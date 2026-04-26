# Event Helpers (`src/helpers/`)

The `helpers` folder is the consumer-facing surface for working with [`Agent`](../../src/agent/index.ts) runs after they have been kicked off. It groups four concerns: **display fallbacks** (`defaultDisplay`, `displayOf`) so any `AgentEvent` can be rendered without exhaustive switching; **event consumption** (`consumeAgentEvents`, `streamText`) for typed dispatch and plain-text streaming; an **NDJSON streaming codec** (`serializeEvent`, `serializeEventsAsNDJSON`, `readEventStream`) that is resilient to mid-stream failures via synthetic error events; and **HTTP adapters** at two levels — low-level pipes for Node `ServerResponse` and Web `Response`, and high-level handlers (`handleAgentRun`, `handleAgentRunWebResponse`) that fold in `agent.run` invocation, abort wiring on transport close, and `SessionBusyError` → 409 mapping. Nothing in this folder participates in the agent loop itself; it only adapts loop output for transport and rendering.

## Imports

All exports listed below are re-exported from the package root (see `src/index.ts:259-262`). Consumers should import from `@sftinc/openrouter-agent`:

```ts
import {
  defaultDisplay,
  displayOf,
  consumeAgentEvents,
  streamText,
  serializeEvent,
  serializeEventsAsNDJSON,
  readEventStream,
  pipeEventsToNodeResponse,
  eventsToWebResponse,
  handleAgentRun,
  handleAgentRunWebResponse,
} from "@sftinc/openrouter-agent";

import type {
  AgentEventHandlers,
  NodeResponseLike,
  ResponseAdapterOptions,
  HandleAgentRunOptions,
  HandleAgentRunNodeOptions,
  AgentEvent,
  EventDisplay,
  Message,
} from "@sftinc/openrouter-agent";
```

The folder's own barrel is at `src/helpers/index.ts:1-18`. `defaultDisplay` itself lives in `src/agent/events.ts:262` and is re-exported through the helpers barrel for ergonomic co-location with `displayOf`.

---

## 1. Display

### `defaultDisplay(event)`

Source: `src/agent/events.ts:262`. Re-exported via `src/helpers/index.ts:11`.

Computes a sensible `{ title, content? }` for any `AgentEvent` variant, used as the fallback when no upstream layer (agent, tool) attached its own `display`.

**Signature**

```ts
function defaultDisplay(event: AgentEvent): EventDisplay;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `event` | `AgentEvent` | yes | — | Any event from the loop. The function is exhaustive over every variant. |

**Returns** — `EventDisplay` (`{ title: string; content?: string }`). Per-variant output:

| Event variant | `title` | `content` |
| --- | --- | --- |
| `agent:start` | `` `Starting ${event.agentName}` `` | — |
| `agent:end` (success) | `` `Completed in ${seconds}s` `` (min 1s) | — |
| `agent:end` (errored) | `` `Completed with errors in ${seconds}s` `` | — |
| `message:delta` | `"Message delta"` | — |
| `message` | `"Message"` | — |
| `tool:start` | `` `Running ${event.toolName}` `` | — |
| `tool:progress` | `` `Still running (${Math.round(event.elapsedMs / 1000)}s)` `` | — |
| `tool:end` (success) | `` `Completed tool in ${seconds}s` `` (min 1s) | — |
| `tool:end` (error) | `` `Tool failed after ${seconds}s` `` | — |
| `error` | `"Error"` | `event.error.message` |

**Errors** — none.

**Side effects** — none; pure.

**Example**

```ts
import { defaultDisplay } from "@sftinc/openrouter-agent";

const { title } = defaultDisplay({
  type: "tool:start",
  runId: "r1",
  toolName: "calculator",
  callId: "c1",
  args: { expression: "1+1" },
});
console.log(title); // "Running calculator"
```

> Most callers should prefer `displayOf` because it transparently honors any explicit `event.display` set by tools or the agent.

---

### `displayOf(event)`

Source: `src/helpers/displayOf.ts:31`.

Resolves the display payload for an event by preferring `event.display` and falling back to `defaultDisplay(event)`. Provided so callers cannot accidentally drop the SDK fallback (e.g. by writing `event.display ?? null`).

**Signature**

```ts
function displayOf(event: AgentEvent): EventDisplay;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `event` | `AgentEvent` | yes | — | Any event from a run. |

**Returns** — `EventDisplay`, never `null` or `undefined`.

**Errors** — none.

**Side effects** — none; pure.

