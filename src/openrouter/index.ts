/**
 * @file Public surface of the `openrouter/` module.
 *
 * Consumers should import from this folder (`./openrouter`), not from the
 * individual files inside it, per the project convention in `CLAUDE.md`.
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

export { OpenRouterClient, OpenRouterError } from "./client.js";
export type {
	OpenRouterClientOptions,
	EmbedRequest,
	EmbedResponse,
	EmbeddingsDefaults,
	RequestOptions,
} from "./client.js";

export type {
	TranscriptionRequest,
	TranscriptionResponse,
	TranscriptionsDefaults,
	TranscriptionProviderOptions,
} from "./audio/transcriptions.types.js";

export { setOpenRouterClient, getOpenRouterClient } from "./default.js";
export { parseSseStream } from "./sse.js";
export { StreamTruncatedError, IdleTimeoutError } from "./errors.js";
export { defaultIsRetryable, RetryableProviderError } from "./retry.js";
export type { RetryConfig } from "./retry.js";
