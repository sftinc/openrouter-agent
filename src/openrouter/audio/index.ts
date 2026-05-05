/**
 * @file Aggregator for the audio sub-namespace. Currently exposes only
 * `transcriptions`; future audio endpoints (e.g. text-to-speech) will be
 * added here as additional sub-namespaces.
 */

import { Transport } from "../transport.js";
import { TranscriptionsNamespace } from "./transcriptions.js";
import type { TranscriptionsDefaults } from "./transcriptions.types.js";

/**
 * Holder for OpenRouter's audio endpoints. Construct with a
 * {@link Transport} and optional per-sub-namespace defaults; expose as
 * `client.audio` on {@link OpenRouterClient}.
 */
export class AudioNamespace {
	/** Transcription sub-namespace. */
	readonly transcriptions: TranscriptionsNamespace;

	constructor(
		transport: Transport,
		defaults?: { transcriptions?: TranscriptionsDefaults },
	) {
		this.transcriptions = new TranscriptionsNamespace(transport, defaults?.transcriptions);
	}
}

export { TranscriptionsNamespace } from "./transcriptions.js";
export type {
	TranscriptionRequest,
	TranscriptionResponse,
	TranscriptionsDefaults,
	TranscriptionProviderOptions,
} from "./transcriptions.types.js";
