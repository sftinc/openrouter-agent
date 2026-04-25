/**
 * Public surface of the `session/` module.
 *
 * Consumers should import from this folder rather than reaching into
 * individual files — e.g.
 * `import { InMemorySessionStore } from "./session"`. The module exports:
 *
 * - {@link SessionStore} — the persistence interface implemented by
 *   custom backends.
 * - {@link InMemorySessionStore} — a built-in implementation backed by a
 *   {@link Map}, suitable for tests and single-process servers.
 * - {@link SessionBusyError} — error thrown by {@link Agent} when an
 *   overlapping run is started for the same `sessionId`.
 *
 * Note: system messages are never persisted through this layer. The agent
 * loop strips them before calling {@link SessionStore.set}, and they are
 * also defensively filtered on load.
 */
export type { SessionStore } from "./SessionStore.js";
export { InMemorySessionStore } from "./InMemorySessionStore.js";
export { SessionBusyError } from "./SessionBusyError.js";
