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
