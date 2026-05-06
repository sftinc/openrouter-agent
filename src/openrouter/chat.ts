/**
 * @file Chat completions namespace. Wraps OpenRouter's
 * `/chat/completions` endpoint and exposes two methods:
 *
 * - {@link ChatNamespace.completeStream} — POSTs `stream: true` and yields
 *   parsed SSE chunks. The only method that hits the network.
 * - {@link ChatNamespace.complete} — drains `completeStream` and assembles a
 *   single {@link CompletionsResponse}. There is no separate non-streaming
 *   HTTP path; both methods drive the same SSE flow upstream.
 *
 * Field-level resolution per request, lowest → highest priority:
 *   1. Hardcoded model fallback `"openai/gpt-5.4"`.
 *   2. Defaults configured on the namespace (constructor arg).
 *   3. Fields supplied on the per-call request.
 *   4. `stream` is forced (`true`) and never overridable.
 */

import { Transport, type RequestOptions } from "./transport.js";
import { parseSseStream } from "./sse.js";
import { StreamTruncatedError } from "./errors.js";
import type {
	Annotation,
	CompletionChunk,
	CompletionsRequest,
	CompletionsResponse,
	LLMConfig,
} from "./types.js";

/**
 * Chat completions namespace. Construct with a {@link Transport} and an
 * optional defaults object; expose as `client.chat` on
 * {@link OpenRouterClient}.
 *
 * @example
 * ```ts
 * import { OpenRouterClient } from "./openrouter";
 *
 * const client = new OpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   chat: { model: "anthropic/claude-haiku-4.5", temperature: 0.2 },
 * });
 * const res = await client.chat.complete({
 *   messages: [{ role: "user", content: "hi" }],
 * });
 * for await (const chunk of client.chat.completeStream({
 *   messages: [{ role: "user", content: "hi" }],
 * })) {
 *   process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
 * }
 * ```
 */
export class ChatNamespace {
	/** Shared transport (auth, retry, fetch). */
	private readonly transport: Transport;
	/** Per-namespace defaults. May be empty. */
	private readonly chatDefaults: LLMConfig;

	/**
	 * @param transport Shared transport instance.
	 * @param defaults Optional defaults applied to every request unless
	 *   overridden per call. All fields optional.
	 */
	constructor(transport: Transport, defaults?: LLMConfig) {
		this.transport = transport;
		this.chatDefaults = defaults ?? {};
	}

	/**
	 * Read-only snapshot of the configured chat defaults. Returns a fresh
	 * object on each call.
	 */
	get defaults(): LLMConfig {
		return { ...this.chatDefaults };
	}

	/**
	 * POSTs a chat completion with `stream: true` and yields parsed SSE
	 * chunks ({@link CompletionChunk}) as they arrive. The final pre-`[DONE]`
	 * chunk typically carries `usage` with an empty `choices` array.
	 *
	 * @param request Completion request. `messages` is required.
	 * @param signalOrOptions Bare `AbortSignal` or {@link RequestOptions}.
	 * @throws {OpenRouterError} On non-2xx (after retries).
	 * @throws {StreamTruncatedError} When the stream ends without `[DONE]`
	 *   and no terminal `finish_reason` was observed.
	 * @throws {IdleTimeoutError} When no chunk arrives within `idleTimeoutMs`.
	 */
	async *completeStream(
		request: CompletionsRequest,
		signalOrOptions?: AbortSignal | RequestOptions,
	): AsyncGenerator<CompletionChunk, void, void> {
		const opts: RequestOptions =
			signalOrOptions instanceof AbortSignal
				? { signal: signalOrOptions }
				: (signalOrOptions ?? {});

		const body = JSON.stringify({
			model: "openai/gpt-5.4",
			...this.chatDefaults,
			...request,
			stream: true as const,
		});

		const response = await this.transport.fetchWithRetry(
			"/chat/completions",
			{ method: "POST", body },
			opts,
			"[openrouter:stream]",
			{ Accept: "text/event-stream" },
		);

		if (!response.body) {
			throw new StreamTruncatedError({
				message: "streaming response had no body",
				partialContentLength: 0,
			});
		}

		const debug = !!process.env.OPENROUTER_DEBUG;
		const debugChunks: CompletionChunk[] = [];
		let sawTerminalFinishReason = false;
		let partialContentLength = 0;
		try {
			for await (const payload of parseSseStream(response.body, { idleTimeoutMs: this.transport.retry.idleTimeoutMs })) {
				const chunk = payload as CompletionChunk;
				if (debug) debugChunks.push(chunk);
				for (const c of chunk.choices ?? []) {
					if (c.finish_reason != null) sawTerminalFinishReason = true;
					if (typeof c.delta?.content === "string") partialContentLength += c.delta.content.length;
				}
				yield chunk;
			}
			if (debug) {
				const assembled = assembleCompletionsResponse(debugChunks);
				const hasToolCalls = (assembled.choices ?? []).some(
					(c) => Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0,
				);
				const debugBody = JSON.stringify(assembled);
				// eslint-disable-next-line no-console
				console.log("[openrouter:stream] response:", hasToolCalls ? `\x1b[33m${debugBody}\x1b[0m` : debugBody);
			}
		} catch (err) {
			if (err instanceof StreamTruncatedError) {
				if (sawTerminalFinishReason) return;
				throw new StreamTruncatedError({
					message: err.message,
					generationId: err.generationId,
					partialContentLength,
				});
			}
			throw err;
		} finally {
			response.body.cancel().catch(() => {});
		}
	}

