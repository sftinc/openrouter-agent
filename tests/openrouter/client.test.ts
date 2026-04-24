import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenRouterClient, OpenRouterError } from "../../src/openrouter/client.js";
import type { CompletionsResponse } from "../../src/openrouter/index.js";

const OK_RESPONSE: CompletionsResponse = {
  id: "gen-abc",
  choices: [
    {
      finish_reason: "stop",
      native_finish_reason: "stop",
      message: { role: "assistant", content: "hello" },
    },
  ],
  created: 1704067200,
  model: "anthropic/claude-haiku-4.5",
  object: "chat.completion",
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe("OpenRouterClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("POSTs to /chat/completions with Bearer auth and JSON body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(OK_RESPONSE), { status: 200 })
    );

    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const response = await client.complete({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.id).toBe("gen-abc");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("includes optional HTTP-Referer and X-OpenRouter-Title headers", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(OK_RESPONSE), { status: 200 })
    );

    const client = new OpenRouterClient({
      apiKey: "sk-test",
      referer: "https://example.com",
      title: "My App",
    });
    await client.complete({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-OpenRouter-Title"]).toBe("My App");
  });

  test("throws OpenRouterError on non-2xx responses", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
      })
    );

    const client = new OpenRouterClient({ apiKey: "sk-bad" });
    await expect(
      client.complete({
        model: "anthropic/claude-haiku-4.5",
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof OpenRouterError && err.code === 401;
    });
  });

  test("uses process.env.OPENROUTER_API_KEY when apiKey is omitted", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(OK_RESPONSE), { status: 200 })
    );
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-from-env";
    try {
      const client = new OpenRouterClient({});
      await client.complete({
        model: "anthropic/claude-haiku-4.5",
        messages: [{ role: "user", content: "hi" }],
      });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-from-env");
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  test("throws if no apiKey available", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouterClient({})).toThrow(
        /OPENROUTER_API_KEY/
      );
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });

  function sseResponse(body: string, status = 200): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(body));
        ctrl.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  async function collectChunks<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of it) out.push(v);
    return out;
  }

  test("completeStream POSTs with stream:true and yields parsed chunks", async () => {
    const body =
      `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"finish_reason":null,"native_finish_reason":null,"delta":{"content":"Hello"}}]}\n\n` +
      `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"finish_reason":"stop","native_finish_reason":"stop","delta":{"content":" world"}}]}\n\n` +
      `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n` +
      `data: [DONE]\n\n`;
    fetchSpy.mockResolvedValue(sseResponse(body));

    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const chunks = await collectChunks(
      client.completeStream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      })
    );

    expect(chunks.length).toBe(3);
    expect(chunks[0].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].usage?.total_tokens).toBe(3);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.stream).toBe(true);
  });

  test("completeStream throws OpenRouterError on non-2xx", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      })
    );
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await expect(
      collectChunks(
        client.completeStream({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        })
      )
    ).rejects.toSatisfy((e: unknown) =>
      e instanceof OpenRouterError && e.code === 429
    );
  });

  test("completeStream propagates abort via AbortSignal", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode(
            `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"finish_reason":null,"native_finish_reason":null,"delta":{"content":"a"}}]}\n\n`
          )
        );
        // keep the stream open so abort has something to interrupt
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchSpy.mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal | undefined;
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const ac = new AbortController();
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const it = client.completeStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      ac.signal
    )[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.done).toBe(false);

    ac.abort();
    // next() after abort should cancel the underlying reader
    await it.return?.();
    expect(cancelled).toBe(true);
  });
});
