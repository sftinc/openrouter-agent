import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { OpenRouterTool } from "../openrouter/index.js";
import type { ToolDeps } from "./types.js";
import type { EventDisplay } from "../agent/events.js";

/**
 * A hook's return value is merged with the display-level `title` default. If
 * the hook omits `title`, the default is used. If neither supplies a title,
 * no display is emitted for that phase.
 */
export interface ToolDisplayHooks<Args> {
  /**
   * Default title for every phase (start/progress/success/error). Per-phase
   * hooks can override it by returning their own `title`. A string is used as
   * the title verbatim; a function receives the validated tool args.
   */
  title?: string | ((args: Args) => string);
  start?: (args: Args) => Partial<EventDisplay>;
  progress?: (args: Args, meta: { elapsedMs: number }) => Partial<EventDisplay>;
  success?: (
    args: Args,
    output: unknown,
    metadata?: Record<string, unknown>
  ) => Partial<EventDisplay>;
  error?: (
    args: Args,
    error: unknown,
    metadata?: Record<string, unknown>
  ) => Partial<EventDisplay>;
}

/**
 * Construction-time configuration for a `Tool`. The generic `Args` captures
 * the input shape derived from the Zod schema.
 */
export interface ToolConfig<Args> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Args>;
  execute: (args: Args, deps: ToolDeps) => Promise<unknown>;
  display?: ToolDisplayHooks<Args>;
}

/**
 * A tool the agent can call. Wraps a user `execute` function with a Zod
 * input schema (auto-converted to JSON Schema for OpenRouter) and optional
 * display hooks for UI. Instances can be passed to multiple Agents.
 *
 * @template Args The validated input shape (inferred from the Zod schema).
 */
export class Tool<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly display?: ToolDisplayHooks<Args>;
  private readonly executeFn: (args: Args, deps: ToolDeps) => Promise<unknown>;

  constructor(config: ToolConfig<Args>) {
    this.name = config.name;
    this.description = config.description;
    this.inputSchema = config.inputSchema;
    this.executeFn = config.execute;
    this.display = config.display;
  }

  /**
   * Invoke the tool. Called by the agent loop after validating `args`
   * against `inputSchema`. Return a string, a `ToolResult` shape, or any
   * value (auto-wrapped as `{ content }`). Throwing or returning
   * `{ error: string }` both signal failure to the loop.
   */
  execute(args: Args, deps: ToolDeps): Promise<unknown> {
    return this.executeFn(args, deps);
  }

  /**
   * Serialize this tool into the `OpenRouterTool` shape OpenRouter expects.
   * The Zod schema is converted to JSON Schema via `zod-to-json-schema`
   * (OpenAPI 3 target).
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
