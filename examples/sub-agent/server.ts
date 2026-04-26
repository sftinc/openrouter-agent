import { setOpenRouterClient, Agent } from '../../src/index.js'

setOpenRouterClient({
	// Using default model
	max_tokens: 2000,
	temperature: 0.3,
	reasoning: { effort: 'none' },
	title: 'openrouter-agent: sub-agent',
})

// A subagent is just an Agent passed into another Agent's `tools` array.
// The parent invokes it like any tool; the child runs its own loop and
// returns its final text back to the parent.
const haikuWriter = new Agent({
	name: 'haiku-writer',
	description: 'Writes a single haiku on the given topic. Input: { input: string } describing the topic.',
	systemPrompt: 'You write a single 5-7-5 haiku. Output only the haiku.',
})

const orchestrator = new Agent({
	name: 'orchestrator',
	description: 'Delegates creative writing tasks to specialist subagents.',
	systemPrompt: 'When asked for a poem, call the haiku-writer tool. Then return the haiku to the user.',
	tools: [haikuWriter],
})

const result = await orchestrator.run('Write me a haiku about the ocean.')

console.log('[final text]', result.text)
console.log('\n[result]')
console.dir(result, { depth: null }) // the full result object, including tool calls and intermediate reasoning
