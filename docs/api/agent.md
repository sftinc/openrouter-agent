# Agent Layer (`src/agent/`)

The Agent layer is the primary entry point of `@sftinc/openrouter-agent`. It owns the streaming run loop that drives the assistant ↔ tool conversation, emits a typed stream of structured events, persists conversation history through a pluggable `SessionStore`, and exposes a single dual-purpose handle (`AgentRun`) that is simultaneously awaitable for the final `Result` and async-iterable for every `AgentEvent`. The folder also exports the lower-level `runLoop` driver and the full event vocabulary so that consumers can build their own transports, persistence layers, or UI integrations on top of the same primitives.

## Imports

The canonical way to import the public surface is from the package root:

```ts
import {
  Agent,
  type AgentConfig,
  type AgentRunOptions,
  type AgentEvent,
  type AgentDisplayHooks,
  type EventDisplay,
  type EventEmit,
  type Result,
  type RetryConfig,
  defaultIsRetryable,
  SessionBusyError,
  setOpenRouterClient,
} from "@sftinc/openrouter-agent";
```

`RetryConfig` and `defaultIsRetryable` are technically owned by `src/openrouter/` (their primary documentation lives in [openrouter.md](./openrouter.md)) but are referenced throughout this page because they configure agent runs.

Within the package, the folder index re-exports everything (`src/agent/index.ts:17-22`):

| Symbol | Kind | Source |
| --- | --- | --- |
| `Agent` | class | `src/agent/Agent.ts:138` |
| `AgentConfig` | interface | `src/agent/Agent.ts:49` |
| `AgentRunOptions` | type alias | `src/agent/Agent.ts:107` |
| `AgentRun` | class | `src/agent/AgentRun.ts:28` |
| `runLoop` | function | `src/agent/loop.ts:579` |
| `RunLoopConfig` | interface | `src/agent/loop.ts:42` |
| `RunLoopOptions` | interface | `src/agent/loop.ts:83` |
| `AgentEvent` | discriminated union | `src/agent/events.ts:104` |
| `AgentDisplayHooks` | interface | `src/agent/events.ts:46` |
| `EventDisplay` | interface | `src/agent/events.ts:20` |
| `EventEmit` | type alias | `src/agent/events.ts:302` |

The `defaultDisplay` value-level helper is co-located in `src/agent/events.ts:262` but is re-exported from `@sftinc/openrouter-agent` via `src/helpers/`, not from this folder's index.

---

## `Agent` class

Defined at `src/agent/Agent.ts:138`. `Agent` extends `Tool`, so an `Agent` instance can be passed wherever a `Tool` is expected. That is how subagents work: drop one `Agent` into another `Agent`'s `tools` array and the parent will invoke it as a tool, with all child events bubbled into the parent's event stream via `deps.emit` (`src/agent/Agent.ts:182-192`).

### Constructor

```ts
new Agent<Input = { input: string }>(config: AgentConfig<Input>)
```

The constructor does the following work, in order:

1. Resolves `inputSchema` (default `z.object({ input: z.string() })` — `src/agent/Agent.ts:120`).
2. Calls `super(...)` to register a `Tool` whose `execute` runs a nested `runLoop`, forwarding child events to the parent via `deps.emit` and returning either `{ content: result.text }` or `{ error }` based on `result.stopReason` (`src/agent/Agent.ts:175-203`).
3. Stores the per-agent `client` overrides, `systemPrompt`, `tools`, `maxTurns`, `sessionStore`, and `display`.
4. Resolves the OpenRouter client via `getOpenRouterClient()` and falls back to `new OpenRouterClient({})` if no project-wide client has been registered (`src/agent/Agent.ts:211`).

### `AgentConfig<Input>` fields

