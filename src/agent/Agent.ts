import { z } from "zod";
import type { Message, Result } from "../types/index.js";
import type { LLMConfig } from "../openrouter/index.js";
import { OpenRouterClient, getOpenRouterClient } from "../openrouter/index.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import { InMemorySessionStore, SessionBusyError } from "../session/index.js";
import type { EventDisplay } from "./events.js";
import { runLoop, type RunLoopConfig, type RunLoopOptions } from "./loop.js";
import { AgentRun } from "./AgentRun.js";

export interface AgentConfig<Input> {
  name: string;
  description: string;
  client?: LLMConfig;
  systemPrompt?: string;
  tools?: Tool<any>[];
  inputSchema?: z.ZodType<Input>;
  maxTurns?: number;
  sessionStore?: SessionStore;
  display?: {
    start?: (input: string | Message[]) => EventDisplay;
    end?: (result: Result) => EventDisplay;
  };
}

export type AgentRunOptions = Omit<RunLoopOptions, "parentRunId"> & {
  parentRunId?: string;
};

const DEFAULT_INPUT_SCHEMA = z.object({ input: z.string() });

/**
 * The core agent. Extends `Tool` so an Agent can be passed wherever a tool
 * is expected — this is how subagents work. `run()` returns an `AgentRun`
 * handle which is both awaitable (for the final `Result`) and async-iterable
 * (for every `AgentEvent` in order).
 */
export class Agent<Input = { input: string }> extends Tool<Input> {
  private readonly clientOverrides: LLMConfig;
  private readonly systemPrompt?: string;
  private readonly agentTools: Tool<any>[];
  private readonly maxTurns: number;
  private readonly sessionStore: SessionStore;
  private readonly openrouter: OpenRouterClient;
  private readonly agentDisplay?: AgentConfig<Input>["display"];
  private readonly activeSessions = new Set<string>();

  constructor(config: AgentConfig<Input>) {
    const inputSchema =
      config.inputSchema ?? (DEFAULT_INPUT_SCHEMA as unknown as z.ZodType<Input>);

    super({
      name: config.name,
      description: config.description,
      inputSchema,
      execute: async (args: Input, deps: ToolDeps): Promise<string | ToolResult> => {
        const inputStr =
          args && typeof args === "object" && "input" in args
            ? String((args as { input: unknown }).input)
            : String(args);

        // Subagent: reuse the outer runId as parent, forward events upward.
        const parentEmit = deps.emit;
        const handle = new AgentRun(async (emit) => {
          await runLoop(
            this.buildConfig(deps.runId),
            inputStr,
            { signal: deps.signal, parentRunId: deps.runId },
            (ev) => {
              parentEmit?.(ev);
              emit(ev);
            }
          );
        });
        try {
          const result = await handle.result;
          if (result.stopReason === "error") {
            return { error: result.error?.message ?? "subagent errored" };
          }
          return { content: result.text };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    this.clientOverrides = config.client ?? {};
    this.systemPrompt = config.systemPrompt;
    this.agentTools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.openrouter = getOpenRouterClient() ?? new OpenRouterClient({});
    this.agentDisplay = config.display;
  }

  /**
   * Run the agent. The returned `AgentRun` is both `PromiseLike<Result>`
   * and `AsyncIterable<AgentEvent>`:
   *
   *   const result = await agent.run(input);                 // just the result
   *   for await (const ev of agent.run(input)) { ... }       // just the events
   *   const run = agent.run(input);                          // both
   *   for await (const ev of run) { ... }
   *   const result = await run.result;
   *
   * Throws `SessionBusyError` synchronously if `options.sessionId` is
   * already running.
   */
  run(input: string | Message[], options: AgentRunOptions = {}): AgentRun {
    const release = this.acquireSession(options.sessionId);
    return new AgentRun(async (emit) => {
      try {
        await runLoop(
          this.buildConfig(options.parentRunId),
          input,
          options,
          emit
        );
      } finally {
        release();
      }
    });
  }

  private acquireSession(sessionId: string | undefined): () => void {
    if (!sessionId) return () => {};
    if (this.activeSessions.has(sessionId)) {
      throw new SessionBusyError(sessionId);
    }
    this.activeSessions.add(sessionId);
    return () => {
      this.activeSessions.delete(sessionId);
    };
  }

  private buildConfig(parentRunId?: string): RunLoopConfig {
    return {
      agentName: this.name,
      systemPrompt: this.systemPrompt,
      client: this.clientOverrides,
      tools: this.agentTools,
      maxTurns: this.maxTurns,
      sessionStore: this.sessionStore,
      openrouter: this.openrouter,
      parentRunId,
      display: this.agentDisplay,
    };
  }
}
