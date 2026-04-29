/**
 * Quickstart — minimal Agent with one custom Tool (a calculator).
 *
 * From this repo:
 *   npm run demo:quickstart
 *
 * From a project that has installed `@sftinc/openrouter-agent`:
 *   1. Copy this file into your project.
 *   2. Install the runner: `npm i -D tsx zod`
 *   3. Run: `OPENROUTER_API_KEY=sk-... npx tsx server.ts`
 *
 * Env vars:
 *   OPENROUTER_API_KEY (required) — OpenRouter API key.
 */
import { z } from 'zod'
import { setOpenRouterClient, Tool, Agent } from '@sftinc/openrouter-agent'

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

console.log('[text]', result.text) // assistant's final text
console.log('\n[stopReason]', result.stopReason) // "done" | "max_turns" | "length" | "content_filter" | "error" | "aborted"
console.log('\n[Usage]', result.usage) // token + cost totals across the whole run
