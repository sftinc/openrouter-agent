import { describe, test, expect } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { pipeEventsToNodeResponse, eventsToWebResponse } from "../../src/helpers/responseAdapters.js";
import { readEventStream } from "../../src/helpers/ndjson.js";

async function* iter(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

function makeMockRes() {
  const writes: string[] = [];
  const closeListeners: Array<() => void> = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  let writableEnded = false;
  return {
    writes,
    closeListeners,
    get head() {
      return head;
    },
    get writableEnded() {
      return writableEnded;
    },
    writeHead(status: number, headers: Record<string, string>) {
      head = { status, headers };
    },
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    },
    end() {
      writableEnded = true;
    },
    on(event: "close", listener: () => void) {
      if (event === "close") closeListeners.push(listener);
    },
  };
}

describe("pipeEventsToNodeResponse", () => {
  test("writes default headers and NDJSON lines, then ends", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter(events), res);
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(res.head?.headers["Cache-Control"]).toBe("no-cache");
    expect(res.head?.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.writes.length).toBe(2);
    expect(JSON.parse(res.writes[0].trim())).toEqual(events[0]);
    expect(JSON.parse(res.writes[1].trim())).toEqual(events[1]);
    expect(res.writableEnded).toBe(true);
  });

  test("merges caller-supplied headers over defaults", async () => {
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter([]), res, {
      headers: { "X-Session-Id": "abc", "Cache-Control": "no-store" },
    });
    expect(res.head?.headers["X-Session-Id"]).toBe("abc");
    expect(res.head?.headers["Cache-Control"]).toBe("no-store");
    expect(res.head?.headers["Content-Type"]).toBe("application/x-ndjson");
  });

  test("respects a caller-supplied status", async () => {
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter([]), res, { status: 201 });
    expect(res.head?.status).toBe(201);
  });

  test("calls abort.abort() when res.on('close') fires before iteration ends", async () => {
    const abort = new AbortController();
    const res = makeMockRes();

    let resolveLong: (() => void) | undefined;
    async function* slow(): AsyncIterable<AgentEvent> {
      yield { type: "message:delta", runId: "r1", text: "a" };
      await new Promise<void>((r) => { resolveLong = r; });
      yield { type: "message:delta", runId: "r1", text: "b" };
    }

    const pipePromise = pipeEventsToNodeResponse(slow(), res, { abort });
    // Wait one microtask so iteration has started.
    await Promise.resolve();
    res.closeListeners.forEach((fn) => fn());
    expect(abort.signal.aborted).toBe(true);
    resolveLong?.();
    await pipePromise;
  });

  test("does not call abort if iteration finished cleanly", async () => {
    const abort = new AbortController();
    const res = makeMockRes();
    await pipeEventsToNodeResponse(iter([]), res, { abort });
    res.closeListeners.forEach((fn) => fn());
    // close after end is a no-op because writableEnded is true
    expect(abort.signal.aborted).toBe(false);
  });
});

describe("pipeEventsToNodeResponse — Gap 1 (error listener)", () => {
  test("aborts the run when the response emits an 'error' event", async () => {
    const writes: string[] = [];
    let closeListener: (() => void) | undefined;
    let errorListener: ((err: Error) => void) | undefined;
    const res = {
      writeHead: () => {},
      write: (chunk: string) => { writes.push(chunk); return true; },
      end: () => {},
      writableEnded: false,
      on: (ev: string, listener: (...args: unknown[]) => void) => {
        if (ev === "close") closeListener = listener as () => void;
        if (ev === "error") errorListener = listener as (err: Error) => void;
      },
    };

    void closeListener; // declared for symmetry; only errorListener is exercised

    const ctrl = new AbortController();
    const events = (async function* () {
      yield { type: "agent:start", runId: "r1", agentName: "t", startedAt: 0 };
      await new Promise((r) => setTimeout(r, 10));
      if (ctrl.signal.aborted) return;
      yield { type: "agent:end", runId: "r1", result: { text: "", messages: [], stopReason: "done", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, generationIds: [] }, startedAt: 0, endedAt: 1, elapsedMs: 1 };
    })();

    const promise = pipeEventsToNodeResponse(events as never, res as never, { abort: ctrl });
    setTimeout(() => errorListener?.(new Error("socket dead")), 5);
    await promise;
    expect(ctrl.signal.aborted).toBe(true);
  });
});

describe("eventsToWebResponse", () => {
  test("returns a Response with default NDJSON headers and 200 status", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", text: "a" },
      { type: "message:delta", runId: "r1", text: "b" },
    ];
    const res = eventsToWebResponse(iter(events));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(res.body).not.toBeNull();
    const back: AgentEvent[] = [];
    for await (const e of readEventStream(res.body!)) back.push(e);
    expect(back).toEqual(events);
  });

  test("merges caller-supplied headers over defaults", () => {
    const res = eventsToWebResponse(iter([]), {
      headers: { "X-Session-Id": "abc", "Cache-Control": "no-store" },
      status: 201,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Session-Id")).toBe("abc");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
  });

  test("calls abort.abort() when the stream is cancelled", async () => {
    const abort = new AbortController();

    async function* slow(): AsyncIterable<AgentEvent> {
      yield { type: "message:delta", runId: "r1", text: "a" };
      // Hang indefinitely until abort.
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    }

    const res = eventsToWebResponse(slow(), { abort });
    const reader = res.body!.getReader();
    await reader.read(); // pull the first chunk so the stream is active
    await reader.cancel();
    expect(abort.signal.aborted).toBe(true);
  });
});
