/**
 * Event vocabulary for the agent module.
 *
 * Defines the {@link AgentEvent} discriminated union streamed by
 * {@link runLoop}, the {@link AgentDisplayHooks} consumed by `Agent` to
 * decorate events with human-readable titles, the {@link EventDisplay} shape
 * those hooks resolve to, the {@link EventEmit} callback type used to push
 * events into the stream, and a {@link defaultDisplay} fallback for
 * consumers that want a one-line description of any event without writing a
 * per-variant switch.
 */
import type { Message, Result } from "../types/index.js";

/**
 * A pre-rendered, display-friendly representation of an event. Attached to
 * most {@link AgentEvent} variants either by the user-supplied
 * {@link AgentDisplayHooks} / `Tool` display hooks or by
 * {@link defaultDisplay} as a fallback.
 */
export interface EventDisplay {
  /** Human-readable single-line label for the event (always required). */
  title: string;
  /**
   * Optional payload to render alongside the title (for example an error
   * message, a structured summary, or markdown). Type is intentionally
   * `unknown` because the loop passes it through opaquely; consumers decide
   * how to render based on context.
   */
  content?: unknown;
}

/**
 * Display hooks for an Agent, mirroring `Tool`'s shape. Each hook returns a
 * `Partial<EventDisplay>` that the loop merges with the `title` default. If
 * neither the hook nor the default produces a string `title`, no `display`
 * field is attached to the corresponding event.
 *
 * Outcome routing for `agent:end`:
 *   - `stopReason === "done"`   → `success` (falls back to `end`)
 *   - `stopReason === "error"`  → `error`   (falls back to `end`)
 *   - `aborted` / `max_turns` / `length` / `content_filter` → `end`
 *
 * If only `end` is supplied, it handles every terminal state. Hooks are
 * invoked through a try/catch so a throw can't take down the run.
 */
export interface AgentDisplayHooks {
  /**
   * Default title for both `agent:start` and `agent:end`. Per-phase hooks can
   * override it by returning their own `title`. A function form receives the
   * original input passed to `agent.run()`.
   */
  title?: string | ((input: string | Message[]) => string);
  /**
   * Called when emitting `agent:start`. Receives the original `agent.run()`
   * input. Return any subset of {@link EventDisplay} fields to override or
   * augment the default title.
   */
  start?: (input: string | Message[]) => Partial<EventDisplay>;
  /**
   * Called when emitting `agent:end` with `stopReason === "done"`. If
   * omitted, the loop falls back to {@link AgentDisplayHooks.end}.
   */
  success?: (result: Result) => Partial<EventDisplay>;
  /**
   * Called when emitting `agent:end` with `stopReason === "error"`. If
   * omitted, the loop falls back to {@link AgentDisplayHooks.end}.
   */
  error?: (result: Result) => Partial<EventDisplay>;
  /**
   * Universal terminal-state hook. Used for `aborted`, `max_turns`,
   * `length`, `content_filter`, and as the fallback for `done` / `error`
   * when their dedicated hooks aren't supplied.
   */
  end?: (result: Result) => Partial<EventDisplay>;
}

/**
 * The discriminated-union stream emitted by `runLoop` and consumed by
 * `Agent.run()` and display hooks. Discriminate on `event.type`.
 *
 * **Lifecycle order** (per run):
 *   `agent:start` → (`message:delta*` + `message` | `tool:start` + `tool:progress*` + `tool:end`)* → (`error`)? → `agent:end`
 *
 * **Events:**
 * - `agent:start` — fires once, immediately after the runId is assigned,
 *   before any session load or LLM call.
 * - `message:delta` — fires zero or more times per assistant turn as text
 *   tokens arrive from the streaming transport. Each delta carries only the
 *   new text since the previous delta, not the accumulated buffer. Does not
 *   fire for tool-call arg deltas (those are only exposed via the final
 *   `message` event's `tool_calls`).
 * - `message` — fires once per assistant message (including tool-call
 *   messages). Does NOT fire for user or tool-role messages.
 * - `tool:start` — fires when a tool invocation begins. `input` is the
 *   parsed JSON args (best-effort; `{}` on parse failure).
 * - `tool:progress` — only fires if a tool emits one manually via
 *   `deps.emit`. The loop itself never emits this.
 * - `tool:end` — fires once per tool invocation. Discriminate success vs
 *   failure via `"error" in event`.
 * - `error` — fires once at most per run, just before a terminal
 *   `stopReason: "error"`.
 * - `agent:end` — fires once, last, with the final `Result`.
 */
