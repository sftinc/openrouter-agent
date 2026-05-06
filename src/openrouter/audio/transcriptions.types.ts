/**
 * @file Request, response, and defaults types for OpenRouter's
 * `/audio/transcriptions` endpoint. See
 * https://openrouter.ai/docs/api/api-reference/transcriptions/create-audio-transcriptions.
 *
 * The actual HTTP client class lives in `./transcriptions.ts`; this file is
 * type-only so that callers and other modules can import the shapes without
 * pulling in the runtime class.
 */

/**
 * Provider-specific options forwarded to OpenRouter's transcription
 * endpoint. Keyed by provider slug; only the matched provider's options are
 * forwarded upstream.
 *
 * @example
 * ```ts
 * import type { TranscriptionProviderOptions } from "./openrouter";
 *
 * const provider: TranscriptionProviderOptions = {
 *   options: {
 *     groq: { prompt: "Expected vocabulary: OpenRouter, API" },
 *   },
 * };
 * ```
 */
export interface TranscriptionProviderOptions {
  /** Per-provider options bag. Inner record is provider-specific. */
  options?: Record<string, Record<string, unknown>>;
}

/**
 * Body of a request to {@link TranscriptionsNamespace.create}. Mirrors
 * OpenRouter's `/audio/transcriptions` schema. `input_audio.data` is
 * base64-encoded raw bytes — **not** a data URI. The client does not
 * transform or validate it.
 *
 * @example
 * ```ts
 * import { OpenRouterClient } from "./openrouter";
 * const client = new OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY });
 * const audio = await fs.promises.readFile("voice.wav");
 * const res = await client.audio.transcriptions.create({
 *   input_audio: { data: audio.toString("base64"), format: "wav" },
 *   language: "en",
 * });
 * console.log(res.text);
 * ```
 */
export interface TranscriptionRequest {
  /**
   * Transcription model slug (e.g. `"openai/gpt-4o-mini-transcribe"`).
   * Falls back to {@link TranscriptionsDefaults.model}, then to the
   * package-level default `"openai/gpt-4o-mini-transcribe"`.
   */
  model?: string;
  /** Audio payload to transcribe. Both fields required. */
  input_audio: {
    /** Base64-encoded raw audio bytes (NOT a data URI). */
    data: string;
    /** Audio container format. Provider support varies; see docs. */
    format: "wav" | "mp3" | "flac" | "m4a" | "ogg" | "webm" | "aac";
  };
  /**
   * ISO-639-1 language hint (e.g. `"en"`, `"ja"`). Auto-detected when
   * omitted.
   */
  language?: string;
  /**
   * Sampling temperature in `[0, 1]`. Lower = more deterministic. Provider
   * default applies when omitted.
   */
  temperature?: number;
  /** Optional provider-specific passthrough. */
  provider?: TranscriptionProviderOptions;
  /** Optional end-user identifier forwarded to the provider. */
  user?: string;
}

/**
 * Parsed response from {@link TranscriptionsNamespace.create}. `text` is
 * always populated on success; `usage` is typed as optional to mirror
 * defensive handling of providers that omit it.
 */
export interface TranscriptionResponse {
  /** The transcribed text. */
  text: string;
  /** Token / duration / cost accounting. May be omitted by some providers. */
  usage?: {
    /** Duration of the input audio in seconds. */
    seconds?: number;
    /** Total tokens billed (input + output). */
    total_tokens: number;
    /** Input tokens billed. */
    input_tokens: number;
    /** Output tokens generated. */
    output_tokens: number;
    /** Optional cost in USD. */
    cost?: number;
  };
}

/**
 * Default values applied to every {@link TranscriptionsNamespace.create}
 * request unless overridden per call. All fields optional. Field-level
 * resolution: per-call request > these defaults > hardcoded fallback (model
 * only).
 */
export interface TranscriptionsDefaults {
  /** Default transcription model. Falls back to `"openai/gpt-4o-mini-transcribe"`. */
  model?: string;
  /** Default ISO-639-1 language hint. */
  language?: string;
  /** Default sampling temperature. */
  temperature?: number;
  /** Default provider-specific passthrough. */
  provider?: TranscriptionProviderOptions;
}
