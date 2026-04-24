/**
 * Sums two optional records of numeric counters by key, skipping non-numeric
 * values. Returns `undefined` only when both inputs are `undefined`.
 *
 * Used to accumulate `Usage.prompt_tokens_details`,
 * `Usage.completion_tokens_details`, and `Usage.server_tool_use` across every
 * LLM call in a single agent run.
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
