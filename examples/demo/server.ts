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
