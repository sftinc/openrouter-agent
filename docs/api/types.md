# Conversation Types (`src/types/`)

The `src/types/` folder holds the wire-shape primitives that the agent loop exchanges with OpenRouter — the `Message` discriminated union, its supporting `ContentPart` and `ToolCall` shapes, the cumulative `Usage` accounting record — together with `Result`, the value returned from `Agent.run()`. These are the same shapes documented in `docs/openrouter/llm.md`; treat that document as the source of truth for the underlying OpenAI-compatible chat completions schema. Public re-exports flow through `src/types/index.ts` and then through the package entrypoint `src/index.ts` so consumers can import them directly from `@sftinc/openrouter-agent`.

Source files:

- `src/types/Message.ts` — every type defined here (`src/types/Message.ts:1`).
- `src/types/index.ts` — folder barrel (`src/types/index.ts:1`).
- `src/index.ts` — package entrypoint, re-exports `Message`, `ContentPart`, `ToolCall`, `Usage`, `Result` (`src/index.ts:305`).

## Imports

The canonical, type-only import for external consumers (humans and agents) is:

```ts
import type {
  Message,
  ContentPart,
  ToolCall,
  Usage,
  Result,
} from "@sftinc/openrouter-agent";
```

All five types above are re-exported from the package root at `src/index.ts:305-311`. Two additional helpers — the runtime arrays `MESSAGE_ROLES` / `STOP_REASONS` and their derived literal-union aliases `MessageRole` / `StopReason` — are exported from `src/types/index.ts` (`src/types/index.ts:24-36`) but are **not** currently re-exported from the package entrypoint. They are documented at the bottom of this page for completeness; if you need them externally, import them via a deep path or open an issue requesting public re-export.

## `Message`

A single chat message exchanged with the LLM. Defined at `src/types/Message.ts:72-116` as a discriminated union over `role`. Each variant mirrors one of the four message kinds accepted by OpenRouter's chat completions endpoint.

Allowed `role` values: `"system" | "user" | "assistant" | "tool"`.

By convention, `system` messages are sourced from `Agent` configuration rather than stored in `Result.messages` — see the codebase note "Sessions do not store system messages".

### Variant: `role: "system"`

`src/types/Message.ts:80`

| Field    | Type     | Required | Default | Description                                                |
| -------- | -------- | -------- | ------- | ---------------------------------------------------------- |
| `role`   | `"system"` | required | —       | Discriminator. Always the string `"system"`.               |
| `content`| `string` | required | —       | The system prompt text. Must be a string (no array form).  |
| `name`   | `string` | optional | —       | Participant name forwarded verbatim to the provider.       |

```ts
const m: Message = { role: "system", content: "You are a helpful assistant." };
```

### Variant: `role: "user"`

`src/types/Message.ts:90`

| Field    | Type                              | Required | Default | Description                                                                                          |
| -------- | --------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `role`   | `"user"`                          | required | —       | Discriminator. Always the string `"user"`.                                                           |
| `content`| `string \| ContentPart[]`         | required | —       | Plain string for text-only input, or an array of `ContentPart` for multimodal (text + image) input.  |
| `name`   | `string`                          | optional | —       | Participant name; useful for multi-user transcripts.                                                 |

```ts
// Plain text user turn
const m1: Message = { role: "user", content: "Hello!" };

// Multimodal user turn
const m2: Message = {
  role: "user",
  content: [
    { type: "text", text: "What's in this picture?" },
    { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "high" } },
  ],
};
```

### Variant: `role: "assistant"`

`src/types/Message.ts:103`

| Field        | Type             | Required | Default | Description                                                                                                                                                  |
| ------------ | ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `role`       | `"assistant"`    | required | —       | Discriminator. Always the string `"assistant"`.                                                                                                              |
| `content`    | `string \| null` | required | —       | Natural-language reply, or `null` when the turn produced only `tool_calls` and no visible text.                                                              |
| `tool_calls` | `ToolCall[]`     | optional | —       | List of tool invocations the model is requesting. When present, the host must respond with one `role: "tool"` message per call before the next assistant turn. |
| `name`       | `string`         | optional | —       | Participant name forwarded to the provider.                                                                                                                  |

