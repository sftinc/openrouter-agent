import { describe, test, expect } from "vitest";
import { mergeNumericRecords } from "../../src/lib/metrics.js";

describe("mergeNumericRecords", () => {
  test("returns undefined when both inputs undefined", () => {
    expect(mergeNumericRecords(undefined, undefined)).toBeUndefined();
  });

  test("returns a if b is undefined (merged clone)", () => {
    const a = { cached_tokens: 5 };
    const result = mergeNumericRecords(a, undefined);
    expect(result).toEqual({ cached_tokens: 5 });
  });

  test("returns b if a is undefined (merged clone)", () => {
    const b = { reasoning_tokens: 7 };
    expect(mergeNumericRecords(undefined, b)).toEqual({ reasoning_tokens: 7 });
  });

  test("sums overlapping numeric keys", () => {
    const a = { cached_tokens: 5, cache_write_tokens: 2 };
    const b = { cached_tokens: 3, cache_write_tokens: 1 };
    expect(mergeNumericRecords(a, b)).toEqual({ cached_tokens: 8, cache_write_tokens: 3 });
  });

  test("unions non-overlapping keys", () => {
    const a = { cached_tokens: 5 };
    const b = { reasoning_tokens: 7 };
    expect(mergeNumericRecords(a, b)).toEqual({ cached_tokens: 5, reasoning_tokens: 7 });
  });

  test("skips non-numeric values", () => {
    const a = { cached_tokens: 5, ratio: "high" as unknown as number };
    const b = { cached_tokens: 3 };
    expect(mergeNumericRecords(a, b)).toEqual({ cached_tokens: 8 });
  });
});
