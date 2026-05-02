/**
 * Public surface of the `lib/` folder — shared utilities used across the
 * agent runtime, OpenRouter client, tool layer, and session store.
 *
 * Consumers should import from this barrel rather than from individual files,
 * e.g. `import { generateId } from "../lib"`.
 *
 * Re-exports:
 * - {@link generateId} — short prefixed pseudo-random IDs (see `./ids.ts`).
 * - {@link mergeNumericRecords} — additive merge of two numeric-counter
 *   records, used to accumulate token/cost details across LLM calls
 *   (see `./metrics.ts`).
 * - {@link buildToolResultMessage} / {@link buildToolErrorMessage} —
 *   constructors for the `role: "tool"` conversation messages appended after
 *   a tool's `execute()` resolves or rejects (see `./messages.ts`).
 * - {@link flattenUsageLog} — recursively replaces `"agent"` UsageLogEntry
 *   items with their inner subagent's leaf entries (see `./usageLog.ts`).
 *
 * @module lib
 */

/** See {@link ./ids!generateId}. */
export { generateId } from "./ids.js";
/** See {@link ./metrics!mergeNumericRecords}. */
export { mergeNumericRecords } from "./metrics.js";
/** See {@link ./messages!buildToolResultMessage} and {@link ./messages!buildToolErrorMessage}. */
export { buildToolResultMessage, buildToolErrorMessage } from "./messages.js";
/** See {@link ./usageLog!flattenUsageLog}. */
export { flattenUsageLog } from "./usageLog.js";
