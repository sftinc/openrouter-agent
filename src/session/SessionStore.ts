import type { Message } from "../types/index.js";

/**
 * Pluggable persistence for conversation history. Implementations must be
 * safe for concurrent calls with *different* session IDs; per-session
 * serialization is handled by the `Agent` (which throws `SessionBusyError`
 * if the same session is already running).
 *
 * **Invariant:** system messages are never persisted. The agent loop strips
 * them from `messages` before calling `set`. System prompts are agent
 * configuration, not conversation state.
 */
export interface SessionStore {
  /** Load persisted messages, or null if the session does not exist. */
  get(sessionId: string): Promise<Message[] | null>;
  /**
   * Replace the stored messages for a session. Called only on clean
   * terminal stop reasons (`done`, `max_turns`, `length`, `content_filter`);
   * runs ending in `error` or `aborted` leave the store untouched so the
   * caller can safely retry with the same user input.
   */
  set(sessionId: string, messages: Message[]): Promise<void>;
  /** Remove a session entirely. */
  delete(sessionId: string): Promise<void>;
}
