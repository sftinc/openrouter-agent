/**
 * @file Retry helpers for the OpenRouter transport layer.
 *
 * This file will grow to include the full retry helper (`withRetry`,
 * `RetryBudget`), the `RetryConfig` shape, and the `defaultIsRetryable`
 * predicate. For Task 2, only `parseRetryAfter` lands.
 */

import { OpenRouterError } from './client.js'
import { StreamTruncatedError, IdleTimeoutError } from './errors.js'

/**
 * Parse the value of an HTTP `Retry-After` response header into milliseconds.
 *
 * Accepts both forms permitted by RFC 7231 §7.1.3:
 *   - delta-seconds (e.g. `"3"`, `"60"`)
 *   - HTTP-date (e.g. `"Sun, 26 Apr 2026 12:00:05 GMT"`)
 *
 * Past dates yield `0`; unparseable values yield `undefined` so the caller
 * can fall back to its own backoff calculation.
 *
 * @param value Raw header value, or `null`/`undefined` if the header was absent.
 * @returns Milliseconds to wait, or `undefined` if the value cannot be parsed.
 *
 * @example
 * ```ts
 * import { parseRetryAfter } from './openrouter'
 *
 * const ms = parseRetryAfter(response.headers.get('Retry-After'))
 * if (ms != null) console.log(`provider asked us to wait ${ms}ms`)
 * ```
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
	if (value == null) return undefined
	const trimmed = value.trim()
	if (trimmed.length === 0) return undefined
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
	const ts = Date.parse(trimmed)
	if (Number.isNaN(ts)) return undefined
	return Math.max(0, ts - Date.now())
}

/**
 * Status codes considered retryable by the default predicate. Mutable
 * `Set` lookup is faster than an `includes` array scan; not exported
 * because callers should override via `RetryConfig.isRetryable` rather
 * than mutate a shared set.
 */
const RETRYABLE_STATUS = new Set<number>([408, 429, 500, 502, 503, 504])

/**
 * Default predicate determining whether the retry helper should retry a
 * given error. Exported so callers can extend it (e.g.
 * `isRetryable: (e) => defaultIsRetryable(e) || e instanceof MyTransient`).
 *
 * Returns `true` for:
 *   - {@link OpenRouterError} whose `code` is `408`, `429`, `500`, `502`,
 *     `503`, or `504`.
 *   - Any `Error` with no `code` and `name !== "AbortError"` (treated as
 *     network-level: ECONNRESET, ECONNREFUSED, ETIMEDOUT, DNS, TLS).
 *   - {@link StreamTruncatedError}.
 *   - {@link IdleTimeoutError}.
 *
 * Returns `false` for everything else, including `AbortError`,
 * non-retryable HTTP codes (4xx other than `408`/`429`), and non-Error
 * values.
 *
 * @param err The thrown value (could be anything — predicate handles all
 *   types defensively).
 * @returns `true` if the retry helper should retry; `false` to surface
 *   the error immediately.
 *
 * @example
 * ```ts
 * import { defaultIsRetryable } from './openrouter'
 *
 * const isRetryable = (e: unknown) =>
 *   defaultIsRetryable(e) || (e instanceof Error && e.message === 'transient')
 * ```
 */
export function defaultIsRetryable(err: unknown): boolean {
	if (!(err instanceof Error)) return false
	if (err.name === 'AbortError') return false
	if (err instanceof StreamTruncatedError) return true
	if (err instanceof IdleTimeoutError) return true
	if (err instanceof OpenRouterError) return RETRYABLE_STATUS.has(err.code)
	return true
}

/**
 * Configuration for the retry helper. Surfaced on
 * {@link OpenRouterClientOptions.retry}, {@link AgentConfig.retry}, and
 * {@link AgentRunOptions.retry} (per-run shallow override).
 *
 * Unspecified fields fall through to per-Agent, then global defaults.
 *
 * @example
 * ```ts
 * import { defaultIsRetryable, type RetryConfig } from '@sftinc/openrouter-agent'
 *
 * const retry: RetryConfig = {
 *   maxAttempts: 5,
 *   initialDelayMs: 250,
 *   isRetryable: (e) => defaultIsRetryable(e),
 * }
 * ```
 */
export interface RetryConfig {
	/** Total attempts including the first. Default: `3`. Set to `1` to disable retries. */
	maxAttempts?: number
	/** Base for exponential-with-full-jitter backoff in ms. Default: `500`. */
	initialDelayMs?: number
	/**
	 * Cap on a single backoff delay. Also caps honored `Retry-After` so a
	 * malicious or buggy provider cannot pin the client. Default: `8000`.
	 */
	maxDelayMs?: number
	/**
	 * Idle-stream timeout in ms; the SSE consumer raises
	 * {@link IdleTimeoutError} after this gap. Default: `60000`.
	 */
	idleTimeoutMs?: number
	/**
	 * Override the retryable-error predicate. Default: {@link defaultIsRetryable}.
	 */
	isRetryable?: (err: unknown) => boolean
}

/**
 * Built-in defaults for {@link RetryConfig}. Exported for callers that want
 * to inspect what they will get if they pass `undefined`.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
	maxAttempts: 3,
	initialDelayMs: 500,
	maxDelayMs: 8000,
	idleTimeoutMs: 60_000,
	isRetryable: defaultIsRetryable,
}

/**
 * Resolve a {@link RetryConfig} (possibly undefined and possibly partial)
 * into a fully-populated config using {@link DEFAULT_RETRY_CONFIG} as the
 * fallback. Pure: returns a fresh object on every call.
 *
 * @param cfg Partial config (may be `undefined`).
 * @returns A fully-populated config, every field set.
 */
export function resolveRetryConfig(cfg: RetryConfig | undefined): Required<RetryConfig> {
	return {
		maxAttempts: cfg?.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts,
		initialDelayMs: cfg?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
		maxDelayMs: cfg?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
		idleTimeoutMs: cfg?.idleTimeoutMs ?? DEFAULT_RETRY_CONFIG.idleTimeoutMs,
		isRetryable: cfg?.isRetryable ?? DEFAULT_RETRY_CONFIG.isRetryable,
	}
}
