import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../src/agent/Agent.js'
import { Tool } from '../../src/tool/Tool.js'
import { SessionBusyError } from '../../src/session/index.js'
import type { CompletionChunk } from '../../src/openrouter/index.js'
import { mockCompletionChunks, mockChunkStream } from '../fixtures/completions.js'

/** Encode a chunk array as an SSE Response (what OpenRouterClient.completeStream parses). */
function sseOfChunks(chunks: CompletionChunk[]): Response {
	const body =
		chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
		`data: [DONE]\n\n`
	return new Response(body, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	})
}

function mockOkSse(content: string, id = 'gen-x'): Response {
	return sseOfChunks(
		mockCompletionChunks({
			id,
			content,
			usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
		})
	)
}

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
})