**Example**

```ts
import { displayOf } from "@sftinc/openrouter-agent";

for await (const event of agent.run("hello")) {
  const { title, content } = displayOf(event);
  console.log(title, content ?? "");
}
```

---

## 2. Consumption

### `consumeAgentEvents(source, handlers)`

Source: `src/helpers/consumeEvents.ts:68`.

Typed dispatcher that walks an `AsyncIterable<AgentEvent>` and routes each event to the handler matching its `type`. Removes per-call `switch (event.type)` boilerplate while preserving full TypeScript narrowing on each handler's parameter.

**Signature**

```ts
function consumeAgentEvents(
  source: AsyncIterable<AgentEvent>,
  handlers: AgentEventHandlers,
): Promise<void>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | `AsyncIterable<AgentEvent>` | yes | — | Typically `agent.run(...)`, an HTTP NDJSON parse loop, or a buffered replay. Iteration is sequential; back-pressure is preserved. |
| `handlers` | `AgentEventHandlers` | yes | — | Per-variant handlers plus an optional catch-all. All fields are optional; events without a matching handler are skipped silently. |

**Returns** — `Promise<void>` that resolves once `source` completes normally and every awaited handler has finished.

**Errors thrown** — rejects if any handler throws (sync or async) or if `source` itself throws. Iteration stops at the first throw.

**Side effects** — none of its own; whatever the handlers do.

**Behavior notes**
- Handlers may be sync or async; each is `await`-ed before the next event is pulled from the source.
- `onAny` runs **after** the matching typed handler, on every event.
- The internal `switch` performs an exhaustiveness check against `never`, so adding a new `AgentEvent` variant without updating both the switch and `AgentEventHandlers` is a TypeScript compile error.

**Example**

```ts
import { consumeAgentEvents } from "@sftinc/openrouter-agent";

await consumeAgentEvents(agent.run("hello"), {
  onAgentStart: () => console.log("Thinking..."),
  onToolStart:  (e) => console.log("->", e.toolName),
  onToolEnd:    (e) => console.log("done", e.elapsedMs, "ms"),
  onAgentEnd:   (e) => console.log("stop:", e.result.stopReason),
  onAny:        (e) => telemetry.record(e),
});
```

---

### `interface AgentEventHandlers`

Source: `src/helpers/consumeEvents.ts:20-45`.

Per-variant typed handlers consumed by `consumeAgentEvents`. All fields are optional.

| Field | Type | Description |
| --- | --- | --- |
| `onAgentStart` | `(e: Extract<AgentEvent, { type: "agent:start" }>) => void \| Promise<void>` | Called once at the start of a run. |
| `onAgentEnd` | `(e: Extract<AgentEvent, { type: "agent:end" }>) => void \| Promise<void>` | Called once at the end of a run with the final `Result`. |
| `onMessage` | `(e: Extract<AgentEvent, { type: "message" }>) => void \| Promise<void>` | Called once per assistant message (including tool-call messages). |
| `onMessageDelta` | `(e: Extract<AgentEvent, { type: "message:delta" }>) => void \| Promise<void>` | Called for each streamed text delta from the assistant. |
| `onToolStart` | `(e: Extract<AgentEvent, { type: "tool:start" }>) => void \| Promise<void>` | Called once when a tool invocation begins. |
| `onToolProgress` | `(e: Extract<AgentEvent, { type: "tool:progress" }>) => void \| Promise<void>` | Called when a tool emits a manual progress signal via `deps.emit`. |
| `onToolEnd` | `(e: Extract<AgentEvent, { type: "tool:end" }>) => void \| Promise<void>` | Called once when a tool invocation ends (success or failure). |
| `onError` | `(e: Extract<AgentEvent, { type: "error" }>) => void \| Promise<void>` | Called when a fatal run error occurs. Always precedes `agent:end` with `stopReason: "error"`. Emitted at most once per run. |
| `onAny` | `(e: AgentEvent) => void \| Promise<void>` | Catch-all that runs **after** any matching typed handler, useful for logging/telemetry. |

---

### `streamText(source)`

Source: `src/helpers/streamText.ts:30`.

Async iterable of assistant text. Yields each non-empty `message:delta.text` chunk as it arrives. If the stream completes without ever emitting a delta but a final assistant `message` carries string content, yields that content as a single trailing chunk (covers non-streaming providers).

**Signature**

```ts
function streamText(source: AsyncIterable<AgentEvent>): AsyncIterable<string>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | `AsyncIterable<AgentEvent>` | yes | — | Any agent event stream — typically `agent.run(...)`. |

