/**
 * Direct client — a one-shot `OpenRouterClient.chat.complete` call (no
 * `Agent` loop). Demonstrates the raw client surface with a plain text
 * generation request (no tools).
 *
 * From this repo:
 *   npm run demo:direct-client                          # default prompt
 *   npm run demo:direct-client -- "your prompt here"    # custom prompt
 *
 * From a project that has installed `@sftinc/openrouter-agent`:
 *   1. Copy this file into your project.
 *   2. Install the runner: `npm i -D tsx`
 *   3. Run: `OPENROUTER_API_KEY=sk-... npx tsx server.ts "your prompt"`
 *
 * Env vars:
 *   OPENROUTER_API_KEY (required) — OpenRouter API key.
 */
import { OpenRouterClient } from '@sftinc/openrouter-agent'

const prompt = process.argv[2] ?? 'Write 3 paragraphs about a boy and his dog.'

const client = new OpenRouterClient({
	referer: 'https://github.com/sftinc/openrouter-agent',
	title: 'openrouter-agent: direct-client',
	chat: {
		max_tokens: 2000,
		temperature: 0.3,
	},
})

const response = await client.chat.complete({
	messages: [{ role: 'user', content: prompt }],
})

console.log('\n--- response ---')
console.dir(response, { depth: null })
