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
import type { RetryConfig } from "../openrouter/retry.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDisplayHooks } from "../tool/Tool.js";
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
  /**
   * Customizations that apply only when this agent is invoked as a tool by
   * a parent agent (i.e. as a subagent). Each entry inside is independently
   * optional. When the agent runs at top level (`agent.run(...)` without a
   * parent loop dispatching it), every entry here is silently ignored.
   *
   * @example
   * ```ts
   * import { Agent } from "./agent";
   *
   * new Agent({
   *   name: "researcher",
   *   description: "multi-step research",
   *   asTool: {
   *     metadata: (result, input) => ({
   *       topic: input.input,
   *       tokens: result.usage.total_tokens,
   *       stopReason: result.stopReason,
   *     }),
   *   },
   * });
   * ```
   */
  asTool?: {
    /**
     * Compute structured metadata to attach to the outer `tool:end.metadata`
     * field when this agent finishes a subagent invocation. Called once,
     * synchronously, after the inner run resolves but before the wrapper's
     * ToolResult is returned to the parent's loop. Receives the inner
     * {@link Result} (`text`, `usage`, `stopReason`, `messages`) and the
     * validated input args the parent passed.
     *
     * Returning `undefined` is equivalent to not setting the hook — no
     * `metadata` field is attached. The model never sees this value; it's
     * a side-channel for the parent's UI / telemetry / billing only. Despite
     * the name "metadata", this field is not limited to auxiliary info — put
     * primary client-facing structured data here (sources, citations,
     * billing fields, debug traces) if useful.
     *
     * @param result The inner run's {@link Result}, including `stopReason`
     *   (which may be `"error"` if the subagent failed gracefully).
     * @param input The validated input args the parent passed, shaped by
     *   {@link AgentConfig.inputSchema} (defaults to `{ input: string }`).
     * @returns A JSON-serializable record to attach as `tool:end.metadata`,
     *   or `undefined` to attach nothing.
     */
    metadata?: (result: Result, input: Input) => Record<string, unknown> | undefined;
  };
  /**
   * Optional retry policy for transient LLM-call failures. Applied to every
   * run started by this Agent; per-run overrides via
   * {@link AgentRunOptions.retry} merge field-by-field on top.
   *
   * Default: `{ maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, idleTimeoutMs: 60_000 }`.
   * Set `maxAttempts: 1` to disable retries.
   */
  retry?: RetryConfig;
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
 * Hidden marker used to thread the inner {@link Result} from an Agent's
 * tool wrapper to its synthesized success/error display hooks via the
 * per-invocation `metadata` object identity. The property is attached
 * non-enumerably so it stays invisible to JSON serialization, `Object.keys`,
 * `console.log`, and any downstream consumer reading `tool:end.metadata`.
 *
 * Why a Symbol on `metadata` rather than a closure variable?
 * `Tool.ts` documents that tool instances are immutable and may be reused
 * across concurrent runs. A single shared closure (`let lastResult`) would
 * race when the same child Agent is invoked concurrently from multiple
 * parents: the second run's `execute` would overwrite the first's captured
 * Result before the first run's loop emitted `tool:end`. Binding the Result
 * to the per-invocation `metadata` object identity — which the loop
 * forwards verbatim from `execute`'s ToolResult to the success/error
 * display hooks — keeps each invocation's Result attached to its own
 * invocation. Garbage-collected naturally when the metadata object
 * becomes unreachable.
 */
const INNER_RESULT_KEY = Symbol("agentInnerResult");

/**
 * Reshape a Tool's `args` into the input shape the AgentDisplayHooks
 * expect (`string | Message[]`). When the Agent uses the default
 * `{ input: string }` schema, return the inner string; otherwise pass
 * the args through as a JSON-serializable proxy. This keeps the
 * synthesis lossy-but-useful: hooks that destructure `{ input }` work
 * cleanly; hooks that just use the input as a label string get a
 * sensible fallback.
 *
 * @remarks
 * In practice the synthesized hooks always observe a `string` here,
 * never a `Message[]`. {@link Agent.execute} normalizes its tool-call
 * args to a `string` before dispatching `runLoop`, so the only values
 * that can flow into this helper at the as-tool path are the validated
 * tool arguments — i.e. an object matching the agent's `inputSchema`.
 * The `Message[]` return branch exists purely for type-shape
 * compatibility with {@link AgentDisplayHooks} (whose `start`/`title`
 * accept `string | Message[]` so direct `agent.run()` callers can pass
 * either) and is unreachable when the Agent is invoked as a tool.
 */
