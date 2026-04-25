/**
 * @file HTTP client for OpenRouter's chat completions endpoint.
 *
 * Wraps `POST https://openrouter.ai/api/v1/chat/completions` with two entry
 * points:
 *   - {@link OpenRouterClient.complete} for non-streaming JSON responses.
 *   - {@link OpenRouterClient.completeStream} for SSE token-by-token streaming.
 *
 * Also defines {@link OpenRouterError}, the typed error thrown on any non-2xx
 * response, and the internal `assembleCompletionsResponse` helper used solely
 * to render a streaming run as a single response object for `OPENROUTER_DEBUG`
 * logging.
 *
 * The client is thin on purpose: it does not retry, queue, or rate-limit.
 * Higher-level concerns (the agent loop, tool execution, message
 * persistence) live in `src/agent/` and `src/session/`.
 */

import type {
	CompletionChunk,
	CompletionsRequest,
	CompletionsResponse,
	LLMConfig,
} from './types.js'
import { DEFAULT_MODEL } from './types.js'
import { parseSseStream } from './sse.js'

/**
 * Error thrown by {@link OpenRouterClient} when OpenRouter returns a non-2xx
 * response. The HTTP status is on {@link OpenRouterError.code}; the parsed
 * response body (if any) is on {@link OpenRouterError.body}; provider-specific
 * extras (rate-limit windows, moderation reasons, …) on
 * {@link OpenRouterError.metadata}.
 *
 * Common codes:
 *   - `401` — missing or invalid API key.
 *   - `402` — out of credits.
 *   - `429` — rate limited (check `metadata` for retry hints).
 *   - `503` — upstream provider unavailable.
 */
export class OpenRouterError extends Error {
	/** HTTP status code that triggered the error. */
	readonly code: number
	/** Parsed JSON body of the error response, or `undefined` if the body was not JSON. */
	readonly body?: unknown
	/** Provider-specific extra detail extracted from `body.error.metadata`. */
	readonly metadata?: Record<string, unknown>

	/**
	 * @param params Constructor params.
	 * @param params.code HTTP status code.
	 * @param params.message Human-readable message (becomes `Error.message`).
	 * @param params.body Optional parsed response body.
	 * @param params.metadata Optional provider metadata.
	 */
	constructor(params: { code: number; message: string; body?: unknown; metadata?: Record<string, unknown> }) {
		super(params.message)
		this.name = 'OpenRouterError'
		this.code = params.code
		this.body = params.body
		this.metadata = params.metadata
	}
}

/**
 * Options for {@link OpenRouterClient}. Project-wide LLM defaults (model,
 * max_tokens, temperature, etc.) live here via {@link LLMConfig} —
 * everything on `LLMConfig` is part of the chat-completions request body.
 * `apiKey`, `referer`, and `title` are transport-level fields sent as
 * headers and are stripped from the request body.
 */
export interface OpenRouterClientOptions extends LLMConfig {
	/**
	 * OpenRouter API key. Falls back to the `OPENROUTER_API_KEY` environment
	 * variable when omitted. The constructor throws if neither source
	 * provides a key.
	 */
	apiKey?: string
	/**
	 * Optional human-readable site/app name. Sent as the
	 * `X-OpenRouter-Title` header for OpenRouter rankings/attribution.
	 */
	title?: string
	/**
	 * Optional referer URL. Sent as the `HTTP-Referer` header for OpenRouter
	 * rankings/attribution.
	 */
	referer?: string
}

/**
 * Base URL for the OpenRouter v1 API. All endpoints in this client are
 * formed by appending a path (e.g. `/chat/completions`).
 */
const BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Thin HTTP client for OpenRouter's `/chat/completions` endpoint. Holds the
 * API key (from env or constructor), optional `referer`/`title` headers for
 * OpenRouter attribution, and default {@link LLMConfig} values applied to
 * every request.
 *
 * Per-request fields always override client defaults, which override the
 * built-in {@link DEFAULT_MODEL} fallback. Both streaming and non-streaming
 * shapes are supported via {@link OpenRouterClient.completeStream} and
 * {@link OpenRouterClient.complete} respectively.
 *
 * @example
 * ```ts
 * const client = new OpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   model: "anthropic/claude-haiku-4.5",
 *   temperature: 0.2,
 * });
 * const res = await client.complete({ messages: [{ role: "user", content: "hi" }] });
 * ```
 */
