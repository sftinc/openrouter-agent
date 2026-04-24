# Unified `run` with Optional Event Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `Agent.run` and `Agent.runStream` into a single `run()` method that returns an `AgentRun` handle which is both `PromiseLike<Result>` and `AsyncIterable<AgentEvent>`; add SSE streaming transport to `OpenRouterClient` and emit a new `message:delta` event so the demo renders tokens progressively.

**Architecture:** Three layers change. (1) **Transport:** new `OpenRouterClient.completeStream()` that parses OpenRouter SSE frames into a `CompletionChunk` async iterable. (2) **Loop:** `runLoop` always uses `completeStream`, accumulates text + tool-call argument deltas into a single final assistant `Message` per turn, and emits a new `message:delta` event as text arrives. (3) **Agent API:** `runStream()` is removed; `run()` returns an `AgentRun` handle supporting both awaiting and async iteration, started eagerly with event buffering so iteration attached synchronously after the call loses no events.

**Tech Stack:** Node.js, TypeScript (ESM, NodeNext), Vitest, Zod. Web Streams API (`ReadableStream`, `TextDecoder`) for SSE parsing — already available in Node ≥ 18.

**Source spec:** `docs/superpowers/specs/2026-04-24-unified-run-streaming-design.md`

---

## File Structure

### New files
- `src/openrouter/sse.ts` — Pure SSE frame parser. Takes a `ReadableStream<Uint8Array>` / async iterable of bytes, yields parsed JSON objects (one per `data:` frame). Skips comments and the `[DONE]` sentinel. No OpenRouter-specific logic.
- `src/agent/AgentRun.ts` — The `AgentRun` class implementing `PromiseLike<Result>` + `AsyncIterable<AgentEvent>`, backed by an event buffer/queue fed by the loop's `emit`.
- `tests/openrouter/sse.test.ts` — Unit tests for the SSE parser.
- `tests/agent/AgentRun.test.ts` — Unit tests for the handle's await/iterate semantics.

### Modified files
- `src/openrouter/types.ts` — Widen `CompletionsRequest.stream` to `boolean`; add `StreamingChoice`, `CompletionChunk`, and export them.
- `src/openrouter/client.ts` — Add `completeStream(request, signal): AsyncIterable<CompletionChunk>`.
- `src/openrouter/index.ts` — Export new types.
- `src/agent/events.ts` — Add `{ type: "message:delta"; runId; text }` variant to `AgentEvent`; handle it in `defaultDisplay`.
- `src/agent/loop.ts` — Replace `config.openrouter.complete(...)` per-turn call with `completeStream(...)` consumption that accumulates and emits `message:delta`; tighten the `openrouter` config type to include `completeStream`.
- `src/agent/Agent.ts` — Remove `runStream`; change `run` to return `AgentRun`; move the subagent `execute` wrapper to iterate an `AgentRun`.
- `src/agent/index.ts` — Export `AgentRun`.
- `examples/demo/backend.ts` — Switch to `agent.run(...)`, drop the async-iterator first-event peek (use try/catch on the synchronous call for `SessionBusyError`).
- `examples/demo/public/chat.js` — Add `case "message:delta"` and update `case "message"` to finalize the bubble.
- `tests/openrouter/client.test.ts` — Add `completeStream` tests.
- `tests/agent/loop.test.ts` — Update mock `openrouter` shape to provide `completeStream`; add delta-accumulation and `message:delta` emission tests.
- `tests/agent/Agent.test.ts` — Replace `runStream` calls with `run(...)` handle iteration.
- `tests/agent/events.test.ts` — If it enumerates event types, add the new one.

### Removed
- Nothing is deleted outright — `runStream` is removed from the public API, but the file containing it (`Agent.ts`) is just edited.

---

## Task 1: SSE frame parser (pure, no OpenRouter knowledge)

**Why first:** `completeStream` depends on it; isolating the parser makes it trivially unit-testable without spinning up an HTTP mock.

**Files:**
- Create: `src/openrouter/sse.ts`
- Test: `tests/openrouter/sse.test.ts`

**SSE rules we need (subset):**
- Frames are separated by a blank line (`\n\n` or `\r\n\r\n`).
- Lines starting with `:` are comments — skip them. (OpenRouter sends these as keep-alives.)
- Lines of the form `data: <payload>` carry a payload. Multiple `data:` lines in one frame concatenate with `\n`.
- The sentinel `data: [DONE]` terminates the stream.
- Non-`data:` fields (`event:`, `id:`, `retry:`) are ignored — we only need `data`.
- We ignore empty-data frames.

- [ ] **Step 1: Write the parser tests**

```ts
// tests/openrouter/sse.test.ts
import { describe, test, expect } from "vitest";
import { parseSseStream } from "../../src/openrouter/sse.js";

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

  test("ends cleanly if stream closes without [DONE]", async () => {
    const stream = bytes(`data: {"a":1}\n\n`);
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });

  test("ignores non-data fields like event:/id:/retry:", async () => {
    const stream = bytes(
      `event: foo\nid: 1\ndata: {"a":1}\nretry: 5\n\n`,
      `data: [DONE]\n\n`
    );
    expect(await collect(parseSseStream(stream))).toEqual([{ a: 1 }]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/openrouter/sse.test.ts`
Expected: FAIL — `parseSseStream` is not defined.

- [ ] **Step 3: Implement the parser**

```ts
// src/openrouter/sse.ts

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
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- tests/openrouter/sse.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/openrouter/sse.ts tests/openrouter/sse.test.ts
git commit -m "feat(openrouter): add SSE frame parser"
```

---

## Task 2: Streaming response types

**Files:**
- Modify: `src/openrouter/types.ts`
- Modify: `src/openrouter/index.ts`

- [ ] **Step 1: Widen `CompletionsRequest.stream` and add streaming types**

In `src/openrouter/types.ts`, **replace** the `CompletionsRequest` interface and **add** the new types. Edit the file as follows:

Find:
```ts
/** Request body we POST to /chat/completions. */
export interface CompletionsRequest extends LLMConfig {
	messages: Message[]
	tools?: OpenRouterTool[]
	stream?: false
}
```

Replace with:
```ts
/** Request body we POST to /chat/completions. */
export interface CompletionsRequest extends LLMConfig {
	messages: Message[]
	tools?: OpenRouterTool[]
	stream?: boolean
}

/**
 * Incremental tool-call piece from a streaming response. `index` identifies
 * which tool call this piece applies to (tool calls are streamed in parallel
 * keyed by index). `id` and `function.name` typically appear only on the
 * first chunk; `function.arguments` is a JSON string fragment to concatenate.
 */
export interface ToolCallDelta {
	index: number
	id?: string
	type?: 'function'
	function?: {
		name?: string
		arguments?: string
	}
}

/** Streaming choice shape from OpenRouter. See docs/openrouter/llm.md. */
export interface StreamingChoice {
	finish_reason: string | null
	native_finish_reason: string | null
	delta: {
		content: string | null
		role?: string
		tool_calls?: ToolCallDelta[]
	}
	error?: ErrorResponse
}

/**
 * A single SSE chunk parsed from /chat/completions when `stream: true`.
 * The final chunk before `[DONE]` carries `usage` with an empty `choices`
 * array; all other chunks carry one streaming choice.
 */
export interface CompletionChunk {
	id: string
	object: 'chat.completion.chunk'
	created: number
	model: string
	choices: StreamingChoice[]
	usage?: Usage
}
```

