/**
 * `streamText` — async-iterates assistant text from an {@link AgentEvent}
 * stream, yielding `message:delta.content` chunks in arrival order. Falls back
 * to the final assistant `message.content` if no deltas ever arrived (e.g.
 * non-streaming providers).
 */
import type { AgentEvent } from "../agent/events.js";

/**
 * Yield assistant text from an agent run.
 *
 * Yields each `message:delta.content` chunk as it arrives. If the stream
 * completes without ever emitting a delta AND a final assistant `message`
 * carries string content, yields that content as a single trailing chunk.
 * Tool calls and reasoning content are not yielded.
 *
 * @param source Any `AsyncIterable<AgentEvent>` — typically an `AgentRun`
 *   handle returned from `agent.run(...)`.
 * @returns An async iterable of plain text chunks. Empty deltas are skipped.
 *
 * @example
 * ```ts
 * import { streamText } from "@sftinc/openrouter-agent";
 *
 * for await (const chunk of streamText(agent.run("hello"))) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export async function* streamText(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string> {
  let sawDelta = false;
  let pendingFinal: string | undefined;
  for await (const event of source) {
    if (event.type === "message:delta") {
      if (event.content.length === 0) continue;
      sawDelta = true;
      yield event.content;
      continue;
    }
    if (
      event.type === "message" &&
      event.message.role === "assistant" &&
      typeof event.message.content === "string" &&
      event.message.content.length > 0
    ) {
      pendingFinal = event.message.content;
    }
  }
  if (!sawDelta && pendingFinal !== undefined) {
    yield pendingFinal;
  }
}
