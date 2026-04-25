# Helpers folder and NDJSON helpers — design

**Date:** 2026-04-25
**Status:** Approved (ready for implementation plan)

## Problem

The SDK exposes two consumer-facing helpers today (`displayOf`, `consumeAgentEvents`) that live in `src/agent/`. They share a folder with the agent loop, the `Agent` class, `AgentRun`, and the event vocabulary, but they don't participate in any of those concerns — they exist only for SDK consumers. Mixing them muddies what `src/agent/` is "about."

The demo (`examples/demo/`) surfaces additional pain that the SDK doesn't currently address:

- Server-side NDJSON streaming is hand-rolled (`backend.ts:80–91`), including a synthetic error event built by hand on iterator throw.
- Client-side NDJSON parsing is hand-rolled (`chat.js:208–222`).
- `SessionBusyError` → HTTP 409 mapping is boilerplate every consumer writes.
- `res.on('close')` → `AbortController.abort()` wiring is boilerplate every Node consumer writes.
- Plain assistant text accumulation from `message:delta` events is boilerplate every chat-UI consumer writes.

These are real, copy-pasteable boilerplate that the SDK should encapsulate.

## Goals

1. Separate consumer-facing helpers from SDK internals via a new `src/helpers/` folder.
2. Ship streaming helpers — `streamText`, NDJSON serialize/parse, response adapters for Node and Web — that close the demo's hand-rolled boilerplate.
3. Keep the public package surface (`@sftinc/openrouter-agent` named exports) unchanged. This is purely an internal restructure plus additive new helpers.
4. All new helpers test-driven.

## Non-goals

- Bundling/distributing the SDK for browser use without a build step. The demo's `chat.js` stays vanilla JS and continues to inline its own `defaultDisplay`/`displayOf` mirrors. Solving that is a separate packaging decision.
- Adding helpers without demo evidence (subagent run-id demux, session truncation/clone, message constructors). Defer.

## Folder structure

Create `src/helpers/` parallel to existing `src/lib/`:

- `src/lib/` — internal utilities, never re-exported (already private).
- `src/helpers/` — consumer-facing helpers, re-exported from the package root.

Initial layout (flat — subdivide only if it grows past ~6 files):

```
src/helpers/
  index.ts             — public surface re-export
  displayOf.ts         — moved from src/agent/
  consumeEvents.ts     — moved from src/agent/
  streamText.ts        — new
  ndjson.ts            — new (format-only)
  responseAdapters.ts  — new (Node + Web HTTP adapters, low-level)
  http.ts              — new (handleAgentRun, high-level wrapper)
```

Public re-exports continue to flow through `src/index.ts`. Only the source path changes (`./agent/index.js` → `./helpers/index.js` for the helper exports).

## Format-only helpers (`src/helpers/ndjson.ts`)

```ts
export function serializeEvent(event: AgentEvent): string;

export async function* serializeEventsAsNDJSON(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string>;

export function readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AgentEvent>;
```

Behavior:

- `serializeEvent(event)` — single JSON line, no trailing newline. Used by callers who want full control over framing.
- `serializeEventsAsNDJSON(source)` — yields each event encoded as `JSON.stringify(event) + '\n'`. If the source iterator throws, yields a final synthetic error line and completes (does not re-throw). The synthetic event has `runId: "server"`.
- `readEventStream(body)` — wraps `body.getReader()` + `TextDecoder`, splits on `\n`, parses each line. Empty/whitespace-only lines are skipped. A malformed JSON line yields a synthetic error event (`runId: "client"`) rather than throwing the iteration.

### Canonical synthetic error event

```ts
{
  type: "error",
  runId: "server" | "client",
  error: { message: string },
}
```

Matches the demo's existing shape (`examples/demo/backend.ts:88`) and the `defaultDisplay("error")` rendering in `src/agent/events.ts`. Existing UIs continue to work without change.

## `streamText` (`src/helpers/streamText.ts`)

```ts
export async function* streamText(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string>;
```

Behavior:

- Yields each `message:delta.text` chunk as it arrives (no transformation).
- If the stream completes without ever emitting a `message:delta`, AND a final `message` event with `role: "assistant"` and string `content` was seen, yields that content as a single trailing chunk. This covers non-streaming providers and disabled-streaming configurations.
- If both deltas and a final message were seen (the common case), the final message is **not** re-emitted.
- Tool calls (`tool_calls` on assistant messages) and reasoning fields are not yielded.

Internal state: a single `sawDelta` boolean and a `pendingFinal` string. On stream end, emit `pendingFinal` only if `!sawDelta && pendingFinal`.

## Response adapters — low level (`src/helpers/responseAdapters.ts`)