- [ ] **Step 2: Export new types**

Edit `src/openrouter/index.ts`. Find:
```ts
export type {
  LLMConfig,
  OpenRouterTool,
  FunctionTool,
  DatetimeServerTool,
  WebSearchServerTool,
  CompletionsRequest,
  CompletionsResponse,
  NonStreamingChoice,
  ErrorResponse,
  Annotation,
  UrlCitationAnnotation,
} from "./types.js";
```

Replace with:
```ts
export type {
  LLMConfig,
  OpenRouterTool,
  FunctionTool,
  DatetimeServerTool,
  WebSearchServerTool,
  CompletionsRequest,
  CompletionsResponse,
  NonStreamingChoice,
  StreamingChoice,
  CompletionChunk,
  ToolCallDelta,
  ErrorResponse,
  Annotation,
  UrlCitationAnnotation,
} from "./types.js";
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. The existing `stream: false as const` in `client.ts` still satisfies the widened `stream?: boolean` type.

- [ ] **Step 4: Commit**

```bash
git add src/openrouter/types.ts src/openrouter/index.ts
git commit -m "feat(openrouter): add streaming response types"
```

---

## Task 3: `OpenRouterClient.completeStream`

**Files:**
- Modify: `src/openrouter/client.ts`
- Modify: `tests/openrouter/client.test.ts`

- [ ] **Step 1: Write failing tests for `completeStream`**

Append to `tests/openrouter/client.test.ts` (inside the existing `describe("OpenRouterClient", ...)` block, before the closing brace):

```ts
  function sseResponse(body: string, status = 200): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(body));
        ctrl.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  async function collectChunks<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of it) out.push(v);
    return out;
  }

  test("completeStream POSTs with stream:true and yields parsed chunks", async () => {
    const body =
      `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"finish_reason":null,"native_finish_reason":null,"delta":{"content":"Hello"}}]}\n\n` +
      `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"finish_reason":"stop","native_finish_reason":"stop","delta":{"content":" world"}}]}\n\n` +
      `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n` +
      `data: [DONE]\n\n`;
    fetchSpy.mockResolvedValue(sseResponse(body));

    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const chunks = await collectChunks(
      client.completeStream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      })
    );

    expect(chunks.length).toBe(3);
    expect(chunks[0].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].usage?.total_tokens).toBe(3);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.stream).toBe(true);
  });

  test("completeStream throws OpenRouterError on non-2xx", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      })
    );
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    await expect(
      collectChunks(
        client.completeStream({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        })
      )
    ).rejects.toSatisfy((e: unknown) =>
      e instanceof OpenRouterError && e.code === 429
    );
  });

  test("completeStream propagates abort via AbortSignal", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode(
            `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"finish_reason":null,"native_finish_reason":null,"delta":{"content":"a"}}]}\n\n`
          )
        );
        // keep the stream open so abort has something to interrupt
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchSpy.mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal | undefined;
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const ac = new AbortController();
    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const it = client.completeStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      ac.signal
    )[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.done).toBe(false);

    ac.abort();
    // next() after abort should cancel the underlying reader
    await it.return?.();
    expect(cancelled).toBe(true);
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/openrouter/client.test.ts`
Expected: FAIL with `completeStream is not a function`.

- [ ] **Step 3: Implement `completeStream`**

Edit `src/openrouter/client.ts`. Add the import for the SSE parser at the top:

Find:
```ts
import type { CompletionsRequest, CompletionsResponse, LLMConfig } from './types.js'
import { DEFAULT_MODEL } from './types.js'
```

Replace with:
```ts
import type {
	CompletionChunk,
	CompletionsRequest,
	CompletionsResponse,
	LLMConfig,
} from './types.js'
import { DEFAULT_MODEL } from './types.js'
import { parseSseStream } from './sse.js'
```

Then add the method to the class. Find:
```ts
	async complete(request: CompletionsRequest, signal?: AbortSignal): Promise<CompletionsResponse> {
```

And directly **before** that line, insert:

```ts
	/**
	 * POSTs a streaming chat completion to `${BASE_URL}/chat/completions` with
	 * `stream: true` and yields parsed SSE chunks as they arrive. The final
	 * chunk before `[DONE]` carries `usage` with an empty `choices` array.
	 *
	 * @throws OpenRouterError on non-2xx responses (thrown before any chunks
	 *   are yielded). Aborts via `signal` cancel the underlying fetch and the
	 *   SSE reader.
	 */
	async *completeStream(
		request: CompletionsRequest,
		signal?: AbortSignal,
	): AsyncGenerator<CompletionChunk, void, void> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		}
		if (this.referer) headers['HTTP-Referer'] = this.referer
		if (this.title) headers['X-OpenRouter-Title'] = this.title

		const body = {
			model: DEFAULT_MODEL,
			...this.defaults,
			...request,
			stream: true as const,
		}

		const response = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok) {
			const errBody = await this.safeParseJson(response)
			const message =
				(errBody as { error?: { message?: string } } | undefined)?.error?.message ??
				`HTTP ${response.status}`
			const metadata = (errBody as { error?: { metadata?: Record<string, unknown> } } | undefined)?.error?.metadata
			throw new OpenRouterError({
				code: response.status,
				message,
				body: errBody,
				metadata,
			})
		}

		if (!response.body) {
			throw new OpenRouterError({
				code: response.status,
				message: 'streaming response had no body',
			})
		}

		for await (const payload of parseSseStream(response.body)) {
			yield payload as CompletionChunk
		}
	}

```

- [ ] **Step 4: Run client tests**

Run: `npm test -- tests/openrouter/client.test.ts`
Expected: all tests (old + new 3) PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/openrouter/client.ts tests/openrouter/client.test.ts
git commit -m "feat(openrouter): add completeStream for SSE chat completions"
```

---

## Task 4: `message:delta` event type

**Files:**
- Modify: `src/agent/events.ts`

- [ ] **Step 1: Add the new variant**

Edit `src/agent/events.ts`. Find the lifecycle comment:

```ts
 * **Lifecycle order** (per run):
 *   `agent:start` → (`message` | `tool:start` + `tool:progress*` + `tool:end`)* → (`error`)? → `agent:end`
```

Replace with:
```ts
 * **Lifecycle order** (per run):
 *   `agent:start` → (`message:delta*` + `message` | `tool:start` + `tool:progress*` + `tool:end`)* → (`error`)? → `agent:end`
```

Then in the events list comment, after the `* - `agent:start`` line and before the `* - `message`` line, insert:
```ts
 * - `message:delta` — fires zero or more times per assistant turn as text
 *   tokens arrive from the streaming transport. Each delta carries only the
 *   new text since the previous delta, not the accumulated buffer. Does not
 *   fire for tool-call arg deltas (those are only exposed via the final
 *   `message` event's `tool_calls`).
```

Then in the union type, find:
```ts
  | {
      type: "message";
      runId: string;
      message: Message;
      display?: EventDisplay;
    }
```

And directly **before** that, insert:
```ts
  | {
      type: "message:delta";
      runId: string;
      text: string;
    }
```

Then in `defaultDisplay`, find:
```ts
    case "message":
      return { title: "Message" };
```

