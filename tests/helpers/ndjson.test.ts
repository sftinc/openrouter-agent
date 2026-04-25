import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import {
  serializeEvent,
  serializeEventsAsNDJSON,
  readEventStream,
} from "../../src/helpers/ndjson.js";

async function* iter(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

async function* throwingIter(
  events: AgentEvent[],
  err: unknown,
): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
  throw err;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

describe("serializeEvent", () => {
  test("returns a single JSON line with no embedded newlines", () => {
    const ev: AgentEvent = {
      type: "message:delta",
      runId: "r1",
      text: "hi",
    };
    const line = serializeEvent(ev);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(ev);
  });
});

describe("serializeEventsAsNDJSON", () => {
  test("yields each event encoded with a trailing newline", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const lines = await collect(serializeEventsAsNDJSON(iter(events)));
    expect(lines.length).toBe(2);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0])).toEqual(events[0]);
    expect(JSON.parse(lines[1])).toEqual(events[1]);
  });

  test("yields a synthetic error line if the source throws", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
    ];
    const lines = await collect(
      serializeEventsAsNDJSON(throwingIter(events, new Error("boom"))),
    );
    expect(lines.length).toBe(2);
    const last = JSON.parse(lines[1]);
    expect(last).toEqual({
      type: "error",
      runId: "server",
      error: { message: "boom" },
    });
  });

  test("uses String(err) when the thrown value is not an Error", async () => {
    const lines = await collect(
      serializeEventsAsNDJSON(throwingIter([], "non-error")),
    );
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: "error",
      runId: "server",
      error: { message: "non-error" },
    });
  });
});

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

async function collectEvents(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of source) out.push(e);
  return out;
}

describe("readEventStream", () => {
  test("parses NDJSON bytes back into events", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const body = streamFromString(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await collectEvents(readEventStream(body))).toEqual(events);
  });

  test("skips empty and whitespace-only lines", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
    ];
    const body = streamFromString(
      "\n   \n" + JSON.stringify(events[0]) + "\n\n",
    );
    expect(await collectEvents(readEventStream(body))).toEqual(events);
  });

  test("yields a synthetic error event for malformed lines and continues", async () => {
    const ok: AgentEvent = { type: "message:delta", runId: "r1", text: "ok" };
    const body = streamFromString(`not-json\n${JSON.stringify(ok)}\n`);
    const events = await collectEvents(readEventStream(body));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      type: "error",
      runId: "client",
    });
    expect((events[0] as { error: { message: string } }).error.message).toMatch(/JSON|parse/i);
    expect(events[1]).toEqual(ok);
  });

  test("handles events split across chunk boundaries", async () => {
    const ev: AgentEvent = { type: "message:delta", runId: "r1", text: "abc" };
    const line = JSON.stringify(ev) + "\n";
    const mid = Math.floor(line.length / 2);
    const body = streamFromChunks([line.slice(0, mid), line.slice(mid)]);
    expect(await collectEvents(readEventStream(body))).toEqual([ev]);
  });
});
