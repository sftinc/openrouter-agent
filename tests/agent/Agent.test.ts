import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../src/agent/Agent.js'
import { Tool } from '../../src/tool/Tool.js'
import { SessionBusyError } from '../../src/session/index.js'
import { OpenRouterClient } from '../../src/openrouter/index.js'
import {
	mockCompletionChunks,
	mockChunkStream,
	sseOfChunks,
	mockOkSse,
} from '../fixtures/completions.js'

describe('Agent', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch')
		process.env.OPENROUTER_API_KEY = 'sk-test'
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	test('run returns Result with text and usage', async () => {
		fetchSpy.mockResolvedValue(mockOkSse('hi there'))
		const agent = new Agent({ name: 'a', description: 'd' })
		const result = await agent.run('hello')
		expect(result.text).toBe('hi there')
		expect(result.stopReason).toBe('done')
		expect(result.usage.total_tokens).toBe(8)
	})

	test('run yields events in order when iterated', async () => {
		fetchSpy.mockResolvedValue(mockOkSse('ok'))
		const agent = new Agent({ name: 'a', description: 'd' })
		const events: string[] = []
		for await (const ev of agent.run('hello')) {
			events.push(ev.type)
		}
		expect(events[0]).toBe('agent:start')
		expect(events).toContain('message')
		expect(events[events.length - 1]).toBe('agent:end')
	})

	test('default model falls back to DEFAULT_MODEL when client is omitted', async () => {
		fetchSpy.mockResolvedValue(mockOkSse('ok'))
		const agent = new Agent({ name: 'a', description: 'd' })
		await agent.run('hi')
		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
		const { DEFAULT_MODEL } = await import('../../src/openrouter/index.js')
		expect(body.model).toBe(DEFAULT_MODEL)
	})

	test('per-run client shallow-merges over constructor client', async () => {
		fetchSpy.mockResolvedValue(mockOkSse('ok'))
		const agent = new Agent({
			name: 'a',
			description: 'd',
			client: { model: 'anthropic/claude-haiku-4.5', temperature: 0.7 },
		})
		await agent.run('hi', { client: { temperature: 0 } })
		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
		expect(body.model).toBe('anthropic/claude-haiku-4.5')
		expect(body.temperature).toBe(0)
	})

	test('Agent can be used as a Tool (subagent)', async () => {
		// First call: parent emits tool_calls for 'child'. Second call: child responds 'child-done'. Third: parent's final response.
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'do it' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-done', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({ name: 'child', description: 'a subagent' })
		const parent = new Agent({ name: 'parent', description: 'the parent', tools: [child] })
		const result = await parent.run('use the child')
		expect(result.text).toBe('parent-final')
		expect(result.stopReason).toBe('done')
	})

	test('subagent events bubble up with parentRunId', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'hi' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-done', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('final', 'gen-3'))

		const child = new Agent({ name: 'child', description: 'sub' })
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		const starts: { agentName: string; parentRunId?: string }[] = []
		for await (const ev of parent.run('go')) {
			if (ev.type === 'agent:start') {
				starts.push({ agentName: ev.agentName, parentRunId: ev.parentRunId })
			}
		}
		expect(starts).toHaveLength(2)
		expect(starts[0]).toMatchObject({ agentName: 'parent' })
		expect(starts[0].parentRunId).toBeUndefined()
		expect(starts[1]).toMatchObject({ agentName: 'child' })
		expect(typeof starts[1].parentRunId).toBe('string')
	})

	test('custom tool with Zod schema is validated before execute', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'weather', arguments: JSON.stringify({ city: 123 }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('recovered', 'gen-2'))

		const weather = new Tool({
			name: 'weather',
			description: 'weather',
			inputSchema: z.object({ city: z.string() }),
			execute: async (args) => `weather in ${args.city}`,
		})
		const agent = new Agent({ name: 'a', description: 'd', tools: [weather] })
		const result = await agent.run("what's the weather")
		expect(result.stopReason).toBe('done')
		// Tool message should carry the validation error, not crash the loop.
		const toolMsg = result.messages.find((m) => m.role === 'tool')
		expect(toolMsg).toBeDefined()
		expect(String((toolMsg as { content: string }).content)).toMatch(/Error/i)
	})

	test('concurrent runs on the same sessionId throw SessionBusyError', async () => {
		// Block the first fetch until we release it, so we can start a second
		// run while the first is still in flight.
		let release: () => void
		const gate = new Promise<void>((r) => {
			release = r
		})
		fetchSpy.mockImplementation(async () => {
			await gate
			return mockOkSse('ok')
		})

		const agent = new Agent({ name: 'a', description: 'd' })
		const first = agent.run('one', { sessionId: 's1' })
		// Give the first run a tick to acquire the lock before we start the second.
		await Promise.resolve()

		// SessionBusyError is thrown synchronously from run(), not wrapped in a promise.
		expect(() => agent.run('two', { sessionId: 's1' })).toThrow(SessionBusyError)

		release!()
		await first
	})

	test('lock releases after a successful run so the same session can run again', async () => {
		fetchSpy.mockImplementation(async () => mockOkSse('ok'))
		const agent = new Agent({ name: 'a', description: 'd' })
		await agent.run('one', { sessionId: 's1' })
		// Second run on the same session should succeed, not throw.
		const r = await agent.run('two', { sessionId: 's1' })
		expect(r.stopReason).toBe('done')
	})

	test('lock releases after a failed run', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('network boom'))
		const agent = new Agent({ name: 'a', description: 'd' })
		const first = await agent.run('one', { sessionId: 's1' })
		expect(first.stopReason).toBe('error')

		// After the error, the lock should be free again.
		fetchSpy.mockResolvedValueOnce(mockOkSse('recovered'))
		const second = await agent.run('retry', { sessionId: 's1' })
		expect(second.stopReason).toBe('done')
		expect(second.text).toBe('recovered')
	})

	test('run throws SessionBusyError synchronously when session is already busy', async () => {
		let release: () => void
		const gate = new Promise<void>((r) => {
			release = r
		})
		fetchSpy.mockImplementation(async () => {
			await gate
			return mockOkSse('ok')
		})

		const agent = new Agent({ name: 'a', description: 'd' })
		// Kick off a blocking run; start iterating it in the background.
		const firstRun = agent.run('one', { sessionId: 's1' })
		const firstStreamIter = firstRun[Symbol.asyncIterator]()
		const firstStart = firstStreamIter.next()
		await Promise.resolve()

		// SessionBusyError must be thrown synchronously from run(), not wrapped.
		expect(() => agent.run('two', { sessionId: 's1' })).toThrow(SessionBusyError)

		release!()
		// Drain the first run so the lock releases cleanly.
		await firstStart
		while (!(await firstStreamIter.next()).done) {
			/* drain */
		}
	})

	test('subagent message events do NOT bubble to parent stream', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'hi' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-says-this', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({ name: 'child', description: 'sub' })
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let childRunId: string | undefined
		const messageRunIds: string[] = []

		for await (const ev of parent.run('go')) {
			if (ev.type === 'agent:start' && ev.parentRunId) {
				childRunId = ev.runId
			}
			if (ev.type === 'message' || ev.type === 'message:delta') {
				messageRunIds.push(ev.runId)
			}
		}

		expect(childRunId).toBeTypeOf('string')
		expect(messageRunIds.includes(childRunId!)).toBe(false)
		expect(messageRunIds.length).toBeGreaterThan(0)
	})

	test('subagent display hooks attach to outer tool:start and tool:end', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'topic' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-output', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({
			name: 'child',
			description: 'sub',
			display: {
				title: 'Child Title',
				start: (input) => ({
					title: 'Child Starting',
					content: typeof input === 'string' ? input : JSON.stringify(input),
				}),
				success: (result) => ({
					title: 'Child Done',
					content: `text=${result.text}`,
				}),
			},
		})
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let outerToolStart: { display?: { title: string; content?: unknown } } | undefined
		let outerToolEnd: { display?: { title: string; content?: unknown } } | undefined

		for await (const ev of parent.run('go')) {
			if (ev.type === 'tool:start' && ev.toolName === 'child') {
				outerToolStart = ev as never
			}
			if (ev.type === 'tool:end' && ev.toolName === 'child') {
				outerToolEnd = ev as never
			}
		}

		expect(outerToolStart?.display?.title).toBe('Child Starting')
		expect(outerToolStart?.display?.content).toBe('topic')

		expect(outerToolEnd?.display?.title).toBe('Child Done')
		expect(outerToolEnd?.display?.content).toBe('text=child-output')
	})

	test('subagent display.title as a string passes through to outer tool:start', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'topic' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-output', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({
			name: 'child',
			description: 'sub',
			display: { title: 'Static Title' },
		})
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let outerToolStart: { display?: { title: string; content?: unknown } } | undefined
		for await (const ev of parent.run('go')) {
			if (ev.type === 'tool:start' && ev.toolName === 'child') {
				outerToolStart = ev as never
			}
		}

		expect(outerToolStart?.display?.title).toBe('Static Title')
	})

	test('subagent without display config leaves outer tool:start/tool:end display undefined', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'topic' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-output', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({ name: 'child', description: 'sub' })
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let outerToolStart: { display?: { title: string; content?: unknown } } | undefined
		let outerToolEnd: { display?: { title: string; content?: unknown } } | undefined
		for await (const ev of parent.run('go')) {
			if (ev.type === 'tool:start' && ev.toolName === 'child') {
				outerToolStart = ev as never
			}
			if (ev.type === 'tool:end' && ev.toolName === 'child') {
				outerToolEnd = ev as never
			}
		}

		// With no display config, the loop's resolveToolDisplay returns undefined
		// and consumers fall back to the helpers' `defaultDisplay`.
		expect(outerToolStart?.display).toBeUndefined()
		expect(outerToolEnd?.display).toBeUndefined()
	})

	test('subagent display.error fires on inner stopReason="error"', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'boom' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			// Child's first (and only) LLM call fails with HTTP 400 — non-retryable.
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { code: 400, message: 'bad' } }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				})
			)
			// Parent's follow-up turn after the child returns an error.
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({
			name: 'child',
			description: 'sub',
			retry: { maxAttempts: 1 },
			display: {
				error: (result) => ({
					title: 'Child Failed',
					content: `err=${result.error?.message ?? ''}`,
				}),
			},
		})
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let outerToolEnd:
			| { display?: { title: string; content?: unknown }; error?: unknown }
			| undefined
		for await (const ev of parent.run('go')) {
			if (ev.type === 'tool:end' && ev.toolName === 'child') {
				outerToolEnd = ev as never
			}
		}

		expect(outerToolEnd?.display?.title).toBe('Child Failed')
		expect(String(outerToolEnd?.display?.content)).toContain('bad')
	})

	test('subagent display.end is the fallback for both success and error paths', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'topic' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-output', 'gen-2'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

		const child = new Agent({
			name: 'child',
			description: 'sub',
			display: {
				end: (result) => ({
					title: result.stopReason === 'error' ? 'Ended Error' : 'Ended OK',
					content: 'from-end',
				}),
			},
		})
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let outerToolEnd: { display?: { title: string; content?: unknown } } | undefined
		for await (const ev of parent.run('go')) {
			if (ev.type === 'tool:end' && ev.toolName === 'child') {
				outerToolEnd = ev as never
			}
		}

		expect(outerToolEnd?.display?.title).toBe('Ended OK')
		expect(outerToolEnd?.display?.content).toBe('from-end')
	})

	test('subagent non-message events still bubble to parent stream', async () => {
		const innerTool = new Tool({
			name: 'inner_tool',
			description: 'a tool the child uses',
			inputSchema: z.object({ x: z.string() }),
			execute: async ({ x }) => `inner-result-${x}`,
		})

		fetchSpy
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-1',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'child', arguments: JSON.stringify({ input: 'go' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(
				sseOfChunks(
					mockCompletionChunks({
						id: 'gen-2',
						finish_reason: 'tool_calls',
						tool_calls: [
							{
								id: 't1',
								type: 'function',
								function: { name: 'inner_tool', arguments: JSON.stringify({ x: 'foo' }) },
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				)
			)
			.mockResolvedValueOnce(mockOkSse('child-summary', 'gen-3'))
			.mockResolvedValueOnce(mockOkSse('parent-final', 'gen-4'))

		const child = new Agent({ name: 'child', description: 'sub', tools: [innerTool] })
		const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

		let childRunId: string | undefined
		const observedTypesByRunId = new Map<string, string[]>()

		for await (const ev of parent.run('go')) {
			if (ev.type === 'agent:start' && ev.parentRunId) childRunId = ev.runId
			const arr = observedTypesByRunId.get(ev.runId) ?? []
			arr.push(ev.type)
			observedTypesByRunId.set(ev.runId, arr)
		}

		const childEvents = observedTypesByRunId.get(childRunId!) ?? []
		expect(childEvents).toContain('agent:start')
		expect(childEvents).toContain('agent:end')
		expect(childEvents).toContain('tool:start')
		expect(childEvents).toContain('tool:end')
		expect(childEvents).not.toContain('message')
		expect(childEvents).not.toContain('message:delta')
	})
})

describe("Agent — retry config plumbing", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("forwards AgentConfig.retry into the run loop", async () => {
    let observedConfig: unknown;
    const stubClient = {
      completeStream: (_req: unknown, opts: unknown) => {
        observedConfig = opts;
        return (async function* () {
          yield {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ finish_reason: "stop", native_finish_reason: "stop", delta: { content: "ok" } }],
          };
          yield {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        })();
      },
    } as unknown as OpenRouterClient;

    const agent = new Agent({
      name: "t",
      description: "t",
      retry: { maxAttempts: 7, initialDelayMs: 99 },
    });
    (agent as unknown as { openrouter: OpenRouterClient }).openrouter = stubClient;
    await agent.run("hi");
    expect(observedConfig).toMatchObject({
      retryConfig: expect.objectContaining({ maxAttempts: 7, initialDelayMs: 99 }),
    });
  });

  test("per-run retry merges over AgentConfig.retry", async () => {
    let observedConfig: any;
    const stubClient = {
      completeStream: (_req: unknown, opts: unknown) => {
        observedConfig = opts;
        return (async function* () {
          yield {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ finish_reason: "stop", native_finish_reason: "stop", delta: { content: "ok" } }],
          };
          yield {
            id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        })();
      },
    } as unknown as OpenRouterClient;

    const agent = new Agent({
      name: "t",
      description: "t",
      retry: { maxAttempts: 7, initialDelayMs: 99 },
    });
    (agent as unknown as { openrouter: OpenRouterClient }).openrouter = stubClient;
    await agent.run("hi", { retry: { maxAttempts: 1 } });
    expect(observedConfig.retryConfig).toMatchObject({
      maxAttempts: 1,
      initialDelayMs: 99,
    });
  });
});

