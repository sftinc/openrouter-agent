import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "../../src/openrouter/transport.js";
import { TranscriptionsNamespace } from "../../src/openrouter/audio/transcriptions.js";
import { OpenRouterError } from "../../src/openrouter/index.js";

describe("TranscriptionsNamespace.create", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("POSTs to /audio/transcriptions with model and base64 audio", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ text: "hello", usage: { seconds: 1, total_tokens: 5, input_tokens: 4, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new TranscriptionsNamespace(transport);

		const res = await ns.create({ input_audio: { data: "AAAA", format: "wav" } });

		const [url, init] = (globalThis.fetch as any).mock.calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
		const body = JSON.parse(init.body);
		expect(body.model).toBe("openai/gpt-4o-mini-transcribe");
		expect(body.input_audio).toEqual({ data: "AAAA", format: "wav" });
		expect(res.text).toBe("hello");
		expect(res.usage?.total_tokens).toBe(5);
	});

	test("client default model used when request omits model", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new TranscriptionsNamespace(transport, { model: "groq/whisper-large-v3", language: "en" });

		await ns.create({ input_audio: { data: "AAAA", format: "wav" } });
		const [, init] = (globalThis.fetch as any).mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.model).toBe("groq/whisper-large-v3");
		expect(body.language).toBe("en");
	});

	test("request fields override client defaults", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new TranscriptionsNamespace(transport, { model: "default-m", language: "en", temperature: 0.1 });

		await ns.create({
			input_audio: { data: "AAAA", format: "mp3" },
			model: "request-m",
			language: "ja",
			temperature: 0.5,
		});

		const [, init] = (globalThis.fetch as any).mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.model).toBe("request-m");
		expect(body.language).toBe("ja");
		expect(body.temperature).toBe(0.5);
	});

	test("forwards provider passthrough", async () => {
		(globalThis.fetch as any).mockResolvedValueOnce(
			new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new TranscriptionsNamespace(transport);
		await ns.create({
			input_audio: { data: "AAAA", format: "wav" },
			provider: { options: { groq: { prompt: "X" } } },
		});
		const [, init] = (globalThis.fetch as any).mock.calls[0];
		expect(JSON.parse(init.body).provider).toEqual({ options: { groq: { prompt: "X" } } });
	});

	test("non-2xx surfaces OpenRouterError", async () => {
		(globalThis.fetch as any).mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "bad audio" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
		);
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new TranscriptionsNamespace(transport);
		await expect(ns.create({ input_audio: { data: "AAAA", format: "wav" } })).rejects.toSatisfy((e: unknown) => {
			const err = e as OpenRouterError;
			return err instanceof OpenRouterError && err.code === 400 && err.message === "bad audio";
		});
	});

	test("aborts when signal fires", async () => {
		(globalThis.fetch as any).mockImplementation((_url: string, init: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		});
		const transport = new Transport({ apiKey: "sk-test" });
		const ns = new TranscriptionsNamespace(transport);
		const ac = new AbortController();
		const promise = ns.create({ input_audio: { data: "AAAA", format: "wav" } }, ac.signal);
		ac.abort();
		await expect(promise).rejects.toThrow();
	});
});
