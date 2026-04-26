import { describe, test, expect } from "vitest";
import { parseSseStream } from "../../src/openrouter/sse.js";
import { IdleTimeoutError } from "../../src/openrouter/errors.js";

function bytes(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(encoder.encode(c));
      ctrl.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("parseSseStream", () => {
  test("yields parsed JSON from single-line data frames", async () => {
    const stream = bytes(
      `data: {"a":1}\n\n`,
      `data: {"a":2}\n\n`,
      `data: [DONE]\n\n`
    );
    const out = await collect(parseSseStream(stream));
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("skips comment lines starting with ':'", async () => {
    const stream = bytes(
      `: keepalive\n\n`,
      `data: {"a":1}\n\n`,
      `: another\n\n`,
      `data: [DONE]\n\n`
    );
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });

  test("concatenates multi-line data fields with '\\n'", async () => {
    const stream = bytes(`data: {"a":\ndata: 1}\n\n`, `data: [DONE]\n\n`);
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });

  test("handles chunks that split mid-frame", async () => {
    const stream = bytes(`data: {"a`, `":1}\n`, `\ndata: [DO`, `NE]\n\n`);
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });

  test("handles \\r\\n line endings", async () => {
    const stream = bytes(`data: {"a":1}\r\n\r\n`, `data: [DONE]\r\n\r\n`);
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });

  test("stops at [DONE] and ignores trailing frames", async () => {
    const stream = bytes(`data: {"a":1}\n\ndata: [DONE]\n\ndata: {"a":2}\n\n`);
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });

  test("throws StreamTruncatedError if stream closes without [DONE]", async () => {
    const { StreamTruncatedError } = await import("../../src/openrouter/errors.js");
    const stream = bytes(`data: {"a":1}\n\n`);
    await expect(collect(parseSseStream(stream))).rejects.toBeInstanceOf(StreamTruncatedError);
  });

  test("yields trailing partial frame before throwing on premature close", async () => {
    const { StreamTruncatedError } = await import("../../src/openrouter/errors.js");
    const stream = bytes(`data: {"a":1}\n\ndata: {"b":2}`);
    const yielded: unknown[] = [];
    const iter = parseSseStream(stream)[Symbol.asyncIterator]();
    let caught: unknown;
    try {
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        yielded.push(r.value);
      }
    } catch (err) {
      caught = err;
    }
    expect(yielded).toEqual([{ a: 1 }, { b: 2 }]);
    expect(caught).toBeInstanceOf(StreamTruncatedError);
  });

  test("ignores non-data fields like event:/id:/retry:", async () => {
    const stream = bytes(
      `event: foo\nid: 1\ndata: {"a":1}\nretry: 5\n\n`,
      `data: [DONE]\n\n`
    );
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });
});

describe("parseSseStream — idle timeout", () => {
  test("throws IdleTimeoutError if no chunk arrives within idleTimeoutMs", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(`data: {"a":1}\n\n`));
      },
    });

    const iter = parseSseStream(stream, { idleTimeoutMs: 50 })[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toEqual({ a: 1 });

    await expect(iter.next()).rejects.toBeInstanceOf(IdleTimeoutError);
  });

  test("does not arm the idle timer when idleTimeoutMs is undefined", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(`data: {"a":1}\n\ndata: [DONE]\n\n`));
        setTimeout(() => ctrl.close(), 50);
      },
    });
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });
});
