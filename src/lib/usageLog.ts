/**
 * Helpers for working with `Result.usageLog`.
 *
 * @module lib/usageLog
 */
import { INNER_RESULT_KEY } from "../agent/index.js";
import type { Result, UsageLogEntry } from "../types/index.js";

/**
 * Flatten a `Result.usageLog` so every nested subagent's per-call entries
 * appear at the top level. Each `"agent"` entry is replaced by the
 * recursively-flattened entries of its inner `Result`. The returned array
 * contains only leaf entries — `"turn"`, `"tool"`, `"embed"` — never an
 * `"agent"`.
 *
 * Subagent inner Results are reached via the {@link INNER_RESULT_KEY} Symbol
 * attached to each `"agent"` entry by the agent loop. If for some reason an
 * `"agent"` entry has no Symbol attached (e.g. fabricated by hand), it is
 * passed through as-is so the function never silently drops data.
 *
 * @param result The {@link Result} whose log to flatten.
 * @returns A new array of leaf {@link UsageLogEntry} objects in chronological order.
 *
 * @example
 * ```ts
 * import { flattenUsageLog } from "./lib";
 *
 * const total = flattenUsageLog(result)
 *   .reduce((sum, entry) => sum + (entry.usage.cost ?? 0), 0);
 * ```
 */
export function flattenUsageLog(result: Result): UsageLogEntry[] {
  const out: UsageLogEntry[] = [];
  for (const entry of result.usageLog) {
    if (entry.source !== "agent") {
      out.push(entry);
      continue;
    }
    const inner = (entry as unknown as Record<PropertyKey, unknown>)[INNER_RESULT_KEY] as
      | Result
      | undefined;
    if (!inner) {
      out.push(entry);
      continue;
    }
    out.push(...flattenUsageLog(inner));
  }
  return out;
}
