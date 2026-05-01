# Tool Layer (`src/tool/`)

The `tool` folder defines the abstraction agents use to expose callable functions to the model. A `Tool` couples a Zod input schema (used both for runtime validation and for generating the JSON Schema OpenRouter advertises), an async `execute` function the agent loop invokes when the model emits a `tool_call`, and optional display hooks that decorate lifecycle events. Tools are immutable after construction and may be reused across multiple `Agent` instances and concurrent runs. The folder also defines the `ToolResult` normalization shape produced from any tool's return value, and the `ToolDeps` bundle of dependencies the loop injects into every call (LLM completion callback, abort signal, run identifiers, message snapshot, and an event emitter for tools that bubble events into the parent stream).

The `Agent` class extends `Tool`, so an agent can be passed directly into another agent's `tools` array as a subagent — see the cross-reference under [`Tool` class](#tool-class) below.

## Imports

All public symbols are re-exported from the package root and should be imported from there, never from internal paths:

```ts
import {
  Tool,
  type ToolConfig,
  type ToolDisplayHooks,
  type ToolDeps,
  type ToolResult,
} from "@sftinc/openrouter-agent";
```

The folder's barrel file (`src/tool/index.ts`) re-exports `Tool`, `ToolConfig`, `ToolDisplayHooks` from `./Tool.js` and `ToolDeps`, `ToolResult` from `./types.js` (`src/tool/index.ts:15-19`). `src/index.ts:153` exports `Tool`; `src/index.ts:172` exports the four type aliases.

## Public surface map

| Symbol             | Kind      | File                                | Re-exported at                |
| ------------------ | --------- | ----------------------------------- | ----------------------------- |
| `Tool`             | class     | `src/tool/Tool.ts:185`              | `src/index.ts:153`            |
| `ToolConfig`       | interface | `src/tool/Tool.ts:123`              | `src/index.ts:172`            |
| `ToolDisplayHooks` | interface | `src/tool/Tool.ts:41`               | `src/index.ts:172`            |
| `ToolDeps`         | interface | `src/tool/types.ts:66`              | `src/index.ts:172`            |
| `ToolResult`       | type      | `src/tool/types.ts:30`              | `src/index.ts:172`            |

---

## `Tool` class

Source: `src/tool/Tool.ts:185`.

A typed, async function the model is allowed to call. Wraps a user `execute` function with a Zod input schema (auto-converted to JSON Schema for OpenRouter) and optional display hooks for UI. Instances are immutable after construction and may be passed to multiple `Agent`s.

```ts
class Tool<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly display?: ToolDisplayHooks<Args>;

  constructor(config: ToolConfig<Args>);
  execute(args: Args, deps: ToolDeps): Promise<unknown>;
  toOpenRouterTool(): OpenRouterTool;
}
```

**Cross-reference:** `Agent` extends `Tool` (`src/agent/Agent.ts:138`: `export class Agent<Input = { input: string }> extends Tool<Input>`). An `Agent` can therefore be placed directly in another `Agent`'s `tools: [...]` array as a subagent. The `Agent.execute` override forwards the call into a nested run, bubbling subagent events into the parent stream via `deps.emit`.

### Public fields

| Field         | Type                       | Origin                          | Description                                                                                          |
| ------------- | -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `name`        | `string`                   | `ToolConfig.name`               | Stable identifier the model uses to invoke the tool (`src/tool/Tool.ts:189`).                        |
| `description` | `string`                   | `ToolConfig.description`        | Natural-language description sent to the model (`src/tool/Tool.ts:194`).                             |
| `inputSchema` | `z.ZodType<Args>`          | `ToolConfig.inputSchema`        | Zod schema for validating model-supplied arguments and generating JSON Schema (`src/tool/Tool.ts:199`). |
| `display`     | `ToolDisplayHooks<Args>?`  | `ToolConfig.display`            | Optional UI hooks; may be `undefined` (`src/tool/Tool.ts:205`).                                      |

The user-supplied executor is stored privately as `executeFn` (`src/tool/Tool.ts:210`) and reached through `Tool.execute()`.

