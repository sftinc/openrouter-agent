# openrouter-agent — Agent Wrapper Design (v1)

Repository: https://github.com/sftinc/openrouter-agent

Status: draft for review
Date: 2026-04-23

## Goal

A minimal Node.js + TypeScript library that wraps OpenRouter's chat completions API with an agent loop. Users construct `Agent` and `Tool` instances, then call `agent.run(input)` to execute a tool-using conversation until the model stops.

Agents can be used as tools by other agents (subagent pattern) without special syntax — an `Agent` implements the `Tool` interface.

## Non-goals (v1)

- **Token streaming.** Non-streaming only; a future `message:delta` event slots into the existing event union without breaking changes.
- **MCP support.** Deferred to v2 (see "Future work" below). The `Tool` interface is MCP-compatible by shape so adding it later is strictly additive.
- **Built-in tools.** The library ships no pre-made tools (no `webSearch`, no `datetime`). Users write whatever they need using the `Tool` class. The reference pattern for wrapping OpenRouter server tools lives in `docs/examples/`.
- **Retry policies.** If a tool throws intermittently, the tool handles retry internally. Infrastructure errors from OpenRouter abort the run.
- **Cost estimation / budgets.** `Result.usage.cost` is reported; no enforcement.

## Core concepts

| Concept | Purpose |
|---|---|
| `Tool` | A callable the model can invoke: name, description, Zod input schema, async `execute(args, deps)`. |
| `Agent` | A tool-using loop. Has a system prompt, a model, a list of `Tool`s. Implements the `Tool` interface so it can be a subagent. |
| `Session` | Optional conversation history. Triggered by passing `sessionId` to `run()`. |
| `SessionStore` | Pluggable storage for session history. `InMemorySessionStore` is the default. |
| `AgentEvent` | Discriminated union emitted during a run for UI observability. |
| `Result` | Structured return from `run()`: final text, full message trace, usage, stop reason. |

## Folder layout

```
src/
  agent/
    Agent.ts            // Agent class
    loop.ts             // the run-until-done loop
    events.ts           // AgentEvent union + emitter helpers
    index.ts            // barrel
  tool/
    Tool.ts             // Tool class
    types.ts            // ToolDeps, ToolResult
    index.ts
  session/
    SessionStore.ts     // interface
    InMemorySessionStore.ts
    index.ts
  openrouter/
    client.ts           // thin HTTP client, handles auth + streaming off for v1
    types.ts            // wire types matching docs/openrouter/llm.md
    index.ts
  types/
    Message.ts
    Usage.ts
    Result.ts
    index.ts
  index.ts              // top-level barrel re-exports the public surface
```

Every subfolder exposes its public surface via its `index.ts`. Consumers import from the folder (`import { Agent } from "./agent"`), never from a specific file. The top-level `src/index.ts` re-exports everything external consumers need.

## Types

### `Message`

OpenAI-compatible message shape (per `docs/openrouter/llm.md`):

```ts
type Message =
  | { role: "system" | "user" | "assistant"; content: string | ContentPart[]; name?: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };  // arguments is JSON-stringified
};
```

### `ToolResult`

```ts
type ToolResult = {
  content: unknown;                          // model-visible payload
  isError?: boolean;                         // UI / event only; not sent to the model
  metadata?: Record<string, unknown>;        // internal (logs, UI), not sent to the model
};
```

Handler return value is `string | ToolResult`. A plain string is sugar for `{ content: string }`. Before sending to OpenRouter, `content` is serialized: strings as-is, non-strings via `JSON.stringify`.

### `ToolDeps`

Injected into every tool's `execute`:

```ts
interface ToolDeps {
  complete: (
    messages: Message[],
    options?: { llm?: LLMConfig; tools?: unknown[] }
  ) => Promise<{ content: string | null; usage: Usage; tool_calls?: ToolCall[] }>;
}
```

Future additions (`signal`, `runId`, `emit`) are additive.

### `EventDisplay`

Every event optionally carries a `display` block for UI consumers. Kept intentionally minimal — `title` is the required human-readable label; `content` is an open `unknown` slot for whatever richer payload the event needs (string, object, array — whatever makes sense for the rendering surface).

```ts
type EventDisplay = {
  title: string;
  content?: unknown;  // string | object | array | anything the UI wants to render
};
```

### `AgentEvent`

