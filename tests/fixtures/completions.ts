import type { CompletionsResponse } from "../../src/openrouter/index.js";
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
