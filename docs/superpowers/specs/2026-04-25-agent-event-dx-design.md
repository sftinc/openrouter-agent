# Agent event DX — design

**Date:** 2026-04-25
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `src/agent/`, `examples/demo/`, public package surface

## Motivation

Wiring up the demo's per-turn activity bubble surfaced three friction points
that every consumer of `AgentEvent`s will hit:

1. **Timing is hand-rolled.** UIs that want "completed in Xs" measure wall
   time on the client by stamping `Date.now()` at `agent:start` and again at
   `agent:end`. Network jitter inflates the number, the bookkeeping leaks
   into render code, and per-tool timings are not available at all without
   the consumer also tracking each `tool:start`.
2. **Event consumers re-implement the same `switch`.** `chat.js` has a
   ~90-line typed switch on `event.type`. Every Express/Next/CLI/Slack
   integration will copy the same shape, with TypeScript narrowing redone by
   hand and forgotten variants causing silent UI bugs.
3. **`event.display ?? defaultDisplay(event)` is the documented pattern but
   not a single export.** The demo independently invented
   `function displayOf(event) { return event.display ?? null }` and silently
   discards SDK fallback titles. The pattern is small enough to ship.

This design adds three coordinated, additive changes that remove all three
frictions at once and shrink the demo's event handler from ~90 lines to
~20.

## Non-goals

- **No NDJSON helper.** Tempting, but couples the package to HTTP transport.
  Defer to a later, separately-shipped `parseNdjsonStream` if it earns its
  weight.
- **No reactive integrations** (React hooks, Vue composables). Frameworks
  are downstream of the typed dispatcher; ship the primitive first.
- **No event-schema versioning.** The package is pre-1.0; we add fields
  rather than version the union.
- **No demo build step.** The demo stays vanilla JS, runnable with
  `node examples/demo/server.ts` and no bundler.

## Section 1 — Timing fields on events

Every lifecycle event gains absolute timestamps stamped server-side at the
loop emission site. End events also gain the precomputed `elapsedMs`.

| Event | Existing fields | Added fields |
|---|---|---|
| `agent:start` | runId, parentRunId?, agentName, display? | `startedAt: number` |
| `agent:end` | runId, result, display? | `startedAt: number`, `endedAt: number`, `elapsedMs: number` |
| `tool:start` | runId, toolUseId, toolName, input, display? | `startedAt: number` |
| `tool:progress` | runId, toolUseId, elapsedMs, display? | `startedAt: number` (existing `elapsedMs` retained) |
| `tool:end` (success) | runId, toolUseId, output, metadata?, display? | `startedAt: number`, `endedAt: number`, `elapsedMs: number` |
| `tool:end` (error) | runId, toolUseId, error, metadata?, display? | `startedAt: number`, `endedAt: number`, `elapsedMs: number` |
| `message`, `message:delta`, `error` | unchanged | none |

Rationale for shipping all three end-event fields rather than just one:

- `elapsedMs` is what UIs want — no math, no client clock skew, render
  directly.
- `startedAt` / `endedAt` are what logs and telemetry want — sortable,
  joinable across services, replayable.
- The bytes are negligible and consumers pick whichever they need.

### Computation

The loop captures `Date.now()` at exactly the moment it would have emitted
the event today. No additional async work, no clock fanciness. Each phase
records its own `startedAt` locally and reuses it on the corresponding end
event so `elapsedMs === endedAt - startedAt` is invariant.

### Existing fields

No fields are removed. The `tool:end` success/error discriminator
(`"error" in event`) is unchanged. `agent:end`'s `result.stopReason` is
unchanged. Display hooks are unchanged.

### `defaultDisplay` update

`defaultDisplay` consults the new `elapsedMs` field for end events:

- `agent:end` → `Completed in ${round(elapsedMs/1000)}s` (or
  `Completed with errors in Xs` when `result.stopReason === "error"`).
- `tool:end` → `Completed tool in Xs` / `Tool failed after Xs`.
- All other events unchanged.

## Section 2 — `consumeAgentEvents` helper

A typed dispatcher exported from the package.

```ts
export interface AgentEventHandlers {
  onAgentStart?:   (e: Extract<AgentEvent, { type: "agent:start" }>)   => void | Promise<void>;
  onAgentEnd?:     (e: Extract<AgentEvent, { type: "agent:end" }>)     => void | Promise<void>;
  onMessage?:      (e: Extract<AgentEvent, { type: "message" }>)       => void | Promise<void>;
  onMessageDelta?: (e: Extract<AgentEvent, { type: "message:delta" }>) => void | Promise<void>;
  onToolStart?:    (e: Extract<AgentEvent, { type: "tool:start" }>)    => void | Promise<void>;
  onToolProgress?: (e: Extract<AgentEvent, { type: "tool:progress" }>) => void | Promise<void>;
  onToolEnd?:      (e: Extract<AgentEvent, { type: "tool:end" }>)      => void | Promise<void>;
  onError?:        (e: Extract<AgentEvent, { type: "error" }>)         => void | Promise<void>;
  /**
   * Catch-all hook. Runs AFTER any matching typed handler. Useful for
   * logging or telemetry that should observe every event without forcing
   * the consumer to enumerate variants.
   */
  onAny?:          (e: AgentEvent)                                     => void | Promise<void>;
}

export async function consumeAgentEvents(
  source: AsyncIterable<AgentEvent>,
  handlers: AgentEventHandlers,
): Promise<void>;
```

### Behavior

- For each event, the matching typed handler runs first, then `onAny`.
- Handlers are awaited before the next event is pulled. This preserves
  back-pressure semantics (same as a manual `for await ... of`).
- Handler throws → propagate. The function rejects with the same error,
  matching `for await` behavior. No swallow-and-continue.
