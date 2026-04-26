/**
 * @file Stream-level error classes raised from the SSE consumer.
 *
 * `StreamTruncatedError` and `IdleTimeoutError` are part of the retry surface
 * (see `src/openrouter/retry.ts`). Both abort the underlying `fetch` before
 * being thrown so the socket is freed.
 */

/**
 * Thrown by the SSE consumer when the upstream response body ends without the
 * `[DONE]` sentinel. Within the agent loop's pre-first-content-delta window
 * this error is retryable; past that window it surfaces as
 * `stopReason: "error"` and the session is not persisted.
 *
 * @example
 * ```ts
 * import { StreamTruncatedError } from "./openrouter";
 *
 * try {
 *   for await (const chunk of client.completeStream({ messages })) { ... }
 * } catch (err) {
 *   if (err instanceof StreamTruncatedError) {
 *     console.warn(`upstream truncated after ${err.partialContentLength} chars`);
 *   }
 * }
 * ```
 */
export class StreamTruncatedError extends Error {
	/** Discriminator (`Error.name`). */
	readonly name = "StreamTruncatedError" as const;
	/** OpenRouter generation id observed before truncation, if one was assigned. */
	readonly generationId?: string;
	/** Total `delta.content` length accumulated before the stream was cut. */
	readonly partialContentLength: number;

	/**
	 * @param params Constructor params.
	 * @param params.message Human-readable message (becomes `Error.message`).
	 * @param params.generationId Optional OpenRouter generation id observed before truncation.
	 * @param params.partialContentLength Total `delta.content` characters emitted before the cut.
	 */
	constructor(params: { message: string; generationId?: string; partialContentLength: number }) {
		super(params.message);
		this.generationId = params.generationId;
		this.partialContentLength = params.partialContentLength;
	}
}

/**
 * Thrown by the SSE consumer when no chunk arrives within the configured
 * `idleTimeoutMs` window. Within the agent loop's pre-first-content-delta
 * window this error is retryable.
 *
 * @example
 * ```ts
 * import { IdleTimeoutError } from "./openrouter";
 *
 * try {
 *   for await (const chunk of client.completeStream({ messages })) { ... }
 * } catch (err) {
 *   if (err instanceof IdleTimeoutError) {
 *     console.warn(`upstream wedged: no chunk in ${err.idleMs}ms`);
 *   }
 * }
 * ```
 */
export class IdleTimeoutError extends Error {
	/** Discriminator (`Error.name`). */
	readonly name = "IdleTimeoutError" as const;
	/** Configured idle window that elapsed without a chunk, in ms. */
	readonly idleMs: number;

	/**
	 * @param params Constructor params.
	 * @param params.message Human-readable message (becomes `Error.message`).
	 * @param params.idleMs The idle window that elapsed without a chunk.
	 */
	constructor(params: { message: string; idleMs: number }) {
		super(params.message);
		this.idleMs = params.idleMs;
	}
}
