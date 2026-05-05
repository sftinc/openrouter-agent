/**
 * @file Embeddings namespace. Wraps OpenRouter's `/embeddings` endpoint.
 *
 * Field-level resolution for `model`, lowest → highest priority:
 *   1. Hardcoded fallback `"openai/text-embedding-3-small"`.
 *   2. {@link EmbeddingsDefaults.model} on the namespace.
 *   3. {@link EmbedRequest.model} per call.
 */

import { Transport, type RequestOptions } from "./transport.js";
import type { EmbedRequest, EmbedResponse, EmbeddingsDefaults } from "./client.js";

/**
 * Embeddings namespace. Construct with a {@link Transport} and an optional
 * defaults object; expose as `client.embeddings` on
 * {@link OpenRouterClient}.
 *
 * @example
 * ```ts
 * import { OpenRouterClient } from "./openrouter";
 *
 * const client = new OpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   embeddings: { model: "qwen/qwen3-embedding-8b", dimensions: 1536 },
 * });
 * const res = await client.embeddings.create({ input: ["hello", "world"] });
 * const vecs = res.data.map((d) => d.embedding as number[]);
 * ```
 */
export class EmbeddingsNamespace {
	private readonly transport: Transport;
	private readonly embeddingsDefaults: EmbeddingsDefaults;

	/**
	 * @param transport Shared transport.
	 * @param defaults Optional per-namespace defaults.
	 */
	constructor(transport: Transport, defaults?: EmbeddingsDefaults) {
		this.transport = transport;
		this.embeddingsDefaults = defaults ?? {};
	}

	/** Read-only snapshot of the configured embeddings defaults. */
	get defaults(): EmbeddingsDefaults {
		return { ...this.embeddingsDefaults };
	}

	/**
	 * POST a non-streaming embeddings request and return the parsed
	 * {@link EmbedResponse}.
	 *
	 * @param request The embed request. `input` is required; `model` falls
	 *   through to {@link EmbeddingsDefaults.model}, then to
	 *   `"openai/text-embedding-3-small"`.
	 * @param signalOrOptions Bare `AbortSignal` or {@link RequestOptions}.
	 * @throws {OpenRouterError} On non-2xx after retries.
	 */
	async create(
		request: EmbedRequest,
		signalOrOptions?: AbortSignal | RequestOptions,
	): Promise<EmbedResponse> {
		const opts: RequestOptions =
			signalOrOptions instanceof AbortSignal
				? { signal: signalOrOptions }
				: (signalOrOptions ?? {});

		const model =
			request.model ?? this.embeddingsDefaults.model ?? "openai/text-embedding-3-small";
		const body: Record<string, unknown> = {
			model,
			input: request.input,
		};
		const dimensions = request.dimensions ?? this.embeddingsDefaults.dimensions;
		if (dimensions !== undefined) body.dimensions = dimensions;
		const encoding_format = request.encoding_format ?? this.embeddingsDefaults.encoding_format;
		if (encoding_format) body.encoding_format = encoding_format;
		const input_type = request.input_type ?? this.embeddingsDefaults.input_type;
		if (input_type) body.input_type = input_type;
		const user = request.user ?? this.embeddingsDefaults.user;
		if (user) body.user = user;

		const response = await this.transport.fetchWithRetry(
			"/embeddings",
			{ method: "POST", body: JSON.stringify(body) },
			opts,
			"[openrouter:embed]",
		);

		const json = (await response.json()) as EmbedResponse;
		if (process.env.OPENROUTER_DEBUG) {
			const redacted = {
				...json,
				data: json.data?.map((d) => {
					const dim = Array.isArray(d.embedding)
						? d.embedding.length
						: typeof d.embedding === "string"
							? d.embedding.length
							: 0;
					return { ...d, embedding: `<${dim} dims omitted>` };
				}),
			};
			// eslint-disable-next-line no-console
			console.log("[openrouter:embed] response:", JSON.stringify(redacted));
		}
		return json;
	}
}