And directly **before** that, insert:
```ts
    case "message:delta":
      return { title: "Message delta" };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: may surface errors in existing tests or demo code that exhaustively switch on `AgentEvent.type`. Note any failures — they get addressed in later tasks. If the only failures are in `tests/` and `examples/`, that's fine; core `src/` should still typecheck.

To isolate `src/`: `npx tsc -p tsconfig.json --noEmit` (existing typecheck command already does this).

Expected after inspection: errors (if any) are confined to files we will touch in Tasks 7-9.

- [ ] **Step 3: Commit**

```bash
git add src/agent/events.ts
git commit -m "feat(agent): add message:delta event for token streaming"
```

---

## Task 5: `runLoop` switches to streaming transport

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `tests/agent/loop.test.ts`

### Loop behavior per turn (contract)

1. Call `config.openrouter.completeStream(request, signal)` — returns `AsyncIterable<CompletionChunk>`.
2. For each chunk:
   - If `chunk.choices[0]?.delta.content` is a non-empty string, append it to `contentBuf` and emit `{ type: "message:delta", runId, text }` where `text` is only the new piece.
   - If `chunk.choices[0]?.delta.tool_calls` is present, merge each entry into a `toolCallBuf` keyed by its `index` (first appearance locks `id`, `type`, and `function.name`; `function.arguments` strings concatenate in arrival order).
   - If `chunk.choices[0]?.finish_reason` is set, record it (do not break yet — let the stream close normally).
   - If `chunk.choices[0]?.error` is set, record it.
   - If `chunk.usage` is set (final chunk before `[DONE]`), record it.
3. After the stream closes, assemble the final `Message`:
   - `role: "assistant"`, `content: contentBuf.length ? contentBuf : null`, `tool_calls: toolCallBuf` (as an array sorted by index, omitted if empty).
4. Push the final message, emit the existing `{ type: "message", runId, message }` event, then update `usage`/`generationIds` and continue into tool dispatch exactly as today.
5. If the stream threw, handle like today's `complete()` error path (`stopReason: "error"`, `emitError`).

### Updated `RunLoopConfig.openrouter` type

The loop no longer calls `complete`; it calls `completeStream`. The `openrouter` field becomes:

```ts
openrouter: {
  completeStream: (
    request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
    signal?: AbortSignal
  ) => AsyncIterable<CompletionChunk>;
};
```

`ToolDeps.complete` (used by tools like subagents that run their own completion) continues to return a `CompletionsResponse`-shaped result assembled by consuming the stream internally. Tools do not see streaming.

- [ ] **Step 1: Update loop tests to the new transport contract**

Tests in `tests/agent/loop.test.ts` currently mock `openrouter.complete`. Rewrite the `mkConfig` helper and each test to mock `completeStream` instead.

Replace the top of `tests/agent/loop.test.ts`:

```ts
import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { runLoop, type RunLoopConfig } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { Tool } from "../../src/tool/Tool.js";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { CompletionChunk } from "../../src/openrouter/index.js";
import type { ToolCall, Usage } from "../../src/types/index.js";

/**
 * Build a series of CompletionChunks that emit `content` as a single text
 * delta, optional tool_calls on the last chunk, and usage on a trailing
 * empty-choices chunk.
 */
function mockChunks(partial: {
  id?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  finish_reason?: string;
  usage?: Usage;
}): CompletionChunk[] {
  const id = partial.id ?? "gen-1";
  const model = "anthropic/claude-haiku-4.5";
  const chunks: CompletionChunk[] = [];
  if (partial.content != null && partial.content.length > 0) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          finish_reason: null,
          native_finish_reason: null,
          delta: { content: partial.content },
        },
      ],
    });
  }
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        delta: {
          content: null,
          tool_calls: partial.tool_calls?.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: tc.type,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        },
      },
    ],
  });
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [],
    usage: partial.usage ?? {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  });
  return chunks;
}

function mockStream(chunks: CompletionChunk[]): AsyncIterable<CompletionChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function mkConfig(overrides: Partial<RunLoopConfig> = {}): RunLoopConfig {
  const openrouter = {
    completeStream: vi.fn((_req: unknown, _signal?: AbortSignal) =>
      mockStream(mockChunks({ content: "hello" }))
    ),
  };
  return {
    agentName: "test-agent",
    systemPrompt: "you are helpful",
    client: { model: "anthropic/claude-haiku-4.5" },
    tools: [],
    maxTurns: 10,
    openrouter: openrouter as any,
    ...overrides,
  };
}

function collect(events: AgentEvent[]): (ev: AgentEvent) => void {
  return (ev) => { events.push(ev); };
}
```

(The original `mockResponse` helper and its import of `mockCompletionsResponse` are no longer needed here; delete them.)

- [ ] **Step 2: Adjust existing loop tests to call the new mock style**

For each test that uses `client.complete.mockResolvedValueOnce(...)`, replace with the streaming equivalent. Example for the tool-call test — find:

```ts
    const client = {
      complete: vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            id: "gen-1",
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
```

and analogous occurrences in other tests. Replace the mock construction with:

```ts
    const client = {
      completeStream: vi
        .fn<(req: any, signal?: AbortSignal) => AsyncIterable<CompletionChunk>>()
        .mockImplementationOnce(() =>
          mockStream(
            mockChunks({
              id: "gen-1",
              finish_reason: "tool_calls",
              content: null,
              tool_calls: [
                /* ...original tool_calls array... */
              ],
            })
          )
        )
        .mockImplementationOnce(() =>
          mockStream(mockChunks({ id: "gen-2", content: "ok" }))
        ),
    };
```

Work through each existing test, keeping the same per-turn semantics. Do not change test names or assertions; only the mock shape changes.

- [ ] **Step 3: Add new tests for streaming delta behavior**

Append these tests inside the existing `describe("runLoop", ...)` block:

```ts
  test("emits message:delta events as text chunks arrive and assembles final message", async () => {
    const events: AgentEvent[] = [];
    const openrouter = {
      completeStream: vi.fn(() =>
        mockStream([
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: null,
                native_finish_reason: null,
                delta: { content: "Hel" },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: null,
                native_finish_reason: null,
                delta: { content: "lo " },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: "stop",
                native_finish_reason: "stop",
                delta: { content: "world" },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          },
        ])
      ),
    };
    const cfg = mkConfig({ openrouter: openrouter as any });

    await runLoop(cfg, "hi", {}, collect(events));

    const deltas = events.filter((e) => e.type === "message:delta");
    expect(deltas.map((e: any) => e.text)).toEqual(["Hel", "lo ", "world"]);

    const msg = events.find((e) => e.type === "message");
    expect(msg?.type).toBe("message");
    if (msg?.type === "message") {
      expect(msg.message.role).toBe("assistant");
      expect(msg.message.content).toBe("Hello world");
    }

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.text).toBe("Hello world");
      expect(end.result.stopReason).toBe("done");
      expect(end.result.usage.total_tokens).toBe(4);
    }
  });

  test("assembles tool_calls from streaming deltas across chunks", async () => {
    const openrouter = {
      completeStream: vi.fn(() =>
        mockStream([
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: null,
                native_finish_reason: null,
                delta: {
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "echo", arguments: '{"t' },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [
              {
                finish_reason: "tool_calls",
                native_finish_reason: "tool_calls",
                delta: {
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: 'ext":"hi"}' },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: "gen-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          },
        ])
      ),
    };
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => `ECHO:${args.text}`,
    });
    // Second turn: model replies after tool result.
    (openrouter.completeStream as any).mockImplementationOnce(() =>
      mockStream([
        {
          id: "gen-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [
            {
              finish_reason: null,
              native_finish_reason: null,
              delta: {
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "echo", arguments: '{"t' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "gen-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [
            {
              finish_reason: "tool_calls",
              native_finish_reason: "tool_calls",
              delta: {
                content: null,
                tool_calls: [{ index: 0, function: { arguments: 'ext":"hi"}' } }],
              },
            },
          ],
        },
        {
          id: "gen-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        },
      ])
    );
    (openrouter.completeStream as any).mockImplementationOnce(() =>
      mockStream(mockChunks({ id: "gen-2", content: "done" }))
    );

    const cfg = mkConfig({ openrouter: openrouter as any, tools: [tool] });
    await runLoop(cfg, "hi", {}, collect(events));

    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolEnd?.type).toBe("tool:end");
    if (toolEnd?.type === "tool:end" && "output" in toolEnd) {
      expect(toolEnd.output).toBe("ECHO:hi");
    }
  });

  test("transport error during stream yields stopReason error", async () => {
    const openrouter = {
      completeStream: vi.fn(() => {
        return (async function* () {
          throw new Error("boom");
          // eslint-disable-next-line no-unreachable
          yield undefined as any;
        })();
      }),
    };
    const events: AgentEvent[] = [];
    const cfg = mkConfig({ openrouter: openrouter as any });
    await runLoop(cfg, "hi", {}, collect(events));
    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("error");
      expect(end.result.error?.message).toBe("boom");
    }
  });
