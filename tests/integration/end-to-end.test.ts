import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Agent, Tool } from "../../src/index.js";
import type { AgentEvent } from "../../src/index.js";

function completionWithToolCall(id: string, name: string, args: object) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: "tool_calls",
        native_finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc-" + id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function completionText(id: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: "stop",
        native_finish_reason: "stop",
        message: { role: "assistant", content: text },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  };
}

describe("end-to-end", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.OPENROUTER_API_KEY = "sk-e2e";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("Agent invokes a custom Tool, feeds result back, and returns synthesis", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completionWithToolCall("gen-1", "lookup", { key: "X" })), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completionText("gen-2", "value for X is 42")), { status: 200 })
      );

    const lookup = new Tool({
      name: "lookup",
      description: "Returns the value for a key",
      inputSchema: z.object({ key: z.string() }),
      execute: async (args) => ({ content: `${args.key}=42`, metadata: { source: "mock" } }),
    });

    const agent = new Agent({
      name: "researcher",
      description: "Looks things up",
      systemPrompt: "Answer questions using the lookup tool.",
      tools: [lookup],
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.runStream("what is X?")) {
      events.push(ev);
    }

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type !== "agent:end") throw new Error("no agent:end event");

    expect(end.result.text).toBe("value for X is 42");
    expect(end.result.stopReason).toBe("done");
    expect(end.result.generationIds).toEqual(["gen-1", "gen-2"]);
    expect(end.result.usage.total_tokens).toBe(33);

    const toolStart = events.find((e) => e.type === "tool:start");
    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool:end") {
      expect(toolEnd.isError).toBe(false);
    }

    // Second HTTP call should include the tool result fed back to the model.
    const secondBody = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    const toolMsg = (secondBody.messages as { role: string; content: string }[]).find(
      (m) => m.role === "tool"
    );
    expect(toolMsg?.content).toBe("X=42");
  });
});
