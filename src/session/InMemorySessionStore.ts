/**
 * In-process implementation of {@link SessionStore} backed by a {@link Map}.
 *
 * Intended for tests, single-process servers, and development. State is
 * lost when the process exits — use a durable backend (filesystem, Redis,
 * SQL, etc.) for production deployments that need survivability.
 */
import type { SessionStore } from "./SessionStore.js";
import type { Message } from "../types/index.js";

/**
 * In-memory {@link SessionStore} backed by a single {@link Map} keyed by
 * `sessionId`. All methods are async to match the interface but resolve
 * synchronously on the next microtask.
 *
 * **Snapshot semantics:** both {@link InMemorySessionStore.get} and
 * {@link InMemorySessionStore.set} copy the message array (`[...value]`),
 * so the caller cannot mutate stored state by holding onto a reference,
 * and subsequent mutations on the agent side do not retroactively change
 * persisted history. Individual {@link Message} objects are not deep-cloned.
 *
 * **System messages:** like all {@link SessionStore} implementations, this
 * class never receives `system` messages from the agent loop — they are
 * stripped before persistence. No special handling is required here.
 *
 * **Concurrency:** safe across distinct session IDs. Per-session
 * serialization is the {@link Agent}'s responsibility (it throws
 * {@link SessionBusyError} for overlapping runs on the same `sessionId`).
 *
 * @example
 * ```ts
 * const store = new InMemorySessionStore();
 * const agent = new Agent({ sessionStore: store, ... });
 * ```
 */
export class InMemorySessionStore implements SessionStore {
  /**
   * Internal map of `sessionId` -> persisted message array. Marked
   * `private readonly` so the field reference itself is immutable, even
   * though the {@link Map} contents are mutated by
   * {@link InMemorySessionStore.set} and
   * {@link InMemorySessionStore.delete}.
   */
  private readonly map = new Map<string, Message[]>();

  /**
   * Load the persisted messages for a session.
   *
   * Returns a shallow copy of the stored array so that callers cannot
   * mutate the in-memory state by mutating the returned value.
   *
   * @param sessionId - Identifier of the session to load.
   * @returns A fresh array of {@link Message} objects, or `null` if no
   *   session has been persisted under `sessionId`.
   */
  async get(sessionId: string): Promise<Message[] | null> {
    const value = this.map.get(sessionId);
    return value ? [...value] : null;
  }

  /**
   * Replace the stored messages for a session.
   *
   * Stores a shallow copy of `messages` so that subsequent mutations by
   * the caller do not retroactively change persisted state. Creates a new
   * map entry if `sessionId` has not been seen before, otherwise overwrites
   * the prior value.
   *
   * @param sessionId - Identifier under which to store the messages.
   * @param messages - Full conversation history to persist. The agent
   *   loop has already removed any `system` messages before invoking this
   *   method.
   * @returns A promise that resolves once the value has been written.
   */
  async set(sessionId: string, messages: Message[]): Promise<void> {
    this.map.set(sessionId, [...messages]);
  }

  /**
   * Remove a session entirely.
   *
   * Idempotent — deleting an unknown `sessionId` resolves without error
   * and has no side effect.
   *
   * @param sessionId - Identifier of the session to remove.
   * @returns A promise that resolves once the entry (if any) has been
   *   removed from the underlying map.
   */
  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
  }
}