```

- [ ] **Step 4: Run loop tests to confirm they fail**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: FAIL — many errors: existing tests reference `.complete` which no longer exists on our mocks; new tests reference behavior not yet implemented.

- [ ] **Step 5: Rewrite `runLoop` to use `completeStream`**

Edit `src/agent/loop.ts`.

5a. Update imports. Find:
```ts
import type {
  CompletionsResponse,
  LLMConfig,
  OpenRouterTool,
} from "../openrouter/index.js";
```

Replace with:
```ts
import type {
  CompletionChunk,
  LLMConfig,
  OpenRouterTool,
  ToolCallDelta,
} from "../openrouter/index.js";
import type { ToolCall } from "../types/index.js";
```

5b. Replace the `RunLoopConfig.openrouter` type. Find:
```ts
  openrouter: {
    complete: (
      request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
      signal?: AbortSignal
    ) => Promise<CompletionsResponse>;
  };
```

Replace with:
```ts
  openrouter: {
    completeStream: (
      request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
      signal?: AbortSignal
    ) => AsyncIterable<CompletionChunk>;
  };
```

5c. Add a helper just above `runLoop` for assembling tool-call deltas:

```ts
/**
 * Merge a tool-call delta into an index-keyed buffer. First appearance of
 * an index locks `id`, `type`, and `function.name`; subsequent appearances
 * concatenate `function.arguments`. Returns the sorted final array with
 * `arguments` defaulted to "".
 */
function assembleToolCalls(buf: Map<number, ToolCallDelta>): ToolCall[] {
  const out: ToolCall[] = [];
  const indices = [...buf.keys()].sort((a, b) => a - b);
  for (const i of indices) {
    const d = buf.get(i)!;
    out.push({
      id: d.id ?? "",
      type: d.type ?? "function",
      function: {
        name: d.function?.name ?? "",
        arguments: d.function?.arguments ?? "",
      },
    });
  }
  return out;
}

function mergeToolCallDelta(
  buf: Map<number, ToolCallDelta>,
  delta: ToolCallDelta
): void {
  const existing = buf.get(delta.index);
  if (!existing) {
    buf.set(delta.index, {
      index: delta.index,
      id: delta.id,
      type: delta.type,
      function: {
        name: delta.function?.name,
        arguments: delta.function?.arguments ?? "",
      },
    });
    return;
  }
  if (existing.id === undefined && delta.id !== undefined) existing.id = delta.id;
  if (existing.type === undefined && delta.type !== undefined) existing.type = delta.type;
  if (delta.function?.name && !existing.function?.name) {
    existing.function = { ...existing.function, name: delta.function.name };
  }
  if (delta.function?.arguments) {
    existing.function = {
      ...existing.function,
      arguments: (existing.function?.arguments ?? "") + delta.function.arguments,
    };
  }
}
```

5d. Rewrite the per-turn HTTP call + accumulation. Find:

```ts
    let response: CompletionsResponse;
    try {
      response = await config.openrouter.complete(
        { ...overrides, messages: wireMessages(), tools: openrouterTools },
        signal
      );
    } catch (err) {
      if (signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      stopReason = "error";
      const anyErr = err as { code?: number; message?: string; metadata?: Record<string, unknown> };
      error = {
        code: anyErr.code,
        message: anyErr.message ?? String(err),
        metadata: anyErr.metadata,
      };
      emitError(anyErr.code, error.message);
      break;
    }

    generationIds.push(response.id);
    usage = addUsage(usage, response.usage);

    const choice = response.choices[0];
    if (!choice) {
      stopReason = "error";
      error = { message: "OpenRouter response had no choices" };
      emitError(undefined, error.message);
      break;
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    };
    messages.push(assistantMsg);
    emit({ type: "message", runId, message: assistantMsg });

    const fr = choice.finish_reason;
    const mapped = FINISH_REASON_TO_STOP[fr ?? ""];
    if (mapped) {
      stopReason = mapped;
      break;
    }
    if (fr === "error") {
      stopReason = "error";
      error = choice.error
        ? { code: choice.error.code, message: choice.error.message, metadata: choice.error.metadata }
        : { message: "Unknown error from provider" };
      emitError(error.code, error.message);
      break;
    }

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      stopReason = "done";
      break;
    }

    for (const toolCall of choice.message.tool_calls) {
      const toolMessage = await executeToolCall(toolCall, toolByName, deps, runId, emit);
      messages.push(toolMessage);
    }

    // Loop continues for next turn.
