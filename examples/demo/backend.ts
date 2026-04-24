import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionBusyError } from '../../src/index.js'
import type { AgentEvent, AgentRun } from '../../src/index.js'
import { agent, sessionStore } from './agent.js'

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
	if (!message) {
		res.writeHead(400, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'message is required' }))
		return
	}
	// Session ids are owned by the server. The client only echoes back whatever
	// we gave it last. If the client sent nothing, or sent an id we don't
	// recognize, mint a fresh one and return it via the X-Session-Id response
	// header. This prevents a client from dictating or guessing session ids.
	const claimed = body.sessionId?.trim()
	const isKnown = claimed ? (await sessionStore.get(claimed)) !== null : false
	const sessionId = isKnown ? (claimed as string) : crypto.randomUUID()

	// Abort the agent run if the client disconnects before the response ends.
	// Combined with the transactional session persist in runLoop, this means a
	// dropped stream leaves the session exactly as it was before the run, so
	// the client can safely retry with the same user message.
	const abort = new AbortController()
	res.on('close', () => {
		if (!res.writableEnded) abort.abort()
	})

	// SessionBusyError is thrown synchronously from agent.run() so we can
	// surface it as HTTP 409 without peeking the iterator.
	let run: AgentRun
	try {
		run = agent.run(message, { sessionId, signal: abort.signal })
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
		'X-Session-Id': sessionId,
	})

	const send = (event: AgentEvent) => {
		res.write(JSON.stringify(event) + '\n')
	}

	try {
		for await (const ev of run) send(ev)
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