export type AgentEvent =
  | {
      /** Discriminator: marks the start of a run. */
      type: "agent:start";
      /** Unique id for this run. Stable for the lifetime of one `runLoop` invocation. */
      runId: string;
      /**
       * Run id of the enclosing parent run, when this run is a subagent
       * invocation. Undefined for top-level runs.
       */
      parentRunId?: string;
      /** Name of the agent being started, taken from `RunLoopConfig.agentName`. */
      agentName: string;
      /** Resolved display payload from the agent's `start` hook, if any. */
      display?: EventDisplay;
      /** Wall-clock epoch ms captured at the moment this event was emitted. */
      startedAt: number;
    }
  | {
      /** Discriminator: marks the terminal event of a run. */
      type: "agent:end";
      /** Unique id of the run that just ended. Matches the prior `agent:start`. */
      runId: string;
      /** Final {@link Result} including stop reason, accumulated usage, and full message log. */
      result: Result;
      /** Resolved display payload from the agent's terminal hook (`success` / `error` / `end`), if any. */
      display?: EventDisplay;
      /** Wall-clock epoch ms when the run started (matches the prior `agent:start.startedAt`). */
      startedAt: number;
      /** Wall-clock epoch ms when the run ended (this event was emitted). */
      endedAt: number;
      /** `endedAt - startedAt`. Provided so consumers can render durations without subtracting. */
      elapsedMs: number;
    }
  | {
      /** Discriminator: incremental token output from the assistant. */
      type: "message:delta";
      /** Run id this delta belongs to. */
      runId: string;
      /** Newly arrived text since the previous delta. NOT a cumulative buffer. */
      text: string;
    }
  | {
      /** Discriminator: a complete assistant message (possibly with `tool_calls`). */
      type: "message";
      /** Run id this message belongs to. */
      runId: string;
      /** The full assistant {@link Message} as it was appended to the conversation. */
      message: Message;
      /** Reserved for future per-message display rendering; currently unused by the loop. */
      display?: EventDisplay;
    }
  | {
      /** Discriminator: a tool invocation has started. */
      type: "tool:start";
      /** Run id this tool call belongs to. */
      runId: string;
      /** Stable identifier for this tool invocation, used to correlate with `tool:end` (and any `tool:progress`). */
      toolUseId: string;
      /** Name of the tool as registered on the agent. */
      toolName: string;
      /** Best-effort parsed JSON args. Falls back to `{}` if argument parsing failed. */
      input: unknown;
      /** Resolved display payload from the tool's `start` hook, if any. */
      display?: EventDisplay;
      /** Wall-clock epoch ms captured at the moment this event was emitted. */
      startedAt: number;
    }
  | {
      /** Discriminator: optional progress signal a tool may emit manually via `deps.emit`. The loop never produces this on its own. */
      type: "tool:progress";
      /** Run id this tool call belongs to. */
      runId: string;
      /** Identifier matching the originating `tool:start`. */
      toolUseId: string;
      /** Milliseconds since the tool started, as reported by the tool. */
      elapsedMs: number;
      /** Optional display payload supplied by the tool. */
      display?: EventDisplay;
      /** Wall-clock epoch ms when the originating `tool:start` was emitted. */
      startedAt: number;
    }
  | {
      /** Discriminator: a tool invocation completed successfully. */
      type: "tool:end";
      /** Run id this tool call belongs to. */
      runId: string;
      /** Identifier matching the originating `tool:start`. */
      toolUseId: string;
      /** Tool result content (the same value passed back to the model in the `tool` role message). */
      output: unknown;
      /** Optional structured metadata returned by the tool, surfaced for telemetry/UI. */
      metadata?: Record<string, unknown>;
      /** Resolved display payload from the tool's `success` hook, if any. */
      display?: EventDisplay;
      /** Wall-clock epoch ms when the originating `tool:start` was emitted. */
      startedAt: number;
      /** Wall-clock epoch ms when this `tool:end` was emitted. */
      endedAt: number;
      /** `endedAt - startedAt`. Provided so consumers can render durations without subtracting. */
      elapsedMs: number;
    }
  | {
      /** Discriminator: a tool invocation failed. Distinguish from the success variant via `"error" in event`. */
      type: "tool:end";
      /** Run id this tool call belongs to. */
      runId: string;
      /** Identifier matching the originating `tool:start`. */
      toolUseId: string;
      /** Human-readable error message; this same string is sent back to the model. */
      error: string;
      /** Optional structured metadata captured alongside the error. */
      metadata?: Record<string, unknown>;
      /** Resolved display payload from the tool's `error` hook, if any. */
      display?: EventDisplay;
      /** Wall-clock epoch ms when the originating `tool:start` was emitted. */
      startedAt: number;
      /** Wall-clock epoch ms when this `tool:end` was emitted. */
      endedAt: number;
      /** `endedAt - startedAt`. Provided so consumers can render durations without subtracting. */
      elapsedMs: number;
    }
  | {
      /** Discriminator: a run-fatal error. Always immediately precedes an `agent:end` with `stopReason: "error"`. */
      type: "error";
      /** Run id this error belongs to. */
      runId: string;
      /**
       * Error envelope. `code` is included only when the underlying provider
       * supplied one (typically an HTTP-style status). `message` is always
       * present.
       */
      error: { code?: number; message: string };
      /** Reserved for future error-level display rendering; currently unused by the loop. */
      display?: EventDisplay;
    };

