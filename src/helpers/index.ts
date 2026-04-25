/**
 * Public surface for the `helpers` module — consumer-facing utilities for
 * working with {@link Agent} runs and event streams.
 *
 * Helpers in this folder are imported from the package root; they do not
 * participate in the agent-loop machinery itself.
 */
export { displayOf } from "./displayOf.js";
export { consumeAgentEvents } from "./consumeEvents.js";
export type { AgentEventHandlers } from "./consumeEvents.js";
export { defaultDisplay } from "../agent/events.js";
export { streamText } from "./streamText.js";
export { serializeEvent, serializeEventsAsNDJSON, readEventStream } from "./ndjson.js";
export { pipeEventsToNodeResponse, eventsToWebResponse } from "./responseAdapters.js";
export type { NodeResponseLike, ResponseAdapterOptions } from "./responseAdapters.js";
