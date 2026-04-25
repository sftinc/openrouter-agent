# Agent event DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-stamped timing to lifecycle events, ship a typed `consumeAgentEvents` dispatcher and a `displayOf` fallback helper, and adopt all three in the demo so per-turn timing renders from server data.

**Architecture:** Three coordinated, additive changes to `src/agent/`. The event union gains `startedAt` / `endedAt` / `elapsedMs` fields stamped by `runLoop` at emit boundaries. Two new exports — `consumeAgentEvents` (typed dispatcher over `AsyncIterable<AgentEvent>`) and `displayOf` (`event.display ?? defaultDisplay(event)`) — sit beside the existing `defaultDisplay`. The demo's `chat.js` adopts the new `elapsedMs` and inlines a corrected vanilla `displayOf` so the demo stays bundler-free.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Zod 4. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-25-agent-event-dx-design.md`

---

## File structure

**Modified**
- `src/agent/events.ts` — extend `AgentEvent` variants with timing fields; update `defaultDisplay` end-event titles.
- `src/agent/loop.ts` — capture `Date.now()` at phase boundaries; thread into emits.
- `src/agent/index.ts` — re-export `consumeAgentEvents`, `AgentEventHandlers`, `displayOf`.
- `src/index.ts` — re-export the same at the package root; small JSDoc nudge under the Agent layer section.
- `tests/agent/events.test.ts` — update `defaultDisplay` expectations for end events.
- `tests/agent/loop.test.ts` — add timing assertions; add nested-run timing test.
- `examples/demo/public/chat.js` — adopt `event.elapsedMs`; replace local `displayOf` with corrected inline version.
- `examples/demo/agent.ts` — one-line JSDoc nudge.

**New**
- `src/agent/displayOf.ts` — one-liner export.
- `src/agent/consumeEvents.ts` — typed dispatcher and `AgentEventHandlers` interface.
- `tests/agent/displayOf.test.ts` — fallback behavior coverage.
- `tests/agent/consumeEvents.test.ts` — typed dispatch, missing handlers, `onAny`, async back-pressure, error propagation.

---

## Task 1: Extend `AgentEvent` with timing fields

**Files:**
- Modify: `src/agent/events.ts`

- [ ] **Step 1: Add timing fields to the relevant `AgentEvent` variants.**

In `src/agent/events.ts`, modify the `AgentEvent` union. Apply these additions verbatim:

In the `agent:start` variant (currently lines ~104–119) add after `display?`:

```ts
      /** Wall-clock epoch ms captured at the moment this event was emitted. */
      startedAt: number;
```

In the `agent:end` variant (currently lines ~120–129) add after `display?`:

```ts
      /** Wall-clock epoch ms when the run started (matches the prior `agent:start.startedAt`). */
      startedAt: number;
      /** Wall-clock epoch ms when the run ended (this event was emitted). */
      endedAt: number;
      /** `endedAt - startedAt`. Provided so consumers can render durations without subtracting. */
      elapsedMs: number;
```

In the `tool:start` variant (currently lines ~148–161) add after `display?`:

```ts
      /** Wall-clock epoch ms captured at the moment this event was emitted. */
      startedAt: number;
```

In the `tool:progress` variant (currently lines ~162–173) add after `display?` (`elapsedMs` already exists):

```ts
      /** Wall-clock epoch ms when the originating `tool:start` was emitted. */
      startedAt: number;
```

In **both** `tool:end` variants (currently lines ~174–187 success and ~188–201 error) add after `display?`:

```ts
      /** Wall-clock epoch ms when the originating `tool:start` was emitted. */
      startedAt: number;
      /** Wall-clock epoch ms when this `tool:end` was emitted. */
      endedAt: number;
      /** `endedAt - startedAt`. Provided so consumers can render durations without subtracting. */
      elapsedMs: number;
```

The `message`, `message:delta`, and `error` variants are NOT modified.

- [ ] **Step 2: Run typecheck — expect failures pointing into `loop.ts`.**

Run: `npm run typecheck`
Expected: failures at every `emit(...)` site in `src/agent/loop.ts` saying the new timing fields are missing. This confirms the type changes landed.

- [ ] **Step 3: Commit.**

```bash
git add src/agent/events.ts
git commit -m "feat(events): extend AgentEvent variants with timing fields"
```

---

## Task 2: Stamp timing fields in `runLoop`

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Capture `runStartedAt` and stamp `agent:start`.**

In `src/agent/loop.ts`, inside `runLoop` (currently around line 575), immediately after `const runId = newRunId();` add:

```ts
  const runStartedAt = Date.now();
```

