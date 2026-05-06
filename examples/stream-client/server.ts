/**
 * Stream client — a one-shot `OpenRouterClient.chat.completeStream` call
 * (no `Agent` loop). Demonstrates the raw streaming client surface,
 * printing content deltas to stdout as they arrive.
 *
 * From this repo:
 *   npm run demo:stream-client                          # default prompt
 *   npm run demo:stream-client -- "your prompt here"    # custom prompt
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
	title: 'openrouter-agent stream-client example',
	chat: {
		max_tokens: 2000,
		temperature: 0.3,
	},
})

console.log('--- response ---')
let model: string | undefined
for await (const chunk of client.chat.completeStream({
	messages: [{ role: 'user', content: prompt }],
})) {
	model ??= chunk.model
	process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
console.log(`\n\n--- model: ${model} ---\n`)
