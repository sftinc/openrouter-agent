import type { Message, Result } from "../types/index.js";

export interface EventDisplay {
  title: string;
  content?: unknown;
}

/**
 * The discriminated-union stream emitted by `runLoop` and consumed by
 * `Agent.runStream()` and display hooks. Discriminate on `event.type`.
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
      type: "agent:start";
      runId: string;
      parentRunId?: string;
      agentName: string;
      display?: EventDisplay;
    }
  | {
      type: "agent:end";
      runId: string;
      result: Result;
      display?: EventDisplay;
    }
  | {
      type: "message:delta";
      runId: string;
      text: string;
    }
  | {
      type: "message";
      runId: string;
      message: Message;
      display?: EventDisplay;
    }
  | {
      type: "tool:start";
      runId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      display?: EventDisplay;
    }
  | {
      type: "tool:progress";
      runId: string;
      toolUseId: string;
      elapsedMs: number;
      display?: EventDisplay;
    }
  | {
      type: "tool:end";
      runId: string;
      toolUseId: string;
      output: unknown;
      metadata?: Record<string, unknown>;
      display?: EventDisplay;
    }
  | {
      type: "tool:end";
      runId: string;
      toolUseId: string;
      error: string;
      metadata?: Record<string, unknown>;
      display?: EventDisplay;
    }
  | {
      type: "error";
      runId: string;
      error: { code?: number; message: string };
      display?: EventDisplay;
    };

/**
 * Fallback display for events that don't carry a `display` field.
 * Consumers should prefer `event.display` if set:
 * `event.display ?? defaultDisplay(event)`.
 *
 * @param event Any `AgentEvent`.
 * @returns An `EventDisplay` with a human-readable title (and optional
 *   content, for errors only). Callers can use this to render a progress
 *   line in a UI without handling every event variant explicitly.
 */
export function defaultDisplay(event: AgentEvent): EventDisplay {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end":
      return { title: "Done" };
    case "message:delta":
      return { title: "Message delta" };
    case "message":
      return { title: "Message" };
    case "tool:start":
      return { title: `Running ${event.toolName}` };
    case "tool:progress":
      return { title: `Still running (${Math.round(event.elapsedMs / 1000)}s)` };
    case "tool:end":
      return { title: "error" in event ? "Tool failed" : "Completed tool" };
    case "error":
      return { title: "Error", content: event.error.message };
  }
}

export type EventEmit = (event: AgentEvent) => void;
