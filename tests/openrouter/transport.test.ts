import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "../../src/openrouter/transport.js";
import { OpenRouterError } from "../../src/openrouter/index.js";

describe("Transport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("buildHeaders includes auth, content-type, and optional referer/title", () => {
    const t = new Transport({ apiKey: "sk-test", referer: "https://example.com", title: "app" });
    const headers = t.buildHeaders();
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-OpenRouter-Title"]).toBe("app");
  });

  test("buildHeaders merges extra headers", () => {
    const t = new Transport({ apiKey: "sk-test" });
    const headers = t.buildHeaders({ Accept: "text/event-stream" });
    expect(headers.Accept).toBe("text/event-stream");
  });

  test("buildHeaders omits referer/title when not configured", () => {
    const t = new Transport({ apiKey: "sk-test" });
    const headers = t.buildHeaders();
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-OpenRouter-Title"]).toBeUndefined();
  });

  test("constructor throws when no apiKey is available", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new Transport({})).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });

  test("fetchWithRetry POSTs to BASE_URL + path and returns the response on 2xx", async () => {
    const t = new Transport({ apiKey: "sk-test" });
    const fakeRes = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    (globalThis.fetch as any).mockResolvedValueOnce(fakeRes);

    const res = await t.fetchWithRetry("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(200);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ x: 1 }));
    expect(init.headers.Authorization).toBe("Bearer sk-test");
  });

  test("fetchWithRetry throws OpenRouterError with code/message/body on non-2xx", async () => {
    const t = new Transport({ apiKey: "sk-test" });
    const errBody = { error: { message: "rate limited", metadata: { tier: "free" } } };
    const makeRes = () =>
      new Response(JSON.stringify(errBody), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      });
    (globalThis.fetch as any)
      .mockResolvedValueOnce(makeRes())
      .mockResolvedValueOnce(makeRes())
      .mockResolvedValueOnce(makeRes())
      .mockResolvedValueOnce(makeRes());

    await expect(t.fetchWithRetry("/chat/completions", { method: "POST", body: "{}" })).rejects.toSatisfy((e: unknown) => {
      const err = e as OpenRouterError;
      return err instanceof OpenRouterError && err.code === 429 && err.message === "rate limited" && err.metadata?.tier === "free";
    });
  });
});
