/**
 * `displayOf` — convenience helper that resolves the display payload for any
 * {@link AgentEvent}, preferring an explicit `event.display` and falling back
 * to {@link defaultDisplay}.
 *
 * Equivalent to writing `event.display ?? defaultDisplay(event)` everywhere,
 * but exposed as a single import so consumers cannot accidentally drop the
 * SDK fallback (e.g. by writing `event.display ?? null`).
 */
import type { AgentEvent, EventDisplay } from "../agent/events.js";
import { defaultDisplay } from "../agent/events.js";

/**
 * Resolve the `{ title, content? }` to render for an agent event.
 *
 * @param event Any {@link AgentEvent}.
 * @returns The event's explicit `display` if set, otherwise the
 *   {@link defaultDisplay} for that variant. Always returns a fully-shaped
 *   {@link EventDisplay} — never `null` or `undefined`.
 *
 * @example
 * ```ts
 * import { displayOf } from "@sftinc/openrouter-agent";
 *
 * for await (const event of agent.runStream("hello")) {
 *   const { title, content } = displayOf(event);
 *   console.log(title, content ?? "");
 * }
 * ```
 */
export function displayOf(event: AgentEvent): EventDisplay {
  return event.display ?? defaultDisplay(event);
}
