import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "../../src/agent/Agent.js";
import { OpenRouterClient } from "../../src/openrouter/index.js";

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