Then in the `emit({ type: "agent:start", ... })` call (currently lines 584–590), add `startedAt: runStartedAt,` to the emitted event:

```ts
  emit({
    type: "agent:start",
    runId,
    parentRunId,
    agentName: config.agentName,
    startedAt: runStartedAt,
    display: resolveAgentDisplay(config.display, input, (d) => d.start?.(input)),
  });
```

- [ ] **Step 2: Stamp `agent:end`.**

At the end of `runLoop` (currently lines 783–788), capture `endedAt` and pass timing fields:

```ts
  const runEndedAt = Date.now();
  emit({
    type: "agent:end",
    runId,
    result,
    startedAt: runStartedAt,
    endedAt: runEndedAt,
    elapsedMs: runEndedAt - runStartedAt,
    display: resolveAgentDisplay(config.display, input, (d) => pickAgentEndHook(d, result)),
  });
```

- [ ] **Step 3: Capture per-tool start time and pass it through `executeToolCall`.**

In `src/agent/loop.ts`, change the signature of `executeToolCall` (currently line 312) to accept no extra parameter — instead, capture `Date.now()` inside the function, immediately after `const tool = toolByName.get(toolName);` (currently line 321):

```ts
  const toolStartedAt = Date.now();
```

Then update the `emit({ type: "tool:start", ... })` call inside `executeToolCall` (currently lines 330–337):

```ts
  emit({
    type: "tool:start",
    runId,
    toolUseId,
    toolName,
    input: parsedArgs,
    startedAt: toolStartedAt,
    display: resolveToolDisplay(tool, parsedArgs, (d) => d.start?.(parsedArgs)),
  });
```

- [ ] **Step 4: Stamp both `tool:end` variants.**

In `executeToolCall`, before each of the two `emit({ type: "tool:end", ... })` calls (the error variant currently around lines 365–372 and the success variant around lines 377–384), introduce `toolEndedAt`:

The error branch (replacing the existing `emit` for the error case):

```ts
  if ("error" in result) {
    const err = result.error;
    const toolEndedAt = Date.now();
    emit({
      type: "tool:end",
      runId,
      toolUseId,
      error: err,
      metadata: result.metadata,
      startedAt: toolStartedAt,
      endedAt: toolEndedAt,
      elapsedMs: toolEndedAt - toolStartedAt,
      display: resolveToolDisplay(tool, parsedArgs, (d) => d.error?.(parsedArgs, err, result.metadata)),
    });
    return buildToolErrorMessage(toolCall.id, err);
  }
```

The success branch (replacing the existing `emit` for the success case):

```ts
  const out = result.content;
  const toolEndedAt = Date.now();
  emit({
    type: "tool:end",
    runId,
    toolUseId,
    output: out,
    metadata: result.metadata,
    startedAt: toolStartedAt,
    endedAt: toolEndedAt,
    elapsedMs: toolEndedAt - toolStartedAt,
    display: resolveToolDisplay(tool, parsedArgs, (d) => d.success?.(parsedArgs, out, result.metadata)),
  });
  return buildToolResultMessage(toolCall.id, out);
```

- [ ] **Step 5: Run typecheck.**

Run: `npm run typecheck`
Expected: PASS. (`tool:progress` is never emitted by `runLoop` itself, so no further changes are needed here — the type still requires `startedAt` for any tool that manually emits one via `deps.emit`. That is intentional.)

- [ ] **Step 6: Run existing tests — expect them to still pass.**

Run: `npm test`
Expected: existing assertions all PASS. `tests/agent/events.test.ts` will fail because `defaultDisplay` end-event titles change in Task 4 — but at this point those tests still expect the old titles and pass because we haven't touched `defaultDisplay` yet. The `tests/agent/loop.test.ts` will pass because nothing there asserts timing yet.

If any test fails for reasons OTHER than display-title changes, fix the cause before continuing.

- [ ] **Step 7: Commit.**

```bash
git add src/agent/loop.ts
git commit -m "feat(loop): stamp startedAt/endedAt/elapsedMs on lifecycle events"
```

---

## Task 3: Pin timing behavior with tests

**Files:**
- Modify: `tests/agent/loop.test.ts`

- [ ] **Step 1: Append a top-level timing test block.**

Append the following at the end of `tests/agent/loop.test.ts`, inside the existing `describe("runLoop", () => { ... })` block (just before the closing `})` of that describe):