export class OpenRouterClient {
	/** Resolved API key (constructor argument or `OPENROUTER_API_KEY`). */
	private readonly apiKey: string
	/** Optional `HTTP-Referer` header value. */
	private readonly referer?: string
	/** Optional `X-OpenRouter-Title` header value. */
	private readonly title?: string
	/** Per-client {@link LLMConfig} defaults applied to every request. */
	private readonly defaults: LLMConfig

	/**
	 * Build a client. Pulls the API key from the options first, then from
	 * the `OPENROUTER_API_KEY` environment variable. All fields beyond
	 * `apiKey`, `title`, and `referer` are stored as {@link LLMConfig}
	 * defaults.
	 *
	 * @param options Client options. `apiKey` falls back to the
	 *   `OPENROUTER_API_KEY` env var; if neither is set the constructor
	 *   throws. `title` is sent as `X-OpenRouter-Title`; `referer` as
	 *   `HTTP-Referer`. All other fields (`model`, `temperature`, etc.)
	 *   become {@link LLMConfig} defaults.
	 * @throws {Error} If no API key is available from either source.
	 */
	constructor(options: OpenRouterClientOptions) {
		const { apiKey, title, referer, ...llmDefaults } = options
		const envKey = typeof process !== 'undefined' ? process.env?.OPENROUTER_API_KEY : undefined
		const key = apiKey ?? envKey
		if (!key) {
			throw new Error('OPENROUTER_API_KEY is not set. Pass apiKey to the OpenRouterClient or set the env var.')
		}
		this.apiKey = key
		this.title = title
		this.referer = referer
		this.defaults = llmDefaults
	}

	/**
	 * Shallow-copied {@link LLMConfig} defaults configured on this client.
	 * Useful for callers (like the agent loop) that want to read what the
	 * client will send for fields the caller has not overridden. Returns a
	 * fresh object on each call — mutating the result has no effect on the
	 * client.
	 */
	get llmDefaults(): LLMConfig {
		return { ...this.defaults }
	}

