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
});