```

Replace with:

```ts
    let contentBuf = "";
    const toolCallBuf = new Map<number, ToolCallDelta>();
    let finishReason: string | null = null;
    let turnError: { code?: number; message: string; metadata?: Record<string, unknown> } | undefined;
    let generationId: string | null = null;
    let turnUsage: Usage | undefined;

    try {
      for await (const chunk of config.openrouter.completeStream(
        { ...overrides, messages: wireMessages(), tools: openrouterTools },
        signal
      )) {
        if (!generationId && chunk.id) generationId = chunk.id;
        if (chunk.usage) turnUsage = chunk.usage;

        const sc = chunk.choices[0];
        if (!sc) continue;

        if (typeof sc.delta.content === "string" && sc.delta.content.length > 0) {
          contentBuf += sc.delta.content;
          emit({ type: "message:delta", runId, text: sc.delta.content });
        }
        if (sc.delta.tool_calls) {
          for (const d of sc.delta.tool_calls) mergeToolCallDelta(toolCallBuf, d);
        }
        if (sc.finish_reason) finishReason = sc.finish_reason;
        if (sc.error) {
          turnError = {
            code: sc.error.code,
            message: sc.error.message,
            metadata: sc.error.metadata,
          };
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      stopReason = "error";
      const anyErr = err as { code?: number; message?: string; metadata?: Record<string, unknown> };
      error = {
        code: anyErr.code,
        message: anyErr.message ?? String(err),
        metadata: anyErr.metadata,
      };
      emitError(anyErr.code, error.message);
      break;
    }

    if (generationId) generationIds.push(generationId);
    if (turnUsage) usage = addUsage(usage, turnUsage);

    const assembledToolCalls = assembleToolCalls(toolCallBuf);
    const hasToolCalls = assembledToolCalls.length > 0;
    const assistantMsg: Message = {
      role: "assistant",
      content: contentBuf.length > 0 ? contentBuf : null,
      tool_calls: hasToolCalls ? assembledToolCalls : undefined,
    };
    messages.push(assistantMsg);
    emit({ type: "message", runId, message: assistantMsg });

    if (turnError) {
      stopReason = "error";
      error = turnError;
      emitError(turnError.code, turnError.message);
      break;
    }

    if (finishReason === "error") {
      stopReason = "error";
      error = { message: "Unknown error from provider" };
      emitError(undefined, error.message);
      break;
    }

    const mapped = FINISH_REASON_TO_STOP[finishReason ?? ""];
    if (mapped) {
      stopReason = mapped;
      break;
    }

    if (!hasToolCalls) {
      stopReason = "done";
      break;
    }

    for (const toolCall of assembledToolCalls) {
      const toolMessage = await executeToolCall(toolCall, toolByName, deps, runId, emit);
      messages.push(toolMessage);
    }

    // Loop continues for next turn.
```

5e. Update `deps.complete` — the inner helper that tools can use to run their own completions. It used to return `CompletionsResponse`-shape; keep that API by consuming the stream internally. Find:

```ts
  const deps: ToolDeps = {
    complete: async (msgs, opts) => {
      const res = await config.openrouter.complete(
        {
          ...overrides,
          ...(opts?.client ?? {}),
          messages: msgs,
          tools: opts?.tools,
        },
        signal
      );
      const choice = res.choices[0];
      return {
        content: choice?.message.content ?? null,
        usage: res.usage ?? zeroUsage(),
        tool_calls: choice?.message.tool_calls,
        annotations: choice?.message.annotations,
      };
    },
```

Replace with:

```ts
  const deps: ToolDeps = {
    complete: async (msgs, opts) => {
      let content = "";
      const toolBuf = new Map<number, ToolCallDelta>();
      let u: Usage | undefined;
      for await (const chunk of config.openrouter.completeStream(
        {
          ...overrides,
          ...(opts?.client ?? {}),
          messages: msgs,
          tools: opts?.tools,
        },
        signal
      )) {
        if (chunk.usage) u = chunk.usage;
        const sc = chunk.choices[0];
        if (!sc) continue;
        if (typeof sc.delta.content === "string") content += sc.delta.content;
        if (sc.delta.tool_calls) {
          for (const d of sc.delta.tool_calls) mergeToolCallDelta(toolBuf, d);
        }
      }
      const tool_calls = assembleToolCalls(toolBuf);
      return {
        content: content.length > 0 ? content : null,
        usage: u ?? zeroUsage(),
        tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      };
    },
```

(If `ToolDeps.complete` requires `annotations`, look at `src/tool/types.ts` — if it's optional, we can omit; if it's required, set it to `undefined`. Annotations are not streamed in our current setup, so leave undefined.)

- [ ] **Step 6: Run loop tests to confirm they pass**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: all existing + 3 new tests PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `src/` (Agent.ts and subagent paths may not yet typecheck cleanly because Tool.execute still references the old shape — handled in Task 7).

If Agent.ts has type errors referring to `complete`, that's expected — we'll fix it in Task 6.

- [ ] **Step 8: Commit**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat(agent): runLoop consumes streaming transport and emits message:delta"
```

---

## Task 6: `AgentRun` handle

**Files:**
- Create: `src/agent/AgentRun.ts`
- Create: `tests/agent/AgentRun.test.ts`

### Semantics (from spec, authoritative)

- Implements `PromiseLike<Result>` and `AsyncIterable<AgentEvent>`.
- Exposes `readonly result: Promise<Result>`.
- Single underlying run, started eagerly by the constructor.
- One iterator per handle. Second `[Symbol.asyncIterator]()` call throws.
- Events are buffered until the iterator is attached; once attached, buffered events are delivered then live ones stream.
- `await` resolves with the final `Result` whether or not anyone iterated.
- Errors from the loop (e.g. thrown from inside `runLoop`) reject `result` and the iterator's `next()`.
- Abort (signal fires) resolves `result` with `stopReason: "aborted"`; iterator ends cleanly.

### Constructor contract

```ts
new AgentRun(start: (emit: EventEmit) => Promise<void>)
```

The constructor immediately invokes `start(emit)` where `emit` pushes events into the handle's internal buffer/queue. `start`'s returned promise resolves when the run is done and rejects on unexpected loop errors.

`result` is derived from the last `agent:end` event whose `runId` matches the first `agent:start` event's `runId` (matches existing `Agent.run` filter rule). If `start` rejects before any `agent:end` arrives, `result` rejects with that error.

- [ ] **Step 1: Write the handle tests**

```ts
// tests/agent/AgentRun.test.ts
import { describe, test, expect } from "vitest";
import { AgentRun } from "../../src/agent/AgentRun.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { Result } from "../../src/types/index.js";

function mkResult(overrides: Partial<Result> = {}): Result {
  return {
    text: "ok",
    messages: [],
    stopReason: "done",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    generationIds: [],
    ...overrides,
  };
}

function runWithEvents(events: AgentEvent[]): AgentRun {
  return new AgentRun(async (emit) => {
    for (const e of events) {
      await Promise.resolve();
      emit(e);
    }
  });
}

describe("AgentRun", () => {
  test("await resolves with the Result from agent:end", async () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult({ text: "hi" }) },
    ]);
    const result = await run;
    expect(result.text).toBe("hi");
  });

  test("iteration yields every event in order", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "message:delta", runId: "r1", text: "he" },
      { type: "message:delta", runId: "r1", text: "llo" },
      { type: "agent:end", runId: "r1", result: mkResult({ text: "hello" }) },
    ];
    const run = runWithEvents(events);
    const seen: AgentEvent[] = [];
    for await (const ev of run) seen.push(ev);
    expect(seen.map((e) => e.type)).toEqual([
      "agent:start",
      "message:delta",
      "message:delta",
      "agent:end",
    ]);
  });

  test("iterate + await same handle returns the same result", async () => {
    const events: AgentEvent[] = [
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult({ text: "x" }) },
    ];
    const run = runWithEvents(events);
    const seen: AgentEvent[] = [];
    for await (const ev of run) seen.push(ev);
    const result = await run;
    expect(result.text).toBe("x");
    expect(seen.length).toBe(2);
  });

  test("awaiting .result twice returns the memoized Result", async () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult({ text: "y" }) },
    ]);
    const a = await run.result;
    const b = await run.result;
    expect(a).toBe(b);
  });

  test("second [Symbol.asyncIterator]() call throws", () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "r1", agentName: "a" },
      { type: "agent:end", runId: "r1", result: mkResult() },
    ]);
    run[Symbol.asyncIterator]();
    expect(() => run[Symbol.asyncIterator]()).toThrow(/already/i);
  });

  test("events emitted synchronously before iterator attach are buffered", async () => {
    // Emit synchronously (all before returning the Promise).
    const run = new AgentRun(async (emit) => {
      emit({ type: "agent:start", runId: "r1", agentName: "a" });
      emit({ type: "message:delta", runId: "r1", text: "a" });
      emit({ type: "message:delta", runId: "r1", text: "b" });
      emit({ type: "agent:end", runId: "r1", result: mkResult({ text: "ab" }) });
    });
    // Iterator attached after emit() has already been called a bunch of times.
    await Promise.resolve();
    const seen: AgentEvent[] = [];
    for await (const ev of run) seen.push(ev);
    expect(seen.length).toBe(4);
  });

  test("loop error rejects result and iteration", async () => {
    const run = new AgentRun(async (emit) => {
      emit({ type: "agent:start", runId: "r1", agentName: "a" });
      throw new Error("kaboom");
    });
    await expect(run.result).rejects.toThrow("kaboom");
    const run2 = new AgentRun(async (emit) => {
      emit({ type: "agent:start", runId: "r1", agentName: "a" });
      throw new Error("kaboom");
    });
    await expect(async () => {
      for await (const _ of run2) void _;
    }).rejects.toThrow("kaboom");
  });

  test("filters agent:end by outer runId (subagent bubbling)", async () => {
    const run = runWithEvents([
      { type: "agent:start", runId: "outer", agentName: "a" },
      { type: "agent:start", runId: "inner", parentRunId: "outer", agentName: "sub" },
      { type: "agent:end", runId: "inner", result: mkResult({ text: "SUB" }) },
      { type: "agent:end", runId: "outer", result: mkResult({ text: "TOP" }) },
    ]);
    const result = await run;
    expect(result.text).toBe("TOP");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/agent/AgentRun.test.ts`
Expected: FAIL — `AgentRun` module does not exist.

- [ ] **Step 3: Implement `AgentRun`**

```ts
// src/agent/AgentRun.ts
import type { Result } from "../types/index.js";
import type { AgentEvent, EventEmit } from "./events.js";

/**
 * Handle returned by `Agent.run`. Both awaitable (resolves to `Result`) and
 * async-iterable (yields every `AgentEvent` in order).
 *
 * - The underlying run is started eagerly by the constructor.
 * - `[Symbol.asyncIterator]()` may be called at most once.
 * - Events emitted before an iterator is attached are buffered; they flush
 *   on the first `next()` calls.
 * - `await run` and `await run.result` resolve to the same memoized Result.
 * - Loop errors reject both `result` and the iterator's `next()`.
 */
export class AgentRun implements PromiseLike<Result>, AsyncIterable<AgentEvent> {
  private readonly buffer: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private iteratorAttached = false;
  private done = false;
  private error: unknown = undefined;

  private outerRunId: string | undefined;
  private resultValue: Result | undefined;
  private resultPromise: Promise<Result>;
  private resolveResult!: (r: Result) => void;
  private rejectResult!: (err: unknown) => void;

  /**
   * @param start Callback invoked immediately with an `emit` function that
   *   feeds events into this handle. Its returned promise completes the run.
   */
  constructor(start: (emit: EventEmit) => Promise<void>) {
    this.resultPromise = new Promise<Result>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });

    const emit: EventEmit = (ev) => {
      if (this.done) return;
      if (ev.type === "agent:start" && this.outerRunId === undefined) {
        this.outerRunId = ev.runId;
      }
      if (
        ev.type === "agent:end" &&
        this.outerRunId !== undefined &&
        ev.runId === this.outerRunId &&
        this.resultValue === undefined
      ) {
        this.resultValue = ev.result;
      }
      this.buffer.push(ev);
      const r = this.resolveNext;
      this.resolveNext = null;
      r?.();
    };

    start(emit)
      .then(() => {
        this.done = true;
        if (this.resultValue !== undefined) {
          this.resolveResult(this.resultValue);
        } else {
          this.rejectResult(
            new Error("run finished without agent:end event")
          );
        }
        const r = this.resolveNext;
        this.resolveNext = null;
        r?.();
      })
      .catch((err) => {
        this.done = true;
        this.error = err;
        this.rejectResult(err);
        const r = this.resolveNext;
        this.resolveNext = null;
        r?.();
      });
  }

  /** Promise for the final `Result`. Memoized; safe to await multiple times. */
  get result(): Promise<Result> {
    return this.resultPromise;
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.resultPromise.then(onfulfilled, onrejected);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iteratorAttached) {
      throw new Error("AgentRun iterator already attached; only one consumer supported");
    }
    this.iteratorAttached = true;

    const self = this;
    return {
      async next(): Promise<IteratorResult<AgentEvent>> {
        while (true) {
          if (self.buffer.length > 0) {
            return { value: self.buffer.shift()!, done: false };
          }
          if (self.done) {
            if (self.error) throw self.error;
            return { value: undefined as any, done: true };
          }
          await new Promise<void>((resolve) => {
            self.resolveNext = resolve;
          });
        }
      },
      async return(): Promise<IteratorResult<AgentEvent>> {
        // Consumer bailed early. We don't cancel the underlying run — the
        // caller owns the signal for that.
        return { value: undefined as any, done: true };
      },
    };
  }
}
```

- [ ] **Step 4: Run handle tests to confirm they pass**

Run: `npm test -- tests/agent/AgentRun.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `src/agent/AgentRun.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/AgentRun.ts tests/agent/AgentRun.test.ts
git commit -m "feat(agent): add AgentRun handle (awaitable + async iterable)"
```

---

## Task 7: Collapse `Agent.run`/`runStream` into a single `run`

**Files:**
- Modify: `src/agent/Agent.ts`
- Modify: `src/agent/index.ts`
- Modify: `tests/agent/Agent.test.ts`

- [ ] **Step 1: Update `Agent.test.ts` to use the new handle API**

In `tests/agent/Agent.test.ts`, replace every call to `agent.runStream(...)` with equivalent handle iteration. Skim the file for usage. The typical changes:

```ts
// Before
for await (const ev of agent.runStream(input, options)) { /* ... */ }

// After
for await (const ev of agent.run(input, options)) { /* ... */ }
```

And:

```ts
// Before
const result = await agent.run(input, options);

// After  — unchanged; the new API is a superset.
const result = await agent.run(input, options);
```

If any test expected `agent.runStream` to throw `SessionBusyError` synchronously on iteration, update it to expect the throw from `agent.run(...)` itself (synchronous).

Also update the mock `openrouter` in each test. If tests import `mockCompletionsResponse` and mock `.complete`, switch to the streaming helpers introduced in Task 5 (import them from `tests/fixtures/completions.ts` once we add them — see next step, or inline them in `Agent.test.ts` for now).

- [ ] **Step 2: Add streaming fixtures**

Extend `tests/fixtures/completions.ts`. Add at the bottom:

```ts
import type { CompletionChunk, ToolCallDelta } from "../../src/openrouter/index.js";

/**
 * Build a minimal list of `CompletionChunk`s for tests. Mirrors
 * `mockCompletionsResponse` but in streaming shape.
 */
export function mockCompletionChunks(partial: {
  id?: string;
  model?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  finish_reason?: string;
  usage?: Usage;
} = {}): CompletionChunk[] {
  const id = partial.id ?? "gen-1";
  const model = partial.model ?? "anthropic/claude-haiku-4.5";
  const usage = partial.usage ?? DEFAULT_USAGE;
  const chunks: CompletionChunk[] = [];
  if (typeof partial.content === "string" && partial.content.length > 0) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: 1704067200,
      model,
      choices: [
        {
          finish_reason: null,
          native_finish_reason: null,
          delta: { content: partial.content },
        },
      ],
    });
  }
  const toolDeltas: ToolCallDelta[] | undefined = partial.tool_calls?.map(
    (tc, i) => ({
      index: i,
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })
  );
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1704067200,
    model,
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        delta: { content: null, tool_calls: toolDeltas },
      },
    ],
  });
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1704067200,
    model,
    choices: [],
    usage,
  });
  return chunks;
}

