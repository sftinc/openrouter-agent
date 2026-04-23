import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { runLoop, type RunLoopConfig } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { Tool } from "../../src/tool/Tool.js";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { CompletionsResponse } from "../../src/openrouter/index.js";

function mockResponse(partial: Partial<CompletionsResponse> & { message: { content: string | null; tool_calls?: unknown[] }; finish_reason?: string }): CompletionsResponse {
  return {
    id: partial.id ?? "gen-1",
    object: "chat.completion",
    created: 1704067200,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        message: {
          role: "assistant",
          content: partial.message.content,
          tool_calls: partial.message.tool_calls as any,
        },
      },
    ],
    usage: partial.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mkConfig(overrides: Partial<RunLoopConfig> = {}): RunLoopConfig {
  const client = {
    complete: vi.fn().mockResolvedValue(
      mockResponse({ message: { content: "hello" } })
    ),
  };
  return {
    agentName: "test-agent",
    systemPrompt: "you are helpful",
    llm: { model: "anthropic/claude-haiku-4.5" },
    tools: [],
    maxTurns: 10,
    client: client as any,
    ...overrides,
  };
}

function collect(events: AgentEvent[]): (ev: AgentEvent) => void {
  return (ev) => { events.push(ev); };
}

describe("runLoop", () => {
  test("single-turn no-tool run returns done", async () => {
    const events: AgentEvent[] = [];
    const cfg = mkConfig();

    await runLoop(cfg, "hi", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    expect(end?.type).toBe("agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("done");
      expect(end.result.text).toBe("hello");
      expect(end.result.usage.total_tokens).toBe(15);
      expect(end.result.generationIds).toEqual(["gen-1"]);
    }
  });

  test("tool_calls are dispatched and results fed back", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => `ECHO:${args.text}`,
    });
    const client = {
      complete: vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            id: "gen-1",
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) },
                },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          mockResponse({ id: "gen-2", message: { content: "final" } })
        ),
    };
    const cfg = mkConfig({ tools: [tool], client: client as any });

    await runLoop(cfg, "please echo", {}, collect(events));

    expect(client.complete).toHaveBeenCalledTimes(2);
    const second = client.complete.mock.calls[1][0];
    const toolMsg = (second.messages as any[]).find((m) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call-1");
    expect(toolMsg.content).toBe("ECHO:hi");

    const toolStart = events.find((e) => e.type === "tool:start");
    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool:end") {
      expect(toolEnd.isError).toBe(false);
      expect(toolEnd.output).toBe("ECHO:hi");
    }
  });

  test("tool handler errors feed 'Error: ...' to model with isError=true and loop continues", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "crash",
      description: "always fails",
      inputSchema: z.object({}),
      execute: async () => { throw new Error("boom"); },
    });
    const client = {
      complete: vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "c", type: "function", function: { name: "crash", arguments: "{}" } },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          mockResponse({ message: { content: "recovered" } })
        ),
    };
    const cfg = mkConfig({ tools: [tool], client: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const toolEnd = events.find((e) => e.type === "tool:end");
    if (toolEnd?.type === "tool:end") {
      expect(toolEnd.isError).toBe(true);
      expect(String(toolEnd.output)).toContain("boom");
    }
    const secondCall = client.complete.mock.calls[1][0];
    const toolMsg = (secondCall.messages as any[]).find((m) => m.role === "tool");
    expect(toolMsg.content).toContain("boom");
    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("done");
    }
  });

  test("maxTurns bailout sets stopReason to max_turns", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "loop",
      description: "loop",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });
    const client = {
      complete: vi.fn().mockResolvedValue(
        mockResponse({
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "loop", arguments: "{}" } }],
          },
        })
      ),
    };
    const cfg = mkConfig({ tools: [tool], maxTurns: 2, client: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("max_turns");
    }
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  test("AbortSignal triggers aborted stopReason between turns", async () => {
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    const tool = new Tool({
      name: "loop",
      description: "loop",
      inputSchema: z.object({}),
      execute: async () => { ac.abort(); return "ok"; },
    });
    const client = {
      complete: vi.fn().mockResolvedValue(
        mockResponse({
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "loop", arguments: "{}" } }],
          },
        })
      ),
    };
    const cfg = mkConfig({ tools: [tool], client: client as any });

    await runLoop(cfg, "go", { signal: ac.signal }, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("aborted");
    }
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  test("sessionId seeds history and persists updated history on exit", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [
      { role: "system", content: "be nice" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    const events: AgentEvent[] = [];
    const cfg = mkConfig({ sessionStore: store });

    await runLoop(cfg, "followup", { sessionId: "s1" }, collect(events));

    const persisted = await store.get("s1");
    expect(persisted).not.toBeNull();
    const roles = persisted!.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
  });

  test("run-time system replaces session's system message", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [{ role: "system", content: "old" }]);
    const events: AgentEvent[] = [];
    const client = { complete: vi.fn().mockResolvedValue(mockResponse({ message: { content: "ok" } })) };
    const cfg = mkConfig({ sessionStore: store, client: client as any });

    await runLoop(cfg, "hi", { sessionId: "s1", system: "new prompt" }, collect(events));

    const [req] = client.complete.mock.calls[0];
    const sys = (req.messages as any[]).find((m) => m.role === "system");
    expect(sys.content).toBe("new prompt");
    const persisted = await store.get("s1");
    const sysStored = persisted!.find((m) => m.role === "system");
    expect(sysStored?.content).toBe("new prompt");
  });

  test("infrastructure error from client aborts with stopReason=error", async () => {
    const events: AgentEvent[] = [];
    const client = {
      complete: vi.fn().mockRejectedValue(
        Object.assign(new Error("rate limited"), { code: 429 })
      ),
    };
    const cfg = mkConfig({ client: client as any });

    await runLoop(cfg, "hi", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("error");
      expect(end.result.error?.message).toBe("rate limited");
    }
  });

  test("emits agent:start, message, and agent:end in order", async () => {
    const events: AgentEvent[] = [];
    await runLoop(mkConfig(), "hi", {}, collect(events));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent:start");
    expect(types).toContain("message");
    expect(types[types.length - 1]).toBe("agent:end");
  });
});
