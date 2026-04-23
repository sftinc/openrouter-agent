import type { SessionStore } from "./SessionStore.js";
import type { Message } from "../types/index.js";

export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Message[]>();

  async get(sessionId: string): Promise<Message[] | null> {
    const value = this.map.get(sessionId);
    return value ? [...value] : null;
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    this.map.set(sessionId, [...messages]);
  }

  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
  }
}
