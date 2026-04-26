# Session Layer (`src/session/`)

The session layer provides pluggable conversation persistence so that successive `Agent.run` calls that share a `sessionId` can resume against the prior message history. The contract is intentionally narrow: a `SessionStore` only needs `get`, `set`, and `delete`. The `system` role is **never** persisted — it is treated as agent configuration, not conversation state, and is stripped both by the loop before calling `set` and defensively on load. Writes are **transactional**: `set` is invoked only on clean terminal stop reasons (`done`, `max_turns`, `length`, `content_filter`); runs that error or are aborted leave the store untouched, so callers can safely retry the same user message. Per-session single-flight is enforced by the `Agent` (not the store) — overlapping runs for the same `sessionId` raise a `SessionBusyError`.

## Imports

```ts
import {
  InMemorySessionStore,
  SessionBusyError,
  type SessionRecord,
  type SessionStore,
} from "@sftinc/openrouter-agent";
```

`SessionStore` and `SessionRecord` are type-only; `InMemorySessionStore` and `SessionBusyError` are value exports. All are re-exported from the package entrypoint at `src/index.ts:213-227` and originate from the folder index `src/session/index.ts:19-21`.

## `SessionRecord` type

Defined at `src/session/SessionRecord.ts:3-40`.

`SessionRecord` is the persisted session shape returned by `SessionStore.get`. It wraps the conversation `messages` array with two ISO-8601 timestamps so backends can drive TTL eviction, audit trails, or "recently active" surfaces without inventing their own metadata layer. Timestamps are always set by the store implementation, never by the agent loop.

### Properties

| Property    | Type      | Description                                                                                                                          |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `messages`  | `Message[]` | Full conversation history for this session, in wire order. Excludes `system` messages (those live on the `Agent` config, not on the session). |
| `createdAt` | `string`  | ISO-8601 UTC string captured on the **first** write for this `sessionId`. Immutable across subsequent writes.                         |
| `updatedAt` | `string`  | ISO-8601 UTC string captured on the **most recent** write. Refreshed by every successful `set`. Used by `InMemorySessionStore` and other TTL-aware backends to decide whether an entry is stale. |

### Example

```ts
import type { SessionRecord } from "@sftinc/openrouter-agent";

const record: SessionRecord = {
  messages: [{ role: "user", content: "hi" }],
  createdAt: "2026-04-26T18:23:11.044Z",
  updatedAt: "2026-04-26T18:23:11.044Z",
};
```

## `SessionStore` interface

Defined at `src/session/SessionStore.ts:42-79`.

`SessionStore` is the persistence contract used by `Agent`. Implementations may be in-memory, on-disk, Redis, SQL, or anything else with async semantics. The full interface is three async methods.

| Method   | Signature                                                    | Called by `Agent`                                                  |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `get`    | `(sessionId: string) => Promise<Message[] \| null>`          | At the start of each run (`src/agent/loop.ts:608-611`)             |
| `set`    | `(sessionId: string, messages: Message[]) => Promise<void>`  | After a clean terminal stop reason (`src/agent/loop.ts:782-784`)   |
| `delete` | `(sessionId: string) => Promise<void>`                       | Never called by the loop — exposed for caller-driven cleanup       |

### `get(sessionId): Promise<Message[] | null>`

Source: `src/session/SessionStore.ts:43-53`.

Load the persisted message history for a session.

**Parameters**

| Name        | Type     | Required | Description                                                                                       |
| ----------- | -------- | -------- | ------------------------------------------------------------------------------------------------- |
| `sessionId` | `string` | yes      | Opaque identifier supplied by the caller of `Agent.run` via `options.sessionId`. |

**Returns** — `Promise<Message[] | null>`. The array is in conversation order. Return `null` (not `[]`) when no session has ever been persisted under `sessionId`. Implementations should return a defensive copy so caller mutation cannot bleed into stored state.

**Semantics**

- The agent loop *also* defensively filters any `system`-role messages out of whatever `get` returns (`src/agent/loop.ts:436-440`, `resolveInitialMessages` in `src/agent/loop.ts:417-452`). Stores that — through legacy data or a buggy backend — return system messages will not corrupt the run, but the recommended invariant is that they were never stored in the first place.
- Called exactly once per run, before any LLM call.

### `set(sessionId, messages): Promise<void>`

Source: `src/session/SessionStore.ts:54-70`.

Replace the persisted message history for a session with the run's final tail.

**Parameters**

| Name        | Type        | Required | Description                                                                                                          |
| ----------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | `string`    | yes      | Identifier under which to store the messages.                                                                        |
| `messages`  | `Message[]` | yes      | Full conversation history to persist. The agent loop has already stripped any `system` messages before calling this. |

