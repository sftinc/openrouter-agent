import type { Message, ToolCall, Usage } from "../types/index.js";
import type { LLMConfig, OpenRouterTool } from "../openrouter/index.js";
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
 */
export type ToolResult =
  | { content: unknown; metadata?: Record<string, unknown> }
  | { error: string; metadata?: Record<string, unknown> };

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
