/**
 * Core conversation type definitions for the sft-agent.
 *
 * This module declares the discriminated-union {@link Message} shape exchanged
 * with OpenRouter (and any OpenAI-compatible chat completions endpoint), the
 * supporting {@link ContentPart} and {@link ToolCall} sub-shapes, the cumulative
 * token/cost {@link Usage} record, the final {@link Result} returned by
 * `Agent.run()`, and the runtime arrays/aliases used for role and stop-reason
 * validation.
 *
 * The shapes here are intentionally aligned with the OpenAI-compatible request
 * and response schemas documented in `docs/openrouter/llm.md` — treat that
 * document as the source of truth when extending these types.
 *
 * @module types/Message
 */

/**
 * A single chat message exchanged with the LLM.
 *
 * `Message` is a discriminated union over the `role` field. Each variant
 * mirrors one of the four message kinds accepted by OpenRouter's chat
 * completions endpoint (see `docs/openrouter/llm.md`). The variants are:
 *
 * - `system` — instructional preamble authored by the application. By
 *   convention these are sourced from `Agent` configuration rather than
 *   stored in {@link Result.messages}; see the codebase note
 *   "Sessions do not store system messages".
 * - `user` — input from the human end-user. May be a plain string, or an
 *   array of {@link ContentPart} objects for multimodal (text + image)
 *   inputs.
 * - `assistant` — output produced by the model. `content` is `null` when the
 *   turn consisted exclusively of `tool_calls`.
 * - `tool` — the result of executing a tool requested by the assistant. Must
 *   reference the originating call via `tool_call_id`.
 *
 * The optional `name` field is forwarded verbatim to OpenRouter and is used
 * by some providers to identify a participant within a role (e.g. multi-user
 * transcripts, named tools).
 *
 * @example Plain user turn
 * ```ts
 * const m: Message = { role: "user", content: "Hello!" };
 * ```
 *
 * @example Assistant turn that requested a tool
 * ```ts
 * const m: Message = {
 *   role: "assistant",
 *   content: null,
 *   tool_calls: [{
 *     id: "call_abc",
 *     type: "function",
 *     function: { name: "get_weather", arguments: '{"city":"SF"}' },
 *   }],
 * };
 * ```
 *
 * @example Tool result
 * ```ts
 * const m: Message = {
 *   role: "tool",
 *   tool_call_id: "call_abc",
 *   content: '{"tempF":68}',
 * };
 * ```
 *
 * @see {@link ContentPart}
 * @see {@link ToolCall}
 * @see {@link MessageRole}
 */
export type Message =
  /**
   * System message — application-authored guidance for the model.
   *
   * @property role - Discriminator. Always `"system"`.
   * @property content - The system prompt text. Required and must be a string.
   * @property name - Optional participant name forwarded to the provider.
   */
  | { role: "system"; content: string; name?: string }
  /**
   * User message — input from the end-user.
   *
   * @property role - Discriminator. Always `"user"`.
   * @property content - Either a plain string, or an array of
   *   {@link ContentPart} objects for multimodal inputs (mixed text + images).
   * @property name - Optional participant name; useful for multi-user
   *   transcripts forwarded to providers that support it.
   */
  | { role: "user"; content: string | ContentPart[]; name?: string }
  /**
   * Assistant message — output produced by the model.
   *
   * @property role - Discriminator. Always `"assistant"`.
   * @property content - The assistant's natural-language reply, or `null` when
   *   the turn produced only tool calls and no visible text.
   * @property tool_calls - Optional list of tool invocations the model has
   *   asked the host to execute. Each entry is a {@link ToolCall}. When
   *   present, the host must respond with one `tool` message per call before
   *   the next assistant turn.
   * @property name - Optional participant name forwarded to the provider.
   */
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; name?: string }
  /**
   * Tool message — the result of executing a previously requested tool call.
   *
   * @property role - Discriminator. Always `"tool"`.
   * @property content - Stringified tool output. Conventionally JSON, though
   *   any string is permitted by the OpenRouter spec.
   * @property tool_call_id - The `id` of the {@link ToolCall} this message
   *   answers. Required by OpenRouter — must match exactly so the model can
   *   correlate the response with its prior request.
   * @property name - Optional tool name; some providers use this to display
   *   the tool that produced the output.
   */
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