describe('Agent — asTool.metadata', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    process.env.OPENROUTER_API_KEY = 'sk-test'
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  test('asTool.metadata is attached to outer tool:end.metadata', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        sseOfChunks(
          mockCompletionChunks({
            id: 'gen-1',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'child', arguments: JSON.stringify({ input: 'topic' }) },
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          })
        )
      )
      .mockResolvedValueOnce(
        sseOfChunks(
          mockCompletionChunks({
            id: 'gen-2',
            content: 'child-output',
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          })
        )
      )
      .mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

    const child = new Agent({
      name: 'child',
      description: 'sub',
      asTool: {
        metadata: (result, input) => ({
          topic: (input as { input: string }).input,
          tokens: result.usage.total_tokens,
          stopReason: result.stopReason,
        }),
      },
    })
    const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

    let toolEnd: { metadata?: Record<string, unknown> } | undefined
    for await (const ev of parent.run('go')) {
      if (ev.type === 'tool:end' && ev.toolName === 'child') {
        toolEnd = ev as never
      }
    }

    expect(toolEnd?.metadata).toBeTypeOf('object')
    expect(toolEnd?.metadata?.topic).toBe('topic')
    expect(toolEnd?.metadata?.tokens).toBe(10)
    expect(toolEnd?.metadata?.stopReason).toBe('done')
  })

  test('asTool.metadata is silently ignored on top-level run', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkSse('hi', 'gen-1'))

    const spy = vi.fn(() => ({ should: 'not be invoked' }))
    const agent = new Agent({
      name: 'a',
      description: 'd',
      asTool: { metadata: spy },
    })

    const result = await agent.run('hello')
    expect(result.stopReason).toBe('done')
    expect(spy).not.toHaveBeenCalled()
  })

  test('asTool.metadata receives Result on error stop reason', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        sseOfChunks(
          mockCompletionChunks({
            id: 'gen-1',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'child', arguments: JSON.stringify({ input: 'x' }) },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 400, message: 'bad request' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(mockOkSse('parent-final', 'gen-3'))

    const child = new Agent({
      name: 'child',
      description: 'sub',
      asTool: {
        metadata: (result) => ({
          stopReason: result.stopReason,
          sawError: result.error !== undefined,
        }),
      },
      retry: { maxAttempts: 1 },
    })
    const parent = new Agent({ name: 'parent', description: 'p', tools: [child] })

    let toolEnd: { error?: string; metadata?: Record<string, unknown> } | undefined
    for await (const ev of parent.run('go')) {
      if (ev.type === 'tool:end' && ev.toolName === 'child') {
        toolEnd = ev as never
      }
    }

    expect(toolEnd?.error).toBeTypeOf('string')
    expect(toolEnd?.metadata?.stopReason).toBe('error')
    expect(toolEnd?.metadata?.sawError).toBe(true)
  })
});