### Constructor

```ts
new Tool<Args>(config: ToolConfig<Args>)
```

Source: `src/tool/Tool.ts:220`.

Build a tool from a `ToolConfig`. No validation of `name` or `description` is performed here; OpenRouter rejects the request later if either is malformed. Display hooks are stored verbatim.

| Parameter | Type               | Required | Default | Description                                                          |
| --------- | ------------------ | -------- | ------- | -------------------------------------------------------------------- |
| `config`  | `ToolConfig<Args>` | yes      | —       | The tool's name, description, schema, executor, and optional display. |

**Constructor options** (the fields of `ToolConfig<Args>`):

| Field         | Type                                                  | Required | Default     | Description                                                                                                                            |
| ------------- | ----------------------------------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`                                              | yes      | —           | Stable identifier. Must be unique within an Agent's tool set and conform to OpenRouter's `[A-Za-z0-9_-]+` function-name pattern.       |
| `description` | `string`                                              | yes      | —           | Sent to the model. The LLM uses this to decide when to call the tool — be specific about inputs, side effects, and expected outputs.   |
| `inputSchema` | `z.ZodType<Args>`                                     | yes      | —           | Zod schema validating model-supplied arguments and source for the JSON Schema advertised to OpenRouter.                                |
| `execute`     | `(args: Args, deps: ToolDeps) => Promise<unknown>`    | yes      | —           | The implementation. Receives validated `args` and a `ToolDeps` bundle. Return value is normalized — see [Tool result coercion](#tool-result-coercion). |
| `display`     | `ToolDisplayHooks<Args>`                              | no       | `undefined` | Optional UI hooks generating `EventDisplay` fragments for the lifecycle events emitted around this tool.                               |

**Throws:** the constructor itself does not throw.

**Example:**

```ts
import { z } from "zod";
import { Tool } from "@sftinc/openrouter-agent";

const echo = new Tool({
  name: "echo",
  description: "Echo the input back to the model.",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
  display: {
    title: ({ text }) => `echo("${text}")`,
  },
});
```

### `Tool.execute(args, deps)`

```ts
execute(args: Args, deps: ToolDeps): Promise<unknown>
```

Source: `src/tool/Tool.ts:244`.

Invoke the tool. Called by the agent loop after validating `args` against `Tool.inputSchema`. May return a string, a `ToolResult` shape, or any value (auto-wrapped as `{ content }`). Throwing or returning `{ error: string }` both signal failure to the loop. Errors thrown inside `execute` propagate to the loop, which converts them into a `tool:end` (error variant) event and a `role: "tool"` error message appended to the conversation so the model can recover.

| Parameter | Type        | Required | Default | Description                                                                              |
| --------- | ----------- | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `args`    | `Args`      | yes      | —       | The validated input arguments for this call.                                             |
| `deps`    | `ToolDeps`  | yes      | —       | Loop-injected helpers — see [`ToolDeps`](#tooldeps).                                     |

**Returns:** `Promise<unknown>` — the raw tool output (later normalized to a `ToolResult` by the loop; see [Tool result coercion](#tool-result-coercion)).

**Throws:** whatever the user-supplied `execute` function throws. The loop catches it and emits `tool:end` (error variant).

**Example:**

```ts
import { Tool } from "@sftinc/openrouter-agent";

