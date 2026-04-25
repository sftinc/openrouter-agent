# Helpers Folder and NDJSON Helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `src/helpers/` folder that hosts public consumer-facing helpers (separated from SDK internals), move the existing `displayOf`/`consumeAgentEvents` into it, and add five new helpers — `streamText`, NDJSON serialize/parse, Node and Web response adapters, and a high-level `handleAgentRun` wrapper — plus refactor the demo backend to use them.

**Architecture:** New folder `src/helpers/` parallel to existing internal-only `src/lib/`. Wire-format truth lives in one helper (`serializeEventsAsNDJSON`); both response adapters delegate body production to it. The high-level wrapper (`handleAgentRun`) is pure composition over the low-level adapter + `agent.run` + `SessionBusyError` mapping. Public package surface (`@sftinc/openrouter-agent` named exports) is preserved; only internal source paths change.

**Tech Stack:** TypeScript, Node.js ≥20 (Web `Response`/`ReadableStream`/`AbortController` globals available), Vitest, Zod (existing). No new runtime dependencies.

---

## File Structure

**New files (in dependency order):**

| Path | Responsibility |
|---|---|
| `src/helpers/index.ts` | Re-export the helpers folder's public surface. |
| `src/helpers/streamText.ts` | `streamText(source)` — yield assistant text chunks. |
| `src/helpers/ndjson.ts` | `serializeEvent`, `serializeEventsAsNDJSON`, `readEventStream`. |
| `src/helpers/responseAdapters.ts` | `pipeEventsToNodeResponse`, `eventsToWebResponse`, shared `NodeResponseLike` interface, shared `ResponseAdapterOptions`. |
| `src/helpers/http.ts` | `handleAgentRun`, `handleAgentRunWebResponse`, plus `HandleAgentRunOptions` / `HandleAgentRunNodeOptions`. |
| `tests/helpers/streamText.test.ts` | Tests for `streamText`. |
| `tests/helpers/ndjson.test.ts` | Tests for the three NDJSON helpers. |
| `tests/helpers/responseAdapters.test.ts` | Tests for both adapters. |
| `tests/helpers/http.test.ts` | Tests for both `handleAgentRun*` wrappers. |

**Moved files (path changes only):**

| From | To |
|---|---|
| `src/agent/displayOf.ts` | `src/helpers/displayOf.ts` |
| `src/agent/consumeEvents.ts` | `src/helpers/consumeEvents.ts` |
| `tests/agent/displayOf.test.ts` | `tests/helpers/displayOf.test.ts` |
| `tests/agent/consumeEvents.test.ts` | `tests/helpers/consumeEvents.test.ts` |

**Modified files:**

| Path | Change |
|---|---|
| `src/agent/index.ts` | Drop re-exports of `displayOf`, `consumeAgentEvents`, `AgentEventHandlers`, `defaultDisplay`. Update file-level JSDoc paragraph. |
| `src/index.ts` | Switch helper-export source paths from `./agent/index.js` to `./helpers/index.js`. Add new helper exports incrementally. |
| `examples/demo/backend.ts` | Replace `handleChat` body with a `handleAgentRun(...)` call. |
| `memory/agent_run_subagent_event_filter.md` | Update any references to the old paths (if present). |

---

## Task 1 — Move `displayOf` and `consumeAgentEvents` into `src/helpers/`

Single atomic commit. No behavior change. The package root surface is unchanged after this task.

**Files:**
- Create: `src/helpers/displayOf.ts`
- Create: `src/helpers/consumeEvents.ts`
- Create: `src/helpers/index.ts`
- Delete: `src/agent/displayOf.ts`
- Delete: `src/agent/consumeEvents.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/index.ts`
- Move: `tests/agent/displayOf.test.ts` → `tests/helpers/displayOf.test.ts`
- Move: `tests/agent/consumeEvents.test.ts` → `tests/helpers/consumeEvents.test.ts`

- [ ] **Step 1: Create `src/helpers/displayOf.ts`**

```ts
/**
 * `displayOf` — convenience helper that resolves the display payload for any
 * {@link AgentEvent}, preferring an explicit `event.display` and falling back
 * to {@link defaultDisplay}.
 *
 * Equivalent to writing `event.display ?? defaultDisplay(event)` everywhere,
 * but exposed as a single import so consumers cannot accidentally drop the
 * SDK fallback (e.g. by writing `event.display ?? null`).
 */
import type { AgentEvent, EventDisplay } from "../agent/events.js";
import { defaultDisplay } from "../agent/events.js";

/**
 * Resolve the `{ title, content? }` to render for an agent event.
 *
 * @param event Any {@link AgentEvent}.
 * @returns The event's explicit `display` if set, otherwise the
 *   {@link defaultDisplay} for that variant. Always returns a fully-shaped
 *   {@link EventDisplay} — never `null` or `undefined`.
 *
 * @example
 * ```ts
 * import { displayOf } from "@sftinc/openrouter-agent";
 *
 * for await (const event of agent.runStream("hello")) {
 *   const { title, content } = displayOf(event);
 *   console.log(title, content ?? "");
 * }
 * ```
 */
export function displayOf(event: AgentEvent): EventDisplay {
  return event.display ?? defaultDisplay(event);
}
```

- [ ] **Step 2: Create `src/helpers/consumeEvents.ts`** — copy the current contents of `src/agent/consumeEvents.ts` verbatim, but change the events-type import path from `./events.js` to `../agent/events.js`.

The full file body is identical to `src/agent/consumeEvents.ts` (107 lines including the JSDoc, the `AgentEventHandlers` interface, and the `consumeAgentEvents` async function). Only this line changes:

Before:
```ts
import type { AgentEvent } from "./events.js";
```
After:
```ts
import type { AgentEvent } from "../agent/events.js";
```

- [ ] **Step 3: Create `src/helpers/index.ts`**

```ts
/**
 * Public surface for the `helpers` module — consumer-facing utilities for
 * working with {@link Agent} runs and event streams.
 *
 * Helpers in this folder are imported from the package root; they do not
 * participate in the agent-loop machinery itself.
 */
export { displayOf } from "./displayOf.js";
export { consumeAgentEvents } from "./consumeEvents.js";
export type { AgentEventHandlers } from "./consumeEvents.js";
export { defaultDisplay } from "../agent/events.js";
```

- [ ] **Step 4: Delete `src/agent/displayOf.ts` and `src/agent/consumeEvents.ts`**

```bash
rm src/agent/displayOf.ts src/agent/consumeEvents.ts
```

- [ ] **Step 5: Update `src/agent/index.ts`**

Replace the file with:

