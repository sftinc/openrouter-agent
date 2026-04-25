/**
 * `Agent` — the primary entry point for the library.
 *
 * Defines an LLM-backed conversational agent with a fixed system prompt,
 * tool set, and OpenRouter client overrides. An Agent is itself a
 * {@link Tool}, which is how subagents work: pass an `Agent` into another
 * agent's `tools` array and it will be invoked as a tool, with its events
 * bubbled up into the parent's event stream.
 *
 * `Agent.run()` returns an {@link AgentRun} handle that is both awaitable
 * (for the final {@link Result}) and async-iterable (for every
 * {@link AgentEvent} in order).
 */
import { z } from "zod";
import type { Message, Result } from "../types/index.js";
import type { LLMConfig } from "../openrouter/index.js";
import { OpenRouterClient, getOpenRouterClient } from "../openrouter/index.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import { InMemorySessionStore, SessionBusyError } from "../session/index.js";
import type { AgentDisplayHooks } from "./events.js";
import { runLoop, type RunLoopConfig, type RunLoopOptions } from "./loop.js";
import { AgentRun } from "./AgentRun.js";

/**
 * Configuration shape passed to the {@link Agent} constructor.
 *
 * @template Input The validated argument type for this agent when used as a
 *   tool by a parent agent. Defaults to `{ input: string }` when no
 *   {@link AgentConfig.inputSchema} is provided.
 *
 * @example
 * ```ts
 * import { Agent } from "./agent";
 * import { Tool } from "./tool";
 *
 * const config: AgentConfig<{ input: string }> = {
 *   name: "writer",
 *   description: "Drafts short prose.",
 *   systemPrompt: "You write concise haiku.",
 *   tools: [],
 *   maxTurns: 5,
 *   client: { model: "anthropic/claude-haiku-4.5", temperature: 0.7 },
 * };
 * const agent = new Agent(config);
 * ```
 */
export interface AgentConfig<Input> {
  /** Tool name surfaced to parent agents. Must be unique within a tool set. */
  name: string;
  /** Description surfaced to the LLM (and to humans) when this agent is used as a tool. */
  description: string;
  /**
   * Per-agent OpenRouter overrides (model, temperature, provider routing,
   * etc.). Merged on top of the global client defaults at run time.
   */
  client?: LLMConfig;
  /**
   * System prompt used for every run unless explicitly overridden via
   * {@link RunLoopOptions.system}.
   */
  systemPrompt?: string;
  /**
   * Tools the agent may call. May contain other `Agent` instances to enable
   * subagents. Defaults to `[]` (no tools).
   */
  tools?: Tool<any>[];
  /**
   * Zod schema validating the tool-input shape when this agent is used as a
   * tool. Defaults to `z.object({ input: z.string() })`.
   */
  inputSchema?: z.ZodType<Input>;
  /**
   * Maximum number of LLM-call/tool-execution cycles per run before the
   * loop terminates with `stopReason: "max_turns"`. Defaults to `10`.
   */
  maxTurns?: number;
  /**
   * Optional session backing store. When supplied alongside
   * `options.sessionId` to {@link Agent.run}, conversation state persists
   * across runs. Defaults to a fresh {@link InMemorySessionStore}.
   */
  sessionStore?: SessionStore;
  /**
   * Optional display hooks invoked while running to attach human-readable
   * `display` payloads to lifecycle events. See {@link AgentDisplayHooks}.
   */
  display?: AgentDisplayHooks;
}

/**
 * Options accepted by {@link Agent.run}. Mirrors {@link RunLoopOptions}
 * with `parentRunId` exposed (subagent calls set it automatically inside
 * the tool wrapper, but it can also be set explicitly when threading runs
 * together by hand).
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * const result = await agent.run("Continue the story.", {
 *   sessionId: "user-42",
 *   signal: controller.signal,
 * });
 * ```
 */
export type AgentRunOptions = Omit<RunLoopOptions, "parentRunId"> & {
  /**
   * If set, the resulting `agent:start` event reports this run as a child
   * of `parentRunId`. Most callers do not need this — subagent invocations
   * set it automatically.
   */
  parentRunId?: string;
};

/**
 * Default Zod schema applied when the caller does not supply
 * {@link AgentConfig.inputSchema}. Accepts `{ input: string }`.
 */
