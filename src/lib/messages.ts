import type { Message } from "../types/index.js";

/**
 * Builds the `role: "tool"` message appended to the conversation after a
 * tool's execute() returned a success payload. Non-string content is
 * JSON-stringified since the OpenRouter wire protocol requires string content.
 */
export function buildToolResultMessage(toolCallId: string, output: unknown): Message {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: typeof output === "string" ? output : JSON.stringify(output),
  };
}

/**
 * Builds the `role: "tool"` message appended to the conversation after a
 * tool's execute() threw or returned `{ error }`. The model sees the prefixed
 * "Error: " string so it can decide whether to retry or bail.
 */
export function buildToolErrorMessage(toolCallId: string, error: string): Message {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: `Error: ${error}`,
  };
}
