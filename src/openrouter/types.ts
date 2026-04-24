import type { Message, ToolCall, Usage } from '../types/index.js'

/**
 * User-facing configuration mirroring OpenRouter's chat completions
 * request schema, minus `messages` and `tools` (handled by the loop
 * and the Agent respectively). Every field is optional. See
 * docs/openrouter/llm.md for the full schema.
 */
export interface LLMConfig {
	model?: string
	max_tokens?: number
	temperature?: number
	top_p?: number
	top_k?: number
	min_p?: number
	top_a?: number
	frequency_penalty?: number
	presence_penalty?: number
	repetition_penalty?: number
	seed?: number
	stop?: string | string[]
	logit_bias?: Record<number, number>
	top_logprobs?: number
	response_format?:
		| { type: 'json_object' }
		| {
				type: 'json_schema'
				json_schema: { name: string; strict?: boolean; schema: object }
		  }
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } }
	prediction?: { type: 'content'; content: string }
	reasoning?: {
		effort?: 'low' | 'medium' | 'high'
		max_tokens?: number
		enabled?: boolean
	}
	user?: string
	models?: string[]
	route?: 'fallback'
	provider?: Record<string, unknown>
	plugins?: Array<{ id: string; [key: string]: unknown }>
}

/** Tool declaration as sent to OpenRouter (function tools only). */
export interface OpenRouterTool {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: object
	}
}

/** Non-streaming choice shape from OpenRouter. */
export interface NonStreamingChoice {
	finish_reason: string | null
	native_finish_reason: string | null
	message: {
		content: string | null
		role: string
		tool_calls?: ToolCall[]
	}
	error?: ErrorResponse
}

export interface ErrorResponse {
	code: number
	message: string
	metadata?: Record<string, unknown>
}

/** Full non-streaming response from /chat/completions. */
export interface CompletionsResponse {
	id: string
	choices: NonStreamingChoice[]
	created: number
	model: string
	object: 'chat.completion'
	system_fingerprint?: string
	usage?: Usage
}

/** Request body we POST to /chat/completions. */
export interface CompletionsRequest extends LLMConfig {
	messages: Message[]
	tools?: OpenRouterTool[]
	stream?: false
}

export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'
// export const DEFAULT_MODEL = 'inception/mercury-2'
