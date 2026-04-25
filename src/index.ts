/**
 * `@sftinc/openrouter-agent` — package entrypoint.
 *
 * A small, typed Node.js + TypeScript agent-loop wrapper around
 * [OpenRouter](https://openrouter.ai). Provide a model, a system prompt, and
 * a set of {@link Tool}s; the loop drives the assistant ↔ tool conversation,
 * streams structured {@link AgentEvent}s as it progresses, and persists
 * conversation history through a pluggable {@link SessionStore}.
 *
 * The public surface is intentionally narrow:
 *
 * - **OpenRouter client** — {@link setOpenRouterClient}, {@link OpenRouterClient},
 *   {@link OpenRouterError}, {@link DEFAULT_MODEL}, plus the request/response
 *   and configuration types ({@link LLMConfig}, {@link OpenRouterClientOptions},
 *   {@link OpenRouterTool}, {@link CompletionsRequest},
 *   {@link CompletionsResponse}).
 * - **Tool layer** — {@link Tool} and its config/dependency/result types
 *   ({@link ToolConfig}, {@link ToolDisplayHooks}, {@link ToolDeps},
 *   {@link ToolResult}).
 * - **Agent layer** — {@link Agent}, its config/options ({@link AgentConfig},
 *   {@link AgentRunOptions}), the event vocabulary
 *   ({@link AgentEvent}, {@link AgentDisplayHooks}, {@link EventDisplay},
 *   {@link EventEmit}, {@link defaultDisplay}), and the event-consumer
 *   helpers ({@link consumeAgentEvents}, {@link AgentEventHandlers},
 *   {@link displayOf}).
 * - **Sessions** — the {@link SessionStore} interface, the bundled
 *   {@link InMemorySessionStore}, and the {@link SessionBusyError} thrown when
 *   a second concurrent run is started for the same `sessionId`.
 * - **Conversation types** — wire-shape primitives ({@link Message},
 *   {@link ContentPart}, {@link ToolCall}, {@link Usage}) and the
 *   {@link Result} returned from `Agent.run()`.
 *
 * Internal helpers in `src/lib/` (id generation, metric merging, tool-message
 * builders) are not re-exported from this entrypoint; consumers should not
 * depend on them.
 *
 * ## Subfolder map
 *
 * - `src/openrouter/` — HTTP client, wire types, default-client registry.
 * - `src/tool/` — {@link Tool} class and tool-result/dependency types.
 * - `src/agent/` — {@link Agent}, the run loop, and event types.
 * - `src/session/` — pluggable session persistence.
 * - `src/types/` — shared message / content-part / usage / result shapes.
 * - `src/lib/` — internal shared utilities (not part of the public API).
 *
 * @example
 * Quick start — register the project's OpenRouter client once at startup,
 * define tools, and run an {@link Agent}:
 * ```ts
 * import { z } from "zod";
 * import { setOpenRouterClient, Tool, Agent } from "@sftinc/openrouter-agent";
 *
 * setOpenRouterClient({
 *   model: "anthropic/claude-haiku-4.5",
 *   max_tokens: 2000,
 *   temperature: 0.3,
 *   title: "my-app",
 * });
 *
 * const calculator = new Tool({
 *   name: "calculator",
 *   description: "Evaluate a basic arithmetic expression.",
 *   inputSchema: z.object({ expression: z.string() }),
 *   execute: async ({ expression }) =>
 *     String(Function(`"use strict"; return (${expression});`)()),
 * });
 *
 * const agent = new Agent({
 *   name: "demo-assistant",
 *   description: "A helpful assistant with a calculator.",
 *   systemPrompt: "You are concise and helpful.",
 *   tools: [calculator],
 * });
 *
 * const result = await agent.run("What is 347 * 29?");
 * console.log(result.text, result.stopReason, result.usage);
 * ```
 *
 * @example
 * Streaming events from a run:
 * ```ts
 * import type { AgentEvent } from "@sftinc/openrouter-agent";
 *
 * for await (const event of agent.runStream("hello", { sessionId: "user-42" })) {
 *   if (event.type === "tool:start") console.log("→", event.toolName);
 *   if (event.type === "agent:end")  console.log("stop:", event.result.stopReason);
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * OpenRouter client surface.
 *
 * Re-exports the value-level pieces of the OpenRouter integration:
 *
 * - {@link setOpenRouterClient} — register the project-wide
 *   {@link OpenRouterClient} (or build one from options). Call once at app
 *   startup, before constructing any {@link Agent}.
 * - {@link OpenRouterClient} — thin HTTP client for OpenRouter's
 *   `/chat/completions` endpoint and the home for project-wide LLM defaults
 *   (model, sampling knobs, etc.) and OpenRouter auth/attribution headers.
 * - {@link OpenRouterError} — thrown by the client on any non-2xx response;
 *   carries the HTTP status code, parsed body, and provider metadata.
 * - {@link DEFAULT_MODEL} — hardcoded fallback model slug used when no
 *   `model` is supplied at any layer of the config-merge chain.
 */