/**
 * One element of a multimodal `user` message body.
 *
 * Discriminated union over `type`:
 * - `"text"` — a chunk of plain text.
 * - `"image_url"` — an image referenced by URL (or data URI). The optional
 *   `detail` field follows OpenAI's vision conventions (e.g. `"low"`,
 *   `"high"`, `"auto"`); providers that don't recognize it ignore it.
 *
 * Used as the array form of `Message.content` for `role: "user"` turns.
 *
 * @example
 * ```ts
 * const parts: ContentPart[] = [
 *   { type: "text", text: "What is in this image?" },
 *   { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "high" } },
 * ];
 * ```
 *
 * @see {@link Message}
 */
export type ContentPart =
  /**
   * A plain-text chunk in a multimodal user message.
   *
   * @property type - Discriminator. Always `"text"`.
   * @property text - The text content of this chunk.
   */
  | { type: "text"; text: string }
  /**
   * An image reference in a multimodal user message.
   *
   * @property type - Discriminator. Always `"image_url"`.
   * @property image_url - Image source.
   * @property image_url.url - HTTP(S) URL or `data:` URI for the image.
   * @property image_url.detail - Optional resolution hint (e.g. `"low"`,
   *   `"high"`, `"auto"`). Provider-dependent; ignored when unsupported.
   */
  | { type: "image_url"; image_url: { url: string; detail?: string } };

/**
 * A single tool invocation requested by the assistant.
 *
 * Appears inside the `tool_calls` array of an assistant {@link Message}. The
 * host is expected to execute the named function with the supplied arguments
 * and reply with a `role: "tool"` message whose `tool_call_id` matches `id`.
 *
 * @property id - Unique identifier for this call, generated by the model.
 *   Used to correlate the subsequent `tool` message back to this request.
 * @property type - Discriminator. Always `"function"`. Reserved for future
 *   tool kinds in the OpenAI/OpenRouter spec.
 * @property function - The function call payload.
 * @property function.name - Name of the function to invoke. Must match a tool
 *   the host advertised in its `tools` request parameter.
 * @property function.arguments - JSON-encoded string of the function's
 *   arguments. The host is responsible for parsing — the model is not
 *   guaranteed to emit valid JSON.
 *
 * @example
 * ```ts
 * const call: ToolCall = {
 *   id: "call_abc123",
 *   type: "function",
 *   function: { name: "search", arguments: '{"q":"bun runtime"}' },
 * };
 * ```
 *
 * @see {@link Message}
 */
export type ToolCall = {
  /** Unique identifier for this tool call. Echoed back as `tool_call_id`. */
  id: string;
  /** Tool kind. Always `"function"` in the current OpenRouter spec. */
  type: "function";
  /** The function name + JSON-encoded arguments to invoke. */
  function: {
    /** Name of the function to invoke. Must match a tool advertised to the model. */
    name: string;
    /** JSON-encoded argument object as a string. May be malformed — host must validate. */
    arguments: string;
  };
};

