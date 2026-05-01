import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenRouterClient, OpenRouterError } from "../../src/openrouter/client.js";

const OK_BODY = {
  id: "embd-1",
  object: "list" as const,
  model: "qwen/qwen3-embedding-8b",
  data: [
    { object: "embedding" as const, index: 0, embedding: [0.1, 0.2] },
  ],
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

function okResponse(body: unknown = OK_BODY, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("OpenRouterClient.embed — body assembly + happy paths", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  test("single string input returns one embedding indexed 0", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const res = await client.embed({ model: "m", input: "hello" });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].index).toBe(0);
  });

  test("array input is index-aligned", async () => {
    fetchSpy.mockResolvedValue(
      okResponse({
        ...OK_BODY,
        data: [
          { object: "embedding", index: 0, embedding: [1] },
          { object: "embedding", index: 1, embedding: [2] },
          { object: "embedding", index: 2, embedding: [3] },
        ],
      }),
    );
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const res = await client.embed({ model: "m", input: ["a", "b", "c"] });
    expect(res.data.map((d) => d.index)).toEqual([0, 1, 2]);
  });

  test("only sends optional fields when set", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await client.embed({ model: "m", input: "hi" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ model: "m", input: "hi" });
  });

  test("forwards dimensions, input_type, user when set", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await client.embed({
      model: "m",
      input: "hi",
      dimensions: 1536,
      input_type: "search_query",
      user: "u-1",
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.dimensions).toBe(1536);
    expect(sent.input_type).toBe("search_query");
    expect(sent.user).toBe("u-1");
  });
});

describe("OpenRouterClient.embed — model precedence", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  test("uses client embedModel when request omits model", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const client = new OpenRouterClient({ apiKey: "sk-test", embedModel: "client-default" });
    await client.embed({ input: "hi" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("client-default");
  });

  test("request.model wins over client embedModel", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const client = new OpenRouterClient({ apiKey: "sk-test", embedModel: "client-default" });
    await client.embed({ model: "request-override", input: "hi" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("request-override");
  });

  test("throws clearly when neither client nor request supplies a model", async () => {
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await expect(client.embed({ input: "hi" })).rejects.toThrow(/embedModel/);
  });
});

describe("OpenRouterClient.embed — errors and cancellation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  test("4xx → OpenRouterError carrying body.error.message and metadata", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "bad input", metadata: { reason: "x" } } }),
        { status: 400 },
      ),
    );
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await expect(client.embed({ model: "m", input: "hi" })).rejects.toSatisfy((e: unknown) => {
      return e instanceof OpenRouterError
        && e.code === 400
        && e.message === "bad input"
        && (e.metadata as { reason?: string })?.reason === "x";
    });
  });

  test("aborted signal → AbortError", async () => {
    fetchSpy.mockImplementation(async (_url, init) => {
      const sig = (init as RequestInit).signal as AbortSignal | undefined;
      if (sig?.aborted) throw new DOMException("aborted", "AbortError");
      throw new DOMException("aborted", "AbortError");
    });
    const ac = new AbortController();
    ac.abort();
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await expect(
      client.embed({ model: "m", input: "hi" }, ac.signal),
    ).rejects.toSatisfy((e: unknown) => (e as Error).name === "AbortError");
  });
});

describe("OpenRouterClient.embed — connection-level retry", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("retries 503 once and resolves on the second 200", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: "sk-test",
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
    });
    const res = await client.embed({ model: "m", input: "hi" });
    expect(res.id).toBe("embd-1");
    expect(calls).toBe(2);
  });

  test("throws after exhausting maxAttempts on repeated 503", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: "sk-test",
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
    });
    await expect(client.embed({ model: "m", input: "hi" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OpenRouterError && e.code === 503,
    );
    expect(calls).toBe(2);
  });
});

describe("OpenRouterClient.embed — headers and logging", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  test("sends Authorization, Content-Type, HTTP-Referer, X-OpenRouter-Title", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const client = new OpenRouterClient({
      apiKey: "sk-test",
      referer: "https://example.com",
      title: "My App",
    });
    await client.embed({ model: "m", input: "hi" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-OpenRouter-Title"]).toBe("My App");
  });

  test("OPENROUTER_DEBUG → stdout contains [openrouter:embed] response:; 4xx → stderr [openrouter:embed] error response:", async () => {
    const prev = process.env.OPENROUTER_DEBUG;
    process.env.OPENROUTER_DEBUG = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchSpy.mockResolvedValue(okResponse());
      const client = new OpenRouterClient({ apiKey: "sk-test" });
      await client.embed({ model: "m", input: "hi" });
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("[openrouter:embed] response:"))).toBe(true);

      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }),
      );
      await expect(client.embed({ model: "m", input: "hi" })).rejects.toThrow();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[openrouter:embed] error response:"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      if (prev === undefined) delete process.env.OPENROUTER_DEBUG;
      else process.env.OPENROUTER_DEBUG = prev;
    }
  });
});
