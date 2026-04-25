/**
 * Helpers for constructing `role: "tool"` conversation messages that the
 * agent loop appends after each tool call resolves.
 *
 * The OpenRouter (OpenAI-compatible) wire protocol requires the `content`
 * field of a tool message to be a string keyed by the originating
 * `tool_call_id`. These helpers centralize the stringification rules and the
 * error-prefix convention so the agent loop and any test fixtures stay in
 * lockstep.
 *
 * @module lib/messages
 * @see {@link ../types!Message}
 */

import type { Message } from "../types/index.js";

/**
 * Builds the `role: "tool"` message appended to the conversation after a
 * tool's `execute()` returned a successful payload.
 *
 * Strings are passed through unchanged; any other value is serialized via
 * {@link JSON.stringify} since the OpenRouter wire protocol requires the
 * `content` field to be a string. Callers that need a specific serialization
 * (e.g. pretty-printed JSON, custom redaction) should stringify themselves
 * and pass the resulting string in.
 *
 * @param toolCallId - The `id` of the assistant `tool_calls[i]` entry this
 *   message is responding to. Must match exactly or the model will not be
 *   able to associate the result with its request.
 * @param output - The tool's return value. Strings are forwarded verbatim;
 *   anything else is JSON-stringified. `undefined` becomes the literal string
 *   `"undefined"` because `JSON.stringify(undefined)` returns `undefined` —
 *   prefer `null` if you need an explicit empty result.
 * @returns A {@link Message} with `role: "tool"`, the supplied
 *   `tool_call_id`, and the stringified `content`.
 *
 * @example
 * ```ts
 * buildToolResultMessage("call_1", { ok: true });
 * // => { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' }
 * ```
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
 * tool's `execute()` threw or returned `{ error }`.
 *
 * The model sees the prefixed `"Error: "` string so it can decide whether to
 * retry the call with adjusted arguments, fall back to a different tool, or
 * surface the failure to the user. The prefix is part of the contract — do
 * not alter it without updating any prompts or evals that depend on it.
 *
 * @param toolCallId - The `id` of the assistant `tool_calls[i]` entry this
 *   error message is responding to.
 * @param error - Human-readable error description. Should already be a plain
 *   string (e.g. `err.message`); structured errors should be flattened by the
 *   caller before being passed in.
 * @returns A {@link Message} with `role: "tool"`, the supplied
 *   `tool_call_id`, and `content` of the form `"Error: {error}"`.
 *
 * @example
 * ```ts
 * buildToolErrorMessage("call_2", "timeout after 30s");
 * // => { role: "tool", tool_call_id: "call_2", content: "Error: timeout after 30s" }
 * ```
 */
export function buildToolErrorMessage(toolCallId: string, error: string): Message {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: `Error: ${error}`,
  };
}