describe('Agent — subagent display under concurrent parent runs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    process.env.OPENROUTER_API_KEY = 'sk-test'
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  test('display.success captures the right Result when the same child Agent is shared across concurrent parent runs', async () => {
    // Regression: a single shared `lastResult` closure variable would race
    // here. Run two parent runs concurrently against the SAME child Agent
    // instance; assert each parent's tool:end display.content reflects its
    // own child output, not the sibling's.

    // Two distinct child outputs the parents should see:
    const childOutputs: Record<string, string> = {
      'parent-A': 'AAA',
      'parent-B': 'BBB',
    }

    // Route fetch by inspecting the request body: the parent first turn
    // emits a tool_call response; the child turn returns the per-parent
    // text; the parent final turn returns a closing message. We
    // discriminate parents via the user prompt embedded in the messages.
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        messages: { role: string; content: string | null; tool_calls?: unknown }[]
      }
      const userText = body.messages.find((m) => m.role === 'user')?.content ?? ''

      // Discriminate parent A vs B by the per-parent suffix appearing
      // anywhere in the conversation messages. Parent A's prompt is
      // 'parent-A', child input is 'topic-A'.
      const isA = body.messages.some((m) =>
        typeof m.content === 'string' && (m.content.includes('parent-A') || m.content.includes('topic-A'))
      )
      const parentKey = isA ? 'parent-A' : 'parent-B'

      const lastMsg = body.messages[body.messages.length - 1]
      const isToolReply = lastMsg?.role === 'tool'
      const hasAssistantWithToolCalls = body.messages.some(
        (m) => m.role === 'assistant' && m.tool_calls
      )

      // Heuristic: if there's no assistant turn yet, this is either the
      // parent's first turn (asking for the tool) or the child's first
      // turn (asking for output). Distinguish by checking for the child's
      // user input "topic-A" / "topic-B".
      if (!hasAssistantWithToolCalls && !isToolReply) {
        const isChildTurn = userText.startsWith('topic-')
        if (isChildTurn) {
          // Child run: return its per-parent text.
          return mockOkSse(childOutputs[parentKey]!, `${parentKey}-child`)
        }
        // Parent first turn: emit tool_call to invoke 'child'.
        return sseOfChunks(
          mockCompletionChunks({
            id: `${parentKey}-parent-1`,
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: `${parentKey}-c1`,
                type: 'function',
                function: {
                  name: 'child',
                  arguments: JSON.stringify({ input: `topic-${parentKey.slice(-1)}` }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        )
      }

      // Parent final turn after the tool reply.
      return mockOkSse(`${parentKey}-final`, `${parentKey}-parent-2`)
    })

    // ONE shared child Agent instance — this is the whole point of the
    // test. Display.success captures the inner Result's text.
    const child = new Agent({
      name: 'child',
      description: 'sub',
      display: {
        success: (result) => ({ title: 'done', content: result.text }),
      },
    })

    // Two parent agents (separate instances), but it doesn't matter —
    // they share the same `child` tool reference. Concurrent runs.
    const parentA = new Agent({ name: 'parentA', description: 'p', tools: [child] })
    const parentB = new Agent({ name: 'parentB', description: 'p', tools: [child] })

    const collect = async (run: AsyncIterable<{ type: string; toolName?: string; display?: { content?: unknown } }>) => {
      const out: { type: string; toolName?: string; display?: { content?: unknown } }[] = []
      for await (const ev of run) out.push(ev)
      return out
    }

    const [eventsA, eventsB] = await Promise.all([
      collect(parentA.run('parent-A')) as ReturnType<typeof collect>,
      collect(parentB.run('parent-B')) as ReturnType<typeof collect>,
    ])

    const endA = eventsA.find((e) => e.type === 'tool:end' && e.toolName === 'child')
    const endB = eventsB.find((e) => e.type === 'tool:end' && e.toolName === 'child')

    expect(endA?.display?.content).toBe('AAA')
    expect(endB?.display?.content).toBe('BBB')
  })
});
