import { StreamTruncatedError, IdleTimeoutError } from "./errors.js";

/**
 * @file Minimal Server-Sent Events (SSE) parser for OpenRouter streaming
 * responses.
 *
 * Implements just enough of the WHATWG SSE spec
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html) to
 * decode the `text/event-stream` body returned by `/chat/completions` when
 * `stream: true`. We only care about `data:` fields — `event:`, `id:`, and
 * `retry:` are silently dropped because OpenRouter does not use them.
 *
 * Each yielded value is the JSON-parsed payload of one frame. The OpenAI-
 * compatible `[DONE]` sentinel terminates iteration cleanly.
 */

/**
 * Options for {@link parseSseStream}.
 */
export interface ParseSseStreamOptions {
  /**
   * Idle window in milliseconds. If no chunk arrives in this window, throws
   * {@link IdleTimeoutError}. Default: no timer (wait forever).
   */
  idleTimeoutMs?: number;
}

/**
 * Parse a `ReadableStream` of UTF-8 bytes as an SSE event stream, yielding
 * the JSON-parsed payload of each non-empty `data:` frame. Handles:
 *   - `\n` or `\r\n` line endings
 *   - comment lines starting with `:`
 *   - multi-line `data:` fields (joined with `\n` per spec)
 *   - the OpenAI/OpenRouter `[DONE]` sentinel (ends the iteration)
 *   - chunks that split mid-frame (buffered until a frame terminator arrives)
 *   - a trailing frame with no terminator if the server closes the stream
 *     without a blank line; a stream that ends without the `[DONE]` sentinel
 *     throws `StreamTruncatedError` after yielding any trailing data
 *
 * Non-`data` fields (`event:`, `id:`, `retry:`) are ignored — we only need
 * `data`. Payloads that fail `JSON.parse` throw and abort the stream
 * (consumer's `for await` will reject).
 *
 * The reader's lock is always released in a `finally`, regardless of how
 * iteration ended (return, throw, or `[DONE]`). Callers that abandon the
 * iterator early (e.g. via `AbortSignal`) should additionally cancel the
 * underlying body to free network resources — {@link OpenRouterClient.completeStream}
 * already does this.
 *
 * @param body A `ReadableStream<Uint8Array>` such as `fetch().body`.
 * @param options Optional configuration for the parser.
 * @param options.idleTimeoutMs If set, each `reader.read()` races a timer of
 *   this many milliseconds; if no chunk arrives in time, throws
 *   {@link IdleTimeoutError}. Omit (or leave `undefined`) to wait forever.
 * @returns Async generator of JSON-parsed payloads (one per `data:` frame).
 *
 * @example
 * ```ts
 * const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
 * for await (const payload of parseSseStream(res.body!, { idleTimeoutMs: 30_000 })) {
 *   console.log(payload);
 * }
 * ```
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {}
): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const idleTimeoutMs = options.idleTimeoutMs;

  try {
    while (true) {
      const readPromise = reader.read();
      const { value, done } = idleTimeoutMs != null
        ? await raceIdleTimeout(readPromise, idleTimeoutMs)
        : await readPromise;
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      /**
       * Inner loop: drain every complete frame currently in `buffer` (frames
       * are separated by a blank line per the SSE spec). Stop as soon as
       * `findFrameSeparator` reports no more terminators so we can read more
       * bytes from the network.
       */
      while (true) {
        const sep = findFrameSeparator(buffer);
        if (sep === -1) break;
        const frame = buffer.slice(0, sep.start);
        buffer = buffer.slice(sep.end);

        const payload = extractData(frame);
        if (payload === null) continue;
        if (payload === "[DONE]") return;
        yield JSON.parse(payload);
      }

      if (done) {
        /**
         * Server closed the stream. If anything remains in `buffer` it is a
         * trailing frame the server never terminated with a blank line —
         * extract and yield it (unless it is `[DONE]`). Then throw
         * `StreamTruncatedError`: a stream that ended without the `[DONE]`
         * sentinel is truncated. The OpenRouter client (or the agent loop)
         * decides whether to surface this based on whether a terminal
         * `finish_reason` was already observed in the chunks.
         */
        const payload = extractData(buffer);
        buffer = "";
        if (payload === "[DONE]") return;
        if (payload !== null) yield JSON.parse(payload);
        throw new StreamTruncatedError({
          message: "SSE stream ended without [DONE] sentinel",
          partialContentLength: 0,
        });
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Find the next SSE frame terminator (a blank line) in `buf`.
 *
 * SSE permits both `\n\n` and `\r\n\r\n` as frame separators. We scan for
 * both and return whichever appears first. The returned `start` is the
 * offset of the terminator within `buf`; `end` is the offset just after
 * it (so `buf.slice(end)` is the next frame's first byte).
 *
 * @param buf Current accumulated text buffer.
 * @returns `{ start, end }` of the terminator, or `-1` if no complete
 *   frame has arrived yet.
 */
function findFrameSeparator(buf: string): { start: number; end: number } | -1 {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { start: crlf, end: crlf + 4 };
  return { start: lf, end: lf + 2 };
}

/**
 * Extract the concatenated `data:` payload from a single SSE frame.
 *
 * Per the SSE spec, multiple `data:` lines within one frame are joined
 * with `\n`. A leading single space after the colon is stripped (so
 * `data: foo` and `data:foo` both yield `foo`). Comment lines (starting
 * with `:`) and unrecognized fields (`event`, `id`, `retry`) are ignored.
 *
 * @param frame The text of one SSE frame (no terminating blank line).
 * @returns The joined payload string, or `null` if the frame contained
 *   no `data:` lines.
 */
function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      /** Per spec, strip exactly one leading space after the colon. */
      const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
      dataLines.push(value);
    }
    /** Silently ignore other fields (event, id, retry). */
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/**
 * Race a `reader.read()` promise against a timer. If the timer fires first,
 * throws {@link IdleTimeoutError}. The losing branch is left to settle
 * naturally; the underlying stream should be cancelled by the caller (the
 * OpenRouter client does this in its `finally`).
 *
 * @template T Resolved value of the read promise.
 * @param readPromise The pending `reader.read()` promise.
 * @param idleMs Idle window in ms.
 * @returns Whatever the read resolved to.
 * @throws {IdleTimeoutError} If the timer fires before the read resolves.
 */
async function raceIdleTimeout<T>(readPromise: Promise<T>, idleMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timerPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new IdleTimeoutError({
        message: `SSE idle timeout after ${idleMs}ms`,
        idleMs,
      }));
    }, idleMs);
  });
  try {
    return await Promise.race([readPromise, timerPromise]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
