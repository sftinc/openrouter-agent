/**
 * Public surface for the `tool` module.
 *
 * Re-exports the {@link Tool} class (the primary entry point used to define
 * a callable function for the agent), its construction config
 * ({@link ToolConfig}) and display-hook shape ({@link ToolDisplayHooks}),
 * and the loop-facing types {@link ToolDeps} and {@link ToolResult}.
 *
 * Consumers should import from this folder (e.g. `from "./tool"`) rather
 * than from individual files inside it.
 *
 * @module tool
 */
/** See {@link ./Tool!Tool}. */
export { Tool } from "./Tool.js";
/** See {@link ./Tool!ToolConfig} and {@link ./Tool!ToolDisplayHooks}. */
export type { ToolConfig, ToolDisplayHooks } from "./Tool.js";
/** See {@link ./types!ToolDeps} and {@link ./types!ToolResult}. */
export type { ToolDeps, ToolResult } from "./types.js";