/** Async iterable wrapper around a pre-built chunk array. */
export function mockChunkStream(
  chunks: CompletionChunk[]
): AsyncIterable<CompletionChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}
```

Use these in `Agent.test.ts` to mock `openrouter.completeStream`.

- [ ] **Step 3: Run agent tests to confirm they fail**

Run: `npm test -- tests/agent/Agent.test.ts`
Expected: multiple FAILs — `agent.runStream` doesn't exist (yet it still does in the current source), OR `agent.run` return type is incompatible with iteration. Either way, red.

- [ ] **Step 4: Rewrite `Agent.ts`**

Replace the file `src/agent/Agent.ts` with:

```ts
import { z } from "zod";
import type { Message, Result } from "../types/index.js";
import type { LLMConfig } from "../openrouter/index.js";
import { OpenRouterClient, getOpenRouterClient } from "../openrouter/index.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import { InMemorySessionStore, SessionBusyError } from "../session/index.js";
import type { AgentEvent, EventDisplay } from "./events.js";
import { runLoop, type RunLoopConfig, type RunLoopOptions } from "./loop.js";
import { AgentRun } from "./AgentRun.js";

export interface AgentConfig<Input> {
  name: string;
  description: string;
  client?: LLMConfig;
  systemPrompt?: string;
  tools?: Tool<any>[];
  inputSchema?: z.ZodType<Input>;
  maxTurns?: number;
  sessionStore?: SessionStore;
  display?: {
    start?: (input: string | Message[]) => EventDisplay;
    end?: (result: Result) => EventDisplay;
  };
}