export {
  setOpenRouterClient,
  OpenRouterClient,
  OpenRouterError,
  DEFAULT_MODEL,
} from "./openrouter/index.js";
/**
 * OpenRouter type surface.
 *
 * Re-exports the type-level shapes used to talk to OpenRouter's chat
 * completions API and to configure the client / per-call overrides:
 *
 * - {@link LLMConfig} — every wire-body field except `messages` and `tools`
 *   (model, sampling knobs, `reasoning`, `response_format`, `tool_choice`,
 *   `plugins`, etc.). Used as the override shape at every layer
 *   (project client, agent, run, tool call).
 * - {@link OpenRouterClientOptions} — `LLMConfig` plus transport fields
 *   (`apiKey`, `title`, `referer`) accepted by
 *   `new OpenRouterClient(options)` and {@link setOpenRouterClient}.
 * - {@link OpenRouterTool} — the wire shape advertised to the model for a
 *   callable tool (function tool, datetime server tool, web-search server
 *   tool).
 * - {@link CompletionsRequest} — the request body posted to
 *   `/chat/completions`: `LLMConfig` + `messages` + optional `tools`.
 * - {@link CompletionsResponse} — the parsed response body returned from
 *   {@link OpenRouterClient.complete}.
 */
export type {
  LLMConfig,
  OpenRouterClientOptions,
  OpenRouterTool,
  CompletionsRequest,
  CompletionsResponse,
} from "./openrouter/index.js";
/**
 * Tool layer.
 *
 * Re-exports the {@link Tool} class — a typed, async function the model is
 * allowed to call. Inputs are validated with a Zod schema; the JSON Schema
 * sent to the model is generated automatically via Zod 4's `z.toJSONSchema()`.
 * The {@link Agent}'s loop advertises the tool to the model, parses and
 * validates each `tool_call`, runs `execute`, and feeds the result back as a
 * `role: "tool"` conversation message.
 */
export { Tool } from "./tool/index.js";
/**
 * Tool type surface.
 *
 * Re-exports the type-level shapes used when defining or consuming tools:
 *
 * - {@link ToolConfig} — constructor argument for `new Tool(...)`
 *   (`name`, `description`, `inputSchema`, `execute`, optional `display`).
 * - {@link ToolDisplayHooks} — optional UI metadata bundle
 *   (`title`, `start`, `progress`, `success`, `error`) attached to tool
 *   events so consumers can render structured tool cards.
 * - {@link ToolDeps} — the second argument every `execute` receives:
 *   inner `complete` for nested LLM calls, `emit` for custom events, the
 *   run's `signal` / `runId` / `parentRunId`, and `getMessages` for a
 *   live snapshot of the loop's conversation.
 * - {@link ToolResult} — the normalized success/error shape `execute` may
 *   return (`{ content, metadata? }` or `{ error, metadata? }`); plain
 *   strings and other values are coerced into this shape.
 */
export type { ToolConfig, ToolDisplayHooks, ToolDeps, ToolResult } from "./tool/index.js";
/**
 * Agent layer (primary entry point).
 *
 * Re-exports the {@link Agent} class — owner of the run loop, the tool
 * registry, and the session store. An `Agent` reads the project's
 * {@link OpenRouterClient} (registered via {@link setOpenRouterClient}) at
 * construction time and exposes both `run` (awaits the final {@link Result})
 * and `runStream` (yields {@link AgentEvent}s as they happen).
 *
 * `Agent` also extends {@link Tool}, so an agent can be passed straight into
 * another agent's `tools` array as a subagent.
 */
export { Agent } from "./agent/index.js";
/**
 * Agent type surface.
 *
 * Re-exports the type-level shapes used to construct and invoke an
 * {@link Agent}:
 *
 * - {@link AgentConfig} — constructor argument for `new Agent(...)`
 *   (`name`, `description`, optional `client` / `systemPrompt` / `tools` /
 *   `inputSchema` / `maxTurns` / `sessionStore` / `display`).
 * - {@link AgentRunOptions} — second argument to `agent.run` and
 *   `agent.runStream` (`sessionId`, `system`, `signal`, `maxTurns`,
 *   per-run `client` overrides, internal `parentRunId`).
 */
