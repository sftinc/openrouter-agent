/**
 * @file Shared HTTP transport for the OpenRouter namespace classes
 * (`ChatNamespace`, `EmbeddingsNamespace`, `TranscriptionsNamespace`).
 *
 * Owns auth (`Authorization` header), attribution headers (`HTTP-Referer`,
 * `X-OpenRouter-Title`), the base URL, and the retry policy. Exposes a
 * `fetchWithRetry` helper that wraps `fetch` with `withRetry` and converts
 * non-2xx responses into typed {@link OpenRouterError}s.
 */

import { OpenRouterError } from "./errors.js";
import {
	parseRetryAfter,
	withRetry,
	createRetryBudget,
	resolveRetryConfig,
	type RetryConfig,
	type RetryBudget,
} from "./retry.js";

/**
 * Base URL for OpenRouter v1. All namespace classes form their endpoint URL
 * by appending a path (e.g. `/chat/completions`).
 */
export const BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Constructor options for {@link Transport}. Mirrors the transport-only
 * fields from `OpenRouterClientOptions`.
 */
export interface TransportOptions {
	/** OpenRouter API key. Falls back to `OPENROUTER_API_KEY` env var. */
	apiKey?: string;
	/** Optional `HTTP-Referer` value. */
	referer?: string;
	/** Optional `X-OpenRouter-Title` value. */
	title?: string;
	/** Optional retry policy. Defaults to `DEFAULT_RETRY_CONFIG`. */
	retry?: RetryConfig;
}

/**
 * Per-call options accepted by {@link Transport.fetchWithRetry}. Mirrors the
 * public `RequestOptions` shape so namespace methods can pass it through
 * directly.
 */
export interface RequestOptions {
	/** Cancellation signal. */
	signal?: AbortSignal;
	/** Shared retry budget; if omitted, the transport allocates its own. */
	retryBudget?: RetryBudget;
	/** Per-call override of the transport's resolved retry config. */
	retryConfig?: RetryConfig;
}

/**
 * Returns true for `localhost` / loopback hostnames. Used by
 * {@link OpenRouterClient}'s constructor to warn when `referer` is loopback
 * but `title` is not set (OpenRouter app-attribution requires `title` in
 * that case).
 */
export function isLocalhostUrl(value: string): boolean {
	try {
		const { hostname } = new URL(value);
		if (hostname === "localhost" || hostname === "::1") return true;
		return /^127(?:\.\d{1,3}){3}$/.test(hostname);
	} catch {
		return false;
	}
}

/**
 * Shared HTTP transport. Holds connection-level state (auth, headers, retry
 * config) and exposes the small set of helpers each namespace needs:
 * `buildHeaders`, `fetchWithRetry`, `safeParseJson`.
 */
export class Transport {
	/** Resolved API key (constructor or `OPENROUTER_API_KEY`). */
	readonly apiKey: string;
	/** Optional `HTTP-Referer` value. */
	readonly referer?: string;
	/** Optional `X-OpenRouter-Title` value. */
	readonly title?: string;
	/** Resolved retry policy (always fully populated). */
	readonly retry: ReturnType<typeof resolveRetryConfig>;

	/**
	 * Build a transport. Pulls the API key from options first, then from
	 * `OPENROUTER_API_KEY`.
	 *
	 * @throws {Error} If no API key is available from either source.
	 */
	constructor(options: TransportOptions) {
		const envKey = typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined;
		const key = options.apiKey ?? envKey;
		if (!key) {
			throw new Error(
				"OPENROUTER_API_KEY is not set. Pass apiKey to the OpenRouterClient or set the env var.",
			);
		}
		this.apiKey = key;
		this.referer = options.referer;
		this.title = options.title;
		this.retry = resolveRetryConfig(options.retry);
	}

	/**
	 * Build the transport headers. Always sets `Authorization` and
	 * `Content-Type`; conditionally sets `HTTP-Referer` and `X-OpenRouter-Title`.
	 *
	 * @param extra Optional extra headers (e.g. `Accept: text/event-stream`).
	 */
	buildHeaders(extra?: Record<string, string>): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			...extra,
		};
		if (this.referer) headers["HTTP-Referer"] = this.referer;
		if (this.title) headers["X-OpenRouter-Title"] = this.title;
		return headers;
	}

	/**
	 * POST a JSON-bodied request to `BASE_URL + path` with auth/attribution
	 * headers and `withRetry` applied. Returns the raw `Response` on 2xx so
	 * the caller can choose `.json()` (non-streaming) or `.body` (SSE). On
	 * non-2xx, throws {@link OpenRouterError} with parsed body, metadata, and
	 * `Retry-After` ms.
	 *
	 * @param path Path under {@link BASE_URL} (e.g. `/chat/completions`).
	 * @param init Standard `fetch` init. Must set `method` and `body`. Headers
	 *   merged on top of `buildHeaders(extraHeaders)`.
	 * @param opts Per-call cancel/retry options.
	 * @param logPrefix Prefix used in the error console.error (e.g.
	 *   `"[openrouter]"`, `"[openrouter:embed]"`).
	 * @param extraHeaders Optional extra headers (e.g. SSE Accept).
	 */
	async fetchWithRetry(
		path: string,
		init: { method: string; body: string },
		opts: RequestOptions = {},
		logPrefix = "[openrouter]",
		extraHeaders?: Record<string, string>,
	): Promise<Response> {
		const config = opts.retryConfig
			? resolveRetryConfig({ ...this.retry, ...opts.retryConfig })
			: this.retry;
		const budget = opts.retryBudget ?? createRetryBudget(config);
		const headers = this.buildHeaders(extraHeaders);

		return withRetry(
			async () => {
				const res = await fetch(`${BASE_URL}${path}`, {
					method: init.method,
					headers,
					body: init.body,
					signal: opts.signal,
				});
				if (!res.ok) {
					const errBody = await this.safeParseJson(res);
					// eslint-disable-next-line no-console
					console.error(`${logPrefix} error response:`, res.status, JSON.stringify(errBody));
					const message =
						(errBody as { error?: { message?: string } } | undefined)?.error?.message ??
						`HTTP ${res.status}`;
					const metadata = (errBody as { error?: { metadata?: Record<string, unknown> } } | undefined)?.error
						?.metadata;
					throw new OpenRouterError({
						code: res.status,
						message,
						body: errBody,
						metadata,
						retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")),
					});
				}
				return res;
			},
			{ budget, config, signal: opts.signal },
		);
	}

	/**
	 * Best-effort JSON parse. Returns `undefined` on parse failure rather than
	 * throwing — used by error paths where surfacing the raw status matters
	 * more than the body.
	 */
	async safeParseJson(response: Response): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			return undefined;
		}
	}
}
