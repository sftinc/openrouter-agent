import type {
	CompletionChunk,
	CompletionsRequest,
	CompletionsResponse,
	LLMConfig,
} from './types.js'
import { DEFAULT_MODEL } from './types.js'
import { parseSseStream } from './sse.js'

/**
 * Thrown when OpenRouter returns a non-2xx response.
 */
export class OpenRouterError extends Error {
	readonly code: number
	readonly body?: unknown
	readonly metadata?: Record<string, unknown>

	constructor(params: { code: number; message: string; body?: unknown; metadata?: Record<string, unknown> }) {
		super(params.message)
		this.name = 'OpenRouterError'
		this.code = params.code
		this.body = params.body
		this.metadata = params.metadata
	}
}

/**
 * Options for the OpenRouter client. Project-wide LLM defaults (model,
 * max_tokens, temperature, etc.) live here via `LLMConfig` — everything on
 * `LLMConfig` is part of the chat-completions request body. `apiKey`,
 * `referer`, and `title` are transport-level fields sent as headers.
 */
export interface OpenRouterClientOptions extends LLMConfig {
	apiKey?: string
	title?: string
	referer?: string
}

const BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Thin HTTP client for OpenRouter's `/chat/completions` endpoint. Holds the
 * API key (from env or constructor), optional `referer`/`title` headers for
 * OpenRouter attribution, and default `LLMConfig` values applied to every
 * request.
 *
 * Per-request fields always override client defaults, which override the
 * built-in `DEFAULT_MODEL` fallback. Streaming is not supported — see
 * `complete()` JSDoc.
 */
export class OpenRouterClient {
	private readonly apiKey: string
	private readonly referer?: string
	private readonly title?: string
	private readonly defaults: LLMConfig

	/**
	 * @param options Client options. `apiKey` falls back to the
	 *   `OPENROUTER_API_KEY` env var; if neither is set the constructor throws.
	 *   `title` is sent as `X-OpenRouter-Title`; `referer` as `HTTP-Referer`.
	 *   All other fields (`model`, `temperature`, etc.) become `LLMConfig`
	 *   defaults.
	 * @throws Error if no API key is available from either source.
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
	 * Shallow-merged LLMConfig defaults configured on this client. Useful for
	 * callers (like the agent loop) that want to read what the client will send
	 * for fields the caller has not overridden.
	 */
	get llmDefaults(): LLMConfig {
		return { ...this.defaults }
	}

	/**
	 * POSTs a streaming chat completion to `${BASE_URL}/chat/completions` with
	 * `stream: true` and yields parsed SSE chunks as they arrive. The final
	 * chunk before `[DONE]` carries `usage` with an empty `choices` array.
	 *
	 * @throws OpenRouterError on non-2xx responses (thrown before any chunks
	 *   are yielded). Aborts via `signal` cancel the underlying fetch and the
	 *   SSE reader.
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
			// Cancel the underlying body stream if the generator is abandoned
			// early (e.g. via AbortSignal or consumer calling return()).
			response.body.cancel().catch(() => {
				// ignore errors on cancel — stream may already be closed
			})
		}
	}

	/**
	 * POSTs a non-streaming chat completion to `${BASE_URL}/chat/completions`
	 * and returns the parsed response. The request is sent with `stream: false`.
	 * For token-by-token SSE streaming use `completeStream` on this client.
	 *
	 * @throws OpenRouterError on non-2xx responses. Common codes: 401 (missing
	 *   or invalid key), 402 (out of credits), 429 (rate limited), 503
	 *   (upstream provider error).
	 */
	async complete(request: CompletionsRequest, signal?: AbortSignal): Promise<CompletionsResponse> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		}
		if (this.referer) headers['HTTP-Referer'] = this.referer
		if (this.title) headers['X-OpenRouter-Title'] = this.title

		// Precedence: DEFAULT_MODEL fallback < client.defaults < per-request fields.
		// `stream: false` is hardcoded — this client is non-streaming by design.
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

	private async safeParseJson(response: Response): Promise<unknown> {
		try {
			return await response.json()
		} catch {
			return undefined
		}
	}
}

/**
 * Folds an ordered list of streaming `CompletionChunk`s into the same
 * `CompletionsResponse` shape the non-streaming endpoint returns. Used only
 * for `OPENROUTER_DEBUG` logging — the runtime path consumes chunks directly.
 *
 * Per-choice accumulation:
 *   - `content`: concatenate every `delta.content` string.
 *   - `role`: take the first non-empty `delta.role` (defaults to "assistant").
 *   - `tool_calls`: keyed by `index`; first appearance locks `id`/`type`/
 *     `function.name`, `function.arguments` strings concatenate.
 *   - `finish_reason` / `native_finish_reason`: last non-null wins.
 *
 * Top-level `id`/`model`/`created` come from the first chunk that has them;
 * `usage` from whichever chunk carries it (typically the final frame).
 */
function assembleCompletionsResponse(chunks: CompletionChunk[]): CompletionsResponse {
	type ToolAcc = { id?: string; type?: 'function'; name?: string; arguments: string }
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
			// OpenRouter SSE choices carry an `index`, but our `StreamingChoice`
			// type doesn't declare it; fall back to position when missing.
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
