import { describe, test, expect } from "vitest";
import { StreamTruncatedError, IdleTimeoutError } from "../../src/openrouter/errors.js";
import { OpenRouterError } from "../../src/openrouter/client.js";

describe("StreamTruncatedError", () => {
  test("carries name, message, generationId, and partialContentLength", () => {
    const err = new StreamTruncatedError({
      message: "stream ended without [DONE]",
      generationId: "gen-abc",
      partialContentLength: 42,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StreamTruncatedError");
    expect(err.message).toBe("stream ended without [DONE]");
    expect(err.generationId).toBe("gen-abc");
    expect(err.partialContentLength).toBe(42);
  });

  test("generationId is optional", () => {
    const err = new StreamTruncatedError({ message: "x", partialContentLength: 0 });
    expect(err.generationId).toBeUndefined();
    expect(err.partialContentLength).toBe(0);
  });
});

describe("IdleTimeoutError", () => {
  test("carries name, message, and idleMs", () => {
    const err = new IdleTimeoutError({ message: "idle for 60000ms", idleMs: 60_000 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IdleTimeoutError");
    expect(err.message).toBe("idle for 60000ms");
    expect(err.idleMs).toBe(60_000);
  });
});

describe("OpenRouterError", () => {
  test("carries optional retryAfterMs", () => {
    const err = new OpenRouterError({
      code: 429,
      message: "rate limited",
      retryAfterMs: 3000,
    });
    expect(err.retryAfterMs).toBe(3000);
  });

  test("retryAfterMs defaults to undefined when not provided", () => {
    const err = new OpenRouterError({ code: 500, message: "boom" });
    expect(err.retryAfterMs).toBeUndefined();
  });
});