// Direct invocation (rare — usually the agent loop calls this for you)
const out = await echo.execute(
  { text: "hi" },
  { complete: async () => ({ content: "", usage: {} as any }) }
);
```

### `Tool.toOpenRouterTool()`

```ts
toOpenRouterTool(): OpenRouterTool
```

Source: `src/tool/Tool.ts:261`.

Serialize this tool into the `OpenRouterTool` shape OpenRouter expects in the `tools` array of a completion request. The Zod schema is converted to JSON Schema via Zod 4's built-in `z.toJSONSchema()` with the `target: "draft-7"` option so it round-trips through OpenRouter's parameter validation cleanly (OpenAPI 3.0 uses a JSON Schema dialect derived from draft-7).

Called once per request by the agent loop; **no caching is performed**, so callers that re-serialize repeatedly may want to memoize.

**Parameters:** none.

**Returns:** `OpenRouterTool` — a `function`-typed tool descriptor of the form:

```ts
{
  type: "function",
  function: {
    name: string,
    description: string,
    parameters: object, // JSON Schema (draft-7)
  }
}
```

**Throws:** propagates whatever `z.toJSONSchema()` throws if the schema is unsupported.

**Example:**

```ts
const wireShape = echo.toOpenRouterTool();
// {
//   type: "function",
//   function: {
//     name: "echo",
//     description: "Echo the input back to the model.",
//     parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], ... }
//   }
// }
```

---

## `ToolConfig<Args>`

Source: `src/tool/Tool.ts:123`.

Construction-time configuration for a `Tool`. The generic `Args` captures the input shape derived from the Zod schema and is propagated to the `execute` callback and the `ToolDisplayHooks`.

| Field         | Type                                                  | Required | Default     | Description                                                                                                                          |
| ------------- | ----------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | `string`                                              | yes      | —           | Stable identifier. Unique within an Agent's tool set; must match `[A-Za-z0-9_-]+`.                                                   |
| `description` | `string`                                              | yes      | —           | Natural-language description sent to the model.                                                                                      |
| `inputSchema` | `z.ZodType<Args>`                                     | yes      | —           | Zod schema for validating arguments and generating JSON Schema.                                                                      |
| `execute`     | `(args: Args, deps: ToolDeps) => Promise<unknown>`    | yes      | —           | The implementation. Receives validated `args` and `deps`. May return a string, an object, a `ToolResult`, or throw.                  |
| `display`     | `ToolDisplayHooks<Args>`                              | no       | `undefined` | Optional UI hooks (`start` / `progress` / `success` / `error`) that produce display fragments for the corresponding `tool:start`, `tool:progress`, and `tool:end` events. |

**Producers:** the user, when constructing a `Tool`.
**Consumers:** `new Tool(config)` (`src/tool/Tool.ts:220`).

**Example literal:**

```ts
import { z } from "zod";
import type { ToolConfig } from "@sftinc/openrouter-agent";

const cfg: ToolConfig<{ city: string }> = {
  name: "get_weather",
  description: "Fetch the current temperature for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => `It is 21°C in ${city}.`,
  display: {
    title: ({ city }) => `Weather in ${city}`,
  },
};
```

---

## `ToolDisplayHooks<Args>`

Source: `src/tool/Tool.ts:41`.

Optional hooks that produce per-phase `EventDisplay` fragments for a tool. The agent loop calls the relevant hook (`start`, `progress`, `success`, or `error`) when emitting a `tool:start`, `tool:progress`, or `tool:end` event (success or error variant) and merges the returned partial onto a base display object. A hook's return value is merged with the display-level `title` default; if the hook omits `title`, the default is used. **If neither supplies a title, no display is emitted for that phase.** All hooks are synchronous and must not throw — runtime errors inside a hook are swallowed by the loop's defensive wrapper rather than aborting the run.

| Field      | Type                                                                                                          | Required | Default     | Description                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`    | `string \| ((args: Args) => string)`                                                                          | no       | `undefined` | Default title for every phase. Per-phase hooks can override by returning their own `title`. A string is used verbatim; a function receives validated args.   |
| `start`    | `(args: Args) => Partial<EventDisplay>`                                                                       | no       | `undefined` | Invoked once just before `execute()` runs. Return a partial `EventDisplay` merged into the `tool:start` event.                                               |
| `progress` | `(args: Args, meta: { elapsedMs: number }) => Partial<EventDisplay>`                                          | no       | `undefined` | Invoked periodically while `execute()` is in flight (for tools that opt into progress reporting). `meta.elapsedMs` is ms since `start`.                      |
| `success`  | `(args: Args, output: unknown, metadata?: Record<string, unknown>) => Partial<EventDisplay>`                  | no       | `undefined` | Invoked after `execute()` resolves successfully. Receives args, the raw return value, and any tool-supplied `metadata`.                                      |
| `error`    | `(args: Args, error: unknown, metadata?: Record<string, unknown>) => Partial<EventDisplay>`                   | no       | `undefined` | Invoked when `execute()` throws or returns `{ error: string }`. Receives args, the error value (`Error` for throws, the string for returned errors), `metadata`. |

