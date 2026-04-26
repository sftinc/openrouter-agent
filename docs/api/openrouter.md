# OpenRouter Client (`src/openrouter/`)

This folder owns the package's transport layer: a thin, typed HTTP client for OpenRouter's `/chat/completions` endpoint, the wire-shape types that mirror OpenRouter's request/response schema, a project-singleton registry so every `Agent` shares one client, and a small SSE parser used by streaming completions. Higher-level concerns (the agent loop, tool execution, sessions) live elsewhere; this folder is intentionally minimal — no retries, no queueing, no rate limiting. See `src/openrouter/client.ts:14-17` for the design statement.

The folder's own re-export surface lives in `src/openrouter/index.ts`. The package root (`src/index.ts`) re-exports a curated subset of these for external consumers; symbols that are folder-exported but not package-exported are listed under "Internal helpers" at the bottom.

## Imports

The canonical import line for external consumers is:

```ts
import {
  setOpenRouterClient,
  OpenRouterClient,
  OpenRouterError,
  DEFAULT_MODEL,
  // type-only imports
  type LLMConfig,
  type OpenRouterClientOptions,
  type OpenRouterTool,
  type CompletionsRequest,
  type CompletionsResponse,
} from "@sftinc/openrouter-agent";
```

All examples below assume that import path. Internal callers inside this repo import from the folder index (`./openrouter`), per the project convention in `CLAUDE.md`.

---

## `setOpenRouterClient`

Register the project-wide `OpenRouterClient`. Call once at app startup, before constructing any `Agent`.

### Signature

```ts
function setOpenRouterClient(
  clientOrOptions: OpenRouterClient | OpenRouterClientOptions
): OpenRouterClient;
```

Source: `src/openrouter/default.ts:49-57`.

### Parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `clientOrOptions` | `OpenRouterClient \| OpenRouterClientOptions` | yes | — | Either a pre-built client (used as-is) or an options object that will be passed to `new OpenRouterClient(...)`. The branch is chosen via `instanceof OpenRouterClient`. |

### Return value

The resulting `OpenRouterClient` (the same instance you passed in, or the freshly constructed one). Stored in module scope and shared across the process.

### Errors

- Throws `Error("OPENROUTER_API_KEY is not set...")` indirectly when constructing from options without an `apiKey` and without `process.env.OPENROUTER_API_KEY` (see `src/openrouter/client.ts:172-174`).

### Behavior notes

- Calling this multiple times overwrites the previously registered client. `Agent` instances that have already cached a client are unaffected — only future `getOpenRouterClient()` calls see the new value (`src/openrouter/default.ts:31-34`).
- This intentionally couples the process to one client; multi-tenant servers should not use this helper and should construct `OpenRouterClient` instances themselves (`src/openrouter/default.ts:20-22`).

### Example

```ts
import { setOpenRouterClient } from "@sftinc/openrouter-agent";

setOpenRouterClient({
  apiKey: process.env.OPENROUTER_API_KEY, // optional, falls back to env
  model: "anthropic/claude-haiku-4.5",
  max_tokens: 2000,
  temperature: 0.3,
  title: "my-app",
});
```

See also: `OpenRouterClient`, `OpenRouterClientOptions`, `Agent`.

---

## `OpenRouterClient`

Thin HTTP client for OpenRouter's `/chat/completions` endpoint. Holds the API key, optional attribution headers, and per-client `LLMConfig` defaults.

### Signature

```ts
class OpenRouterClient {
  constructor(options: OpenRouterClientOptions);

  get llmDefaults(): LLMConfig;

  complete(
    request: CompletionsRequest,
    signal?: AbortSignal
  ): Promise<CompletionsResponse>;

  completeStream(
    request: CompletionsRequest,
    signal?: AbortSignal
  ): AsyncGenerator<CompletionChunk, void, void>;
}
```

Source: `src/openrouter/client.ts:145-394`.

### Constructor parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `options` | `OpenRouterClientOptions` | yes | — | API key, transport headers, and any `LLMConfig` defaults. See the `OpenRouterClientOptions` section below for field-by-field docs. |

The constructor splits `options` into `{ apiKey, title, referer }` (transport-level) and the remaining `LLMConfig` fields (stored as request-body defaults). If `apiKey` is absent it falls back to `process.env.OPENROUTER_API_KEY`; if neither is set it throws (`src/openrouter/client.ts:168-175`).

### Errors

