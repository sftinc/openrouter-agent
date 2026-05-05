/**
 * @file `OpenRouterClient` — thin shell around `Transport` plus three
 * namespace classes (chat, embeddings, audio.transcriptions). Each
 * endpoint owns its own defaults and request/response types; transport-level
 * concerns (auth, headers, retry) live on the shared {@link Transport}.
 *
 * Re-exports {@link OpenRouterError} (defined in `errors.ts`) and the
 * public {@link RequestOptions} type.
 */

import { Transport, isLocalhostUrl } from './transport.js'
import { ChatNamespace } from './chat.js'
import { EmbeddingsNamespace } from './embeddings.js'
import { AudioNamespace } from './audio/index.js'
import type { LLMConfig } from './types.js'
import type { TranscriptionsDefaults } from './audio/transcriptions.types.js'
import type { RetryConfig, RetryBudget } from './retry.js'

export { OpenRouterError } from './errors.js'
export type { RequestOptions } from './transport.js'

/**
 * Body of a request to {@link EmbeddingsNamespace.create}. Mirrors
 * OpenRouter's OpenAI-compatible embeddings shape.
 *
 * @example
 * ```ts
 * import { OpenRouterClient } from "./openrouter";
 * const client = new OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY });
 * const res = await client.embeddings.create({
 *   input: ["hello", "world"],
 *   model: "openai/text-embedding-3-small",
 * });
 * ```
 */
export interface EmbedRequest {
	/** Embedding model id. Falls through to client default → hardcoded fallback `"openai/text-embedding-3-small"`. */
	model?: string
	/** Text(s) to embed. */
	input: string | string[]
	/** Optional output dimensionality. Rejected by models that don't support it. */
	dimensions?: number
	/** Output encoding. Default `"float"`. */
	encoding_format?: 'float' | 'base64'
	/**
	 * Provider-specific input classification. Cohere uses
	 * `"search_query"` / `"search_document"` / `"classification"` /
	 * `"clustering"`; Voyage uses `"query"` / `"document"`.
	 */
	input_type?: string
	/** Optional end-user identifier forwarded to the provider. */
	user?: string
}

/**
 * Parsed response from {@link EmbeddingsNamespace.create}. OpenAI-compatible
 * shape; some sub-fields are optional because providers populate them
 * inconsistently.
 */
export interface EmbedResponse {
	/** Server-assigned response id. */
	id: string
	/** Always `"list"`. Object discriminator. */
	object: 'list'
	/** The model that actually served the request. */
	model: string
	/** One entry per input, index-aligned. */
	data: Array<{
		object: 'embedding'
		index: number
		/** Vector when `encoding_format` is `"float"`; base64 string when `"base64"`. */
		embedding: number[] | string
	}>
	/** Token usage and (optionally) cost. */
	usage: {
		prompt_tokens: number
		total_tokens: number
		/** Optional credit cost. */
		cost?: number
		/** Optional per-modality / cache breakdown. */
		prompt_tokens_details?: {
			cached_tokens?: number
			text_tokens?: number
			image_tokens?: number
			audio_tokens?: number
			video_tokens?: number
		}
	}
}

/**
 * Default values applied to every {@link EmbeddingsNamespace.create}
 * request unless overridden per call. All fields optional. Field-level
 * resolution: per-call request > these defaults > hardcoded fallback
 * (`"openai/text-embedding-3-small"` for `model`).
 */
export interface EmbeddingsDefaults {
	/** Default embedding model. Falls back to `"openai/text-embedding-3-small"`. */
	model?: string
	/** Default output dimensionality. */
	dimensions?: number
	/** Default output encoding. */
	encoding_format?: 'float' | 'base64'
	/** Default provider-specific input classification. */
	input_type?: string
	/** Default end-user identifier forwarded to the provider. */
	user?: string
}

