import { describe, test, expect } from "vitest";
import { defaultDisplay, type AgentEvent } from "../../src/agent/events.js";

describe("defaultDisplay", () => {
  test("agent:start uses agentName", () => {
    const ev: AgentEvent = {
      type: "agent:start",
      runId: "r1",
      agentName: "research",
    };
    expect(defaultDisplay(ev).title).toBe("Starting research");
  });

  test("tool:start uses toolName", () => {
    const ev: AgentEvent = {
      type: "tool:start",
      runId: "r1",
      toolUseId: "t1",
      toolName: "web_search",
      input: { queries: ["foo"] },
    };
    expect(defaultDisplay(ev).title).toBe("Running web_search");
  });

  test("tool:end shows success or failure", () => {
    const ok: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      output: "result",
    };
    expect(defaultDisplay(ok).title).toBe("Completed tool");
    const err: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      error: "something broke",
    };
    expect(defaultDisplay(err).title).toBe("Tool failed");
  });

  test("agent:end title is Done", () => {
    const ev: AgentEvent = {
      type: "agent:end",
      runId: "r1",
      result: {
        text: "",
        messages: [],
        stopReason: "done",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        generationIds: [],
      },
    };
    expect(defaultDisplay(ev).title).toBe("Done");
  });

  test("error includes the error message", () => {
    const ev: AgentEvent = {
      type: "error",
      runId: "r1",
      error: { message: "rate limited" },
    };
    expect(defaultDisplay(ev).title).toBe("Error");
    expect(defaultDisplay(ev).content).toBe("rate limited");
  });
});
