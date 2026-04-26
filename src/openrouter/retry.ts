/**
 * @file Retry helpers for the OpenRouter transport layer.
 *
 * Exports: `parseRetryAfter` (Retry-After header parser), `defaultIsRetryable`
 * (error predicate), `RetryConfig` type, `DEFAULT_RETRY_CONFIG`, and
 * `resolveRetryConfig` (config resolver). Also exports `abortableSleep`,
 * `RetryBudget`, `createRetryBudget`, `withRetry`, and `computeBackoffDelay`
 * for cooperative full-jitter exponential backoff with per-turn budget sharing.
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
 * **Caveat:** the "any other `Error`" branch also matches bug-class errors
 * (`TypeError`, `SyntaxError` from a malformed SSE frame, etc.) — these
 * will be retried up to `maxAttempts` times before surfacing. The intent
 * is to cover unknown platform-level network failures; if you need
 * tighter control, override via {@link RetryConfig.isRetryable}.
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
	if (err instanceof RetryableProviderError) return true
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

/**
 * Resolves after `delayMs` milliseconds, or rejects with an `AbortError` if
 * `signal` fires first. Used by {@link withRetry} for cooperative backoff.
 *
 * @param delayMs Milliseconds to wait. May be `0`.
 * @param signal Optional cancellation signal.
 * @returns A promise that resolves with `void` on timer or rejects with an
 *   `AbortError` (`Error` with `name === "AbortError"`) on signal.
 *
 * @example
 * ```ts
 * import { abortableSleep } from './openrouter'
 *
 * const ctrl = new AbortController()
 * await abortableSleep(1000, ctrl.signal)
 * ```
 */
export function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(makeAbortError())
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, delayMs)
		const onAbort = () => {
			clearTimeout(timer)
			reject(makeAbortError())
		}
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

/**
 * Construct an Error with `name === "AbortError"`. Used by
 * {@link abortableSleep} when the signal fires.
 */
function makeAbortError(): Error {
	const err = new Error('Aborted')
	err.name = 'AbortError'
	return err
}

/**
 * Mutable per-turn retry budget. The agent loop allocates one of these per
 * turn and shares it with the OpenRouter client so the two retry layers do
 * not compound. Decrementing happens immediately before scheduling a retry.
 */
export interface RetryBudget {
	/** Attempts remaining (excluding the in-flight one). Decremented as retries fire. */
	remaining: number
	/** Total attempts allowed for this turn. Set once at creation. */
	readonly total: number
}

/**
 * Build a fresh {@link RetryBudget} from a resolved config. `remaining`
 * starts at `maxAttempts - 1` because the first attempt is "free" — the
 * budget governs the *retries*, not the total attempts.
 *
 * @param cfg Resolved retry config (use {@link resolveRetryConfig} first).
 * @returns A new budget. Mutate the returned object directly.
 *
 * @example
 * ```ts
 * import { createRetryBudget, resolveRetryConfig } from './openrouter'
 *
 * const cfg = resolveRetryConfig(undefined)
 * const budget = createRetryBudget(cfg)
 * ```
 */
export function createRetryBudget(cfg: Required<RetryConfig>): RetryBudget {
	return { remaining: Math.max(0, cfg.maxAttempts - 1), total: cfg.maxAttempts }
}

/**
 * Information passed to the optional `onRetry` callback.
 */
export interface RetryAttemptInfo {
	/** One-based; the attempt that just failed. The next attempt will be `attempt + 1`. */
	attempt: number
	/** Computed backoff delay until the next attempt, in ms. */
	delayMs: number
	/** The retryable error that just fired. */
	error: unknown
}

/**
 * Options accepted by {@link withRetry}.
 */
