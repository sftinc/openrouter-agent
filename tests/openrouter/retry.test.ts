import { describe, test, expect, vi } from "vitest";
import { parseRetryAfter } from "../../src/openrouter/retry.js";

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