```ts
// Plain assistant text turn
const m1: Message = { role: "assistant", content: "Sure — here you go." };

// Assistant turn that requested a tool
const m2: Message = {
  role: "assistant",
  content: null,
  tool_calls: [{
    id: "call_abc",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"SF"}' },
  }],
};
```

### Variant: `role: "tool"`

`src/types/Message.ts:116`

| Field          | Type     | Required | Default | Description                                                                                                                |
| -------------- | -------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `role`         | `"tool"` | required | —       | Discriminator. Always the string `"tool"`.                                                                                 |
| `content`      | `string` | required | —       | Stringified tool output. Conventionally JSON, though any string is permitted by the OpenRouter spec.                       |
| `tool_call_id` | `string` | required | —       | The `id` of the originating `ToolCall`. Must match exactly so the model can correlate the response with its prior request. |
| `name`         | `string` | optional | —       | Tool name; some providers use this to display which tool produced the output.                                              |

```ts
const m: Message = {
  role: "tool",
  tool_call_id: "call_abc",
  content: '{"tempF":68}',
};
```

## `ContentPart`

One element of a multimodal `user` message body. Defined at `src/types/Message.ts:139-156` as a discriminated union over `type`. Used as the array form of `Message.content` for `role: "user"` turns.

Allowed `type` values: `"text" | "image_url"`.

### Variant: `type: "text"`

`src/types/Message.ts:146`

| Field   | Type     | Required | Default | Description                                          |
| ------- | -------- | -------- | ------- | ---------------------------------------------------- |
| `type`  | `"text"` | required | —       | Discriminator. Always the string `"text"`.           |
| `text`  | `string` | required | —       | The text content of this chunk.                      |

```ts
const part: ContentPart = { type: "text", text: "What is in this image?" };
```

### Variant: `type: "image_url"`

`src/types/Message.ts:156`

| Field                | Type        | Required | Default | Description                                                                                                                |
| -------------------- | ----------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `"image_url"` | required | —     | Discriminator. Always the string `"image_url"`.                                                                            |
| `image_url`          | `object`    | required | —       | Image source object (see fields below).                                                                                    |
| `image_url.url`      | `string`    | required | —       | HTTP(S) URL or `data:` URI for the image.                                                                                  |
| `image_url.detail`   | `string`    | optional | —       | Resolution hint — typically `"low"`, `"high"`, or `"auto"` per OpenAI vision conventions. Provider-dependent; ignored when unsupported. |

```ts
const part: ContentPart = {
  type: "image_url",
  image_url: { url: "https://example.com/cat.png", detail: "high" },
};
```

## `ToolCall`

A single tool invocation requested by the assistant. Defined at `src/types/Message.ts:187-199`. Appears inside the `tool_calls` array of an assistant `Message`. The host is expected to execute the named function with the supplied arguments and reply with a `role: "tool"` message whose `tool_call_id` matches `id`.

| Field                  | Type         | Required | Default | Description                                                                                                                                            |
| ---------------------- | ------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                   | `string`     | required | —       | Unique identifier for this call, generated by the model. Echoed back as `tool_call_id` on the corresponding tool message.                              |
| `type`                 | `"function"` | required | —       | Discriminator. Always the literal `"function"` in the current OpenRouter spec; reserved for future tool kinds.                                         |
| `function`             | `object`     | required | —       | Function call payload (see fields below).                                                                                                              |
| `function.name`        | `string`     | required | —       | Name of the function to invoke. Must match a tool the host advertised in its `tools` request parameter.                                                |
| `function.arguments`   | `string`     | required | —       | JSON-encoded string of the function's arguments. The host is responsible for parsing — the model is **not** guaranteed to emit valid JSON. Always validate. |

```ts
const call: ToolCall = {
  id: "call_abc123",
  type: "function",
  function: { name: "search", arguments: '{"q":"bun runtime"}' },
};
```

## `Usage`

Cumulative token and cost accounting for a single agent run. Defined at `src/types/Message.ts:215-275`. The shape mirrors OpenRouter's `ResponseUsage` (see `docs/openrouter/llm.md` §Usage).

