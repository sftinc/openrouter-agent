import type { Message } from "../types/index.js";

/**
 * Pluggable persistence for conversation history.
 */
export interface SessionStore {
  get(sessionId: string): Promise<Message[] | null>;
  set(sessionId: string, messages: Message[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