	/**
	 * POSTs a streaming chat completion to `${BASE_URL}/chat/completions`
	 * with `stream: true` and yields parsed SSE chunks
	 * ({@link CompletionChunk}) as they arrive. The final chunk before the
	 * `[DONE]` sentinel typically carries `usage` with an empty `choices`
	 * array.
	 *
	 * Precedence for the request body, lowest to highest priority:
	 *   1. {@link DEFAULT_MODEL} as the model fallback;
	 *   2. this client's {@link LLMConfig} defaults;
	 *   3. fields on `request`;
	 *   4. `stream: true` (always forced).
	 *
	 * When the `OPENROUTER_DEBUG` env var is set, every chunk is collected
	 * and reassembled into a single {@link CompletionsResponse} via
	 * {@link assembleCompletionsResponse} for diagnostic logging after the
	 * stream completes.
	 *
	 * @param request The completion request. `messages` is required;
	 *   everything else may be omitted to inherit defaults.
	 * @param signal Optional `AbortSignal`. Aborting cancels the underlying
	 *   `fetch` and the SSE reader; the generator throws an `AbortError`.
	 * @returns Async generator yielding {@link CompletionChunk} values. The
	 *   generator returns when `[DONE]` is seen or the body closes.
	 * @throws {OpenRouterError} On non-2xx responses (thrown before any
	 *   chunks are yielded) or when the response has no body.
	 *
	 * @example
	 * ```ts
	 * for await (const chunk of client.completeStream({ messages })) {
	 *   process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
	 * }
	 * ```
	 */
	async *completeStream(
		request: CompletionsRequest,
		signal?: AbortSignal,
	): AsyncGenerator<CompletionChunk, void, void> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		}
		if (this.referer) headers['HTTP-Referer'] = this.referer
		if (this.title) headers['X-OpenRouter-Title'] = this.title

		const body = {
			model: DEFAULT_MODEL,
			...this.defaults,
			...request,
			stream: true as const,
		}

		const response = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok) {
			const errBody = await this.safeParseJson(response)
			const message =
				(errBody as { error?: { message?: string } } | undefined)?.error?.message ??
				`HTTP ${response.status}`
			const metadata = (errBody as { error?: { metadata?: Record<string, unknown> } } | undefined)?.error?.metadata
			throw new OpenRouterError({
				code: response.status,
				message,
				body: errBody,
				metadata,
			})
		}

		if (!response.body) {
			throw new OpenRouterError({
				code: response.status,
				message: 'streaming response had no body',
			})
		}

		const debug = !!process.env.OPENROUTER_DEBUG
		const debugChunks: CompletionChunk[] = []
		try {
			for await (const payload of parseSseStream(response.body)) {
				const chunk = payload as CompletionChunk
				if (debug) debugChunks.push(chunk)
				yield chunk
			}
			if (debug) {
				const assembled = assembleCompletionsResponse(debugChunks)
				const hasToolCalls = (assembled.choices ?? []).some(
					(c) => Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0,
				)
				const debugBody = JSON.stringify(assembled)
				// eslint-disable-next-line no-console
				console.log('[openrouter:stream] response:', hasToolCalls ? `\x1b[33m${debugBody}\x1b[0m` : debugBody)
			}
		} finally {
			/**
			 * Cancel the underlying body stream if the generator is abandoned
			 * early (e.g. via AbortSignal or the consumer calling `return()`).
			 * Errors are swallowed because the stream may already be closed.
			 */
			response.body.cancel().catch(() => {
				// ignore errors on cancel — stream may already be closed
			})
		}
	}

	/**
	 * POSTs a non-streaming chat completion to `${BASE_URL}/chat/completions`
	 * and returns the parsed {@link CompletionsResponse}. The request is
	 * sent with `stream: false`. For token-by-token SSE streaming use
	 * {@link OpenRouterClient.completeStream}.
	 *
	 * Precedence for the request body, lowest to highest priority:
	 *   1. {@link DEFAULT_MODEL} as the model fallback;
	 *   2. this client's {@link LLMConfig} defaults;
	 *   3. fields on `request`;
	 *   4. `stream: false` (always forced).
	 *
	 * When `OPENROUTER_DEBUG` is set, the parsed response is logged to
	 * stderr/stdout (yellow if it contains tool calls).
	 *
	 * @param request The completion request. `messages` is required.
	 * @param signal Optional `AbortSignal` to cancel the underlying `fetch`.
	 * @returns The parsed {@link CompletionsResponse}.
	 * @throws {OpenRouterError} On non-2xx responses. Common codes: 401
	 *   (missing or invalid key), 402 (out of credits), 429 (rate limited),
	 *   503 (upstream provider error).
	 */
	async complete(request: CompletionsRequest, signal?: AbortSignal): Promise<CompletionsResponse> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		}
		if (this.referer) headers['HTTP-Referer'] = this.referer
		if (this.title) headers['X-OpenRouter-Title'] = this.title

		/**
		 * Precedence: DEFAULT_MODEL fallback < client.defaults < per-request fields.
		 * `stream: false` is hardcoded — this method is non-streaming by design.
		 */
		const body = {
			model: DEFAULT_MODEL,
			...this.defaults,
			...request,
			stream: false as const,
		}

		const response = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok) {
			const errBody = await this.safeParseJson(response)
			// eslint-disable-next-line no-console
			console.error('[openrouter] error response:', response.status, JSON.stringify(errBody))

			const message =
				(errBody as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${response.status}`
			const metadata = (errBody as { error?: { metadata?: Record<string, unknown> } } | undefined)?.error?.metadata
			throw new OpenRouterError({
				code: response.status,
				message,
				body: errBody,
				metadata,
			})
		}

		const json = (await response.json()) as CompletionsResponse
		if (process.env.OPENROUTER_DEBUG) {
			const hasToolCalls = (json.choices ?? []).some(
				(c) => Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0,
			)
			const debugBody = JSON.stringify(json, (key, value) => {
				// Hide reasoning details
				// if (key === 'reasoning' || key === 'reasoning_details') return undefined
				return value
			})
			if (process.env.OPENROUTER_DEBUG) {
				// eslint-disable-next-line no-console
				console.log('[openrouter] response:', hasToolCalls ? `\x1b[33m${debugBody}\x1b[0m` : debugBody)
			}
		}
		return json
	}

	/**
	 * Best-effort JSON parse of an HTTP response body. Returns `undefined`
	 * on any parse error so callers can surface the raw status without
	 * throwing a secondary error.
	 *
	 * @param response The `Response` to consume. The body is consumed even
	 *   on failure (subsequent reads will throw).
	 * @returns The parsed JSON, or `undefined` if the body was not JSON.
	 */
	private async safeParseJson(response: Response): Promise<unknown> {
		try {
			return await response.json()
		} catch {
			return undefined
		}
	}
}

/**
 * Folds an ordered list of streaming {@link CompletionChunk}s into the same
 * {@link CompletionsResponse} shape the non-streaming endpoint returns.
 * Used only for `OPENROUTER_DEBUG` logging — the runtime path consumes
 * chunks directly.
 *
 * Per-choice accumulation:
 *   - `content`: concatenate every `delta.content` string.
 *   - `role`: take the first non-empty `delta.role` (defaults to
 *     `"assistant"`).
 *   - `tool_calls`: keyed by `index`; first appearance locks
 *     `id`/`type`/`function.name`, `function.arguments` strings concatenate.
 *   - `finish_reason` / `native_finish_reason`: last non-null wins.
 *
 * Top-level `id`/`model`/`created` come from the first chunk that has them;
 * `usage` from whichever chunk carries it (typically the final frame).
 *
 * @param chunks Stream chunks in arrival order.
 * @returns A synthesized {@link CompletionsResponse} equivalent to what
 *   the non-streaming endpoint would have returned for the same generation.
 */
function assembleCompletionsResponse(chunks: CompletionChunk[]): CompletionsResponse {
	/**
	 * Per-tool-call accumulator. `id`/`type`/`name` are locked on first
	 * appearance; `arguments` accumulates concatenated JSON-string fragments.
	 */
	type ToolAcc = { id?: string; type?: 'function'; name?: string; arguments: string }
	/** Per-choice accumulator built up across chunks. */
	type ChoiceAcc = {
		content: string
		role: string
		toolCalls: Map<number, ToolAcc>
		finish_reason: string | null
		native_finish_reason: string | null
	}
	const choices = new Map<number, ChoiceAcc>()
	let id = ''
	let model = ''
	let created = 0
	let usage: CompletionsResponse['usage']

	for (const chunk of chunks) {
		if (!id && chunk.id) id = chunk.id
		if (!model && chunk.model) model = chunk.model
		if (!created && chunk.created) created = chunk.created
		if (chunk.usage) usage = chunk.usage
		const cs = chunk.choices ?? []
		for (let i = 0; i < cs.length; i++) {
			const sc = cs[i]!
			/**
			 * OpenRouter SSE choices carry an `index`, but our
			 * {@link StreamingChoice} type doesn't declare it; fall back to
			 * position when missing.
			 */
			const idx = (sc as unknown as { index?: number }).index ?? i
			let acc = choices.get(idx)
			if (!acc) {
				acc = {
					content: '',
					role: 'assistant',
					toolCalls: new Map(),
					finish_reason: null,
					native_finish_reason: null,
				}
				choices.set(idx, acc)
			}
			if (typeof sc.delta?.content === 'string') acc.content += sc.delta.content
			if (sc.delta?.role) acc.role = sc.delta.role
			for (const td of sc.delta?.tool_calls ?? []) {
				let tc = acc.toolCalls.get(td.index)
				if (!tc) {
					tc = { id: td.id, type: td.type, name: td.function?.name, arguments: '' }
					acc.toolCalls.set(td.index, tc)
				} else {
					if (!tc.id && td.id) tc.id = td.id
					if (!tc.type && td.type) tc.type = td.type
					if (!tc.name && td.function?.name) tc.name = td.function.name
				}
				if (typeof td.function?.arguments === 'string') tc.arguments += td.function.arguments
			}
			if (sc.finish_reason !== null && sc.finish_reason !== undefined) acc.finish_reason = sc.finish_reason
			if (sc.native_finish_reason !== null && sc.native_finish_reason !== undefined)
				acc.native_finish_reason = sc.native_finish_reason
		}
	}

	const sortedIndexes = [...choices.keys()].sort((a, b) => a - b)
	return {
		id,
		object: 'chat.completion',
		created,
		model,
		choices: sortedIndexes.map((idx) => {
			const acc = choices.get(idx)!
			const toolCalls = [...acc.toolCalls.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, tc]) => ({
					id: tc.id ?? '',
					type: (tc.type ?? 'function') as 'function',
					function: { name: tc.name ?? '', arguments: tc.arguments },
				}))
			return {
				finish_reason: acc.finish_reason,
				native_finish_reason: acc.native_finish_reason,
				message: {
					role: acc.role,
					content: acc.content.length > 0 ? acc.content : null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				},
			}
		}),
		...(usage ? { usage } : {}),
	}
}
