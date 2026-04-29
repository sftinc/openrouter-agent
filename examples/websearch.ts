/**
 * Websearch — direct OpenRouterClient call using OpenRouter's built-in
 * `openrouter:web_search` tool (Exa engine).
 *
 * From this repo:
 *   npm run websearch                          # default query
 *   npm run websearch -- "your query here"     # custom query
 *
 * From a project that has installed `@sftinc/openrouter-agent`:
 *   1. Copy this file into your project.
 *   2. Install the runner: `npm i -D tsx`
 *   3. Run: `OPENROUTER_API_KEY=sk-... npx tsx websearch.ts "your query"`
 *
 * Env vars:
 *   OPENROUTER_API_KEY (required) — OpenRouter API key.
 */
import { OpenRouterClient } from '@sftinc/openrouter-agent'

const query = process.argv[2] ?? 'Current stock price for MSFT'

const client = new OpenRouterClient({
	model: 'anthropic/claude-haiku-4.5',
	max_tokens: 2000,
	temperature: 0.3,
	title: 'openrouter-agent websearch example',
})

const response = await client.complete({
	messages: [
		{
			role: 'system',
			content:
				'You must use the openrouter:web_search tool to find current, factual information related to the query. Only respond with the result information and no additional text.',
		},
		{ role: 'user', content: query },
	],
	tools: [{ type: 'openrouter:web_search', engine: 'exa', max_results: 5 } as never],
})

// console.log('--- full response ---')
// console.dir(response, { depth: null })

console.log('\n--- choices[0].message ---')
console.log(response.choices[0]?.message)