**Accumulation semantics.** Every LLM call performed during a run contributes to a single `Usage` record. Numeric fields (including `cost`, every `*_tokens` field, and every nested `*_details` field) are **summed across calls**. Optional fields are **omitted** (rather than zeroed) when no provider in the run reported them. The agent reports the union of every field any provider returned during the run; `is_byok` reflects the most recent call. The merging logic lives in `src/lib/` (internal) and is invoked on each completion before being surfaced as `Result.usage`.

| Field                                              | Type      | Required | Default | Description                                                                                          |
| -------------------------------------------------- | --------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `prompt_tokens`                                    | `number`  | required | —       | Total tokens the provider counted as input across all calls in the run.                              |
| `completion_tokens`                                | `number`  | required | —       | Total tokens the provider counted as output across all calls.                                        |
| `total_tokens`                                     | `number`  | required | —       | `prompt_tokens + completion_tokens`, for convenience.                                                |
| `cost`                                             | `number`  | optional | —       | Provider-reported cost in USD. Summed across calls.                                                  |
| `prompt_tokens_details`                            | `object`  | optional | —       | Fine-grained breakdown of prompt tokens. See sub-fields below.                                       |
| `prompt_tokens_details.cached_tokens`              | `number`  | optional | —       | Tokens served from the provider's prompt cache.                                                      |
| `prompt_tokens_details.cache_write_tokens`         | `number`  | optional | —       | Tokens written into the provider's prompt cache on this turn.                                        |
| `prompt_tokens_details.audio_tokens`               | `number`  | optional | —       | Audio-modality input tokens (provider-dependent).                                                    |
| `prompt_tokens_details.video_tokens`               | `number`  | optional | —       | Video-modality input tokens (provider-dependent).                                                    |
| `completion_tokens_details`                        | `object`  | optional | —       | Fine-grained breakdown of completion tokens. See sub-fields below.                                   |
| `completion_tokens_details.reasoning_tokens`       | `number`  | optional | —       | Hidden chain-of-thought / reasoning tokens billed as completions.                                    |
| `completion_tokens_details.audio_tokens`           | `number`  | optional | —       | Audio-modality output tokens (provider-dependent).                                                   |
| `completion_tokens_details.image_tokens`           | `number`  | optional | —       | Image-modality output tokens (provider-dependent).                                                   |
| `server_tool_use`                                  | `object`  | optional | —       | OpenRouter server-side tool usage — counts tools invoked by OpenRouter's own infrastructure (not host-executed tools). |
| `server_tool_use.web_search_requests`              | `number`  | optional | —       | Number of OpenRouter-hosted web search requests issued.                                              |
| `cost_details`                                     | `object`  | optional | —       | Cost broken down by upstream pricing component. Provider-dependent. See `docs/openrouter/llm.md` §Usage. |
| `cost_details.upstream_inference_cost`             | `number`  | optional | —       | Total upstream cost in USD before OpenRouter markup.                                                 |
| `cost_details.upstream_inference_prompt_cost`      | `number`  | optional | —       | Upstream prompt-token cost in USD.                                                                   |
| `cost_details.upstream_inference_completions_cost` | `number`  | optional | —       | Upstream completion-token cost in USD.                                                               |
| `is_byok`                                          | `boolean` | optional | —       | Whether the call was billed to the user's BYOK provider key. Reflects the **most recent call** in the run. |

```ts
const usage: Usage = {
  prompt_tokens: 1240,
  completion_tokens: 318,
  total_tokens: 1558,
  cost: 0.00342,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 96 },
};
```

## `Result`

The result of an agent run. Defined at `src/types/Message.ts:289-322`. Returned by `Agent.run()` and surfaced as the payload of the `agent:end` event. Captures the final assistant text, the full message transcript produced during the run, the reason the loop terminated, cumulative `Usage`, every OpenRouter generation id observed, and — only for `stopReason === "error"` — a structured error.

