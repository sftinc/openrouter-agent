import { z } from "zod";
import type { Message, Result } from "../types/index.js";
import type { LLMConfig } from "../openrouter/index.js";
import { OpenRouterClient, getOpenRouterClient } from "../openrouter/index.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import { InMemorySessionStore, SessionBusyError } from "../session/index.js";
import type { AgentEvent, EventDisplay } from "./events.js";
import { runLoop, type RunLoopConfig, type RunLoopOptions } from "./loop.js";

/**
 * Construction-time configuration for an Agent. Everything except `name` and
 * `description` is optional. `client` overrides shallow-merge over the
 * project-wide `OpenRouterClient` defaults registered with
 * `setOpenRouterClient(...)`.
 */
export interface AgentConfig<Input> {
  name: string;
  description: string;
  /**
   * Per-agent overrides for the OpenRouter client's request body. Shallow-
   * merged over the project-wide client's defaults set via
   * `setOpenRouterClient(...)`. Every `LLMConfig` field is optional.
   */
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

/**
 * Per-call options for `Agent.run()` and `Agent.runStream()`. Overrides the
 * corresponding `AgentConfig` fields for this one invocation.
 * - `sessionId`: enables conversation persistence via the configured
 *   `SessionStore`. Concurrent runs for the same `sessionId` throw
 *   `SessionBusyError`.
 * - `signal`: aborts the run mid-turn. The session is not persisted on abort.
 * - `client`: per-call overrides on top of the agent's `client` config.
 * - `maxTurns`: overrides the agent's default turn cap.
 * - `system`: overrides the agent's `systemPrompt` for this call.
 * - `parentRunId`: when this agent runs as a subagent, the caller's `runId`
 *   so events can be correlated in a single tree.
 */
export type AgentRunOptions = Omit<RunLoopOptions, "parentRunId"> & {
  parentRunId?: string;
};

const DEFAULT_INPUT_SCHEMA = z.object({ input: z.string() });

/**
 * The core agent. Extends `Tool` so an Agent can be passed wherever a tool
 * is expected — this is how subagents work. `run()` returns the final
 * `Result`; `runStream()` yields every `AgentEvent` as it happens.
 *
 * @template Input Optional input shape; defaults to `{ input: string }`. When
 *   provided, the agent validates tool-call style invocations (e.g. from a
 *   parent agent) against this schema.
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

  /**
   * @param config Agent configuration. `name` and `description` are required.
   *   Everything else falls back to sensible defaults (InMemorySessionStore,
   *   `maxTurns=10`, empty tool list, no system prompt, default input schema
   *   of `{ input: string }`).
   */
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

    this.clientOverrides = config.client ?? {};
    this.systemPrompt = config.systemPrompt;
    this.agentTools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    // The global client is the only identity. If none was registered, fall back
    // to a default one that picks up OPENROUTER_API_KEY from the environment.
    this.openrouter = getOpenRouterClient() ?? new OpenRouterClient({});
    this.agentDisplay = config.display;
  }

  /**
   * Run the agent to completion and return the final `Result`. The session
   * is persisted on clean terminal stop reasons (`done`, `max_turns`,
   * `length`, `content_filter`); on `error` or `aborted` the session is
   * left unchanged so callers can safely retry.
   *
   * @param input Either a user string or a full message array. If messages
   *   include a `role: "system"` entry it is honored for this call only and
   *   never persisted.
   * @param options Per-call overrides. See `AgentRunOptions`.
   * @returns The accumulated `Result` with `text`, `messages`, `stopReason`,
   *   `usage`, `generationIds`, and optional `error`.
   * @throws SessionBusyError if `options.sessionId` is already running.
   */
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

  /**
   * Run the agent and yield every `AgentEvent` as it is emitted — agent
   * start/end, assistant messages, tool start/end, errors. This is *event*
   * streaming, not token streaming; the underlying HTTP call is still
   * non-streaming (see `OpenRouterClient.complete`).
   *
   * @throws SessionBusyError (synchronously, before the first yield) if
   *   `options.sessionId` is already running.
   */
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
