/**
 * @file Public surface of the `openrouter/` module.
 *
 * Re-exports the {@link OpenRouterClient}, the typed {@link OpenRouterError},
 * the project-level singleton helpers ({@link setOpenRouterClient},
 * {@link getOpenRouterClient}), the SSE parser ({@link parseSseStream}), and
 * every type used to describe a chat-completions request/response.
 *
 * Consumers should import from this folder (`./openrouter`), not from the
 * individual files inside it, per the project convention in
 * `CLAUDE.md`.
 */

/**
 * Type-only re-exports of the OpenRouter request/response schema. See
 * `./types.ts` for definitions and `docs/openrouter/llm.md` for the
 * source-of-truth API spec they mirror.
 */
export type {
  LLMConfig,
  OpenRouterTool,
  FunctionTool,
  DatetimeServerTool,
  WebSearchServerTool,
  CompletionsRequest,
  CompletionsResponse,
  NonStreamingChoice,
  StreamingChoice,
  CompletionChunk,
  ToolCallDelta,
  ErrorResponse,
  Annotation,
  UrlCitationAnnotation,
} from "./types.js";

/** Default model slug used when no `model` is supplied at any config layer. */
export { DEFAULT_MODEL } from "./types.js";

/** HTTP client and its typed error class. See `./client.ts`. */
export { OpenRouterClient, OpenRouterError } from "./client.js";

/** Constructor options for {@link OpenRouterClient}. */
export type { OpenRouterClientOptions } from "./client.js";

/**
 * Project-singleton helpers for sharing one {@link OpenRouterClient} across
 * every {@link Agent}. See `./default.ts`.
 */
export { setOpenRouterClient, getOpenRouterClient } from "./default.js";

/**
 * Low-level SSE parser used by {@link OpenRouterClient.completeStream}.
 * Exported for callers that want to consume an OpenRouter SSE stream
 * directly without going through the client.
 */
export { parseSseStream } from "./sse.js";

/**
 * Stream-level error classes raised from the SSE consumer when the upstream
 * response is dropped or wedged. See `./errors.ts`.
 */
export { StreamTruncatedError, IdleTimeoutError } from "./errors.js";

/**
 * Retry surface — see `./retry.ts`. {@link RetryConfig} is the public knobs
 * shape; {@link defaultIsRetryable} is the default predicate (overridable
 * per-Agent or per-run); {@link RetryableProviderError} is exported for
 * callers that want to recognize the synthetic error the loop raises for
 * mid-stream provider failures.
 */
export {
  defaultIsRetryable,
  DEFAULT_RETRY_CONFIG,
  RetryableProviderError,
} from "./retry.js";

export type { RetryConfig } from "./retry.js";
