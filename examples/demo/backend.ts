import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionBusyError } from '../../src/index.js'
import type { AgentEvent } from '../../src/index.js'
import { agent } from './agent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PUBLIC_DIR = resolve(__dirname, 'public')

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
}

export async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

export async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
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
