/**
 * In-process implementation of {@link SessionStore} backed by a {@link Map}.
 *
 * Intended for tests, single-process servers, and development. State is
 * lost when the process exits — use a durable backend (filesystem, Redis,
 * SQL, etc.) for production deployments that need survivability.
 */
import type { SessionStore } from "./SessionStore.js";
import type { SessionRecord } from "./SessionRecord.js";
import type { Message } from "../types/index.js";

/**
 * Construction options for {@link InMemorySessionStore}.
 *
 * Both fields are optional. When omitted the store uses a real wall clock
 * and never expires entries.
 */
export interface InMemorySessionStoreOptions {
  /**
   * Idle TTL in milliseconds. When set, a session whose `updatedAt` is at
   * least `ttlMs` ms behind `now()` is considered expired: the next `get`
   * for that `sessionId` lazily deletes the entry and returns `null`.
   *
   * - Omit (or pass `undefined`) to disable expiry.
   * - `0` evicts on the very next `get` even at the same instant
   *   (comparison is `>=`, not `>`).
   * - Negative values and `NaN` are rejected with a `RangeError` from the
   *   constructor.
   *
   * The TTL is **idle**, not absolute: every `set` refreshes `updatedAt`
   * and therefore extends the window.
   *
   * Eviction is purely lazy — no background sweeper, no timers. Stale
   * entries can sit in memory until `get` is called, until the entry is
   * overwritten by `set`, or until the process exits.
   */
  ttlMs?: number;
  /**
   * Clock injection for tests. Called once per `get` and once per `set`
   * to obtain the current time. Defaults to `() => new Date()`.
   *
   * @example
   * ```ts
   * let t = 0;
   * const fakeNow = () => new Date(t);
   * const store = new InMemorySessionStore({ now: fakeNow });
   * await store.set("s1", []);
   * t += 5_000;
   * const record = await store.get("s1"); // updatedAt 5s behind now
   * ```
   */
  now?: () => Date;
}

/**
 * In-memory {@link SessionStore} backed by a single {@link Map} keyed by
 * `sessionId`. All methods are async to match the interface but resolve
 * synchronously on the next microtask.
 *
 * **Snapshot semantics:** {@link InMemorySessionStore.get} returns a
 * record with a freshly-cloned `messages` array, and
 * {@link InMemorySessionStore.set} stores a freshly-cloned array, so the
 * caller cannot mutate stored state by holding onto a reference. Individual
 * {@link Message} objects are not deep-cloned.
 *
 * **Timestamps:** `createdAt` is captured on the first `set` for a
 * `sessionId` and preserved across subsequent writes. `updatedAt` is
 * refreshed on every `set`. Both are ISO-8601 UTC strings.
 *
 * **TTL:** if {@link InMemorySessionStoreOptions.ttlMs} is supplied, `get`
 * lazily evicts entries whose `updatedAt` is at least `ttlMs` ms behind
 * `now()`. `set` does **not** check the TTL — writing always succeeds and
 * refreshes `updatedAt`.
 *
 * **Concurrency:** safe across distinct session IDs. Per-session
 * serialization is the {@link Agent}'s responsibility (it throws
 * {@link SessionBusyError} for overlapping runs on the same `sessionId`).
 *
 * @example Basic usage (no TTL)
 * ```ts
 * import { InMemorySessionStore } from "./session";
 * const store = new InMemorySessionStore();
 * const agent = new Agent({ sessionStore: store, ... });
 * ```
 *
 * @example One-hour idle TTL
 * ```ts
 * const store = new InMemorySessionStore({ ttlMs: 60 * 60 * 1000 });
 * ```
 */
export class InMemorySessionStore implements SessionStore {
  /** Persisted records, keyed by `sessionId`. */
  private readonly map = new Map<string, SessionRecord>();
  /** Idle TTL in ms, or `undefined` for no expiry. */
  private readonly ttlMs: number | undefined;
  /** Clock used to stamp `createdAt`/`updatedAt` and to compare TTLs. */
  private readonly now: () => Date;

  /**
   * @param options - Optional clock and TTL configuration; see
   *   {@link InMemorySessionStoreOptions}.
   * @throws RangeError if `options.ttlMs` is negative or `NaN`.
   */
  constructor(options: InMemorySessionStoreOptions = {}) {
    if (options.ttlMs !== undefined) {
      if (Number.isNaN(options.ttlMs) || options.ttlMs < 0) {
        throw new RangeError(
          `InMemorySessionStore: ttlMs must be a non-negative number, got ${String(options.ttlMs)}`
        );
      }
    }
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Load the persisted record for a session, lazily evicting it if the
   * configured TTL has elapsed.
   *
   * @param sessionId - Identifier of the session to load.
   * @returns A {@link SessionRecord} with a freshly-cloned `messages`
   *   array, or `null` if no session has been persisted under `sessionId`
   *   (or it was just evicted by this call).
   */
  async get(sessionId: string): Promise<SessionRecord | null> {
    const entry = this.map.get(sessionId);
    if (!entry) return null;

    if (this.ttlMs !== undefined) {
      const ageMs = this.now().getTime() - Date.parse(entry.updatedAt);
      if (ageMs >= this.ttlMs) {
        this.map.delete(sessionId);
        return null;
      }
    }

    return {
      messages: [...entry.messages],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Replace the stored messages for a session, refreshing `updatedAt` and
   * preserving `createdAt` if the session already exists.
   *
   * `set` does not check the TTL: even an entry that *would* be evicted
   * by the next `get` is still treated as a live continuation by `set`,
   * preserving its existing `createdAt` and refreshing `updatedAt`.
   *
   * @param sessionId - Identifier under which to store the messages.
   * @param messages - Full conversation history to persist. The agent
   *   loop has already removed any `system` messages before invoking
   *   this method.
   */
  async set(sessionId: string, messages: Message[]): Promise<void> {
    const nowIso = this.now().toISOString();
    const existing = this.map.get(sessionId);
    this.map.set(sessionId, {
      messages: [...messages],
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
  }

  /**
   * Remove a session entirely. Idempotent — deleting an unknown
   * `sessionId` resolves without error.
   *
   * @param sessionId - Identifier of the session to remove.
   */
  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
  }
}
