import { describe, test, expect } from "vitest";
import { defaultDisplay, type AgentEvent } from "../../src/agent/events.js";

describe("defaultDisplay", () => {
  test("agent:start uses agentName", () => {
    const ev: AgentEvent = {
      type: "agent:start",
      runId: "r1",
      agentName: "research",
      startedAt: 0,
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
      startedAt: 0,
    };
    expect(defaultDisplay(ev).title).toBe("Running web_search");
  });

  test("tool:end shows success or failure with elapsed", () => {
    const ok: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      toolName: "web_search",
      content: "result",
      startedAt: 1000,
      endedAt: 3500,
      elapsedMs: 2500,
    };
    expect(defaultDisplay(ok).title).toBe("Completed web_search in 3s");
    const err: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      toolName: "web_search",
      error: "something broke",
      startedAt: 1000,
      endedAt: 4200,
      elapsedMs: 3200,
    };
    expect(defaultDisplay(err).title).toBe("web_search failed after 3s");
  });

  test("agent:end title shows elapsed seconds", () => {
    const ok: AgentEvent = {
      type: "agent:end",
      runId: "r1",
      result: {
        content: "",
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
        content: "",
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

  test("error includes the error message", () => {
    const ev: AgentEvent = {
      type: "error",
      runId: "r1",
      error: { message: "rate limited" },
    };
    expect(defaultDisplay(ev).title).toBe("Error");
    expect(defaultDisplay(ev).content).toBe("rate limited");
  });

  test("message:preamble has a default title", () => {
    const ev: AgentEvent = {
      type: "message:preamble",
      runId: "r1",
      message: { role: "assistant", content: "I'll look that up.", tool_calls: [] },
    };
    expect(defaultDisplay(ev).title).toBe("Preamble");
  });
});

describe("defaultDisplay — retry variant", () => {
  test("renders attempt and delay", () => {
    const display = defaultDisplay({
      type: "retry",
      runId: "run-1",
      turn: 0,
      attempt: 2,
      delayMs: 1500,
      error: { message: "ECONNRESET" },
    });
    expect(display.title).toMatch(/Retrying/);
    expect(display.title).toMatch(/2/);
  });
});
