/**
 * Public surface for the `types` module.
 *
 * Re-exports the core conversation type definitions used across the
 * sft-agent codebase: the {@link Message} discriminated union and its
 * supporting shapes ({@link ContentPart}, {@link ToolCall}), the cumulative
 * {@link Usage} accounting record, and the agent-run {@link Result}. Also
 * re-exports the runtime arrays {@link MESSAGE_ROLES} / {@link STOP_REASONS}
 * and their derived literal-union aliases {@link MessageRole} /
 * {@link StopReason} for callers that need to iterate or validate at runtime.
 *
 * Consumers should import from this folder (e.g. `from "./types"`) rather
 * than reaching into `./types/Message.js` directly. See the project
 * `CLAUDE.md` for the codebase organization rules.
 *
 * @module types
 */

/**
 * Re-exports the core message and result type aliases. See
 * {@link Message}, {@link ContentPart}, {@link ToolCall}, {@link Usage}, and
 * {@link Result} in `./Message.ts` for the full definitions.
 */
export type {
  Message,
  ContentPart,
  ToolCall,
  Usage,
  Result,
  UsageLogSource,
  UsageLogEntry,
} from "./Message.js";

/**
 * Re-exports the runtime arrays of valid roles and stop reasons. Use these
 * when validating untrusted input or enumerating values at runtime.
 */
export { MESSAGE_ROLES, STOP_REASONS } from "./Message.js";

/**
 * Re-exports the literal-union aliases derived from {@link MESSAGE_ROLES}
 * and {@link STOP_REASONS}.
 */
export type { MessageRole, StopReason } from "./Message.js";
