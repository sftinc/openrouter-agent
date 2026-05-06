/**
 * Direct client — a one-shot `OpenRouterClient.chat.complete` call (no
 * `Agent` loop). This example happens to use OpenRouter's built-in
 * `openrouter:web_search` server tool (Exa engine), but the point is the
 * raw client surface itself.
 *
 * From this repo:
 *   npm run demo:direct-client                          # default query
 *   npm run demo:direct-client -- "your query here"     # custom query
 *
 * From a project that has installed `@sftinc/openrouter-agent`:
 *   1. Copy this file into your project.
 *   2. Install the runner: `npm i -D tsx`
 *   3. Run: `OPENROUTER_API_KEY=sk-... npx tsx server.ts "your query"`
 *
 * Env vars:
 *   OPENROUTER_API_KEY (required) — OpenRouter API key.
 */
import { OpenRouterClient } from '@sftinc/openrouter-agent'

const query = process.argv[2] ?? 'Current stock price for MSFT'

const client = new OpenRouterClient({
	referer: 'https://github.com/sftinc/openrouter-agent',
	title: 'openrouter-agent websearch example',
	chat: {
		model: 'openai/gpt-5.4-mini',
		max_tokens: 2000,
		temperature: 0.3,
	},
})

const response = await client.chat.complete({
	messages: [
		{
			role: 'system',
			content:
				'You must use the openrouter:web_search tool to find current, factual information related to the query. Only respond with the result information and no additional text.',
		},
		{ role: 'user', content: query },
	],
	tools: [
		{
			type: 'openrouter:web_search',
			parameters: { engine: 'exa', max_results: 2 },
		} as never,
	],
})

for (const choice of response.choices) {
	for (const annotation of choice.message.annotations ?? []) {
		const content = annotation.url_citation.content
		if (annotation.type === 'url_citation' && content && content.length > 100) {
			annotation.url_citation.content = `${content.slice(0, 100)}…`
		}
	}
}
console.log('\n--- response ---')
console.dir(response, { depth: null })
