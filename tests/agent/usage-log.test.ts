import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../../src/agent/Agent.js";
import { OpenRouterClient } from "../../src/openrouter/index.js";
import { Tool } from "../../src/tool/index.js";
import { z } from "zod";

describe("usageLog — turn entries", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("a single-turn run appends one 'turn' entry whose usage equals turnUsage", async () => {
    const client = new OpenRouterClient({ apiKey: "test" });
    vi.spyOn(client, "completeStream").mockImplementation(async function* () {
      yield {
        id: "gen_1",
        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      } as any;
    });

    const agent = new Agent({
      name: "test",
      description: "t",
      systemPrompt: "s",
      client: { model: "x" },
    });
    (agent as unknown as { openrouter: OpenRouterClient }).openrouter = client;

    const result = await agent.run("hi");
    expect(result.usageLog).toHaveLength(1);
    expect(result.usageLog[0]).toMatchObject({
      source: "turn",
      runId: result.runId,
      generationId: "gen_1",
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    expect(result.usageLog[0].toolUseId).toBeUndefined();
    expect(result.usage.total_tokens).toBe(14);
  });
});

describe("usageLog — tool entries", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("deps.complete from a tool appends a 'tool' entry attributed to the calling tool", async () => {
    const client = new OpenRouterClient({ apiKey: "test" });
    let mainTurn = 0;
    vi.spyOn(client, "completeStream").mockImplementation(async function* (req: any) {
      mainTurn++;
      if (mainTurn === 1) {
        yield {
          id: `gen_${mainTurn}`,
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "tu_x", type: "function", function: { name: "echo", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        } as any;
        return;
      }
      if (mainTurn === 2) {
        yield {
          id: `gen_${mainTurn}`,
          choices: [{ delta: { content: "side" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        } as any;
        return;
      }
      yield {
        id: `gen_${mainTurn}`,
        choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      } as any;
    });

    const echo = new Tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({}),
      execute: async (_args, deps) => {
        const sub = await deps.complete([{ role: "user", content: "x" }]);
        return sub.content ?? "";
      },
    });

    const agent = new Agent({
      name: "test",
      description: "t",
      systemPrompt: "s",
      client: { model: "x" },
      tools: [echo],
    });
    (agent as unknown as { openrouter: OpenRouterClient }).openrouter = client;

    const result = await agent.run("hi");

    const turns = result.usageLog.filter((e) => e.source === "turn");
    const tools = result.usageLog.filter((e) => e.source === "tool");
    expect(turns).toHaveLength(2);          // turn 1 + turn 2 from main loop
    expect(tools).toHaveLength(1);          // one deps.complete from inside the tool
    expect(tools[0]).toMatchObject({
      source: "tool",
      runId: result.runId,
      toolUseId: "tu_x",
      toolName: "echo",
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });
    // 8 (turn 1) + 9 (deps.complete) + 5 (turn 2) = 22
    expect(result.usage.total_tokens).toBe(22);
  });
});

describe("usageLog — agent entries", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("subagent invocation appends a single 'agent' entry summarizing inner usage", async () => {
    const innerClient = new OpenRouterClient({ apiKey: "test" });
    vi.spyOn(innerClient, "completeStream").mockImplementation(async function* () {
      yield {
        id: "gen_inner",
        choices: [{ delta: { content: "inner" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      } as any;
    });
    const inner = new Agent({
      name: "inner",
      description: "inner",
      systemPrompt: "s",
      client: { model: "x" },
    });
    (inner as unknown as { openrouter: OpenRouterClient }).openrouter = innerClient;

    const outerClient = new OpenRouterClient({ apiKey: "test" });
    let outerTurn = 0;
    vi.spyOn(outerClient, "completeStream").mockImplementation(async function* () {
      outerTurn++;
      if (outerTurn === 1) {
        yield {
          id: "gen_outer_1",
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "tu_y", type: "function", function: { name: "inner", arguments: "{\"input\":\"hi\"}" } }] },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        } as any;
        return;
      }
      yield {
        id: "gen_outer_2",
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } as any;
    });

    const outer = new Agent({
      name: "outer",
      description: "outer",
      systemPrompt: "s",
      client: { model: "x" },
      tools: [inner],
    });
    (outer as unknown as { openrouter: OpenRouterClient }).openrouter = outerClient;

    const result = await outer.run("go");

    const agentEntries = result.usageLog.filter((e) => e.source === "agent");
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0]).toMatchObject({
      source: "agent",
      toolUseId: "tu_y",
      toolName: "inner",
      parentRunId: result.runId,
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    });
    // outer turn 1 (2) + agent rollup (33) + outer turn 2 (2) = 37
    expect(result.usage.total_tokens).toBe(37);
  });
});
