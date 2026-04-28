/**
 * `runLoop` — the streaming agent driver.
 *
 * Implements the per-turn cycle: stream a completion, accumulate tool-call
 * deltas, emit lifecycle events, dispatch tool invocations, persist sessions
 * transactionally on clean termination, and produce a final {@link Result}.
 *
 * This module is the lower-level engine behind {@link Agent.run}. Most
 * consumers should use `Agent` rather than calling `runLoop` directly.
 */
import type { Message, Result, Usage } from "../types/index.js";
import type {
  CompletionChunk,
  LLMConfig,
  OpenRouterTool,
  ToolCallDelta,
} from "../openrouter/index.js";
import type { CompleteStreamOptions } from "../openrouter/client.js";
import type { ToolCall } from "../types/index.js";
import type { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import type { AgentDisplayHooks, AgentEvent, EventDisplay, EventEmit } from "./events.js";
import { generateId, mergeNumericRecords, buildToolResultMessage, buildToolErrorMessage } from "../lib/index.js";
import {
  withRetry,
  createRetryBudget,
  resolveRetryConfig,
  RetryableProviderError,
  type RetryConfig,
} from "../openrouter/retry.js";

/**
 * Mapping from OpenRouter `finish_reason` values that indicate a clean,
 * non-tool-call termination to our internal {@link Result.stopReason}. The
 * `tool_calls` finish reason is intentionally absent: when tool calls are
 * present the loop continues for another turn rather than stopping.
 */
const FINISH_REASON_TO_STOP: Record<string, Result["stopReason"]> = {
  stop: "done",
  length: "length",
  content_filter: "content_filter",
};

/**
 * Static configuration for a {@link runLoop} invocation. Built once per
 * Agent.run call by {@link Agent} and held constant for the lifetime of
 * the loop.
 */
export interface RunLoopConfig {
  /** Agent name reported on `agent:start` events and used in default display titles. */
  agentName: string;
  /** Default system prompt; overridable per-run via {@link RunLoopOptions.system}. */
  systemPrompt?: string;
  /** Base OpenRouter client overrides (model, temperature, provider routing, etc.). */
  client: LLMConfig;
  /** Registered tools. Empty array if the agent has no tools. */
  tools: Tool<any>[];
  /** Cap on LLM-call/tool-execution cycles. Hitting it terminates with `stopReason: "max_turns"`. */
  maxTurns: number;
  /** Optional session backing store; required only when callers also pass `sessionId`. */
  sessionStore?: SessionStore;
  /**
   * The OpenRouter streaming surface. Structurally typed — tests and other
   * environments can supply a mock implementing only `completeStream`.
   */
  openrouter: {
    /**
     * Issue a streaming completion. Must yield chunks in OpenRouter's SSE
     * shape (see {@link CompletionChunk}). The optional `signal` aborts the
     * underlying HTTP request when the run is cancelled.
     */
    completeStream: (
      request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
      signalOrOptions?: AbortSignal | CompleteStreamOptions
    ) => AsyncIterable<CompletionChunk>;
  };
  /**
   * Outer run id when this run is a subagent invocation. Reported on the
   * resulting `agent:start` event so consumers can reconstruct the run tree.
   */
  parentRunId?: string;
  /** Optional display hooks merged into lifecycle events. */
  display?: AgentDisplayHooks;
  /**
   * Optional default retry policy applied to every turn's LLM call.
   * Per-call overrides via {@link RunLoopOptions.retry} merge on top of this.
   * Falls through to `DEFAULT_RETRY_CONFIG` when both are unset.
   */
  retry?: RetryConfig;
}

/**
 * Per-call options for {@link runLoop}. All fields are optional and may
 * override values from {@link RunLoopConfig}.
 */
export interface RunLoopOptions {
  /**
   * If set, the run resumes the conversation persisted under this id (loaded
   * from {@link RunLoopConfig.sessionStore}) and writes back on a clean
   * terminal stop reason.
   */
  sessionId?: string;
  /**
   * Override for the system prompt. Wins over both
   * {@link RunLoopConfig.systemPrompt} and any `system` message embedded in
   * an `input: Message[]`.
   */
  system?: string;
  /**
   * Optional cancellation signal. When aborted, the loop terminates with
   * `stopReason: "aborted"` and skips session persistence.
   */
  signal?: AbortSignal;
  /** Per-call override for {@link RunLoopConfig.maxTurns}. */
  maxTurns?: number;
  /** Per-call OpenRouter overrides; merged on top of {@link RunLoopConfig.client}. */
  client?: LLMConfig;
  /** Outer run id when this run is a subagent invocation. Wins over {@link RunLoopConfig.parentRunId}. */
  parentRunId?: string;
  /**
   * Per-call retry override. Merged field-by-field on top of
   * {@link RunLoopConfig.retry}, then on top of `DEFAULT_RETRY_CONFIG`.
   */
  retry?: RetryConfig;
}

/**
 * Generate a fresh run id with the `run-` prefix.
 *
 * @returns A new opaque id suitable for `runId` on {@link AgentEvent}s.
 */
function newRunId(): string {
  return generateId("run-");
}

/**
 * Resolve a tool-use id, preferring the id supplied by the model and
 * falling back to a generated `tu-` prefixed one when missing or empty.
 *
 * @param fallback The id from the model's `tool_call.id`. May be empty.
 * @returns A non-empty stable identifier for one tool invocation.
 */
function newToolUseId(fallback: string): string {
  return fallback || generateId("tu-");
}

/**
 * Construct a zero-initialized {@link Usage} accumulator.
 *
 * @returns A `Usage` with all token counts at `0` and no optional fields.
 */
function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/**
 * Sum two {@link Usage} values, merging structured detail records and
 * carrying through optional fields (`cost`, `is_byok`, `*_details`).
 *
 * @param a The running total. Returned unchanged if `b` is `undefined`.
 * @param b The increment to add. May be `undefined` (no-op).
 * @returns A new `Usage` representing `a + b`. `cost` resolves to
 *   `undefined` when both sides contributed zero (avoids reporting a
 *   spurious `0` cost).
 */
function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost: (a.cost ?? 0) + (b.cost ?? 0) || undefined,
    prompt_tokens_details: mergeNumericRecords(a.prompt_tokens_details, b.prompt_tokens_details),
    completion_tokens_details: mergeNumericRecords(a.completion_tokens_details, b.completion_tokens_details),
    server_tool_use: mergeNumericRecords(a.server_tool_use, b.server_tool_use),
    cost_details: mergeNumericRecords(a.cost_details, b.cost_details),
    is_byok: b.is_byok ?? a.is_byok,
  };
}


