/**
 * Error type raised by {@link Agent} when a second run is started for a
 * `sessionId` that already has a run in flight on the same agent instance.
 *
 * This module exists as a single-export file so that callers can `import
 * { SessionBusyError }` from the `session` folder without pulling in the
 * full store implementation.
 */

/**
 * Thrown when a run is started for a sessionId that already has a run in
 * flight on the same Agent instance. Servers should surface this as a busy
 * response (e.g. HTTP 409) so the client can wait and retry.
 *
 * The error carries a stable {@link SessionBusyError.code} of
 * `"SESSION_BUSY"` so callers can branch on it without relying on
 * `instanceof` across module boundaries (useful when the class is loaded
 * twice in mixed CJS/ESM environments).
 *
 * @example
 * ```ts
 * try {
 *   await agent.run({ sessionId, input });
 * } catch (err) {
 *   if (err instanceof SessionBusyError) {
 *     return reply.code(409).send({ error: err.code, sessionId: err.sessionId });
 *   }
 *   throw err;
 * }
 * ```
 */
export class SessionBusyError extends Error {
  /**
   * Stable, machine-readable error code. Always the literal string
   * `"SESSION_BUSY"`. Useful for cross-realm checks where `instanceof`
   * would fail (e.g. duplicated module copies).
   */
  readonly code = "SESSION_BUSY";
  /**
   * Construct a new {@link SessionBusyError}.
   *
   * The constructor sets {@link Error.message} to
   * `` `session "${sessionId}" already has an active run` `` and assigns
   * {@link Error.name} to `"SessionBusyError"` so stack traces and
   * structured loggers identify the subclass correctly.
   *
   * @param sessionId - The identifier of the session that is already
   *   running. Exposed publicly as a readonly property so handlers can
   *   include it in user-facing error responses.
   */
  constructor(public readonly sessionId: string) {
    super(`session "${sessionId}" already has an active run`);
    this.name = "SessionBusyError";
  }
}