- Missing handlers are silently skipped. There is no "unhandled event"
  warning; consumers that want exhaustiveness use TypeScript's narrowing in
  their own code or rely on `onAny`.
- Returns when the source iterator completes normally.

### What this fixes

- TypeScript narrows each handler's `event` parameter to the right variant —
  no `if (event.type === "tool:end" && "error" in event)` ceremony.
- Adding a new event variant later (say `agent:turn`) becomes an opt-in
  extension — existing consumers keep working; consumers that want to react
  add a new handler.
- Cross-cutting concerns (logging, "time-to-first-token", auto-rendering
  `defaultDisplay` if no other handler claims the event) get a canonical
  hook point via `onAny`.

### What this does NOT do

- No NDJSON parsing. The helper is pure: any `AsyncIterable<AgentEvent>`
  works (e.g. `agent.runStream(...)`). Streams arriving over HTTP are the
  caller's responsibility today.
- No automatic UI rendering. Consumers still decide what to draw.

## Section 3 — `displayOf` helper

```ts
export function displayOf(event: AgentEvent): EventDisplay {
  return event.display ?? defaultDisplay(event);
}
```

That is the entire change. `defaultDisplay` already exists and is retained.
The new helper is the one-liner that pairs the optional `display` field with
the SDK fallback in a single expression.

### Why ship it

- Eliminates the demo's pre-existing bug where its local
  `displayOf(event) => event.display ?? null` silently discards the SDK
  fallback titles.
- Removes the temptation to hand-roll a "null if missing" version in every
  consumer.
- Pairs naturally with `consumeAgentEvents` — handlers can call
  `displayOf(e)` to get a guaranteed `{ title, content? }` without
  remembering to fall back.

## Section 4 — Files touched

### SDK

- **`src/agent/events.ts`** — extend each affected variant in `AgentEvent`
  with the timing fields. Update `defaultDisplay` so end events use
  `elapsedMs`. Add JSDoc explaining that times are server-stamped at emit
  time.
- **`src/agent/loop.ts`** — capture `Date.now()` at each phase boundary;
  pass through to the corresponding emit. One local variable per active
  tool invocation; one for the run as a whole.
- **`src/agent/consumeEvents.ts`** *(new)* — `AgentEventHandlers` interface
  and `consumeAgentEvents` function. ~30 lines including JSDoc.
- **`src/agent/displayOf.ts`** *(new)* — the one-liner. Could live in
  `events.ts`, but a dedicated file keeps the public-helper conceptual
  grouping clear.
- **`src/agent/index.ts`** — re-export `consumeAgentEvents`,
  `AgentEventHandlers`, `displayOf`.
- **`src/index.ts`** — re-export at the package root; update the
  package-level JSDoc to mention the new helpers under the "Agent layer"
  section.

### Tests

- **`tests/agent/loop.test.ts`** — extend with assertions:
  - Every emitted event has the documented timing fields.
  - `event.startedAt ≤ event.endedAt` for end events.
  - `event.elapsedMs === event.endedAt - event.startedAt` for end events.
  - For a subagent invocation, the inner `agent:start.startedAt` ≥ outer
    `agent:start.startedAt` and `agent:end.endedAt` ≤ outer
    `agent:end.endedAt` (timings nest cleanly).
  - `defaultDisplay` produces "Completed in Xs" / "Tool failed after Xs"
    for end events.
- **`tests/agent/consumeEvents.test.ts`** *(new)*:
  - Typed dispatch — each handler receives only its variant.
  - Missing handlers are silently skipped.
  - `onAny` runs after the typed handler for every event.
  - Async handlers are awaited (next event isn't pulled until prior
    handler resolves).
  - Handler throw propagates as a rejection.

### Demo

- **`examples/demo/public/chat.js`**
  - Drop the local `displayOf(event) => event.display ?? null`.
  - Drop `agentStartedAt` and the `Date.now()` math in `agent:end`.
  - Replace with `event.elapsedMs` (server-stamped).
  - Inline a three-line vanilla copy of `displayOf` (and a minimal
    `defaultDisplay`) so the demo stays single-file and bundler-free. The
    bug is fixed regardless because the inlined version delegates to a
    real fallback instead of returning `null`.
- **`examples/demo/agent.ts`** — JSDoc nudge mentioning that
  `agent:end.elapsedMs` is now available downstream.
- **`examples/demo/backend.ts`** — no changes; events pass through
  opaquely.
- **`examples/demo/public/index.html`** — no changes.

## Risks & mitigations

- **Wire size.** Three additional numeric fields per end event, one per
  start. Negligible — bytes per turn are dominated by message content.
- **Backwards compatibility.** Package is pre-1.0; additions are
  non-breaking. Any consumer that hard-asserts the exact shape of an event
  via `Exact<...>` will need to widen — none in this repo.
- **Clock guarantees.** Times are server wall-clock from `Date.now()`. We
  do not promise monotonicity across NTP jumps. Tests assert
  `startedAt ≤ endedAt` only because both use the same source within
  microseconds of each other on the same process.
- **`onAny` ordering.** Documented as "after the typed handler". Tests
  pin this so future refactors don't silently flip it.

## Open questions

None blocking. Naming is final per brainstorming session
(`consumeAgentEvents`, `AgentEventHandlers`, `displayOf`).

## Acceptance criteria

1. `npm run typecheck` passes with the new fields and exports.
2. `npm test` passes including the new test files.
3. The demo runs unchanged (`node examples/demo/server.ts`); the activity
   bubble's "Completed in Xs" title is rendered from `event.elapsedMs` with
   no client-side timing bookkeeping.
4. The package's top-level `src/index.ts` JSDoc mentions
   `consumeAgentEvents` and `displayOf` under the Agent layer section.
