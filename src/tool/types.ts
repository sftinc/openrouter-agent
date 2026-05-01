/**
 * Type definitions shared between the agent loop and tool implementations.
 *
 * Defines the normalized {@link ToolResult} shape produced from any tool's
 * return value, and the {@link ToolDeps} bundle of dependencies the loop
 * injects into every `Tool.execute()` call (LLM completion callback, abort
 * signal, run identifiers, message snapshot, and an event emitter for
 * tools that bubble their own events into the parent stream).
 *
 * @module tool/types
 */
import type { Message, ToolCall, Usage } from "../types/index.js";
import type { Annotation, LLMConfig, OpenRouterTool } from "../openrouter/index.js";
import type { AgentEvent } from "../agent/events.js";

/**
 * Normalized tool result. Tools may return any value: a bare string, number,
 * object, or array becomes the success payload. To signal failure, either
 * throw (the loop catches) or return `{ error: "message" }`. `metadata` is
 * optional and never sent to the model — it's for events, UI, and logs.
 *
 * A string return from a tool handler is sugar for `{ content: string }`.
 * A non-string return that isn't already a ToolResult is wrapped as
 * `{ content: value }`. Non-string `content` is JSON-stringified before
 * being sent to the model.
 *
 * The two arms are mutually exclusive — a result is either a success
 * (with `content`) or a failure (with `error`), never both.
 */
export type ToolResult =
  | {
      /**
       * The success payload returned to the model. May be any JSON-serializable
       * value; non-string values are JSON-stringified at the wire boundary.
       */
      content: unknown;
      /**
       * Optional auxiliary data attached to the `tool:success` event. Never
       * included in the message sent back to the model.
       */
      metadata?: Record<string, unknown>;
    }
  | {
      /**
       * Human-readable failure message. Forwarded to the model in the
       * `role: "tool"` reply so it can recover or apologize.
       */
      error: string;
      /**
       * Optional auxiliary data attached to the `tool:error` event. Never
       * included in the message sent back to the model.
       */
      metadata?: Record<string, unknown>;
    };

/**
 * Dependencies injected into every tool's `execute()` call. Optional fields
 * are always populated by the agent loop; user tools can ignore them. Agents
 * used as subagents rely on `emit` and `runId` to bubble their own events
 * up into the parent's stream.
 *
 * Tools generally need only `complete` (for nested LLM calls) and `signal`
 * (to honor cancellation). The remaining fields exist for advanced cases
 * such as wrapping an `Agent` as a tool.
 */
export interface ToolDeps {
  /**
   * Issue a one-shot LLM completion using the active agent's OpenRouter
   * client and default model/options. Useful for tools that want to ask
   * the model a follow-up question without spawning a full subagent.
   *
   * @param messages The full conversation to send. Caller is responsible
   *   for assembling system/user/assistant turns; the loop does not inject
   *   anything here.
   * @param options Optional per-call overrides.
   * @param options.client Override the {@link LLMConfig} (model, sampling
   *   params, provider routing, etc.) for just this call.
   * @param options.tools Override the OpenRouter tool list advertised on
   *   this call. Pass `[]` to forbid tool use.
   * @returns The completion's `content` (or `null` on tool-only turns),
   *   {@link Usage} accounting, any `tool_calls` the model produced, and
   *   any `annotations` such as URL citations.
   */
  complete: (
    messages: Message[],
    options?: { client?: LLMConfig; tools?: OpenRouterTool[] }
  ) => Promise<{
    content: string | null;
    usage: Usage;
    tool_calls?: ToolCall[];
    annotations?: Annotation[];
  }>;
  /**
   * Forward an {@link AgentEvent} into the parent run's event stream.
   * Present when this tool is being executed inside a parent agent — for
   * example, when an `Agent` is wrapped as a tool. Subagents call this to
   * surface their internal lifecycle events (token deltas, nested tool
   * calls, etc.) to the outer consumer.
   *
   * Undefined when no parent emitter is wired up; tools that emit defensively
   * should guard with `if (deps.emit)`.
   */
  emit?: (event: AgentEvent) => void;
  /**
   * Abort signal tied to the current run. Aborts when the consumer calls
   * `AgentRun.abort()` or when an outer `AbortController` fires. Tools
   * performing I/O should pass this through to `fetch`, child processes,
   * etc. so cancellation propagates promptly.
   */
  signal?: AbortSignal;
  /**
   * Identifier of the current run. Same value as the `runId` on every
   * agent event for this run. Useful for correlating logs.
   */
  runId?: string;
  /**
   * Identifier of the parent run when this tool is executing inside a
   * subagent. Undefined for top-level runs.
   */
  parentRunId?: string;
  /**
   * Snapshot of the loop's in-memory messages at the moment of the call:
   * prior session history, the user input, and every completed
   * assistant/tool turn produced earlier in this run.
   *
   * The assistant message currently invoking this tool is excluded so the
   * snapshot is always a valid conversation that can be forwarded to any
   * LLM provider (Anthropic in particular rejects an unmatched `tool_use`
   * block, which would otherwise occur because the in-flight tool has no
   * `tool_result` yet — it _is_ the result). For parallel tool calls in a
   * batch, sibling tools' results are also excluded so the snapshot stays
   * a valid conversation; tools that need their own invocation context
   * receive it via `Tool.execute`'s validated `args` parameter.
   *
   * The system prompt is never included; it is only injected at the
   * OpenRouter wire boundary. Returns a fresh array each call; mutating it
   * does not affect the loop.
   *
   * @returns A defensive copy of the conversation visible to this tool
   *   call, ending at the last completed turn.
   */
  getMessages?: () => Message[];
  /**
   * Caller-supplied data for the current run, made available to tools and
   * propagated verbatim into every subagent invocation. Set once at the
   * top-level {@link Agent.run} call via {@link AgentRunOptions.context};
   * never seen by the LLM.
   *
   * Treat as read-only: mutating this object does not affect subagents or
   * sibling tool calls, and the framework reserves the right to freeze it
   * in a future release. `undefined` when the caller did not supply one.
   *
   * @example
   * ```ts
   * import { Tool } from "./tool";
   * import { z } from "zod";
   *
   * const calendar = new Tool({
   *   name: "search_calendar",
   *   description: "Find events on the user's calendar.",
   *   inputSchema: z.object({ query: z.string() }),
   *   execute: async ({ query }, deps) => {
   *     const ctx = deps.context ?? {};
   *     return await calendarApi.search({
   *       userId: ctx.userId as string,
   *       timezone: (ctx.timezone as string) ?? "UTC",
   *       query,
   *     });
   *   },
   * });
   * ```
   */
  context?: Record<string, unknown>;
}