Source: `src/agent/Agent.ts:49-90`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | `string` | yes | — | Tool name surfaced to parent agents. Must be unique within a tool set. |
| `description` | `string` | yes | — | Description surfaced to the LLM (and to humans) when this agent is used as a tool. |
| `client` | `LLMConfig` | no | `{}` | Per-agent OpenRouter overrides (model, temperature, provider routing, `reasoning`, `response_format`, `tool_choice`, `plugins`, ...). Merged on top of the global client defaults at run time. |
| `systemPrompt` | `string \| ((context: Record<string, unknown> \| undefined) => string)` | no | `undefined` | Default system prompt used for every run. Accepts a verbatim string or a function called with the run's `AgentRunOptions.context`; the function form is invoked once per LLM request so time-sensitive values (e.g. the user's local time) are re-evaluated each turn. Overridable per run via `AgentRunOptions.system`. |
| `tools` | `Tool<any>[]` | no | `[]` | Tools the agent may call. May contain other `Agent` instances to enable subagents. |
| `inputSchema` | `z.ZodType<Input>` | no | `z.object({ input: z.string() })` | Zod schema validating the tool-input shape **only when this agent is invoked as a tool by a parent**. Top-level callers pass `string \| Message[]` directly to `run()` and the schema is not consulted. |
| `maxTurns` | `number` | no | `10` | Maximum LLM-call/tool-execution cycles per run before the loop terminates with `stopReason: "max_turns"`. |
| `sessionStore` | `SessionStore` | no | `new InMemorySessionStore()` | Backing store for conversation history. The store is consulted only when the caller also passes `options.sessionId`. |
| `display` | `AgentDisplayHooks` | no | `undefined` | Optional display hooks that decorate `agent:start` and `agent:end` events with human-readable `display` payloads. See [`AgentDisplayHooks`](#agentdisplayhooks). |
| `asTool` | `{ metadata?: (result: Result, input: Input) => Record<string, unknown> \| undefined } \| undefined` | no | `undefined` | Customizations that fire only when this agent is invoked as a subagent by a parent. `asTool.metadata` computes structured metadata to attach to the outer `tool:end.metadata` field; called once after the inner run resolves. Receives the inner `Result` and the validated input args. Silently ignored when the agent runs at top level (`agent.run(...)` without a parent dispatching it). |
| `retry` | `RetryConfig` | no | `{ maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, idleTimeoutMs: 60_000, isRetryable: defaultIsRetryable }` | Retry policy for transient LLM-call failures. Retries are scoped to the **pre-first-content-delta** window per turn — once any `message:delta` has been emitted, a subsequent failure is committed (`stopReason: "error"`) and never retried. Set `maxAttempts: 1` to disable retries. See [Retry behavior](#retry-behavior) and [openrouter.md `RetryConfig`](./openrouter.md#retryconfig). |

**`display` bubble-up to outer tool events.** When this agent is invoked as a subagent (passed in another agent's `tools` array), the same `display` payload produced by these hooks is also attached to the parent's outer `tool:start` and `tool:end` events. Configure once, applies in both places. UIs that render only outer tool events (the common case) get the rich titles and content automatically. The inner `Result` is bound to its invocation via per-call `metadata` identity (a non-enumerable Symbol attachment), so a single child Agent shared as a tool across concurrent parent runs renders the right `Result` per parent — there is no shared closure that can be raced (`src/agent/Agent.ts:181-200`).

### `asTool.metadata` example

Surface token usage and source counts on the outer `tool:end` event so the parent UI can render a "researcher used N sources, M tokens" badge:

```ts
import { Agent } from "@sftinc/openrouter-agent";

const researcher = new Agent({
  name: "research_assistant",
  description: "Multi-step research session.",
  systemPrompt: "...",
  tools: [webSearch, currentTime],
  display: {
    /* rich hooks here also drive outer tool events */
  },
  asTool: {
    metadata: (result, input) => ({
      topic: input.input,
      stopReason: result.stopReason,
      turns: result.messages.filter((m) => m.role === "assistant").length,
      totalTokens: result.usage.total_tokens,
    }),
  },
});

const orchestrator = new Agent({
  name: "orchestrator",
  description: "...",
  tools: [researcher],
});
```

The model never sees `metadata`; it's a side-channel for the parent's UI / telemetry / billing.

### `agent.run(input, options?)`

Source: `src/agent/Agent.ts:252-266`.

```ts
run(input: string | Message[], options?: AgentRunOptions): AgentRun
```

The single run entry point. **There is no separate `runStream` method** — the returned `AgentRun` is both `PromiseLike<Result>` and `AsyncIterable<AgentEvent>`, so the same value supports both consumption styles (`src/agent/AgentRun.ts:28`).

**Behavior:**

- **Session reservation is synchronous.** If `options.sessionId` is provided and is already running on this `Agent` instance, `run` throws `SessionBusyError` **before** returning (`src/agent/Agent.ts:253`, `src/agent/Agent.ts:280-289`). Callers must wrap the call in `try/catch`, not `try { await ... } catch`.
- **Loop kicks off eagerly.** The underlying `runLoop` starts inside the `AgentRun` constructor; events buffer until consumed (`src/agent/AgentRun.ts:69-124`).
- **Session lock is released in `finally`.** Whether the run succeeds, errors, or aborts, the session id is freed when the run callback settles (`src/agent/Agent.ts:262-264`).

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string \| Message[]` | yes | A user prompt string (appended as a `user`-role message) **or** a full `Message[]` to seed the conversation. When an array is passed, an embedded `system` message overrides `AgentConfig.systemPrompt`, but `options.system` still wins over both (`src/agent/loop.ts:417-452`). |
| `options` | `AgentRunOptions` | no (defaults to `{}`) | Per-run overrides. See [`AgentRunOptions`](#agentrunoptions). |

**Returns:** `AgentRun` — see [`AgentRun`](#agentrun).

**Throws:**

- `SessionBusyError` — synchronously, if `options.sessionId` is already running on this `Agent` instance.

**Examples:**

```ts
import { Agent } from "@sftinc/openrouter-agent";

const agent = new Agent({
  name: "writer",
  description: "Drafts short prose.",
  systemPrompt: "You write concise haiku.",
});

// 1. Final result only.
const result = await agent.run("Write a haiku about rain.");
console.log(result.text, result.stopReason, result.usage);

// 2. Stream events with for-await.
for await (const ev of agent.run("Another haiku.")) {
  if (ev.type === "message:delta") process.stdout.write(ev.text);
  if (ev.type === "agent:end")     console.log("\n", ev.result.stopReason);
}

// 3. Both — iterate events and await result on the same handle.
const run = agent.run("One more.");
for await (const ev of run) {
  if (ev.type === "tool:start") console.log("→", ev.toolName);
}
const final = await run.result;
```

### `AgentRunOptions`

Source: `src/agent/Agent.ts:107-114`. Defined as `Omit<RunLoopOptions, "parentRunId"> & { parentRunId?: string }`, so the full shape is the union of the loop-level fields plus `parentRunId`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | `string` | no | `undefined` | If set, the run resumes the conversation persisted under this id (loaded from `AgentConfig.sessionStore`) and writes back on a clean terminal stop reason. Holding the same `sessionId` while another run is in flight throws `SessionBusyError` synchronously. |
| `system` | `string \| ((context: Record<string, unknown> \| undefined) => string)` | no | `undefined` | Override for the system prompt. Wins over both `AgentConfig.systemPrompt` and any embedded `system` message in `input`. Accepts a verbatim string or a function called with `AgentRunOptions.context`; invoked once per LLM request. (`src/agent/loop.ts:467-513`). |
| `signal` | `AbortSignal` | no | `undefined` | Cancellation signal. When aborted, the loop terminates with `stopReason: "aborted"` and **skips session persistence** so the same `input` can be safely retried. |
| `maxTurns` | `number` | no | `AgentConfig.maxTurns` (`10`) | Per-call override of the maximum LLM/tool turn count. |
| `client` | `LLMConfig` | no | `undefined` | Per-call OpenRouter overrides; merged on top of `AgentConfig.client` (`src/agent/loop.ts:590-593`). |
| `parentRunId` | `string` | no | `undefined` | If set, the resulting `agent:start` event reports this run as a child of `parentRunId`. Subagent invocations set this automatically inside the tool wrapper; explicit callers rarely need it. |
| `retry` | `RetryConfig` | no | inherits `AgentConfig.retry` | Per-call retry override. Merged field-by-field on top of the Agent default: any field unspecified here falls through to the Agent's `retry`, then to the built-in defaults. So `agent.run(input, { retry: { maxAttempts: 5 } })` uses 5 attempts and inherits `initialDelayMs`, `maxDelayMs`, `idleTimeoutMs`, and `isRetryable` from the Agent. |
| `context` | `Record<string, unknown>` | no | `undefined` | Caller-supplied data bag propagated verbatim into every `ToolDeps.context` for this run. Useful for threading per-request state (user id, timezone, tenant, etc.) into tool implementations without the LLM ever seeing it. Never sent to the model. When this agent invokes a subagent, the same `context` object is forwarded into the subagent's `runLoop` so tools at any depth of nesting observe the same value. |

### Context and dynamic system prompts

`agent.run()` accepts an optional `context` object that flows verbatim through every tool and subagent in the call tree. It is never sent to the LLM.

```ts
await agent.run("plan my day", {
  context: { timezone: "America/Los_Angeles", userId: "u_42" }
});
```

Tools read it via `deps.context`:

```ts
new Tool({
  name: "search_calendar",
  description: "...",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }, deps) => {
    const ctx = deps.context ?? {};
    return calendarApi.search({
      userId: ctx.userId as string,
      timezone: (ctx.timezone as string) ?? "UTC",
      query,
    });
  },
});
```

`systemPrompt` and the per-run `system` override accept a function that receives the same `context` and returns the rendered string:

```ts
new Agent({
  systemPrompt: (ctx) => {
    const tz = (ctx?.timezone as string) ?? "UTC";
    const now = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, dateStyle: "full", timeStyle: "long",
    }).format(new Date());
    return `You are an assistant. Local time: ${now} (${tz}).`;
  },
});
```

The function is called once per request to the LLM. `context` is caller-owned and immutable through the call tree — there is no per-tool or per-subagent override.

---

## `AgentRun`

Source: `src/agent/AgentRun.ts:28-207`. The dual-purpose handle returned by `Agent.run()`. Implements both `PromiseLike<Result>` and `AsyncIterable<AgentEvent>`.

| Member | Signature | Description |
| --- | --- | --- |
| `result` | `Promise<Result>` (getter) | Memoized promise for the final `Result`. Resolves when `agent:end` fires for the **outer** run id; rejects if the loop callback rejected, or if it settled without emitting a matching `agent:end` (`"run finished without agent:end event"`) (`src/agent/AgentRun.ts:107-110`). |
| `then(onfulfilled?, onrejected?)` | `PromiseLike<...>` | `PromiseLike` plumbing so `await run` is equivalent to `await run.result` (`src/agent/AgentRun.ts:145-150`). |
| `[Symbol.asyncIterator]()` | `AsyncIterator<AgentEvent>` | Returns an iterator over every emitted event in order. Buffered events drain first; subsequent `next()` calls block on emissions. **Single-consumer:** throws `Error("AgentRun iterator already attached; only one consumer supported")` on the second invocation (`src/agent/AgentRun.ts:165-169`). The iterator's `return()` is a no-op for the underlying run — cancellation must be done via `AbortSignal` (`src/agent/AgentRun.ts:200-204`). |

**Subagent runId filtering.** Because subagent runs forward all of their events through the parent's `deps.emit`, a single stream may contain interleaved `agent:start`/`agent:end` pairs from multiple runs. `AgentRun` records the first `agent:start.runId` it observes as the *outer* run id and only resolves `result` when an `agent:end` arrives whose `runId` matches that outer id (`src/agent/AgentRun.ts:85-95`). This is enforced; do not rely on emission order.

**Error propagation.** If the `start` callback rejects, the captured error rejects both `result` and the iterator's `next()`. Any pending `next()` resolver is woken so the iterator can rethrow synchronously on its next pull (`src/agent/AgentRun.ts:116-123`, `src/agent/AgentRun.ts:185-188`).

**Iterating with break/early-return.** The iterator's `return()` does not abort the underlying loop. If the consumer bails early via `break`, the run continues to completion in the background. To actually cancel, pass an `AbortSignal` via `AgentRunOptions.signal` and call `controller.abort()` (`src/agent/AgentRun.ts:196-204`).

---

## `AgentEvent` discriminated union

Source: `src/agent/events.ts:104-241`.

Every event carries a `runId: string`. Subagent-emitted events additionally carry the outer run's id on the `agent:start.parentRunId` field so consumers can reconstruct the run tree. Lifecycle order per run:

```
agent:start
  → ((retry* | message:delta* + message) | tool:start + tool:progress* + tool:end)*
  → error?
  → agent:end
