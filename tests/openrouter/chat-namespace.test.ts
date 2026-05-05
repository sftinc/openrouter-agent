import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "../../src/openrouter/transport.js";
import { ChatNamespace } from "../../src/openrouter/chat.js";
import type { CompletionChunk } from "../../src/openrouter/index.js";

function sseStream(chunks: CompletionChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("ChatNamespace.complete (drainer)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("concatenates content deltas into a single response", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-5.4", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null, native_finish_reason: null }] } as any,
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-5.4", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null, native_finish_reason: null }] } as any,
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-5.4", choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport);
    const res = await chat.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(res.choices[0]!.message.content).toBe("Hello");
    expect(res.choices[0]!.finish_reason).toBe("stop");
    expect(res.usage?.total_tokens).toBe(6);
  });

  test("assembles tool_calls across deltas", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-5.4", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc1", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] }, finish_reason: null, native_finish_reason: null }] } as any,
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-5.4", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"hi\"}" } }] }, finish_reason: null, native_finish_reason: null }] } as any,
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-5.4", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", native_finish_reason: "tool_calls" }] } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport);
    const res = await chat.complete({ messages: [{ role: "user", content: "hi" }] });
    const tc = res.choices[0]!.message.tool_calls!;
    expect(tc).toHaveLength(1);
    expect(tc[0]!.id).toBe("tc1");
    expect(tc[0]!.function.name).toBe("lookup");
    expect(tc[0]!.function.arguments).toBe('{"q":"hi"}');
    expect(res.choices[0]!.finish_reason).toBe("tool_calls");
  });

  test("falls back to hardcoded default model when nothing else is set", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop", native_finish_reason: "stop" }] } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport);
    await chat.complete({ messages: [{ role: "user", content: "hi" }] });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe("openai/gpt-5.4");
  });

  test("client defaults override the hardcoded fallback", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop", native_finish_reason: "stop" }] } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport, { model: "anthropic/claude-haiku-4.5", temperature: 0.2 });
    await chat.complete({ messages: [{ role: "user", content: "hi" }] });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.temperature).toBe(0.2);
  });

  test("request fields override client defaults", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop", native_finish_reason: "stop" }] } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport, { model: "anthropic/claude-haiku-4.5", temperature: 0.2 });
    await chat.complete({ messages: [{ role: "user", content: "hi" }], model: "openai/gpt-4o", temperature: 0.9 });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe("openai/gpt-4o");
    expect(body.temperature).toBe(0.9);
  });

  test("complete forces stream:true on the wire", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop", native_finish_reason: "stop" }] } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport);
    await chat.complete({ messages: [{ role: "user", content: "hi" }] });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
  });
});

describe("ChatNamespace.completeStream", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("yields chunks from the SSE stream", async () => {
    const chunks: CompletionChunk[] = [
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { role: "assistant", content: "a" }, finish_reason: null, native_finish_reason: null }] } as any,
      { id: "g1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: { content: "b" }, finish_reason: "stop", native_finish_reason: "stop" }] } as any,
    ];
    (globalThis.fetch as any).mockResolvedValueOnce(new Response(sseStream(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const transport = new Transport({ apiKey: "sk-test" });
    const chat = new ChatNamespace(transport);
    const out: string[] = [];
    for await (const c of chat.completeStream({ messages: [{ role: "user", content: "hi" }] })) {
      const sc = (c.choices as any[])[0];
      if (typeof sc?.delta?.content === "string") out.push(sc.delta.content);
    }
    expect(out.join("")).toBe("ab");
  });
});