```ts
type AgentEvent =
  | { type: "agent:start";    runId: string; parentRunId?: string; agentName: string; display?: EventDisplay }
  | { type: "agent:end";      runId: string; result: Result;                          display?: EventDisplay }
  | { type: "message";        runId: string; message: Message;                        display?: EventDisplay }
  | { type: "tool:start";     runId: string; toolUseId: string; toolName: string; input: unknown; display?: EventDisplay }
  | { type: "tool:progress";  runId: string; toolUseId: string; elapsedMs: number;    display?: EventDisplay }
  | { type: "tool:end";       runId: string; toolUseId: string; output: unknown; isError: boolean; display?: EventDisplay }
  | { type: "error";          runId: string; error: { code?: number; message: string }; display?: EventDisplay };
```

Subagent events bubble up to the parent's stream with `parentRunId` set. Consumers reconstruct a tree by correlating `runId` / `parentRunId`.

**`display` population.** Tools and agents optionally declare `display` hooks on their config (see `Tool` and `Agent` sections below). When the agent emits an event, it calls the relevant hook to populate `event.display`. If no hook is declared, `display` is `undefined` — consumers should fall back to a `defaultDisplay(event)` helper shipped by the library.

Hooks that throw are caught; `display` is left `undefined` and the loop continues. Rendering must never block execution.

### `Usage`

Mirrors OpenRouter's `ResponseUsage`, accumulated across all LLM calls in a single run:

```ts
interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  server_tool_use?: { web_search_requests?: number };
}
```

### `LLMConfig`

Mirrors OpenRouter's chat-completion request schema (per `docs/openrouter/llm.md`), minus `messages` and `tools` (those are handled separately — messages by the loop, tools by the Agent's `tools: Tool[]` array). Every field is optional; any subset can be supplied at construction, per-run, or per sub-call.

```ts
interface LLMConfig {
  model?: string;                                          // default: "anthropic/claude-haiku-4.5"
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  top_a?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
  logit_bias?: Record<number, number>;
  top_logprobs?: number;
  response_format?:
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; strict?: boolean; schema: object } };
  tool_choice?: "none" | "auto" | { type: "function"; function: { name: string } };
  prediction?: { type: "content"; content: string };
  reasoning?: { effort?: "low" | "medium" | "high"; max_tokens?: number; enabled?: boolean };
  user?: string;
  models?: string[];                                       // fallback chain
  route?: "fallback";
  provider?: Record<string, unknown>;                      // ProviderPreferences (typed later)
  plugins?: Array<{ id: string; [key: string]: unknown }>;
}
```

**Resolution across layers.** A shallow merge, top to bottom:

1. Library defaults (`model: "anthropic/claude-haiku-4.5"`, everything else unset).
2. `Agent` constructor `llm` field.
3. Per-run `options.llm` passed to `run()` / `runStream()`.
4. For sub-calls from inside a tool, the `llm` passed to `deps.complete(messages, { llm })` — does **not** inherit from the parent run; the tool specifies what it wants explicitly.

### `Result`

```ts
interface Result {
  text: string;                          // last assistant message content
  messages: Message[];                   // full trace from this run
  stopReason:
    | "done"                             // normalized "stop"
    | "max_turns"                        // loop bailout
    | "aborted"                          // AbortSignal fired
    | "length"                           // hit max_tokens
    | "content_filter"
    | "error";
  usage: Usage;                          // accumulated across all LLM calls in the loop
  generationIds: string[];               // one OpenRouter `id` per LLM call
  error?: { code?: number; message: string; metadata?: Record<string, unknown> };
}
```

## `Tool` class

```ts
class Tool<Args = any> {
  constructor(config: {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<Args>;
    execute: (args: Args, deps: ToolDeps) => Promise<string | ToolResult>;
    display?: {
      start?:    (args: Args) => EventDisplay;
      progress?: (args: Args, meta: { elapsedMs: number }) => EventDisplay;
      end?:      (args: Args, output: unknown, meta: { isError: boolean }) => EventDisplay;
    };
  });

  name: string;
  description: string;
  inputSchema: z.ZodSchema<Args>;
  execute(args: Args, deps: ToolDeps): Promise<string | ToolResult>;

  /** Serialize to OpenRouter tool format. */
  toOpenRouterTool(): { type: "function"; function: { name: string; description: string; parameters: object } };
}
```