```

`agent:end` is always the terminal event. `error` fires at most once per run, immediately before a terminal `agent:end` with `stopReason: "error"`. `retry` may fire zero or more times per turn, **only before** the turn's first `message:delta` (the retry window closes once any content has been emitted to the client). A turn that ultimately succeeds after retries emits its `retry` events first, then the normal `message:delta*` / `message`. A turn that exhausts the retry budget emits its retry events, then a single `error`, then `agent:end`.

### `agent:start`

Source: `src/agent/events.ts:105-121`. Fires once, immediately after the `runId` is assigned and before any session load or LLM call (`src/agent/loop.ts:595-602`).

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"agent:start"` | Discriminator. |
| `runId` | `string` | Unique id for this run. Stable for the lifetime of one `runLoop` invocation. Format `run-XXXX`. |
| `parentRunId` | `string \| undefined` | Run id of the enclosing parent run when this run is a subagent invocation; `undefined` for top-level runs. |
| `agentName` | `string` | Name of the agent being started, taken from `RunLoopConfig.agentName`. |
| `display` | `EventDisplay \| undefined` | Resolved display payload from the agent's `start` hook, if any. |
| `startedAt` | `number` | Wall-clock epoch ms captured when the event was emitted. |

### `agent:end`

Source: `src/agent/events.ts:122-137`. Fires once, last, with the final `Result`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"agent:end"` | Discriminator. |
| `runId` | `string` | Matches the prior `agent:start.runId`. |
| `result` | `Result` | Final result: `text`, `messages`, `stopReason`, `usage`, `generationIds`, `error?`. |
| `display` | `EventDisplay \| undefined` | Resolved display payload from the agent's `success` / `error` / `end` hook (see hook routing below). |
| `startedAt` | `number` | Wall-clock epoch ms when the run started (matches the prior `agent:start.startedAt`). |
| `endedAt` | `number` | Wall-clock epoch ms when the event was emitted. |
| `elapsedMs` | `number` | `endedAt - startedAt`. |

### `message:delta`

Source: `src/agent/events.ts:138-147`. Fires zero or more times per assistant turn as text tokens arrive from the streaming transport. `text` carries only the **new** text since the previous delta — it is **not** a cumulative buffer (`src/agent/loop.ts:694-697`). Does not fire for tool-call argument deltas.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"message:delta"` | Discriminator. |
| `runId` | `string` | Run id this delta belongs to. |
| `text` | `string` | Newly arrived text since the previous delta. |
| `display` | `EventDisplay \| undefined` | Optional display payload (the loop itself does not populate this). |

