import type { Message } from "../types/index.js";

/**
 * Persisted session shape returned from {@link SessionStore.get}.
 *
 * Wraps the conversation `messages` array with two ISO-8601 timestamps so
 * backends can drive TTL eviction, audit trails, or "recently active"
 * surfaces without inventing their own metadata layer. Timestamps are
 * always set by the store implementation, never by the agent loop.
 *
 * **No system messages.** As with the rest of the session layer, the agent
 * loop strips `system` from `messages` before persistence, and the loop
 * defensively re-strips them on load. {@link SessionRecord.messages} should
 * never contain a `system`-role message.
 *
 * @property messages - Full conversation history for this session, in
 *   wire order. Excludes `system` messages (those live on the {@link Agent}
 *   config, not on the session).
 * @property createdAt - ISO-8601 UTC string captured on the **first** write
 *   for this `sessionId`. Immutable across subsequent writes.
 * @property updatedAt - ISO-8601 UTC string captured on the **most recent**
 *   write. Refreshed by every successful `set`. Used by
 *   {@link InMemorySessionStore} (and other TTL-aware backends) to decide
 *   whether an entry is stale.
 *
 * @example
 * ```ts
 * import type { SessionRecord } from "./session";
 *
 * const record: SessionRecord = {
 *   messages: [{ role: "user", content: "hi" }],
 *   createdAt: "2026-04-26T18:23:11.044Z",
 *   updatedAt: "2026-04-26T18:23:11.044Z",
 * };
 * ```
 */
export interface SessionRecord {
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}