export type AgentRunOptions = Omit<RunLoopOptions, "parentRunId"> & {
  parentRunId?: string;
};

const DEFAULT_INPUT_SCHEMA = z.object({ input: z.string() });

/**
 * The core agent. Extends `Tool` so an Agent can be passed wherever a tool
 * is expected — this is how subagents work. `run()` returns an `AgentRun`
 * handle which is both awaitable (for the final `Result`) and async-iterable
 * (for every `AgentEvent` in order).
 */
export class Agent<Input = { input: string }> extends Tool<Input> {
  private readonly clientOverrides: LLMConfig;
  private readonly systemPrompt?: string;
  private readonly agentTools: Tool<any>[];
  private readonly maxTurns: number;
  private readonly sessionStore: SessionStore;
  private readonly openrouter: OpenRouterClient;
  private readonly agentDisplay?: AgentConfig<Input>["display"];
  private readonly activeSessions = new Set<string>();

  constructor(config: AgentConfig<Input>) {
    const inputSchema =
      config.inputSchema ?? (DEFAULT_INPUT_SCHEMA as unknown as z.ZodType<Input>);

    super({
      name: config.name,
      description: config.description,
      inputSchema,
      execute: async (args: Input, deps: ToolDeps): Promise<string | ToolResult> => {
        const inputStr =
          args && typeof args === "object" && "input" in args
            ? String((args as { input: unknown }).input)
            : String(args);

        // Subagent: reuse the outer runId as parent, forward events upward.
        const parentEmit = deps.emit;
        const handle = new AgentRun(async (emit) => {
          await runLoop(
            this.buildConfig(deps.runId),
            inputStr,
            { signal: deps.signal, parentRunId: deps.runId },
            (ev) => {
              parentEmit?.(ev);
              emit(ev);
            }
          );
        });
        try {
          const result = await handle.result;
          if (result.stopReason === "error") {
            return { error: result.error?.message ?? "subagent errored" };
          }
          return { content: result.text };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    this.clientOverrides = config.client ?? {};
    this.systemPrompt = config.systemPrompt;
    this.agentTools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.openrouter = getOpenRouterClient() ?? new OpenRouterClient({});
    this.agentDisplay = config.display;
  }

  /**
   * Run the agent. The returned `AgentRun` is both `PromiseLike<Result>`
   * and `AsyncIterable<AgentEvent>`:
   *
   *   const result = await agent.run(input);                 // just the result
   *   for await (const ev of agent.run(input)) { ... }       // just the events
   *   const run = agent.run(input);                          // both
   *   for await (const ev of run) { ... }
   *   const result = await run.result;
   *
   * Throws `SessionBusyError` synchronously if `options.sessionId` is
   * already running.
   */
  run(input: string | Message[], options: AgentRunOptions = {}): AgentRun {
    const release = this.acquireSession(options.sessionId);
    return new AgentRun(async (emit) => {
      try {
        await runLoop(
          this.buildConfig(options.parentRunId),
          input,
          options,
          emit
        );
      } finally {
        release();
      }
    });
  }

  private acquireSession(sessionId: string | undefined): () => void {
    if (!sessionId) return () => {};
    if (this.activeSessions.has(sessionId)) {
      throw new SessionBusyError(sessionId);
    }
    this.activeSessions.add(sessionId);
    return () => {
      this.activeSessions.delete(sessionId);
    };
  }

  private buildConfig(parentRunId?: string): RunLoopConfig {
    return {
      agentName: this.name,
      systemPrompt: this.systemPrompt,
      client: this.clientOverrides,
      tools: this.agentTools,
      maxTurns: this.maxTurns,
      sessionStore: this.sessionStore,
      openrouter: this.openrouter,
      parentRunId,
      display: this.agentDisplay,
    };
  }
}
```

Note: `SessionBusyError` is thrown synchronously from `acquireSession` before `new AgentRun(...)` executes — matches the spec.

- [ ] **Step 5: Export `AgentRun`**

Edit `src/agent/index.ts`. Find:
```ts
export { Agent } from "./Agent.js";
export type { AgentConfig, AgentRunOptions } from "./Agent.js";
export { runLoop } from "./loop.js";
export type { RunLoopConfig, RunLoopOptions } from "./loop.js";
export { defaultDisplay } from "./events.js";
export type { AgentEvent, EventDisplay, EventEmit } from "./events.js";
```

Replace with:
```ts
export { Agent } from "./Agent.js";
export type { AgentConfig, AgentRunOptions } from "./Agent.js";
export { AgentRun } from "./AgentRun.js";
export { runLoop } from "./loop.js";
export type { RunLoopConfig, RunLoopOptions } from "./loop.js";
export { defaultDisplay } from "./events.js";
export type { AgentEvent, EventDisplay, EventEmit } from "./events.js";
```

- [ ] **Step 6: Run Agent.test.ts**

Run: `npm test -- tests/agent/Agent.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/agent/Agent.ts src/agent/index.ts tests/agent/Agent.test.ts tests/fixtures/completions.ts
git commit -m "feat(agent): unify run/runStream into single run() returning AgentRun"
```

---

## Task 8: Demo backend uses `agent.run`

**Files:**
- Modify: `examples/demo/backend.ts`

- [ ] **Step 1: Switch to `agent.run` and simplify the first-event peek**

Edit `examples/demo/backend.ts`. Find:

```ts
	const stream = agent.runStream(message, { sessionId, signal: abort.signal })
	const iterator = stream[Symbol.asyncIterator]()

	// Pull the first event before writing status headers so we can surface a
	// SessionBusyError as HTTP 409 instead of an in-stream error.
	let first: IteratorResult<AgentEvent>
	try {
		first = await iterator.next()
	} catch (err) {
		if (err instanceof SessionBusyError) {
			res.writeHead(409, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'session busy', sessionId }))
			return
		}
		const msg = err instanceof Error ? err.message : String(err)
		res.writeHead(500, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: msg }))
		return
	}

	res.writeHead(200, {
		'Content-Type': 'application/x-ndjson',
		'Cache-Control': 'no-cache',
		'X-Accel-Buffering': 'no',
		'X-Session-Id': sessionId,
	})

	const send = (event: AgentEvent) => {
		res.write(JSON.stringify(event) + '\n')
	}

	try {
		if (!first.done) send(first.value)
		while (true) {
			const next = await iterator.next()
			if (next.done) break
			send(next.value)
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		res.write(JSON.stringify({ type: 'error', runId: 'server', error: { message: msg } }) + '\n')
	} finally {
		res.end()
	}
```

Replace with:

```ts
	// SessionBusyError is thrown synchronously from agent.run() so we can
	// surface it as HTTP 409 without peeking the iterator.
	let run
	try {
		run = agent.run(message, { sessionId, signal: abort.signal })
	} catch (err) {
		if (err instanceof SessionBusyError) {
			res.writeHead(409, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'session busy', sessionId }))
			return
		}
		const msg = err instanceof Error ? err.message : String(err)
		res.writeHead(500, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: msg }))
		return
	}

	res.writeHead(200, {
		'Content-Type': 'application/x-ndjson',
		'Cache-Control': 'no-cache',
		'X-Accel-Buffering': 'no',
		'X-Session-Id': sessionId,
	})

	const send = (event: AgentEvent) => {
		res.write(JSON.stringify(event) + '\n')
	}

	try {
		for await (const ev of run) send(ev)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		res.write(JSON.stringify({ type: 'error', runId: 'server', error: { message: msg } }) + '\n')
	} finally {
		res.end()
	}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add examples/demo/backend.ts
