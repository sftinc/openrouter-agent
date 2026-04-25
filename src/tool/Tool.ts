/**
 * Defines the {@link Tool} class — the abstraction agents use to expose
 * callable functions to the model. A `Tool` couples three things:
 *
 * 1. A Zod input schema, used both to validate model-provided arguments and
 *    to derive the JSON Schema that OpenRouter advertises to the LLM.
 * 2. An `execute` function the agent loop invokes when the model requests
 *    the tool, with dependencies (LLM completion, abort signal, message
 *    snapshot, etc.) injected via {@link ToolDeps}.
 * 3. Optional {@link ToolDisplayHooks} that shape the human-readable
 *    `display` payloads emitted on `tool:start`, `tool:progress`,
 *    `tool:success`, and `tool:error` agent events.
 *
 * Tool instances are immutable after construction and may be reused across
 * multiple `Agent`s and concurrent runs.
 *
 * @module tool/Tool
 */
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { OpenRouterTool } from "../openrouter/index.js";
import type { ToolDeps } from "./types.js";
import type { EventDisplay } from "../agent/events.js";

/**
 * Optional hooks that produce per-phase {@link EventDisplay} fragments for
 * a tool. The agent loop calls the relevant hook when emitting a
 * `tool:start`, `tool:progress`, `tool:success`, or `tool:error` event and
 * merges the returned partial onto a base display object.
 *
 * A hook's return value is merged with the display-level `title` default. If
 * the hook omits `title`, the default is used. If neither supplies a title,
 * no display is emitted for that phase.
 *
 * All hooks are synchronous and must not throw — runtime errors inside a
 * hook are swallowed by the loop's defensive wrapper rather than aborting
 * the run.
 *
 * @template Args The validated tool argument shape (the `z.infer` of the
 *   tool's `inputSchema`).
 */
export interface ToolDisplayHooks<Args> {
  /**
   * Default title for every phase (start/progress/success/error). Per-phase
   * hooks can override it by returning their own `title`. A string is used as
   * the title verbatim; a function receives the validated tool args and must
   * return a string synchronously.
   */
  title?: string | ((args: Args) => string);
  /**
   * Hook invoked once just before `execute()` runs. Receives the validated
   * arguments. Return a partial {@link EventDisplay} — fields are merged
   * onto the loop's base display object for the `tool:start` event.
   *
   * @param args The validated input arguments for the call.
   * @returns A partial display fragment merged into the emitted event.
   */
  start?: (args: Args) => Partial<EventDisplay>;
  /**
   * Hook invoked periodically while `execute()` is in flight (for tools
   * that opt into progress reporting). Receives the args and a meta object
   * with `elapsedMs` since `start`.
   *
   * @param args The validated input arguments for the call.
   * @param meta Live progress metadata supplied by the loop.
   * @param meta.elapsedMs Milliseconds elapsed since the tool started.
   * @returns A partial display fragment merged into the emitted event.
   */
  progress?: (args: Args, meta: { elapsedMs: number }) => Partial<EventDisplay>;
  /**
   * Hook invoked after `execute()` resolves successfully. Receives the args,
   * the raw return value (post-normalization at the loop boundary may
   * differ), and any tool-supplied `metadata`.
   *
   * @param args The validated input arguments for the call.
   * @param output The raw value returned by `execute()`.
   * @param metadata Optional metadata attached to the {@link ToolResult}.
   * @returns A partial display fragment merged into the emitted event.
   */
  success?: (
    args: Args,
    output: unknown,
    metadata?: Record<string, unknown>
  ) => Partial<EventDisplay>;
  /**
   * Hook invoked when `execute()` throws or returns `{ error: string }`.
   * Receives the args, the error value (an `Error` for throws, the string
   * for returned errors), and any tool-supplied metadata.
   *
   * @param args The validated input arguments for the call.
   * @param error The thrown value or `error` string returned by the tool.
   * @param metadata Optional metadata attached to a `{ error, metadata }`
   *   {@link ToolResult}.
   * @returns A partial display fragment merged into the emitted event.
   */
  error?: (
    args: Args,
    error: unknown,
    metadata?: Record<string, unknown>
  ) => Partial<EventDisplay>;
}

/**
 * Construction-time configuration for a {@link Tool}. The generic `Args`
 * captures the input shape derived from the Zod schema and is propagated
 * to the `execute` callback and the {@link ToolDisplayHooks}.
 *
 * @template Args The validated input shape (typically `z.infer<typeof schema>`).
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { Tool } from "./tool";
 *
 * const schema = z.object({ city: z.string() });
 * const weather = new Tool({
 *   name: "get_weather",
 *   description: "Fetch the current temperature for a city.",
 *   inputSchema: schema,
 *   execute: async ({ city }) => `It is 21°C in ${city}.`,
 * });
 * ```
 */
