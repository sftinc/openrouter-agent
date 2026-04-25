import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { runLoop, type RunLoopConfig } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { Tool } from "../../src/tool/Tool.js";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { CompletionChunk } from "../../src/openrouter/index.js";
import type { ToolCall, Usage } from "../../src/types/index.js";

/**
 * Build a series of CompletionChunks that emit `content` as a single text
 * delta, optional tool_calls on the last chunk, and usage on a trailing
 * empty-choices chunk.
 */
function mockChunks(partial: {
  id?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  finish_reason?: string;
  usage?: Usage;
}): CompletionChunk[] {
  const id = partial.id ?? "gen-1";
  const model = "anthropic/claude-haiku-4.5";
  const chunks: CompletionChunk[] = [];
  if (partial.content != null && partial.content.length > 0) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          finish_reason: null,
          native_finish_reason: null,
          delta: { content: partial.content },
        },
      ],
    });
  }
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        delta: {
          content: null,
          tool_calls: partial.tool_calls?.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: tc.type,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        },
      },
    ],
  });
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [],
    usage: partial.usage ?? {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  });
  return chunks;
}

function mockStream(chunks: CompletionChunk[]): AsyncIterable<CompletionChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function mkConfig(overrides: Partial<RunLoopConfig> = {}): RunLoopConfig {
  const openrouter = {
    completeStream: vi.fn((_req: unknown, _signal?: AbortSignal) =>
      mockStream(mockChunks({ content: "hello" }))
    ),
  };
  return {
    agentName: "test-agent",
    systemPrompt: "you are helpful",
    client: { model: "anthropic/claude-haiku-4.5" },
    tools: [],
    maxTurns: 10,
    openrouter: openrouter as any,
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
      completeStream: vi.fn()
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            id: "gen-1",
            finish_reason: "tool_calls",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) },
              },
            ],
          }))
        )
        .mockImplementationOnce(() =>
          mockStream(mockChunks({ id: "gen-2", content: "final" }))
        ),
    };
    const cfg = mkConfig({ tools: [tool], openrouter: client as any });

    await runLoop(cfg, "please echo", {}, collect(events));

    expect(client.completeStream).toHaveBeenCalledTimes(2);
    const second = client.completeStream.mock.calls[1][0];
    const toolMsg = (second.messages as any[]).find((m) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call-1");
    expect(toolMsg.content).toBe("ECHO:hi");

    const toolStart = events.find((e) => e.type === "tool:start");
    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool:end") {
      expect("error" in toolEnd).toBe(false);
      if (!("error" in toolEnd)) expect(toolEnd.output).toBe("ECHO:hi");
    }
  });

  test("tool receives a snapshot of loop messages via deps.getMessages", async () => {
    const seen: any[] = [];
    const tool = new Tool({
      name: "peek",
      description: "peek at messages",
      inputSchema: z.object({}),
      execute: async (_args, deps) => {
        seen.push(deps.getMessages?.());
        return "ok";
      },
    });
    const client = {
      completeStream: vi.fn()
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            finish_reason: "tool_calls",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "peek", arguments: "{}" } },
            ],
          }))
        )
        .mockImplementationOnce(() => mockStream(mockChunks({ content: "done" }))),
    };
    const cfg = mkConfig({ tools: [tool], openrouter: client as any });

    await runLoop(cfg, "hello there", {}, () => {});

    expect(seen).toHaveLength(1);
    const snap = seen[0] as any[];
    expect(snap.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(snap.some((m) => m.role === "system")).toBe(false);
    expect(snap[0].content).toBe("hello there");
    expect(snap[1].tool_calls?.[0].function.name).toBe("peek");

    // Mutating the snapshot must not affect the loop.
    snap.push({ role: "user", content: "MUTATION" });
    const second = client.completeStream.mock.calls[1][0];
    expect((second.messages as any[]).some((m) => m.content === "MUTATION")).toBe(false);
  });

  test("tool handler throws surface as error on tool:end and loop continues", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "crash",
      description: "always fails",
      inputSchema: z.object({}),
      execute: async () => { throw new Error("boom"); },
    });
    const client = {
      completeStream: vi.fn()
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            finish_reason: "tool_calls",
            content: null,
            tool_calls: [
              { id: "c", type: "function", function: { name: "crash", arguments: "{}" } },
            ],
          }))
        )
        .mockImplementationOnce(() =>
          mockStream(mockChunks({ content: "recovered" }))
        ),
    };
    const cfg = mkConfig({ tools: [tool], openrouter: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const toolEnd = events.find((e) => e.type === "tool:end");
    if (toolEnd?.type === "tool:end" && "error" in toolEnd) {
      expect(toolEnd.error).toContain("boom");
    } else {
      throw new Error("expected tool:end with error");
    }
    const secondCall = client.completeStream.mock.calls[1][0];
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
      completeStream: vi.fn().mockImplementation(() =>
        mockStream(mockChunks({
          finish_reason: "tool_calls",
          content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "loop", arguments: "{}" } }],
        }))
      ),
    };
    const cfg = mkConfig({ tools: [tool], maxTurns: 2, openrouter: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("max_turns");
    }
    expect(client.completeStream).toHaveBeenCalledTimes(2);
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
      completeStream: vi.fn().mockImplementation(() =>
        mockStream(mockChunks({
          finish_reason: "tool_calls",
          content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "loop", arguments: "{}" } }],
        }))
      ),
    };
    const cfg = mkConfig({ tools: [tool], openrouter: client as any });

    await runLoop(cfg, "go", { signal: ac.signal }, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("aborted");
    }
    expect(client.completeStream).toHaveBeenCalledTimes(1);
  });

  test("sessionId seeds history and persists updated history on exit (no system in store)", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    const events: AgentEvent[] = [];
    const cfg = mkConfig({ sessionStore: store });

    await runLoop(cfg, "followup", { sessionId: "s1" }, collect(events));

    const persisted = await store.get("s1");
    expect(persisted).not.toBeNull();
    const roles = persisted!.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("stored system messages are stripped on load (defensive)", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [
      { role: "system", content: "stale" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    const client = {
      completeStream: vi.fn().mockImplementation(() =>
        mockStream(mockChunks({ content: "ok" }))
      ),
    };
    const cfg = mkConfig({ sessionStore: store, openrouter: client as any });

    await runLoop(cfg, "followup", { sessionId: "s1" }, collect([]));

    const [req] = client.completeStream.mock.calls[0];
    const systems = (req.messages as any[]).filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toBe("you are helpful");
  });

  test("run-time system is sent on the wire but NOT persisted", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [
      { role: "user", content: "prev" },
      { role: "assistant", content: "prev reply" },
    ]);
    const client = {
      completeStream: vi.fn().mockImplementation(() =>
        mockStream(mockChunks({ content: "ok" }))
      ),
    };
    const cfg = mkConfig({ sessionStore: store, openrouter: client as any });

    await runLoop(cfg, "hi", { sessionId: "s1", system: "new prompt" }, collect([]));

    const [req] = client.completeStream.mock.calls[0];
    const sys = (req.messages as any[]).find((m) => m.role === "system");
    expect(sys.content).toBe("new prompt");

    const persisted = await store.get("s1");
    const sysStored = persisted!.find((m) => m.role === "system");
    expect(sysStored).toBeUndefined();
  });

  test("infrastructure error from client aborts with stopReason=error", async () => {
    const events: AgentEvent[] = [];
    const client = {
      completeStream: vi.fn().mockImplementation(() => {
        return (async function* () {
          throw Object.assign(new Error("rate limited"), { code: 429 });
          // eslint-disable-next-line no-unreachable
          yield undefined as any;
        })();
      }),
    };
    const cfg = mkConfig({ openrouter: client as any });

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

  test("session is NOT persisted when the run errors", async () => {
    const store = new InMemorySessionStore();
    const before = [
      { role: "user", content: "earlier" } as const,
      { role: "assistant", content: "earlier reply" } as const,
    ];
    await store.set("s1", [...before]);
    const client = {
      completeStream: vi.fn().mockImplementation(() => {
        return (async function* () {
          throw Object.assign(new Error("boom"), { code: 500 });
          // eslint-disable-next-line no-unreachable
          yield undefined as any;
        })();
      }),
    };
    const cfg = mkConfig({ sessionStore: store, openrouter: client as any });

    await runLoop(cfg, "followup", { sessionId: "s1" }, collect([]));

    const persisted = await store.get("s1");
    expect(persisted).toEqual(before);
  });

  describe("tool display merging", () => {
    async function runOnce(
      tool: Tool<{ text: string }>,
      args: { text: string } = { text: "hi" }
    ): Promise<AgentEvent[]> {
      const events: AgentEvent[] = [];
      const client = {
        completeStream: vi.fn()
          .mockImplementationOnce(() =>
            mockStream(mockChunks({
              finish_reason: "tool_calls",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: tool.name, arguments: JSON.stringify(args) },
                },
              ],
            }))
          )
          .mockImplementationOnce(() =>
            mockStream(mockChunks({ id: "gen-2", content: "final" }))
          ),
      };
      const cfg = mkConfig({ tools: [tool], openrouter: client as any });
      await runLoop(cfg, "go", {}, collect(events));
      return events;
    }

    test("default title (string) is used when phase hook omits title", async () => {
      const tool = new Tool({
        name: "echo",
        description: "",
        inputSchema: z.object({ text: z.string() }),
        execute: async (a) => `ECHO:${a.text}`,
        display: {
          title: "Echoing",
          success: (_a, output) => ({ content: output }),
        },
      });
      const events = await runOnce(tool);
      const start = events.find((e) => e.type === "tool:start");
      const end = events.find((e) => e.type === "tool:end");
      expect(start?.display).toEqual({ title: "Echoing", content: undefined });
      expect(end?.display).toEqual({ title: "Echoing", content: "ECHO:hi" });
    });

    test("default title (function) receives args", async () => {
      const tool = new Tool({
        name: "echo",
        description: "",
        inputSchema: z.object({ text: z.string() }),
        execute: async (a) => `ECHO:${a.text}`,
        display: {
          title: (a) => `Echoing ${a.text}`,
        },
      });
      const events = await runOnce(tool, { text: "abc" });
      const start = events.find((e) => e.type === "tool:start");
      const end = events.find((e) => e.type === "tool:end");
      expect(start?.display?.title).toBe("Echoing abc");
      expect(end?.display?.title).toBe("Echoing abc");
    });

    test("phase hook title overrides the default", async () => {
      const tool = new Tool({
        name: "echo",
        description: "",
        inputSchema: z.object({ text: z.string() }),
        execute: async (a) => `ECHO:${a.text}`,
        display: {
          title: "Running",
          success: (_a, output) => ({ title: "Done", content: output }),
        },
      });
      const events = await runOnce(tool);
      const end = events.find((e) => e.type === "tool:end");
      expect(end?.display).toEqual({ title: "Done", content: "ECHO:hi" });
    });

    test("no title anywhere emits no display", async () => {
      const tool = new Tool({
        name: "echo",
        description: "",
        inputSchema: z.object({ text: z.string() }),
        execute: async (a) => `ECHO:${a.text}`,
        display: {
          success: (_a, output) => ({ content: output }),
        },
      });
      const events = await runOnce(tool);
      const start = events.find((e) => e.type === "tool:start");
      const end = events.find((e) => e.type === "tool:end");
      expect(start?.display).toBeUndefined();
      expect(end?.display).toBeUndefined();
    });

    test("error hook inherits default title when it returns only content", async () => {
      const tool = new Tool({
        name: "crash",
        description: "",
        inputSchema: z.object({ text: z.string() }),
        execute: async () => { throw new Error("boom"); },
        display: {
          title: "Crashing",
          error: (_a, err) => ({ content: String(err) }),
        },
      });
      const events = await runOnce(tool);
      const end = events.find((e) => e.type === "tool:end");
      expect(end?.display?.title).toBe("Crashing");
      if (end?.type === "tool:end" && "error" in end) {
        expect(end.display?.content).toContain("boom");
      } else {
        throw new Error("expected tool:end with error");
      }
    });
  });

  test("session is NOT persisted when the run is aborted mid-flight", async () => {
    const store = new InMemorySessionStore();
    const before = [
      { role: "user", content: "earlier" } as const,
      { role: "assistant", content: "earlier reply" } as const,
    ];
    await store.set("s1", [...before]);
    const ctrl = new AbortController();
    const client = {
      completeStream: vi.fn().mockImplementation(() => {
        return (async function* () {
          ctrl.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
          // eslint-disable-next-line no-unreachable
          yield undefined as any;
        })();
      }),
    };
    const cfg = mkConfig({ sessionStore: store, openrouter: client as any });

    const events: AgentEvent[] = [];
    await runLoop(cfg, "followup", { sessionId: "s1", signal: ctrl.signal }, collect(events));

    const persisted = await store.get("s1");
    expect(persisted).toEqual(before);
    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("aborted");
    }
  });

  test("emits message:delta events as text chunks arrive and assembles final message", async () => {
    const events: AgentEvent[] = [];
    const openrouter = {
      completeStream: vi.fn(() =>
        mockStream([
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: null,
                native_finish_reason: null,
                delta: { content: "Hel" },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: null,
                native_finish_reason: null,
                delta: { content: "lo " },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: "stop",
                native_finish_reason: "stop",
                delta: { content: "world" },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          },
        ])
      ),
    };
    const cfg = mkConfig({ openrouter: openrouter as any });

    await runLoop(cfg, "hi", {}, collect(events));

    const deltas = events.filter((e) => e.type === "message:delta");
    expect(deltas.map((e: any) => e.text)).toEqual(["Hel", "lo ", "world"]);

    const msg = events.find((e) => e.type === "message");
    expect(msg?.type).toBe("message");
    if (msg?.type === "message") {
      expect(msg.message.role).toBe("assistant");
      expect(msg.message.content).toBe("Hello world");
    }

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.text).toBe("Hello world");
      expect(end.result.stopReason).toBe("done");
      expect(end.result.usage.total_tokens).toBe(4);
    }
  });

  test("assembles tool_calls from streaming deltas across chunks", async () => {
    const firstTurnChunks: CompletionChunk[] = [
      {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [
          {
            finish_reason: null,
            native_finish_reason: null,
            delta: {
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "echo", arguments: '{"t' },
                },
              ],
            },
          },
        ],
      },
      {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [
          {
            finish_reason: "tool_calls",
            native_finish_reason: "tool_calls",
            delta: {
              content: null,
              tool_calls: [{ index: 0, function: { arguments: 'ext":"hi"}' } }],
            },
          },
        ],
      },
      {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      },
    ];
    const openrouter = {
      completeStream: vi
        .fn<(req: any, signal?: AbortSignal) => AsyncIterable<CompletionChunk>>()
        .mockImplementationOnce(() => mockStream(firstTurnChunks))
        .mockImplementationOnce(() => mockStream(mockChunks({ id: "gen-2", content: "done" }))),
    };

    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => `ECHO:${args.text}`,
    });

    const cfg = mkConfig({ openrouter: openrouter as any, tools: [tool] });
    await runLoop(cfg, "hi", {}, collect(events));

    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolEnd?.type).toBe("tool:end");
    if (toolEnd?.type === "tool:end" && "output" in toolEnd) {
      expect(toolEnd.output).toBe("ECHO:hi");
    }
  });

  test("transport error during stream yields stopReason error", async () => {
    const openrouter = {
      completeStream: vi.fn(() => {
        return (async function* () {
          throw new Error("boom");
          // eslint-disable-next-line no-unreachable
          yield undefined as any;
        })();
      }),
    };
    const events: AgentEvent[] = [];
    const cfg = mkConfig({ openrouter: openrouter as any });
    await runLoop(cfg, "hi", {}, collect(events));
    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("error");
      expect(end.result.error?.message).toBe("boom");
    }
  });
});