git commit -m "feat(demo): switch backend to unified agent.run"
```

---

## Task 9: Demo frontend renders `message:delta`

**Files:**
- Modify: `examples/demo/public/chat.js`

- [ ] **Step 1: Add delta handling and finalize on `message`**

Edit `examples/demo/public/chat.js`. Find:

```js
  const toolCards = new Map();
  let assistantEl = null;
  let errorShown = false;
```

Replace with:
```js
  const toolCards = new Map();
  let assistantEl = null;
  let assistantBuf = "";
  let errorShown = false;
```

Then find the `handleEvent` function's switch:

```js
      case "tool:start": {
        assistantEl = null;
```

Replace (the whole `case "tool:start"` block) with:
```js
      case "tool:start": {
        // A tool call interrupts the current assistant bubble; next text
        // belongs to a fresh bubble for the post-tool turn.
        assistantEl = null;
        assistantBuf = "";
```

Then find:

```js
      case "message": {
        if (
          event.message?.role === "assistant" &&
          typeof event.message.content === "string" &&
          event.message.content.length > 0
        ) {
          if (!assistantEl) assistantEl = addAssistantMessage();
          renderMarkdown(assistantEl, event.message.content);
          scroll();
        }
        break;
      }
```

Replace with:
```js
      case "message:delta": {
        if (typeof event.text !== "string" || event.text.length === 0) break;
        if (!assistantEl) {
          assistantEl = addAssistantMessage();
          assistantBuf = "";
        }
        assistantBuf += event.text;
        renderMarkdown(assistantEl, assistantBuf);
        scroll();
        break;
      }
      case "message": {
        // The full assistant message. If we rendered deltas, the bubble is
        // already up-to-date — just reset state for the next turn. If for
        // some reason no deltas arrived (e.g. non-streaming fallback), fall
        // through to render the whole content here.
        if (
          event.message?.role === "assistant" &&
          typeof event.message.content === "string" &&
          event.message.content.length > 0 &&
          assistantBuf.length === 0
        ) {
          if (!assistantEl) assistantEl = addAssistantMessage();
          renderMarkdown(assistantEl, event.message.content);
          scroll();
        }
        assistantEl = null;
        assistantBuf = "";
        break;
      }
```

- [ ] **Step 2: Commit**

```bash
git add examples/demo/public/chat.js
git commit -m "feat(demo): render message:delta events for token-by-token UI"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no errors, `dist/` emitted.

- [ ] **Step 4: Manual demo smoke test**

Start the demo server (details in `examples/demo/server.ts`; typically `npm run demo` or equivalent — check `package.json`). Open the browser, send a message, confirm:

1. Text appears progressively character-by-character rather than in one jump.
2. A tool-calling prompt (e.g. one that triggers a registered tool) produces a tool card mid-response and then continues streaming the post-tool reply.
3. Errors, aborts, and session continuity still work.

If the manual check reveals issues, file them and iterate before closing.

- [ ] **Step 5: Final commit (only if there are outstanding changes)**

Most tasks commit their own changes; this step exists as a catch-all for any stray fixes from the smoke test.

```bash
git status
# If clean, skip. Otherwise:
git add -A
git commit -m "fix: follow-ups from manual demo smoke test"
```

---

## Self-Review Notes

- **Spec coverage:** Public API (Task 7), transport (Tasks 1-3), loop (Task 5), event type (Task 4), AgentRun semantics (Task 6), session busy synchronous throw (Task 7/8), demo backend (Task 8), demo frontend (Task 9), tool-call argument deltas out of scope (implicit — we accumulate but don't emit per-delta). All spec sections map to tasks.
- **Type consistency:** `ToolCallDelta`, `CompletionChunk`, `StreamingChoice` defined in Task 2 and reused consistently in Tasks 3, 5, 6, 7. `AgentRun` class API matches the spec's `interface AgentRun`. `mockCompletionChunks` / `mockChunkStream` names are stable across Task 5 and Task 7.
- **No placeholders:** Each code step shows complete code. No "fill in the rest" or "handle edge cases." Exact `git commit` messages and exact `npm` commands in every run step.
- **Deferred follow-ups** (from project memory): `Agent.run` still filters `agent:end` by outer runId (preserved in `AgentRun`). `runLoop` / `Agent.run` dedup concerns are naturally addressed by Task 7 collapsing to one method.