**Producers:** the user, on `ToolConfig.display`.
**Consumers:** the agent loop's `resolveToolDisplay` helper (`src/agent/loop.ts:221+`), which calls the appropriate hook and merges its return with a default `{ title }`.

**Example literal:**

```ts
import type { ToolDisplayHooks } from "@sftinc/openrouter-agent";

const display: ToolDisplayHooks<{ city: string }> = {
  title: ({ city }) => `Weather in ${city}`,
  start: ({ city }) => ({ content: `Looking up ${city}...` }),
  progress: (_args, { elapsedMs }) => ({ content: `Still working (${elapsedMs}ms)` }),
  success: (_args, output) => ({ content: String(output) }),
  error: (_args, err) => ({ content: `Failed: ${err}` }),
};
```

---

## `ToolDeps`

Source: `src/tool/types.ts:66`.

Dependencies injected into every tool's `execute()` call. Optional fields are always populated by the agent loop; user tools can ignore them. Agents used as subagents rely on `emit` and `runId` to bubble their own events up into the parent's stream. Tools generally need only `complete` (for nested LLM calls) and `signal` (to honor cancellation).

| Field         | Type                                                                                                                                                                                                                       | Required | Default     | Description                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`    | `(messages: Message[], options?: { client?: LLMConfig; tools?: OpenRouterTool[] }) => Promise<{ content: string \| null; usage: Usage; tool_calls?: ToolCall[]; annotations?: Annotation[] }>`                              | yes      | —           | One-shot LLM completion using the active agent's OpenRouter client and default model/options. Caller assembles the full `messages` array; the loop does **not** inject anything.                 |
| `emit`        | `(event: AgentEvent) => void`                                                                                                                                                                                              | no       | `undefined` | Forward an `AgentEvent` into the parent run's event stream. Present when this tool is being executed inside a parent agent (e.g. an `Agent` wrapped as a tool). Guard with `if (deps.emit)`.    |
| `signal`      | `AbortSignal`                                                                                                                                                                                                              | no       | `undefined` | Abort signal tied to the current run. Aborts when the consumer calls `AgentRun.abort()` or when an outer `AbortController` fires. Pass through to `fetch`, child processes, etc.                 |
| `runId`       | `string`                                                                                                                                                                                                                   | no       | `undefined` | Identifier of the current run. Same value as the `runId` on every agent event for this run.                                                                                                       |
| `parentRunId` | `string`                                                                                                                                                                                                                   | no       | `undefined` | Identifier of the parent run when this tool is executing inside a subagent. Undefined for top-level runs.                                                                                         |
| `getMessages` | `() => Message[]`                                                                                                                                                                                                          | no       | `undefined` | Snapshot of the loop's in-memory messages at the moment of the call: prior session history, the user input, and every **completed** assistant/tool turn from this run. The assistant message currently invoking this tool is **excluded** so the snapshot is always a valid conversation forwardable to any provider (Anthropic rejects an unmatched `tool_use`). For parallel tool calls in a batch, sibling tools' results are also excluded. **The system prompt is never included.** Returns a fresh array each call; mutating it does not affect the loop. |
| `context`     | `Record<string, unknown>`                                                                                                                                                                                                  | no       | `undefined` | Caller-supplied data bag passed through from `RunLoopOptions.context`. Treat as read-only; never sent to the LLM. `undefined` when the caller did not supply one. |

`complete`'s `options` sub-fields:

| Sub-field        | Type               | Required | Default     | Description                                                                                                       |
| ---------------- | ------------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `options.client` | `LLMConfig`        | no       | `undefined` | Override the `LLMConfig` (model, sampling params, provider routing, etc.) for just this call.                     |
| `options.tools`  | `OpenRouterTool[]` | no       | `undefined` | Override the OpenRouter tool list advertised on this call. Pass `[]` to forbid tool use.                          |

**Producers:** the agent loop (`src/agent/loop.ts`) constructs the `ToolDeps` per tool call and passes it as the second argument to `Tool.execute`.
**Consumers:** user `execute` implementations and, in particular, `Agent.execute` when an `Agent` is wrapped as a subagent tool.

**Example literal (the shape a tool sees):**

```ts
import type { ToolDeps } from "@sftinc/openrouter-agent";