```ts
interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  on(event: "close", listener: () => void): unknown;
  writableEnded: boolean;
}

export interface ResponseAdapterOptions {
  abort?: AbortController;
  headers?: Record<string, string>;
  status?: number; // default 200
}

export async function pipeEventsToNodeResponse(
  source: AsyncIterable<AgentEvent>,
  res: NodeResponseLike,
  options?: ResponseAdapterOptions,
): Promise<void>;

export function eventsToWebResponse(
  source: AsyncIterable<AgentEvent>,
  options?: ResponseAdapterOptions,
): Response;
```

Default response headers (callers can override or extend via `options.headers`):

| Header | Value |
|---|---|
| `Content-Type` | `application/x-ndjson` |
| `Cache-Control` | `no-cache` |
| `X-Accel-Buffering` | `no` |

`NodeResponseLike` is structural — the helper does not import `node:http`, so the helpers folder remains importable in any runtime.

Behavior:

- **Node adapter**: writes head with merged headers, iterates `serializeEventsAsNDJSON(source)`, writes each line, calls `res.end()` in a `finally`. If `options.abort` is provided, registers `res.on('close')` → `abort.abort()` (only fires if iteration hasn't finished).
- **Web adapter**: returns `new Response(stream, { status, headers })` where `stream` is a `ReadableStream<Uint8Array>` whose `start(controller)` reads from `serializeEventsAsNDJSON(source)` and enqueues `TextEncoder.encode(line)`. The stream's `cancel()` calls `options.abort?.abort()`.

Both adapters delegate body production to `serializeEventsAsNDJSON`, so the wire format has one source of truth.

## High-level wrapper (`src/helpers/http.ts`)

```ts
export interface HandleAgentRunOptions {
  sessionId?: string;
  echoSessionHeader?: boolean;       // default true
  sessionHeaderName?: string;        // default "X-Session-Id"
  headers?: Record<string, string>;
  runOptions?: Omit<AgentRunOptions, "sessionId" | "signal">;
}

export interface HandleAgentRunNodeOptions extends HandleAgentRunOptions {
  onSessionBusy?: (err: SessionBusyError, res: NodeResponseLike) => void;
}

export async function handleAgentRun(
  agent: Agent,
  input: string | Message[],
  res: NodeResponseLike,
  options?: HandleAgentRunNodeOptions,
): Promise<void>;

export async function handleAgentRunWebResponse(
  agent: Agent,
  input: string | Message[],
  options?: HandleAgentRunOptions,
): Promise<Response>;
```

Behavior:

1. Create an internal `AbortController`.
2. Try `agent.run(input, { sessionId, signal: abort.signal, ...runOptions })`.
3. On `SessionBusyError`:
   - Node: call `onSessionBusy(err, res)` if provided; otherwise write `409` with `Content-Type: application/json`, body `{ error: "session busy", sessionId }`. Includes `[sessionHeaderName]: sessionId` when `echoSessionHeader && sessionId`.
   - Web: return `new Response(JSON.stringify({ error: "session busy", sessionId }), { status: 409, headers })` where `headers` includes `Content-Type: application/json` and the optional session header echo on the same condition. Does **not** include the NDJSON content-type (the body is JSON, not a stream).
4. Build merged headers: defaults ⊕ `options.headers` ⊕ optional `{ [sessionHeaderName]: sessionId }` when `echoSessionHeader && sessionId`.
5. Delegate the stream to the corresponding low-level adapter, passing the `abort` controller through.

The high-level wrapper is purely composition over the low-level adapter + `agent.run` + `SessionBusyError` handling. Callers who need anything bespoke between request receipt and stream start (auth, rate limiting, custom session ID minting) drop down to the low-level adapter without losing any behavior.

## Move plan for existing helpers

- `src/agent/displayOf.ts` → `src/helpers/displayOf.ts`. Import path inside the file changes from `./events.js` to `../agent/events.js` for `defaultDisplay`.
- `src/agent/consumeEvents.ts` → `src/helpers/consumeEvents.ts`. Import path inside the file changes from `./events.js` to `../agent/events.js` for the `AgentEvent` type.
- `src/agent/index.ts`: drop the three re-exports `defaultDisplay`, `displayOf`, `consumeAgentEvents`, and the `AgentEventHandlers` type. Update the file's JSDoc paragraph (lines 8–10) to no longer list them.

  Note: `defaultDisplay` is defined in `src/agent/events.ts` and used internally by the loop's display hooks. It stays defined there. Its **public re-export** moves to `src/helpers/index.ts` (which re-exports it from `../agent/events.js`).
- `src/helpers/index.ts` (new): re-exports the full helpers surface.
- `src/index.ts`: change the source paths for `defaultDisplay`, `displayOf`, `consumeAgentEvents`, and `AgentEventHandlers` from `./agent/index.js` to `./helpers/index.js`. Add new exports for `streamText`, `serializeEvent`, `serializeEventsAsNDJSON`, `readEventStream`, `pipeEventsToNodeResponse`, `eventsToWebResponse`, `handleAgentRun`, `handleAgentRunWebResponse`, plus their option types.
- `tests/agent/displayOf.test.ts` → `tests/helpers/displayOf.test.ts`. Imports change from `../../src/agent/displayOf.js` to `../../src/helpers/displayOf.js`.
- `tests/agent/consumeEvents.test.ts` → `tests/helpers/consumeEvents.test.ts`. Imports change analogously.
- Memory note (`memory/agent_run_subagent_event_filter.md` and any others that reference the old paths) and any internal cross-references in JSDoc updated to new paths.

The public package surface (`@sftinc/openrouter-agent` named exports) is unchanged. Consumers see only additions.

## Testing strategy (TDD)

For each new helper, write the test file first; implement until it passes.

### `tests/helpers/streamText.test.ts`

- Yields delta texts in arrival order.
- Falls back to final assistant message when no deltas seen.
- Does not re-emit final message when deltas were seen.
- Ignores tool calls and reasoning content.
- Yields nothing when the source emits no assistant text at all.

### `tests/helpers/ndjson.test.ts`

- `serializeEvent` produces a single JSON line (no embedded newlines).
- `serializeEventsAsNDJSON` yields the expected lines in order, each ending with `\n`.
- When the source throws, a final synthetic error line is yielded with `runId: "server"`.
- `readEventStream` parses a stream of NDJSON bytes back into the original events.
- `readEventStream` skips empty/whitespace-only lines.
- `readEventStream` yields a synthetic error event with `runId: "client"` when a line is malformed JSON; iteration continues.

### `tests/helpers/responseAdapters.test.ts`

- Node adapter writes status, default headers, all event lines, and ends.
- Node adapter merges caller-supplied headers over defaults.
- Node adapter calls `abort.abort()` when `res.on('close')` fires before iteration completes.
- Web adapter returns a `Response` with merged headers and `200` status.
- Web adapter's stream emits the expected NDJSON bytes.
- Web adapter calls `abort.abort()` when the stream is cancelled.

### `tests/helpers/http.test.ts`

- `handleAgentRun` happy path: streams events to the response, includes `X-Session-Id` when configured.
- `handleAgentRun` maps `SessionBusyError` to 409 with JSON body by default.
- `handleAgentRun` invokes a custom `onSessionBusy` if provided.
- `handleAgentRun` propagates abort through to the run when the response closes.
- `handleAgentRunWebResponse` returns a 409 `Response` on `SessionBusyError`.
- `handleAgentRunWebResponse` returns a 200 `Response` with merged headers and a stream body otherwise.

### Existing tests

- `tests/agent/displayOf.test.ts` and `tests/agent/consumeEvents.test.ts` move to `tests/helpers/` with import paths updated. No assertion changes.

## Demo refactor scope

After helpers + tests are green:

- `examples/demo/backend.ts`: refactor `handleChat`. Replace the manual NDJSON pipe, the `res.on('close')` wiring, the `SessionBusyError` try/catch, and the synthetic error event construction with a single `handleAgentRun(agent, message, res, { sessionId: claimed, sessionHeaderName: "X-Session-Id" })` call. The "mint or echo" session ID resolution stays in the caller — the helper accepts whatever ID the caller decides.
- `examples/demo/public/chat.js`: **out of scope.** Vanilla browser JS without a bundler can't import the SDK. Continues to inline its own `defaultDisplay`/`displayOf` mirrors and its own NDJSON read loop. Refactoring it requires a packaging change (browser-friendly distribution), which is a separate decision.

The demo must remain functionally equivalent: same NDJSON wire format, same headers, same 409 behavior, same client experience.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Helper authors accidentally import `node:http` and break browser/Workers consumers | `NodeResponseLike` is a structural interface defined inline in `responseAdapters.ts`; no `node:http` import anywhere in `src/helpers/` (lint check during review). |
| Wire-format drift between the SDK helpers and the demo's vanilla `chat.js` mirror | The synthetic error event shape is documented as canonical in this spec; the demo's `chat.js` already uses the same shape. Future format changes update both in lockstep until packaging makes the duplication unnecessary. |
| C-level wrapper grows opinions that don't fit a real consumer | Layered design: B-level adapters are the primitive. Consumers can drop down at any time without losing functionality; C is purely composition. |
| Existing tests break from import-path changes | Tests move alongside the files they test; re-run `npm test` after the move and before adding new tests. |

## Out of scope

- Browser-friendly distribution of the SDK (so `chat.js` could `import { displayOf } from "@sftinc/openrouter-agent"`).
- Subagent run-id event demux (no demo evidence).
- Session helpers (`cloneSession`, `truncateSession`).
- Message constructors (`userMessage`, `systemMessage`, `assistantMessage`).
- Event-stream cancellation hooks beyond `AbortController.abort()` (no demo evidence).
