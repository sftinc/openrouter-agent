/**
 * NDJSON codec for {@link AgentEvent} streams.
 *
 * The wire format is the canonical transport for streaming agent events
 * over HTTP: one JSON-encoded event per line, terminated by `\n`. Both
 * response adapters in `responseAdapters.ts` delegate body production to
 * {@link serializeEventsAsNDJSON}, so the format truth lives in this file.
 *
 * Synthetic error events have `runId: "server"` (when `serializeEventsAsNDJSON`
 * catches a source throw) or `runId: "client"` (when {@link readEventStream}
 * encounters malformed JSON). They use the same shape as the loop's `error`
 * variant so existing consumers render them without special handling.
 */
import type { AgentEvent } from "../agent/events.js";

/**
 * Encode a single {@link AgentEvent} as one JSON line. The result contains
 * no embedded newlines and no trailing newline.
 *
 * @param event The event to encode.
 * @returns A JSON string with no `\n` characters.
 *
 * @example
 * ```ts
 * import { serializeEvent } from "./helpers";
 *
 * const line = serializeEvent({ type: "message:delta", runId: "r1", text: "hi" });
 * // '{"type":"message:delta","runId":"r1","text":"hi"}'
 * ```
 */
export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

/**
 * Convert an {@link AgentEvent} stream into NDJSON text lines. Each yielded
 * string ends with `\n`. If `source` throws mid-iteration, yields a final
 * synthetic error line (`type: "error"`, `runId: "server"`) and completes
 * without re-throwing.
 *
 * @param source Any `AsyncIterable<AgentEvent>` — typically an `AgentRun`
 *   handle or `agent.runStream(...)`.
 * @returns An async iterable of NDJSON-framed lines.
 *
 * @example
 * ```ts
 * import { serializeEventsAsNDJSON } from "./helpers";
 *
 * for await (const line of serializeEventsAsNDJSON(agent.runStream("hello"))) {
 *   res.write(line); // each line is a complete JSON object followed by \n
 * }
 * ```
 */
export async function* serializeEventsAsNDJSON(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string> {
  try {
    for await (const event of source) {
      yield serializeEvent(event) + "\n";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const synthetic: AgentEvent = {
      type: "error",
      runId: "server",
      error: { message },
    };
    yield serializeEvent(synthetic) + "\n";
  }
}
