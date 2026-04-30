import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Agent } from "../../src/agent/Agent.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { CompletionChunk } from "../../src/openrouter/index.js";

function chunk(
  over: Partial<CompletionChunk> & {
    delta?: { content?: string };
    finish_reason?: string | null;
  }
): CompletionChunk {
  return {
    id: over.id ?? "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [
      {
        finish_reason: over.finish_reason ?? null,
        native_finish_reason: over.finish_reason ?? null,
        delta: over.delta ?? {},
      },
    ],
  } as CompletionChunk;
}

function injectClient(
  agent: Agent,
  client: { completeStream: unknown }
): void {
  (agent as unknown as { openrouter: unknown }).openrouter = client;
}

describe("integration — retry through Agent.run", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  test("transient failure before any delta, succeeds on retry", async () => {
    let calls = 0;
    const client = {
      completeStream: () => {
        calls++;
        if (calls < 3) {
          return (async function* () {
            throw new Error("ECONNRESET");
          })();
        }
        return (async function* () {
          yield chunk({ delta: { content: "hi" } });
          yield chunk({ finish_reason: "stop" });
        })();
      },
    };
    const agent = new Agent({
      name: "t",
      description: "t",
      retry: { maxAttempts: 5, initialDelayMs: 0, maxDelayMs: 0 },
    });
    injectClient(agent, client);

    const run = agent.run("hi");
    const events: AgentEvent[] = [];
    for await (const e of run) {
      events.push(e);
    }
    const result = await run.result;

    expect(result.stopReason).toBe("done");
    expect(result.content).toBe("hi");
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(calls).toBe(3);
  });

  test("failure after a content delta surfaces as error and does NOT write to session", async () => {
    const client = {
      completeStream: () =>
        (async function* () {
          yield chunk({ delta: { content: "partial" } });
          throw new Error("ECONNRESET");
        })(),
    };
    const agent = new Agent({
      name: "t",
      description: "t",
      retry: { maxAttempts: 5, initialDelayMs: 0, maxDelayMs: 0 },
    });
    injectClient(agent, client);

    const sessionId = "s1";
    const result = await agent.run("hi", { sessionId });

    expect(result.stopReason).toBe("error");

    const stored = await (
      agent as unknown as {
        sessionStore: { get: (k: string) => Promise<unknown> };
      }
    ).sessionStore.get(sessionId);
    expect(stored).toBeNull();
  });

  test("aborted during retry sleep ends with stopReason: aborted (no further attempts)", async () => {
    let calls = 0;
    const client = {
      completeStream: () => {
        calls++;
        return (async function* () {
          throw new Error("ECONNRESET");
        })();
      },
    };
    const agent = new Agent({
      name: "t",
      description: "t",
      retry: { maxAttempts: 10, initialDelayMs: 5000, maxDelayMs: 5000 },
    });
    injectClient(agent, client);

    const ctrl = new AbortController();
    const runPromise = agent.run("hi", { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    const result = await runPromise;

    expect(result.stopReason).toBe("aborted");
    expect(calls).toBe(1);
  });

  test("maxAttempts: 1 disables retries", async () => {
    let calls = 0;
    const client = {
      completeStream: () => {
        calls++;
        return (async function* () {
          throw new Error("ECONNRESET");
        })();
      },
    };
    const agent = new Agent({
      name: "t",
      description: "t",
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });
    injectClient(agent, client);

    const events: AgentEvent[] = [];
    for await (const e of agent.run("hi")) {
      events.push(e);
    }

    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(0);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });
});
