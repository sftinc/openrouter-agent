# Unified `run` with Optional Event Streaming

## Problem

Today `Agent` exposes two entry points:

- `Agent.run(input, options): Promise<Result>` — returns the final result; silently discards every event the loop emits.
- `Agent.runStream(input, options): AsyncIterable<AgentEvent>` — yields every event; callers who want the final `Result` must fish it out of `agent:end`.

Two problems follow:

1. **No token streaming anywhere.** `OpenRouterClient.complete` is hardcoded `stream: false`. Even `runStream` emits the assistant `message` event only at the end of each turn, so the demo UI (`examples/demo/public/chat.js`) renders each assistant turn in one jump rather than character-by-character.
2. **Asymmetric access.** If you pick `run`, you have no hook for events. If you pick `runStream`, the common "just give me the result" case becomes ceremony.

## Goal

One entry point. Events always generated internally. The caller chooses per call whether to consume the final `Result`, the event stream, or both — with the common path (`await agent.run(input)`) unchanged from today.

## Design

### Public API

```ts
interface AgentRun extends PromiseLike<Result>, AsyncIterable<AgentEvent> {
  readonly result: Promise<Result>;
}

class Agent<Input = { input: string }> extends Tool<Input> {
  run(input: string | Message[], options?: AgentRunOptions): AgentRun;
}
```

`runStream` is removed.

**Consumption styles:**

```ts
// Result only — identical ergonomics to today's run().
const result = await agent.run(input);

// Events only — identical ergonomics to today's runStream().
for await (const ev of agent.run(input)) { /* ... */ }

// Both — iterate events for live rendering, then read the final result.
const run = agent.run(input);
for await (const ev of run) render(ev);
const result = await run.result;
```

`run.result` and awaiting `run` directly resolve to the same `Result`. Both are safe to call multiple times (resolved value is memoized).

### `AgentRun` semantics

- **Single underlying run.** The loop is started eagerly when `agent.run(...)` is called. Awaiting the handle or iterating it both observe the same in-flight run — they do not start a second one.
- **One iterator per handle.** `[Symbol.asyncIterator]()` may be called at most once per `AgentRun`. Calling it a second time throws. Typical usage attaches the iterator immediately after `agent.run(...)` returns, before any async work yields.
- **Event buffering.** Events emitted before the iterator is attached are buffered in order and delivered on the iterator's first `next()` calls. This means `for await (const ev of agent.run(input))` works correctly regardless of microtask timing: no events are lost. If no iterator is ever attached, events are discarded (but still accumulated into the final `Result`).
- **`await run` / `await run.result`** resolve to the final `Result` whether or not anyone iterated. Both accessors resolve to the same memoized value and may be awaited any number of times. Errors from the loop reject both the handle and the iterator's `next()`.
- **`SessionBusyError`** is thrown synchronously from `agent.run(...)` itself (before the `AgentRun` is returned), matching today's `run` behavior and preserving the demo's HTTP 409 path.
- **Abort semantics** are unchanged: `options.signal` aborts the underlying loop; the iterator closes cleanly; `await run` resolves with `stopReason: "aborted"` (does not reject).

### Transport layer

Add `OpenRouterClient.completeStream(request, signal)`:

```ts
completeStream(
  request: CompletionsRequest,
  signal?: AbortSignal,
): AsyncIterable<CompletionChunk>;
```

- POSTs with `stream: true`.
- Parses the SSE body (`data: {...}\n\n` frames, terminated by `data: [DONE]`).
- Yields `CompletionChunk` records containing incremental `delta.content`, incremental `delta.tool_calls` (array of `{ index, id?, function: { name?, arguments? } }`), and — on the final frame — `finish_reason`, `usage`, `id`, and optional `error`.

`complete` stays as-is; non-agent callers can still use the single-shot form.

### Loop layer

`runLoop` always uses `completeStream`. Per turn it:

1. Iterates chunks from `completeStream`.
2. Accumulates text into an assistant content buffer.
3. Accumulates tool-call deltas into a per-index tool-call buffer (id + name locked on first appearance; arguments string concatenated).
4. Emits `message:delta` events (see below) as text arrives.
5. On end-of-stream: assembles the final assistant `Message` (same shape it produces today), pushes it onto `messages`, and emits the existing `message` event.
6. Continues into tool execution / next turn exactly as today.

A cancellation or transport error inside `completeStream` surfaces the same way `complete` errors surface today (`stopReason: "error"` with the caught error, or `stopReason: "aborted"` if the signal fired).

### New event type

```ts
type AgentEvent =
  | { type: "agent:start"; ... }
  | { type: "agent:end"; ... }
  | { type: "message:delta"; runId: string; text: string }   // NEW
  | { type: "message"; ... }
  | { type: "tool:start"; ... }
  | { type: "tool:end"; ... }
  | { type: "error"; ... };
```

- `message:delta` carries only new text since the previous delta (not the accumulated buffer).
- Deltas are only emitted when there is text content. Empty chunks are dropped.
- Tool-call argument streaming is **out of scope for v1.** The existing `message` event continues to carry fully-assembled `tool_calls` at turn end.

### Session persistence

Unchanged. Persistence happens on clean terminal stop reasons, after the loop assembles the final assistant message — identical to today.

### Subagent behavior

Unchanged. A subagent forwards its events (including `message:delta`) through `deps.emit` to the parent, and the parent's `agent.run` correctly filters `agent:end` events by outer `runId` (per existing memory).

## Demo updates

### `examples/demo/backend.ts`

Minimal touch: the code calls `agent.runStream(...)` today and already iterates the result. Change the call site to `agent.run(...)` and iterate the same way — the `AgentRun` handle is an `AsyncIterable`, so the existing loop works unchanged. The first-event peek that surfaces `SessionBusyError` as HTTP 409 is preserved because `SessionBusyError` now throws synchronously from `agent.run(...)`; the peek logic can be simplified to wrap that call in a try/catch.

### `examples/demo/public/chat.js`

Add a case for `message:delta`:

```js
case "message:delta": {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg assistant";
    messagesEl.appendChild(currentAssistantEl);
    currentAssistantText = "";
  }
  currentAssistantText += event.text;
  renderMarkdown(currentAssistantEl, currentAssistantText);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  break;
}
```

Update the existing `case "message"` to finalize the current bubble (reset `currentAssistantEl` / `currentAssistantText` for the next turn) rather than re-rendering — the deltas already rendered the content. Tool cards and error handling are unchanged.

## Out of scope (v1)

- Tool-call argument deltas. Arguments continue to appear atomically on the `message` event.
- Reasoning/thinking token deltas. If/when OpenRouter's SSE exposes them, add a separate event type.
- Per-call opt-out of streaming transport. The transport is always SSE; callers who don't iterate simply ignore deltas.
- Changing the `Result` shape, session format, or any subagent contract.

## Testing

- Unit tests for `completeStream`: SSE parsing (text deltas, tool-call deltas across multiple chunks, `[DONE]`, usage on final frame, error frames, abort).
- `runLoop` tests: text accumulates across deltas into the final `message`; tool-call deltas assemble into `tool_calls`; `message:delta` ordering matches chunk ordering; abort mid-stream yields `stopReason: "aborted"`; transport error yields `stopReason: "error"`.
- `Agent.run` handle tests: `await run` and `for await (run)` against the same handle; iterating after end yields no events but `await` still resolves; `SessionBusyError` throws synchronously; memoized `result` can be awaited twice.
- Demo smoke test: token-by-token rendering visible in the browser during a multi-turn tool-calling run.