- `Error("OPENROUTER_API_KEY is not set. Pass apiKey to the OpenRouterClient or set the env var.")` — thrown by the constructor when no key is available.
- `OpenRouterError` — thrown by `complete` and `completeStream` on any non-2xx HTTP response, or when a streaming response has no body.

### Properties

#### `llmDefaults` (getter)

Returns a fresh shallow copy of the per-client `LLMConfig` defaults. Mutating the returned object does not affect the client (`src/openrouter/client.ts:188-190`). The agent loop reads this to know what fields the client will already supply.

```ts
const client = new OpenRouterClient({ model: "x-ai/grok-4", temperature: 0.5 });
console.log(client.llmDefaults); // { model: "x-ai/grok-4", temperature: 0.5 }
```

### Method: `complete`

POSTs a non-streaming chat completion and resolves to a parsed `CompletionsResponse`.

#### Parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `request` | `CompletionsRequest` | yes | — | The completion request body. `messages` is required; everything else may be omitted to inherit defaults. |
| `signal` | `AbortSignal` | no | `undefined` | Cancels the underlying `fetch`; rejection surfaces as the standard `fetch` `AbortError`. |

#### Body precedence (lowest → highest)

1. `DEFAULT_MODEL` as the model fallback (`src/openrouter/client.ts:336-341`);
2. this client's `LLMConfig` defaults;
3. fields on `request`;
4. `stream: false` (always forced).

#### Returns

`Promise<CompletionsResponse>`.

#### Throws

`OpenRouterError` on any non-2xx response. Common codes:

- `401` — missing or invalid API key.
- `402` — out of credits.
- `429` — rate limited (check `metadata` for retry hints).
- `503` — upstream provider unavailable.

#### Side effects

- Logs the parsed response to stdout when `process.env.OPENROUTER_DEBUG` is set (yellow if it contains tool calls; `src/openrouter/client.ts:367-374`).
- Logs error responses to stderr (`src/openrouter/client.ts:352-353`).

#### Example

```ts
import { OpenRouterClient } from "@sftinc/openrouter-agent";

const client = new OpenRouterClient({
  model: "anthropic/claude-haiku-4.5",
  temperature: 0.2,
});

const res = await client.complete({
  messages: [{ role: "user", content: "Say hi." }],
});
console.log(res.choices[0]?.message.content);
```

### Method: `completeStream`

POSTs a streaming chat completion and yields parsed SSE `CompletionChunk` values as they arrive. The final chunk before the `[DONE]` sentinel typically carries `usage` with an empty `choices` array.

#### Parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `request` | `CompletionsRequest` | yes | — | The completion request body. `messages` is required. |
| `signal` | `AbortSignal` | no | `undefined` | Aborting cancels both the underlying `fetch` and the SSE reader; the generator throws an `AbortError`. |

#### Body precedence (lowest → highest)

1. `DEFAULT_MODEL` as the model fallback;
2. this client's `LLMConfig` defaults;
3. fields on `request`;
4. `stream: true` (always forced; `src/openrouter/client.ts:238-243`).

#### Returns

`AsyncGenerator<CompletionChunk, void, void>`. The generator returns when `[DONE]` is seen or the body closes. On early abandonment (e.g. `break` in the consumer), `response.body.cancel()` is invoked in a `finally` block to release network resources (`src/openrouter/client.ts:290-299`).

#### Throws

- `OpenRouterError` on non-2xx responses (thrown before any chunks are yielded).
- `OpenRouterError` with a `"streaming response had no body"` message when the response is OK but `response.body` is `null` (`src/openrouter/client.ts:266-271`).
- Re-throws any error from the SSE parser (e.g. malformed JSON in a `data:` frame).

#### Side effects

- When `process.env.OPENROUTER_DEBUG` is set, every chunk is captured and reassembled via the internal `assembleCompletionsResponse` helper, then logged after the stream completes (`src/openrouter/client.ts:273-289`).

#### Example

```ts
import { OpenRouterClient } from "@sftinc/openrouter-agent";

const client = new OpenRouterClient({ model: "anthropic/claude-haiku-4.5" });

for await (const chunk of client.completeStream({
  messages: [{ role: "user", content: "Stream this." }],
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

See also: `OpenRouterError`, `CompletionsRequest`, `CompletionsResponse`, `CompletionChunk`, `parseSseStream`.

---

## `OpenRouterError`

Typed error thrown by the client on any non-2xx response. Extends `Error`.

### Signature

```ts
class OpenRouterError extends Error {
  readonly name: "OpenRouterError";
  readonly code: number;
  readonly body?: unknown;
  readonly metadata?: Record<string, unknown>;