### `message`

Source: `src/agent/events.ts:148-157`. Fires once per assistant message (including assistant messages whose only content is `tool_calls`). Does **not** fire for `user`- or `tool`-role messages (`src/agent/loop.ts:737`).

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"message"` | Discriminator. |
| `runId` | `string` | Run id this message belongs to. |
| `message` | `Message` | The full assistant `Message` (`role: "assistant"`) as appended to the conversation, including `content` (string or `null`) and `tool_calls?`. |
| `display` | `EventDisplay \| undefined` | Reserved for future per-message display rendering; currently unused by the loop. |

### `tool:start`

Source: `src/agent/events.ts:158-173`. Fires when a tool invocation begins.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"tool:start"` | Discriminator. |
| `runId` | `string` | Run id this tool call belongs to. |
| `toolUseId` | `string` | Stable identifier for this tool invocation. Correlates with the matching `tool:end` and any `tool:progress`. Falls back to `tu-XXXX` when the model didn't supply an id (`src/agent/loop.ts:125-127`). |
| `toolName` | `string` | Name of the tool as registered on the agent. |
| `input` | `unknown` | Best-effort parsed JSON args. Falls back to `{}` if `JSON.parse` of the model's `arguments` string failed (`src/agent/loop.ts:325-329`). |
| `display` | `EventDisplay \| undefined` | Resolved display payload from the tool's `start` hook, if any. |
| `startedAt` | `number` | Wall-clock epoch ms when the event was emitted. |

