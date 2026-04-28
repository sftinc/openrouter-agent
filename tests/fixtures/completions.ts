import type { CompletionsResponse, CompletionChunk, ToolCallDelta } from "../../src/openrouter/index.js";
import type { ToolCall, Usage } from "../../src/types/index.js";

const DEFAULT_USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
};

/**
 * Build a minimal valid `CompletionsResponse` for tests. Override any field
 * via `partial`. Defaults: id=`"gen-1"`, model=`"anthropic/claude-haiku-4.5"`,
 * single choice with `finish_reason: "stop"`, empty assistant content,
 * usage = 10/5/15.
 */
export function mockCompletionsResponse(
  partial: {
    id?: string;
    model?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
    finish_reason?: string;
    usage?: Usage;
  } = {}
): CompletionsResponse {
  return {
    id: partial.id ?? "gen-1",
    object: "chat.completion",
    created: 1704067200,
    model: partial.model ?? "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        message: {
          role: "assistant",
          content: partial.content ?? null,
          tool_calls: partial.tool_calls,
        },
      },
    ],
    usage: partial.usage ?? DEFAULT_USAGE,
  };
}

/** Sugar for a plain text completion. */
export function mockTextResponse(
  text: string,
  id = "gen-1",
  usage?: Usage
): CompletionsResponse {
  return mockCompletionsResponse({ id, content: text, finish_reason: "stop", usage });
}

/** Sugar for an assistant turn that issues a single tool call. */
export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  opts: { id?: string; callId?: string; usage?: Usage } = {}
): CompletionsResponse {
  return mockCompletionsResponse({
    id: opts.id ?? "gen-1",
    content: null,
    finish_reason: "tool_calls",
    usage: opts.usage,
    tool_calls: [
      {
        id: opts.callId ?? "call-1",
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(args) },
      },
    ],
  });
}

/**
 * Build a minimal list of `CompletionChunk`s for tests. Mirrors
 * `mockCompletionsResponse` but in streaming shape.
 */
export function mockCompletionChunks(
  partial: {
    id?: string;
    model?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
    finish_reason?: string;
    usage?: Usage;
  } = {}
): CompletionChunk[] {
  const id = partial.id ?? "gen-1";
  const model = partial.model ?? "anthropic/claude-haiku-4.5";
  const usage = partial.usage ?? DEFAULT_USAGE;
  const chunks: CompletionChunk[] = [];
  if (typeof partial.content === "string" && partial.content.length > 0) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created: 1704067200,
      model,
      choices: [
        {
          finish_reason: null,
          native_finish_reason: null,
          delta: { content: partial.content },
        },
      ],
    });
  }
  const toolDeltas: ToolCallDelta[] | undefined = partial.tool_calls?.map(
    (tc, i) => ({
      index: i,
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })
  );
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1704067200,
    model,
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        delta: { content: null, tool_calls: toolDeltas },
      },
    ],
  });
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 1704067200,
    model,
    choices: [],
    usage,
  });
  return chunks;
}

/** Async iterable wrapper around a pre-built chunk array. */
export function mockChunkStream(
  chunks: CompletionChunk[]
): AsyncIterable<CompletionChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

/**
 * Encode a `CompletionChunk[]` as an SSE `Response`, the wire shape
 * `OpenRouterClient.completeStream` parses. Terminates the stream with
 * `data: [DONE]`.
 *
 * @param chunks - the chunks to serialise, in order
 * @returns a `Response` with `Content-Type: text/event-stream` and status 200
 * @example
 * fetchSpy.mockResolvedValue(sseOfChunks(mockCompletionChunks({ content: "hi" })));
 */
export function sseOfChunks(chunks: CompletionChunk[]): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    `data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Sugar for a successful SSE response carrying a single text completion with
 * a small fixed usage block (5/3/8). Use when a test only cares that the
 * agent received some assistant text.
 *
 * @param content - the assistant text content to emit
 * @param id - optional generation id, defaults to `"gen-x"`
 * @returns a `Response` ready to hand back from a mocked `fetch`
 * @example
 * fetchSpy.mockResolvedValue(mockOkSse("hi there"));
 */
export function mockOkSse(content: string, id = "gen-x"): Response {
  return sseOfChunks(
    mockCompletionChunks({
      id,
      content,
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })
  );
}