```ts
/**
 * Public surface for the `agent` module.
 *
 * Re-exports the {@link Agent} class (the primary entry point), the
 * {@link AgentRun} handle returned from `Agent.run()`, the lower-level
 * {@link runLoop} driver and its config/options shapes, and the event
 * vocabulary ({@link AgentEvent}, {@link AgentDisplayHooks},
 * {@link EventDisplay}, {@link EventEmit}).
 *
 * Consumer-facing helpers (`displayOf`, `consumeAgentEvents`,
 * `defaultDisplay`) now live in `src/helpers/` and are re-exported through
 * the package root.
 *
 * Consumers should import from this folder (e.g. `from "./agent"`) rather
 * than from individual files inside it.
 */
export { Agent } from "./Agent.js";
export type { AgentConfig, AgentRunOptions } from "./Agent.js";
export { AgentRun } from "./AgentRun.js";
export { runLoop } from "./loop.js";
export type { RunLoopConfig, RunLoopOptions } from "./loop.js";
export type { AgentDisplayHooks, AgentEvent, EventDisplay, EventEmit } from "./events.js";
```

- [ ] **Step 6: Update `src/index.ts`**

Find this block:

```ts
export { defaultDisplay, displayOf, consumeAgentEvents } from "./agent/index.js";
export type { AgentEventHandlers } from "./agent/index.js";
```

Replace with:

```ts
export { defaultDisplay, displayOf, consumeAgentEvents } from "./helpers/index.js";
export type { AgentEventHandlers } from "./helpers/index.js";
```

(Leave the surrounding documentation block on lines ~228–240 unchanged.)

- [ ] **Step 7: Move `tests/agent/displayOf.test.ts` → `tests/helpers/displayOf.test.ts`**

```bash
mkdir -p tests/helpers && git mv tests/agent/displayOf.test.ts tests/helpers/displayOf.test.ts
```

Then update line 3 of the moved file from:
```ts
import { displayOf } from "../../src/agent/displayOf.js";
```
to:
```ts
import { displayOf } from "../../src/helpers/displayOf.js";
```

- [ ] **Step 8: Move `tests/agent/consumeEvents.test.ts` → `tests/helpers/consumeEvents.test.ts`**

```bash
git mv tests/agent/consumeEvents.test.ts tests/helpers/consumeEvents.test.ts
```

Update the import path inside from `../../src/agent/consumeEvents.js` to `../../src/helpers/consumeEvents.js`.

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no output beyond the script banner).

- [ ] **Step 10: Run tests**

Run: `npm test`
Expected: PASS — all existing tests still pass (the moved tests now run from `tests/helpers/`).

- [ ] **Step 11: Commit**

```bash
git add src/helpers/ src/agent/displayOf.ts src/agent/consumeEvents.ts \
        src/agent/index.ts src/index.ts \
        tests/agent/displayOf.test.ts tests/agent/consumeEvents.test.ts \
        tests/helpers/displayOf.test.ts tests/helpers/consumeEvents.test.ts
git commit -m "refactor: move displayOf/consumeAgentEvents into src/helpers/

Separates consumer-facing helpers from agent-loop internals. Public
package surface is unchanged (re-exports flow through src/index.ts as
before), tests move alongside their files."
```

---

## Task 2 — `streamText` helper (TDD)

Yields assistant text chunks. Falls back to the final assistant message when no deltas were observed.

**Files:**
- Create: `tests/helpers/streamText.test.ts`
- Create: `src/helpers/streamText.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/streamText.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { streamText } from "../../src/helpers/streamText.js";

async function* iter(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

describe("streamText", () => {
  test("yields delta text in arrival order", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "demo", startedAt: 0 },
      { type: "message:delta", runId: "r1", text: "Hello " },
      { type: "message:delta", runId: "r1", text: "world" },
    ];
    expect(await collect(streamText(iter(events)))).toEqual(["Hello ", "world"]);
  });

  test("falls back to final assistant message when no deltas seen", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "demo", startedAt: 0 },
      {
        type: "message",
        runId: "r1",
        message: { role: "assistant", content: "fallback answer" },
      },
    ];
    expect(await collect(streamText(iter(events)))).toEqual(["fallback answer"]);
  });

  test("does not re-emit the final message when deltas were seen", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "streamed" },
      {
        type: "message",
        runId: "r1",
        message: { role: "assistant", content: "streamed" },
      },
    ];
    expect(await collect(streamText(iter(events)))).toEqual(["streamed"]);
  });

  test("ignores tool calls and reasoning content", async () => {
    const events: AgentEvent[] = [
      {
        type: "tool:start",
        runId: "r1",
        toolUseId: "t1",
        toolName: "calc",
        input: {},
        startedAt: 0,
      },
      {
        type: "tool:end",
        runId: "r1",
        toolUseId: "t1",
        output: "42",
        startedAt: 0,
        endedAt: 1,
        elapsedMs: 1,
      },
      {
        type: "message",
        runId: "r1",
        message: { role: "assistant", content: "post-tool" },
      },
    ];
    expect(await collect(streamText(iter(events)))).toEqual(["post-tool"]);
  });

  test("yields nothing when no assistant text is present", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "demo", startedAt: 0 },
      {
        type: "message",
        runId: "r1",
        message: { role: "assistant", content: [] },
      },
    ];
    expect(await collect(streamText(iter(events)))).toEqual([]);
  });

  test("ignores empty delta strings", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "" },
      { type: "message:delta", runId: "r1", text: "ok" },
    ];
    expect(await collect(streamText(iter(events)))).toEqual(["ok"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helpers/streamText.test.ts`
Expected: FAIL with "Cannot find module '../../src/helpers/streamText.js'" or equivalent module-not-found error.

- [ ] **Step 3: Write minimal implementation**

Create `src/helpers/streamText.ts`:

