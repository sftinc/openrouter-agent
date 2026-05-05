/**
 * @file Transcriptions namespace. Wraps OpenRouter's
 * `/audio/transcriptions` endpoint.
 *
 * Field-level resolution for `model`, lowest → highest:
 *   1. Hardcoded fallback `"openai/gpt-4o-mini-transcribe"`.
 *   2. {@link TranscriptionsDefaults.model} on the namespace.
 *   3. {@link TranscriptionRequest.model} per call.
 */

import { Transport, type RequestOptions } from "../transport.js";
import type {
	TranscriptionRequest,
	TranscriptionResponse,
	TranscriptionsDefaults,
} from "./transcriptions.types.js";

/**
 * Transcriptions namespace. Expose as `client.audio.transcriptions` on
 * {@link OpenRouterClient}.
 *
 * @example
 * ```ts
 * import fs from "node:fs/promises";
 * import { OpenRouterClient } from "./openrouter";
 *
 * const client = new OpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   audio: { transcriptions: { model: "openai/whisper-1", language: "en" } },
 * });
 * const audio = await fs.readFile("voice.wav");
 * const res = await client.audio.transcriptions.create({
 *   input_audio: { data: audio.toString("base64"), format: "wav" },
 * });
 * console.log(res.text);
 * ```
 */
export class TranscriptionsNamespace {
	private readonly transport: Transport;
	private readonly transcriptionsDefaults: TranscriptionsDefaults;

	/**
	 * @param transport Shared transport.
	 * @param defaults Optional per-namespace defaults.
	 */
	constructor(transport: Transport, defaults?: TranscriptionsDefaults) {
		this.transport = transport;
		this.transcriptionsDefaults = defaults ?? {};
	}

	/** Read-only snapshot of the configured transcription defaults. */
	get defaults(): TranscriptionsDefaults {
		return { ...this.transcriptionsDefaults };
	}

	/**
	 * POST a transcription request and return the parsed response.
	 *
	 * @param request Transcription request. `input_audio` is required.
	 * @param signalOrOptions Bare `AbortSignal` or {@link RequestOptions}.
	 * @throws {OpenRouterError} On non-2xx after retries.
	 */
	async create(
		request: TranscriptionRequest,
		signalOrOptions?: AbortSignal | RequestOptions,
	): Promise<TranscriptionResponse> {
		const opts: RequestOptions =
			signalOrOptions instanceof AbortSignal
				? { signal: signalOrOptions }
				: (signalOrOptions ?? {});

		const model =
			request.model ?? this.transcriptionsDefaults.model ?? "openai/gpt-4o-mini-transcribe";
		const language = request.language ?? this.transcriptionsDefaults.language;
		const temperature = request.temperature ?? this.transcriptionsDefaults.temperature;
		const provider = request.provider ?? this.transcriptionsDefaults.provider;

		const body: Record<string, unknown> = {
			model,
			input_audio: request.input_audio,
		};
		if (language) body.language = language;
		if (temperature !== undefined) body.temperature = temperature;
		if (provider) body.provider = provider;
		if (request.user) body.user = request.user;

		const response = await this.transport.fetchWithRetry(
			"/audio/transcriptions",
			{ method: "POST", body: JSON.stringify(body) },
			opts,
			"[openrouter:transcribe]",
		);

		const json = (await response.json()) as TranscriptionResponse;
		if (process.env.OPENROUTER_DEBUG) {
			// Request side: log only metadata, never the base64 audio data.
			const requestMeta = {
				model,
				format: request.input_audio.format,
				language,
				temperature,
				provider,
			};
			// eslint-disable-next-line no-console
			console.log("[openrouter:transcribe] request:", JSON.stringify(requestMeta));
			// eslint-disable-next-line no-console
			console.log("[openrouter:transcribe] response:", JSON.stringify(json));
		}
		return json;
	}
}