**Returns** — `AsyncIterable<string>`. Empty deltas are skipped. Tool calls and reasoning content are not yielded.

**Errors thrown** — propagates whatever `source` throws.

**Side effects** — none.

**Example**

```ts
import { streamText } from "@sftinc/openrouter-agent";

for await (const chunk of streamText(agent.run("hello"))) {
  process.stdout.write(chunk);
}
```

---

## 3. NDJSON codec

The wire format is one JSON object per line, terminated with `\n`. Both response adapters delegate body production to `serializeEventsAsNDJSON`, so this file is the format's source of truth (`src/helpers/ndjson.ts:1-13`).

**Synthetic error events.** When iteration fails mid-stream, the codec emits an event using the same shape as the loop's `error` variant, so existing consumers render it without special handling:

| Origin | `runId` | When |
| --- | --- | --- |
| `serializeEventsAsNDJSON` | `"server"` | Source `AsyncIterable` throws during iteration. |
| `readEventStream` | `"client"` | A non-blank line fails `JSON.parse`. |

### `serializeEvent(event)`

Source: `src/helpers/ndjson.ts:31`.

Encode a single event as one JSON line. The result contains no embedded newlines and **no trailing newline** — the caller is responsible for framing if needed.

**Signature**

```ts
function serializeEvent(event: AgentEvent): string;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `event` | `AgentEvent` | yes | — | Event to encode. |

**Returns** — `string` (a single JSON object, no `\n`).

**Errors thrown** — anything `JSON.stringify` would throw (e.g. cyclic structures). The loop never produces such events.

**Side effects** — none.

**Example**

```ts
import { serializeEvent } from "@sftinc/openrouter-agent";

