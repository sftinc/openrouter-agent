import { describe, test, expect, vi } from "vitest";
import { parseRetryAfter, defaultIsRetryable, resolveRetryConfig, abortableSleep, createRetryBudget, withRetry, type RetryBudget, type RetryConfig } from "../../src/openrouter/retry.js";
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

describe("abortableSleep", () => {
  test("resolves after the given delay when not aborted", async () => {
    vi.useFakeTimers();
    const p = abortableSleep(100);
    let resolved = false;
    p.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  test("rejects with AbortError when aborted before timeout fires", async () => {
    const ctrl = new AbortController();
    const p = abortableSleep(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects with AbortError immediately if signal already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(abortableSleep(10_000, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  test("zero delay still yields a microtask", async () => {
    let synchronous = true;
    const p = abortableSleep(0).then(() => { synchronous = false; });
    expect(synchronous).toBe(true);
    await p;
    expect(synchronous).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns the result of fn on first success", async () => {
    const cfg = resolveRetryConfigForTest();
    const budget = createRetryBudget(cfg);
    const result = await withRetry(async () => 42, { budget, config: cfg });
    expect(result).toBe(42);
    expect(budget.remaining).toBe(cfg.maxAttempts - 1);
  });

  test("retries on retryable error and decrements budget", async () => {
    const cfg = resolveRetryConfigForTest({ maxAttempts: 3, initialDelayMs: 0 });
    const budget = createRetryBudget(cfg);
    let calls = 0;
    const events: Array<{ attempt: number; delayMs: number }> = [];
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("ECONNRESET");
        return "ok";
      },
      {
        budget,
        config: cfg,
        onRetry: (info) => events.push({ attempt: info.attempt, delayMs: info.delayMs }),
        random: () => 0,
      }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(events).toHaveLength(2);
    expect(events[0].attempt).toBe(1);
    expect(events[1].attempt).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  test("rethrows when error is not retryable", async () => {
    const cfg = resolveRetryConfigForTest({ maxAttempts: 5 });
    const budget = createRetryBudget(cfg);
    const err = new Error("aborted");
    err.name = "AbortError";
    await expect(withRetry(async () => { throw err; }, { budget, config: cfg })).rejects.toBe(err);
    expect(budget.remaining).toBe(4); // unchanged: never decremented
  });

  test("rethrows when budget is exhausted", async () => {
    const cfg = resolveRetryConfigForTest({ maxAttempts: 2, initialDelayMs: 0 });
    const budget = createRetryBudget(cfg);
    const events: number[] = [];
    await expect(
      withRetry(async () => { throw new Error("boom"); }, {
        budget,
        config: cfg,
        onRetry: (info) => events.push(info.attempt),
        random: () => 0,
      })
    ).rejects.toThrow("boom");
    expect(events).toEqual([1]);
    expect(budget.remaining).toBe(0);
  });

  test("honors Retry-After as a floor on backoff", async () => {
    const cfg = resolveRetryConfigForTest({ maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 8000 });
    const budget = createRetryBudget(cfg);
    let delayObserved = -1;
    const err = new OpenRouterError({ code: 429, message: "rate limited", retryAfterMs: 3000 });
    let calls = 0;
    await withRetry(
      async () => { calls++; if (calls === 1) throw err; return "ok"; },
      {
        budget,
        config: cfg,
        onRetry: (info) => { delayObserved = info.delayMs; },
        random: () => 0,
        sleep: async () => {},
      }
    );
    expect(delayObserved).toBe(3000);
  });

  test("caps Retry-After at maxDelayMs", async () => {
    const cfg = resolveRetryConfigForTest({ maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 5000 });
    const budget = createRetryBudget(cfg);
    let delayObserved = -1;
    const err = new OpenRouterError({ code: 429, message: "rate limited", retryAfterMs: 60_000 });
    let calls = 0;
    await withRetry(
      async () => { calls++; if (calls === 1) throw err; return "ok"; },
      {
        budget,
        config: cfg,
        onRetry: (info) => { delayObserved = info.delayMs; },
        random: () => 0,
        sleep: async () => {},
      }
    );
    expect(delayObserved).toBe(5000);
  });

  test("aborts during backoff sleep without further attempts", async () => {
    const cfg = resolveRetryConfigForTest({ maxAttempts: 5, initialDelayMs: 1000 });
    const budget = createRetryBudget(cfg);
    const ctrl = new AbortController();
    let calls = 0;
    const events: number[] = [];
    const promise = withRetry(
      async () => { calls++; throw new Error("boom"); },
      {
        budget,
        config: cfg,
        signal: ctrl.signal,
        onRetry: (info) => events.push(info.attempt),
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    expect(events).toEqual([1]);
  });
});

function resolveRetryConfigForTest(overrides: Partial<RetryConfig> = {}) {
  return resolveRetryConfig({ initialDelayMs: 0, maxDelayMs: 0, ...overrides });
}