```ts
/**
 * `streamText` — async-iterates assistant text from an {@link AgentEvent}
 * stream, yielding `message:delta.text` chunks in arrival order. Falls back
 * to the final assistant `message.content` if no deltas ever arrived (e.g.
 * non-streaming providers).
 */
import type { AgentEvent } from "../agent/events.js";

/**
 * Yield assistant text from an agent run.
 *
 * Yields each `message:delta.text` chunk as it arrives. If the stream
 * completes without ever emitting a delta AND a final assistant `message`
 * carries string content, yields that content as a single trailing chunk.
 * Tool calls and reasoning content are not yielded.
 *
 * @param source Any `AsyncIterable<AgentEvent>` — typically the return value
 *   of `agent.runStream(...)` or an `AgentRun` handle.
 * @returns An async iterable of plain text chunks. Empty deltas are skipped.
 *
 * @example
 * ```ts
 * import { streamText } from "@sftinc/openrouter-agent";
 *
 * for await (const chunk of streamText(agent.runStream("hello"))) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export async function* streamText(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string> {
  let sawDelta = false;
  let pendingFinal: string | undefined;
  for await (const event of source) {
    if (event.type === "message:delta") {
      if (event.text.length === 0) continue;
      sawDelta = true;
      yield event.text;
      continue;
    }
    if (
      event.type === "message" &&
      event.message.role === "assistant" &&
      typeof event.message.content === "string" &&
      event.message.content.length > 0
    ) {
      pendingFinal = event.message.content;
    }
  }
  if (!sawDelta && pendingFinal !== undefined) {
    yield pendingFinal;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/helpers/streamText.test.ts`
Expected: PASS — all six test cases green.

- [ ] **Step 5: Wire helper into `src/helpers/index.ts`**

Append to the existing file:

```ts
export { streamText } from "./streamText.js";
```

- [ ] **Step 6: Wire helper into `src/index.ts`**

Find the helpers re-export block (the one we updated in Task 1):

```ts
export { defaultDisplay, displayOf, consumeAgentEvents } from "./helpers/index.js";
export type { AgentEventHandlers } from "./helpers/index.js";
```

Replace with:

```ts
export { defaultDisplay, displayOf, consumeAgentEvents, streamText } from "./helpers/index.js";
export type { AgentEventHandlers } from "./helpers/index.js";
```

Update the surrounding JSDoc paragraph (which currently lists the existing helpers) to mention `streamText` as well — add a bullet:

```ts
 * - {@link streamText} — async-iterable of assistant text chunks; yields
 *   each `message:delta.text` and falls back to the final assistant message
 *   when no deltas arrive.
```

- [ ] **Step 7: Run typecheck and full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/streamText.test.ts src/helpers/streamText.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add streamText for assistant-text-only iteration"
```

---

## Task 3 — `serializeEvent` and `serializeEventsAsNDJSON` (TDD)

Format-only helpers. `serializeEvent` returns one line; `serializeEventsAsNDJSON` yields lines plus a synthetic error line on iterator throw.

**Files:**
- Create: `tests/helpers/ndjson.test.ts`
- Create: `src/helpers/ndjson.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing tests for the two serializers**

Create `tests/helpers/ndjson.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import {
  serializeEvent,
  serializeEventsAsNDJSON,
} from "../../src/helpers/ndjson.js";

async function* iter(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

async function* throwingIter(
  events: AgentEvent[],
  err: unknown,
): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
  throw err;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

describe("serializeEvent", () => {
  test("returns a single JSON line with no embedded newlines", () => {
    const ev: AgentEvent = {
      type: "message:delta",
      runId: "r1",
      text: "hi",
    };
    const line = serializeEvent(ev);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(ev);
  });
});

describe("serializeEventsAsNDJSON", () => {
  test("yields each event encoded with a trailing newline", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const lines = await collect(serializeEventsAsNDJSON(iter(events)));
    expect(lines.length).toBe(2);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0])).toEqual(events[0]);
    expect(JSON.parse(lines[1])).toEqual(events[1]);
  });

  test("yields a synthetic error line if the source throws", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
    ];
    const lines = await collect(
      serializeEventsAsNDJSON(throwingIter(events, new Error("boom"))),
    );
    expect(lines.length).toBe(2);
    const last = JSON.parse(lines[1]);
    expect(last).toEqual({
      type: "error",
      runId: "server",
      error: { message: "boom" },
    });
  });

  test("uses String(err) when the thrown value is not an Error", async () => {
    const lines = await collect(
      serializeEventsAsNDJSON(throwingIter([], "non-error")),
    );
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: "error",
      runId: "server",
      error: { message: "non-error" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/helpers/ndjson.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the two serializers**

Create `src/helpers/ndjson.ts`:

```ts
/**
 * NDJSON codec for {@link AgentEvent} streams.
 *
 * The wire format is the canonical transport for streaming agent events
 * over HTTP: one JSON-encoded event per line, terminated by `\n`. Both
 * response adapters in `responseAdapters.ts` delegate body production to
 * {@link serializeEventsAsNDJSON}, so the format truth lives in this file.
 *
 * Synthetic error events have `runId: "server"` (when `serializeEventsAsNDJSON`
 * catches a source throw) or `runId: "client"` (when {@link readEventStream}
 * encounters malformed JSON). They use the same shape as the loop's `error`
 * variant so existing consumers render them without special handling.
 */
import type { AgentEvent } from "../agent/events.js";

/**
 * Encode a single {@link AgentEvent} as one JSON line. The result contains
 * no embedded newlines and no trailing newline.
 *
 * @param event The event to encode.
 * @returns A JSON string with no `\n` characters.
 */
export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

/**
 * Convert an {@link AgentEvent} stream into NDJSON text lines. Each yielded
 * string ends with `\n`. If `source` throws mid-iteration, yields a final
 * synthetic error line (`type: "error"`, `runId: "server"`) and completes
 * without re-throwing.
 *
 * @param source Any `AsyncIterable<AgentEvent>` — typically an `AgentRun`
 *   handle or `agent.runStream(...)`.
 * @returns An async iterable of NDJSON-framed lines.
 */
export async function* serializeEventsAsNDJSON(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string> {
  try {
    for await (const event of source) {
      yield serializeEvent(event) + "\n";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const synthetic: AgentEvent = {
      type: "error",
      runId: "server",
      error: { message },
    };
    yield serializeEvent(synthetic) + "\n";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/helpers/ndjson.test.ts`
Expected: PASS — all four `serializeEvent`/`serializeEventsAsNDJSON` test cases green.

- [ ] **Step 5: Wire serializers into `src/helpers/index.ts`**

Append:

```ts
export { serializeEvent, serializeEventsAsNDJSON } from "./ndjson.js";
```

- [ ] **Step 6: Wire serializers into `src/index.ts`**

Update the helpers re-export block to include them, and add a bullet to the JSDoc paragraph for these two functions:

```ts
export { defaultDisplay, displayOf, consumeAgentEvents, streamText, serializeEvent, serializeEventsAsNDJSON } from "./helpers/index.js";
export type { AgentEventHandlers } from "./helpers/index.js";
```

JSDoc bullet to add:

```ts
 * - {@link serializeEvent} / {@link serializeEventsAsNDJSON} — NDJSON codec
 *   for streaming events over HTTP. The latter yields a synthetic error
 *   line on iterator throw so consumers always see a clean terminator.
```

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/ndjson.test.ts src/helpers/ndjson.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add NDJSON serializers (serializeEvent, serializeEventsAsNDJSON)"
```

---

## Task 4 — `readEventStream` (TDD)

Parses NDJSON byte streams back into events. Malformed lines yield synthetic error events with `runId: "client"`.

**Files:**
- Modify: `tests/helpers/ndjson.test.ts`
- Modify: `src/helpers/ndjson.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append failing tests for `readEventStream`**

Append to `tests/helpers/ndjson.test.ts` (above the closing of the file, in a new `describe` block):

```ts
import { readEventStream } from "../../src/helpers/ndjson.js";

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

async function collectEvents(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of source) out.push(e);
  return out;
}

describe("readEventStream", () => {
  test("parses NDJSON bytes back into events", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const body = streamFromString(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await collectEvents(readEventStream(body))).toEqual(events);
  });

  test("skips empty and whitespace-only lines", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
    ];
    const body = streamFromString(
      "\n   \n" + JSON.stringify(events[0]) + "\n\n",
    );
    expect(await collectEvents(readEventStream(body))).toEqual(events);
  });

  test("yields a synthetic error event for malformed lines and continues", async () => {
    const ok: AgentEvent = { type: "message:delta", runId: "r1", text: "ok" };
    const body = streamFromString(`not-json\n${JSON.stringify(ok)}\n`);
    const events = await collectEvents(readEventStream(body));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      type: "error",
      runId: "client",
    });
    expect((events[0] as { error: { message: string } }).error.message).toMatch(/JSON|parse/i);
    expect(events[1]).toEqual(ok);
  });

  test("handles events split across chunk boundaries", async () => {
    const ev: AgentEvent = { type: "message:delta", runId: "r1", text: "abc" };
    const line = JSON.stringify(ev) + "\n";
    const mid = Math.floor(line.length / 2);
    const body = streamFromChunks([line.slice(0, mid), line.slice(mid)]);
    expect(await collectEvents(readEventStream(body))).toEqual([ev]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/helpers/ndjson.test.ts`
Expected: FAIL — `readEventStream` is not exported yet.

- [ ] **Step 3: Implement `readEventStream`**

Append to `src/helpers/ndjson.ts`:

```ts
/**
 * Parse an NDJSON byte stream back into {@link AgentEvent}s.
 *
 * Splits on `\n`, skips blank or whitespace-only lines, and parses each
 * remaining line with `JSON.parse`. Lines that fail to parse yield a
 * synthetic error event (`type: "error"`, `runId: "client"`) so a single
 * malformed byte sequence does not abort the entire iteration.
 *
 * @param body A `ReadableStream<Uint8Array>` — typically `response.body`
 *   from a `fetch` call against an NDJSON endpoint.
 * @returns An async iterable of parsed {@link AgentEvent}s.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      yield parseLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parseLine(buffer);
}

function parseLine(line: string): AgentEvent {
  try {
    return JSON.parse(line) as AgentEvent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: "error",
      runId: "client",
      error: { message },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/helpers/ndjson.test.ts`
Expected: PASS — all `readEventStream` test cases plus the previous serializer tests are green.

- [ ] **Step 5: Wire into `src/helpers/index.ts`**

Update the line added in Task 3 to:

```ts
export { serializeEvent, serializeEventsAsNDJSON, readEventStream } from "./ndjson.js";
```

- [ ] **Step 6: Wire into `src/index.ts`**

Add `readEventStream` to the helpers re-export:

```ts
export { defaultDisplay, displayOf, consumeAgentEvents, streamText, serializeEvent, serializeEventsAsNDJSON, readEventStream } from "./helpers/index.js";
```

Update the JSDoc bullet for the NDJSON helpers to mention `readEventStream`:

```ts
 * - {@link serializeEvent} / {@link serializeEventsAsNDJSON} /
 *   {@link readEventStream} — NDJSON codec for streaming events over HTTP.
 *   The serializer yields a synthetic error line on iterator throw; the
 *   reader yields a synthetic error event on malformed lines, so consumers
 *   never see a hard parse failure terminating the iteration.
```

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/ndjson.test.ts src/helpers/ndjson.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add readEventStream for parsing NDJSON event bytes"
```

---

## Task 5 — `pipeEventsToNodeResponse` adapter (TDD)

Low-level Node `ServerResponse` adapter. Structurally typed (no `node:http` import). Optional `AbortController` is wired through `res.on('close')`.

**Files:**
- Create: `tests/helpers/responseAdapters.test.ts`
- Create: `src/helpers/responseAdapters.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/responseAdapters.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { pipeEventsToNodeResponse } from "../../src/helpers/responseAdapters.js";

async function* iter(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

function makeMockRes() {
  const writes: string[] = [];
  const closeListeners: Array<() => void> = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  let writableEnded = false;
  return {
    writes,
    closeListeners,
    get head() {
      return head;
    },
    get writableEnded() {
      return writableEnded;
    },
    writeHead(status: number, headers: Record<string, string>) {
      head = { status, headers };
    },
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    },
    end() {
      writableEnded = true;
    },
    on(event: "close", listener: () => void) {
      if (event === "close") closeListeners.push(listener);
    },
  };
}

describe("pipeEventsToNodeResponse", () => {
  test("writes default headers and NDJSON lines, then ends", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter(events), res);
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(res.head?.headers["Cache-Control"]).toBe("no-cache");
    expect(res.head?.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.writes.length).toBe(2);
    expect(JSON.parse(res.writes[0].trim())).toEqual(events[0]);
    expect(JSON.parse(res.writes[1].trim())).toEqual(events[1]);
    expect(res.writableEnded).toBe(true);
  });

  test("merges caller-supplied headers over defaults", async () => {
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter([]), res, {
      headers: { "X-Session-Id": "abc", "Cache-Control": "no-store" },
    });
    expect(res.head?.headers["X-Session-Id"]).toBe("abc");
    expect(res.head?.headers["Cache-Control"]).toBe("no-store");
    expect(res.head?.headers["Content-Type"]).toBe("application/x-ndjson");
  });

  test("respects a caller-supplied status", async () => {
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter([]), res, { status: 201 });
    expect(res.head?.status).toBe(201);
  });

  test("calls abort.abort() when res.on('close') fires before iteration ends", async () => {
    const abort = new AbortController();
    const res = makeMockRes();

    let resolveLong: (() => void) | undefined;
    async function* slow(): AsyncIterable<AgentEvent> {
      yield { type: "message:delta", runId: "r1", text: "a" };
      await new Promise<void>((r) => { resolveLong = r; });
      yield { type: "message:delta", runId: "r1", text: "b" };
    }

    const pipePromise = pipeEventsToNodeResponse(slow(), res, { abort });
    // Wait one microtask so iteration has started.
    await Promise.resolve();
    res.closeListeners.forEach((fn) => fn());
    expect(abort.signal.aborted).toBe(true);
    resolveLong?.();
    await pipePromise;
  });

  test("does not call abort if iteration finished cleanly", async () => {
    const abort = new AbortController();
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter([]), res, { abort });
    res.closeListeners.forEach((fn) => fn());
    // close after end is a no-op because writableEnded is true
    expect(abort.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helpers/responseAdapters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pipeEventsToNodeResponse`**

Create `src/helpers/responseAdapters.ts`:

```ts
/**
 * Response adapters that stream {@link AgentEvent}s as NDJSON over HTTP.
 *
 * Two adapters share the same options shape: {@link pipeEventsToNodeResponse}
 * for Node `http.ServerResponse` (structurally typed; no `node:http`
 * import), and {@link eventsToWebResponse} for Web `Response` (Workers,
 * Deno, Bun, fetch-style handlers). Both delegate body production to
 * {@link serializeEventsAsNDJSON} from `./ndjson.js`.
 */
import type { AgentEvent } from "../agent/events.js";
import { serializeEventsAsNDJSON } from "./ndjson.js";

/**
 * Structural type compatible with Node's `http.ServerResponse`. Defined
 * inline so this module does not import `node:http` (which would break
 * browser/Workers consumers).
 */
export interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  on(event: "close", listener: () => void): unknown;
  readonly writableEnded: boolean;
}

/**
 * Shared options for both response adapters.
 */
export interface ResponseAdapterOptions {
  /**
   * Optional controller. If provided, the adapter calls `abort.abort()` when
   * the underlying transport closes/cancels before iteration completes.
   * Caller is responsible for passing `abort.signal` into `agent.run(...)`.
   */
  abort?: AbortController;
  /**
   * Headers merged on top of the NDJSON defaults
   * (`Content-Type: application/x-ndjson`, `Cache-Control: no-cache`,
   * `X-Accel-Buffering: no`). Caller's values win on key collisions.
   */
  headers?: Record<string, string>;
  /** HTTP status. Defaults to `200`. */
  status?: number;
}

const NDJSON_DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

/**
 * Stream an {@link AgentEvent} source to a Node `http.ServerResponse`-shaped
 * object as NDJSON. Sets default headers, writes one line per event, and
 * calls `res.end()` in a `finally`. If `options.abort` is provided, hooks
 * `res.on('close')` so a client disconnect aborts the run.
 *
 * @param source Any `AsyncIterable<AgentEvent>` (e.g. an `AgentRun`).
 * @param res A Node response-shaped object satisfying {@link NodeResponseLike}.
 * @param options {@link ResponseAdapterOptions}.
 * @returns A promise that resolves when the response has ended.
 */
export async function pipeEventsToNodeResponse(
  source: AsyncIterable<AgentEvent>,
  res: NodeResponseLike,
  options: ResponseAdapterOptions = {},
): Promise<void> {
  const headers = { ...NDJSON_DEFAULT_HEADERS, ...(options.headers ?? {}) };
  res.writeHead(options.status ?? 200, headers);
  if (options.abort) {
    const abort = options.abort;
    res.on("close", () => {
      if (!res.writableEnded && !abort.signal.aborted) abort.abort();
    });
  }
  try {
    for await (const line of serializeEventsAsNDJSON(source)) {
      res.write(line);
    }
  } finally {
    res.end();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/helpers/responseAdapters.test.ts`
Expected: PASS — all five Node-adapter test cases green.

- [ ] **Step 5: Wire into `src/helpers/index.ts`**

Append:

```ts
export { pipeEventsToNodeResponse } from "./responseAdapters.js";
export type { NodeResponseLike, ResponseAdapterOptions } from "./responseAdapters.js";
```

- [ ] **Step 6: Wire into `src/index.ts`**

Update the helpers value re-export to include `pipeEventsToNodeResponse`. Add a separate `export type` line for `NodeResponseLike` and `ResponseAdapterOptions` near the existing `AgentEventHandlers` type re-export. Add a JSDoc bullet:

```ts
 * - {@link pipeEventsToNodeResponse} — streams events to a Node
 *   `http.ServerResponse` as NDJSON. Sets default headers, wires abort on
 *   `res.on('close')`, and delegates body to `serializeEventsAsNDJSON`.
```

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/responseAdapters.test.ts src/helpers/responseAdapters.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add pipeEventsToNodeResponse adapter"
```

---

## Task 6 — `eventsToWebResponse` adapter (TDD)

Low-level Web `Response` adapter for Workers / Deno / Bun / fetch-style handlers.

**Files:**
- Modify: `tests/helpers/responseAdapters.test.ts`
- Modify: `src/helpers/responseAdapters.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append failing tests for the Web adapter**

Append to `tests/helpers/responseAdapters.test.ts`:

```ts
import { eventsToWebResponse } from "../../src/helpers/responseAdapters.js";
import { readEventStream } from "../../src/helpers/ndjson.js";

describe("eventsToWebResponse", () => {
  test("returns a Response with default NDJSON headers and 200 status", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const res = eventsToWebResponse(iter(events));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(res.body).not.toBeNull();
    const back: AgentEvent[] = [];
    for await (const e of readEventStream(res.body!)) back.push(e);
    expect(back).toEqual(events);
  });

  test("merges caller-supplied headers over defaults", () => {
    const res = eventsToWebResponse(iter([]), {
      headers: { "X-Session-Id": "abc", "Cache-Control": "no-store" },
      status: 201,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Session-Id")).toBe("abc");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
  });

  test("calls abort.abort() when the stream is cancelled", async () => {
    const abort = new AbortController();

    async function* slow(): AsyncIterable<AgentEvent> {
      yield { type: "message:delta", runId: "r1", text: "a" };
      // Hang indefinitely until abort.
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    }

    const res = eventsToWebResponse(slow(), { abort });
    const reader = res.body!.getReader();
    await reader.read(); // pull the first chunk so the stream is active
    await reader.cancel();
    expect(abort.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/helpers/responseAdapters.test.ts`
Expected: FAIL on the `eventsToWebResponse` test cases — symbol not exported yet.

- [ ] **Step 3: Implement `eventsToWebResponse`**

Append to `src/helpers/responseAdapters.ts`:

```ts
/**
 * Stream an {@link AgentEvent} source as a Web `Response` body in NDJSON.
 * Suitable for Cloudflare Workers, Deno, Bun, or any `fetch`-style handler.
 *
 * If `options.abort` is provided, the returned stream's `cancel()` calls
 * `abort.abort()` so a client disconnect propagates into the run.
 *
 * @param source Any `AsyncIterable<AgentEvent>`.
 * @param options {@link ResponseAdapterOptions}.
 * @returns A Web `Response` with status 200 by default and an NDJSON stream body.
 */
export function eventsToWebResponse(
  source: AsyncIterable<AgentEvent>,
  options: ResponseAdapterOptions = {},
): Response {
  const headers = { ...NDJSON_DEFAULT_HEADERS, ...(options.headers ?? {}) };
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<string> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!iterator) iterator = serializeEventsAsNDJSON(source)[Symbol.asyncIterator]();
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    cancel() {
      if (options.abort && !options.abort.signal.aborted) options.abort.abort();
    },
  });
  return new Response(stream, { status: options.status ?? 200, headers });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/helpers/responseAdapters.test.ts`
Expected: PASS — all eight tests across both adapters green.

- [ ] **Step 5: Wire into `src/helpers/index.ts`**

Update the line added in Task 5 to:

```ts
export { pipeEventsToNodeResponse, eventsToWebResponse } from "./responseAdapters.js";
```

- [ ] **Step 6: Wire into `src/index.ts`**

Add `eventsToWebResponse` to the helpers re-export and update the JSDoc bullet:

```ts
 * - {@link pipeEventsToNodeResponse} / {@link eventsToWebResponse} —
 *   low-level adapters that stream events as NDJSON to a Node
 *   `ServerResponse` or a Web `Response` respectively. Both share
 *   {@link ResponseAdapterOptions} and wire abort on transport close.
```

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/responseAdapters.test.ts src/helpers/responseAdapters.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add eventsToWebResponse for Workers/Deno/Bun/fetch handlers"
```

---

## Task 7 — `handleAgentRun` (Node, TDD)

High-level wrapper that creates an AbortController, calls `agent.run`, maps `SessionBusyError` → 409, and delegates streaming to `pipeEventsToNodeResponse`.

**Files:**
- Create: `tests/helpers/http.test.ts`
- Create: `src/helpers/http.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/http.test.ts`:

```ts
import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { Agent, SessionBusyError, setOpenRouterClient } from "../../src/index.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { handleAgentRun } from "../../src/helpers/http.js";

// Vitest may run these in parallel; setOpenRouterClient is idempotent for
// our purposes and we override per-agent for runs anyway.
setOpenRouterClient({ apiKey: "test-key" });

function makeMockRes() {
  const writes: string[] = [];
  const closeListeners: Array<() => void> = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  let writableEnded = false;
  return {
    writes,
    closeListeners,
    get head() { return head; },
    get writableEnded() { return writableEnded; },
    writeHead(status: number, headers: Record<string, string>) { head = { status, headers }; },
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    },
    end() { writableEnded = true; },
    on(event: "close", listener: () => void) {
      if (event === "close") closeListeners.push(listener);
    },
  };
}

function fakeAgent(opts: {
  events?: AgentEvent[];
  throwSync?: unknown;
}): Agent {
  const agent = new Agent({ name: "fake", description: "fake" });
  // Replace `run` with a stub. AgentRun is async-iterable + has .result, but
  // for these tests we only need the async iterator path that
  // pipeEventsToNodeResponse consumes.
  vi.spyOn(agent, "run").mockImplementation(((..._args: unknown[]) => {
    if (opts.throwSync !== undefined) throw opts.throwSync;
    const events = opts.events ?? [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    } as never;
  }) as never);
  return agent;
}

describe("handleAgentRun", () => {
  test("streams events as NDJSON with default headers", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "fake", startedAt: 0 },
      { type: "message:delta", runId: "r1", text: "hi" },
    ];
    const agent = fakeAgent({ events });
    const res = makeMockRes();
    await handleAgentRun(agent, "hello", res);
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(res.writes.length).toBe(2);
    expect(JSON.parse(res.writes[1].trim())).toEqual(events[1]);
    expect(res.writableEnded).toBe(true);
  });

  test("includes X-Session-Id when sessionId is provided and echoSessionHeader defaults to true", async () => {
    const agent = fakeAgent({ events: [] });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc" });
    expect(res.head?.headers["X-Session-Id"]).toBe("abc");
  });

  test("does not include the session header when echoSessionHeader=false", async () => {
    const agent = fakeAgent({ events: [] });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc", echoSessionHeader: false });
    expect(res.head?.headers["X-Session-Id"]).toBeUndefined();
  });

  test("uses sessionHeaderName when provided", async () => {
    const agent = fakeAgent({ events: [] });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc", sessionHeaderName: "X-Conv" });
    expect(res.head?.headers["X-Conv"]).toBe("abc");
    expect(res.head?.headers["X-Session-Id"]).toBeUndefined();
  });

  test("maps SessionBusyError to 409 JSON by default", async () => {
    const agent = fakeAgent({ throwSync: new SessionBusyError("abc") });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc" });
    expect(res.head?.status).toBe(409);
    expect(res.head?.headers["Content-Type"]).toBe("application/json");
    expect(res.head?.headers["X-Session-Id"]).toBe("abc");
    const body = JSON.parse(res.writes.join(""));
    expect(body).toEqual({ error: "session busy", sessionId: "abc" });
    expect(res.writableEnded).toBe(true);
  });

  test("invokes onSessionBusy when provided", async () => {
    const agent = fakeAgent({ throwSync: new SessionBusyError("abc") });
    const res = makeMockRes();
    const onSessionBusy = vi.fn((_err, r) => {
      r.writeHead(429, { "Content-Type": "text/plain" });
      r.write("custom");
      r.end();
    });
    await handleAgentRun(agent, "hi", res, { sessionId: "abc", onSessionBusy });
    expect(onSessionBusy).toHaveBeenCalledTimes(1);
    expect(res.head?.status).toBe(429);
    expect(res.writes.join("")).toBe("custom");
  });

  test("rethrows non-SessionBusy synchronous errors from agent.run", async () => {
    const agent = fakeAgent({ throwSync: new Error("boom") });
    const res = makeMockRes();
    await expect(handleAgentRun(agent, "hi", res)).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helpers/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `handleAgentRun`**

Create `src/helpers/http.ts`:

```ts
/**
 * High-level HTTP wrappers that compose {@link pipeEventsToNodeResponse} /
 * {@link eventsToWebResponse} with `agent.run`, AbortController wiring,
 * and `SessionBusyError` → 409 mapping. Suitable for the common case of
 * "POST /chat → stream events back". Drop down to the lower-level adapters
 * when you need custom logic between request receipt and stream start.
 */
import type { Message } from "../types/index.js";
import { Agent, type AgentRunOptions } from "../agent/index.js";
import { SessionBusyError } from "../session/index.js";
import {
  pipeEventsToNodeResponse,
  type NodeResponseLike,
} from "./responseAdapters.js";

/**
 * Options shared by the Node and Web variants of the high-level wrapper.
 */
export interface HandleAgentRunOptions {
  /** Session id forwarded to `agent.run` and (when echoed) to the response header. */
  sessionId?: string;
  /** Whether to echo `sessionId` back as a response header. Defaults to `true`. */
  echoSessionHeader?: boolean;
  /** Header name used when echoing the session id. Defaults to `"X-Session-Id"`. */
  sessionHeaderName?: string;
  /** Extra response headers merged on top of the NDJSON defaults. */
  headers?: Record<string, string>;
  /**
   * Per-run options forwarded to `agent.run`. `sessionId` and `signal` are
   * managed by the wrapper and excluded from this shape.
   */
  runOptions?: Omit<AgentRunOptions, "sessionId" | "signal">;
}

/**
 * Node-only options: adds a hook for {@link SessionBusyError}.
 */
export interface HandleAgentRunNodeOptions extends HandleAgentRunOptions {
  /**
   * Called instead of the default 409 response when `agent.run` throws
   * {@link SessionBusyError}. The handler is responsible for writing a
   * complete response (status, headers, body, end).
   */
  onSessionBusy?: (err: SessionBusyError, res: NodeResponseLike) => void;
}

/**
 * Stream an {@link Agent} run to a Node response. Creates an internal
 * AbortController, calls `agent.run(input, { sessionId, signal })`, and
 * delegates the body stream to {@link pipeEventsToNodeResponse}.
 *
 * On {@link SessionBusyError} (synchronously thrown by `agent.run`), the
 * default behavior writes a 409 JSON response. Provide
 * {@link HandleAgentRunNodeOptions.onSessionBusy} to override.
 *
 * @param agent The agent to run.
 * @param input The user prompt or message array.
 * @param res A Node response-shaped object satisfying {@link NodeResponseLike}.
 * @param options {@link HandleAgentRunNodeOptions}.
 * @returns A promise that resolves once the response has ended.
 *
 * @example
 * ```ts
 * await handleAgentRun(agent, body.message, res, { sessionId: claimed });
 * ```
 */
export async function handleAgentRun(
  agent: Agent,
  input: string | Message[],
  res: NodeResponseLike,
  options: HandleAgentRunNodeOptions = {},
): Promise<void> {
  const sessionId = options.sessionId;
  const echoHeader = options.echoSessionHeader ?? true;
  const headerName = options.sessionHeaderName ?? "X-Session-Id";
  const sessionHeader: Record<string, string> =
    sessionId && echoHeader ? { [headerName]: sessionId } : {};

  const abort = new AbortController();
  let run: AsyncIterable<unknown>;
  try {
    run = agent.run(input, {
      sessionId,
      signal: abort.signal,
      ...(options.runOptions ?? {}),
    }) as AsyncIterable<unknown>;
  } catch (err) {
    if (err instanceof SessionBusyError) {
      if (options.onSessionBusy) {
        options.onSessionBusy(err, res);
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...sessionHeader,
        ...(options.headers ?? {}),
      };
      res.writeHead(409, headers);
      res.write(JSON.stringify({ error: "session busy", sessionId }));
      res.end();
      return;
    }
    throw err;
  }

  await pipeEventsToNodeResponse(
    run as AsyncIterable<import("../agent/events.js").AgentEvent>,
    res,
    {
      abort,
      headers: { ...sessionHeader, ...(options.headers ?? {}) },
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/helpers/http.test.ts`
Expected: PASS — all seven test cases green.

- [ ] **Step 5: Wire into `src/helpers/index.ts`**

Append:

```ts
export { handleAgentRun } from "./http.js";
export type { HandleAgentRunOptions, HandleAgentRunNodeOptions } from "./http.js";
```

- [ ] **Step 6: Wire into `src/index.ts`**

Add `handleAgentRun` to the helpers re-export and the option types to the type re-exports. Add a JSDoc bullet:

```ts
 * - {@link handleAgentRun} — Node response handler that composes
 *   `agent.run` + abort wiring + `SessionBusyError` → 409 mapping and
 *   delegates the stream to {@link pipeEventsToNodeResponse}. Drop down
 *   to the lower-level adapter when you need custom request handling.
```

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/http.test.ts src/helpers/http.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add handleAgentRun (Node high-level wrapper)"
```

---

## Task 8 — `handleAgentRunWebResponse` (Web, TDD)

Web-`Response` counterpart for Workers / Deno / Bun.

**Files:**
- Modify: `tests/helpers/http.test.ts`
- Modify: `src/helpers/http.ts`
- Modify: `src/helpers/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/helpers/http.test.ts`:

```ts
import { handleAgentRunWebResponse } from "../../src/helpers/http.js";
import { readEventStream } from "../../src/helpers/ndjson.js";

describe("handleAgentRunWebResponse", () => {
  test("returns a 200 Response with NDJSON body and merged headers", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const agent = fakeAgent({ events });
    const res = await handleAgentRunWebResponse(agent, "hi", { sessionId: "abc" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("X-Session-Id")).toBe("abc");
    const back: AgentEvent[] = [];
    for await (const e of readEventStream(res.body!)) back.push(e);
    expect(back).toEqual(events);
  });

  test("returns a 409 JSON Response on SessionBusyError", async () => {
    const agent = fakeAgent({ throwSync: new SessionBusyError("abc") });
    const res = await handleAgentRunWebResponse(agent, "hi", { sessionId: "abc" });
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Session-Id")).toBe("abc");
    expect(await res.json()).toEqual({ error: "session busy", sessionId: "abc" });
  });

  test("rethrows non-SessionBusy errors", async () => {
    const agent = fakeAgent({ throwSync: new Error("boom") });
    await expect(handleAgentRunWebResponse(agent, "hi")).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/helpers/http.test.ts`
Expected: FAIL on the new cases — `handleAgentRunWebResponse` is not yet exported.

- [ ] **Step 3: Implement `handleAgentRunWebResponse`**

Append to `src/helpers/http.ts`:

```ts
import { eventsToWebResponse } from "./responseAdapters.js";

/**
 * Stream an {@link Agent} run as a Web `Response` in NDJSON. Counterpart to
 * {@link handleAgentRun} for Cloudflare Workers, Deno, Bun, and any
 * `fetch`-style handler.
 *
 * On {@link SessionBusyError}, returns a 409 `Response` with
 * `Content-Type: application/json` and body `{ error, sessionId }`. Other
 * synchronous errors from `agent.run` propagate as a rejected promise.
 *
 * @param agent The agent to run.
 * @param input The user prompt or message array.
 * @param options {@link HandleAgentRunOptions}.
 * @returns A promise resolving to the `Response` to send back.
 *
 * @example
 * ```ts
 * export default {
 *   async fetch(req: Request): Promise<Response> {
 *     const { message, sessionId } = await req.json();
 *     return handleAgentRunWebResponse(agent, message, { sessionId });
 *   },
 * };
 * ```
 */
export async function handleAgentRunWebResponse(
  agent: Agent,
  input: string | Message[],
  options: HandleAgentRunOptions = {},
): Promise<Response> {
  const sessionId = options.sessionId;
  const echoHeader = options.echoSessionHeader ?? true;
  const headerName = options.sessionHeaderName ?? "X-Session-Id";
  const sessionHeader: Record<string, string> =
    sessionId && echoHeader ? { [headerName]: sessionId } : {};

  const abort = new AbortController();
  let run: AsyncIterable<unknown>;
  try {
    run = agent.run(input, {
      sessionId,
      signal: abort.signal,
      ...(options.runOptions ?? {}),
    }) as AsyncIterable<unknown>;
  } catch (err) {
    if (err instanceof SessionBusyError) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...sessionHeader,
        ...(options.headers ?? {}),
      };
      return new Response(
        JSON.stringify({ error: "session busy", sessionId }),
        { status: 409, headers },
      );
    }
    throw err;
  }

  return eventsToWebResponse(
    run as AsyncIterable<import("../agent/events.js").AgentEvent>,
    {
      abort,
      headers: { ...sessionHeader, ...(options.headers ?? {}) },
    },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/helpers/http.test.ts`
Expected: PASS — all ten http-test cases green.

- [ ] **Step 5: Wire into `src/helpers/index.ts`**

Update the line added in Task 7 to:

```ts
export { handleAgentRun, handleAgentRunWebResponse } from "./http.js";
```

- [ ] **Step 6: Wire into `src/index.ts`**

Add `handleAgentRunWebResponse` to the helpers re-export. Update the JSDoc bullet:

```ts
 * - {@link handleAgentRun} / {@link handleAgentRunWebResponse} — Node and
 *   Web high-level handlers that compose `agent.run` + abort wiring +
 *   `SessionBusyError` → 409 mapping and delegate the stream to the
 *   appropriate low-level adapter. Drop down to
 *   {@link pipeEventsToNodeResponse} / {@link eventsToWebResponse} when
 *   you need custom request handling.
```

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/http.test.ts src/helpers/http.ts \
        src/helpers/index.ts src/index.ts
git commit -m "feat(helpers): add handleAgentRunWebResponse for Workers/Deno/Bun"
```

---

## Task 9 — Refactor `examples/demo/backend.ts`

Replace the hand-rolled NDJSON pipe and `SessionBusyError` mapping with a single `handleAgentRun` call. Wire format and headers must remain identical.

**Files:**
- Modify: `examples/demo/backend.ts`

- [ ] **Step 1: Confirm current behavior is captured by an integration check**

Open the demo verbosely; identify the externally observable contract that must be preserved:

- 400 with JSON body when `message` is missing or invalid.
- 409 with `{ error: "session busy", sessionId }` when the session is busy.
- 200 with `Content-Type: application/x-ndjson`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `X-Session-Id: <id>` and an NDJSON event stream otherwise.
- Synthetic error event line on iterator throw mid-stream.
- Abort triggered on `res.on('close')`.

The new code preserves all of these behaviors via `handleAgentRun`. The 400 handling stays in the caller because it's about request parsing, not run execution.

- [ ] **Step 2: Replace the `handleChat` body**

Open `examples/demo/backend.ts` and replace the entire `handleChat` function (lines 21–92 in the current file) with this version. The 400 paths and the "mint or echo session id" logic stay; only the run/stream/close-handling block changes.

```ts
export async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	let raw = ''
	for await (const chunk of req) raw += chunk
	let body: { message?: string; sessionId?: string }
	try {
		body = JSON.parse(raw)
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'invalid JSON' }))
		return
	}

	const message = (body.message ?? '').trim()
	if (!message) {
		res.writeHead(400, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'message is required' }))
		return
	}
	// Session ids are owned by the server. The client only echoes back whatever
	// we gave it last. If the client sent nothing, or sent an id we don't
	// recognize, mint a fresh one and return it via the X-Session-Id response
	// header. This prevents a client from dictating or guessing session ids.
	const claimed = body.sessionId?.trim()
	const isKnown = claimed ? (await sessionStore.get(claimed)) !== null : false
	const sessionId = isKnown ? (claimed as string) : crypto.randomUUID()

	await handleAgentRun(agent, message, res, { sessionId })
}
```

- [ ] **Step 3: Update the imports at the top of the file**

Replace the existing `import` block:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionBusyError } from '../../src/index.js'
import type { AgentEvent, AgentRun } from '../../src/index.js'
import { agent, sessionStore } from './agent.js'
```

with:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleAgentRun } from '../../src/index.js'
import { agent, sessionStore } from './agent.js'
```

(Removes unused `SessionBusyError`, `AgentEvent`, and `AgentRun` imports — they're encapsulated by `handleAgentRun`.)

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-test the demo manually**

Run: `npm run demo` (in a separate terminal). Open the demo in a browser, send a message, confirm:
- The activity card renders with timeline phases.
- Tool invocations show start/end states.
- Closing the tab mid-run aborts the agent (check server logs — you should see no further token usage after the close).
- Hitting the same session twice in quick succession returns 409 from the server (visible in the browser network tab as "session busy").

If anything regresses, return to Step 2 and reconcile the diff with the prior `backend.ts`.

- [ ] **Step 7: Commit**

```bash
git add examples/demo/backend.ts
git commit -m "refactor(demo): use handleAgentRun for chat endpoint

Drops the manual NDJSON pipe, res.on('close') wiring, SessionBusyError
try/catch, and synthetic error event from handleChat. Wire format and
headers are unchanged; behavior is identical from the client's view."
```

---

## Task 10 — Documentation and memory cleanup

Final sweep to update any references to the old paths.

**Files:**
- Read and possibly modify: `memory/agent_run_subagent_event_filter.md` (and any other memory entries with `src/agent/displayOf.ts` or `src/agent/consumeEvents.ts` references)
- Read and possibly modify: `README.md` (if present and referencing helper paths)

- [ ] **Step 1: Check the memory folder for stale references**

Run: `grep -rn "src/agent/displayOf\|src/agent/consumeEvents\|tests/agent/displayOf\|tests/agent/consumeEvents" /Users/wwilliams/.claude/projects/-Users-wwilliams-Documents-development-GitHub-sft-agent/memory/ 2>/dev/null`
Expected: any matches are stale memory pointers.

- [ ] **Step 2: Update each match**

For every stale match, edit the memory file to reflect the new path (`src/helpers/displayOf.ts`, `src/helpers/consumeEvents.ts`, `tests/helpers/displayOf.test.ts`, `tests/helpers/consumeEvents.test.ts`).

- [ ] **Step 3: Check the repo for stale references**

Run: `grep -rn "src/agent/displayOf\|src/agent/consumeEvents\|tests/agent/displayOf\|tests/agent/consumeEvents" /Users/wwilliams/Documents/development/GitHub/sft-agent/ --include="*.ts" --include="*.md" --include="*.json" 2>/dev/null | grep -v node_modules | grep -v dist`
Expected: any matches are stale references in docs, JSDoc, or fixtures.

- [ ] **Step 4: Update each match**

If any of the stale references are in committed files (e.g. `README.md`, JSDoc cross-references that didn't get updated in earlier tasks), update them to the new paths.

- [ ] **Step 5: Final typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit (if anything changed in the repo)**

```bash
git add -A
git commit -m "docs: update path references after helpers/ folder move"
```

If nothing in the repo changed, skip this step.

- [ ] **Step 7: Push**

```bash
git push
```

---

## Self-review notes

Before handing off, verify:

1. **Spec coverage:** every section of the spec is implemented.
   - Folder structure — Tasks 1–8.
   - Format helpers (`serializeEvent`, `serializeEventsAsNDJSON`, `readEventStream`) — Tasks 3–4.
   - `streamText` — Task 2.
   - Response adapters (Node + Web) — Tasks 5–6.
   - High-level wrappers (Node + Web) — Tasks 7–8.
   - Move plan for displayOf/consumeAgentEvents — Task 1.
   - Tests — embedded in each TDD task.
   - Demo refactor scope — Task 9.
2. **Public surface unchanged:** re-exports updated incrementally; `src/index.ts` continues to export the same set of names plus new additions. No removals.
3. **No `node:http` import in `src/helpers/`:** `NodeResponseLike` is a structural interface defined inline; verify no helpers file imports `node:http`.
4. **Wire format truth:** `serializeEventsAsNDJSON` is the only place that builds NDJSON lines; both adapters delegate to it.
5. **Synthetic error event shape:** `{ type: "error", runId: "server" | "client", error: { message } }` — consistent across `serializeEventsAsNDJSON` (server) and `readEventStream` (client).
6. **`AgentRunOptions` `Omit`:** the wrapper excludes `sessionId | signal` from the caller's `runOptions` because the wrapper sets them itself.