| Field             | Type                                                                                  | Required | Default | Description                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`         | `string`                                                                              | required | `""`    | Final assistant text message after all tool calls in the run. Empty string if the run produced no assistant text (e.g. errored before the first turn, or the last turn was all tool calls). |
| `messages`        | `Message[]`                                                                           | required | —       | Full conversation including all tool messages from this run. System messages are not stored here.                                                        |
| `stopReason`      | `"done" \| "max_turns" \| "aborted" \| "length" \| "content_filter" \| "error"`       | required | —       | Why the loop stopped. See the **stopReason values** section below for full semantics.                                                                    |
| `usage`           | `Usage`                                                                               | required | —       | Accumulated usage across every LLM call in the run. See `Usage` above.                                                                                   |
| `generationIds`   | `string[]`                                                                            | required | —       | Every `response.id` OpenRouter returned during the run, in the order observed.                                                                           |
| `error`           | `{ code?: number; message: string; metadata?: Record<string, unknown> }`              | optional | —       | Populated **iff** `stopReason === "error"`. See sub-fields below.                                                                                        |
| `error.code`      | `number`                                                                              | optional | —       | HTTP-style status or provider error code.                                                                                                                |
| `error.message`   | `string`                                                                              | required (when `error` present) | — | Human-readable error description.                                                                                                                |
| `error.metadata`  | `Record<string, unknown>`                                                             | optional | —       | Provider-supplied diagnostic blob (free-form).                                                                                                           |

```ts
const result: Result = {
  content: "The answer is 42.",
  messages: [
    { role: "user", content: "What is the answer?" },
    { role: "assistant", content: "The answer is 42." },
  ],
  stopReason: "done",
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  generationIds: ["gen-abc123"],
};
```

## `stopReason` values

`Result.stopReason` is the discriminator over how the agent loop terminated. Defined as a union literal at `src/types/Message.ts:303-309` and re-exported as the runtime array `STOP_REASONS` and the `StopReason` literal-union alias at `src/types/Message.ts:352-365`.

| Value              | Required `error` field? | When it occurs                                                                                                                              |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `"done"`           | no                      | Clean termination — the assistant produced a final text reply with no further pending tool calls. The success path.                          |
| `"max_turns"`      | no                      | The loop reached the configured maximum turn count (`AgentConfig.maxTurns` or the per-run override) before the model emitted a final reply.  |
| `"aborted"`        | no                      | The caller cancelled the run via the `AbortSignal` passed in `AgentRunOptions.signal` (or an equivalent transport-level abort).              |
| `"length"`         | no                      | The provider truncated output because it hit its own length cap (e.g. `max_tokens` saturated or a context-window ceiling was reached).       |
| `"content_filter"` | no                      | The provider refused or filtered the response under its content policy.                                                                     |
| `"error"`          | **yes**                 | A runtime or transport error occurred (network failure, provider 5xx, malformed response, tool execution failure, etc.). `Result.error` is populated with `{ code?, message, metadata? }`. |

## Folder-internal exports (not on package root)

These are exported from `src/types/index.ts` (`src/types/index.ts:30-36`) but are **not** re-exported from the package root in `src/index.ts`. They are listed here for completeness; external consumers should not rely on importing them from `@sftinc/openrouter-agent` until they are added to the public surface.

### `MESSAGE_ROLES`

Runtime tuple of valid `Message.role` values, declared `as const`. `src/types/Message.ts:331`.

```ts
const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
```

Use when validating untrusted input or building UIs that need to enumerate roles.

### `MessageRole`

Literal-union type derived from `MESSAGE_ROLES`. `src/types/Message.ts:337`. Equivalent to `"system" | "user" | "assistant" | "tool"`.

### `STOP_REASONS`

Runtime tuple of valid `Result.stopReason` values, declared `as const`. `src/types/Message.ts:352-359`. Order matches the union in `Result.stopReason`.

```ts
const STOP_REASONS = [
  "done",
  "max_turns",
  "aborted",
  "length",
  "content_filter",
  "error",
] as const;
```

### `StopReason`

Literal-union type derived from `STOP_REASONS`. `src/types/Message.ts:365`. Equivalent to `"done" | "max_turns" | "aborted" | "length" | "content_filter" | "error"`.
