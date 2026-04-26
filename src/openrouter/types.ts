/**
 * @file Type definitions for the OpenRouter chat completions API surface.
 *
 * Mirrors OpenRouter's HTTP request/response schemas (see
 * `docs/openrouter/llm.md`) so callers can construct typed requests and
 * consume both streaming (`CompletionChunk`) and non-streaming
 * (`CompletionsResponse`) responses with full type safety.
 *
 * The {@link LLMConfig} interface in particular is the canonical "knobs"
 * shape — the `Agent` and `OpenRouterClient` both treat it as their unit
 * of configuration. `messages` and `tools` are intentionally split out
 * (`messages` is owned by the agent loop, `tools` by the {@link Tool}
 * registry on the agent).
 */

import type { Message, ToolCall, Usage } from '../types/index.js'

/**
 * User-facing configuration mirroring OpenRouter's chat completions
 * request schema, minus `messages` and `tools` (handled by the loop
 * and the Agent respectively). Every field is optional. See
 * docs/openrouter/llm.md for the full schema.
 *
 * Used in three places, with later layers overriding earlier ones:
 *   1. as defaults on {@link OpenRouterClient} (set once at app startup);
 *   2. as defaults on an {@link Agent} (per-agent overrides);
 *   3. as per-call overrides on a {@link CompletionsRequest}.
 */
