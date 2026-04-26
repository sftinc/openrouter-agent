# Session Layer (`src/session/`)

The session layer provides pluggable conversation persistence so that successive `Agent.run` calls that share a `sessionId` can resume against the prior message history. The contract is intentionally narrow: a `SessionStore` only needs `get`, `set`, and `delete`. The `system` role is **never** persisted — it is treated as agent configuration, not conversation state, and is stripped both by the loop before calling `set` and defensively on load. Writes are **transactional**: `set` is invoked only on clean terminal stop reasons (`done`, `max_turns`, `length`, `content_filter`); runs that error or are aborted leave the store untouched, so callers can safely retry the same user message. Per-session single-flight is enforced by the `Agent` (not the store) — overlapping runs for the same `sessionId` raise a `SessionBusyError`.

Every persisted session also carries `createdAt` and `updatedAt` timestamps (ISO 8601 UTC strings) on the [`SessionRecord`](#sessionrecord-type) returned from `get`. Backends are responsible for stamping these — `createdAt` on the first write, `updatedAt` on every write. The bundled `InMemorySessionStore` uses them to drive optional [idle-TTL eviction](#inmemorysessionstoreoptions).

## Imports

```ts
import {
  InMemorySessionStore,
  SessionBusyError,
  type InMemorySessionStoreOptions,
  type SessionRecord,
  type SessionStore,
} from "@sftinc/openrouter-agent";
```

`SessionStore`, `SessionRecord`, and `InMemorySessionStoreOptions` are type-only; `InMemorySessionStore` and `SessionBusyError` are value exports. All five are re-exported from the package entrypoint at `src/index.ts` and originate from the folder index `src/session/index.ts`.

## `SessionRecord` type

Defined at `src/session/SessionRecord.ts`.

`SessionRecord` is the shape returned from `SessionStore.get`. It wraps the conversation messages with two ISO 8601 UTC timestamps so backends can drive TTL eviction, audit trails, or "recently active" surfaces without inventing their own metadata layer. Timestamps are always set by the store implementation, never by the agent loop.

| Property    | Type        | Description                                                                                                                                                                  |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`  | `Message[]` | Full conversation history for this session, in wire order. Excludes `system` messages (those live on the `Agent` config, not on the session).                                |
| `createdAt` | `string`    | ISO 8601 UTC string captured on the **first** write for this `sessionId`. Immutable across subsequent writes.                                                                |
| `updatedAt` | `string`    | ISO 8601 UTC string captured on the **most recent** write. Refreshed by every successful `set`. Used by `InMemorySessionStore` (and other TTL-aware backends) to decide whether an entry is stale. |

```ts
import type { SessionRecord } from "@sftinc/openrouter-agent";

const record: SessionRecord = {
  messages: [{ role: "user", content: "hi" }],
  createdAt: "2026-04-26T18:23:11.044Z",
  updatedAt: "2026-04-26T18:23:11.044Z",
};
```

## `SessionStore` interface

Defined at `src/session/SessionStore.ts`.

`SessionStore` is the persistence contract used by `Agent`. Implementations may be in-memory, on-disk, Redis, SQL, or anything else with async semantics. The full interface is three async methods.

| Method   | Signature                                                          | Called by `Agent`                                |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `get`    | `(sessionId: string) => Promise<SessionRecord \| null>`            | At the start of each run (`src/agent/loop.ts`)   |
| `set`    | `(sessionId: string, messages: Message[]) => Promise<void>`        | After a clean terminal stop reason               |
| `delete` | `(sessionId: string) => Promise<void>`                             | Never called by the loop — exposed for callers   |

### Timestamp contract

Implementations are responsible for managing the timestamps on every record:

- **Set `createdAt` on the first `set` for a `sessionId`** and preserve it across subsequent writes.
- **Refresh `updatedAt` on every successful `set`.**
- **Return both fields on every `get` that does not return `null`.**

The agent loop never supplies timestamps — they are entirely a store concern. Backends that don't natively store timestamp columns can use the wall clock at `set` time (see the Postgres sketch below for an example using `now()` in SQL).

### `get(sessionId): Promise<SessionRecord | null>`

Source: `src/session/SessionStore.ts`.

Load the persisted session record.

**Parameters**

| Name        | Type     | Required | Description                                                                                       |
| ----------- | -------- | -------- | ------------------------------------------------------------------------------------------------- |
| `sessionId` | `string` | yes      | Opaque identifier supplied by the caller of `Agent.run` via `options.sessionId`. |

**Returns** — `Promise<SessionRecord | null>`. Return `null` (not a record with an empty `messages` array) when no session has ever been persisted under `sessionId`. Implementations should return a defensive copy of the `messages` array so caller mutation cannot bleed into stored state.

For TTL-aware backends, `get` may return `null` *and* delete the underlying entry when the record's `updatedAt` indicates expiry — eviction is lazy and tied to read traffic.

**Semantics**

- The agent loop unwraps `record.messages` and passes that into `resolveInitialMessages`. It also defensively filters any `system`-role messages out of whatever the store returned. Stores that — through legacy data or a buggy backend — return system messages will not corrupt the run, but the recommended invariant is that they were never stored in the first place.
- Called exactly once per run, before any LLM call.

### `set(sessionId, messages): Promise<void>`

Source: `src/session/SessionStore.ts`.

Replace the persisted message history for a session with the run's final tail. The store is responsible for stamping `updatedAt` (and `createdAt` on first write) per the [timestamp contract](#timestamp-contract).

**Parameters**

| Name        | Type        | Required | Description                                                                                                          |
| ----------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | `string`    | yes      | Identifier under which to store the messages.                                                                        |
| `messages`  | `Message[]` | yes      | Full conversation history to persist. The agent loop has already stripped any `system` messages before calling this. |

**Returns** — `Promise<void>` resolved once the write is durable (for whatever durability the backend offers).

**Semantics**

- Invoked **only** on clean terminal stop reasons: `done`, `max_turns`, `length`, `content_filter`. Runs ending in `error` or `aborted` skip `set` entirely so callers can retry safely.
- Implementations should snapshot `messages` (e.g. with a shallow copy) so subsequent loop mutations do not retroactively change persisted state.
- The supplied `messages` will not contain a `system` entry; persisting one anyway is harmless because of the load-side filter, but wasteful.

### `delete(sessionId): Promise<void>`

Source: `src/session/SessionStore.ts`.

Remove a session entirely.

**Parameters**

| Name        | Type     | Required | Description                          |
| ----------- | -------- | -------- | ------------------------------------ |
| `sessionId` | `string` | yes      | Identifier of the session to remove. |

**Returns** — `Promise<void>`.

**Semantics**

- **Idempotent.** Deleting a non-existent `sessionId` must resolve without error.
- Never called by the run loop. Use it from your own code (e.g. a "clear chat" endpoint).

### Concurrency expectations

From `src/session/SessionStore.ts`:

- Implementations only need to be safe across **distinct** `sessionId` values.
- Per-session serialization is the `Agent`'s responsibility — it tracks in-flight ids in a `Set<string>` (`activeSessions`, see `src/agent/Agent.ts`) and throws `SessionBusyError` synchronously from `Agent.run` (before the `AgentRun` handle is returned) when the same id is already running on the same instance.
- Stores therefore do **not** need internal per-session locking.

### System-message exclusion

The system role is configured on the `Agent` (or supplied per-run via `options.system`), not stored in the conversation. Two layers enforce this:

1. **On persist** — `resolveInitialMessages` builds the loop's working `messages` array without any `system` entry; the loop's `set` call therefore passes a system-free array.
2. **On load (defensive)** — `resolveInitialMessages` also strips `system` messages from whatever the store returns, so a misbehaving or legacy backend cannot inject a stray system prompt at run start.

## `InMemorySessionStoreOptions`

Defined at `src/session/InMemorySessionStore.ts`. Construction options for `InMemorySessionStore`. Both fields are optional — passing nothing yields a real-clock store with no expiry.

| Field   | Type            | Default            | Description                                                                                                                                                                  |
| ------- | --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttlMs` | `number`        | `undefined`        | Idle TTL in milliseconds. When set, a session whose `updatedAt` is at least `ttlMs` ms behind `now()` is considered expired and is lazily deleted on the next `get`. Omit (or pass `undefined`) to disable expiry. |
| `now`   | `() => Date`    | `() => new Date()` | Clock injection for tests. Called once per `get` and once per `set`.                                                                                                          |

`ttlMs` semantics:

- The TTL is **idle**, not absolute: every `set` refreshes `updatedAt` and therefore extends the window. An actively-used session never times out.
- The TTL is **store-wide**, not per-session: every session in the same `InMemorySessionStore` instance shares the same `ttlMs`. Different cohorts with different TTLs require separate store instances (or a custom backend).
- Eviction is **lazy** — checked only on `get`. There is no background sweeper. Stale entries can sit in memory until `get` is called, until the entry is overwritten by `set`, or until the process exits.
- The boundary comparison is `>=`, so `ttlMs: 0` reliably evicts on the very next `get` even at the same instant.
- Negative values and `NaN` are rejected from the constructor with a `RangeError`. `Infinity` is accepted but is functionally equivalent to disabling the TTL.

```ts
new InMemorySessionStore();                           // no expiry (default)
new InMemorySessionStore({ ttlMs: 60 * 60 * 1000 }); // 1h idle TTL

// Deterministic clock for tests
let t = 0;
const fakeNow = () => new Date(t);
const store = new InMemorySessionStore({ ttlMs: 1_000, now: fakeNow });
await store.set("s1", []);
t += 5_000;
await store.get("s1"); // null — entry was 5s idle, TTL was 1s
```

## `InMemorySessionStore` class

Defined at `src/session/InMemorySessionStore.ts`. The bundled `SessionStore` implementation, intended for tests, single-process servers, and local development. State is lost on process exit.

### Constructor

```ts
new InMemorySessionStore(options?: InMemorySessionStoreOptions)
```

Construction options are documented in [`InMemorySessionStoreOptions`](#inmemorysessionstoreoptions). Throws `RangeError` if `options.ttlMs` is negative or `NaN`.

### Storage shape

| Field    | Visibility          | Type                          | Description                                                                                                                |
| -------- | ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `map`    | `private readonly`  | `Map<string, SessionRecord>`  | Internal map of `sessionId` → `SessionRecord`. The reference is immutable; the map's contents are mutated by `set`, `get` (on TTL-driven eviction), and `delete`. |
| `ttlMs`  | `private readonly`  | `number \| undefined`         | Idle TTL in ms, or `undefined` to disable expiry. Captured at construction.                                                |
| `now`    | `private readonly`  | `() => Date`                  | Clock used to stamp timestamps and compare TTLs. Defaults to `() => new Date()`; overridable for tests.                   |

### Public methods

#### `get(sessionId)`

Source: `src/session/InMemorySessionStore.ts`.

```ts
async get(sessionId: string): Promise<SessionRecord | null>
```

Returns a `SessionRecord` whose `messages` array is a **shallow copy** (`[...value]`) of the stored array, or `null` if `sessionId` is unknown. Individual `Message` objects are not deep-cloned, so callers should treat them as read-only.

If `ttlMs` is configured, `get` first checks `now().getTime() - Date.parse(entry.updatedAt) >= ttlMs`. When that holds the entry is deleted from the map and `null` is returned. Eviction is lazy — entries that have aged past the TTL but have not been read yet remain in the map.

#### `set(sessionId, messages)`

Source: `src/session/InMemorySessionStore.ts`.

```ts
async set(sessionId: string, messages: Message[]): Promise<void>
```

Stores a **shallow copy** of `messages` along with a freshly-stamped `updatedAt`. If a record already exists under `sessionId`, its `createdAt` is preserved; otherwise both timestamps are set to the current `now()`.

`set` does **not** check the TTL. An entry that is past its TTL but has not yet been evicted by a `get` is treated as a live continuation: its `createdAt` is preserved and `updatedAt` is refreshed (extending the idle window). Resolves on the next microtask.

#### `delete(sessionId)`

Source: `src/session/InMemorySessionStore.ts`.

```ts
async delete(sessionId: string): Promise<void>
```

Removes the entry if present. Idempotent — unknown ids resolve cleanly.

### Snapshot semantics

Both `get` and `set` use `[...value]` to copy the messages array. Consequence:

- A caller cannot mutate stored state by mutating the array `get` returned.
- Subsequent loop-side mutations to the array passed into `set` do not retroactively change persisted state.
- `Message` objects themselves are shared by reference. Treat them as immutable.

### Concurrency notes

`InMemorySessionStore` itself has **no** locking — `Map` operations are synchronous, and the methods only do a single read or write. Per-session single-flight is **not** enforced by this class; it is enforced by `Agent` via the `activeSessions: Set<string>` instance field plus the `acquireSession` helper:

```ts
private acquireSession(sessionId: string | undefined): () => void {
  if (!sessionId) return () => {};
  if (this.activeSessions.has(sessionId)) {
    throw new SessionBusyError(sessionId);
  }
  this.activeSessions.add(sessionId);
  return () => { this.activeSessions.delete(sessionId); };
}
```

The released callback is invoked from a `finally` block wrapped around `runLoop`, so the session id is always cleared even on thrown errors or abort. This busy-flag mechanism is per-`Agent`-instance only; sharing a `sessionId` across two distinct `Agent` instances will not raise `SessionBusyError`.

## `SessionBusyError`

Defined at `src/session/SessionBusyError.ts`. Thrown by `Agent` when a second run is started for a `sessionId` that already has a run in flight on the same `Agent` instance.

### When it is thrown

- From `Agent.run(input, options)` — **synchronously**, before the `AgentRun` handle is returned and before any work is queued (via `acquireSession`). This is true regardless of whether the caller intends to `await` the run for a `Result` or `for await` it for events. Wrap the `agent.run(...)` call site in `try/catch`, not the `await`.

### Properties

| Property    | Type                 | Description                                                                                                                |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `code`      | `"SESSION_BUSY"`     | Stable, machine-readable code. Always the literal string `"SESSION_BUSY"`. Use this for cross-realm checks where `instanceof` is unreliable (e.g. duplicated CJS/ESM module copies). |
| `sessionId` | `string`             | The id of the session that was already running. Constructor parameter, exposed as a `public readonly` field.               |
| `name`      | `"SessionBusyError"` | Set to `"SessionBusyError"` so structured loggers and stack traces identify the subclass correctly.                        |
| `message`   | `string`             | Set to `` `session "${sessionId}" already has an active run` ``.                                                           |

It extends the built-in `Error`, so it also carries `stack`.

### HTTP mapping recommendation

Surface as **HTTP 409 Conflict**. The class JSDoc and the entrypoint re-export comment both call this out. The bundled handler `handleAgentRun` already does this mapping internally; see `src/helpers/`.

### Example catch block

```ts
import { Agent, SessionBusyError } from "@sftinc/openrouter-agent";

try {
  const result = await agent.run(input, { sessionId });
  return reply.send(result);
} catch (err) {
  if (err instanceof SessionBusyError) {
    return reply.code(409).send({
      error: err.code,        // "SESSION_BUSY"
      sessionId: err.sessionId,
      message: err.message,
    });
  }
  throw err;
}
```

If you load the package twice (mixed CJS/ESM, or a duplicated copy in a monorepo) `instanceof` may fail; in that case prefer a duck-type check on `code`:

```ts
if ((err as { code?: string })?.code === "SESSION_BUSY") { ... }
```

## Implementing your own `SessionStore`

A production deployment will typically back the store with Redis, Postgres, DynamoDB, or similar. The contract is small enough to fit in a few dozen lines. Implementations are responsible for managing `createdAt`/`updatedAt` per the [timestamp contract](#timestamp-contract).

### Redis (sketch)

```ts
import type { SessionStore, SessionRecord, Message } from "@sftinc/openrouter-agent";
import type { RedisClientType } from "redis";

interface StoredEnvelope {
  messages: Message[];
  createdAt: string;
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: RedisClientType,
    private readonly prefix = "agent:session:",
    private readonly ttlSeconds = 60 * 60 * 24 * 7, // 7 days
  ) {}

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (raw === null) return null;
    const env = JSON.parse(raw) as StoredEnvelope & { updatedAt: string };
    return {
      messages: env.messages,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
    };
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    const nowIso = new Date().toISOString();
    // Preserve createdAt across writes; stamp it on first write.
    const prior = await this.redis.get(this.key(sessionId));
    const createdAt = prior
      ? (JSON.parse(prior) as StoredEnvelope).createdAt
      : nowIso;
    const envelope: StoredEnvelope & { updatedAt: string } = {
      messages,
      createdAt,
      updatedAt: nowIso,
    };
    // Redis EX gives you native, server-side TTL eviction — no need to
    // read createdAt back to enforce expiry.
    await this.redis.set(this.key(sessionId), JSON.stringify(envelope), {
      EX: this.ttlSeconds,
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId)); // idempotent: del returns 0 if missing
  }
}
```

### Postgres (sketch)

```ts
import type { SessionStore, SessionRecord, Message } from "@sftinc/openrouter-agent";
import type { Pool } from "pg";

// Schema:
//   create table agent_sessions (
//     session_id text primary key,
//     messages   jsonb not null,
//     created_at timestamptz not null default now(),
//     updated_at timestamptz not null default now()
//   );

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async get(sessionId: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<{
      messages: Message[];
      created_at: Date;
      updated_at: Date;
    }>(
      "select messages, created_at, updated_at from agent_sessions where session_id = $1",
      [sessionId],
    );
    if (rows.length === 0) return null;
    return {
      messages: rows[0].messages,
      createdAt: rows[0].created_at.toISOString(),
      updatedAt: rows[0].updated_at.toISOString(),
    };
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    // INSERT … ON CONFLICT preserves created_at via the row that already
    // exists; updated_at is refreshed via excluded.updated_at = now().
    await this.pool.query(
      `insert into agent_sessions (session_id, messages, updated_at)
         values ($1, $2::jsonb, now())
       on conflict (session_id) do update
         set messages   = excluded.messages,
             updated_at = excluded.updated_at`,
      [sessionId, JSON.stringify(messages)],
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.pool.query(
      "delete from agent_sessions where session_id = $1",
      [sessionId],
    );
  }
}
```

### Implementer's checklist

- `get` returns `null` (not a record with `messages: []`) for unknown ids.
- `get` returns a `SessionRecord`, not a bare `Message[]`. Both timestamps must be ISO 8601 UTC strings.
- `get` and `set` snapshot the messages array so caller mutation cannot leak across the boundary.
- `set` preserves `createdAt` from any existing row and refreshes `updatedAt` on every write.
- `delete` is idempotent.
- The implementation is safe across distinct session ids; no per-session locking is required (the `Agent` already guarantees single-flight).
- Do **not** persist `system` messages. The loop strips them before `set`, but you should treat that as a defense in depth, not a license to store them.
- Errors thrown from any of the three methods will bubble up through `Agent.run` and surface as the run's `agent:end` `error` stop reason; if `set` throws, the run's downstream events have already been emitted but the persistence write is lost — design for at-least-once with an idempotent overwrite (both sketches above are idempotent overwrites).

## Internal helpers

There are no internal helpers under `src/session/`. The folder contains exactly four source files:

- `src/session/SessionStore.ts` — the `SessionStore` interface (type-only export).
- `src/session/SessionRecord.ts` — the `SessionRecord` type (type-only export).
- `src/session/InMemorySessionStore.ts` — the bundled `Map`-backed implementation, plus the `InMemorySessionStoreOptions` type.
- `src/session/SessionBusyError.ts` — the busy-session error class.

…plus the public-surface barrel `src/session/index.ts`.

The single-flight enforcement (`activeSessions: Set<string>`, `acquireSession`) lives on `Agent` rather than in this folder — see `src/agent/Agent.ts`. The transactional persist gate (the `persistable` check before `set`) lives in the run loop at `src/agent/loop.ts`. The system-message strip on load is in `resolveInitialMessages` in the same file. None of these are exported from the package; they are documented here only so implementers understand the surrounding contract.