### `tool:progress`

Source: `src/agent/events.ts:174-187`. **Optional.** Only fires when a tool emits one manually via `deps.emit`; the loop itself never produces this variant.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"tool:progress"` | Discriminator. |
| `runId` | `string` | Run id this tool call belongs to. |
| `toolUseId` | `string` | Identifier matching the originating `tool:start`. |
| `elapsedMs` | `number` | Milliseconds since the tool started, as reported by the tool. |
| `display` | `EventDisplay \| undefined` | Optional display payload supplied by the tool. |
| `startedAt` | `number` | Wall-clock epoch ms when the originating `tool:start` was emitted. |

### `tool:end` (success)

Source: `src/agent/events.ts:208-229`. Discriminate success vs failure with `"error" in event`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"tool:end"` | Discriminator. |
| `runId` | `string` | Run id this tool call belongs to. |
| `toolUseId` | `string` | Identifier matching the originating `tool:start`. |
| `toolName` | `string` | Name of the tool as registered on the agent. Mirrors the value on the originating `tool:start` so `tool:end` is self-describing without a `toolUseId` lookup. |
| `output` | `unknown` | Tool result content (the same value passed back to the model in the `tool` role message). |
| `metadata` | `Record<string, unknown> \| undefined` | Optional structured metadata returned by the tool, surfaced for telemetry/UI. |
| `display` | `EventDisplay \| undefined` | Resolved display payload from the tool's `success` hook, if any. |
| `startedAt` | `number` | Wall-clock epoch ms when the originating `tool:start` was emitted. |
| `endedAt` | `number` | Wall-clock epoch ms when this `tool:end` was emitted. |
| `elapsedMs` | `number` | `endedAt - startedAt`. |

### `tool:end` (error)

Source: `src/agent/events.ts:230-251`. Distinguished from the success variant by the presence of `error` (and the absence of `output`).

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"tool:end"` | Discriminator. |
| `runId` | `string` | Run id this tool call belongs to. |
| `toolUseId` | `string` | Identifier matching the originating `tool:start`. |
| `toolName` | `string` | Name of the tool as registered on the agent. For unregistered-tool errors this is the name the model attempted to call. |
| `error` | `string` | Human-readable error message; this same string is sent back to the model as the tool result. |
| `metadata` | `Record<string, unknown> \| undefined` | Optional structured metadata captured alongside the error. |
| `display` | `EventDisplay \| undefined` | Resolved display payload from the tool's `error` hook, if any. |
| `startedAt` | `number` | Wall-clock epoch ms when the originating `tool:start` was emitted. |
| `endedAt` | `number` | Wall-clock epoch ms when this `tool:end` was emitted. |
| `elapsedMs` | `number` | `endedAt - startedAt`. |

A `tool:end` error fires when: (a) the tool was not registered with the agent (`'tool "X" is not registered with this agent'`), (b) `inputSchema.parse` threw, or (c) `Tool.execute` threw / returned `{ error }` (`src/agent/loop.ts:341-352`).

### `retry`

Source: `src/agent/events.ts:243-262`. Fires **once per failed retryable attempt**, *after* the failure has been classified retryable and *before* the backoff sleep. Only fires while the turn's retry window is open (no `message:delta` emitted yet for this turn). The give-up after exhausting the budget does **not** emit a `retry` — it emits the existing `error` event, symmetric with how non-retryable failures end.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"retry"` | Discriminator. |
| `runId` | `string` | Run id this retry belongs to. |
| `turn` | `number` | Zero-based turn index within the run. |
| `attempt` | `number` | One-based; the attempt that just failed. The next attempt will be `attempt + 1`. |
| `delayMs` | `number` | Computed backoff delay until the next attempt, in milliseconds. Honors `Retry-After` (capped at `maxDelayMs`). |
| `error` | `{ code?: number; message: string; metadata?: Record<string, unknown> }` | The failure being retried. `code` is the HTTP status when the underlying error was an `OpenRouterError`; absent for transport-level errors. |
| `display` | `EventDisplay \| undefined` | Resolved display payload from `AgentDisplayHooks.retry`, if configured. |

Triggers (all must satisfy `isRetryable`, the per-turn retry budget must have remaining attempts, and the abort signal must not be set):
- `OpenRouterError` with retryable status (default predicate: `408`, `429`, `500`, `502`, `503`, `504`).
- Transport-level errors before headers (DNS, ECONNRESET, ECONNREFUSED, ETIMEDOUT, TLS).
- `StreamTruncatedError` (stream ends without `[DONE]` / terminal `finish_reason`) raised from the SSE consumer.
- `IdleTimeoutError` (no chunk within `idleTimeoutMs`) raised from the SSE consumer.
- Mid-stream `chunk.error` or `finish_reason: "error"` seen before any `message:delta` has been emitted (translated by the loop into a synthetic retryable error).