export interface LLMConfig {
	/**
	 * Model slug (e.g. `"anthropic/claude-haiku-4.5"`). Falls back to
	 * {@link DEFAULT_MODEL} when omitted at every layer.
	 */
	model?: string
	/**
	 * Hard cap on completion tokens. Range: `[1, context_length)`.
	 * Provider-dependent; if omitted the provider picks its own default.
	 */
	max_tokens?: number
	/**
	 * Sampling temperature. Range: `[0, 2]`. Higher = more random. Defaults
	 * to the provider's own default (typically `1.0`) when omitted.
	 */
	temperature?: number
	/**
	 * Nucleus sampling cutoff. Range: `(0, 1]`. Defaults to provider default
	 * (typically `1.0`) when omitted.
	 */
	top_p?: number
	/**
	 * Top-k sampling cutoff. Not supported on OpenAI models — silently
	 * ignored there. No default; provider picks its own when omitted.
	 */
	top_k?: number
	/**
	 * Minimum token probability cutoff. Not supported on OpenAI models. No
	 * default when omitted.
	 */
	min_p?: number
	/**
	 * Alternative top-k/top-p hybrid. Not supported on OpenAI models. No
	 * default when omitted.
	 */
	top_a?: number
	/**
	 * Penalty in `[-2, 2]` applied per-token-frequency. Positive values
	 * discourage repetition. Defaults to `0` (off) when omitted.
	 */
	frequency_penalty?: number
	/**
	 * Penalty in `[-2, 2]` applied per-token-presence. Positive values
	 * discourage already-seen tokens regardless of count. Defaults to `0`
	 * (off) when omitted.
	 */
	presence_penalty?: number
	/**
	 * Multiplicative penalty in `(0, 2]` applied to repeated tokens. Values
	 * above `1.0` discourage repetition. Defaults to `1.0` (off) when
	 * omitted.
	 */
	repetition_penalty?: number
	/**
	 * RNG seed for deterministic sampling (provider-dependent support — most
	 * providers are best-effort). No default when omitted.
	 */
	seed?: number
	/**
	 * Stop string(s). The first match terminates the response and is not
	 * included in the output. No default when omitted.
	 */
	stop?: string | string[]
	/**
	 * Per-token-id bias map. Keys are tokenizer ids, values are biases in
	 * `[-100, 100]` added to logits pre-softmax. See OpenAI logit_bias docs.
	 */
	logit_bias?: Record<number, number>
	/**
	 * If set, return top-N alternative tokens per position. Max `20`. Not
	 * exposed by every provider.
	 */
	top_logprobs?: number
	/**
	 * Force a structured response. `json_object` is loose (free-form JSON);
	 * `json_schema` validates against a JSON Schema with optional `strict`
	 * mode. See docs/openrouter/llm.md §Structured Outputs.
	 */
	response_format?:
		| { type: 'json_object' }
		| {
				type: 'json_schema'
				json_schema: { name: string; strict?: boolean; schema: object }
		  }
	/**
	 * How the model should pick a tool. `"none"` disables tool-calling for
	 * this turn; `"auto"` (default when tools are present) lets the model
	 * decide; the object form forces a specific function by name.
	 */
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } }
	/**
	 * Expected prefix of the response, for latency optimization on some
	 * providers (predicted outputs). Ignored where unsupported.
	 */
	prediction?: { type: 'content'; content: string }
	/**
	 * Reasoning controls for reasoning-capable models.
	 *
	 * - `effort`: budget knob (`none` | `minimal` | `low` | `medium` | `high` | `xhigh`).
	 *   Token-allocation ratios are roughly 0.1 / 0.2 / 0.5 / 0.8 / 0.95
	 *   for minimal → xhigh. `xhigh` is only honored by the newest
	 *   reasoning models (e.g. Claude 4.7 Opus+); unsupported levels are
	 *   mapped to the nearest supported one by OpenRouter.
	 * - `max_tokens`: hard cap on reasoning tokens.
	 * - `enabled: false` disables reasoning entirely (defaults to enabled
	 *   on capable models).
	 */
	reasoning?: {
		effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
		max_tokens?: number
		enabled?: boolean
	}
	/**
	 * Stable end-user identifier for OpenRouter attribution and abuse
	 * monitoring. Not used for billing.
	 */
	user?: string
	/**
	 * Fallback models tried in order if the primary {@link LLMConfig.model}
	 * is unavailable. See docs/openrouter/llm.md §Model Routing. Set
	 * {@link LLMConfig.route} to `"fallback"` to opt in.
	 */
	models?: string[]
	/**
	 * Routing strategy. `"fallback"` opts into automatic fallback through
	 * {@link LLMConfig.models}. No default when omitted.
	 */
	route?: 'fallback'
	/**
	 * Provider routing constraints. Common keys include `allow_fallbacks`,
	 * `require_parameters`, `data_collection`, `order`. See
	 * docs/openrouter/llm.md §Provider Routing. Pass-through `Record<string,
	 * unknown>` so future provider keys do not require a type bump.
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
 * The model emits a {@link ToolCall} naming this function; your code is
 * responsible for executing it and supplying the result back as a
 * `tool`-role {@link Message}. See docs/openrouter/llm.md §Tool Calls.
 */
export interface FunctionTool {
	/** Discriminator: always the literal string `"function"`. */
	type: 'function'
	/** Function declaration the model sees. */
	function: {
		/**
		 * Name the model uses to invoke this tool. Must be unique within a
		 * single request and match the function regex (alnum + underscore).
		 */
		name: string
		/** Natural-language description shown to the model. */
		description: string
		/**
		 * JSON Schema (subset) describing the function arguments. Models will
		 * emit `arguments` as a JSON string conforming to this schema.
		 */
		parameters: object
	}
}

/**
 * Server-side datetime tool. OpenRouter supplies the current datetime when
 * invoked; your code does not implement it. See
 * docs/openrouter/tool-datetime.md.
 */
export interface DatetimeServerTool {
	/** Discriminator: literal `"openrouter:datetime"`. */
	type: 'openrouter:datetime'
}

/**
 * Server-side web search tool. Executes a search on OpenRouter's
 * infrastructure (forwarded to the chosen provider's search backend) and
 * returns results as URL citations attached to the assistant message.
 * See docs/openrouter/tool-web_search.md for the full `parameters` shape.
 */
