/**
 * Parse a ReadableStream of UTF-8 bytes as an SSE event stream, yielding
 * the JSON payload of each non-empty `data:` frame. Handles:
 *   - `\n` or `\r\n` line endings
 *   - comment lines starting with ':'
 *   - multi-line `data:` fields (joined with '\n')
 *   - the `[DONE]` sentinel (ends the iteration)
 *   - chunks that split mid-frame
 *
 * Non-`data` fields (`event:`, `id:`, `retry:`) are ignored — we only need
 * `data`. Payloads that fail JSON.parse throw and abort the stream.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      // Process complete frames (separated by blank line).
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
        // Flush trailing frame with no terminator (e.g. server closed early).
        const payload = extractData(buffer);
        buffer = "";
        if (payload !== null && payload !== "[DONE]") yield JSON.parse(payload);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findFrameSeparator(buf: string): { start: number; end: number } | -1 {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { start: crlf, end: crlf + 4 };
  return { start: lf, end: lf + 2 };
}

function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      // Per spec, strip one leading space after the colon.
      const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
      dataLines.push(value);
    }
    // Silently ignore other fields (event, id, retry).
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
