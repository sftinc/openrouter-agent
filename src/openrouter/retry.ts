/**
 * @file Retry helpers for the OpenRouter transport layer.
 *
 * This file will grow to include the full retry helper (`withRetry`,
 * `RetryBudget`), the `RetryConfig` shape, and the `defaultIsRetryable`
 * predicate. For Task 2, only `parseRetryAfter` lands.
 */

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
