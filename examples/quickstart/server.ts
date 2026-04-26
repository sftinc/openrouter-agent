import { z } from 'zod'
import { setOpenRouterClient, Tool, Agent } from '../../src/index.js'

setOpenRouterClient({
	max_tokens: 1000,
	temperature: 0.3,
	reasoning: { effort: 'none' },
	title: 'openrouter-agent: quickstart',
})

const calculator = new Tool<{ expression: string }>({
	name: 'calculator',
	description: 'Evaluate a basic arithmetic expression.',
	inputSchema: z.object({ expression: z.string() }),
	execute: async ({ expression }) => String(Function(`"use strict"; return (${expression});`)()),
})

const agent = new Agent({
	name: 'demo-assistant',
	description: 'A helpful assistant with a calculator.',
	systemPrompt: 'You are concise and helpful.',
	tools: [calculator],
})

const result = await agent.run('What is 347 * 29?')

console.log(result.text) // assistant's final text
console.log(result.stopReason) // "done" | "max_turns" | "length" | "content_filter" | "error" | "aborted"
console.log(result.usage) // token + cost totals across the whole run
