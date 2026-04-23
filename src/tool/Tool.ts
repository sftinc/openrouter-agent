import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { OpenRouterTool } from "../openrouter/index.js";
import type { ToolDeps } from "./types.js";
import type { EventDisplay } from "../agent/events.js";

export interface ToolDisplayHooks<Args> {
  start?: (args: Args) => EventDisplay;
  progress?: (args: Args, meta: { elapsedMs: number }) => EventDisplay;
  success?: (args: Args, output: unknown) => EventDisplay;
  error?: (args: Args, error: unknown) => EventDisplay;
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
