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
 * const line = serializeEvent({ type: "message:delta", runId: "r1", content: "hi" });
 * // '{"type":"message:delta","runId":"r1","content":"hi"}'
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
 *   handle returned from `agent.run(...)`.
 * @returns An async iterable of NDJSON-framed lines.
 *
 * @example
 * ```ts
 * import { serializeEventsAsNDJSON } from "./helpers";
 *
 * for await (const line of serializeEventsAsNDJSON(agent.run("hello"))) {
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

/**
 * Parse an NDJSON byte stream back into {@link AgentEvent}s.
 *
 * Splits on `\n`, skips blank or whitespace-only lines, and parses each
 * remaining line with `JSON.parse`. Lines that fail to parse yield a
 * synthetic error event (`type: "error"`, `runId: "client"`) so a single
 * malformed byte sequence does not abort the entire iteration.
 *
 * @param body A `ReadableStream<Uint8Array>` — typically `response.body`
 *   from a `fetch` call against an NDJSON endpoint.
 * @returns An async iterable of parsed {@link AgentEvent}s.
 *
 * @example
 * ```ts
 * import { readEventStream } from "./helpers";
 *
 * const response = await fetch("/api/agent", { method: "POST", body: JSON.stringify({ prompt }) });
 * for await (const event of readEventStream(response.body!)) {
 *   if (event.type === "message:delta") process.stdout.write(event.content);
 * }
 * ```
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      yield parseLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parseLine(buffer);
}

function parseLine(line: string): AgentEvent {
  try {
    return JSON.parse(line) as AgentEvent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: "error",
      runId: "client",
      error: { message },
    };
  }
}
