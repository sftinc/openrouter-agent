import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { Agent, SessionBusyError, setOpenRouterClient } from "../../src/index.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { handleAgentRun, handleAgentRunWebResponse } from "../../src/helpers/http.js";
import { readEventStream } from "../../src/helpers/ndjson.js";

// Vitest may run these in parallel; setOpenRouterClient is idempotent for
// our purposes and we override per-agent for runs anyway.
setOpenRouterClient({ apiKey: "test-key" });

function makeMockRes() {
  const writes: string[] = [];
  const closeListeners: Array<() => void> = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  let writableEnded = false;
  return {
    writes,
    closeListeners,
    get head() { return head; },
    get writableEnded() { return writableEnded; },
    writeHead(status: number, headers: Record<string, string>) { head = { status, headers }; },
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    },
    end() { writableEnded = true; },
    on(event: "close", listener: () => void) {
      if (event === "close") closeListeners.push(listener);
    },
  };
}

function fakeAgent(opts: {
  events?: AgentEvent[];
  throwSync?: unknown;
}): Agent {
  const agent = new Agent({ name: "fake", description: "fake" });
  // Replace `run` with a stub. AgentRun is async-iterable + has .result, but
  // for these tests we only need the async iterator path that
  // pipeEventsToNodeResponse consumes.
  vi.spyOn(agent, "run").mockImplementation(((..._args: unknown[]) => {
    if (opts.throwSync !== undefined) throw opts.throwSync;
    const events = opts.events ?? [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    } as never;
  }) as never);
  return agent;
}

describe("handleAgentRun", () => {
  test("streams events as NDJSON with default headers", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "fake", startedAt: 0 },
      { type: "message:delta", runId: "r1", content: "hi" },
    ];
    const agent = fakeAgent({ events });
    const res = makeMockRes();
    await handleAgentRun(agent, "hello", res);
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(res.writes.length).toBe(2);
    expect(JSON.parse(res.writes[1].trim())).toEqual(events[1]);
    expect(res.writableEnded).toBe(true);
  });

  test("includes X-Session-Id when sessionId is provided and echoSessionHeader defaults to true", async () => {
    const agent = fakeAgent({ events: [] });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc" });
    expect(res.head?.headers["X-Session-Id"]).toBe("abc");
  });

  test("does not include the session header when echoSessionHeader=false", async () => {
    const agent = fakeAgent({ events: [] });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc", echoSessionHeader: false });
    expect(res.head?.headers["X-Session-Id"]).toBeUndefined();
  });

  test("uses sessionHeaderName when provided", async () => {
    const agent = fakeAgent({ events: [] });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc", sessionHeaderName: "X-Conv" });
    expect(res.head?.headers["X-Conv"]).toBe("abc");
    expect(res.head?.headers["X-Session-Id"]).toBeUndefined();
  });

  test("maps SessionBusyError to 409 JSON by default", async () => {
    const agent = fakeAgent({ throwSync: new SessionBusyError("abc") });
    const res = makeMockRes();
    await handleAgentRun(agent, "hi", res, { sessionId: "abc" });
    expect(res.head?.status).toBe(409);
    expect(res.head?.headers["Content-Type"]).toBe("application/json");
    expect(res.head?.headers["X-Session-Id"]).toBe("abc");
    const body = JSON.parse(res.writes.join(""));
    expect(body).toEqual({ error: "session busy", sessionId: "abc" });
    expect(res.writableEnded).toBe(true);
  });

  test("invokes onSessionBusy when provided", async () => {
    const agent = fakeAgent({ throwSync: new SessionBusyError("abc") });
    const res = makeMockRes();
    const onSessionBusy = vi.fn((_err, r) => {
      r.writeHead(429, { "Content-Type": "text/plain" });
      r.write("custom");
      r.end();
    });
    await handleAgentRun(agent, "hi", res, { sessionId: "abc", onSessionBusy });
    expect(onSessionBusy).toHaveBeenCalledTimes(1);
    expect(res.head?.status).toBe(429);
    expect(res.writes.join("")).toBe("custom");
  });

  test("rethrows non-SessionBusy synchronous errors from agent.run", async () => {
    const agent = fakeAgent({ throwSync: new Error("boom") });
    const res = makeMockRes();
    await expect(handleAgentRun(agent, "hi", res)).rejects.toThrow("boom");
  });
});

describe("handleAgentRunWebResponse", () => {
  test("returns a 200 Response with NDJSON body and merged headers", async () => {
    const events: AgentEvent[] = [
      { type: "message:delta", runId: "r1", content: "a" },
      { type: "message:delta", runId: "r1", content: "b" },
    ];
    const agent = fakeAgent({ events });
    const res = await handleAgentRunWebResponse(agent, "hi", { sessionId: "abc" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("X-Session-Id")).toBe("abc");
    const back: AgentEvent[] = [];
    for await (const e of readEventStream(res.body!)) back.push(e);
    expect(back).toEqual(events);
  });

  test("returns a 409 JSON Response on SessionBusyError", async () => {
    const agent = fakeAgent({ throwSync: new SessionBusyError("abc") });
    const res = await handleAgentRunWebResponse(agent, "hi", { sessionId: "abc" });
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Session-Id")).toBe("abc");
    expect(await res.json()).toEqual({ error: "session busy", sessionId: "abc" });
  });

  test("rethrows non-SessionBusy errors", async () => {
    const agent = fakeAgent({ throwSync: new Error("boom") });
    await expect(handleAgentRunWebResponse(agent, "hi")).rejects.toThrow("boom");
  });
});