const DEFAULT_INPUT_SCHEMA = z.object({ input: z.string() });

/**
 * The core agent. Extends `Tool` so an Agent can be passed wherever a tool
 * is expected — this is how subagents work. `run()` returns an `AgentRun`
 * handle which is both awaitable (for the final `Result`) and async-iterable
 * (for every `AgentEvent` in order).
 *
 * @template Input The validated argument shape when this agent is invoked
 *   as a tool by a parent agent. Defaults to `{ input: string }`.
 *
 * @example
 * ```ts
 * const agent = new Agent({ name: "writer", description: "writes things" });
 * const result = await agent.run("Write a haiku.");
 * for await (const ev of agent.run("Another haiku.")) console.log(ev.type);
 * ```
 */
export class Agent<Input = { input: string }> extends Tool<Input> {
  /** Per-agent OpenRouter overrides; merged with run-time `options.client` for each request. */
  private readonly clientOverrides: LLMConfig;
  /** Default system prompt for every run; can be overridden per-run via `options.system`. */
  private readonly systemPrompt?: string;
  /** Tool set this agent exposes to the LLM. May include other `Agent` instances (subagents). */
  private readonly agentTools: Tool<any>[];
  /** Maximum LLM/tool turns per run before forced termination. Defaults to `10`. */
  private readonly maxTurns: number;
  /** Backing session store; defaults to an `InMemorySessionStore` if not provided. */
  private readonly sessionStore: SessionStore;
  /** Resolved OpenRouter client (global singleton when registered, otherwise a fresh one). */
  private readonly openrouter: OpenRouterClient;
  /** Optional display hooks attached to lifecycle events. */
  private readonly agentDisplay?: AgentConfig<Input>["display"];
  /**
   * Set of session ids currently running on this Agent instance. Used to
   * enforce single-flight per session and surface {@link SessionBusyError}.
   */
  private readonly activeSessions = new Set<string>();

  /**
   * Construct an agent. Also wires up the underlying `Tool` superclass so
   * that invoking this agent as a tool from a parent runs a nested
   * {@link runLoop}, forwarding all child events into the parent's stream
   * via `deps.emit`.
   *
   * @param config The agent configuration. See {@link AgentConfig}.
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
   * and `AsyncIterable<AgentEvent>`.
   *
   * Throws `SessionBusyError` synchronously if `options.sessionId` is
   * already running.
   *
   * @param input Either a single user prompt string (appended as a `user`
   *   role message), or a full `Message[]` to seed the conversation. When
   *   an array is provided, an embedded `system` role message overrides the
   *   agent's configured `systemPrompt` (unless `options.system` is also
   *   set, in which case `options.system` wins).
   * @param options Per-run overrides; see {@link AgentRunOptions}. Defaults
   *   to `{}`.
   * @returns An {@link AgentRun} handle. Awaiting it yields the final
   *   {@link Result}; iterating it yields every {@link AgentEvent}.
   * @throws {SessionBusyError} Synchronously, if `options.sessionId` is
   *   already running on this Agent instance.
   *
   * @example
   * ```ts
   * // Just the final result.
   * const result = await agent.run(input);
   *
   * // Just the events.
   * for await (const ev of agent.run(input)) {
   *   console.log(ev.type);
   * }
   *
   * // Both — iterate events and await the result on the same handle.
   * const run = agent.run(input);
   * for await (const ev of run) {
   *   console.log(ev.type);
   * }
   * const result = await run.result;
   * ```
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

  /**
   * Reserve `sessionId` for the duration of a run, ensuring single-flight
   * concurrency per session id.
   *
   * @param sessionId The session id to reserve, or `undefined` for a
   *   stateless run (in which case this is a no-op).
   * @returns A release callback the caller MUST invoke (in a `finally`
   *   block) once the run terminates so subsequent runs may use the same
   *   session id.
   * @throws {SessionBusyError} If `sessionId` is already in use on this
   *   Agent instance.
   */
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

  /**
   * Assemble the {@link RunLoopConfig} from this agent's configured fields.
   * Called fresh per run so a future mutation surface can re-read live
   * values without breaking in-flight runs.
   *
   * @param parentRunId Optional outer run id when this run is a subagent
   *   invocation. Reported on the resulting `agent:start` event.
   * @returns A complete {@link RunLoopConfig} ready to be handed to
   *   {@link runLoop}.
   */
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
