/**
 * Thrown when a run is started for a sessionId that already has a run in
 * flight on the same Agent instance. Servers should surface this as a busy
 * response (e.g. HTTP 409) so the client can wait and retry.
 */
export class SessionBusyError extends Error {
  readonly code = "SESSION_BUSY";
  constructor(public readonly sessionId: string) {
    super(`session "${sessionId}" already has an active run`);
    this.name = "SessionBusyError";
  }
}
