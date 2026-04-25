import { describe, test, expect, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { consumeAgentEvents } from "../../src/helpers/consumeEvents.js";

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