`AbortError` is **never** retryable. An abort during the backoff sleep gives up immediately and surfaces via the existing aborted path (`stopReason: "aborted"`, no `error` event, no `retry` event for the give-up).

### `error`

Source: `src/agent/events.ts:228-241`. Run-fatal error. Always immediately precedes an `agent:end` with `stopReason: "error"`. Fires at most once per run.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"error"` | Discriminator. |
| `runId` | `string` | Run id this error belongs to. |
| `error.code` | `number \| undefined` | Provider-supplied error code (typically an HTTP-style status). Present only when the provider returned one. |
| `error.message` | `string` | Always present. Human-readable description. |
| `display` | `EventDisplay \| undefined` | Reserved for future error-level display rendering; currently unused by the loop. |

Triggers: a chunk-level `sc.error` from the streaming completion, a thrown error during streaming, or `finish_reason === "error"` (`src/agent/loop.ts:702-723`, `src/agent/loop.ts:746-751`). Aborts do **not** emit `error`; they go straight to `agent:end` with `stopReason: "aborted"`.

---

## `AgentDisplayHooks`

Source: `src/agent/events.ts:46-75`. Optional hooks on `AgentConfig.display` that decorate `agent:start` / `agent:end` events with `display` payloads. Every hook is invoked under a `try/catch` so a buggy hook can't take down the run (`src/agent/loop.ts:202-208`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string \| ((input: string \| Message[]) => string)` | no | Default title for both `agent:start` and `agent:end`. The function form receives the original `agent.run()` input. Phase-specific hooks can override this by returning their own `title`. |
| `start` | `(input: string \| Message[]) => Partial<EventDisplay>` | no | Called when emitting `agent:start`. Receives the original `agent.run()` input. Return any subset of `EventDisplay` fields. |
| `success` | `(result: Result) => Partial<EventDisplay>` | no | Called when emitting `agent:end` with `stopReason === "done"`. Falls back to `end` if omitted. |
| `error` | `(result: Result) => Partial<EventDisplay>` | no | Called when emitting `agent:end` with `stopReason === "error"`. Falls back to `end` if omitted. |
| `end` | `(result: Result) => Partial<EventDisplay>` | no | Universal terminal-state hook. Used for `aborted`, `max_turns`, `length`, `content_filter`, and as the fallback for `done` / `error` when the dedicated hooks are absent. |
| `retry` | `(info: { turn: number; attempt: number; delayMs: number; error: { code?: number; message: string } }) => Partial<EventDisplay>` | no | Called when emitting a `retry` event. Receives the same data attached to the event. Use to render UI like `"Retrying… (attempt 2/3)"`. Optional, no built-in default. Falls back to `defaultDisplay` when omitted. `delayMs` is the *scheduled* backoff — if the run is aborted during the sleep, the next attempt will not actually fire and an `agent:end` with `stopReason: "aborted"` will follow. |

**Outcome routing for `agent:end`** (`src/agent/loop.ts:283-290`):

| `stopReason` | Hook tried | Fallback |
| --- | --- | --- |
| `"done"` | `success` | `end` |
| `"error"` | `error` | `end` |
| `"aborted"` | `end` | — |
| `"max_turns"` | `end` | — |
| `"length"` | `end` | — |
| `"content_filter"` | `end` | — |

If neither the chosen hook nor the `title` default produces a string `title`, no `display` field is attached to the event (`src/agent/loop.ts:256-270`).

## `EventDisplay`

Source: `src/agent/events.ts:20-30`. The pre-rendered, display-friendly representation attached to most events.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | yes | Human-readable single-line label for the event. |
| `content` | `unknown` | no | Optional payload to render alongside the title (error message, structured summary, markdown, ...). Type is intentionally `unknown`; consumers decide how to render based on context. |

## `EventEmit`

Source: `src/agent/events.ts:296-302`.

```ts
type EventEmit = (event: AgentEvent) => void
```