`toOpenRouterTool` uses `zod-to-json-schema` to convert the Zod schema to JSON Schema for the wire format.

## `Agent` class

```ts
class Agent<Input = string> extends Tool<Input> {
  constructor(config: {
    name: string;
    description: string;
    llm?: LLMConfig;                                       // defaults: { model: "anthropic/claude-haiku-4.5" }
    systemPrompt?: string;                                 // default; overridable per-run
    tools?: Tool[];                                        // includes other Agents
    inputSchema?: z.ZodSchema<Input>;                      // defaults to z.object({ input: z.string() })
    maxTurns?: number;                                     // default 10
    sessionStore?: SessionStore;                           // default InMemorySessionStore
    apiKey?: string;                                       // defaults to process.env.OPENROUTER_API_KEY
    referer?: string;                                      // HTTP-Referer header
    title?: string;                                        // X-OpenRouter-Title header
    display?: {
      start?: (input: string | Message[]) => EventDisplay;
      end?:   (result: Result)            => EventDisplay;
    };
  });

  run(
    input: string | Message[],
    options?: {
      sessionId?: string;
      system?: string;                                     // overrides constructor + any system message in `input`
      signal?: AbortSignal;
      maxTurns?: number;                                   // overrides constructor default
      llm?: LLMConfig;                                     // shallow-merges over Agent's llm defaults
      parentRunId?: string;                                // set automatically when invoked as a subagent
    }
  ): Promise<Result>;

  runStream(
    input: string | Message[],
    options?: /* same as run() */
  ): AsyncIterable<AgentEvent>;

  // Implements Tool — an Agent can be used as a subagent.
  execute(args: Input, deps: ToolDeps): Promise<string | ToolResult>;
}
```

### System prompt resolution

1. `options.system` (run-time) wins outright — replaces any other source.
2. Else, a `{ role: "system" }` message inside `input: Message[]` is used.
3. Else, `config.systemPrompt`.

When a session is active and a run-time `system` is given, it **replaces** the session's stored system message (option C from design review).

### Agent-as-subagent

`Agent` implements `Tool`:

- `execute(args, deps)` runs the agent's loop (stateless — no sessionId).
- `inputSchema` defaults to `z.object({ input: z.string() })`; the subagent treats `args.input` as a user message.
- `deps` is accepted to satisfy the `Tool` contract but is **not used** — a subagent has its own model, API key, and system prompt from its own construction, so it uses its own OpenRouter client rather than the parent's `deps.complete`.
- Subagent events are emitted with `parentRunId` set to the parent's runId; they appear in the parent's `runStream()`.

## The agent loop (`src/agent/loop.ts`)

Pseudocode:

```
runId = randomId()
emit { type: "agent:start", runId, parentRunId, agentName }

messages = resolveInitialMessages(input, options, sessionStore, sessionId)
usage = zero()
generationIds = []

for turn in 1..maxTurns:
  if signal.aborted: stopReason = "aborted"; break

  response = openrouter.complete({ ...resolvedLlm, messages, tools: tools.map(toOpenRouterTool()) })
  generationIds.push(response.id)
  usage = accumulate(usage, response.usage)

  assistantMsg = response.choices[0].message
  messages.push(assistantMsg)
  emit { type: "message", runId, message: assistantMsg }

  switch response.choices[0].finish_reason:
    case "stop":            stopReason = "done"; break
    case "length":          stopReason = "length"; break
    case "content_filter":  stopReason = "content_filter"; break
    case "error":           stopReason = "error"; error = response.choices[0].error; break
    case "tool_calls":      // handled below

  if assistantMsg.tool_calls:
    for toolCall in assistantMsg.tool_calls (sequentially for v1):
      emit { type: "tool:start", runId, toolUseId, toolName, input }
      tool = findTool(toolCall.function.name)
      try:
        args = tool.inputSchema.parse(JSON.parse(toolCall.function.arguments))
        raw = await tool.execute(args, deps)
        result = normalize(raw)                     // string -> { content: string }
      catch e:
        result = { content: `Error: ${e.message}`, isError: true }
      emit { type: "tool:end", runId, toolUseId, output: result.content, isError: !!result.isError }

      wireContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content)
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: wireContent })

if turn == maxTurns && !stopReason: stopReason = "max_turns"

if sessionId: sessionStore.set(sessionId, messages)

result = { text: lastAssistantText(messages), messages, stopReason, usage, generationIds, error }
emit { type: "agent:end", runId, result }
return result
```

