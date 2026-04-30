import { describe, test, expect } from "vitest";
import { AgentRun } from "../../src/agent/AgentRun.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { Result } from "../../src/types/index.js";

function mkResult(overrides: Partial<Result> = {}): Result {
  return {
    content: "ok",
    messages: [],
    stopReason: "done",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    generationIds: [],
    ...overrides,
  };
}

function runWithEvents(events: AgentEvent[]): AgentRun {
  return new AgentRun(async (emit) => {
    for (const e of events) {
      await Promise.resolve();
      emit(e);
    }
  });
}

describe("AgentRun", () => {
  test("await resolves with the Result from agent:end", async () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult({ content: "hi" }) },
    ]);
    const result = await run;
    expect(result.content).toBe("hi");
  });

  test("iteration yields every event in order", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "message:delta", runId: "r1", content: "he" },
      { type: "message:delta", runId: "r1", content: "llo" },
      { type: "agent:end", runId: "r1", result: mkResult({ content: "hello" }) },
    ];
    const run = runWithEvents(events);
    const seen: AgentEvent[] = [];
    for await (const ev of run) seen.push(ev);
    expect(seen.map((e) => e.type)).toEqual([
      "agent:start",
      "message:delta",
      "message:delta",
      "agent:end",
    ]);
  });

  test("iterate + await same handle returns the same result", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult({ content: "x" }) },
    ];
    const run = runWithEvents(events);
    const seen: AgentEvent[] = [];
    for await (const ev of run) seen.push(ev);
    const result = await run;
    expect(result.content).toBe("x");
    expect(seen.length).toBe(2);
  });

  test("awaiting .result twice returns the memoized Result", async () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult({ content: "y" }) },
    ]);
    const a = await run.result;
    const b = await run.result;
    expect(a).toBe(b);
  });

  test("second [Symbol.asyncIterator]() call throws", () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult() },
    ]);
    run[Symbol.asyncIterator]();
    expect(() => run[Symbol.asyncIterator]()).toThrow(/already/i);
  });

  test("events emitted synchronously before iterator attach are buffered", async () => {
    const run = new AgentRun(async (emit) => {
      emit({ type: "agent:start", runId: "r1", agentName: "a" });
      emit({ type: "message:delta", runId: "r1", content: "a" });
      emit({ type: "message:delta", runId: "r1", content: "b" });
      emit({ type: "agent:end", runId: "r1", result: mkResult({ content: "ab" }) });
    });
    await Promise.resolve();
    const seen: AgentEvent[] = [];
    for await (const ev of run) seen.push(ev);
    expect(seen.length).toBe(4);
  });

  test("loop error rejects result and iteration", async () => {
    const run = new AgentRun(async (emit) => {
      emit({ type: "agent:start", runId: "r1", agentName: "a" });
      throw new Error("kaboom");
    });
    await expect(run.result).rejects.toThrow("kaboom");
    const run2 = new AgentRun(async (emit) => {
      emit({ type: "agent:start", runId: "r1", agentName: "a" });
      throw new Error("kaboom");
    });
    await expect(async () => {
      for await (const _ of run2) void _;
    }).rejects.toThrow("kaboom");
  });

  test("filters agent:end by outer runId (subagent bubbling)", async () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "outer", agentName: "a" },
      { type: "agent:start", runId: "inner", parentRunId: "outer", agentName: "sub" },
      { type: "agent:end", runId: "inner", result: mkResult({ content: "SUB" }) },
      { type: "agent:end", runId: "outer", result: mkResult({ content: "TOP" }) },
    ]);
    const result = await run;
    expect(result.content).toBe("TOP");
  });
});