const line = serializeEvent({ type: "message:delta", runId: "r1", text: "hi" });
// '{"type":"message:delta","runId":"r1","text":"hi"}'
```

---

### `serializeEventsAsNDJSON(source)`

Source: `src/helpers/ndjson.ts:54`.

Convert an event stream into NDJSON-framed text lines. Each yielded string ends with `\n`. **Does not re-throw** if `source` throws mid-iteration; instead yields a synthetic `{ type: "error", runId: "server", error: { message } }` line and completes normally.

**Signature**

```ts
function serializeEventsAsNDJSON(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<string>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | `AsyncIterable<AgentEvent>` | yes | — | Any agent event stream. |

**Returns** — `AsyncIterable<string>`. Each item is one JSON object plus a trailing `\n`.

**Errors thrown** — never throws for a source error; every other failure mode (e.g. consumer cancellation) follows the standard async-iterator semantics.

**Side effects** — none.

**Example**

```ts
import { serializeEventsAsNDJSON } from "@sftinc/openrouter-agent";

for await (const line of serializeEventsAsNDJSON(agent.run("hello"))) {
  res.write(line); // each line is a complete JSON object followed by \n
}
```

---

### `readEventStream(body)`

Source: `src/helpers/ndjson.ts:94`.

Parse an NDJSON byte stream back into `AgentEvent`s. Splits on `\n`, skips blank/whitespace-only lines, and parses each remaining line with `JSON.parse`. Lines that fail to parse yield a synthetic `{ type: "error", runId: "client", error: { message } }` event so a single malformed line never aborts iteration. Uses `TextDecoder` with `{ stream: true }` so multi-byte characters spanning chunk boundaries are handled correctly; any trailing partial line is parsed at end-of-stream if non-blank.

**Signature**

```ts
function readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AgentEvent>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `body` | `ReadableStream<Uint8Array>` | yes | — | Typically `response.body` from a `fetch` call against an NDJSON endpoint. |

**Returns** — `AsyncIterable<AgentEvent>`. Output is in line order. Malformed lines surface as synthetic `error` events with `runId: "client"`.

**Errors thrown** — does not throw on parse errors. Underlying I/O errors from `body.getReader().read()` propagate.

**Side effects** — calls `body.getReader()`, locking the stream for the lifetime of iteration.

**Example: a browser fetch client**

```ts
import { readEventStream } from "@sftinc/openrouter-agent";

const response = await fetch("/api/agent", {
  method: "POST",
  body: JSON.stringify({ prompt: "hello" }),
});

for await (const event of readEventStream(response.body!)) {
  if (event.type === "message:delta") {
    document.querySelector("#out")!.textContent += event.text;
  } else if (event.type === "error") {
    console.error(event.runId, event.error.message);
  }
}
```

---

## 4. HTTP adapters (low-level)

Both adapters share `ResponseAdapterOptions` and delegate body production to `serializeEventsAsNDJSON`. Default headers are merged so caller values win on key collision (`src/helpers/responseAdapters.ts:62-66`):

```text
Content-Type: application/x-ndjson
Cache-Control: no-cache
X-Accel-Buffering: no
```

### `interface NodeResponseLike`

Source: `src/helpers/responseAdapters.ts:18-24`.

Structural type compatible with Node's `http.ServerResponse`. Defined inline so this module never imports `node:http` (preserving browser/Workers compatibility).

| Field | Type | Description |
| --- | --- | --- |
| `writeHead` | `(status: number, headers: Record<string, string>) => unknown` | Write the response status line and headers. Called once. |
| `write` | `(chunk: string \| Uint8Array) => boolean` | Write a chunk to the response body. |
| `end` | `() => void` | Finalize the response. Called from a `finally` block by `pipeEventsToNodeResponse`. |
| `on` | `(event: "close" \| "error", listener: (err?: Error) => void) => unknown` | Register transport listeners. The `close` listener wires abort on client disconnect; the `error` listener wires abort on socket-level write errors before `close` arrives. |
| `writableEnded` | `boolean` (readonly) | Truthy after `end()` has been called; consulted on the `close` listener to avoid aborting a clean run. |

Express, Fastify, and Node's built-in `http.ServerResponse` all satisfy this interface.

---

### `interface ResponseAdapterOptions`

Source: `src/helpers/responseAdapters.ts:29-44`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `abort` | `AbortController` | optional | `undefined` | If supplied, the adapter calls `abort.abort()` when the underlying transport closes/cancels before iteration completes. **Caller is responsible** for passing `abort.signal` into `agent.run(...)`. |
| `headers` | `Record<string, string>` | optional | `{}` | Headers merged on top of the NDJSON defaults. Caller values win on key collisions. |
| `status` | `number` | optional | `200` | HTTP status code for the response. |

---

### `pipeEventsToNodeResponse(source, res, options?)`

Source: `src/helpers/responseAdapters.ts:91`.

Stream events as NDJSON to a Node response-shaped object. Sets default headers, writes one line per event, and **always** calls `res.end()` in a `finally`. If `options.abort` is provided, hooks both `res.on('close')` and `res.on('error', ...)` so a client disconnect or socket-level write error triggers `abort.abort()` (each guarded by a one-shot check on `writableEnded` / `signal.aborted`).

Internally, each call to `iter.next()` is raced against an abort promise so the loop terminates promptly on disconnect rather than waiting for the next event from the source.

**Signature**

```ts
function pipeEventsToNodeResponse(
  source: AsyncIterable<AgentEvent>,
  res: NodeResponseLike,
  options?: ResponseAdapterOptions,
): Promise<void>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | `AsyncIterable<AgentEvent>` | yes | — | Typically `agent.run(...)`. |
| `res` | `NodeResponseLike` | yes | — | The response object to write to. |
| `options` | `ResponseAdapterOptions` | optional | `{}` | See above. |

**Returns** — `Promise<void>` resolving when the response has ended.

**Errors thrown** — does not re-throw source iteration failures (they are converted to a synthetic error line by `serializeEventsAsNDJSON`). Underlying socket errors from `res.write` may propagate.

**Side effects**
- Calls `res.writeHead(status, headers)` exactly once.
- Calls `res.write(line)` per event.
- Attaches a `close` listener via `res.on('close', ...)` if `abort` is supplied (single listener, one-shot semantics gated by `writableEnded` / `signal.aborted`).
- Attaches an `error` listener via `res.on('error', ...)` if `abort` is supplied, with the same one-shot guard, so socket-level write errors abort the run even when no `close` event fires first.
- Calls `res.end()` in a `finally` block.
- May invoke `options.abort.abort()` on transport close or transport error.

**Example: Express handler**

```ts
import express from "express";
import { pipeEventsToNodeResponse } from "@sftinc/openrouter-agent";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const abort = new AbortController();
  const stream = agent.run(req.body.message, { signal: abort.signal });
  await pipeEventsToNodeResponse(stream, res, { abort });
});

app.listen(3000);
```

---

### `eventsToWebResponse(source, options?)`

Source: `src/helpers/responseAdapters.ts:144`.

Build a Web `Response` whose body is an NDJSON `ReadableStream<Uint8Array>`. Suitable for Cloudflare Workers, Deno, Bun, and any `fetch`-style handler. Pulls from `serializeEventsAsNDJSON` lazily inside the stream's `pull` method, encoding each line via `TextEncoder`.

If `options.abort` is provided, the stream's `cancel()` calls `abort.abort()` so a client disconnect propagates into the run.

**Signature**

```ts
function eventsToWebResponse(
  source: AsyncIterable<AgentEvent>,
  options?: ResponseAdapterOptions,
): Response;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | `AsyncIterable<AgentEvent>` | yes | — | Any agent event stream. |
| `options` | `ResponseAdapterOptions` | optional | `{}` | See above. |

**Returns** — A `Response` with the merged headers, the supplied (or default `200`) status, and an NDJSON streaming body. Returned synchronously; iteration starts when the consumer reads the body.

**Errors thrown** — none synchronously. Source errors surface as synthetic NDJSON `error` lines.

**Side effects** — may call `options.abort.abort()` when the returned stream is cancelled.

**Example: Cloudflare Worker / Deno / Bun**

```ts
import { eventsToWebResponse } from "@sftinc/openrouter-agent";

export default {
  async fetch(req: Request): Promise<Response> {
    const { message } = await req.json();
    const abort = new AbortController();
    const stream = agent.run(message, { signal: abort.signal });
    return eventsToWebResponse(stream, { abort });
  },
};
```

---

## 5. HTTP handlers (high-level)

These wrappers compose `agent.run` invocation, abort-on-close wiring, optional session-id echoing, and `SessionBusyError` → 409 mapping into a single call. Drop down to the low-level adapters when you need custom logic between request receipt and stream start.

> **Note on `agent.run`.** The handlers cast the return of `agent.run` to `AsyncIterable<AgentEvent>` (`src/helpers/http.ts:89,161`). `agent.run` returns an `AgentRun` handle that is *both* `PromiseLike<Result>` and `AsyncIterable<AgentEvent>`; these handlers consume the iterable shape to stream NDJSON to the response.

### `interface HandleAgentRunOptions`

Source: `src/helpers/http.ts:20-34`.

Options shared by the Node and Web variants.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | `string` | optional | `undefined` | Forwarded to `agent.run({ sessionId })` and echoed in the response header (when enabled). |
| `echoSessionHeader` | `boolean` | optional | `true` | When truthy and `sessionId` is set, echoes the id back as a response header. |
| `sessionHeaderName` | `string` | optional | `"X-Session-Id"` | Name of the echoed session header. |
| `headers` | `Record<string, string>` | optional | `{}` | Extra response headers merged on top of the NDJSON defaults (and on top of the session header). |
| `runOptions` | `Omit<AgentRunOptions, "sessionId" \| "signal">` | optional | `undefined` | Per-run options forwarded to `agent.run`. `sessionId` and `signal` are managed by the wrapper and excluded from this shape. |

### `interface HandleAgentRunNodeOptions extends HandleAgentRunOptions`

Source: `src/helpers/http.ts:39-46`.

Node-only superset that adds a `SessionBusyError` hook.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `onSessionBusy` | `(err: SessionBusyError, res: NodeResponseLike) => void` | optional | `undefined` | Called instead of the default 409 response when `agent.run` synchronously throws `SessionBusyError`. The handler is responsible for writing a complete response (status, headers, body, end). |

---

### `handleAgentRun(agent, input, res, options?)`

Source: `src/helpers/http.ts:70`.

Stream an agent run to a Node response. Internally:

1. Creates an internal `AbortController`.
2. Calls `agent.run(input, { sessionId, signal: abort.signal, ...runOptions })`.
3. On synchronous `SessionBusyError`: invokes `onSessionBusy` if set, otherwise writes `409` with `Content-Type: application/json` and body `{ "error": "session busy", "sessionId": <id> }` and ends the response. The session header is included if echoing is enabled.
4. On any other synchronous throw from `agent.run`: re-throws (the caller's framework handles it).
5. Otherwise delegates to `pipeEventsToNodeResponse` with the merged session/extra headers and the internal `abort` controller — which means a client disconnect will abort the run.

**Signature**

```ts
function handleAgentRun(
  agent: Agent,
  input: string | Message[],
  res: NodeResponseLike,
  options?: HandleAgentRunNodeOptions,
): Promise<void>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `agent` | `Agent` | yes | — | The agent to run. |
| `input` | `string \| Message[]` | yes | — | User prompt or full message array. |
| `res` | `NodeResponseLike` | yes | — | Node response-shaped object. |
| `options` | `HandleAgentRunNodeOptions` | optional | `{}` | See tables above. |

**Returns** — `Promise<void>` that resolves once the response has ended (whether via the success path or the 409 path).

**Errors thrown** — re-throws any synchronous error from `agent.run` other than `SessionBusyError`. `pipeEventsToNodeResponse` does not surface source iteration failures (they become synthetic NDJSON `error` lines).

**Side effects**
- Writes the full HTTP response (status, headers, body, `end()`).
- Creates an `AbortController` and passes its `signal` into `agent.run`.
- Attaches a `close` listener to `res` (via the inner adapter) so a client disconnect aborts the run.
- May echo the session header.

**Example: Express handler**

```ts
import express from "express";
import { handleAgentRun } from "@sftinc/openrouter-agent";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  await handleAgentRun(agent, req.body.message, res, {
    sessionId: req.body.sessionId,
    runOptions: { maxTurns: 8 },
  });
});

app.listen(3000);
```

**Example: Fastify handler**

```ts
import Fastify from "fastify";
import { handleAgentRun } from "@sftinc/openrouter-agent";

const app = Fastify();

app.post("/chat", async (request, reply) => {
  // Detach Fastify's default reply lifecycle; we own the raw response.
  reply.hijack();
  await handleAgentRun(agent, request.body.message, reply.raw, {
    sessionId: request.body.sessionId,
  });
});

app.listen({ port: 3000 });
```

**Example: custom busy handler**

```ts
await handleAgentRun(agent, body.message, res, {
  sessionId: body.sessionId,
  onSessionBusy: (err, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.write(JSON.stringify({ error: "rate limited", sessionId: err.sessionId }));
    res.end();
  },
});
```

---

### `handleAgentRunWebResponse(agent, input, options?)`

Source: `src/helpers/http.ts:143`.

Web counterpart of `handleAgentRun`. Returns a `Response` to send back. On synchronous `SessionBusyError`, returns a 409 `Response` with `Content-Type: application/json` and body `{ "error": "session busy", "sessionId": <id> }` (plus the optional session-id header). Other synchronous errors from `agent.run` propagate as a rejected promise.

There is no `onSessionBusy` hook in the Web variant — callers wanting custom busy handling can `try { await ... } catch` and inspect, or call `agent.run` themselves and use `eventsToWebResponse` directly.

**Signature**

```ts
function handleAgentRunWebResponse(
  agent: Agent,
  input: string | Message[],
  options?: HandleAgentRunOptions,
): Promise<Response>;
```

**Parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `agent` | `Agent` | yes | — | The agent to run. |
| `input` | `string \| Message[]` | yes | — | User prompt or full message array. |
| `options` | `HandleAgentRunOptions` | optional | `{}` | See table above. |

**Returns** — `Promise<Response>`. The successful path returns a `Response` whose body streams NDJSON; the busy path returns a 409 `Response`.

**Errors thrown** — rejects on any synchronous `agent.run` error except `SessionBusyError`.

**Side effects** — creates an `AbortController` whose `signal` is passed into `agent.run`; the returned stream's `cancel()` aborts that controller (wired through `eventsToWebResponse`).

**Example: Cloudflare Worker / Deno / Bun**

```ts
import { handleAgentRunWebResponse } from "@sftinc/openrouter-agent";

export default {
  async fetch(req: Request): Promise<Response> {
    const { message, sessionId } = await req.json();
    return handleAgentRunWebResponse(agent, message, { sessionId });
  },
};
```

**Example: Next.js App Router (`app/api/chat/route.ts`)**

```ts
import { handleAgentRunWebResponse } from "@sftinc/openrouter-agent";
import { agent } from "@/lib/agent";

export async function POST(req: Request): Promise<Response> {
  const { message, sessionId } = await req.json();
  return handleAgentRunWebResponse(agent, message, {
    sessionId,
    headers: { "Cache-Control": "no-store" },
  });
}
```

**Example: matching browser client**

```ts
import { readEventStream, displayOf } from "@sftinc/openrouter-agent";

const response = await fetch("/api/chat", {
  method: "POST",
  body: JSON.stringify({ message: "hello", sessionId: "user-42" }),
});

if (response.status === 409) {
  console.warn("session busy");
} else {
  for await (const event of readEventStream(response.body!)) {
    const { title, content } = displayOf(event);
    console.log(title, content ?? "");
  }
}
```