  constructor(params: {
    code: number;
    message: string;
    body?: unknown;
    metadata?: Record<string, unknown>;
  });
}
```

Source: `src/openrouter/client.ts:55-77`.

### Constructor parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `params.code` | `number` | yes | — | HTTP status code that triggered the error. |
| `params.message` | `string` | yes | — | Human-readable message; becomes `Error.message`. The client prefers `body.error.message` from the response when available, falling back to `"HTTP {status}"` (`src/openrouter/client.ts:254-256`). |
| `params.body` | `unknown` | no | `undefined` | Parsed JSON body of the error response, or `undefined` if the body was not JSON. |
| `params.metadata` | `Record<string, unknown>` | no | `undefined` | Provider-specific extra detail, extracted from `body.error.metadata`. |

### Common codes

| Code | Meaning |
| --- | --- |
| `401` | Missing or invalid API key. |
| `402` | Out of credits. |
| `429` | Rate limited; inspect `metadata` for retry hints. |
| `503` | Upstream provider unavailable. |

### Example

```ts
import { OpenRouterError } from "@sftinc/openrouter-agent";

try {
  await client.complete({ messages });
} catch (err) {
  if (err instanceof OpenRouterError) {
    if (err.code === 429) console.warn("rate limited", err.metadata);
    else throw err;
  }
}
```

See also: `OpenRouterClient`, `ErrorResponse`.

---

## `DEFAULT_MODEL`

The hardcoded fallback model slug used when no `model` is supplied at any layer of the config-merge chain (request > client defaults > this constant).

### Signature

```ts
const DEFAULT_MODEL: "anthropic/claude-haiku-4.5";
```

Source: `src/openrouter/types.ts:441`.

### Example

```ts
import { DEFAULT_MODEL, OpenRouterClient } from "@sftinc/openrouter-agent";

console.log(DEFAULT_MODEL); // "anthropic/claude-haiku-4.5"