describe("Usage accumulation — multimodal & cost", () => {
  test("sums audio_tokens and video_tokens across turns", async () => {
    const openrouter = {
      completeStream: vi
        .fn()
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            id: "gen-a",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "noop", arguments: "{}" } },
            ],
            finish_reason: "tool_calls",
            usage: {
              prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
              prompt_tokens_details: { audio_tokens: 2, video_tokens: 1 },
              completion_tokens_details: { audio_tokens: 3, image_tokens: 4 },
              cost_details: { upstream_inference_prompt_cost: 0.01, upstream_inference_completions_cost: 0.02 },
              is_byok: false,
            } as any,
          }))
        )
        .mockImplementationOnce(() =>
          mockStream(mockChunks({
            id: "gen-b",
            content: "done",
            usage: {
              prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
              prompt_tokens_details: { audio_tokens: 5 },
              cost_details: { upstream_inference_prompt_cost: 0.03, upstream_inference_completions_cost: 0.01 },
              is_byok: true,
            } as any,
          }))
        ),
    };
    const noop = new Tool({
      name: "noop",
      description: "no-op",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });
    const events: AgentEvent[] = [];
    await runLoop(mkConfig({ tools: [noop], openrouter: openrouter as any }), "hi", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    expect(end?.type).toBe("agent:end");
    if (end?.type !== "agent:end") throw new Error("unreachable");
    expect(end.result.usage.prompt_tokens_details?.audio_tokens).toBe(7);
    expect(end.result.usage.prompt_tokens_details?.video_tokens).toBe(1);
    expect(end.result.usage.completion_tokens_details?.audio_tokens).toBe(3);
    expect(end.result.usage.completion_tokens_details?.image_tokens).toBe(4);
    expect((end.result.usage as any).cost_details?.upstream_inference_prompt_cost).toBeCloseTo(0.04);
    expect((end.result.usage as any).cost_details?.upstream_inference_completions_cost).toBeCloseTo(0.03);
    expect((end.result.usage as any).is_byok).toBe(true);
  });

  describe("agent display merging", () => {
    async function runWithDisplay(
      display: NonNullable<RunLoopConfig["display"]>,
      chunkOpts: Parameters<typeof mockChunks>[0] = { content: "hi" }
    ): Promise<AgentEvent[]> {
      const events: AgentEvent[] = [];
      const client = {
        completeStream: vi.fn(() => mockStream(mockChunks(chunkOpts))),
      };
      const cfg = mkConfig({ display, openrouter: client as any });
      await runLoop(cfg, "ask", {}, collect(events));
      return events;
    }

    test("default title (string) is used when phase hooks omit title", async () => {
      const events = await runWithDisplay({
        title: "Researcher",
        success: (r) => ({ content: r.text }),
      });
      const start = events.find((e) => e.type === "agent:start");
      const end = events.find((e) => e.type === "agent:end");
      expect(start?.display).toEqual({ title: "Researcher", content: undefined });
      expect(end?.display).toEqual({ title: "Researcher", content: "hi" });
    });

    test("default title (function) receives the input", async () => {
      const events = await runWithDisplay({
        title: (input) => `Working on: ${typeof input === "string" ? input : "(history)"}`,
      });
      const start = events.find((e) => e.type === "agent:start");
      const end = events.find((e) => e.type === "agent:end");
      expect(start?.display?.title).toBe("Working on: ask");
      expect(end?.display?.title).toBe("Working on: ask");
    });

    test("success hook fires only on stopReason === done", async () => {
      const events = await runWithDisplay({
        title: "Run",
        success: (r) => ({ title: "Done", content: r.text }),
        error: () => ({ title: "Failed" }),
        end: () => ({ title: "Ended" }),
      });
      const end = events.find((e) => e.type === "agent:end");
      expect(end?.display).toEqual({ title: "Done", content: "hi" });
    });

    test("end hook fires for non-done, non-error terminals (e.g. length)", async () => {
      const events = await runWithDisplay(
        {
          title: "Run",
          success: () => ({ title: "Done" }),
          end: (r) => ({ title: `Ended: ${r.stopReason}` }),
        },
        { content: "hi", finish_reason: "length" }
      );
      const end = events.find((e) => e.type === "agent:end");
      expect(end?.display?.title).toBe("Ended: length");
    });

    test("end hook is fallback when outcome-specific hook is absent", async () => {
      const events = await runWithDisplay({
        title: "Run",
        end: (r) => ({ title: `Done: ${r.stopReason}` }),
      });
      const end = events.find((e) => e.type === "agent:end");
      expect(end?.display?.title).toBe("Done: done");
    });

    test("a throwing hook does not crash the run; display is omitted", async () => {
      const events = await runWithDisplay({
        title: "Run",
        success: () => { throw new Error("nope"); },
      });
      const end = events.find((e) => e.type === "agent:end");
      expect(end?.display).toBeUndefined();
      if (end?.type === "agent:end") {
        expect(end.result.stopReason).toBe("done");
      }
    });

    test("no title anywhere emits no display", async () => {
      const events = await runWithDisplay({
        success: (r) => ({ content: r.text }),
      });
      const start = events.find((e) => e.type === "agent:start");
      const end = events.find((e) => e.type === "agent:end");
      expect(start?.display).toBeUndefined();
      expect(end?.display).toBeUndefined();
    });
  });
});
