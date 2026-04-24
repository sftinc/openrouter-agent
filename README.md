# @sftinc/openrouter-agent

A small, typed agent loop wrapper for [OpenRouter](https://openrouter.ai). Give it a model, a system prompt, and a set of `Tool`s; it runs the assistant ↔ tool loop for you, streams events as the run progresses, and persists conversation history through a pluggable `SessionStore`.

The public surface is deliberately small:

- **`setDefaultOpenRouterClient`** — one-call setup for the project-wide OpenRouter client. Register it at app startup and every `Agent` uses it by default.
- **`OpenRouterClient`** — the HTTP client and the home for project-wide LLM defaults (model, max tokens, temperature, etc.) and OpenRouter credentials.
- **`Tool`** — a name + description + Zod input schema + async `execute` function.
- **`Agent`** — owns the run loop, the tool registry, and the session store. Uses an `OpenRouterClient` under the hood.
- **`SessionBusyError`** — thrown when a second concurrent run is started for the same `sessionId`; surface as HTTP 409.
- **`SessionStore`** — pluggable persistence for conversation history (`InMemorySessionStore` is included).
- **`AgentEvent`** — the shape of everything the loop emits (start, message, tool start/end, agent end, error).

The `examples/demo/` server is the canonical reference for wiring this into a real app (HTTP + NDJSON streaming + session ids + retry on busy session). References to "the demo" below point there.

---

## Table of contents

1. [Installation](#installation)
2. [Environment](#environment)
3. [Quick start](#quick-start)
4. [Running the bundled demo](#running-the-bundled-demo)
5. [Core concepts](#core-concepts)
6. [`Agent` — full reference](#agent--full-reference)
7. [`Tool` — full reference](#tool--full-reference)
8. [`OpenRouterClient` — standalone use](#openrouterclient--standalone-use)
9. [`ToolDeps` — what every tool receives](#tooldeps--what-every-tool-receives)
10. [`AgentEvent` stream](#agentevent-stream)
11. [Sessions and concurrency](#sessions-and-concurrency)
12. [LLM configuration](#llm-configuration)
13. [Subagents (an `Agent` as a `Tool`)](#subagents-an-agent-as-a-tool)
14. [Wiring it into an HTTP server](#wiring-it-into-an-http-server)
15. [Error handling and retry semantics](#error-handling-and-retry-semantics)
16. [Debugging](#debugging)
17. [Project layout](#project-layout)

---

## Installation

This package is not yet on npm. Use it from a local checkout:

```bash
git clone <this-repo> sft-agent
cd sft-agent
npm install
npm run build
```

Then in your own project:

```json
{
  "dependencies": {
    "@sftinc/openrouter-agent": "file:../sft-agent",
    "zod": "^3.23.8"
  }
}
```

Requirements:

- Node.js **>= 20** (uses native `fetch`, `AbortController`, ESM).
- `"type": "module"` in your `package.json`, or a bundler that handles ESM.
- Peer: **`zod` ^3.23** for tool input schemas.

---

## Environment

The client reads one environment variable:

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes (or pass `apiKey`) | Your OpenRouter API key |
| `OPENROUTER_DEBUG` | no | When set, logs every request/response and tool result to stdout |

You can also pass `apiKey` directly in `new Agent({ apiKey: "..." })`.

The demo uses `tsx --env-file=.env` to load `.env`; for your own app, use whatever you normally use (`dotenv`, `--env-file`, k8s secrets, etc.).

---

## Quick start

```ts
import { z } from "zod";
import { Tool, Agent } from "@sftinc/openrouter-agent"; // for a minimal example; see the shared-client pattern below for real apps

const calculator = new Tool({
  name: "calculator",
  description: "Evaluate a basic arithmetic expression. Supports + - * / ( ).",
  inputSchema: z.object({
    expression: z.string().describe("e.g. '2 + 2 * 3'"),
  }),
  execute: async ({ expression }) => {
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      throw new Error(`"${expression}" contains non-math characters`);
    }
    return String(Function(`"use strict"; return (${expression});`)());
  },
});

const agent = new Agent({
  name: "demo-assistant",
  description: "A helpful assistant with a calculator.",
  systemPrompt: "You are concise and helpful. Prefer calling tools over guessing.",
  tools: [calculator],
  maxTurns: 8,
});

const result = await agent.run("What is 347 * 29?");
console.log(result.text);        // Final assistant text
console.log(result.stopReason);  // "done" | "max_turns" | ...
console.log(result.usage);       // Token + cost totals across the run
```

### Streaming events

```ts
for await (const event of agent.runStream("what's the time in Tokyo?", { sessionId: "user-42" })) {
  switch (event.type) {
    case "tool:start": console.log("→", event.toolName, event.input); break;
    case "tool:end":   console.log("←", "error" in event ? event.error : event.output); break;
    case "message":    if (event.message.role === "assistant") console.log(event.message.content); break;
    case "agent:end":  console.log("stop:", event.result.stopReason); break;
  }
}
```

Both `run` and `runStream` accept the **same** options (`sessionId`, `signal`, `system`, `maxTurns`, `llm`).

---

## Running the bundled demo

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env
npm install
npm run demo
# → http://localhost:3000
```

The demo is a single-file HTTP server (`examples/demo/server.ts`) that:

- Wires three tools (`calculator`, `current_time`, `web_search`).
- Streams `AgentEvent`s to the browser as **NDJSON** (one JSON object per line).
- Uses a per-browser `sessionId` in `localStorage` to keep conversation history.
- Returns **HTTP 409** when a second request comes in for a session that's already busy.
- Aborts the run if the client disconnects mid-stream — the session is not persisted on abort, so the client can safely retry the same user message.

The browser side (`public/chat.js`) is a plain ES module with no framework — it's intentionally small so you can see exactly how to consume the event stream.

---

## Core concepts

| Concept | What it is |
|---|---|
| **Turn** | One assistant completion + any tool calls it emits (which the loop executes and feeds back). `maxTurns` caps how many of these the agent runs before giving up. |
| **Run** | One call to `agent.run()` / `agent.runStream()`. Produces exactly one `agent:start` and one `agent:end`. |
| **Session** | A conversation history identified by a `sessionId` string. The `SessionStore` reads it at the start of a run and writes the new tail back on a clean finish. |
| **Event** | A structured message the loop emits during a run (`tool:start`, `message`, etc.). Streamable via `runStream`. |
| **Tool** | A typed function the model can call. Inputs are validated with Zod; the JSON schema sent to the model is generated automatically. |
| **Result** | The object returned from `agent.run()`: `text`, full `messages`, `stopReason`, `usage`, `generationIds`. |

---

## `Agent` — full reference

```ts
import { Agent } from "@sftinc/openrouter-agent";
```

### Constructor: `new Agent(config)`

All fields except `name` and `description` are optional.

| Field | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | — | Agent identifier. Also used as the tool name when this agent is nested as a subagent. |
| `description` | `string` | — | One-line description. Shown to parent agents when used as a subagent. |
| `llm` | `LLMConfig` | `{ model: DEFAULT_MODEL }` | Default model and sampling params. See [LLM configuration](#llm-configuration). |
| `systemPrompt` | `string` | — | System prompt injected at the wire boundary every turn. Never stored in the session. |
| `tools` | `Tool<any>[]` | `[]` | Tools exposed to the model on every turn. |
| `inputSchema` | `z.ZodType<Input>` | `z.object({ input: z.string() })` | Used when this `Agent` is nested as a tool. The default accepts `{ input: "..." }`. |
| `maxTurns` | `number` | `10` | Hard cap on assistant turns per run. When hit, `stopReason` is `"max_turns"`. |
| `sessionStore` | `SessionStore` | `new InMemorySessionStore()` | Persistence for conversation history keyed by `sessionId`. |
| `client` | `OpenRouterClient \| OpenRouterClientOptions` | module default, else built from `apiKey`/`title`/`referer` | Client for this agent. Accepts either a pre-built `OpenRouterClient` or the same options object the constructor takes (one is built for you). When set, `apiKey` / `title` / `referer` on this config are ignored. Falls back to the module default set by `setDefaultOpenRouterClient(...)` if one was registered. |
| `apiKey` | `string` | `process.env.OPENROUTER_API_KEY` | OpenRouter API key. Ignored if `client` is set. |
| `title` | `string` | — | Sent as `X-OpenRouter-Title`. Ignored if `client` is set. |
| `referer` | `string` | — | Sent as `HTTP-Referer`. Ignored if `client` is set. |
| `display.start` | `(input) => { title, content? }` | — | Optional UI hook for the `agent:start` event. |
| `display.end` | `(result) => { title, content? }` | — | Optional UI hook for the `agent:end` event. |

### `agent.run(input, options?) → Promise<Result>`

Runs the loop to completion and returns a single `Result` object.

`input` is either:
- a `string` — treated as the user's message, or
- a `Message[]` — treated as the full turn prefix. A `system` message inside the array overrides `systemPrompt` for this run only; other messages are appended to the session history.

`options`:

| Option | Type | Notes |
|---|---|---|
| `sessionId` | `string` | Reads from / writes to the session store. Runs without a `sessionId` are stateless. |
| `system` | `string` | Per-run system prompt override. Wins over both the input's system message and `systemPrompt`. |
| `signal` | `AbortSignal` | Cancels the run. Fires `stopReason: "aborted"` and **does not** persist the session. |
| `maxTurns` | `number` | Per-run override of the agent's `maxTurns`. |
| `llm` | `LLMConfig` | Per-run override merged on top of the agent's default `llm`. |
| `parentRunId` | `string` | Internal; set automatically when an Agent is used as a Tool. |

### `agent.runStream(input, options?) → AsyncIterable<AgentEvent>`

Same signature as `run`, but yields events as they happen. Consumers typically render tool cards and streaming messages from this.

### `Result` shape

```ts
interface Result {
  text: string;             // Last assistant text message
  messages: Message[];      // Full message history at end of run (no system prompt)
  stopReason:
    | "done"              // Model chose to stop (no tool calls)
    | "max_turns"         // Hit maxTurns
    | "aborted"           // Caller aborted via signal
    | "length"            // Ran out of output tokens
    | "content_filter"    // Provider-side content filter tripped
    | "error";            // Provider or transport error; see .error
  usage: Usage;             // Sum across every completion in this run
  generationIds: string[];  // One id per completion; useful for OpenRouter billing lookups
  error?: { code?: number; message: string; metadata?: Record<string, unknown> };
}
```

---

## `Tool` — full reference

```ts
import { Tool } from "@sftinc/openrouter-agent";
```

A tool is a typed, async function the model is allowed to call. The loop:

1. Advertises the tool to the model as a function-tool (name, description, JSON schema derived from your Zod schema).
2. When the model emits a `tool_call`, parses arguments as JSON, validates them with the Zod schema, and passes the validated value to your `execute` function.
3. Normalizes the return value into a `ToolResult` and appends a `tool` role message back to the conversation.

### Constructor: `new Tool(config)`

| Field | Type | What it does |
|---|---|---|
| `name` | `string` | Function name sent to the model. Keep it snake_case, short. |
| `description` | `string` | Used by the model to decide *when* to call this tool. Invest in this — good descriptions drive better tool selection. |
| `inputSchema` | `z.ZodType<Args>` | Zod schema for arguments. Converted to JSON Schema via `zod-to-json-schema`. `.describe(...)` on fields surfaces them to the model. |
| `execute` | `(args, deps) => Promise<unknown>` | The tool's logic. `args` is the parsed+validated Zod output. `deps` is the [ToolDeps](#tooldeps--what-every-tool-receives) bundle. |
| `display` | `ToolDisplayHooks<Args>` | Optional UI metadata — see below. |

### Return values from `execute`

Your function can return any of:

| Return value | Interpreted as |
|---|---|
| `string` | `{ content: string }` — sent verbatim to the model. |
| Any other non-`ToolResult` value | `{ content: value }` — the loop JSON-stringifies non-string `content` before sending it back to the model. |
| `{ content: unknown, metadata? }` | Success. `content` is sent to the model; `metadata` is only for events/UI/logs. |
| `{ error: string, metadata? }` | Tool-level failure. The loop sends `Error: <message>` to the model as the tool result so it can recover. |
| A thrown error | Caught by the loop and turned into `{ error: err.message }`. |

**Rule of thumb:** if the model should know something failed *and* try again differently, return/throw an error. If you want to abort the whole run, call the abort signal from outside.

### Display hooks

The loop decorates every tool-related event with a `display` field your UI can render. Hooks are:

```ts
interface ToolDisplayHooks<Args> {
  title?: string | ((args: Args) => string);              // Default title for every phase
  start?:    (args: Args)                 => Partial<EventDisplay>;
  progress?: (args: Args, meta: { elapsedMs: number }) => Partial<EventDisplay>;
  success?:  (args: Args, output: unknown) => Partial<EventDisplay>;
  error?:    (args: Args, error: unknown)  => Partial<EventDisplay>;
}

interface EventDisplay { title: string; content?: unknown; }
```

Per-phase hooks are merged over the default `title` — if a hook returns no `title`, the default is used. Hooks are wrapped in try/catch so a throwing display function cannot kill the run.

Example (from `examples/demo/server.ts`):

```ts
display: {
  title: (args) => `Calculating ${args.expression}`,
  success: (_args, output) => ({ content: output }),
  error:   (_args, error)  => ({ content: String(error) }),
},
```

---

## `OpenRouterClient` — standalone use

The client is the home for **project-wide LLM defaults** (model, max tokens, temperature, any other `LLMConfig` field) and OpenRouter auth/attribution (`apiKey`, `referer`, `title`). Build one, share it across every `Agent` in the project, and overrides at the agent/run/tool level layer on top.

```ts
import { OpenRouterClient, OpenRouterError, DEFAULT_MODEL } from "@sftinc/openrouter-agent";
```

### Constructor: `new OpenRouterClient(options)`

`OpenRouterClientOptions` extends `LLMConfig`, so every LLM knob from [LLM configuration](#llm-configuration) is valid here, plus three transport fields:

```ts
interface OpenRouterClientOptions extends LLMConfig {
  // LLMConfig fields (model, max_tokens, temperature, top_p, reasoning, ...)
  apiKey?:  string;
  title?:   string;
  referer?: string;
}
```

| Option | Default | What it does |
|---|---|---|
| *any `LLMConfig` field* | — | Project-wide default for that field. Merged under every request. |
| `apiKey` | `process.env.OPENROUTER_API_KEY` | Your OpenRouter key. If neither the option nor the env var is set, the constructor throws. |
| `title` | — | Sent as the `X-OpenRouter-Title` header. OpenRouter uses it for app attribution in the dashboard. |
| `referer` | — | Sent as the `HTTP-Referer` header. Same purpose as `title`. |

### `client.complete(request, signal?) → Promise<CompletionsResponse>`

Posts `request` to `https://openrouter.ai/api/v1/chat/completions`, forces `stream: false`, throws `OpenRouterError` on non-2xx. The request body is `{ DEFAULT_MODEL, ...clientDefaults, ...request }` — per-call fields win over client defaults, which win over the hardcoded fallback model.

```ts
interface CompletionsRequest extends LLMConfig {
  messages: Message[];
  tools?:   OpenRouterTool[];
  stream?:  false;
}
```

`LLMConfig` is the same config object the `Agent` accepts — see [LLM configuration](#llm-configuration) for every field.

### `CompletionsResponse`

```ts
interface CompletionsResponse {
  id: string;
  choices: NonStreamingChoice[];
  created: number;
  model: string;
  object: "chat.completion";
  system_fingerprint?: string;
  usage?: Usage;
}

interface NonStreamingChoice {
  finish_reason: string | null;          // "stop" | "length" | "tool_calls" | "content_filter" | "error" | null
  native_finish_reason: string | null;   // Provider's raw finish reason
  message: {
    content: string | null;
    role: string;
    tool_calls?: ToolCall[];
  };
  error?: { code: number; message: string; metadata?: Record<string, unknown> };
}
```

### `OpenRouterError`

Thrown on any non-2xx response:

```ts
class OpenRouterError extends Error {
  readonly code:     number;                   // HTTP status code
  readonly body?:    unknown;                   // Parsed JSON body if available
  readonly metadata?: Record<string, unknown>;  // From body.error.metadata if present
}
```

Common codes worth handling: `401` (bad key), `402` (insufficient credits), `429` (rate limit), `503` (no capacity on the selected model).

### Project-wide default (recommended)

Set the client once at app startup; every `Agent` constructed afterwards picks it up automatically — no `client:` field needed on each agent:

```ts
import { setDefaultOpenRouterClient, Agent } from "@sftinc/openrouter-agent";

setDefaultOpenRouterClient({
  model: "anthropic/claude-haiku-4.5",
  max_tokens: 2000,
  temperature: 0.3,
  title: "my-app",
});

const assistant  = new Agent({ name: "assistant",  description: "...", tools: [...] });
const summarizer = new Agent({ name: "summarizer", description: "...",
  llm: { temperature: 0 }, // per-agent override layered on the default client's config
});
```

`setDefaultOpenRouterClient` accepts either an options object (shown above — the client is built for you, no need to import `OpenRouterClient`) or a pre-built `OpenRouterClient` instance. It returns the resulting client if you want a reference. Companion functions: `getDefaultOpenRouterClient()` (returns the current default or `undefined`) and `clearDefaultOpenRouterClient()` (useful in tests to reset between cases).

### Explicit per-agent client

If you'd rather avoid module-level state, pass the client directly to each agent. `client` accepts either a pre-built `OpenRouterClient` or the options object (built for you):

```ts
import { Agent } from "@sftinc/openrouter-agent";

// Options form — no need to import OpenRouterClient
const assistant = new Agent({
  name: "assistant",
  description: "...",
  client: { model: "anthropic/claude-haiku-4.5", max_tokens: 2000, title: "my-app" },
  tools: [...],
});

// Pre-built form — share one client across many agents
import { OpenRouterClient } from "@sftinc/openrouter-agent";
const openrouter = new OpenRouterClient({ model: "...", max_tokens: 2000, title: "my-app" });
const summarizer = new Agent({ name: "summarizer", description: "...", client: openrouter, tools: [...] });
```

Precedence when `Agent` picks a client: `config.client` → module default → freshly built from `apiKey` / `title` / `referer` (or env). When any of these provides a client, the agent's `apiKey` / `title` / `referer` fields are ignored.

### Standalone example (no agent)

```ts
import { OpenRouterClient } from "@sftinc/openrouter-agent";

const client = new OpenRouterClient({
  model: "anthropic/claude-haiku-4.5",
  temperature: 0.2,
  title: "my-app",
});

const res = await client.complete({
  messages: [
    { role: "system", content: "You are terse." },
    { role: "user",   content: "Name three primary colors." },
  ],
});

console.log(res.choices[0]?.message.content);
console.log(res.usage);
```

Note the call site doesn't need to specify `model` — it's inherited from the client's defaults.

### With tools (no agent loop)

If you want to drive the tool loop yourself, generate the tool JSON from a `Tool` instance and pass it through:

```ts
import { Tool } from "@sftinc/openrouter-agent";

const myTool = new Tool({ /* ... */ });

const res = await client.complete({
  messages,
  tools: [myTool.toOpenRouterTool()],
});

// res.choices[0].message.tool_calls is where the model asks to call a tool.
```

You'd then validate args with `myTool.inputSchema.parse(...)`, call `myTool.execute(args, deps)`, append a `{ role: "tool", ... }` message, and call `complete` again. That's exactly what `runLoop` does — if you find yourself writing it, use `Agent` instead.

---

## `ToolDeps` — what every tool receives

Every `execute` call gets a second `deps` argument with these fields:

```ts
interface ToolDeps {
  complete: (
    messages: Message[],
    options?: { llm?: LLMConfig; tools?: OpenRouterTool[] }
  ) => Promise<{ content: string | null; usage: Usage; tool_calls?: ToolCall[] }>;
  emit?:        (event: AgentEvent) => void;
  signal?:      AbortSignal;
  runId?:       string;
  parentRunId?: string;
  getMessages?: () => Message[];
}
```

| Field | What you use it for |
|---|---|
| `complete` | Make an **inner** LLM call from within a tool, reusing the agent's configured OpenRouter client and API key. The `web_search` tool in the demo uses this to call OpenRouter's server-side web-search plugin. You can pass your own `tools` and `llm` overrides. |
| `emit` | Push custom `AgentEvent`s into the stream (e.g. a `tool:progress` tick from a long-running tool). |
| `signal` | Abort signal for the current run. Pass it to `fetch`, child processes, etc. so cancellation propagates. |
| `runId` / `parentRunId` | Correlate emitted events with the run. Required when you implement your own subagent-style tool. |
| `getMessages` | Fresh snapshot of the loop's in-memory messages at the moment of the call — session history + user input + every assistant/tool message produced so far in this run, **including** the assistant message whose tool call invoked this tool. The system prompt is never included. Mutating the returned array does not affect the loop. Useful for RAG tools that want to see the conversation so far. |

---

## `AgentEvent` stream

Every event carries the `runId` of the emitting run. Subagents emit their own events (with their own `runId` and a `parentRunId` pointing at the parent's run), so in nested setups you get the full tree.

| `event.type` | Fields | Fires |
|---|---|---|
| `agent:start` | `runId`, `parentRunId?`, `agentName`, `display?` | Once, at the very start of a run. |
| `message` | `runId`, `message`, `display?` | After every assistant completion. `message.role` is always `"assistant"`; `message.tool_calls` may be set. |
| `tool:start` | `runId`, `toolUseId`, `toolName`, `input`, `display?` | Before a tool's `execute` runs. `input` is the parsed args (may not yet be Zod-validated if the loop rejects the call). |
| `tool:progress` | `runId`, `toolUseId`, `elapsedMs`, `display?` | Only if a tool emits one manually via `deps.emit`. The loop itself does not time out tools. |
| `tool:end` (success) | `runId`, `toolUseId`, `output`, `metadata?`, `display?` | After a successful tool call. |
| `tool:end` (error) | `runId`, `toolUseId`, `error`, `metadata?`, `display?` | After a failed tool call. Discriminate with `"error" in event`. |
| `error` | `runId`, `error: { code?, message }`, `display?` | Transport or provider error that terminates the run. Followed by `agent:end` with `stopReason: "error"`. |
| `agent:end` | `runId`, `result`, `display?` | Exactly once, last. |

Every event type also carries an optional `display: { title, content? }` that your UI can render directly. For events without display info, the exported helper `defaultDisplay(event)` produces a sensible fallback:

```ts
import { defaultDisplay } from "@sftinc/openrouter-agent";
const d = event.display ?? defaultDisplay(event);
```

---

## Sessions and concurrency

A `SessionStore` is a plain interface:

```ts
interface SessionStore {
  get(sessionId: string):    Promise<Message[] | null>;
  set(sessionId: string, messages: Message[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
```

The built-in `InMemorySessionStore` is fine for local dev and single-process servers. For production, implement `SessionStore` on top of Redis, Postgres, etc. Two invariants the loop relies on:

- The `system` role is **never** stored. The system prompt is agent config, not conversation — the loop strips any system message on persist and defensively re-strips it on load.
- Persistence is **transactional on clean finish only**. If a run ends with `stopReason` of `"error"` or `"aborted"`, the session is *not* written back. This means a client whose stream drops can safely retry the same user message without duplication.

### Per-session locking

A single `Agent` instance will refuse to start a second concurrent run for the same `sessionId`. It throws a `SessionBusyError`:

```ts
import { Agent, SessionBusyError } from "@sftinc/openrouter-agent";

try {
  for await (const event of agent.runStream(msg, { sessionId })) { ... }
} catch (err) {
  if (err instanceof SessionBusyError) {
    // Surface to client as HTTP 409 and let them retry after a delay.
  }
  throw err;
}
```

This lock is **per-Agent-instance only** — it does not coordinate across processes. If you run multiple app replicas against a shared Redis session store, you need a distributed lock in your `SessionStore` implementation.

`SessionBusyError` is thrown from `runStream` on the **first** `.next()`, which is why the demo server calls `iterator.next()` before writing response headers — so it can return a 409 status instead of a 200-with-error-in-stream.

---

## LLM configuration

`LLMConfig` mirrors OpenRouter's chat completions request body (minus `messages` and `tools`). Every field is optional. Highlights:

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | OpenRouter model slug. Default is `DEFAULT_MODEL` (`inception/mercury-2` at the time of writing — check `src/openrouter/types.ts`). |
| `temperature`, `top_p`, `top_k`, `min_p`, `top_a` | `number` | Standard sampling knobs. |
| `max_tokens` | `number` | Output cap. |
| `frequency_penalty`, `presence_penalty`, `repetition_penalty` | `number` | Anti-repetition knobs. |
| `seed` | `number` | Deterministic sampling (provider-dependent). |
| `stop` | `string \| string[]` | Stop sequences. |
| `response_format` | `{ type: "json_object" }` or JSON-schema-strict | Force structured output. |
| `tool_choice` | `"none" \| "auto" \| { type: "function", function: { name } }` | Force a specific tool or suppress tools. |
| `reasoning` | `{ effort?, max_tokens?, enabled? }` | For reasoning-capable models. |
| `models` | `string[]` | Fallback chain. |
| `route` | `"fallback"` | Routing policy. |
| `provider` | `object` | Provider-specific overrides. |
| `plugins` | `Array<{ id: string; ... }>` | OpenRouter plugins (e.g. web search). |

Precedence at request time (lowest → highest):

1. Hardcoded `DEFAULT_MODEL` (fallback so `model` is never empty)
2. **`OpenRouterClient` defaults** — project-wide settings set on the client itself
3. `new Agent({ llm })` — per-agent override
4. `agent.run(..., { llm })` — per-run override
5. `deps.complete(..., { llm })` inside a tool — per-tool-call override

Each later source is shallow-merged over the previous. Putting `model`, `max_tokens`, and sampling knobs on the `OpenRouterClient` is the recommended place for project-wide defaults.

See `docs/openrouter/llm.md` in this repo for the full schema.

---

## Subagents (an `Agent` as a `Tool`)

`Agent` **extends** `Tool`. Any agent can be passed straight into another agent's `tools` array:

```ts
const researcher = new Agent({
  name: "researcher",
  description: "Researches a topic and returns a short summary with citations.",
  systemPrompt: "You are a research assistant...",
  tools: [webSearch],
  // defaults to inputSchema = z.object({ input: z.string() })
});

const orchestrator = new Agent({
  name: "orchestrator",
  description: "Delegates research tasks and writes final answers.",
  tools: [researcher, calculator],
});
```

When the orchestrator calls `researcher`, the subagent runs its own full loop. Its events (`agent:start`, tool events, `agent:end`) are emitted into the parent's stream with `parentRunId` set to the parent's `runId`, so your UI can render nested activity.

Custom `inputSchema` for a subagent:

```ts
const summarizer = new Agent({
  name: "summarizer",
  description: "Summarize a document.",
  inputSchema: z.object({
    document: z.string(),
    maxWords: z.number().int().positive().default(200),
  }),
  // ...
});
```

If `args` is an object with an `input` field, that string is used as the user message. Otherwise the subagent's input is `String(args)`.

---

## Wiring it into an HTTP server

The full template is `examples/demo/server.ts`. The sketch:

```ts
import { createServer } from "node:http";
import { Agent, SessionBusyError } from "@sftinc/openrouter-agent";

const agent = new Agent({ name: "...", description: "...", tools: [...] });

createServer(async (req, res) => {
  const { message, sessionId } = JSON.parse(await readBody(req));

  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const stream = agent.runStream(message, { sessionId, signal: abort.signal });
  const iterator = stream[Symbol.asyncIterator]();

  // Pull the first event before writing status so we can surface 409 cleanly.
  let first;
  try { first = await iterator.next(); }
  catch (err) {
    if (err instanceof SessionBusyError) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "session busy" }));
    }
    throw err;
  }

  res.writeHead(200, {
    "Content-Type":    "application/x-ndjson",
    "Cache-Control":   "no-cache",
    "X-Accel-Buffering": "no", // disable nginx buffering
  });

  if (!first.done) res.write(JSON.stringify(first.value) + "\n");
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    res.write(JSON.stringify(event) + "\n");
  }
  res.end();
}).listen(3000);
```

Client side (NDJSON frame decoder):

```js
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line));
}
if (buffer.trim()) handleEvent(JSON.parse(buffer));
```

Server-Sent Events (SSE) works just as well — just prepend `data: ` to each line and terminate with a blank line. NDJSON is used in the demo because it survives through nginx without buffering quirks and parses with vanilla `JSON.parse`.

---

## Error handling and retry semantics

| Stop reason | What caused it | Session persisted? | Safe to retry same user message? |
|---|---|---|---|
| `done` | Model chose to stop | yes | no (it already succeeded) |
| `max_turns` | Ran out of turns | yes | depends on your product |
| `length` | Output token cap hit | yes | depends |
| `content_filter` | Provider content filter | yes | no — the last assistant turn is now in the session |
| `aborted` | Caller aborted via `AbortSignal` | **no** | **yes** |
| `error` | Transport / provider error | **no** | **yes** |

On `error`, `Result.error = { code?, message, metadata? }`. `code` is the HTTP status (for transport errors) or the provider's error code (for provider errors). Common OpenRouter codes worth handling: `402` (insufficient credits), `429` (rate limit), `503` (no model capacity). Surface these to users — don't just treat them as "something went wrong."

The demo's retry button drops the broken message bubble and re-posts the original user message; because the session wasn't persisted on error, this "just works."

---

## Debugging

Set `OPENROUTER_DEBUG=1`:

```bash
OPENROUTER_DEBUG=1 npm run demo
```

You'll see one log line per OpenRouter request (response body, with `reasoning` stripped), and one line per tool result. OpenRouter responses that contain tool calls are highlighted yellow, tool results green, to make the loop easy to follow in a terminal.

---

## Project layout

```
src/
├── index.ts                  Public entry — re-exports the surface
├── types/                    Message, ContentPart, ToolCall, Usage, Result
├── openrouter/               Thin HTTP client + wire types + DEFAULT_MODEL
│   ├── client.ts             OpenRouterClient + OpenRouterError
│   └── types.ts              LLMConfig, CompletionsRequest, CompletionsResponse
├── tool/                     Tool class, ToolDeps, ToolResult
├── agent/                    Agent class, runLoop, AgentEvent, defaultDisplay
└── session/                  SessionStore interface + in-memory impl + SessionBusyError

examples/demo/                Reference HTTP demo (server.ts + static client)
docs/openrouter/              OpenRouter API reference (source of truth for integration code)
tests/                        Vitest suite
```

Scripts (`package.json`):

| Script | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run test:watch` | `vitest` |
| `npm run build` | `tsc` — emits `dist/` |
| `npm run demo` | `tsx --env-file=.env examples/demo/server.ts` |

Run a single test file: `npm test -- tests/agent/loop.test.ts`
Run a single test by name: `npm test -- -t "handles tool errors"`

---

## Conventions (if you're contributing)

From `CLAUDE.md`:

- Organize code into subfolders by concern (`src/client/`, `src/agent/`, `src/tools/`).
- One primary export per file; name the file after what it exports (`FooClient.ts` exports `FooClient`).
- Each subfolder has an `index.ts` that re-exports its public surface. Consumers import from the folder, not individual files — `import { FooClient } from "./client"`, not `from "./client/FooClient"`.
- Before adding a new class or function, check whether an existing one in the relevant subfolder can be reused or extended. Lift shared logic into a library folder rather than duplicating.
- `docs/openrouter/` is the source of truth for any OpenRouter integration code.