export interface WithRetryOptions {
	/** Mutable budget shared across retry layers. Decremented per retry. */
	budget: RetryBudget
	/** Resolved config used for backoff math and the `isRetryable` predicate. */
	config: Required<RetryConfig>
	/** Optional cancellation signal. Aborts during backoff sleep give up immediately. */
	signal?: AbortSignal
	/** Optional callback invoked once per failed retryable attempt, before the backoff sleep. */
	onRetry?: (info: RetryAttemptInfo) => void
	/** Override the random source for backoff jitter (deterministic tests). */
	random?: () => number
	/** Override the sleep implementation (deterministic tests). */
	sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Compute the next backoff delay for a given attempt number.
 *
 * Full-jitter exponential: `delayMs = random(0, min(maxDelayMs, initialDelayMs * 2^(attempt-1)))`.
 * Floored by `retryAfterMs` (if any) and re-capped at `maxDelayMs`.
 *
 * @param attempt One-based attempt that just failed.
 * @param config Resolved retry config.
 * @param retryAfterMs Optional floor from a `Retry-After` header.
 * @param random RNG, defaults to `Math.random`.
 * @returns Delay in ms, in `[0, maxDelayMs]`.
 *
 * @example
 * ```ts
 * import { computeBackoffDelay, resolveRetryConfig } from './openrouter'
 *
 * const cfg = resolveRetryConfig(undefined)
 * const delay = computeBackoffDelay(1, cfg, undefined)
 * ```
 */
export function computeBackoffDelay(
	attempt: number,
	config: Required<RetryConfig>,
	retryAfterMs: number | undefined,
	random: () => number = Math.random,
): number {
	const exp = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** Math.max(0, attempt - 1))
	let delay = Math.floor(random() * exp)
	if (retryAfterMs != null) delay = Math.max(delay, retryAfterMs)
	return Math.min(delay, config.maxDelayMs)
}

/**
 * Run `fn` and retry on retryable errors until it succeeds, the budget is
 * exhausted, the error is non-retryable, or `signal` fires.
 *
 * @template T Return type of `fn`.
 * @param fn The async function to attempt. Receives the one-based attempt
 *   number; useful for logging.
 * @param options See {@link WithRetryOptions}.
 * @returns The successful result of `fn`.
 * @throws Whatever `fn` threw on the final attempt (non-retryable error,
 *   budget-exhaustion error, or `AbortError`).
 *
 * @example
 * ```ts
 * import { withRetry, createRetryBudget, resolveRetryConfig } from './openrouter'
 *
 * const config = resolveRetryConfig(undefined)
 * const budget = createRetryBudget(config)
 * const data = await withRetry(() => fetchSomething(), {
 *   budget,
 *   config,
 *   onRetry: (info) => console.warn('retry', info.attempt, info.delayMs),
 * })
 * ```
 */
export async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	options: WithRetryOptions,
): Promise<T> {
	const { budget, config, signal, onRetry } = options
	const random = options.random ?? Math.random
	const sleep = options.sleep ?? abortableSleep
	let attempt = 0
	while (true) {
		attempt++
		try {
			return await fn(attempt)
		} catch (err) {
			if (signal?.aborted) throw err
			if (!config.isRetryable(err)) throw err
			if (budget.remaining <= 0) throw err
			const retryAfterMs =
				err instanceof OpenRouterError ? err.retryAfterMs : undefined
			const delayMs = computeBackoffDelay(attempt, config, retryAfterMs, random)
			onRetry?.({ attempt, delayMs, error: err })
			budget.remaining--
			await sleep(delayMs, signal)
		}
	}
}

/**
 * Synthetic error class the agent loop throws to mark a mid-stream provider
 * error (`chunk.error` or `finish_reason: "error"`) as retryable. Only the
 * loop emits this; outside callers should treat it the same as any
 * provider-side error.
 */
export class RetryableProviderError extends Error {
	/** Discriminator (`Error.name`). */
	readonly name = 'RetryableProviderError' as const
	/** Provider-supplied error code (typically HTTP-style). */
	readonly code?: number
	/** Provider metadata, when available. */
	readonly metadata?: Record<string, unknown>

	/**
	 * @param params Constructor params.
	 * @param params.message Human-readable message.
	 * @param params.code Optional provider error code.
	 * @param params.metadata Optional provider metadata.
	 */
	constructor(params: { message: string; code?: number; metadata?: Record<string, unknown> }) {
		super(params.message)
		this.code = params.code
		this.metadata = params.metadata
	}
}
