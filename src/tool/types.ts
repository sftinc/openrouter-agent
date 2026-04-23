import type { Message, ToolCall, Usage } from "../types/index.js";
import type { LLMConfig, OpenRouterTool } from "../openrouter/index.js";
import type { AgentEvent } from "../agent/events.js";

/**
 * Normalized tool result. A string return from a tool handler is sugar for
 * `{ content: string }`. `content` is what the model sees (serialized to
 * string before sending if not already a string). `isError` and `metadata`
 * are for events, UI, and logs — never sent to the model.
 */
export interface ToolResult {
  content: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Dependencies injected into every tool's execute() call. Optional fields are
 * always populated by the agent loop; user tools can ignore them. Agents
 * used as subagents rely on `emit` and `runId` to bubble their own events
 * up into the parent's stream.
 */
export interface ToolDeps {
  complete: (
    messages: Message[],
    options?: { llm?: LLMConfig; tools?: OpenRouterTool[] }
  ) => Promise<{ content: string | null; usage: Usage; tool_calls?: ToolCall[] }>;
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  runId?: string;
  parentRunId?: string;
}
