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
        toolName: "calc",
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