export interface WebSearchServerTool {
	/** Discriminator: literal `"openrouter:web_search"`. */
	type: 'openrouter:web_search'
	/** Optional search configuration. */
	parameters?: {
		/**
		 * Hint for how much context the model should be given from each
		 * result. `low` returns short snippets, `high` returns longer
		 * extracts. Provider default applies when omitted.
		 */
		search_context_size?: 'low' | 'medium' | 'high'
		/** Geographic targeting for region-sensitive queries. */
		user_location?: {
			type: 'approximate'
			approximate: {
				/** ISO 3166-1 alpha-2 country code. */
				country?: string
				/** Free-form city name. */
				city?: string
				/** Free-form region/state name. */
				region?: string
				/** IANA timezone (e.g. `"America/Los_Angeles"`). */
				timezone?: string
			}
		}
	}
}

/**
 * Any tool OpenRouter accepts: either a client-side {@link FunctionTool}
 * (you implement `execute`) or an OpenRouter-hosted server tool
 * ({@link DatetimeServerTool}, {@link WebSearchServerTool}).
 * See docs/openrouter/llm.md and docs/openrouter/tool-*.md.
 */
export type OpenRouterTool = FunctionTool | DatetimeServerTool | WebSearchServerTool

/**
 * URL citation annotation attached to an assistant message. Populated by
 * OpenRouter when a server tool (e.g. {@link WebSearchServerTool}) returns
 * sources, normalized across providers. See
 * docs/openrouter/tool-web_search.md.
 */
export interface UrlCitationAnnotation {
	/** Discriminator: literal `"url_citation"`. */
	type: 'url_citation'
	/** Citation payload. */
	url_citation: {
		/** Absolute URL of the cited source. */
		url: string
		/** Human-readable page title as discovered by the search backend. */
		title: string
		/** Optional snippet/extract from the source. */
		content?: string
		/** Inclusive start index of the citation span within the assistant content. */
		start_index?: number
		/** Exclusive end index of the citation span within the assistant content. */
		end_index?: number
	}
}

/**
 * Any message-level annotation. Currently only {@link UrlCitationAnnotation}
 * is defined; the union is open for future annotation types.
 */
export type Annotation = UrlCitationAnnotation

/**
 * Non-streaming choice shape from OpenRouter — one entry per
 * `n`-of-completion (typically a single entry for `n=1`). Returned in
 * {@link CompletionsResponse.choices}.
 */
export interface NonStreamingChoice {
	/**
	 * Normalized finish reason across providers (`"stop"`, `"length"`,
	 * `"tool_calls"`, `"content_filter"`, `"error"`, …). `null` while the
	 * choice is still in flight (not applicable to non-streaming responses).
	 * See docs/openrouter/llm.md.
	 */
	finish_reason: string | null
	/** Provider-specific raw finish reason, unmapped. Useful for debugging. */
	native_finish_reason: string | null
	/** Assistant message produced by the model. */
	message: {
		/** Free-form text. May be `null` if the turn produced only tool calls. */
		content: string | null
		/** Role of the producer — typically `"assistant"`. */
		role: string
		/** Tool calls the model emitted, if any. */
		tool_calls?: ToolCall[]
		/** Annotations (e.g. URL citations from server tools). */
		annotations?: Annotation[]
	}
	/** Populated when `finish_reason === "error"`. */
	error?: ErrorResponse
}

/**
 * Error payload returned by OpenRouter inside a choice or as the body of
 * a non-2xx response. See {@link OpenRouterError} for the thrown form.
 */
export interface ErrorResponse {
	/** HTTP-style status code (mirrors the response status). */
	code: number
	/** Human-readable error message. */
	message: string
	/** Provider-specific extra detail (rate-limit info, moderation flags, …). */
	metadata?: Record<string, unknown>
}

/**
 * Full non-streaming response from `/chat/completions`. Returned by
 * {@link OpenRouterClient.complete}.
 */
