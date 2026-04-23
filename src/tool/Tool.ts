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
  success?: (args: Args, output: unknown) => Partial<EventDisplay>;
  error?: (args: Args, error: unknown) => Partial<EventDisplay>;
}

export interface ToolConfig<Args> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Args>;
  execute: (args: Args, deps: ToolDeps) => Promise<unknown>;
  display?: ToolDisplayHooks<Args>;
}

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

  execute(args: Args, deps: ToolDeps): Promise<unknown> {
    return this.executeFn(args, deps);
  }

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