const deps: ToolDeps = {
  complete: async (messages, opts) => ({
    content: "...",
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } as any,
  }),
  signal: new AbortController().signal,
  runId: "run_abc123",
  parentRunId: undefined,
  emit: (event) => { /* forwarded to parent stream */ },
  getMessages: () => [/* defensive copy, ending at the last completed turn */],
};
```

---

## `ToolResult`

Source: `src/tool/types.ts:30`.

Normalized tool result. Tools may return any value: a bare string, number, object, or array becomes the success payload. To signal failure, either throw (the loop catches) or return `{ error: "message" }`. `metadata` is optional and **never** sent to the model — it's for events, UI, and logs. The two arms are mutually exclusive — a result is either a success (with `content`) or a failure (with `error`), never both.

```ts
type ToolResult =
  | { content: unknown; metadata?: Record<string, unknown> }
  | { error: string;    metadata?: Record<string, unknown> };
```

### Success arm

| Field      | Type                          | Required | Default     | Description                                                                                                          |
| ---------- | ----------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `content`  | `unknown`                     | yes      | —           | The success payload returned to the model. Any JSON-serializable value; non-string values are JSON-stringified at the wire boundary. |
| `metadata` | `Record<string, unknown>`     | no       | `undefined` | Optional auxiliary data attached to the `tool:end` (success variant) event. **Never** included in the message sent back to the model. |

### Error arm

| Field      | Type                          | Required | Default     | Description                                                                                                          |
| ---------- | ----------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `error`    | `string`                      | yes      | —           | Human-readable failure message. Forwarded to the model in the `role: "tool"` reply (prefixed with `Error: `) so it can recover. |
| `metadata` | `Record<string, unknown>`     | no       | `undefined` | Optional auxiliary data attached to the `tool:end` (error variant) event. **Never** included in the message sent back to the model. |

**Producers:** user `execute` implementations (directly or via the [coercion](#tool-result-coercion) rules), or the agent loop itself when synthesizing `{ error: "tool \"X\" is not registered with this agent" }` for unknown tools (`src/agent/loop.ts:343`).
**Consumers:** the loop's `tool:end` event emitter — both success and error variants (`src/agent/loop.ts:356-358, 365-377`) — and the `buildToolResultMessage` / `buildToolErrorMessage` helpers (`src/lib/messages.ts:43, 74`) that produce the `role: "tool"` message.

**Example literals:**

```ts
import type { ToolResult } from "@sftinc/openrouter-agent";

const ok: ToolResult = {
  content: { temperature: 21, units: "C" },
  metadata: { source: "openweather", cached: false },
};