export interface ToolConfig<Args> {
  /**
   * Stable identifier the model uses to invoke the tool. Must be unique
   * within a given Agent's tool set and conform to OpenRouter's allowed
   * function-name pattern (`[A-Za-z0-9_-]+`).
   */
  name: string;
  /**
   * Natural-language description sent to the model. The LLM uses this to
   * decide when to call the tool, so be specific about inputs, side
   * effects, and expected outputs.
   */
  description: string;
  /**
   * Zod schema validating model-supplied arguments before `execute` is
   * called. Doubles as the source for the JSON Schema advertised to
   * OpenRouter (see {@link Tool.toOpenRouterTool}).
   */
  inputSchema: z.ZodType<Args>;
  /**
   * The tool implementation. Receives the validated `args` and a
   * {@link ToolDeps} bundle of injected helpers (LLM completion callback,
   * abort signal, message snapshot, etc.). May return any value; see
   * {@link ToolResult} for normalization rules.
   *
   * @param args The validated input arguments.
   * @param deps Loop-injected dependencies for the call.
   * @returns A promise resolving to the tool result (string, object, or
   *   {@link ToolResult}). Throwing or returning `{ error }` signals failure.
   */
  execute: (args: Args, deps: ToolDeps) => Promise<unknown>;
  /**
   * Optional UI hooks that generate {@link EventDisplay} fragments for the
   * lifecycle events emitted around this tool.
   */
  display?: ToolDisplayHooks<Args>;
}

/**
 * A tool the agent can call. Wraps a user `execute` function with a Zod
 * input schema (auto-converted to JSON Schema for OpenRouter) and optional
 * display hooks for UI. Instances are immutable after construction and
 * may be passed to multiple `Agent`s.
 *
 * @template Args The validated input shape (inferred from the Zod schema).
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { Tool } from "./tool";
 *
 * const echo = new Tool({
 *   name: "echo",
 *   description: "Echo the input back to the model.",
 *   inputSchema: z.object({ text: z.string() }),
 *   execute: async ({ text }) => text,
 *   display: {
 *     title: ({ text }) => `echo("${text}")`,
 *   },
 * });
 * ```
 */
export class Tool<Args = unknown> {
  /**
   * Stable identifier exposed to the model — see {@link ToolConfig.name}.
   */
  readonly name: string;
  /**
   * Natural-language description exposed to the model — see
   * {@link ToolConfig.description}.
   */
  readonly description: string;
  /**
   * The Zod schema used to validate model-supplied arguments and to
   * generate the JSON Schema sent to OpenRouter.
   */
  readonly inputSchema: z.ZodType<Args>;
  /**
   * Optional display hooks invoked by the agent loop when emitting tool
   * lifecycle events. May be `undefined` when the tool opts out of UI
   * customization.
   */
  readonly display?: ToolDisplayHooks<Args>;
  /**
   * The user-supplied implementation. Held privately and invoked through
   * {@link Tool.execute} so the public surface stays narrow and stable.
   */
  private readonly executeFn: (args: Args, deps: ToolDeps) => Promise<unknown>;

  /**
   * Build a tool from a {@link ToolConfig}. No validation of `name` or
   * `description` is performed here; OpenRouter rejects the request later
   * if either is malformed. Display hooks are stored verbatim.
   *
   * @param config The tool's name, description, schema, executor, and
   *   optional display hooks.
   */
  constructor(config: ToolConfig<Args>) {
    this.name = config.name;
    this.description = config.description;
    this.inputSchema = config.inputSchema;
    this.executeFn = config.execute;
    this.display = config.display;
  }

  /**
   * Invoke the tool. Called by the agent loop after validating `args`
   * against {@link Tool.inputSchema}. Return a string, a {@link ToolResult}
   * shape, or any value (auto-wrapped as `{ content }`). Throwing or
   * returning `{ error: string }` both signal failure to the loop.
   *
   * Errors thrown inside `execute` propagate to the loop, which converts
   * them into a `tool:error` event and a `role: "tool"` error message
   * appended to the conversation so the model can recover.
   *
   * @param args The validated input arguments for this call.
   * @param deps Loop-injected helpers — see {@link ToolDeps}.
   * @returns A promise resolving to the raw tool output (later normalized
   *   to a {@link ToolResult} by the loop).
   * @throws Whatever the user-supplied `execute` function throws.
   */
  execute(args: Args, deps: ToolDeps): Promise<unknown> {
    return this.executeFn(args, deps);
  }

  /**
   * Serialize this tool into the {@link OpenRouterTool} shape OpenRouter
   * expects in the `tools` array of a completion request. The Zod schema
   * is converted to JSON Schema via `zod-to-json-schema` with the
   * `openApi3` target so it round-trips through OpenRouter's parameter
   * validation cleanly.
   *
   * Called once per request by the agent loop; no caching is performed
   * here, so callers that re-serialize repeatedly may want to memoize.
   *
   * @returns The OpenRouter `function`-typed tool descriptor.
   */
  toOpenRouterTool(): OpenRouterTool {
    const schema = zodToJsonSchema(this.inputSchema, { target: "openApi3" });
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: schema as object,
      },
    };
  }
}