export interface CompletionsResponse {
	/** Server-assigned generation id. Use to look up the generation in OpenRouter logs. */
	id: string
	/** One {@link NonStreamingChoice} per `n` (default `n=1`). */
	choices: NonStreamingChoice[]
	/** Unix epoch (seconds) when the response was created. */
	created: number
	/** The model that actually served the request (may differ from the requested slug after fallback). */
	model: string
	/** Object discriminator. Always `"chat.completion"` for this endpoint. */
	object: 'chat.completion'
	/** Provider fingerprint (OpenAI-style). Absent on most non-OpenAI models. */
	system_fingerprint?: string
	/** Token usage and (optionally) cost — populated when the provider reports it. */
	usage?: Usage
}

/**
 * Request body POSTed to `/chat/completions`. Extends {@link LLMConfig}
 * with the two fields the agent loop owns: `messages` (the conversation)
 * and `tools` (the registry).
 */
export interface CompletionsRequest extends LLMConfig {
	/** Full conversation history including the current turn. */
	messages: Message[]
	/** Tools available to the model on this turn. */
	tools?: OpenRouterTool[]
	/**
	 * Whether to stream via SSE. The {@link OpenRouterClient} hardcodes this
	 * per-method (`false` for {@link OpenRouterClient.complete}, `true` for
	 * {@link OpenRouterClient.completeStream}), so callers normally leave it
	 * unset.
	 */
	stream?: boolean
}

/**
 * Incremental tool-call piece from a streaming response. `index` identifies
 * which tool call this piece applies to (tool calls are streamed in
 * parallel keyed by index). `id` and `function.name` typically appear only
 * on the first chunk for a given `index`; `function.arguments` is a JSON
 * string fragment to concatenate in arrival order.
 */
export interface ToolCallDelta {
	/**
	 * Stable index identifying which parallel tool call this delta belongs
	 * to. Concatenate fragments sharing the same `index`.
	 */
	index: number
	/** Tool-call id assigned by the model. Usually only present on the first delta. */
	id?: string
	/** Discriminator: `"function"`. Usually only present on the first delta. */
	type?: 'function'
	/** Function call payload fragment. */
	function?: {
		/** Function name. Usually only present on the first delta. */
		name?: string
		/** JSON-string fragment of arguments to be concatenated across deltas. */
		arguments?: string
	}
}

/**
 * Streaming choice shape from OpenRouter — one per choice within a single
 * SSE chunk. See docs/openrouter/llm.md.
 */
export interface StreamingChoice {
	/**
	 * Normalized finish reason. `null` while content is still streaming;
	 * non-null on the final delta for this choice.
	 */
	finish_reason: string | null
	/** Provider-specific raw finish reason, unmapped. */
	native_finish_reason: string | null
	/** Incremental update (one piece) of the assistant message under construction. */
	delta: {
		/** Text fragment to append, or `null` for non-text deltas. */
		content: string | null
		/** Role declaration — typically only present on the very first delta. */
		role?: string
		/** Tool-call fragments (see {@link ToolCallDelta}). */
		tool_calls?: ToolCallDelta[]
	}
	/** Populated when this choice errored mid-stream. */
	error?: ErrorResponse
}

/**
 * A single SSE chunk parsed from `/chat/completions` when `stream: true`.
 * The final chunk before `[DONE]` carries `usage` with an empty `choices`
 * array; all other chunks carry one or more {@link StreamingChoice}.
 */
export interface CompletionChunk {
	/** Server-assigned generation id (same value across all chunks of a stream). */
	id: string
	/** Object discriminator. Always `"chat.completion.chunk"`. */
	object: 'chat.completion.chunk'
	/** Unix epoch (seconds) for the start of the response. */
	created: number
	/** The model actually serving the response. */
	model: string
	/** Streaming choices in this chunk. Empty on the final usage-only chunk. */
	choices: StreamingChoice[]
	/** Token usage. Typically present only on the final chunk. */
	usage?: Usage
}

/**
 * Default model slug used when no `model` is set anywhere in the
 * config layering ({@link CompletionsRequest} > {@link OpenRouterClient}
 * defaults > this constant).
 */
export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'
