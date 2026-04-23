import { z } from "zod";
import type { Message, Result } from "../types/index.js";
import type { LLMConfig } from "../openrouter/index.js";
import { OpenRouterClient } from "../openrouter/index.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import { InMemorySessionStore, SessionBusyError } from "../session/index.js";
import type { AgentEvent, EventDisplay } from "./events.js";
import { runLoop, type RunLoopConfig, type RunLoopOptions } from "./loop.js";

export interface AgentConfig<Input> {
  name: string;
  description: string;
  llm?: LLMConfig;
  systemPrompt?: string;
  tools?: Tool<any>[];
  inputSchema?: z.ZodType<Input>;
  maxTurns?: number;
  sessionStore?: SessionStore;
  apiKey?: string;
  referer?: string;
  title?: string;
  display?: {
    start?: (input: string | Message[]) => EventDisplay;
    end?: (result: Result) => EventDisplay;
  };
}

export type AgentRunOptions = Omit<RunLoopOptions, "parentRunId"> & {
  parentRunId?: string;
};

const DEFAULT_INPUT_SCHEMA = z.object({ input: z.string() });

export class Agent<Input = { input: string }> extends Tool<Input> {
  private readonly llm: LLMConfig;
  private readonly systemPrompt?: string;
  private readonly agentTools: Tool<any>[];
  private readonly maxTurns: number;
  private readonly sessionStore: SessionStore;
  private readonly client: OpenRouterClient;
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

        const events: AgentEvent[] = [];
        const parentEmit = deps.emit;
        await runLoop(
          this.buildConfig(deps.runId),
          inputStr,
          { signal: deps.signal, parentRunId: deps.runId },
          (ev) => {
            events.push(ev);
            parentEmit?.(ev);
          }
        );
        const end = events.find((e) => e.type === "agent:end");
        if (end?.type !== "agent:end") {
          return { error: "subagent finished without agent:end event" };
        }
        if (end.result.stopReason === "error") {
          return { error: end.result.error?.message ?? "subagent errored" };
        }
        return { content: end.result.text };
      },
    });

    this.llm = config.llm ?? {};
    this.systemPrompt = config.systemPrompt;
    this.agentTools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.client = new OpenRouterClient({
      apiKey: config.apiKey,
      referer: config.referer,
      title: config.title,
    });
    this.agentDisplay = config.display;
  }

  async run(input: string | Message[], options: AgentRunOptions = {}): Promise<Result> {
    const release = this.acquireSession(options.sessionId);
    try {
      const events: AgentEvent[] = [];
      let outerRunId: string | undefined;
      await runLoop(this.buildConfig(options.parentRunId), input, options, (ev) => {
        events.push(ev);
        if (ev.type === "agent:start" && outerRunId === undefined) {
          outerRunId = ev.runId;
        }
      });
      const end = events.find(
        (e) => e.type === "agent:end" && e.runId === outerRunId
      );
      if (end?.type !== "agent:end") {
        throw new Error("runLoop finished without agent:end event");
      }
      return end.result;
    } finally {
      release();
    }
  }

  async *runStream(
    input: string | Message[],
    options: AgentRunOptions = {}
  ): AsyncIterable<AgentEvent> {
    const release = this.acquireSession(options.sessionId);
    try {
      const queue: AgentEvent[] = [];
      let resolveNext: (() => void) | null = null;
      let done = false;

      const emit = (ev: AgentEvent) => {
        queue.push(ev);
        const r = resolveNext;
        resolveNext = null;
        r?.();
      };

      const loopPromise = runLoop(this.buildConfig(options.parentRunId), input, options, emit)
        .finally(() => {
          done = true;
          const r = resolveNext;
          resolveNext = null;
          r?.();
        });

      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }

      await loopPromise;
    } finally {
      release();
    }
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
      llm: this.llm,
      tools: this.agentTools,
      maxTurns: this.maxTurns,
      sessionStore: this.sessionStore,
      client: this.client,
      parentRunId,
      display: this.agentDisplay,
    };
  }
}