/**
 * Coerce an arbitrary tool return value into a structured {@link ToolResult}.
 *
 * Accepts:
 * - A bare string (treated as `content`).
 * - An object with `error: string` (treated as a tool failure; preserves `metadata`).
 * - An object with `content` (preserves `metadata`).
 * - Anything else (treated as opaque `content`).
 *
 * @param raw The raw value returned by `Tool.execute`.
 * @returns A normalized {@link ToolResult} suitable for the loop to emit
 *   and forward to the model.
 */
function normalizeToolResult(raw: unknown): ToolResult {
  if (typeof raw === "string") return { content: raw };
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("error" in obj && typeof obj.error === "string") {
      return { error: obj.error, metadata: obj.metadata as Record<string, unknown> | undefined };
    }
    if ("content" in obj) {
      return {
        content: obj.content,
        metadata: obj.metadata as Record<string, unknown> | undefined,
      };
    }
  }
  return { content: raw };
}

/**
 * Run a display-resolution callback under a try/catch so a buggy hook can
 * never take down the surrounding run.
 *
 * @template T Return type of the wrapped callback.
 * @param fn Callback that may throw.
 * @returns The callback's return value, or `undefined` if it threw.
 */
function safeDisplay<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Merge a tool phase hook's partial display with the display-level `title`
 * default. Returns a fully-resolved `EventDisplay` with a string title, or
 * undefined if no title can be produced. All hook calls are wrapped in a
 * try/catch so a throwing display hook can't take down the run.
 *
 * @template Args The tool's validated argument type.
 * @param tool The tool whose `display` hooks should be consulted. May be
 *   `undefined` (e.g. for an unknown tool name) — returns `undefined`.
 * @param args The validated tool arguments, threaded into hook callbacks.
 * @param pickHook Selector that picks the phase-specific hook (`start`,
 *   `success`, `error`) from the tool's display config.
 * @returns A fully-resolved {@link EventDisplay}, or `undefined` if no
 *   string title could be produced or any hook threw.
 */