/**
 * Cumulative token and cost accounting for a single agent run.
 *
 * Every LLM call performed during a run contributes to a single `Usage`
 * record; numeric fields are summed across calls. The shape mirrors
 * OpenRouter's `ResponseUsage` (see `docs/openrouter/llm.md` §Usage), with
 * the additional invariant that the agent reports the union of every field
 * any provider returned during the run.
 *
 * Optional fields are omitted (rather than zeroed) when no provider in the
 * run reported them.
 *
 * @see {@link Result.usage}
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
  /**
   * Fine-grained breakdown of prompt tokens. Each sub-field is optional and
   * only present when at least one call in the run reported it.
   */
  prompt_tokens_details?: {
    /** Tokens served from the provider's prompt cache. */
    cached_tokens?: number;
    /** Tokens written into the provider's prompt cache on this turn. */
    cache_write_tokens?: number;
    /** Audio-modality input tokens (provider-dependent). */
    audio_tokens?: number;
    /** Video-modality input tokens (provider-dependent). */
    video_tokens?: number;
  };
  /**
   * Fine-grained breakdown of completion tokens. Each sub-field is optional
   * and only present when at least one call in the run reported it.
   */
  completion_tokens_details?: {
    /** Hidden chain-of-thought / reasoning tokens billed as completions. */
    reasoning_tokens?: number;
    /** Audio-modality output tokens (provider-dependent). */
    audio_tokens?: number;
    /** Image-modality output tokens (provider-dependent). */
    image_tokens?: number;
  };
  /**
   * OpenRouter server-side tool usage. Counts tools invoked by OpenRouter's
   * own infrastructure (not host-executed tools).
   */
  server_tool_use?: {
    /** Number of OpenRouter-hosted web search requests issued. */
    web_search_requests?: number;
  };
  /**
   * Cost broken down by upstream pricing component. Provider-dependent.
   * See docs/openrouter/llm.md §Usage.
   */
  cost_details?: {
    /** Total upstream cost in USD before OpenRouter markup. */
    upstream_inference_cost?: number;
    /** Upstream prompt-token cost in USD. */
    upstream_inference_prompt_cost?: number;
    /** Upstream completion-token cost in USD. */
    upstream_inference_completions_cost?: number;
  };
  /**
   * Whether the call was billed to the user's BYOK provider key. Reflects the
   * most recent call in this run.
   */
  is_byok?: boolean;
}

/**
 * The result of an agent run.
 *
 * Returned by `Agent.run()` and surfaced as the payload of the `agent:end`
 * event. Captures the final assistant text, the full message transcript
 * produced during the run, the reason the loop terminated, cumulative
 * {@link Usage}, every OpenRouter generation id observed, and — only for
 * `stopReason === "error"` — a structured error.
 *
 * @see {@link StopReason}
 * @see {@link Usage}
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
  /**
   * Why the loop stopped. `done` is the clean path; the others indicate a
   * truncation, cancellation, provider-imposed limit, content-policy block,
   * or runtime error respectively. See {@link StopReason}.
   */
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
  /**
   * Populated iff `stopReason === "error"`.
   *
   * @property code - Optional HTTP-style status or provider error code.
   * @property message - Human-readable error description.
   * @property metadata - Optional provider-supplied diagnostic blob.
   */
  error?: { code?: number; message: string; metadata?: Record<string, unknown> };
}

/**
 * All valid `Message.role` values, exported for runtime iteration/validation.
 *
 * Declared `as const` so the array literal narrows to a readonly tuple of
 * string literals. Use this when validating untrusted input or building UIs
 * that need to enumerate roles.
 */
export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

/**
 * Union of legal {@link Message} role values, derived from
 * {@link MESSAGE_ROLES}. Equivalent to `"system" | "user" | "assistant" | "tool"`.
 */
export type MessageRole = typeof MESSAGE_ROLES[number];

/**
 * All valid `Result.stopReason` values, exported for runtime iteration/validation.
 *
 * Declared `as const` so the array literal narrows to a readonly tuple of
 * string literals. Order matches the union in {@link Result.stopReason}:
 *
 * - `"done"` — clean termination; the assistant produced a final text reply.
 * - `"max_turns"` — the run hit the configured maximum turn count.
 * - `"aborted"` — the caller cancelled via `AbortSignal` or equivalent.
 * - `"length"` — the provider truncated output due to its own length cap.
 * - `"content_filter"` — the provider refused or filtered the response.
 * - `"error"` — a runtime or transport error occurred; see {@link Result.error}.
 */
export const STOP_REASONS = [
  "done",
  "max_turns",
  "aborted",
  "length",
  "content_filter",
  "error",
] as const;

/**
 * Union of legal {@link Result.stopReason} values, derived from
 * {@link STOP_REASONS}.
 */
export type StopReason = typeof STOP_REASONS[number];