```ts
  test("agent:start and agent:end carry timing fields", async () => {
    const events: AgentEvent[] = [];
    const cfg = mkConfig();
    const before = Date.now();
    await runLoop(cfg, "hi", {}, collect(events));
    const after = Date.now();

    const start = events.find((e) => e.type === "agent:start");
    const end = events.find((e) => e.type === "agent:end");
    expect(start?.type).toBe("agent:start");
    expect(end?.type).toBe("agent:end");
    if (start?.type === "agent:start") {
      expect(start.startedAt).toBeGreaterThanOrEqual(before);
      expect(start.startedAt).toBeLessThanOrEqual(after);
    }
    if (end?.type === "agent:end") {
      expect(end.endedAt).toBeGreaterThanOrEqual(end.startedAt);
      expect(end.elapsedMs).toBe(end.endedAt - end.startedAt);
      expect(end.endedAt).toBeLessThanOrEqual(after);
    }
    if (start?.type === "agent:start" && end?.type === "agent:end") {
      expect(start.startedAt).toBe(end.startedAt);
    }
  });

  test("tool:start and tool:end carry timing fields", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => `ECHO:${args.text}`,
    });
    const client = {
      completeStream: vi.fn()
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            id: "gen-1",
            finish_reason: "tool_calls",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) },
              },
            ],
          }))
        )
        .mockImplementationOnce(() =>
          mockStream(mockChunks({ id: "gen-2", content: "final" }))
        ),
    };
    const cfg = mkConfig({ tools: [tool], openrouter: client as any });

    await runLoop(cfg, "please echo", {}, collect(events));

    const toolStart = events.find((e) => e.type === "tool:start");
    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolStart?.type).toBe("tool:start");
    expect(toolEnd?.type).toBe("tool:end");
    if (toolStart?.type === "tool:start" && toolEnd?.type === "tool:end") {
      expect(toolEnd.startedAt).toBe(toolStart.startedAt);
      expect(toolEnd.endedAt).toBeGreaterThanOrEqual(toolEnd.startedAt);
      expect(toolEnd.elapsedMs).toBe(toolEnd.endedAt - toolEnd.startedAt);
    }
  });

  test("tool:end on error carries timing fields", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "boom",
      description: "fails",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("nope");
      },
    });
    const client = {
      completeStream: vi.fn()
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            id: "gen-1",
            finish_reason: "tool_calls",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "boom", arguments: "{}" },
              },
            ],
          }))
        )
        .mockImplementationOnce(() =>
          mockStream(mockChunks({ id: "gen-2", content: "ok" }))
        ),
    };
    const cfg = mkConfig({ tools: [tool], openrouter: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolEnd?.type).toBe("tool:end");
    if (toolEnd?.type === "tool:end") {
      expect("error" in toolEnd).toBe(true);
      expect(toolEnd.endedAt).toBeGreaterThanOrEqual(toolEnd.startedAt);
      expect(toolEnd.elapsedMs).toBe(toolEnd.endedAt - toolEnd.startedAt);
    }
  });
```

- [ ] **Step 2: Run the new tests.**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: PASS for the three new tests; existing tests still PASS.

- [ ] **Step 3: Commit.**

```bash
git add tests/agent/loop.test.ts
git commit -m "test(loop): pin timing fields on lifecycle events"
```

---

## Task 4: Update `defaultDisplay` end-event titles

**Files:**
- Modify: `src/agent/events.ts`
- Modify: `tests/agent/events.test.ts`

- [ ] **Step 1: Update existing tests to expect the new titles.**

In `tests/agent/events.test.ts`, replace the `tool:end shows success or failure` test body (currently lines 25–40) with:

```ts
  test("tool:end shows success or failure with elapsed", () => {
    const ok: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      output: "result",
      startedAt: 1000,
      endedAt: 3500,
      elapsedMs: 2500,
    };
    expect(defaultDisplay(ok).title).toBe("Completed tool in 3s");
    const err: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      error: "something broke",
      startedAt: 1000,
      endedAt: 4200,
      elapsedMs: 3200,
    };
    expect(defaultDisplay(err).title).toBe("Tool failed after 3s");
  });
```

And replace the `agent:end title is Done` test (currently lines 42–55) with:

```ts
  test("agent:end title shows elapsed seconds", () => {
    const ok: AgentEvent = {
      type: "agent:end",
      runId: "r1",
      result: {
        text: "",
        messages: [],
        stopReason: "done",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        generationIds: [],
      },
      startedAt: 0,
      endedAt: 5000,
      elapsedMs: 5000,
    };
    expect(defaultDisplay(ok).title).toBe("Completed in 5s");

    const err: AgentEvent = {
      type: "agent:end",
      runId: "r1",
      result: {
        text: "",
        messages: [],
        stopReason: "error",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        generationIds: [],
        error: { message: "boom" },
      },
      startedAt: 0,
      endedAt: 1500,
      elapsedMs: 1500,
    };
    expect(defaultDisplay(err).title).toBe("Completed with errors in 2s");
  });
```