function resolveToolDisplay<Args>(
  tool: Tool<Args> | undefined,
  args: Args,
  pickHook: (d: NonNullable<Tool<Args>["display"]>) => Partial<import("./events.js").EventDisplay> | undefined
): import("./events.js").EventDisplay | undefined {
  if (!tool?.display) return undefined;
  return safeDisplay(() => {
    const d = tool.display!;
    const defaultTitle =
      typeof d.title === "function" ? d.title(args) : d.title;
    const partial = pickHook(d);
    const title = partial?.title ?? defaultTitle;
    if (typeof title !== "string") return undefined;
    return { title, content: partial?.content };
  });
}

/**
 * Merge an agent display hook's partial output with the display-level `title`
 * default. `pickHook` selects the phase-specific hook to call. Returns a
 * fully-resolved `EventDisplay` only if a string `title` can be produced.
 *
 * @param display The agent's display hooks. May be `undefined` — returns
 *   `undefined` immediately.
 * @param input The original `agent.run()` input, threaded into the
 *   `title` function form and `start` hook.
 * @param pickHook Selector that picks the phase-specific hook
 *   (`start`, `success`, `error`, `end`) from the display config.
 * @returns A fully-resolved {@link EventDisplay}, or `undefined` if no
 *   string title could be produced or any hook threw.
 */
function resolveAgentDisplay(
  display: AgentDisplayHooks | undefined,
  input: string | Message[],
  pickHook: (d: AgentDisplayHooks) => Partial<EventDisplay> | undefined
): EventDisplay | undefined {
  if (!display) return undefined;
  return safeDisplay(() => {
    const defaultTitle =
      typeof display.title === "function" ? display.title(input) : display.title;
    const partial = pickHook(display);
    const title = partial?.title ?? defaultTitle;
    if (typeof title !== "string") return undefined;
    return { title, content: partial?.content };
  });
}

/**
 * Pick the agent terminal-state hook for a given `Result`. `success` and
 * `error` apply only to their stopReason; everything else (including
 * `aborted` and `max_turns`) falls through to `end`. If no specific hook
 * matches, `end` is the universal fallback.
 *
 * @param display The agent's display hooks (already known to be defined).
 * @param result The terminal {@link Result} being reported.
 * @returns The partial display payload from the chosen hook, or
 *   `undefined` if no applicable hook is configured.
 */
function pickAgentEndHook(
  display: AgentDisplayHooks,
  result: Result
): Partial<EventDisplay> | undefined {
  if (result.stopReason === "done" && display.success) return display.success(result);
  if (result.stopReason === "error" && display.error) return display.error(result);
  return display.end?.(result);
}

/**
 * Runs a single tool call from the assistant's response: validates args,
 * executes the tool, normalizes the result, emits start/end events, and
 * returns the `role: "tool"` message to append to the conversation.
 * Extracted from runLoop's main loop so the per-turn flow stays readable.
 *
 * Side effects: emits exactly one `tool:start` and one `tool:end` event on
 * `emit`. Logs the result to stderr when `OPENROUTER_DEBUG` is set.
 *
 * @param toolCall The OpenRouter tool-call shape from the assistant message,
 *   carrying the model-supplied id and JSON-string arguments.
 * @param toolByName Lookup of registered tools by name. An entry missing
 *   here surfaces as a `"tool ... is not registered"` error to the model.
 * @param deps Tool dependencies (signal, runId, parent emit, completion
 *   helpers) forwarded to `Tool.execute`.
 * @param runId The current run id, copied onto emitted events.
 * @param emit The event sink for the run.
 * @returns The `role: "tool"` {@link Message} to append to the conversation
 *   for the model to consume on the next turn.
 */
