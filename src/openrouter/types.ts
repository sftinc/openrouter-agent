import type { Message, ToolCall, Usage } from '../types/index.js'

/**
 * User-facing configuration mirroring OpenRouter's chat completions
 * request schema, minus `messages` and `tools` (handled by the loop
 * and the Agent respectively). Every field is optional. See
 * docs/openrouter/llm.md for the full schema.
 */
export interface LLMConfig {
	/** Model slug (e.g. `"anthropic/claude-haiku-4.5"`). Falls back to `DEFAULT_MODEL`. */
	model?: string
	/** Hard cap on completion tokens. Range: `[1, context_length)`. */
	max_tokens?: number
	/** Sampling temperature. Range: `[0, 2]`. Higher = more random. */
	temperature?: number
	/** Nucleus sampling cutoff. Range: `(0, 1]`. */
	top_p?: number
	/** Top-k sampling cutoff. Not supported on OpenAI models. */
	top_k?: number
	/** Minimum token probability cutoff. Not supported on OpenAI models. */
	min_p?: number
	/** Alternative top-k/top-p hybrid. Not supported on OpenAI models. */
	top_a?: number
	/** Penalty in `[-2, 2]` applied per-token-frequency. */
	frequency_penalty?: number
	/** Penalty in `[-2, 2]` applied per-token-presence. */
	presence_penalty?: number
	/** Multiplicative penalty in `(0, 2]` applied to repeated tokens. */
	repetition_penalty?: number
	/** RNG seed for deterministic sampling (provider-dependent support). */
	seed?: number
	/** Stop string(s). The first match terminates the response. */
	stop?: string | string[]
	/** Per-token-id bias map. See OpenAI logit_bias docs. */
	logit_bias?: Record<number, number>
	/** If set, return top-N alternative tokens per position (max 20). */
	top_logprobs?: number
	/**
	 * Force a structured response. `json_object` is loose; `json_schema`
	 * validates against a Zod-like JSON Schema. See docs/openrouter/llm.md
	 * §Structured Outputs.
	 */
	response_format?:
		| { type: 'json_object' }
		| {
				type: 'json_schema'
				json_schema: { name: string; strict?: boolean; schema: object }
		  }
	/**
	 * How the model should pick a tool. `"none"` disables tool-calling for
	 * this turn; `"auto"` (default) lets the model decide; the object form
	 * forces a specific function.
	 */
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } }
	/** Expected prefix of the response, for latency optimization on some providers. */
	prediction?: { type: 'content'; content: string }
	/**
	 * Reasoning controls. `effort` is a budget knob; `max_tokens` caps
	 * reasoning tokens. `enabled: false` disables reasoning entirely on
	 * reasoning-capable models.
	 */
	reasoning?: {
		effort?: 'low' | 'medium' | 'high'
		max_tokens?: number
		enabled?: boolean
	}
	/** Stable end-user identifier for OpenRouter attribution/abuse monitoring. */
	user?: string
	/**
	 * Fallback models tried in order if the primary `model` is unavailable.
	 * See docs/openrouter/llm.md §Model Routing.
	 */
	models?: string[]
	/** Routing strategy. `"fallback"` opts into automatic fallback. */
	route?: 'fallback'
	/**
	 * Provider routing constraints. Common keys include `allow_fallbacks`,
	 * `require_parameters`, `data_collection`, `order`. See
	 * docs/openrouter/llm.md §Provider Routing.
	 */
	provider?: Record<string, unknown>
	/**
	 * Plugin pipeline. Each entry has a required `id` (e.g. `"web"`,
	 * `"file-parser"`, `"response-healing"`, `"context-compression"`) plus
	 * plugin-specific fields. See docs/openrouter/llm.md §Plugins.
	 */
	plugins?: Array<{ id: string; [key: string]: unknown }>
	/**
	 * Optional debug flags. When `echo_upstream_body` is true, OpenRouter
	 * echoes back the transformed upstream request body in the response for
	 * inspection. See docs/openrouter/llm.md.
	 */
	debug?: { echo_upstream_body?: boolean }
}

/**
 * Function tool declaration — a client-side tool your agent implements.
 * See docs/openrouter/llm.md §Tool Calls.
 */
export interface FunctionTool {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: object
	}
}

/**
 * Server-side datetime tool. OpenRouter supplies the current datetime when
 * invoked; your code does not implement it. See docs/openrouter/tool-datetime.md.
 */
export interface DatetimeServerTool {
	type: 'openrouter:datetime'
}

/**
 * Server-side web search tool. Executes a search on the provider's
 * infrastructure and returns results. See docs/openrouter/tool-web_search.md
 * for the full `parameters` shape.
 */
export interface WebSearchServerTool {
	type: 'openrouter:web_search'
	parameters?: {
		search_context_size?: 'low' | 'medium' | 'high'
		user_location?: {
			type: 'approximate'
			approximate: {
				country?: string
				city?: string
				region?: string
				timezone?: string
			}
		}
	}
}

/**
 * Any tool OpenRouter accepts: either a client-side `function` tool (you
 * implement `execute`) or an OpenRouter-hosted server tool (datetime, web
 * search). See docs/openrouter/llm.md and tool-*.md.
 */
export type OpenRouterTool = FunctionTool | DatetimeServerTool | WebSearchServerTool

/** Non-streaming choice shape from OpenRouter. */
export interface NonStreamingChoice {
	/** Normalized finish reason across providers. See docs/openrouter/llm.md. */
	finish_reason: string | null
	/** Provider-specific raw finish reason, unmapped. Useful for debugging. */
	native_finish_reason: string | null
	message: {
		content: string | null
		role: string
		tool_calls?: ToolCall[]
	}
	/** Populated when `finish_reason === "error"`. */
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
	/** Provider fingerprint (OpenAI-style). Absent on most non-OpenAI models. */
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
