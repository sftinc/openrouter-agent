/**
 * Full demo — HTTP server with a streaming chat UI. Demonstrates streaming
 * agent events to the browser, a multi-tool agent, and session persistence.
 *
 * Entry point: this file. Companion files in the same folder
 * (`agent.ts`, `backend.ts`, `static/`) are loaded from here.
 *
 * From this repo:
 *   npm run demo:full-demo
 *   # then open http://localhost:3000
 *
 * From a project that has installed `@sftinc/openrouter-agent`:
 *   1. Copy the entire `examples/full-demo/` folder into your project.
 *   2. Install runners: `npm i -D tsx zod`
 *   3. Run: `OPENROUTER_API_KEY=sk-... npx tsx server.ts`
 *
 * Env vars:
 *   OPENROUTER_API_KEY (required) — OpenRouter API key.
 *   PORT             (optional)   — HTTP port. Defaults to 3000.
 */
import { createServer } from 'node:http'
import { handleChat, serveStatic } from './backend.js'

const PORT = Number(process.env.PORT ?? 3000)

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

server.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`demo server ready: http://localhost:${PORT}`)
	if (!process.env.OPENROUTER_API_KEY) {
		// eslint-disable-next-line no-console
		console.warn('warning: OPENROUTER_API_KEY is not set; chat calls will fail')
	}
})