**Returns** — `Promise<void>` resolved once the write is durable (for whatever durability the backend offers).

**Semantics**

- Invoked **only** on clean terminal stop reasons: `done`, `max_turns`, `length`, `content_filter` (`src/agent/loop.ts:777-784`). Runs ending in `error` or `aborted` skip `set` entirely so callers can retry safely.
- Implementations should snapshot `messages` (e.g. with a shallow copy) so subsequent loop mutations do not retroactively change persisted state.
- The supplied `messages` will not contain a `system` entry; persisting one anyway is harmless because of the load-side filter, but wasteful.

### `delete(sessionId): Promise<void>`

Source: `src/session/SessionStore.ts:71-78`.

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

From `src/session/SessionStore.ts:24-28`:

- Implementations only need to be safe across **distinct** `sessionId` values.
- Per-session serialization is the `Agent`'s responsibility — it tracks in-flight ids in a `Set<string>` (`activeSessions`, see `src/agent/Agent.ts:157`) and throws `SessionBusyError` synchronously from `Agent.run` (before the `AgentRun` handle is returned) when the same id is already running on the same instance.
- Stores therefore do **not** need internal per-session locking.

### System-message exclusion

The system role is configured on the `Agent` (or supplied per-run via `options.system`), not stored in the conversation. Two layers enforce this:

1. **On persist** — `resolveInitialMessages` builds the loop's working `messages` array without any `system` entry (`src/agent/loop.ts:417-452`); the loop's `set` call therefore passes a system-free array.
2. **On load (defensive)** — `resolveInitialMessages` also strips `system` messages from whatever the store returns (`src/agent/loop.ts:436-440`), so a misbehaving or legacy backend cannot inject a stray system prompt at run start.

## `InMemorySessionStore` class

Defined at `src/session/InMemorySessionStore.ts:36-92`. The bundled `SessionStore` implementation, intended for tests, single-process servers, and local development. State is lost on process exit.

### Constructor

```ts
new InMemorySessionStore()
```

No arguments. Creates a fresh, empty store. Source: `src/session/InMemorySessionStore.ts:36-44`.

### Storage shape

| Field | Visibility          | Type                    | Description                                                                                                                                    |
| ----- | ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `map` | `private readonly`  | `Map<string, Message[]>` | Internal map of `sessionId` -> persisted message array. The reference is immutable; the map's contents are mutated by `set` and `delete`. |

Source: `src/session/InMemorySessionStore.ts:44`.

### Public methods

#### `get(sessionId)`

Source: `src/session/InMemorySessionStore.ts:56-59`.

```ts
async get(sessionId: string): Promise<Message[] | null>
```

Returns a **shallow copy** (`[...value]`) of the stored array, or `null` if `sessionId` is unknown. Individual `Message` objects are not deep-cloned, so callers should treat them as read-only.

#### `set(sessionId, messages)`

Source: `src/session/InMemorySessionStore.ts:75-77`.

```ts
async set(sessionId: string, messages: Message[]): Promise<void>
```

Stores a **shallow copy** of `messages`. Overwrites any prior value under `sessionId`. Resolves on the next microtask.

#### `delete(sessionId)`

Source: `src/session/InMemorySessionStore.ts:89-91`.

```ts
async delete(sessionId: string): Promise<void>
```

Removes the entry if present. Idempotent — unknown ids resolve cleanly.

### Snapshot semantics

Both `get` and `set` use `[...value]` to copy the array. Consequence:

- A caller cannot mutate stored state by mutating the array `get` returned.
- Subsequent loop-side mutations to the array passed into `set` do not retroactively change persisted state.
- `Message` objects themselves are shared by reference. Treat them as immutable.

### Concurrency notes

`InMemorySessionStore` itself has **no** locking — `Map` operations are synchronous, and the methods only do a single read or write. Per-session single-flight is **not** enforced by this class; it is enforced by `Agent` via the `activeSessions: Set<string>` instance field plus the `acquireSession` helper at `src/agent/Agent.ts:280-289`:

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

The released callback is invoked from a `finally` block wrapped around `runLoop` (`src/agent/Agent.ts:252-266`), so the session id is always cleared even on thrown errors or abort. This busy-flag mechanism is per-`Agent`-instance only; sharing a `sessionId` across two distinct `Agent` instances will not raise `SessionBusyError`.

## `SessionBusyError`

Defined at `src/session/SessionBusyError.ts:32-55`. Thrown by `Agent` when a second run is started for a `sessionId` that already has a run in flight on the same `Agent` instance.

### When it is thrown

- From `Agent.run(input, options)` — **synchronously**, before the `AgentRun` handle is returned and before any work is queued (`src/agent/Agent.ts:283`, via `acquireSession`). This is true regardless of whether the caller intends to `await` the run for a `Result` or `for await` it for events. Wrap the `agent.run(...)` call site in `try/catch`, not the `await`.

