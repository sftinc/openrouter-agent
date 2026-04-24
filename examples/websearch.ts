import { OpenRouterClient } from '../src/index.js'

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
