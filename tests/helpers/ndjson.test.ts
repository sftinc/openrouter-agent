import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import {
  serializeEvent,
  serializeEventsAsNDJSON,
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
