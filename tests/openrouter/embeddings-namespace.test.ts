import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "../../src/openrouter/transport.js";
import { EmbeddingsNamespace } from "../../src/openrouter/embeddings.js";
import { OpenRouterError } from "../../src/openrouter/index.js";

describe("EmbeddingsNamespace.create", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("POSTs to /embeddings with the model and input", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "e1", object: "list", model: "openai/text-embedding-3-small", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new EmbeddingsNamespace(transport);
		const res = await ns.create({ input: "hello" });

		const [url, init] = (globalThis.fetch as any).mock.calls[0];
		expect(url).toContain("/embeddings");
		const body = JSON.parse(init.body);
		expect(body.input).toBe("hello");
		expect(body.model).toBe("openai/text-embedding-3-small");
		expect(res.data[0]!.embedding).toEqual([0.1, 0.2]);
	});

	test("client default model is used when request omits model", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "e1", object: "list", model: "qwen/qwen3-embedding-8b", data: [], usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new EmbeddingsNamespace(transport, { model: "qwen/qwen3-embedding-8b" });
		await ns.create({ input: "hi" });

		const [, init] = (globalThis.fetch as any).mock.calls[0];
		expect(JSON.parse(init.body).model).toBe("qwen/qwen3-embedding-8b");
	});

	test("request.model wins over client default and hardcoded fallback", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "e1", object: "list", model: "voyage-3", data: [], usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new EmbeddingsNamespace(transport, { model: "qwen/qwen3-embedding-8b" });
		await ns.create({ input: "hi", model: "voyage-3" });

		const [, init] = (globalThis.fetch as any).mock.calls[0];
		expect(JSON.parse(init.body).model).toBe("voyage-3");
	});

	test("non-2xx surfaces OpenRouterError with code/message/body", async () => {
		(globalThis.fetch as any).mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "bad model", metadata: { x: 1 } } }), { status: 400, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new EmbeddingsNamespace(transport);
		await expect(ns.create({ input: "hi" })).rejects.toSatisfy((e: unknown) => {
			const err = e as OpenRouterError;
			return err instanceof OpenRouterError && err.code === 400 && err.message === "bad model" && err.metadata?.x === 1;
		});
	});

	test("forwards optional fields (dimensions, encoding_format, input_type, user)", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "e1", object: "list", model: "m", data: [], usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new EmbeddingsNamespace(transport);
		await ns.create({ input: "hi", model: "m", dimensions: 1536, encoding_format: "base64", input_type: "search_document", user: "u-1" });

		const [, init] = (globalThis.fetch as any).mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.dimensions).toBe(1536);
		expect(body.encoding_format).toBe("base64");
		expect(body.input_type).toBe("search_document");
		expect(body.user).toBe("u-1");
	});
});