/**
 * Fallback display for events that don't carry a `display` field.
 * Consumers should prefer `event.display` if set:
 * `event.display ?? defaultDisplay(event)`.
 *
 * @param event Any {@link AgentEvent}.
 * @returns An {@link EventDisplay} with a human-readable title (and optional
 *   content, for errors only). Callers can use this to render a progress
 *   line in a UI without handling every event variant explicitly.
 *
 * @example
 * ```ts
 * for await (const ev of agent.run("hello")) {
 *   const { title, content } = ev.display ?? defaultDisplay(ev);
 *   console.log(title);
 * }
 * ```
 */
export function defaultDisplay(event: AgentEvent): EventDisplay {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end": {
      const seconds = Math.max(1, Math.round(event.elapsedMs / 1000));
      const errored = event.result.stopReason === "error";
      return {
        title: errored
          ? `Completed with errors in ${seconds}s`
          : `Completed in ${seconds}s`,
      };
    }
    case "message:delta":
      return { title: "Message delta" };
    case "message":
      return { title: "Message" };
    case "tool:start":
      return { title: `Running ${event.toolName}` };
    case "tool:progress":
      return { title: `Still running (${Math.round(event.elapsedMs / 1000)}s)` };
    case "tool:end": {
      const seconds = Math.max(1, Math.round(event.elapsedMs / 1000));
      return {
        title: "error" in event ? `Tool failed after ${seconds}s` : `Completed tool in ${seconds}s`,
      };
    }
    case "error":
      return { title: "Error", content: event.error.message };
  }
}

/**
 * Synchronous callback that pushes an {@link AgentEvent} into a consumer
 * (typically an {@link AgentRun} buffer or a parent agent's event stream).
 * Intentionally fire-and-forget: emitters never await delivery, and
 * implementations must not throw.
 *
 * @param event The event to deliver.
 */
export type EventEmit = (event: AgentEvent) => void;
