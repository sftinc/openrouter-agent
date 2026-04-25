import type { Message, Result, Usage } from "../types/index.js";
import type {
  CompletionChunk,
  LLMConfig,
  OpenRouterTool,
  ToolCallDelta,
} from "../openrouter/index.js";
import type { ToolCall } from "../types/index.js";
import type { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import type { AgentDisplayHooks, AgentEvent, EventDisplay, EventEmit } from "./events.js";
import { generateId, mergeNumericRecords, buildToolResultMessage, buildToolErrorMessage } from "../lib/index.js";

const FINISH_REASON_TO_STOP: Record<string, Result["stopReason"]> = {
  stop: "done",
  length: "length",
  content_filter: "content_filter",
};

export interface RunLoopConfig {
  agentName: string;
  systemPrompt?: string;
  client: LLMConfig;
  tools: Tool<any>[];
  maxTurns: number;
  sessionStore?: SessionStore;
  openrouter: {
    completeStream: (
      request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
      signal?: AbortSignal
    ) => AsyncIterable<CompletionChunk>;
  };
  parentRunId?: string;
  display?: AgentDisplayHooks;
}

export interface RunLoopOptions {
  sessionId?: string;
  system?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  client?: LLMConfig;
  parentRunId?: string;
}

function newRunId(): string {
  return generateId("run-");
}

function newToolUseId(fallback: string): string {
  return fallback || generateId("tu-");
}

function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

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
    emit({
      type: "tool:end",
      runId,
      toolUseId,
      error: err,
      metadata: result.metadata,
      display: resolveToolDisplay(tool, parsedArgs, (d) => d.error?.(parsedArgs, err, result.metadata)),
    });
    return buildToolErrorMessage(toolCall.id, err);
  }

  const out = result.content;
  emit({
    type: "tool:end",
    runId,
    toolUseId,
    output: out,
    metadata: result.metadata,
    display: resolveToolDisplay(tool, parsedArgs, (d) => d.success?.(parsedArgs, out, result.metadata)),
  });
  return buildToolResultMessage(toolCall.id, out);
}

function resolveInitialMessages(
  input: string | Message[],
  systemOverride: string | undefined,
  systemFromConfig: string | undefined,
  sessionMessages: Message[] | null
): { system: string | undefined; messages: Message[] } {
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

  if (sessionMessages) {
    for (const m of sessionMessages) {
      if (m.role !== "system") messages.push(m);
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

  return { system: systemContent, messages };
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

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

export async function runLoop(
  config: RunLoopConfig,
  input: string | Message[],
  options: RunLoopOptions,
  emit: EventEmit
): Promise<void> {
  const runId = newRunId();
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
    display: resolveAgentDisplay(config.display, input, (d) => d.start?.(input)),
  });

  const emitError = (code: number | undefined, message: string): void => {
    emit({ type: "error", runId, error: code !== undefined ? { code, message } : { message } });
  };

  const sessionMessages =
    options.sessionId && config.sessionStore
      ? await config.sessionStore.get(options.sessionId)
      : null;
  const { system: systemContent, messages } = resolveInitialMessages(
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

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    let contentBuf = "";
    const toolCallBuf = new Map<number, ToolCallDelta>();
    let finishReason: string | null = null;
    let turnError: { code?: number; message: string; metadata?: Record<string, unknown> } | undefined;
    let generationId: string | null = null;
    let turnUsage: Usage | undefined;

    try {
      for await (const chunk of config.openrouter.completeStream(
        { ...overrides, messages: wireMessages(), tools: openrouterTools },
        signal
      )) {
        if (!generationId && chunk.id) generationId = chunk.id;
        if (chunk.usage) turnUsage = chunk.usage;

        const sc = chunk.choices[0];
        if (!sc) continue;

        if (typeof sc.delta.content === "string" && sc.delta.content.length > 0) {
          contentBuf += sc.delta.content;
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
    messages,
    stopReason,
    usage,
    generationIds,
    error,
  };

  emit({
    type: "agent:end",
    runId,
    result,
    display: resolveAgentDisplay(config.display, input, (d) => pickAgentEndHook(d, result)),
  });
}
