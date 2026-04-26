# @sftinc/openrouter-agent

A small, typed Node.js + TypeScript agent-loop wrapper around [OpenRouter](https://openrouter.ai). Provide a model, a system prompt, and a set of tools; the loop drives the assistant ↔ tool conversation, streams structured events as it progresses, and persists conversation history through a pluggable session store.

The public surface is intentionally narrow. There is one canonical entrypoint — the package root — and one canonical run method (`agent.run(input)`) that is both awaitable and async-iterable.

- **Status:** `0.0.0` — the API is settling. Wire-shape types may move from folder-internal to package-public before `1.0`.
- **Runtime:** Node.js `>= 20` (uses native `fetch`, `AbortSignal`, `ReadableStream`).
- **License:** see `package.json`.

## Table of contents

- [Install](#install)
- [Environment](#environment)
- [Quickstart](#quickstart)
- [Streaming events](#streaming-events)
- [Subagents](#subagents)
- [Serving over HTTP](#serving-over-http)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Examples](#examples)
- [Development](#development)
- [For AI coding agents](#for-ai-coding-agents)

## Install

```bash
npm install @sftinc/openrouter-agent zod
```

`zod` is a peer of the package — it is the only validation library accepted for tool input schemas, and the package generates JSON Schema from your Zod schemas via Zod 4's `z.toJSONSchema()`.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes (unless `apiKey` passed explicitly) | OpenRouter API key. The lazy default client and any `new OpenRouterClient()` call without an explicit `apiKey` falls back to this. |
| `OPENROUTER_DEBUG` | No | When set to a truthy value, the client logs request/response bodies for streaming and non-streaming completions. Verbose — leave unset in production. |

## Quickstart

Register a project-wide OpenRouter client at startup, define one or more tools, and run an agent:

```ts
import { z } from "zod";
import { setOpenRouterClient, Tool, Agent } from "@sftinc/openrouter-agent";

setOpenRouterClient({
  model: "anthropic/claude-haiku-4.5",
  max_tokens: 2000,
  temperature: 0.3,
  title: "my-app",
});

const calculator = new Tool({
  name: "calculator",
  description: "Evaluate a basic arithmetic expression.",
  inputSchema: z.object({ expression: z.string() }),
  execute: async ({ expression }) =>
    String(Function(`"use strict"; return (${expression});`)()),
});

const agent = new Agent({
  name: "demo-assistant",
  description: "A helpful assistant with a calculator.",
  systemPrompt: "You are concise and helpful.",
  tools: [calculator],
});

const result = await agent.run("What is 347 * 29?");

console.log(result.text);        // assistant's final text
console.log(result.stopReason);  // "done" | "max_turns" | "length" | "content_filter" | "error" | "aborted"
console.log(result.usage);       // token + cost totals across the whole run
```

`setOpenRouterClient(...)` is the simplest path; for tests or multi-tenant servers, construct an `OpenRouterClient` directly and pass it as `client` on either `AgentConfig` or per-run `AgentRunOptions`.

## Streaming events

`agent.run(input)` returns an `AgentRun` handle that is **both** `PromiseLike<Result>` and `AsyncIterable<AgentEvent>`. You choose how to consume it:

```ts
// Awaitable form — wait for the final Result.
const result = await agent.run("Plan a three-day trip to Kyoto.");

// Iterable form — observe events as they happen.
for await (const event of agent.run("Plan a three-day trip to Kyoto.")) {
  if (event.type === "tool:start")    console.log("→", event.toolName);
  if (event.type === "message:delta") process.stdout.write(event.delta.text ?? "");
  if (event.type === "agent:end")     console.log("\nstop:", event.result.stopReason);
}
```

A single `AgentRun` is single-consumer — choose one shape per call. Note that `SessionBusyError` is thrown **synchronously** by `agent.run(...)` (before the handle is returned) when a second concurrent run targets the same `sessionId`, so wrap the call site, not the `await`:

```ts
import { SessionBusyError } from "@sftinc/openrouter-agent";

try {
  const run = agent.run(input, { sessionId: "user-42" });
  const result = await run;
} catch (err) {
  if (err instanceof SessionBusyError) {
    // map to HTTP 409 in a server context
  } else {
    throw err;
  }
}
```

For the full event vocabulary (`agent:start`, `message`, `message:delta`, `tool:start`, `tool:progress`, `tool:end` success/error, `error`, `agent:end`), see [docs/api/agent.md](./docs/api/agent.md).

## Subagents

`Agent` extends `Tool`, so any agent can be passed as a tool to another agent:

```ts
const researcher = new Agent({
  name: "researcher",
  description: "Find authoritative answers to factual questions.",
  systemPrompt: "Cite sources in every answer.",
  tools: [/* … */],
});

const orchestrator = new Agent({
  name: "orchestrator",
  description: "Plan and delegate.",
  systemPrompt: "Delegate research to the researcher subagent.",
  tools: [researcher], // ← agent used as a tool
});
```

Events emitted from inside a subagent carry a `parentRunId` linking them back to the outer run. The outer `agent:end` event resolves only when the outer `runId` finishes; subagent `agent:end` events do not terminate the parent stream.

## Serving over HTTP

The package ships streaming HTTP helpers for both Node `http`/`http2` and the Web `Response` model. Events are serialized as NDJSON, one event per line, with a synthetic terminal error event on either side if the stream breaks.

Node (Express, Fastify, raw `http`):

```ts
import { handleAgentRun } from "@sftinc/openrouter-agent";

app.post("/api/chat", async (req, res) => {
  await handleAgentRun({ agent, req, res, input: req.body.input, sessionId: req.body.sessionId });
});
```

Web (Cloudflare Workers, Deno, Bun, Next.js App Router):

```ts
import { handleAgentRunWebResponse } from "@sftinc/openrouter-agent";

export async function POST(request: Request) {
  const { input, sessionId } = await request.json();
  return handleAgentRunWebResponse({ agent, request, input, sessionId });
}
```

Both helpers wire `AbortSignal` to the underlying transport (so a closed connection aborts the run), set NDJSON `Content-Type` headers, and map `SessionBusyError` to HTTP `409`. For lower-level control, drop down to `pipeEventsToNodeResponse` / `eventsToWebResponse`. See [docs/api/helpers.md](./docs/api/helpers.md) for full options and a browser-side decoder example.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        @sftinc/openrouter-agent                  │
│                                                                  │
│   src/agent/      Agent class, run loop, AgentEvent vocabulary   │
│       │                                                          │
│       ├─ extends ─────► src/tool/      Tool class, ToolDeps      │
│       │                                                          │
│       ├─ uses ───────► src/openrouter/ OpenRouterClient (HTTP)   │
│       │                                                          │
│       ├─ uses ───────► src/session/    SessionStore persistence  │
│       │                                                          │
│       └─ emits ──────► src/types/      Message, Result, Usage    │
│                                                                  │
│   src/helpers/    Display fallbacks, NDJSON codec, HTTP adapters │
│   src/lib/        Internal utilities (NOT public)                │
└──────────────────────────────────────────────────────────────────┘
```

Concretely, an `Agent`:

1. Reads the project-wide `OpenRouterClient` (set via `setOpenRouterClient`) at construction time, unless a per-agent or per-run `client` is provided.
2. On each `run`, loads prior history from its `SessionStore` (defaulting to `InMemorySessionStore`), strips any persisted `system` messages, prepends the agent's `systemPrompt`, and appends the new user input.
3. Posts the conversation to OpenRouter, observes `tool_calls`, validates each call's arguments with Zod, runs the tool's `execute(args, deps)`, and feeds the result back as a `role: "tool"` message.
4. Repeats until the model returns a final assistant message, hits `maxTurns`, errors, or is aborted.
5. On a clean stop only (`done` / `max_turns` / `length` / `content_filter`), persists the new tail back to the session — failed and aborted runs leave the session untouched, so retry is safe.

## API reference

The full API reference lives in [`docs/api/`](./docs/api/index.md). Every public export, parameter, field, default, and error is documented.

| Page | Covers |
| --- | --- |
| [Agent Layer](./docs/api/agent.md) | `Agent`, `AgentConfig`, `AgentRunOptions`, `AgentRun`, every `AgentEvent` variant, loop semantics |
| [Tool Layer](./docs/api/tool.md) | `Tool`, `ToolConfig`, `ToolDeps`, `ToolResult`, `ToolDisplayHooks`, result coercion, validation |
| [OpenRouter Client](./docs/api/openrouter.md) | `OpenRouterClient`, `setOpenRouterClient`, `OpenRouterError`, `DEFAULT_MODEL`, `LLMConfig`, request/response types |
| [Session Layer](./docs/api/session.md) | `SessionStore`, `InMemorySessionStore`, `SessionBusyError`, custom-store sketches |
| [Conversation Types](./docs/api/types.md) | `Message`, `ContentPart`, `ToolCall`, `Usage`, `Result`, all `stopReason` values |
| [Event Helpers](./docs/api/helpers.md) | Display, consumption, NDJSON codec, Node/Web HTTP adapters and handlers |

Start at [`docs/api/index.md`](./docs/api/index.md) for the navigation index and recommended reading order.

## Examples

Two runnable examples ship in `examples/`:

- `examples/websearch.ts` — single-shot `OpenRouterClient.complete` call with the `openrouter:web_search` server tool.

  ```bash
  npm run websearch -- "Latest GDP figures for Brazil"
  ```

- `examples/demo/` — Node HTTP server that streams `AgentEvent` NDJSON to a browser chat client. Useful as a reference integration for `handleAgentRun`.

  ```bash
  npm run demo
  # → http://localhost:3000
  ```

Both examples expect `OPENROUTER_API_KEY` in a local `.env` file (loaded via `--env-file` in the `npm` scripts).

## Development

```bash
npm install         # install dependencies
npm run typecheck   # tsc --noEmit
npm test            # run the Vitest suite once
npm run test:watch  # watch mode
npm run build       # emit dist/
```

Run a single test file: `npm test -- tests/agent/loop.test.ts`
Run a single test by name: `npm test -- -t "handles tool errors"`

The repository's contributor conventions (folder layout, JSDoc rules) live in [`CLAUDE.md`](./CLAUDE.md). They apply to AI-assisted edits and human PRs equally.

## For AI coding agents

This package is designed to be readable by both humans and AI coding agents (Claude Code, Copilot, Cursor, etc.). To work with it efficiently:

1. **Treat `docs/api/` as the source of truth.** Every public export, parameter, field, default, and error is documented there with `file:line` citations into the source.
2. **Treat the package root as the only supported import path.** Do not import from `@sftinc/openrouter-agent/src/...`. Symbols flagged "folder-internal" in the API docs may move without a major-version bump.
3. **One run method, two shapes.** `agent.run(input, options?)` returns an `AgentRun`. Either `await` it for a `Result`, or `for await` it for events. Do not look for a separate `runStream` — there isn't one.
4. **`SessionBusyError` throws synchronously** from `agent.run(...)` itself (before the handle is returned). Wrap the call, not the `await`.
5. **`Agent extends Tool`** — to compose subagents, just put one `Agent` in another's `tools` array. Subagent events bubble up with `parentRunId` set; the outer `agent:end` is filtered by outer `runId`.
6. **Sessions strip the `system` role.** The agent's `systemPrompt` is configuration, not history. It is never written to a `SessionStore` and is stripped on defensive load.
7. **Failed and aborted runs do not write back to the session.** Retrying the same user input on the same `sessionId` is safe.
8. **Tools validate inputs with Zod, advertise via `z.toJSONSchema(schema, { target: "draft-7" })`.** Use Zod 4 schemas; non-Zod schemas are not supported.

When in doubt, consult [`docs/api/agent.md`](./docs/api/agent.md) for run-loop semantics and [`docs/api/index.md`](./docs/api/index.md) for the full navigation map.