/**
 * Options for {@link OpenRouterClient}. Top-level fields are
 * transport-shared (`apiKey`, `referer`, `title`, `retry`); per-modality
 * defaults live under `chat`, `embeddings`, and `audio.transcriptions`.
 *
 * @example
 * ```ts
 * import { OpenRouterClient } from "./openrouter";
 *
 * const client = new OpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   referer: "https://myapp.com",
 *   title: "my-app",
 *   chat: { model: "anthropic/claude-haiku-4.5", temperature: 0.2 },
 *   embeddings: { model: "qwen/qwen3-embedding-8b" },
 *   audio: { transcriptions: { model: "openai/whisper-1" } },
 * });
 * ```
 */
export interface OpenRouterClientOptions {
	/** OpenRouter API key. Falls back to `OPENROUTER_API_KEY` env var. */
	apiKey?: string
	/** Optional `HTTP-Referer` value for OpenRouter app attribution. */
	referer?: string
	/** Optional `X-OpenRouter-Title` value (only used when `referer` is set). */
	title?: string
	/** Retry policy shared across all namespaces. */
	retry?: RetryConfig
	/** Defaults applied to every chat completion request. */
	chat?: LLMConfig
	/** Defaults applied to every embeddings request. */
	embeddings?: EmbeddingsDefaults
	/** Defaults applied to audio sub-namespaces. */
	audio?: { transcriptions?: TranscriptionsDefaults }
}

/**
 * Root OpenRouter client. Exposes one namespace per endpoint family:
 *
 * - `client.chat` — chat completions ({@link ChatNamespace})
 * - `client.embeddings` — embeddings ({@link EmbeddingsNamespace})
 * - `client.audio.transcriptions` — speech-to-text ({@link AudioNamespace})
 *
 * Holds the {@link Transport} privately; it is shared across all three
 * namespaces. There is no top-level `model` / `embedModel` /
 * `transcriptionModel` — every model lives under its namespace.
 *
 * @example
 * ```ts
 * import { OpenRouterClient } from "./openrouter";
 *
 * const client = new OpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   chat: { model: "anthropic/claude-haiku-4.5" },
 * });
 * const res = await client.chat.complete({
 *   messages: [{ role: "user", content: "hi" }],
 * });
 * ```
 */
export class OpenRouterClient {
	/** Chat completions namespace. */
	readonly chat: ChatNamespace
	/** Embeddings namespace. */
	readonly embeddings: EmbeddingsNamespace
	/** Audio sub-namespaces. */
	readonly audio: AudioNamespace

	/**
	 * @param options Transport options + per-namespace defaults. All optional.
	 *   `apiKey` falls back to `OPENROUTER_API_KEY` env var; if both are
	 *   missing the constructor throws.
	 */
	constructor(options: OpenRouterClientOptions = {}) {
		if (options.title && !options.referer) {
			// eslint-disable-next-line no-console
			console.warn(
				'[OpenRouterClient] `title` was provided without `referer`. OpenRouter ignores `X-OpenRouter-Title` unless `HTTP-Referer` is also set, so the title will not appear in OpenRouter logs or rankings. See https://openrouter.ai/docs/app-attribution',
			)
		}
		if (options.referer && !options.title && isLocalhostUrl(options.referer)) {
			// eslint-disable-next-line no-console
			console.warn(
				`[OpenRouterClient] \`referer\` is a localhost URL (${options.referer}) but \`title\` was not provided. OpenRouter requires \`X-OpenRouter-Title\` alongside a localhost \`HTTP-Referer\` for the app to be tracked. See https://openrouter.ai/docs/app-attribution`,
			)
		}

		const transport = new Transport({
			apiKey: options.apiKey,
			referer: options.referer,
			title: options.title,
			retry: options.retry,
		})
		this.chat = new ChatNamespace(transport, options.chat)
		this.embeddings = new EmbeddingsNamespace(transport, options.embeddings)
		this.audio = new AudioNamespace(transport, options.audio)
	}
}

/** Re-export for callers that share a budget across layers. */
export type { RetryBudget }
