import { describe, test, expect, vi } from "vitest";
import { parseRetryAfter, defaultIsRetryable } from "../../src/openrouter/retry.js";
import { StreamTruncatedError, IdleTimeoutError } from "../../src/openrouter/errors.js";
import { OpenRouterError } from "../../src/openrouter/client.js";

describe("parseRetryAfter", () => {
  test("returns undefined when header is missing", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  test("parses integer seconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("60")).toBe(60_000);
  });

  test("parses HTTP-date form", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));
    expect(parseRetryAfter("Sun, 26 Apr 2026 12:00:05 GMT")).toBe(5000);
    vi.useRealTimers();
  });

  test("returns 0 when HTTP-date is in the past", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));
    expect(parseRetryAfter("Sun, 26 Apr 2026 11:00:00 GMT")).toBe(0);
    vi.useRealTimers();
  });

  test("returns undefined for unparseable values", () => {
    expect(parseRetryAfter("not-a-number")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });
});

describe("defaultIsRetryable", () => {
  test("retries on 408, 429, 500, 502, 503, 504", () => {
    for (const code of [408, 429, 500, 502, 503, 504]) {
      const err = new OpenRouterError({ code, message: "x" });
      expect(defaultIsRetryable(err)).toBe(true);
    }
  });

  test("does not retry on 400, 401, 403, 404, 409, 422", () => {
    for (const code of [400, 401, 403, 404, 409, 422]) {
      const err = new OpenRouterError({ code, message: "x" });
      expect(defaultIsRetryable(err)).toBe(false);
    }
  });

  test("retries on plain Error (treated as network-level)", () => {
    expect(defaultIsRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(defaultIsRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  test("does not retry on AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(defaultIsRetryable(err)).toBe(false);
  });

  test("does not retry on DOMException-style AbortError", () => {
    const err = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    expect(defaultIsRetryable(err)).toBe(false);
  });

  test("retries on StreamTruncatedError", () => {
    const err = new StreamTruncatedError({ message: "x", partialContentLength: 0 });
    expect(defaultIsRetryable(err)).toBe(true);
  });

  test("retries on IdleTimeoutError", () => {
    const err = new IdleTimeoutError({ message: "x", idleMs: 60_000 });
    expect(defaultIsRetryable(err)).toBe(true);
  });

  test("does not retry on non-Error values", () => {
    expect(defaultIsRetryable(undefined)).toBe(false);
    expect(defaultIsRetryable(null)).toBe(false);
    expect(defaultIsRetryable("string")).toBe(false);
    expect(defaultIsRetryable(42)).toBe(false);
    expect(defaultIsRetryable({})).toBe(false);
  });
});
