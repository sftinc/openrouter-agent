/**
 * Numeric-record arithmetic helpers used to accumulate usage metrics across
 * multiple LLM calls in a single agent run.
 *
 * Currently exposes a single helper, {@link mergeNumericRecords}, which
 * performs an additive merge of two optional records of numeric counters.
 * This is used by the agent loop to fold together OpenRouter's per-call
 * `Usage.prompt_tokens_details`, `Usage.completion_tokens_details`, and
 * `Usage.server_tool_use` sub-records into a single run-level total.
 *
 * @module lib/metrics
 * @see {@link ../types!Usage}
 */

/**
 * Sums two optional records of numeric counters by key, skipping non-numeric
 * values.
 *
 * Behaviour:
 * - Returns `undefined` only when both inputs are `undefined`. If exactly
 *   one input is defined, the result still walks both slots and returns a
 *   freshly-allocated record; the input is never returned by reference.
 * - Iterates `Object.entries` of each input in order (`a` then `b`); for
 *   every entry whose value is a `number`, it adds the value to the
 *   accumulator under the same key.
 * - Non-numeric values (e.g. `undefined`, `null`, `string`, `NaN` is still a
 *   number and will propagate) are silently skipped. `0` is preserved.
 * - Keys present in only one record are carried through; keys present in
 *   both are summed.
 *
 * Used to accumulate `Usage.prompt_tokens_details`,
 * `Usage.completion_tokens_details`, and `Usage.server_tool_use` across every
 * LLM call in a single agent run.
 *
 * @template T - A record type whose values are `number | undefined`. The
 *   return type is widened back to `T` via an unchecked cast since the
 *   accumulator is built as `Record<string, number>` internally.
 * @param a - First record, or `undefined`.
 * @param b - Second record, or `undefined`.
 * @returns A new record containing the per-key sum of numeric values from
 *   `a` and `b`, or `undefined` if both inputs were `undefined`. The result
 *   is always a fresh object — neither input is mutated.
 *
 * @example
 * ```ts
 * mergeNumericRecords({ a: 1, b: 2 }, { b: 3, c: 4 });
 * // => { a: 1, b: 5, c: 4 }
 *
 * mergeNumericRecords(undefined, undefined); // => undefined
 * mergeNumericRecords({ a: 1 }, undefined);  // => { a: 1 }  (fresh object)
 * ```
 */
export function mergeNumericRecords<T extends Record<string, number | undefined>>(
  a: T | undefined,
  b: T | undefined
): T | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as T;
}