	/**
	 * Drain {@link ChatNamespace.completeStream} and return one assembled
	 * {@link CompletionsResponse}. Public contract identical to a non-streaming
	 * call: the wire path is always streaming, but the caller sees one
	 * resolved response.
	 *
	 * @param request Completion request. `messages` is required.
	 * @param signalOrOptions Bare `AbortSignal` or {@link RequestOptions}.
	 * @throws {OpenRouterError} On non-2xx (after retries).
	 * @throws {StreamTruncatedError} If the stream truncates mid-response.
	 */
	async complete(
		request: CompletionsRequest,
		signalOrOptions?: AbortSignal | RequestOptions,
	): Promise<CompletionsResponse> {
		const chunks: CompletionChunk[] = [];
		for await (const chunk of this.completeStream(request, signalOrOptions)) {
			chunks.push(chunk);
		}
		const assembled = assembleCompletionsResponse(chunks);
		if (process.env.OPENROUTER_DEBUG) {
			const hasToolCalls = (assembled.choices ?? []).some(
				(c) => Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0,
			);
			const debugBody = JSON.stringify(assembled);
			// eslint-disable-next-line no-console
			console.log("[openrouter] response:", hasToolCalls ? `\x1b[33m${debugBody}\x1b[0m` : debugBody);
		}
		return assembled;
	}
}

/**
 * Folds an ordered list of streaming {@link CompletionChunk}s into the
 * non-streaming {@link CompletionsResponse} shape. Previously a
 * debug-only helper in `client.ts`; promoted to first-class as the
 * implementation of {@link ChatNamespace.complete}.
 */
function assembleCompletionsResponse(chunks: CompletionChunk[]): CompletionsResponse {
	type ToolAcc = { id?: string; type?: "function"; name?: string; arguments: string };
	type ChoiceAcc = {
		content: string;
		role: string;
		toolCalls: Map<number, ToolAcc>;
		annotations: Annotation[];
		finish_reason: string | null;
		native_finish_reason: string | null;
	};
	const choices = new Map<number, ChoiceAcc>();
	let id = "";
	let model = "";
	let created = 0;
	let usage: CompletionsResponse["usage"];

	for (const chunk of chunks) {
		if (!id && chunk.id) id = chunk.id;
		if (!model && chunk.model) model = chunk.model;
		if (!created && chunk.created) created = chunk.created;
		if (chunk.usage) usage = chunk.usage;
		const cs = chunk.choices ?? [];
		for (let i = 0; i < cs.length; i++) {
			const sc = cs[i]!;
			const idx = (sc as unknown as { index?: number }).index ?? i;
			let acc = choices.get(idx);
			if (!acc) {
				acc = { content: "", role: "assistant", toolCalls: new Map(), annotations: [], finish_reason: null, native_finish_reason: null };
				choices.set(idx, acc);
			}
			if (typeof sc.delta?.content === "string") acc.content += sc.delta.content;
			if (sc.delta?.role) acc.role = sc.delta.role;
			const deltaAnnotations = (sc.delta as { annotations?: Annotation[] } | undefined)?.annotations;
			if (Array.isArray(deltaAnnotations)) acc.annotations.push(...deltaAnnotations);
			for (const td of sc.delta?.tool_calls ?? []) {
				let tc = acc.toolCalls.get(td.index);
				if (!tc) {
					tc = { id: td.id, type: td.type, name: td.function?.name, arguments: "" };
					acc.toolCalls.set(td.index, tc);
				} else {
					if (!tc.id && td.id) tc.id = td.id;
					if (!tc.type && td.type) tc.type = td.type;
					if (!tc.name && td.function?.name) tc.name = td.function.name;
				}
				if (typeof td.function?.arguments === "string") tc.arguments += td.function.arguments;
			}
			if (sc.finish_reason !== null && sc.finish_reason !== undefined) acc.finish_reason = sc.finish_reason;
			if (sc.native_finish_reason !== null && sc.native_finish_reason !== undefined)
				acc.native_finish_reason = sc.native_finish_reason;
		}
	}

	const sortedIndexes = [...choices.keys()].sort((a, b) => a - b);
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: sortedIndexes.map((idx) => {
			const acc = choices.get(idx)!;
			const toolCalls = [...acc.toolCalls.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, tc]) => ({
					id: tc.id ?? "",
					type: (tc.type ?? "function") as "function",
					function: { name: tc.name ?? "", arguments: tc.arguments },
				}));
			return {
				finish_reason: acc.finish_reason,
				native_finish_reason: acc.native_finish_reason,
				message: {
					role: acc.role,
					content: acc.content.length > 0 ? acc.content : null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
					...(acc.annotations.length > 0 ? { annotations: acc.annotations } : {}),
				},
			};
		}),
		...(usage ? { usage } : {}),
	};
}
