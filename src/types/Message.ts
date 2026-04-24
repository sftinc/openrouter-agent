/**
 * Chat messages exchanged with OpenRouter. Matches the OpenAI-compatible
 * shape documented in docs/openrouter/llm.md.
 */
export type Message =
  | { role: "system"; content: string; name?: string }
  | { role: "user"; content: string | ContentPart[]; name?: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; name?: string }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * Usage accumulated across all LLM calls in a single agent run.
 * Mirrors OpenRouter's ResponseUsage (see docs/openrouter/llm.md §Usage).
 */
export interface Usage {
  /** Total tokens the provider counted as input across all calls. */
  prompt_tokens: number;
  /** Total tokens the provider counted as output across all calls. */
  completion_tokens: number;
  /** prompt_tokens + completion_tokens, for convenience. */
  total_tokens: number;
  /** Optional provider-reported cost in USD. Summed across calls. */
  cost?: number;
  /** Fine-grained breakdown of prompt tokens. */
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
    video_tokens?: number;
  };
  /** Fine-grained breakdown of completion tokens. */
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
  };
  /** OpenRouter server-side tool usage, e.g. web_search_requests. */
  server_tool_use?: {
    web_search_requests?: number;
  };
  /**
   * Cost broken down by upstream pricing component. Provider-dependent.
   * See docs/openrouter/llm.md §Usage.
   */
  cost_details?: {
    upstream_inference_cost?: number;
    upstream_inference_prompt_cost?: number;
    upstream_inference_completions_cost?: number;
  };
  /**
   * Whether the call was billed to the user's BYOK provider key. Reflects the
   * most recent call in this run.
   */
  is_byok?: boolean;
}

/**
 * Result returned by `Agent.run()` (and surfaced via `agent:end` event).
 */
export interface Result {
  /**
   * The final assistant text message after all tool calls in this run.
   * Empty string if the run produced no assistant text (e.g. `error` before
   * any turn completed, or the last turn was all tool calls).
   */
  text: string;
  /** Full conversation including all tool messages from this run. */
  messages: Message[];
  /** Why the loop stopped. `done` is the clean path. */
  stopReason:
    | "done"
    | "max_turns"
    | "aborted"
    | "length"
    | "content_filter"
    | "error";
  /** Accumulated usage across every LLM call in this run. */
  usage: Usage;
  /** Every `response.id` OpenRouter returned, in order. */
  generationIds: string[];
  /** Populated iff `stopReason === "error"`. */
  error?: { code?: number; message: string; metadata?: Record<string, unknown> };
}

/** All valid `Message.role` values, exported for runtime iteration/validation. */
export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export type MessageRole = typeof MESSAGE_ROLES[number];

/** All valid `Result.stopReason` values, exported for runtime iteration/validation. */
export const STOP_REASONS = [
  "done",
  "max_turns",
  "aborted",
  "length",
  "content_filter",
  "error",
] as const;
export type StopReason = typeof STOP_REASONS[number];
