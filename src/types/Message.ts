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
 * Mirrors OpenRouter's ResponseUsage.
 */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  server_tool_use?: {
    web_search_requests?: number;
  };
}

/**
 * Result returned by Agent.run().
 */
export interface Result {
  text: string;
  messages: Message[];
  stopReason:
    | "done"
    | "max_turns"
    | "aborted"
    | "length"
    | "content_filter"
    | "error";
  usage: Usage;
  generationIds: string[];
  error?: { code?: number; message: string; metadata?: Record<string, unknown> };
}
