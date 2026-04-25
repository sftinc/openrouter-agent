/**
 * Public surface for the `agent` module.
 *
 * Re-exports the {@link Agent} class (the primary entry point), the
 * {@link AgentRun} handle returned from `Agent.run()`, the lower-level
 * {@link runLoop} driver and its config/options shapes, and the event
 * vocabulary ({@link AgentEvent}, {@link AgentDisplayHooks},
 * {@link EventDisplay}, {@link EventEmit}, {@link defaultDisplay}).
 *
 * Consumers should import from this folder (e.g. `from "./agent"`) rather
 * than from individual files inside it.
 */
export { Agent } from "./Agent.js";
export type { AgentConfig, AgentRunOptions } from "./Agent.js";
export { AgentRun } from "./AgentRun.js";
export { runLoop } from "./loop.js";
export type { RunLoopConfig, RunLoopOptions } from "./loop.js";
export { defaultDisplay } from "./events.js";
export { displayOf } from "./displayOf.js";
export type { AgentDisplayHooks, AgentEvent, EventDisplay, EventEmit } from "./events.js";