function inputArgsToAgentInput(args: unknown): string | Message[] {
  if (args && typeof args === "object" && "input" in args) {
    const v = (args as { input: unknown }).input;
    if (typeof v === "string") return v;
  }
  return typeof args === "string" ? args : JSON.stringify(args);
}

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
  /** Stored retry config; merged per-run with `RunLoopOptions.retry`. */
  private readonly retryConfig?: RetryConfig;
  /**
   * Set of session ids currently running on this Agent instance. Used to
   * enforce single-flight per session and surface {@link SessionBusyError}.
   */
  private readonly activeSessions = new Set<string>();

  /**
   * Construct an agent. Also wires up the underlying `Tool` superclass so
   * that invoking this agent as a tool from a parent runs a nested
   * {@link runLoop}, forwarding child events into the parent's stream via
   * `deps.emit` — except `message` and `message:delta`, which remain on
   * the inner `AgentRun` only so subagent reasoning artifacts don't
   * pollute the parent's chat-bubble path.
   *
   * @param config The agent configuration. See {@link AgentConfig}.
   */
  constructor(config: AgentConfig<Input>) {
    const inputSchema =
      config.inputSchema ?? (DEFAULT_INPUT_SCHEMA as unknown as z.ZodType<Input>);

    const agentDisplay = config.display;

    // The synthesized success/error hooks need this invocation's inner
    // Result to forward to the user's `agentDisplay.success`/`.error`. We
    // can't use a closure variable here: a single shared `lastResult`
    // would race when the same child Agent is shared across concurrent
    // parent runs, since `execute`'s assignment can be overwritten by a
    // sibling invocation's `execute` resolving in between the loop's
    // microtasks. Instead, `execute` attaches the Result to the
    // per-invocation `metadata` object (via `INNER_RESULT_KEY`, a hidden
    // non-enumerable Symbol property), and the hooks pluck it back off
    // their own `metadata` argument — `loop.ts` forwards `result.metadata`
    // identity-preservingly to the success/error display hooks.
    const readInnerResult = (
      metadata: Record<string, unknown> | undefined
    ): Result | undefined => {
      if (!metadata) return undefined;
      const v = (metadata as Record<PropertyKey, unknown>)[INNER_RESULT_KEY];
      return v as Result | undefined;
    };

    const synthesizedToolDisplay: ToolDisplayHooks<Input> | undefined = agentDisplay
      ? {
          title:
            agentDisplay.title === undefined
              ? undefined
              : typeof agentDisplay.title === "string"
                ? agentDisplay.title
                : (args) => {
                    const input = inputArgsToAgentInput(args);
                    return (agentDisplay.title as (i: string | Message[]) => string)(input);
                  },
          start: agentDisplay.start
            ? (args) => agentDisplay.start!(inputArgsToAgentInput(args))
            : undefined,
          success:
            agentDisplay.success || agentDisplay.end
              ? (_args, _output, metadata) => {
                  const result = readInnerResult(metadata);
                  if (!result) return {};
                  const hook = agentDisplay.success ?? agentDisplay.end;
                  return hook!(result);
                }
              : undefined,
          error:
            agentDisplay.error || agentDisplay.end
              ? (_args, _err, metadata) => {
                  const result = readInnerResult(metadata);
                  if (!result) return {};
                  const hook = agentDisplay.error ?? agentDisplay.end;
                  return hook!(result);
                }
              : undefined,
        }
      : undefined;

    super({
      name: config.name,
      description: config.description,
      inputSchema,
      display: synthesizedToolDisplay,
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
              // Subagents are tools from the parent's perspective. Their internal
              // message events are model-shaped reasoning artifacts addressed to
              // the parent loop, not the end user, and should not pollute the
              // parent's NDJSON stream. Keep them on the inner AgentRun (via
              // emit) for inspector/devtools access.
              if (ev.type !== "message" && ev.type !== "message:delta") {
                parentEmit?.(ev);
              }
              emit(ev);
            }
          );
        });
        try {
          const result = await handle.result;
          // Build the metadata object first so we can attach the inner
          // Result to it. When the user supplies `asTool.metadata`, use
          // that object; otherwise (and when display hooks are configured)
          // create a fresh empty object so the Symbol attachment has a
          // home. When neither display nor asTool.metadata is configured
          // we still attach to an internal object — the loop only sees it
          // if at least one path needs it.
          const userMetadata = config.asTool?.metadata?.(result, args);
          const needsResultThread = synthesizedToolDisplay !== undefined;
          const metadata =
            userMetadata !== undefined
              ? userMetadata
              : needsResultThread
                ? ({} as Record<string, unknown>)
                : undefined;
          if (metadata && needsResultThread) {
            // Non-enumerable so JSON.stringify and Object.keys ignore it,
            // keeping the observable `tool:end.metadata` identical to what
            // the user supplied.
            Object.defineProperty(metadata, INNER_RESULT_KEY, {
              value: result,
              enumerable: false,
              writable: false,
              configurable: true,
            });
          }
          if (result.stopReason === "error") {
            return { error: result.error?.message ?? "subagent errored", metadata };
          }
          return { content: result.text, metadata };
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
    this.retryConfig = config.retry;
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
      retry: this.retryConfig,
    };
  }
}
