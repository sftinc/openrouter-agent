/**
 * `consumeAgentEvents` — typed dispatcher over an `AsyncIterable<AgentEvent>`.
 *
 * Removes the per-consumer `switch (event.type)` boilerplate and gives each
 * handler a fully-narrowed event parameter. Pairs naturally with
 * {@link displayOf} for UI rendering.
 */
import type { AgentEvent } from "./events.js";

/**
 * Per-variant typed handlers. Every handler is optional — events with no
 * matching handler are silently skipped. {@link AgentEventHandlers.onAny}
 * runs after the matching typed handler for every event.
 *
 * Handlers may be sync or async; consumers preserve back-pressure because
 * each handler is awaited before the next event is pulled from the source.
 * A throw from any handler propagates as the rejection of
 * {@link consumeAgentEvents}.
 */
export interface AgentEventHandlers {
  /** Called once at the start of a run. */
  onAgentStart?: (e: Extract<AgentEvent, { type: "agent:start" }>) => void | Promise<void>;
  /** Called once at the end of a run with the final {@link Result}. */
  onAgentEnd?: (e: Extract<AgentEvent, { type: "agent:end" }>) => void | Promise<void>;
  /** Called once per assistant message (including tool-call messages). */
  onMessage?: (e: Extract<AgentEvent, { type: "message" }>) => void | Promise<void>;
  /** Called for each streamed text delta from the assistant. */
  onMessageDelta?: (e: Extract<AgentEvent, { type: "message:delta" }>) => void | Promise<void>;
  /** Called once when a tool invocation begins. */
  onToolStart?: (e: Extract<AgentEvent, { type: "tool:start" }>) => void | Promise<void>;
  /** Called when a tool emits a manual progress signal via `deps.emit`. */
  onToolProgress?: (e: Extract<AgentEvent, { type: "tool:progress" }>) => void | Promise<void>;
  /** Called once when a tool invocation ends (success or failure). */
  onToolEnd?: (e: Extract<AgentEvent, { type: "tool:end" }>) => void | Promise<void>;
  /** Called once at most per run, immediately before a terminal `agent:end` with `stopReason: "error"`. */
  onError?: (e: Extract<AgentEvent, { type: "error" }>) => void | Promise<void>;
  /**
   * Catch-all. Runs AFTER any matching typed handler. Useful for logging or
   * telemetry that should observe every event without enumerating variants.
   */
  onAny?: (e: AgentEvent) => void | Promise<void>;
}

/**
 * Consume an agent event stream, dispatching to typed handlers.
 *
 * @param source Any `AsyncIterable<AgentEvent>` — typically the return value
 *   of `agent.runStream(...)`, an HTTP NDJSON parse loop, or a buffered
 *   replay.
 * @param handlers Optional per-variant handlers plus an optional `onAny`.
 * @returns A promise that resolves once `source` completes normally and
 *   every handler has finished. Rejects if any handler throws or if the
 *   source itself throws.
 *
 * @example
 * ```ts
 * await consumeAgentEvents(agent.runStream("hello"), {
 *   onAgentStart: () => console.log("Thinking…"),
 *   onToolStart:  (e) => console.log("→", e.toolName),
 *   onToolEnd:    (e) => console.log("✓", e.elapsedMs, "ms"),
 *   onAgentEnd:   (e) => console.log("done in", e.elapsedMs, "ms"),
 * });
 * ```
 */
export async function consumeAgentEvents(
  source: AsyncIterable<AgentEvent>,
  handlers: AgentEventHandlers,
): Promise<void> {
  for await (const event of source) {
    switch (event.type) {
      case "agent:start":
        if (handlers.onAgentStart) await handlers.onAgentStart(event);
        break;
      case "agent:end":
        if (handlers.onAgentEnd) await handlers.onAgentEnd(event);
        break;
      case "message":
        if (handlers.onMessage) await handlers.onMessage(event);
        break;
      case "message:delta":
        if (handlers.onMessageDelta) await handlers.onMessageDelta(event);
        break;
      case "tool:start":
        if (handlers.onToolStart) await handlers.onToolStart(event);
        break;
      case "tool:progress":
        if (handlers.onToolProgress) await handlers.onToolProgress(event);
        break;
      case "tool:end":
        if (handlers.onToolEnd) await handlers.onToolEnd(event);
        break;
      case "error":
        if (handlers.onError) await handlers.onError(event);
        break;
    }
    if (handlers.onAny) await handlers.onAny(event);
  }
}
