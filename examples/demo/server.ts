import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { setDefaultOpenRouterClient, Tool, Agent, SessionBusyError } from '../../src/index.js'
import type { AgentEvent } from '../../src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, 'public')
const PORT = Number(process.env.PORT ?? 3000)

function randomDelay(minMs: number, maxMs: number): Promise<void> {
	const ms = minMs + Math.random() * (maxMs - minMs)
	return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const calculator = new Tool({
	name: 'calculator',
	description:
		'Evaluate a basic arithmetic expression. Supports + - * / ( ) and decimals. Use for any math the user asks.',
	inputSchema: z.object({
		expression: z.string().describe("The arithmetic expression, e.g. '2 + 2 * 3'"),
	}),
	execute: async ({ expression }) => {
		if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
			throw new Error(`"${expression}" contains non-math characters`)
		}
		await randomDelay(2000, 4000)
		const result = Function(`"use strict"; return (${expression});`)() as number
		return String(result)
	},
	display: {
		title: (args) => `Calculating ${args.expression}`,
		success: (_args, output) => ({ content: output }),
		error: (_args, error) => ({ content: String(error) }),
	},
})

const currentTime = new Tool({
	name: 'current_time',
	description: "Returns the current date and time. Optionally in a specific IANA timezone (e.g. 'America/New_York').",
	inputSchema: z.object({
		timezone: z.string().optional().describe('IANA timezone name; omit for UTC ISO timestamp'),
	}),
	execute: async ({ timezone }) => {
		await randomDelay(2000, 4000)
		const now = new Date()
		if (!timezone) return now.toISOString()
		try {
			return now.toLocaleString('en-US', {
				timeZone: timezone,
				dateStyle: 'full',
				timeStyle: 'long',
			})
		} catch {
			throw new Error(`Unknown timezone "${timezone}"`)
		}
	},
	display: {
		title: (args) => (args.timezone ? `Looking up time in ${args.timezone}` : `Getting current time`),
	},
})

const webSearch = new Tool({
	name: 'web_search',
	description:
		'Search the web for current information. Use for recent facts, news, prices, or anything outside your training data.',
	inputSchema: z.object({
		query: z.string().describe('The search query'),
	}),
	execute: async ({ query }, deps) => {
		const res = await deps.complete(
			[
				{
					role: 'system',
					content:
						'You are a web research assistant. Use the openrouter:web_search tool to find current, factual information and return a concise answer with the key facts, and any source Website Titles / URLs in markdown format.',
				},
				{ role: 'user', content: query },
			],
			{ tools: [{ type: 'openrouter:web_search', engine: 'exa', max_results: 5 } as never] },
		)
		return res.content ?? '(no results)'
	},
	display: {
		title: 'Searching the web',
		start: (args) => ({ content: args.query }),
	},
})

// ---------------------------------------------------------------------------
// OpenRouter client
//
// Set the project-wide default once at startup. Every Agent constructed after
// this call will use it automatically — no need to pass `client:` each time.
// Per-agent or per-run `llm` overrides still layer on top.
// ---------------------------------------------------------------------------

setDefaultOpenRouterClient({
	model: 'anthropic/claude-haiku-4.5',
	max_tokens: 2000,
	temperature: 0.3,
	title: 'openrouter-agent demo',
})

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agent = new Agent({
	name: 'demo-assistant',
	description: 'A helpful assistant with a calculator, current time, and web search.',
	systemPrompt:
		'You are a concise, helpful assistant. Use the available tools when they would give you better or more current information than guessing. Prefer calling a tool over speculating. When you answer, be direct. **You always speak like a pirate.**',
	tools: [calculator, currentTime, webSearch],
	maxTurns: 8,
})

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

	if (req.method === 'POST' && url.pathname === '/api/chat') {
		await handleChat(req, res)
		return
	}

	if (req.method === 'GET') {
		await serveStatic(url.pathname, res)
		return
	}

	res.writeHead(405, { 'Content-Type': 'text/plain' })
	res.end('Method not allowed')
})

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	let raw = ''
	for await (const chunk of req) raw += chunk
	let body: { message?: string; sessionId?: string }
	try {
		body = JSON.parse(raw)
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'invalid JSON' }))
		return
	}

	const message = (body.message ?? '').trim()
	const sessionId = body.sessionId?.trim()
	if (!message || !sessionId) {
		res.writeHead(400, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'message and sessionId are required' }))
		return
	}

	// Abort the agent run if the client disconnects before the response ends.
	// Combined with the transactional session persist in runLoop, this means a
	// dropped stream leaves the session exactly as it was before the run, so
	// the client can safely retry with the same user message.
	const abort = new AbortController()
	res.on('close', () => {
		if (!res.writableEnded) abort.abort()
	})

	const stream = agent.runStream(message, { sessionId, signal: abort.signal })
	const iterator = stream[Symbol.asyncIterator]()

	// Pull the first event before writing status headers so we can surface a
	// SessionBusyError as HTTP 409 instead of an in-stream error.
	let first: IteratorResult<AgentEvent>
	try {
		first = await iterator.next()
	} catch (err) {
		if (err instanceof SessionBusyError) {
			res.writeHead(409, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'session busy', sessionId }))
			return
		}
		const msg = err instanceof Error ? err.message : String(err)
		res.writeHead(500, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: msg }))
		return
	}

	res.writeHead(200, {
		'Content-Type': 'application/x-ndjson',
		'Cache-Control': 'no-cache',
		'X-Accel-Buffering': 'no',
	})

	const send = (event: AgentEvent) => {
		res.write(JSON.stringify(event) + '\n')
	}

	try {
		if (!first.done) send(first.value)
		while (true) {
			const next = await iterator.next()
			if (next.done) break
			send(next.value)
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		res.write(JSON.stringify({ type: 'error', runId: 'server', error: { message: msg } }) + '\n')
	} finally {
		res.end()
	}
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	const relative = pathname === '/' ? '/index.html' : pathname
	const filePath = join(PUBLIC_DIR, relative)

	if (!filePath.startsWith(PUBLIC_DIR)) {
		res.writeHead(403)
		res.end('Forbidden')
		return
	}

	try {
		const data = await readFile(filePath)
		const mime = MIME[extname(filePath)] ?? 'application/octet-stream'
		res.writeHead(200, { 'Content-Type': mime })
		res.end(data)
	} catch {
		res.writeHead(404)
		res.end('Not found')
	}
}

server.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`demo server ready: http://localhost:${PORT}`)
	if (!process.env.OPENROUTER_API_KEY) {
		// eslint-disable-next-line no-console
		console.warn('warning: OPENROUTER_API_KEY is not set; chat calls will fail')
	}
})