Synchronous, fire-and-forget callback that pushes events into a consumer (an `AgentRun` buffer or a parent agent's stream). Implementations must not throw. Tools receive an `EventEmit` via `deps.emit` so they can publish custom `tool:progress` events or surface other lifecycle markers.

---

## Loop semantics

Source: `src/agent/loop.ts:579-805`. `runLoop` is the lower-level driver behind `Agent.run`. Most consumers never call it directly, but its semantics define the agent's behavior end-to-end.

### Lifecycle

1. **`agent:start`** — emitted immediately with the assigned `runId`, before any I/O (`src/agent/loop.ts:595-602`).
2. **Session load** — if both `options.sessionId` and `config.sessionStore` are set, prior messages are read. `system`-role messages from the store are stripped (the system prompt is agent config, not conversation) (`src/agent/loop.ts:608-617`, `src/agent/loop.ts:436-440`).
3. **Initial messages** — built per `resolveInitialMessages` precedence (`options.system` > embedded `system` in `input` > `config.systemPrompt`). The system message is prepended only on the wire, never stored on the in-memory conversation list (`src/agent/loop.ts:619-622`).
4. **Turn loop**, up to `maxTurns`:
   - If `signal.aborted`, set `stopReason = "aborted"` and break.
   - Stream a completion (`config.openrouter.completeStream`). Per-chunk: accumulate text, emit `message:delta` per non-empty content, merge tool-call deltas into the per-index buffer, capture `finish_reason` and any chunk error.
   - On thrown stream error: if aborted, `stopReason = "aborted"`; otherwise `stopReason = "error"`, emit `error`, break.
   - Append the assembled assistant message and emit `message`.
   - On chunk-level error or `finish_reason === "error"`: `stopReason = "error"`, emit `error`, break.
   - On clean `finish_reason` (`stop` → `done`, `length` → `length`, `content_filter` → `content_filter`): set the mapped `stopReason`, break.
   - If no tool calls: `stopReason = "done"`, break.
   - Otherwise dispatch each tool call sequentially via `executeToolCall`, append `role: "tool"` messages, continue.
5. **Loop fall-through** — if the loop exited without setting `stopReason`, set `"max_turns"` (`src/agent/loop.ts:772`).
6. **Transactional persistence** — only on a clean terminal stop reason (`done`, `max_turns`, `length`, `content_filter`) is the conversation written back to the session store. On `error` or `aborted` the session is left exactly as it was, so the client can safely retry with the same input (`src/agent/loop.ts:777-784`).
7. **`agent:end`** — emitted last with the final `Result`, including `text` (last assistant text), `messages`, `stopReason`, accumulated `usage`, every observed `generationIds`, and `error?` (only when `stopReason === "error"`).

### `Result.messages`

Contains only the messages this run produced — the new user input, the assistant turns, and the `role: "tool"` results from this run's tool calls. Prior session history is **not** included; read it from `sessionStore.get(sessionId)` if needed. The session store still receives the full updated transcript on persist; only the live `Result` object is trimmed.

### `Result.stopReason`

Source: `src/types/Message.ts:303-309`.

| Value | Meaning |
| --- | --- |
| `"done"` | Clean termination; assistant produced a final text reply (or `finish_reason === "stop"` with no tool calls). |
| `"max_turns"` | Loop hit `maxTurns` without terminating naturally. |
| `"aborted"` | Caller cancelled via `AbortSignal`. Session **not** persisted. |
| `"length"` | Provider truncated output due to its own length cap. |
| `"content_filter"` | Provider refused or filtered the response. |
| `"error"` | Runtime or transport error. `Result.error` populated; session **not** persisted. |

### Abort / signal

`options.signal` is checked at the top of every turn (`src/agent/loop.ts:671-674`) and propagated to `config.openrouter.completeStream` so in-flight HTTP requests are cancelled at the transport layer (`src/agent/loop.ts:683-687`). An aborted run terminates with `stopReason: "aborted"` and **never** emits an `error` event. An abort during a retry backoff sleep gives up immediately — no further attempts, no `retry` event for the give-up.

### Retry behavior

Each turn allocates a fresh `RetryBudget` from the resolved `RetryConfig` (per-run override merged on top of `AgentConfig.retry`, with built-in defaults filling any unset fields). The same budget is shared across the two retry layers — the OpenRouter client (connection-level: 4xx-retryable / 5xx / pre-headers transport errors) and the agent loop (stream-level: `StreamTruncatedError`, `IdleTimeoutError`, mid-stream provider errors observed before any `message:delta`). **Budgets do not compound across layers.**

The retry window for a turn is open until the first `message:delta` is emitted. Concretely, the loop tracks `hasEmittedContentDelta` (set the first time `message:delta` is emitted for the current turn). Failures with `hasEmittedContentDelta === false` are eligible for retry; failures with `hasEmittedContentDelta === true` fall through to the existing error path (`stopReason: "error"`, no session persistence, client keeps the partial output it already received). The flag is **sticky across attempts within the same turn** — once any delta has reached the consumer the boundary is crossed permanently for that turn, regardless of what later attempts do.

Backoff:

```
delayMs = random(0, min(maxDelayMs, initialDelayMs * 2^(attempt - 1)))
delayMs = max(delayMs, retryAfterMs ?? 0)   // honor Retry-After
delayMs = min(delayMs, maxDelayMs)          // re-cap after the floor
```

Tool-call deltas, `turnUsage`, `contentBuf`, `toolCallBuf`, `finishReason`, and `turnError` are all discarded between attempts of the same turn. The failed attempt's `generationId` (if assigned) **is** appended to `Result.generationIds` so the run reflects every upstream call made.

### Subagent event bubbling

When an `Agent` is invoked as a tool, the wrapper `execute` (`src/agent/Agent.ts:175-203`) creates an internal `AgentRun` whose `emit` forwards every event to **both** the parent's `deps.emit` and the inner handle. The result is that a single outer event stream contains interleaved events from arbitrarily nested subagent runs. Each `agent:start` carries `parentRunId` (set from `deps.runId` at the wrapper boundary); each `agent:end` carries the matching `runId`. Top-level consumers must filter by `runId` to identify a specific run's terminal event — `AgentRun` does this internally so `await run` always resolves to the *outer* run's `Result`.

**Subagent message events do not bubble.** When an Agent runs as a subagent, its inner `message` and `message:delta` events stay on the subagent's own `AgentRun` and are **not** forwarded to the parent's NDJSON stream. Semantically a subagent is a tool from the parent's perspective; its internal "assistant said X" reasoning addresses the parent loop, not the end user, so it would only confuse a chat UI to render it as an assistant bubble. All other inner events (`agent:start`, `agent:end`, `tool:start`, `tool:progress`, `tool:end`, `retry`, `error`) bubble upward unchanged for full observability of subagent activity.

### Error handling summary

| Source | Resulting events | Terminal `stopReason` | Session persisted? |
| --- | --- | --- | --- |
| Tool throws / `inputSchema.parse` fails / unknown tool | `tool:end` (error variant); loop continues | `done` (or other) | yes |
| Retryable failure before any `message:delta`, with budget remaining | `retry` × N then normal `message:delta` / `message` (turn ultimately succeeds) | `done` (or other) | yes |
| Retryable failure before any `message:delta`, budget exhausted | `retry` × (N − 1) then `error`; loop breaks | `error` | no |
| Provider returns `error` chunk after a `message:delta` | `error`; loop breaks (not retried — outside the retry window) | `error` | no |
| `completeStream` throws (non-abort) after a `message:delta` | `error`; loop breaks (not retried — outside the retry window) | `error` | no |
| `completeStream` throws (abort) | none | `aborted` | no |
| `signal.aborted` between turns or during backoff sleep | none | `aborted` | no |
| `finish_reason === "error"` after a `message:delta` | `error`; loop breaks (not retried — outside the retry window) | `error` | no |
| Loop exhausts `maxTurns` | none | `max_turns` | yes |

---

## Internal helpers

The following are not exported from the package but document the loop's behavior:

| Symbol | Source | Purpose |
| --- | --- | --- |
| `FINISH_REASON_TO_STOP` | `src/agent/loop.ts:31-35` | Maps OpenRouter `finish_reason` (`stop`/`length`/`content_filter`) to internal `stopReason`. `tool_calls` is intentionally absent — the loop continues on tool calls. |
| `newRunId()` | `src/agent/loop.ts:114-116` | Generates `run-XXXX` ids for events. |
| `newToolUseId(fallback)` | `src/agent/loop.ts:125-127` | Prefers the model's `tool_call.id`; falls back to `tu-XXXX` when missing/empty. |
| `zeroUsage()` | `src/agent/loop.ts:134-136` | Zero-initialized `Usage` accumulator. |
| `addUsage(a, b)` | `src/agent/loop.ts:148-161` | Accumulates token/cost totals across turns. `cost` becomes `undefined` when both sides contribute zero (avoids spurious `0`). |
| `normalizeToolResult(raw)` | `src/agent/loop.ts:177-192` | Coerces a tool's raw return into `{ content }` / `{ error }` shape. Accepts bare strings, `{ error: string }`, `{ content }`, or anything else (treated as opaque content). |
| `safeDisplay(fn)` | `src/agent/loop.ts:202-208` | Wraps display-hook calls so a thrown hook returns `undefined` rather than killing the run. |
| `resolveToolDisplay(tool, args, pickHook)` | `src/agent/loop.ts:225-240` | Merges a tool's phase hook with the `title` default; returns a fully-resolved `EventDisplay` only if a string title exists. |
| `resolveAgentDisplay(display, input, pickHook)` | `src/agent/loop.ts:256-270` | Same logic for agent-level display hooks. |
| `pickAgentEndHook(display, result)` | `src/agent/loop.ts:283-290` | Implements the `agent:end` hook routing table. |
| `executeToolCall(toolCall, toolByName, deps, runId, emit)` | `src/agent/loop.ts:312-396` | Single-tool dispatcher: validates args, calls `Tool.execute`, normalizes the result, emits `tool:start` / `tool:end`, returns the `role: "tool"` `Message` to append. Logs to stderr when `OPENROUTER_DEBUG` env var is set. |
| `resolveInitialMessages(input, systemOverride, systemFromConfig, sessionMessages)` | `src/agent/loop.ts:467-513` | Builds the seed `messages` array and resolves the system prompt with `systemOverride` > embedded `system` > `systemFromConfig` precedence. Strips `system`-role messages from both session history and seed input. |
| `lastAssistantText(messages)` | `src/agent/loop.ts:462-470` | Walks messages backwards and returns the most recent `assistant` message with string content. Returns `""` if none exist (empty `Result.text` on tool-only final turns). |
| `mergeToolCallDelta(buf, delta)` | `src/agent/loop.ts:484-512` | Reassembles streamed tool-call fragments keyed by `index`; concatenates argument fragments, first-seen `id`/`type`/`name` win. |
| `assembleToolCalls(buf)` | `src/agent/loop.ts:527-542` | Flattens the per-index buffer into an ordered `ToolCall[]`. Defaults missing fields so the structure always type-checks. |