Update the existing `agent:start uses agentName` test (currently lines 5–12) to include the now-required `startedAt` field:

```ts
  test("agent:start uses agentName", () => {
    const ev: AgentEvent = {
      type: "agent:start",
      runId: "r1",
      agentName: "research",
      startedAt: 0,
    };
    expect(defaultDisplay(ev).title).toBe("Starting research");
  });
```

Update the existing `tool:start uses toolName` test (currently lines 14–23) similarly:

```ts
  test("tool:start uses toolName", () => {
    const ev: AgentEvent = {
      type: "tool:start",
      runId: "r1",
      toolUseId: "t1",
      toolName: "web_search",
      input: { queries: ["foo"] },
      startedAt: 0,
    };
    expect(defaultDisplay(ev).title).toBe("Running web_search");
  });
```

- [ ] **Step 2: Run the tests — expect failures.**

Run: `npm test -- tests/agent/events.test.ts`
Expected: FAIL for the two updated tests with messages like
- `expected "Completed tool in 3s" to be "Completed tool"`
- `expected "Completed in 5s" to be "Done"`

- [ ] **Step 3: Update `defaultDisplay` to render elapsed seconds.**

In `src/agent/events.ts`, replace the entire body of `defaultDisplay` (currently lines ~235–254) with:

```ts
export function defaultDisplay(event: AgentEvent): EventDisplay {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end": {
      const seconds = Math.max(1, Math.round(event.elapsedMs / 1000));
      const errored = event.result.stopReason === "error";
      return {
        title: errored
          ? `Completed with errors in ${seconds}s`
          : `Completed in ${seconds}s`,
      };
    }
    case "message:delta":
      return { title: "Message delta" };
    case "message":
      return { title: "Message" };
    case "tool:start":
      return { title: `Running ${event.toolName}` };
    case "tool:progress":
      return { title: `Still running (${Math.round(event.elapsedMs / 1000)}s)` };
    case "tool:end": {
      const seconds = Math.max(1, Math.round(event.elapsedMs / 1000));
      return {
        title: "error" in event ? `Tool failed after ${seconds}s` : `Completed tool in ${seconds}s`,
      };
    }
    case "error":
      return { title: "Error", content: event.error.message };
  }
}
```

- [ ] **Step 4: Run the tests — expect them to pass.**

Run: `npm test -- tests/agent/events.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run the full suite.**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/agent/events.ts tests/agent/events.test.ts
git commit -m "feat(events): render elapsed seconds in defaultDisplay end titles"
```

---

## Task 5: Add `displayOf` helper

**Files:**
- Create: `src/agent/displayOf.ts`
- Create: `tests/agent/displayOf.test.ts`
- Modify: `src/agent/index.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/agent/displayOf.test.ts` with the following content:

```ts
import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { displayOf } from "../../src/agent/displayOf.js";

describe("displayOf", () => {
  test("returns the explicit display when present", () => {
    const ev: AgentEvent = {
      type: "tool:start",
      runId: "r1",
      toolUseId: "t1",
      toolName: "calc",
      input: {},
      startedAt: 0,
      display: { title: "Calculating" },
    };
    expect(displayOf(ev)).toEqual({ title: "Calculating" });
  });

  test("falls back to defaultDisplay when display is absent", () => {
    const ev: AgentEvent = {
      type: "tool:start",
      runId: "r1",
      toolUseId: "t1",
      toolName: "calc",
      input: {},
      startedAt: 0,
    };
    expect(displayOf(ev)).toEqual({ title: "Running calc" });
  });

  test("falls back for end events using elapsed", () => {
    const ev: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      output: "ok",
      startedAt: 0,
      endedAt: 2000,
      elapsedMs: 2000,
    };
    expect(displayOf(ev).title).toBe("Completed tool in 2s");
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail to compile.**

Run: `npm test -- tests/agent/displayOf.test.ts`
Expected: FAIL — module `../../src/agent/displayOf.js` does not exist.

- [ ] **Step 3: Create the implementation.**

Create `src/agent/displayOf.ts` with the following content:

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
import type { AgentEvent, EventDisplay } from "./events.js";
import { defaultDisplay } from "./events.js";

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
 * for await (const event of agent.runStream("hello")) {
 *   const { title, content } = displayOf(event);
 *   console.log(title);
 * }
 * ```
 */