### Properties

| Property    | Type              | Source                                       | Description                                                                                                                |
| ----------- | ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `code`      | `"SESSION_BUSY"`  | `src/session/SessionBusyError.ts:38`         | Stable, machine-readable code. Always the literal string `"SESSION_BUSY"`. Use this for cross-realm checks where `instanceof` is unreliable (e.g. duplicated CJS/ESM module copies). |
| `sessionId` | `string`          | `src/session/SessionBusyError.ts:51`         | The id of the session that was already running. Constructor parameter, exposed as a `public readonly` field.               |
| `name`      | `"SessionBusyError"` | `src/session/SessionBusyError.ts:53`      | Set to `"SessionBusyError"` so structured loggers and stack traces identify the subclass correctly.                        |
| `message`   | `string`          | `src/session/SessionBusyError.ts:52`         | Set to `` `session "${sessionId}" already has an active run` ``.                                                           |

It extends the built-in `Error`, so it also carries `stack`.

### HTTP mapping recommendation

Surface as **HTTP 409 Conflict**. The class JSDoc and the entrypoint re-export comment both call this out (`src/session/SessionBusyError.ts:13-14`, `src/index.ts:209-211`). The bundled handler `handleAgentRun` already does this mapping internally; see `src/helpers/`.

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

A production deployment will typically back the store with Redis, Postgres, DynamoDB, or similar. The contract is small enough to fit in a few dozen lines.

### Redis (sketch)

```ts
import type { SessionStore, Message } from "@sftinc/openrouter-agent";
import type { RedisClientType } from "redis";

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: RedisClientType,
    private readonly prefix = "agent:session:",
    private readonly ttlSeconds = 60 * 60 * 24 * 7, // 7 days
  ) {}

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  async get(sessionId: string): Promise<Message[] | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (raw === null) return null;
    // Defensive copy via JSON round-trip; also filters nothing — the agent
    // loop itself drops any stray `system` messages.
    return JSON.parse(raw) as Message[];
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    // `messages` already has system stripped by the agent loop. Snapshot
    // happens implicitly via JSON.stringify.
    await this.redis.set(this.key(sessionId), JSON.stringify(messages), {
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
import type { SessionStore, Message } from "@sftinc/openrouter-agent";
import type { Pool } from "pg";

// Schema:
//   create table agent_sessions (
//     session_id text primary key,
//     messages   jsonb not null,
//     updated_at timestamptz not null default now()
//   );

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async get(sessionId: string): Promise<Message[] | null> {
    const { rows } = await this.pool.query<{ messages: Message[] }>(
      "select messages from agent_sessions where session_id = $1",
      [sessionId],
    );
    return rows.length ? (rows[0].messages as Message[]) : null;
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    await this.pool.query(
      `insert into agent_sessions (session_id, messages)
         values ($1, $2::jsonb)
       on conflict (session_id) do update
         set messages = excluded.messages,
             updated_at = now()`,
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

- `get` returns `null` (not `[]`) for unknown ids.
- `get` and `set` snapshot the array so caller mutation cannot leak across the boundary.
- `delete` is idempotent.
- The implementation is safe across distinct session ids; no per-session locking is required (the `Agent` already guarantees single-flight).
- Do **not** persist `system` messages. The loop strips them before `set`, but you should treat that as a defense in depth, not a license to store them.
- Errors thrown from any of the three methods will bubble up through `Agent.run` and surface as the run's `agent:end` `error` stop reason; if `set` throws, the run's downstream events have already been emitted but the persistence write is lost — design for at-least-once with an idempotent overwrite (both sketches above are idempotent overwrites).

## Internal helpers

There are no internal helpers under `src/session/`. The folder contains exactly four source files:

- `src/session/SessionRecord.ts` — the `SessionRecord` type (type-only export).
- `src/session/SessionStore.ts` — the `SessionStore` interface (type-only export).
- `src/session/InMemorySessionStore.ts` — the bundled `Map`-backed implementation.
- `src/session/SessionBusyError.ts` — the busy-session error class.

…plus the public-surface barrel `src/session/index.ts` (`src/session/index.ts:19-21`).

The single-flight enforcement (`activeSessions: Set<string>`, `acquireSession`) lives on `Agent` rather than in this folder — see `src/agent/Agent.ts:148`, `src/agent/Agent.ts:157`, and `src/agent/Agent.ts:280-289`. The transactional persist gate (the `persistable` check before `set`) lives in the run loop at `src/agent/loop.ts:777-784`. The system-message strip on load is in `resolveInitialMessages` at `src/agent/loop.ts:417-452`. None of these are exported from the package; they are documented here only so implementers understand the surrounding contract.