export type { AgentConfig, AgentRunOptions } from "./agent/index.js";
/**
 * Session layer.
 *
 * Re-exports the value-level pieces of the session subsystem:
 *
 * - {@link InMemorySessionStore} — the bundled `SessionStore` implementation
 *   suitable for local development and single-process servers. Production
 *   deployments should implement {@link SessionStore} on top of Redis,
 *   Postgres, or similar.
 * - {@link SessionBusyError} — thrown from `Agent.runStream` (on the first
 *   `.next()`) when a second concurrent run is started for the same
 *   `sessionId`. Surface this as HTTP 409 from your server.
 */
export {
  InMemorySessionStore,
  SessionBusyError,
} from "./session/index.js";
/**
 * Session type surface.
 *
 * Re-exports the {@link SessionStore} interface — the contract used by
 * {@link Agent} to read conversation history at the start of a run and
 * write the new tail back on a clean finish. The interface is three async
 * methods: `get`, `set`, `delete`. The system role is never persisted; on a
 * failed/aborted run, the session is not written back, so retrying the same
 * user message is safe.
 */
export type { SessionStore } from "./session/index.js";
/**
 * Event display and consumption helpers.
 *
 * - {@link defaultDisplay} — fallback that produces a sensible
 *   `{ title, content? }` for any {@link AgentEvent} without an explicit
 *   `display` field.
 * - {@link displayOf} — preferred call-site helper; returns
 *   `event.display ?? defaultDisplay(event)` so consumers cannot accidentally
 *   drop the SDK fallback.
 * - {@link consumeAgentEvents} — typed dispatcher over an
 *   `AsyncIterable<AgentEvent>` that routes each event to a per-variant
 *   handler defined by {@link AgentEventHandlers}.
 * - {@link streamText} — async-iterable of assistant text chunks; yields
 *   each `message:delta.text` and falls back to the final assistant message
 *   when no deltas arrive.
 * - {@link serializeEvent} / {@link serializeEventsAsNDJSON} /
 *   {@link readEventStream} — NDJSON codec for streaming events over HTTP.
 *   The serializer yields a synthetic error line on iterator throw; the
 *   reader yields a synthetic error event on malformed lines, so consumers
 *   never see a hard parse failure terminating the iteration.
 * - {@link pipeEventsToNodeResponse} — streams events to a Node
 *   `http.ServerResponse` as NDJSON. Sets default headers, wires abort on
 *   `res.on('close')`, and delegates body to `serializeEventsAsNDJSON`.
 */
export { defaultDisplay, displayOf, consumeAgentEvents, streamText, serializeEvent, serializeEventsAsNDJSON, readEventStream, pipeEventsToNodeResponse } from "./helpers/index.js";
export type { AgentEventHandlers } from "./helpers/index.js";
export type { NodeResponseLike, ResponseAdapterOptions } from "./helpers/index.js";
/**
 * Agent event vocabulary.
 *
 * Re-exports the type-level shapes describing what the loop emits:
 *
 * - {@link AgentDisplayHooks} — optional `start` / `end` UI hooks on
 *   {@link AgentConfig} that decorate `agent:start` and `agent:end` events.
 * - {@link AgentEvent} — discriminated union of every event the loop emits
 *   (`agent:start`, `message`, `tool:start`, `tool:progress`, `tool:end`
 *   success/error, `error`, `agent:end`). Every event carries a `runId` and
 *   nested subagent events carry a `parentRunId`.
 * - {@link EventDisplay} — `{ title, content? }` shape attached to events
 *   for direct UI rendering.
 * - {@link EventEmit} — the `(event: AgentEvent) => void` callback shape used
 *   internally to push events into the stream (also exposed to tools via
 *   `deps.emit`).
 */
export type {
  AgentDisplayHooks,
  AgentEvent,
  EventDisplay,
  EventEmit,
} from "./agent/index.js";
/**
 * Conversation primitives and run result.
 *
 * Re-exports the type-level shapes that describe messages on the wire and
 * the value returned from `Agent.run()`:
 *
 * - {@link Message} — a single conversation message (`system`, `user`,
 *   `assistant`, or `tool` role) with string or {@link ContentPart}[]
 *   content and optional `tool_calls` / `tool_call_id`.
 * - {@link ContentPart} — a single piece of structured message content
 *   (text, image, etc.) used inside multimodal `content` arrays.
 * - {@link ToolCall} — the wire shape of a model-emitted tool invocation
 *   (id, type, function name + JSON-string arguments).
 * - {@link Usage} — token and cost totals returned by OpenRouter; the loop
 *   accumulates these across every completion in a run.
 * - {@link Result} — the final value returned from `Agent.run()`:
 *   `text`, full `messages`, `stopReason`, `usage`, `generationIds`, and
 *   optional `error` (when `stopReason === "error"`).
 */
export type {
  Message,
  ContentPart,
  ToolCall,
  Usage,
  Result,
} from "./types/index.js";
