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