const fail: ToolResult = {
  error: "Upstream timed out after 30s",
  metadata: { httpStatus: 504 },
};
```

---

## Tool result coercion

The agent loop normalizes whatever a `Tool.execute` returns into a `ToolResult` via `normalizeToolResult` (`src/agent/loop.ts:177`). The rules:

| Returned value                                                       | Normalized to                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `string`                                                             | `{ content: string }` (`src/agent/loop.ts:178`)                                            |
| `null`                                                               | `{ content: null }` (falls through to the catch-all branch)                                |
| Object with `error: string`                                          | `{ error, metadata: obj.metadata }` (`src/agent/loop.ts:181-183`)                          |
| Object with `content` field                                          | `{ content: obj.content, metadata: obj.metadata }` (`src/agent/loop.ts:184-189`)           |
| Any other object (no `error: string`, no `content`)                  | `{ content: rawObject }` (`src/agent/loop.ts:191`)                                         |
| Numbers, booleans, arrays, etc.                                      | `{ content: rawValue }` (`src/agent/loop.ts:191`)                                          |
| Thrown error from `execute`                                          | `{ error: e instanceof Error ? e.message : String(e) }` (`src/agent/loop.ts:350`)          |

Unknown tool name (the model invented a tool not registered with the agent) is short-circuited to `{ error: 'tool "<name>" is not registered with this agent' }` before `execute` is even called (`src/agent/loop.ts:343`).

After normalization:

- **Success** — the loop builds a `role: "tool"` message via `buildToolResultMessage(toolCallId, content)` (`src/lib/messages.ts:43`). If `content` is a string it is sent verbatim; otherwise it is `JSON.stringify`'d (`src/lib/messages.ts:47`). A `tool:end` event (success variant) is emitted carrying the same content plus `metadata`.
- **Error** — the loop builds a `role: "tool"` message via `buildToolErrorMessage(toolCallId, error)` whose content is `` `Error: ${error}` `` (`src/lib/messages.ts:78`). A `tool:end` event (error variant) is emitted carrying `error` and `metadata`. The loop then continues so the model can recover; it does not abort the run.

`metadata` is never written into the message sent back to the model; it is only attached to the corresponding `tool:end` `AgentEvent` (success or error variant).

---

## Validation

Argument validation and JSON Schema generation both run off of `Tool.inputSchema` (a `z.ZodType<Args>`):

1. **JSON Schema generation.** `Tool.toOpenRouterTool()` (`src/tool/Tool.ts:261-271`) calls `z.toJSONSchema(this.inputSchema, { target: "draft-7" })` and embeds the result as the `function.parameters` object of the `OpenRouterTool` advertised to the model. The `draft-7` target is chosen because OpenAPI 3.0 (which OpenRouter's tool-parameter validator inherits from) is derived from JSON Schema draft-7; staying on that draft maximizes round-trip compatibility. **No caching** — the loop re-derives the JSON Schema once per request.

2. **Runtime argument validation.** The loop parses the model's `tool_call.function.arguments` (a JSON string), then validates the parsed object with `inputSchema` before invoking `execute`. A validation failure short-circuits to a `tool:end` (error variant) event and a `role: "tool"` error message; `execute` is not called.

3. **No name validation in the SDK.** `Tool`'s constructor does not validate `name` or `description` (`src/tool/Tool.ts:213-215`); OpenRouter rejects malformed names server-side. Tool names should match `[A-Za-z0-9_-]+` and be unique within a single agent's tool set.

The Zod dependency is `zod` (peer-imported via `import { z } from "zod"` at `src/tool/Tool.ts:19`). Schemas can be any `z.ZodType<Args>`: object schemas are typical, but primitives, unions, and discriminated unions all work as long as `z.toJSONSchema` can render them under the `draft-7` target.

---

## Internal helpers

The `tool` folder itself exports no internal-only helpers — the only private member is `Tool#executeFn` (`src/tool/Tool.ts:210`), the user-supplied implementation stored privately so the public surface stays narrow and stable; it is reached through the public `Tool.execute(args, deps)` method.

Helpers that the tool layer collaborates with but that live elsewhere (and are **not** part of the public API) include:

- `normalizeToolResult` (`src/agent/loop.ts:177`) — coerces arbitrary `execute` return values into the canonical `ToolResult` shape; see [Tool result coercion](#tool-result-coercion).
- `resolveToolDisplay` (`src/agent/loop.ts:221+`) — calls the appropriate `ToolDisplayHooks` phase hook and merges its return with a base `{ title }`. Swallows hook errors.
- `buildToolResultMessage(toolCallId, output)` (`src/lib/messages.ts:43`) — produces the `role: "tool"` message sent back to the model on success. JSON-stringifies non-string content.
- `buildToolErrorMessage(toolCallId, error)` (`src/lib/messages.ts:74`) — produces the `role: "tool"` message sent back to the model on failure, prefixed with `Error: `.

These are all internal to `src/agent/` and `src/lib/` and are deliberately not re-exported from `@sftinc/openrouter-agent`. Consumers should not depend on them.
