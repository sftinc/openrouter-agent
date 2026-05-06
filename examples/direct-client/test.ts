/**
 * Raw OpenRouter API call — no client wrapper, no streaming. Same payload
 * as `server.ts` (model, system prompt, tools, headers), but POSTed
 * directly with `stream: false` so we can see exactly what the
 * non-streaming endpoint returns for the `openrouter:web_search` server
 * tool.
 *
 * From this repo:
 *   npm run demo:direct-client:test                          # default query
 *   npm run demo:direct-client:test -- "your query here"     # custom query
 *
 * Env vars:
 *   OPENROUTER_API_KEY (required) — OpenRouter API key.
 */

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
	console.error('OPENROUTER_API_KEY is not set')
	process.exit(1)
}

const query = process.argv[2] ?? 'Current stock price for MSFT'

const body = {
	model: 'openai/gpt-5.4-mini',
	max_tokens: 2000,
	temperature: 0.3,
	stream: false,
	messages: [
		{
			role: 'system',
			content:
				'You must use the openrouter:web_search tool to find current, factual information related to the query. Only respond with the result information and no additional text.',
		},
		{ role: 'user', content: query },
	],
	tools: [{ type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 5 } }],
}

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
	method: 'POST',
	headers: {
		Authorization: `Bearer ${apiKey}`,
		'Content-Type': 'application/json',
		'HTTP-Referer': 'https://github.com/sftinc/openrouter-agent',
		'X-Title': 'openrouter-agent websearch example',
	},
	body: JSON.stringify(body),
})

console.log('--- HTTP status ---')
console.log(response.status, response.statusText)
console.log('--- response body ---')
console.dir(await response.json(), { depth: null })
