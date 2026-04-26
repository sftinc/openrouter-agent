/**
 * Session store abstraction for persisting conversation state across
 * separate {@link Agent} runs that share a `sessionId`.
 *
 * The contract intentionally targets the minimum surface required by the
 * agent loop: load the prior message list, replace it after a successful
 * turn, or delete it. Backends may be in-memory (see
 * {@link InMemorySessionStore}), filesystem, Redis, SQL, etc.
 */
import type { Message } from "../types/index.js";

/**
 * Pluggable persistence for conversation history. Implementations must be
 * safe for concurrent calls with *different* session IDs; per-session
 * serialization is handled by the `Agent` (which throws `SessionBusyError`
 * if the same session is already running).
 *
 * **Invariant:** system messages are never persisted. The agent loop strips
 * them from `messages` before calling `set`, and any `system` entries that
 * happen to be returned by {@link SessionStore.get} are defensively filtered
 * out on load. The system prompt is agent configuration, not conversation
 * state, so it lives on the {@link Agent} config and not in the store.
 *
 * **Concurrency contract:** implementations only need to be safe across
 * distinct `sessionId` values. The {@link Agent} guarantees that no two
 * runs for the same `sessionId` are in flight on the same instance — it
 * throws {@link SessionBusyError} instead. Implementations therefore do
 * not need internal per-session locking.
 *
 * **Failure semantics:** {@link SessionStore.set} is only invoked on
 * clean terminal stop reasons. Runs that error out or are aborted leave
 * the store untouched, preserving the prior turn so the caller can retry
 * the same user input safely.
 *
 * @example
 * ```ts
 * const store: SessionStore = new InMemorySessionStore();
 * const agent = new Agent({ sessionStore: store, ... });
 * await agent.run({ sessionId: "abc", input: "hello" });
 * ```
 */
export interface SessionStore {
  /**
   * Load persisted messages for a session.
   *
   * @param sessionId - Opaque identifier supplied by the caller of
   *   `Agent.run`.
   * @returns A promise resolving to the array of {@link Message} objects in
   *   conversation order, or `null` if no session has been persisted under
   *   `sessionId` yet. Implementations should return a defensive copy so
   *   that mutation by the caller cannot bleed back into stored state.
   */
  get(sessionId: string): Promise<Message[] | null>;
  /**
   * Replace the stored messages for a session. Called only on clean
   * terminal stop reasons (`done`, `max_turns`, `length`, `content_filter`);
   * runs ending in `error` or `aborted` leave the store untouched so the
   * caller can safely retry with the same user input.
   *
   * Implementations should snapshot `messages` (e.g. with a shallow copy)
   * so that subsequent mutations by the agent loop do not retroactively
   * change the persisted state.
   *
   * @param sessionId - Identifier under which to store the messages.
   * @param messages - Full conversation history to persist. The agent loop
   *   has already stripped any `system` messages before calling this method.
   * @returns A promise that resolves once the write has been durably
   *   applied (for whatever durability the backend offers).
   */
  set(sessionId: string, messages: Message[]): Promise<void>;
  /**
   * Remove a session entirely. Idempotent: deleting a non-existent
   * `sessionId` should resolve without error.
   *
   * @param sessionId - Identifier of the session to remove.
   * @returns A promise that resolves once the deletion has been applied.
   */
  delete(sessionId: string): Promise<void>;
}
