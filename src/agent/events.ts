import type { Message, Result } from "../types/index.js";

export interface EventDisplay {
  title: string;
  content?: unknown;
}

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
 * Consumers should prefer `event.display` if set: `event.display ?? defaultDisplay(event)`.
 */
export function defaultDisplay(event: AgentEvent): EventDisplay {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end":
      return { title: "Done" };
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