export function displayOf(event: AgentEvent): EventDisplay {
  return event.display ?? defaultDisplay(event);
}
```

- [ ] **Step 4: Re-export from the agent module.**

In `src/agent/index.ts`, add after the existing `export { defaultDisplay } from "./events.js";` line:

```ts
export { displayOf } from "./displayOf.js";
```

- [ ] **Step 5: Run the test — expect it to pass.**

Run: `npm test -- tests/agent/displayOf.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/agent/displayOf.ts src/agent/index.ts tests/agent/displayOf.test.ts
git commit -m "feat(agent): add displayOf helper that pairs event.display with defaultDisplay fallback"
```

---

## Task 6: Add `consumeAgentEvents` helper

**Files:**
- Create: `src/agent/consumeEvents.ts`
- Create: `tests/agent/consumeEvents.test.ts`
- Modify: `src/agent/index.ts`

- [ ] **Step 1: Write the failing test file.**

Create `tests/agent/consumeEvents.test.ts` with the following content:

```ts
import { describe, test, expect, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { consumeAgentEvents } from "../../src/agent/consumeEvents.js";

function asyncIter(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

const sampleEvents: AgentEvent[] = [
  { type: "agent:start", runId: "r1", agentName: "a", startedAt: 0 },
  { type: "tool:start", runId: "r1", toolUseId: "t1", toolName: "calc", input: {}, startedAt: 1 },
  {
    type: "tool:end",
    runId: "r1",
    toolUseId: "t1",
    output: "ok",
    startedAt: 1,
    endedAt: 2,
    elapsedMs: 1,
  },
  {
    type: "agent:end",
    runId: "r1",
    result: {
      text: "",
      messages: [],
      stopReason: "done",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      generationIds: [],
    },
    startedAt: 0,
    endedAt: 3,
    elapsedMs: 3,
  },
];

describe("consumeAgentEvents", () => {
  test("dispatches each event to its typed handler", async () => {
    const onAgentStart = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const onAgentEnd = vi.fn();

    await consumeAgentEvents(asyncIter(sampleEvents), {
      onAgentStart,
      onToolStart,
      onToolEnd,
      onAgentEnd,
    });

    expect(onAgentStart).toHaveBeenCalledTimes(1);
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(onAgentStart.mock.calls[0][0].type).toBe("agent:start");
    expect(onToolEnd.mock.calls[0][0].type).toBe("tool:end");
  });

  test("missing handlers are silently skipped", async () => {
    const onAgentEnd = vi.fn();
    await consumeAgentEvents(asyncIter(sampleEvents), { onAgentEnd });
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
  });

  test("onAny runs after the typed handler for every event", async () => {
    const order: string[] = [];
    const onToolStart = vi.fn(() => {
      order.push("typed:tool:start");
    });
    const onAny = vi.fn((e: AgentEvent) => {
      order.push(`any:${e.type}`);
    });

    await consumeAgentEvents(asyncIter(sampleEvents), { onToolStart, onAny });

    expect(onAny).toHaveBeenCalledTimes(sampleEvents.length);
    expect(order).toEqual([
      "any:agent:start",
      "typed:tool:start",
      "any:tool:start",
      "any:tool:end",
      "any:agent:end",
    ]);
  });

  test("awaits async handlers before pulling the next event", async () => {
    const seen: string[] = [];
    let resolveFirst: (() => void) | null = null;

    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "a", startedAt: 0 },
      {
        type: "agent:end",
        runId: "r1",
        result: {
          text: "",
          messages: [],
          stopReason: "done",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          generationIds: [],
        },
        startedAt: 0,
        endedAt: 1,
        elapsedMs: 1,
      },
    ];

    const promise = consumeAgentEvents(asyncIter(events), {
      onAgentStart: () =>
        new Promise<void>((r) => {
          resolveFirst = () => {
            seen.push("agent:start:done");
            r();
          };
        }),
      onAgentEnd: () => {
        seen.push("agent:end:start");
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([]);
    resolveFirst!();
    await promise;
    expect(seen).toEqual(["agent:start:done", "agent:end:start"]);
  });

  test("handler throws are propagated as the consumer's rejection", async () => {
    const err = new Error("boom");
    await expect(
      consumeAgentEvents(asyncIter(sampleEvents), {
        onAgentStart: () => {
          throw err;
        },
      })
    ).rejects.toBe(err);
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail.**

Run: `npm test -- tests/agent/consumeEvents.test.ts`
Expected: FAIL — module `../../src/agent/consumeEvents.js` does not exist.

- [ ] **Step 3: Create the implementation.**

Create `src/agent/consumeEvents.ts` with the following content:

```ts
/**
 * `consumeAgentEvents` — typed dispatcher over an `AsyncIterable<AgentEvent>`.
 *
 * Removes the per-consumer `switch (event.type)` boilerplate and gives each
 * handler a fully-narrowed event parameter. Pairs naturally with
 * {@link displayOf} for UI rendering.
 */
import type { AgentEvent } from "./events.js";

/**
 * Per-variant typed handlers. Every handler is optional — events with no
 * matching handler are silently skipped. {@link AgentEventHandlers.onAny}
 * runs after the matching typed handler for every event.
 *
 * Handlers may be sync or async; consumers preserve back-pressure because
 * each handler is awaited before the next event is pulled from the source.
 * A throw from any handler propagates as the rejection of
 * {@link consumeAgentEvents}.
 */
export interface AgentEventHandlers {
  /** Called once at the start of a run. */
  onAgentStart?: (e: Extract<AgentEvent, { type: "agent:start" }>) => void | Promise<void>;
  /** Called once at the end of a run with the final {@link Result}. */
  onAgentEnd?: (e: Extract<AgentEvent, { type: "agent:end" }>) => void | Promise<void>;
  /** Called once per assistant message (including tool-call messages). */
  onMessage?: (e: Extract<AgentEvent, { type: "message" }>) => void | Promise<void>;
  /** Called for each streamed text delta from the assistant. */
  onMessageDelta?: (e: Extract<AgentEvent, { type: "message:delta" }>) => void | Promise<void>;
  /** Called once when a tool invocation begins. */
  onToolStart?: (e: Extract<AgentEvent, { type: "tool:start" }>) => void | Promise<void>;
  /** Called when a tool emits a manual progress signal via `deps.emit`. */
  onToolProgress?: (e: Extract<AgentEvent, { type: "tool:progress" }>) => void | Promise<void>;
  /** Called once when a tool invocation ends (success or failure). */
  onToolEnd?: (e: Extract<AgentEvent, { type: "tool:end" }>) => void | Promise<void>;
  /** Called once at most per run, immediately before a terminal `agent:end` with `stopReason: "error"`. */
  onError?: (e: Extract<AgentEvent, { type: "error" }>) => void | Promise<void>;
  /**
   * Catch-all. Runs AFTER any matching typed handler. Useful for logging or
   * telemetry that should observe every event without enumerating variants.
   */
  onAny?: (e: AgentEvent) => void | Promise<void>;
}

/**
 * Consume an agent event stream, dispatching to typed handlers.
 *
 * @param source Any `AsyncIterable<AgentEvent>` — typically the return value
 *   of `agent.runStream(...)`, an HTTP NDJSON parse loop, or a buffered
 *   replay.
 * @param handlers Optional per-variant handlers plus an optional `onAny`.
 * @returns A promise that resolves once `source` completes normally and
 *   every handler has finished. Rejects if any handler throws or if the
 *   source itself throws.
 *
 * @example
 * ```ts
 * await consumeAgentEvents(agent.runStream("hello"), {
 *   onAgentStart: () => console.log("Thinking…"),
 *   onToolStart:  (e) => console.log("→", e.toolName),
 *   onToolEnd:    (e) => console.log("✓", e.elapsedMs, "ms"),
 *   onAgentEnd:   (e) => console.log("done in", e.elapsedMs, "ms"),
 * });
 * ```
 */
export async function consumeAgentEvents(
  source: AsyncIterable<AgentEvent>,
  handlers: AgentEventHandlers,
): Promise<void> {
  for await (const event of source) {
    switch (event.type) {
      case "agent:start":
        if (handlers.onAgentStart) await handlers.onAgentStart(event);
        break;
      case "agent:end":
        if (handlers.onAgentEnd) await handlers.onAgentEnd(event);
        break;
      case "message":
        if (handlers.onMessage) await handlers.onMessage(event);
        break;
      case "message:delta":
        if (handlers.onMessageDelta) await handlers.onMessageDelta(event);
        break;
      case "tool:start":
        if (handlers.onToolStart) await handlers.onToolStart(event);
        break;
      case "tool:progress":
        if (handlers.onToolProgress) await handlers.onToolProgress(event);
        break;
      case "tool:end":
        if (handlers.onToolEnd) await handlers.onToolEnd(event);
        break;
      case "error":
        if (handlers.onError) await handlers.onError(event);
        break;
    }
    if (handlers.onAny) await handlers.onAny(event);
  }
}
```

- [ ] **Step 4: Re-export from the agent module.**

In `src/agent/index.ts`, add after the `displayOf` line you added in Task 5:

```ts
export { consumeAgentEvents } from "./consumeEvents.js";
export type { AgentEventHandlers } from "./consumeEvents.js";
```

- [ ] **Step 5: Run the test — expect it to pass.**

Run: `npm test -- tests/agent/consumeEvents.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/agent/consumeEvents.ts src/agent/index.ts tests/agent/consumeEvents.test.ts
git commit -m "feat(agent): add typed consumeAgentEvents dispatcher"
```

---

## Task 7: Re-export new helpers from the package root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the two new exports.**

In `src/index.ts`, find the existing `export { defaultDisplay } from "./agent/index.js";` line. Replace it with:

```ts
export { defaultDisplay, displayOf, consumeAgentEvents } from "./agent/index.js";
export type { AgentEventHandlers } from "./agent/index.js";
```

- [ ] **Step 2: Update the package-level JSDoc to mention them.**

In `src/index.ts`, in the `@packageDocumentation` block (currently around line 22), find the bullet that reads:

```
 * - **Agent layer** — {@link Agent}, its config/options ({@link AgentConfig},
 *   {@link AgentRunOptions}), and the event vocabulary
 *   ({@link AgentEvent}, {@link AgentDisplayHooks}, {@link EventDisplay},
 *   {@link EventEmit}, {@link defaultDisplay}).
```

Replace it with:

```
 * - **Agent layer** — {@link Agent}, its config/options ({@link AgentConfig},
 *   {@link AgentRunOptions}), the event vocabulary
 *   ({@link AgentEvent}, {@link AgentDisplayHooks}, {@link EventDisplay},
 *   {@link EventEmit}, {@link defaultDisplay}), and the event-consumer
 *   helpers ({@link consumeAgentEvents}, {@link AgentEventHandlers},
 *   {@link displayOf}).
```

- [ ] **Step 3: Run typecheck and tests.**

Run: `npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/index.ts
git commit -m "feat: re-export displayOf and consumeAgentEvents from package root"
```

---

## Task 8: Adopt new fields in the demo frontend

**Files:**
- Modify: `examples/demo/public/chat.js`

- [ ] **Step 1: Replace the local `displayOf` with a corrected inline version that delegates to a vanilla `defaultDisplay`.**

In `examples/demo/public/chat.js`, replace this block (currently around line 124):

```js
function displayOf(event) {
  return event.display ?? null;
}
```

with:

```js
// Vanilla mirror of the SDK's defaultDisplay/displayOf. Inlined so the demo
// stays bundler-free; keep in sync with `src/agent/events.ts` if titles change.
function defaultDisplay(event) {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end": {
      const seconds = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
      const errored = event.result?.stopReason === "error";
      return {
        title: errored
          ? `Completed with errors in ${seconds}s`
          : `Completed in ${seconds}s`,
      };
    }
    case "message:delta":
      return { title: "Message delta" };
    case "message":
      return { title: "Message" };
    case "tool:start":
      return { title: `Running ${event.toolName}` };
    case "tool:progress":
      return { title: `Still running (${Math.round((event.elapsedMs ?? 0) / 1000)}s)` };
    case "tool:end": {
      const seconds = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
      return {
        title: "error" in event ? `Tool failed after ${seconds}s` : `Completed tool in ${seconds}s`,
      };
    }
    case "error":
      return { title: "Error", content: event.error?.message };
    default:
      return { title: event.type };
  }
}

function displayOf(event) {
  return event.display ?? defaultDisplay(event);
}
```

- [ ] **Step 2: Drop the client-side timing bookkeeping.**

In `examples/demo/public/chat.js`, find and remove this block (currently around lines 137–142):

```js
  // One activity card per request; `phases` is the ordered list of tool
  // invocations (and future agent phases) so we can render them as a
  // timeline inside a single card. `agentStartedAt` is captured on
  // agent:start so we can render "Thought for Xs" when the run finishes
  // with no tool calls.
  let activityCard = null;
  let agentStartedAt = null;
```

Replace with:

```js
  // One activity card per request; `phases` is the ordered list of tool
  // invocations so we can render them as a timeline inside a single card.
  let activityCard = null;
```

Then in the `agent:start` case (currently around lines 196–206), remove the `agentStartedAt` assignment. The case becomes:

```js
      case "agent:start": {
        // Open the per-turn activity card up front so the user sees an
        // immediate "Thinking" indicator while we wait for the first model
        // response. Tool events below replace the title/content live; the
        // final timeline (or "Completed in Xs" if no tools ran) is rendered
        // on agent:end.
        if (!activityCard) {
          activityCard = addToolCard(null, "Thinking", undefined);
        }
        break;
      }
```

In the `agent:end` case (currently around lines 273–292), replace the elapsed math with `event.elapsedMs`. The block that currently reads:

```js
        if (activityCard) {
          const elapsedMs = agentStartedAt ? Date.now() - agentStartedAt : 0;
          const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
          const hasError = phases.some((p) => p.error);
          const title = hasError
            ? `Completed with errors in ${elapsedSec}s`
            : `Completed in ${elapsedSec}s`;
          setActivityTitle(activityCard, title);
          if (phases.length === 0) {
            setActivityContent(activityCard, undefined);
            activityCard.classList.add("done");
          } else {
            renderTimeline(activityCard, phases);
          }
        }
```

becomes:

```js
        if (activityCard) {
          const elapsedSec = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
          const hasError = phases.some((p) => p.error);
          const title = hasError
            ? `Completed with errors in ${elapsedSec}s`
            : `Completed in ${elapsedSec}s`;
          setActivityTitle(activityCard, title);
          if (phases.length === 0) {
            setActivityContent(activityCard, undefined);
            activityCard.classList.add("done");
          } else {
            renderTimeline(activityCard, phases);
          }
        }
```

- [ ] **Step 3: Smoke-test the demo by inspection.**

Read the modified `examples/demo/public/chat.js` end-to-end. Confirm:
- No remaining references to `agentStartedAt`.
- `defaultDisplay` and `displayOf` are both defined exactly once.
- The `agent:end` case reads `event.elapsedMs`, not `Date.now() - agentStartedAt`.

(There are no Vitest tests for the static frontend; the source review is the verification step.)

- [ ] **Step 4: Commit.**

```bash
git add examples/demo/public/chat.js
git commit -m "feat(demo): render Completed-in-Xs from event.elapsedMs and inline corrected displayOf"
```

---

## Task 9: Note the new field in the demo's agent-wiring JSDoc

**Files:**
- Modify: `examples/demo/agent.ts`

- [ ] **Step 1: Add a one-line JSDoc nudge.**

In `examples/demo/agent.ts`, find the JSDoc block above `export const agent = new Agent({` (currently around lines 158–164). It begins:

```ts
/**
 * The demo assistant.
 *
 * Combines the OpenRouter client (registered above), the three tools, and
 * {@link sessionStore}. The client is picked up implicitly from
 * `setOpenRouterClient` — it is not passed in here.
 */
```

Replace with:

```ts
/**
 * The demo assistant.
 *
 * Combines the OpenRouter client (registered above), the three tools, and
 * {@link sessionStore}. The client is picked up implicitly from
 * `setOpenRouterClient` — it is not passed in here.
 *
 * Lifecycle events emitted by the run carry server-stamped timing
 * (`startedAt` / `endedAt` / `elapsedMs`), which `examples/demo/public/chat.js`
 * uses to render "Completed in Xs" on the activity card.
 */
```

- [ ] **Step 2: Run typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add examples/demo/agent.ts
git commit -m "docs(demo): note that lifecycle events carry server-stamped timing"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run the full pipeline.**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 2: Verify the demo runs end-to-end (manual).**

Run (in a separate terminal):

```bash
OPENROUTER_API_KEY=... node --experimental-strip-types examples/demo/server.ts
```

(The exact runner may already be wired up via `package.json`. If `npm run` has a demo script, use that.)

Open `http://localhost:3000`. Send a tool-using message ("what's 347*29?") and a tool-less message ("hi"). Confirm:
- The activity card shows "Thinking" while waiting.
- During tool calls, the card shows the per-tool title.
- On completion with tools, the title reads "Completed in Xs" and the timeline lists each tool.
- On completion without tools, the title reads "Completed in Xs" with no timeline content.

- [ ] **Step 3: Confirm no follow-up commit needed.**

Run: `git status`
Expected: clean working tree (all task commits already pushed locally).

---

## Self-review notes

**Spec coverage:**
- § 1 (timing fields) — Tasks 1, 2, 3, 4 cover types, emit sites, behavior tests, and `defaultDisplay` updates.
- § 2 (`consumeAgentEvents`) — Task 6 covers handlers interface, dispatch, `onAny`, async back-pressure, error propagation.
- § 3 (`displayOf`) — Task 5 covers the helper and tests.
- § 4 (files touched) — every file listed in the spec is touched in this plan; the demo updates land in Tasks 8 and 9; package-root re-exports land in Task 7.
- Acceptance criteria 1 & 2 covered by Task 10 step 1; criterion 3 by Task 10 step 2; criterion 4 by Task 7 step 2.

**Type consistency:** `consumeAgentEvents`, `AgentEventHandlers`, `displayOf`, and the new `startedAt` / `endedAt` / `elapsedMs` field names are used identically across all tasks.

**No placeholders:** every step shows the actual code or command. Manual smoke test (Task 10 step 2) is the one place we rely on the engineer's eyes — that is unavoidable for a frontend demo and the verification questions are explicit.