async function executeToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  toolByName: Map<string, Tool>,
  deps: ToolDeps,
  runId: string,
  emit: EventEmit
): Promise<Message> {
  const toolUseId = newToolUseId(toolCall.id);
  const toolName = toolCall.function.name;
  const tool = toolByName.get(toolName);
  const toolStartedAt = Date.now();

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    parsedArgs = {};
  }

  emit({
    type: "tool:start",
    runId,
    toolUseId,
    toolName,
    input: parsedArgs,
    startedAt: toolStartedAt,
    display: resolveToolDisplay(tool, parsedArgs, (d) => d.start?.(parsedArgs)),
  });

  let result: ToolResult;
  if (!tool) {
    result = { error: `tool "${toolName}" is not registered with this agent` };
  } else {
    try {
      const validated = tool.inputSchema.parse(parsedArgs);
      const raw = await tool.execute(validated, deps);
      result = normalizeToolResult(raw);
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (process.env.OPENROUTER_DEBUG) {
    const payload =
      "error" in result
        ? { error: result.error, metadata: result.metadata }
        : { content: result.content, metadata: result.metadata };
    // eslint-disable-next-line no-console
    console.log(
      `[tool] ${toolName} result: \x1b[32m${JSON.stringify(payload)}\x1b[0m`
    );
  }

  if ("error" in result) {
    const err = result.error;
    const toolEndedAt = Date.now();
    emit({
      type: "tool:end",
      runId,
      toolUseId,
      toolName,
      error: err,
      metadata: result.metadata,
      startedAt: toolStartedAt,
      endedAt: toolEndedAt,
      elapsedMs: toolEndedAt - toolStartedAt,
      display: resolveToolDisplay(tool, parsedArgs, (d) => d.error?.(parsedArgs, err, result.metadata)),
    });
    return buildToolErrorMessage(toolCall.id, err);
  }

  const out = result.content;
  const toolEndedAt = Date.now();
  emit({
    type: "tool:end",
    runId,
    toolUseId,
    toolName,
    output: out,
    metadata: result.metadata,
    startedAt: toolStartedAt,
    endedAt: toolEndedAt,
    elapsedMs: toolEndedAt - toolStartedAt,
    display: resolveToolDisplay(tool, parsedArgs, (d) => d.success?.(parsedArgs, out, result.metadata)),
  });
  return buildToolResultMessage(toolCall.id, out);
}

/**
 * Compute the initial conversation state for a run: the resolved system
 * prompt and the seed message list (session history + new input, with
 * embedded system messages stripped from both).
 *
 * Precedence for the system prompt: `systemOverride` > embedded system
 * message in `input` (when `input` is `Message[]`) > `systemFromConfig`.
 *
 * @param input Either the user prompt string or a seeded message list.
 * @param systemOverride Per-call system override from
 *   {@link RunLoopOptions.system}.
 * @param systemFromConfig Default system prompt from
 *   {@link RunLoopConfig.systemPrompt}.
 * @param sessionMessages Persisted prior messages from the session store,
 *   or `null` if no session is in use.
 * @returns An object with three fields:
 *   - `system`: the resolved system prompt content (or `undefined` if none).
 *   - `messages`: the ordered seed message array for the loop (no
 *     system-role messages — the system prompt is prepended only on the
 *     wire). Order is `[...sessionMessages (system-stripped), ...newInput
 *     (system-stripped)]`.
 *   - `sessionCount`: the count of session-derived messages prepended to
 *     the seed (post system-strip). Used by the caller to slice them off
 *     `Result.messages` so the reported result reflects only this run's
 *     contribution rather than the full historical transcript.
 */
function resolveInitialMessages(
  input: string | Message[],
  systemOverride: string | undefined,
  systemFromConfig: string | undefined,
  sessionMessages: Message[] | null
): { system: string | undefined; messages: Message[]; sessionCount: number } {
  const messages: Message[] = [];

  let systemContent: string | undefined;
  if (systemOverride !== undefined) {
    systemContent = systemOverride;
  } else if (Array.isArray(input)) {
    const sys = input.find((m) => m.role === "system");
    if (sys && typeof sys.content === "string") systemContent = sys.content;
    else systemContent = systemFromConfig;
  } else {
    systemContent = systemFromConfig;
  }

  let sessionCount = 0;
  if (sessionMessages) {
    for (const m of sessionMessages) {
      if (m.role !== "system") {
        messages.push(m);
        sessionCount++;
      }
    }
  }

  if (Array.isArray(input)) {
    for (const m of input) {
      if (m.role === "system") continue;
      messages.push(m);
    }
  } else {
    messages.push({ role: "user", content: input });
  }

  return { system: systemContent, messages, sessionCount };
}

/**
 * Find the most recent assistant text message in the conversation.
 *
 * @param messages The full message log.
 * @returns The string content of the last `assistant`-role message whose
 *   `content` is a string, or `""` if none exist (e.g. the assistant only
 *   produced tool calls).
 */
function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

/**
 * Fold one streaming tool-call delta into the per-index buffer. The
 * provider sends fragments (id once, name once, arguments in many chunks)
 * keyed by `index`; this function reassembles them into a single
 * {@link ToolCallDelta} per index.
 *
 * Mutates `buf` in place. Argument fragments are concatenated; first-seen
 * `id` and `type` win.
 *
 * @param buf Per-index buffer keyed by the model-supplied tool call index.
 * @param delta The incoming streamed fragment to merge.
 */
function mergeToolCallDelta(
  buf: Map<number, ToolCallDelta>,
  delta: ToolCallDelta
): void {
  const existing = buf.get(delta.index);
  if (!existing) {
    buf.set(delta.index, {
      index: delta.index,
      id: delta.id,
      type: delta.type,
      function: {
        name: delta.function?.name,
        arguments: delta.function?.arguments ?? "",
      },
    });
    return;
  }
  if (existing.id === undefined && delta.id !== undefined) existing.id = delta.id;
  if (existing.type === undefined && delta.type !== undefined) existing.type = delta.type;
  if (delta.function?.name && !existing.function?.name) {
    existing.function = { ...existing.function, name: delta.function.name };
  }
  if (delta.function?.arguments) {
    existing.function = {
      ...existing.function,
      arguments: (existing.function?.arguments ?? "") + delta.function.arguments,
    };
  }
}

/**
 * Convert the per-index merge buffer into a flat, ordered list of
 * {@link ToolCall}s ready to attach to the assistant message and dispatch.
 *
 * Order: ascending by the original `index` from the provider stream.
 * Missing `id`, `type`, `function.name`, or `function.arguments` are
 * defaulted so the structure always type-checks (downstream code handles
 * empty values defensively).
 *
 * @param buf Per-index buffer populated by {@link mergeToolCallDelta}.
 * @returns Ordered, fully-shaped tool call array. Empty when no tool calls
 *   were produced this turn.
 */
function assembleToolCalls(buf: Map<number, ToolCallDelta>): ToolCall[] {
  const out: ToolCall[] = [];
  const indices = [...buf.keys()].sort((a, b) => a - b);
  for (const i of indices) {
    const d = buf.get(i)!;
    out.push({
      id: d.id ?? "",
      type: d.type ?? "function",
      function: {
        name: d.function?.name ?? "",
        arguments: d.function?.arguments ?? "",
      },
    });
  }
  return out;
}

/**
 * Execute one full agent run from start to terminal `agent:end`.
 *
 * Lifecycle:
 *  1. Emit `agent:start` with the assigned `runId`.
 *  2. Load prior session messages (if `sessionId` and `sessionStore` are set).
 *  3. Loop up to `maxTurns` times:
 *     - Stream a completion, accumulating content and tool-call deltas.
 *     - Emit `message:delta` per text chunk and a final `message` for the
 *       assembled assistant message.
 *     - On per-chunk error or finish_reason `"error"`: terminate with
 *       `stopReason: "error"`.
 *     - On clean finish_reason mapped via {@link FINISH_REASON_TO_STOP}:
 *       terminate with that reason.
 *     - Otherwise dispatch each tool call via {@link executeToolCall},
 *       append the tool messages, and continue.
 *  4. If the loop exits without setting `stopReason`, terminate with
 *     `"max_turns"`.
 *  5. On a clean stop reason (`done` / `max_turns` / `length` /
 *     `content_filter`), persist the conversation back to the session
 *     store. On `error` or `aborted`, the session is left untouched so the
 *     client can safely retry with the same input.
 *  6. Emit `agent:end` with the final {@link Result}.
 *
 * Cancellation: the loop respects `options.signal`. An aborted run
 * terminates with `stopReason: "aborted"` (no `error` event is emitted).
 *
 * @param config Static run configuration assembled by {@link Agent}.
 * @param input Either a user prompt string or a seed message list.
 * @param options Per-call overrides; see {@link RunLoopOptions}.
 * @param emit Event sink. Must accept events synchronously and not throw.
 * @returns A promise that resolves once the terminal `agent:end` has been
 *   emitted. The promise itself never rejects for run-level errors —
 *   errors are reported via the `error` and `agent:end` events.
 */
export async function runLoop(
  config: RunLoopConfig,
  input: string | Message[],
  options: RunLoopOptions,
  emit: EventEmit
): Promise<void> {
  const runId = newRunId();
  const runStartedAt = Date.now();
  const parentRunId = options.parentRunId ?? config.parentRunId;
  const maxTurns = options.maxTurns ?? config.maxTurns;
  const signal = options.signal;
  const overrides: LLMConfig = {
    ...config.client,
    ...(options.client ?? {}),
  };

  emit({
    type: "agent:start",
    runId,
    parentRunId,
    agentName: config.agentName,
    startedAt: runStartedAt,
    display: resolveAgentDisplay(config.display, input, (d) => d.start?.(input)),
  });

  const emitError = (code: number | undefined, message: string): void => {
    emit({ type: "error", runId, error: code !== undefined ? { code, message } : { message } });
  };

  const sessionRecord =
    options.sessionId && config.sessionStore
      ? await config.sessionStore.get(options.sessionId)
      : null;
  const sessionMessages = sessionRecord?.messages ?? null;
  const { system: systemContent, messages, sessionCount } = resolveInitialMessages(
    input,
    options.system,
    config.systemPrompt,
    sessionMessages
  );

  const wireMessages = (): Message[] =>
    typeof systemContent === "string"
      ? [{ role: "system", content: systemContent }, ...messages]
      : messages;

  const toolByName = new Map<string, Tool>();
  for (const t of config.tools) toolByName.set(t.name, t);
  const openrouterTools =
    config.tools.length > 0 ? config.tools.map((t) => t.toOpenRouterTool()) : undefined;

  let usage = zeroUsage();
  const generationIds: string[] = [];
  let stopReason: Result["stopReason"] | null = null;
  let error: Result["error"];

  const deps: ToolDeps = {
    complete: async (msgs, opts) => {
      let content = "";
      const toolBuf = new Map<number, ToolCallDelta>();
      let u: Usage | undefined;
      for await (const chunk of config.openrouter.completeStream(
        {
          ...overrides,
          ...(opts?.client ?? {}),
          messages: msgs,
          tools: opts?.tools,
        },
        signal
      )) {
        if (chunk.usage) u = chunk.usage;
        const sc = chunk.choices[0];
        if (!sc) continue;
        if (typeof sc.delta.content === "string") content += sc.delta.content;
        if (sc.delta.tool_calls) {
          for (const d of sc.delta.tool_calls) mergeToolCallDelta(toolBuf, d);
        }
      }
      const tool_calls = assembleToolCalls(toolBuf);
      return {
        content: content.length > 0 ? content : null,
        usage: u ?? zeroUsage(),
        tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      };
    },
    emit,
    signal,
    runId,
    parentRunId,
    getMessages: () => messages.slice(),
  };

  // Resolve retry config once for the whole run; per-turn budgets are
  // allocated fresh inside the loop.
  const retryConfig = resolveRetryConfig({ ...(config.retry ?? {}), ...(options.retry ?? {}) });

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    const budget = createRetryBudget(retryConfig);

    // Per-attempt buffers — re-initialized every retry so half-finished state
    // never leaks across attempts. The accumulated `generationIds` array is
    // shared so failed attempts that received an id are still recorded.
    let contentBuf = "";
    let toolCallBuf = new Map<number, ToolCallDelta>();
    let finishReason: string | null = null;
    let turnError: { code?: number; message: string; metadata?: Record<string, unknown> } | undefined;
    let generationId: string | null = null;
    let turnUsage: Usage | undefined;
    // Sticky across attempts within a turn: once any content delta has been
    // emitted to the consumer, the B2 boundary is crossed permanently for
    // this turn and retries must stop. Do NOT reset this on `attempt > 1`.
    let hasEmittedContentDelta = false;

    try {
      await withRetry(
        async (attempt) => {
          if (attempt > 1) {
            contentBuf = "";
            toolCallBuf = new Map();
            finishReason = null;
            turnError = undefined;
            generationId = null;
            turnUsage = undefined;
          }

          for await (const chunk of config.openrouter.completeStream(
            { ...overrides, messages: wireMessages(), tools: openrouterTools },
            { signal, retryBudget: budget, retryConfig }
          )) {
            if (!generationId && chunk.id) generationId = chunk.id;
            if (chunk.usage) turnUsage = chunk.usage;

            const sc = chunk.choices[0];
            if (!sc) continue;

            if (typeof sc.delta.content === "string" && sc.delta.content.length > 0) {
              contentBuf += sc.delta.content;
              hasEmittedContentDelta = true;
              emit({ type: "message:delta", runId, text: sc.delta.content });
            }
            if (sc.delta.tool_calls) {
              for (const d of sc.delta.tool_calls) mergeToolCallDelta(toolCallBuf, d);
            }
            if (sc.finish_reason) finishReason = sc.finish_reason;
            if (sc.error) {
              turnError = {
                code: sc.error.code,
                message: sc.error.message,
                metadata: sc.error.metadata,
              };
            }
          }

          // Translate provider-side errors into a retryable surface IF still
          // inside the B2 window. Past B2, fall through to the existing error
          // path (loop handles `turnError`/`finishReason: "error"` after this
          // try-block).
          if (!hasEmittedContentDelta) {
            if (turnError) {
              throw new RetryableProviderError({
                message: turnError.message,
                code: turnError.code,
                metadata: turnError.metadata,
              });
            }
            if (finishReason === "error") {
              throw new RetryableProviderError({
                message: "Unknown error from provider",
              });
            }
          }
        },
        {
          budget,
          // Wrap the configured `isRetryable` so that once we have emitted a
          // content delta this turn (past the B2 boundary), no error is
          // retryable — the loop must surface it to the caller.
          config: {
            ...retryConfig,
            isRetryable: (e: unknown) =>
              !hasEmittedContentDelta && retryConfig.isRetryable(e),
          },
          signal,
          onRetry: (info) => {
            if (generationId) generationIds.push(generationId);
            const errAny = info.error as { code?: number; message?: string; metadata?: Record<string, unknown> };
            emit({
              type: "retry",
              runId,
              turn,
              attempt: info.attempt,
              delayMs: info.delayMs,
              error: {
                code: errAny.code,
                message: errAny.message ?? String(info.error),
                metadata: errAny.metadata,
              },
            });
          },
        }
      );
    } catch (err) {
      if (signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      stopReason = "error";
      const anyErr = err as { code?: number; message?: string; metadata?: Record<string, unknown> };
      error = {
        code: anyErr.code,
        message: anyErr.message ?? String(err),
        metadata: anyErr.metadata,
      };
      emitError(anyErr.code, error.message);
      break;
    }

    if (generationId) generationIds.push(generationId);
    if (turnUsage) usage = addUsage(usage, turnUsage);

    const assembledToolCalls = assembleToolCalls(toolCallBuf);
    const hasToolCalls = assembledToolCalls.length > 0;
    const assistantMsg: Message = {
      role: "assistant",
      content: contentBuf.length > 0 ? contentBuf : null,
      tool_calls: hasToolCalls ? assembledToolCalls : undefined,
    };
    messages.push(assistantMsg);
    emit({ type: "message", runId, message: assistantMsg });

    if (turnError) {
      stopReason = "error";
      error = turnError;
      emitError(turnError.code, turnError.message);
      break;
    }

    if (finishReason === "error") {
      stopReason = "error";
      error = { message: "Unknown error from provider" };
      emitError(undefined, error.message);
      break;
    }

    const mapped = FINISH_REASON_TO_STOP[finishReason ?? ""];
    if (mapped) {
      stopReason = mapped;
      break;
    }

    if (!hasToolCalls) {
      stopReason = "done";
      break;
    }

    for (const toolCall of assembledToolCalls) {
      const toolMessage = await executeToolCall(toolCall, toolByName, deps, runId, emit);
      messages.push(toolMessage);
    }

    // Loop continues for next turn.
  }

  if (stopReason === null) stopReason = "max_turns";

  // Transactional persist: only write back to the session on a clean terminal
  // stop reason. On "error" or "aborted" the session stays exactly as it was
  // before this run so the client can safely retry with the same user message.
  const persistable =
    stopReason === "done" ||
    stopReason === "max_turns" ||
    stopReason === "length" ||
    stopReason === "content_filter";
  if (persistable && options.sessionId && config.sessionStore) {
    await config.sessionStore.set(options.sessionId, messages);
  }

  const result: Result = {
    text: lastAssistantText(messages),
    messages: messages.slice(sessionCount),
    stopReason,
    usage,
    generationIds,
    error,
  };

  const runEndedAt = Date.now();
  emit({
    type: "agent:end",
    runId,
    result,
    startedAt: runStartedAt,
    endedAt: runEndedAt,
    elapsedMs: runEndedAt - runStartedAt,
    display: resolveAgentDisplay(config.display, input, (d) => pickAgentEndHook(d, result)),
  });
}