Notes:
- Tool calls within a single turn run **sequentially** for v1. Parallelization is a future optimization.
- When `maxTurns` is hit mid-turn, the in-flight tool finishes before the loop exits — cleaner side-effect state.
- A thrown tool handler is caught and fed back to the model as an error tool-result; the loop continues. This is how the model recovers from tool failures.
- A thrown OpenRouter client error (network, auth, rate limit) is **not** caught — it bubbles out and aborts the run with `stopReason: "error"`.

## Sessions

```ts
interface SessionStore {
  get(sessionId: string): Promise<Message[] | null>;
  set(sessionId: string, messages: Message[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
```

- Default: `InMemorySessionStore` — a `Map`. Scoped to the current process.
- No `sessionId` passed → run is stateless, no store interaction.
- With `sessionId`: on entry, `get(sessionId)` seeds `messages`; on exit, `set(sessionId, messages)` persists the updated history.
- Users replace the default for Redis / Postgres / etc. by implementing the interface.

## Dependencies

Runtime:

- `zod` — tool input schemas.
- `zod-to-json-schema` — Zod → JSON Schema conversion for OpenRouter's wire format.
- Node 20+ native `fetch` (no HTTP client dependency).

Dev:

- `typescript`, `tsx` or `ts-node`, a test runner (choice deferred until implementation — Vitest is the likely default).

## OpenRouter client (`src/openrouter/client.ts`)

Thin wrapper around `fetch`:

- POSTs to `https://openrouter.ai/api/v1/chat/completions`.
- Sends `Authorization: Bearer`, `Content-Type`, optional `HTTP-Referer`, `X-OpenRouter-Title`.
- Non-streaming only in v1 (`stream: false` / omitted).
- Returns the typed `CompletionsResponse` from `src/openrouter/types.ts`.
- Throws `OpenRouterError` on non-2xx:

```ts
class OpenRouterError extends Error {
  code: number;                          // HTTP status
  body?: unknown;                        // raw parsed JSON body, if any
  metadata?: Record<string, unknown>;    // from the per-choice `error.metadata` field when present
}
```

## Top-level exports (`src/index.ts`)

```ts
export { Agent } from "./agent";
export { Tool } from "./tool";
export { InMemorySessionStore, type SessionStore } from "./session";
export type { Message, ContentPart, ToolCall } from "./types";
export type { ToolDeps, ToolResult } from "./tool";
export type { AgentEvent, EventDisplay } from "./agent";
export { defaultDisplay } from "./agent";
export type { Result, Usage } from "./types";
export type { LLMConfig } from "./openrouter";
export { OpenRouterError } from "./openrouter";
```

## Future work (v2+)

**Token streaming.** Add a `message:delta` event variant. `runStream()` yields deltas as they arrive; `run()` still returns the final `Result`. OpenRouter's streaming API is SSE; the client adds a streaming code path alongside the non-streaming one.

**MCP support.** Additive. Adds:
- `McpServerConfig` discriminated union (`stdio` | `http`).
- `McpClient` speaking JSON-RPC over the chosen transport.
- Internal `McpTool extends Tool` that wraps a remote tool's definition and dispatches `execute` over the client.
- New `Agent` constructor option: `mcpServers?: McpServerConfig[]`. On first use the agent lists tools from each server and merges them into its `tools` array. Optional `mcp__<server>__<tool>` namespacing for collision safety.
- None of this touches the `Agent` loop, `Tool` interface, `Result` shape, or event stream.

**Parallel tool calls within a turn.** The loop currently dispatches tool calls sequentially. `Promise.all` with per-call error isolation is a drop-in change.

**Expanded `ToolDeps`.** Add `signal: AbortSignal`, `runId: string`, and `emit: (event) => void` when a real use case arrives. Additive; existing tools keep working.

**Typed per-tool-class pre-builts.** If users end up writing the same server-tool wrappers repeatedly, a companion package (`sft-agent-tools`?) could ship typed ones (`WebSearchTool`, etc.). Kept out of the core library to keep the surface small.

## Open questions

None at time of writing. If any surface during implementation, capture here before adding to the design.