// Build a client that explicitly opts into the fallback:
const client = new OpenRouterClient({ model: DEFAULT_MODEL });
```

See also: `LLMConfig.model`, `OpenRouterClient`.

---

## `OpenRouterClientOptions`

Constructor argument for `OpenRouterClient`. Extends `LLMConfig` (so every LLM knob is also a client default), plus three transport-level fields. Source: `src/openrouter/client.ts:99-116`.

### Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | `string` | no | `process.env.OPENROUTER_API_KEY` | OpenRouter API key. The constructor throws if neither this nor the env var is set. |
| `title` | `string` | no | `undefined` | Human-readable site/app name, sent as the `X-OpenRouter-Title` header for OpenRouter rankings/attribution. |
| `referer` | `string` | no | `undefined` | Referer URL, sent as the `HTTP-Referer` header for OpenRouter rankings/attribution. |
| …all `LLMConfig` fields | see `LLMConfig` | no | — | Used as per-client defaults on every request body. Stripped of `apiKey`/`title`/`referer` before being merged. |

### Example

```ts
const options: OpenRouterClientOptions = {
  apiKey: process.env.OPENROUTER_API_KEY,
  title: "my-app",
  referer: "https://example.com",
  model: "anthropic/claude-haiku-4.5",
  max_tokens: 2000,
  temperature: 0.3,
  reasoning: { effort: "low" },
};
```

See also: `LLMConfig`, `OpenRouterClient`, `setOpenRouterClient`.

---

## `LLMConfig`

The canonical "knobs" shape — every wire-body field except `messages` and `tools`. Used as the override unit at three layers: client defaults, agent defaults, and per-call overrides (later layers win). Source: `src/openrouter/types.ts:29-172`.

### Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | `string` | no | `DEFAULT_MODEL` (i.e. `"anthropic/claude-haiku-4.5"`) | Model slug. Falls back through every layer to `DEFAULT_MODEL`. |
| `max_tokens` | `number` | no | provider default | Hard cap on completion tokens. Range `[1, context_length)`. |
| `temperature` | `number` | no | provider default (typically `1.0`) | Sampling temperature, range `[0, 2]`. Higher = more random. |
| `top_p` | `number` | no | provider default (typically `1.0`) | Nucleus sampling cutoff, range `(0, 1]`. |
| `top_k` | `number` | no | provider default | Top-k cutoff. Silently ignored on OpenAI models. |
| `min_p` | `number` | no | provider default | Minimum token-probability cutoff. Not supported on OpenAI models. |
| `top_a` | `number` | no | provider default | Alternative top-k/top-p hybrid. Not supported on OpenAI models. |
| `frequency_penalty` | `number` | no | `0` | Per-token-frequency penalty, range `[-2, 2]`. Positive discourages repetition. |
| `presence_penalty` | `number` | no | `0` | Per-token-presence penalty, range `[-2, 2]`. Positive discourages already-seen tokens. |
| `repetition_penalty` | `number` | no | `1.0` | Multiplicative repetition penalty, range `(0, 2]`. Above `1.0` discourages repetition. |
| `seed` | `number` | no | none | RNG seed for deterministic sampling. Provider support is best-effort. |
| `stop` | `string \| string[]` | no | none | Stop string(s). The first match terminates the response and is excluded from output. |
| `logit_bias` | `Record<number, number>` | no | none | Per-token-id bias map; values in `[-100, 100]` added to logits pre-softmax. |
| `top_logprobs` | `number` | no | none | If set, return top-N alternative tokens per position. Max `20`. |
| `response_format` | `{ type: "json_object" } \| { type: "json_schema"; json_schema: { name: string; strict?: boolean; schema: object } }` | no | none | Force structured output. `json_object` is loose; `json_schema` validates against a JSON Schema with optional `strict` mode. |
| `tool_choice` | `"none" \| "auto" \| { type: "function"; function: { name: string } }` | no | `"auto"` when tools are present | How the model picks a tool. `"none"` disables tool-calling for this turn; the object form forces a specific function. |
| `prediction` | `{ type: "content"; content: string }` | no | none | Expected response prefix (predicted outputs) for latency optimization. Ignored where unsupported. |
| `reasoning` | `{ effort?: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"; max_tokens?: number; enabled?: boolean }` | no | enabled on capable models | Reasoning controls. `effort` token-allocation ratios are roughly 0.1 / 0.2 / 0.5 / 0.8 / 0.95 for `minimal` → `xhigh`; `xhigh` is only honored by the newest reasoning models (e.g. Claude 4.7 Opus+), and unsupported levels are mapped to the nearest supported one by OpenRouter. `enabled: false` disables reasoning entirely. |
| `user` | `string` | no | none | Stable end-user identifier for OpenRouter attribution and abuse monitoring. |
| `models` | `string[]` | no | none | Fallback models tried in order if `model` is unavailable. Set `route: "fallback"` to opt in. |
| `route` | `"fallback"` | no | none | Routing strategy. `"fallback"` opts into automatic fallback through `models`. |
| `provider` | `Record<string, unknown>` | no | none | Provider-routing constraints. Common keys: `allow_fallbacks`, `require_parameters`, `data_collection`, `order`. Pass-through so future keys do not require a type bump. |
| `plugins` | `Array<{ id: string; [key: string]: unknown }>` | no | none | Plugin pipeline. Each entry has a required `id` (e.g. `"web"`, `"file-parser"`, `"response-healing"`, `"context-compression"`) plus plugin-specific fields. |
| `debug` | `{ echo_upstream_body?: boolean }` | no | none | Debug flags. `echo_upstream_body: true` makes OpenRouter echo back the transformed upstream request body for inspection. |

### Example

```ts
const cfg: LLMConfig = {
  model: "anthropic/claude-sonnet-4.5",
  max_tokens: 4000,
  temperature: 0.2,
  reasoning: { effort: "medium" },
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "Person",
      strict: true,
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name", "age"],
        additionalProperties: false,
      },
    },
  },
};
```

See also: `CompletionsRequest`, `OpenRouterClientOptions`, `DEFAULT_MODEL`.

---

## `OpenRouterTool`

Discriminated union of tool declarations sent to the model. Source: `src/openrouter/types.ts:250`.

```ts
type OpenRouterTool = FunctionTool | DatetimeServerTool | WebSearchServerTool;
```

The three variants below describe the shape the model receives. Application code that uses the high-level `Tool` class never builds these by hand — the `Agent` advertises tools by serializing each registered `Tool` into a `FunctionTool`. Build these manually only for OpenRouter-hosted server tools or when bypassing the `Agent`.

### Variant: `FunctionTool` (client-side function tool)

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `type` | `"function"` | yes | — | Discriminator. |
| `function.name` | `string` | yes | — | Name the model uses to invoke this tool. Must be unique within a request and match `[A-Za-z0-9_]+`. |
| `function.description` | `string` | yes | — | Natural-language description shown to the model. |
| `function.parameters` | `object` | yes | — | JSON Schema (subset) describing arguments. The model emits `arguments` as a JSON string conforming to this schema. |

### Variant: `DatetimeServerTool` (server-side, OpenRouter-hosted)

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `type` | `"openrouter:datetime"` | yes | — | Discriminator. OpenRouter supplies the current datetime; your code does not implement it. |

### Variant: `WebSearchServerTool` (server-side, OpenRouter-hosted)

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `type` | `"openrouter:web_search"` | yes | — | Discriminator. |
| `parameters.search_context_size` | `"low" \| "medium" \| "high"` | no | provider default | Hint for context length per result. `low` = short snippets, `high` = longer extracts. |
| `parameters.user_location.type` | `"approximate"` | yes if `user_location` set | — | Discriminator for the location envelope. |
| `parameters.user_location.approximate.country` | `string` | no | — | ISO 3166-1 alpha-2 country code. |
| `parameters.user_location.approximate.city` | `string` | no | — | Free-form city name. |
| `parameters.user_location.approximate.region` | `string` | no | — | Free-form region/state name. |
| `parameters.user_location.approximate.timezone` | `string` | no | — | IANA timezone (e.g. `"America/Los_Angeles"`). |

### Example

```ts
const tools: OpenRouterTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Look up current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
  { type: "openrouter:datetime" },
  {
    type: "openrouter:web_search",
    parameters: {
      search_context_size: "medium",
      user_location: {
        type: "approximate",
        approximate: { country: "US", city: "Brooklyn" },
      },
    },
  },
];
```

See also: `Tool` (the high-level wrapper), `CompletionsRequest`, `Annotation`.

---

## `CompletionsRequest`

Body POSTed to `/chat/completions`. Extends `LLMConfig` with the two fields the agent loop owns: `messages` (the conversation) and `tools` (the registry). Source: `src/openrouter/types.ts:351-363`.

### Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `messages` | `Message[]` | yes | — | Full conversation history including the current turn. |
| `tools` | `OpenRouterTool[]` | no | none | Tools available to the model on this turn. |
| `stream` | `boolean` | no | client-method-controlled | Whether to stream via SSE. `OpenRouterClient.complete` hardcodes `false`; `OpenRouterClient.completeStream` hardcodes `true`. Callers normally leave this unset. |
| …all `LLMConfig` fields | see `LLMConfig` | no | — | Per-call overrides for any LLM knob. |

### Example

```ts
const req: CompletionsRequest = {
  model: "anthropic/claude-haiku-4.5",
  messages: [
    { role: "system", content: "You are concise." },
    { role: "user", content: "What is 2+2?" },
  ],
  temperature: 0,
};
```

See also: `LLMConfig`, `Message`, `OpenRouterTool`, `OpenRouterClient.complete`.

---

## `CompletionsResponse`

Full non-streaming response from `/chat/completions`. Returned by `OpenRouterClient.complete`. Source: `src/openrouter/types.ts:329-344`.

### Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | `string` | yes | — | Server-assigned generation id. Use to look up the generation in OpenRouter logs. |
| `choices` | `NonStreamingChoice[]` | yes | — | One entry per `n` (default `n=1`). |
| `created` | `number` | yes | — | Unix epoch (seconds) when the response was created. |
| `model` | `string` | yes | — | The model that actually served the request (may differ from the requested slug after fallback). |
| `object` | `"chat.completion"` | yes | — | Object discriminator. |
| `system_fingerprint` | `string` | no | — | Provider fingerprint (OpenAI-style). Absent on most non-OpenAI models. |
| `usage` | `Usage` | no | — | Token usage and (optionally) cost. Populated when the provider reports it. |

### `NonStreamingChoice`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `finish_reason` | `string \| null` | yes | — | Normalized finish reason (`"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`, `"error"`, …). |
| `native_finish_reason` | `string \| null` | yes | — | Provider-specific raw finish reason (unmapped). Useful for debugging. |
| `message.content` | `string \| null` | yes | — | Free-form text. May be `null` if the turn produced only tool calls. |
| `message.role` | `string` | yes | — | Producer role — typically `"assistant"`. |
| `message.tool_calls` | `ToolCall[]` | no | — | Tool calls the model emitted, if any. |
| `message.annotations` | `Annotation[]` | no | — | Annotations such as URL citations from server tools. |
| `error` | `ErrorResponse` | no | — | Populated when `finish_reason === "error"`. |

### Example

```ts
const res: CompletionsResponse = await client.complete({ messages });
const text = res.choices[0]?.message.content ?? "";
const usage = res.usage; // { prompt_tokens, completion_tokens, total_tokens, ... }
```

See also: `CompletionsRequest`, `NonStreamingChoice`, `Annotation`, `Usage`.

---

## `NonStreamingChoice`

A single completion choice from `CompletionsResponse.choices`. Field-by-field documented in the table above under `CompletionsResponse`. Source: `src/openrouter/types.ts:287-310`.

---

## `StreamingChoice`

A single completion choice within an SSE chunk. Source: `src/openrouter/types.ts:395-414`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `finish_reason` | `string \| null` | yes | — | Normalized finish reason. `null` while content is still streaming; non-null on the final delta for this choice. |
| `native_finish_reason` | `string \| null` | yes | — | Provider-specific raw finish reason (unmapped). |
| `delta.content` | `string \| null` | yes | — | Text fragment to append, or `null` for non-text deltas. |
| `delta.role` | `string` | no | — | Role declaration — typically only present on the very first delta. |
| `delta.tool_calls` | `ToolCallDelta[]` | no | — | Tool-call fragments. |
| `error` | `ErrorResponse` | no | — | Populated when this choice errored mid-stream. |

Note: OpenRouter SSE choices in the wire payload also carry an `index` field which the type does not declare; the internal stream-assembler accounts for this via a position fallback (`src/openrouter/client.ts:443-450`).

---

## `CompletionChunk`

A single SSE chunk parsed from `/chat/completions` when `stream: true`. The final chunk before `[DONE]` carries `usage` with an empty `choices` array; all other chunks carry one or more `StreamingChoice`. Source: `src/openrouter/types.ts:421-434`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | `string` | yes | — | Server-assigned generation id (same value across all chunks of a stream). |
| `object` | `"chat.completion.chunk"` | yes | — | Object discriminator. |
| `created` | `number` | yes | — | Unix epoch (seconds) for the start of the response. |
| `model` | `string` | yes | — | The model actually serving the response. |
| `choices` | `StreamingChoice[]` | yes | — | Streaming choices in this chunk. Empty on the final usage-only chunk. |
| `usage` | `Usage` | no | — | Token usage. Typically present only on the final chunk. |

---

## `ToolCallDelta`

Incremental tool-call piece from a streaming response. `index` identifies which parallel tool call this fragment applies to. Source: `src/openrouter/types.ts:372-389`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `index` | `number` | yes | — | Stable index identifying which parallel tool call this delta belongs to. Concatenate fragments sharing the same `index`. |
| `id` | `string` | no | — | Tool-call id. Usually only present on the first delta for a given `index`. |
| `type` | `"function"` | no | — | Discriminator. Usually only present on the first delta. |
| `function.name` | `string` | no | — | Function name. Usually only present on the first delta. |
| `function.arguments` | `string` | no | — | JSON-string fragment of arguments to be concatenated across deltas. |

### Example

```ts
const acc = new Map<number, { id?: string; name?: string; args: string }>();
for await (const chunk of client.completeStream({ messages, tools })) {
  for (const sc of chunk.choices) {
    for (const td of sc.delta.tool_calls ?? []) {
      const cur = acc.get(td.index) ?? { args: "" };
      if (td.id) cur.id = td.id;
      if (td.function?.name) cur.name = td.function.name;
      if (td.function?.arguments) cur.args += td.function.arguments;
      acc.set(td.index, cur);
    }
  }
}
```

---

## `ErrorResponse`

Error payload returned by OpenRouter inside a choice or as the body of a non-2xx response. Source: `src/openrouter/types.ts:316-323`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `code` | `number` | yes | — | HTTP-style status code (mirrors the response status). |
| `message` | `string` | yes | — | Human-readable error message. |
| `metadata` | `Record<string, unknown>` | no | — | Provider-specific extra detail (rate-limit info, moderation flags, …). |

See also: `OpenRouterError` (the thrown form).

---

## `Annotation`

Open union of message-level annotations. Currently only `UrlCitationAnnotation` is defined. Source: `src/openrouter/types.ts:280`.

```ts
type Annotation = UrlCitationAnnotation;
```

---

## `UrlCitationAnnotation`

URL citation attached to an assistant message — populated by OpenRouter when a server tool (e.g. `WebSearchServerTool`) returns sources. Source: `src/openrouter/types.ts:258-274`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `type` | `"url_citation"` | yes | — | Discriminator. |
| `url_citation.url` | `string` | yes | — | Absolute URL of the cited source. |
| `url_citation.title` | `string` | yes | — | Human-readable page title as discovered by the search backend. |
| `url_citation.content` | `string` | no | — | Optional snippet/extract from the source. |
| `url_citation.start_index` | `number` | no | — | Inclusive start index of the citation span within the assistant content. |
| `url_citation.end_index` | `number` | no | — | Exclusive end index of the citation span within the assistant content. |

### Example

```ts
const choice = res.choices[0]!;
for (const ann of choice.message.annotations ?? []) {
  if (ann.type === "url_citation") {
    console.log(ann.url_citation.title, "→", ann.url_citation.url);
  }
}
```

---

## `FunctionTool`, `DatetimeServerTool`, `WebSearchServerTool`

The three variants of `OpenRouterTool`. These are folder-level exports (re-exported from `src/openrouter/index.ts`) but **not** re-exported from the package root — external consumers should reference `OpenRouterTool` and discriminate on `type`. See the variant tables under `OpenRouterTool` above for every field.

---

## Internal helpers

The following symbols live in `src/openrouter/` but are **not** re-exported from the package root (`@sftinc/openrouter-agent`). They are part of the folder's surface for internal use and may change without a major version bump.

| Symbol | Where | Status | Notes |
| --- | --- | --- | --- |
| `getOpenRouterClient` | `src/openrouter/default.ts:68-70` | Folder-exported, **not** package-exported | Internal accessor used by the `Agent` constructor to read the project-singleton client (returns `undefined` if none registered). External consumers should not rely on it. |
| `parseSseStream` | `src/openrouter/sse.ts:47-93` | Folder-exported, **not** package-exported | Low-level SSE parser used by `OpenRouterClient.completeStream`. Yields the JSON-parsed payload of each non-empty `data:` frame; terminates on the `[DONE]` sentinel. Exported from the folder so callers that want to consume an OpenRouter SSE stream directly can do so without going through the client. |
| `FunctionTool` / `DatetimeServerTool` / `WebSearchServerTool` (types) | `src/openrouter/types.ts` | Folder-exported, **not** package-exported | The three variants of `OpenRouterTool`. Use `OpenRouterTool` from the package root and discriminate on `type`. |
| `NonStreamingChoice` / `StreamingChoice` / `CompletionChunk` / `ToolCallDelta` / `ErrorResponse` / `Annotation` / `UrlCitationAnnotation` | `src/openrouter/types.ts` | Folder-exported, **not** package-exported | Wire-shape detail types. Useful when consuming raw `OpenRouterClient` responses or building an SSE consumer; not needed for the high-level `Agent` API. |
| `assembleCompletionsResponse` | `src/openrouter/client.ts:417-509` | **Not exported** | Folds streaming chunks into a single `CompletionsResponse` for `OPENROUTER_DEBUG` logging only; not on any export path. |
| `BASE_URL` | `src/openrouter/client.ts:122` | **Not exported** | Module-private constant `"https://openrouter.ai/api/v1"`. |
| `projectClient` | `src/openrouter/default.ts:23` | **Not exported** | Module-scope singleton holder. Mutated by `setOpenRouterClient`, read by `getOpenRouterClient`. |
| `findFrameSeparator` / `extractData` | `src/openrouter/sse.ts:107-142` | **Not exported** | Helpers used by `parseSseStream`. |

> **Note on type re-exports:** several wire-shape types (`NonStreamingChoice`, `StreamingChoice`, `CompletionChunk`, `ToolCallDelta`, `ErrorResponse`, `Annotation`, `UrlCitationAnnotation`, `FunctionTool`, `DatetimeServerTool`, `WebSearchServerTool`) are exported from `src/openrouter/index.ts` but **not** from `src/index.ts`. If you need them in application code, the recommended path is to discriminate on the public union types (`OpenRouterTool`, `Annotation`) or — at your own risk — deep-import from the package's internal path. A future minor version may promote some of these to the public root.
