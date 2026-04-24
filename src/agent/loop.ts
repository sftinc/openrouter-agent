import type { Message, Result, Usage } from "../types/index.js";
import type {
  CompletionsResponse,
  LLMConfig,
  OpenRouterTool,
} from "../openrouter/index.js";
import type { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import type { AgentEvent, EventEmit } from "./events.js";

export interface RunLoopConfig {
  agentName: string;
  systemPrompt?: string;
  llm: LLMConfig;
  tools: Tool<any>[];
  maxTurns: number;
  sessionStore?: SessionStore;
  client: {
    complete: (
      request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
      signal?: AbortSignal
    ) => Promise<CompletionsResponse>;
  };
  parentRunId?: string;
  display?: {
    start?: (input: string | Message[]) => { title: string; content?: unknown };
    end?: (result: Result) => { title: string; content?: unknown };
  };
}

export interface RunLoopOptions {
  sessionId?: string;
  system?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  llm?: LLMConfig;
  parentRunId?: string;
}

function newRunId(): string {
  return `run-${Math.random().toString(36).slice(2, 10)}`;
}

function newToolUseId(fallback: string): string {
  return fallback || `tu-${Math.random().toString(36).slice(2, 10)}`;
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
    prompt_tokens_details: mergeSubUsage(a.prompt_tokens_details, b.prompt_tokens_details),
    completion_tokens_details: mergeSubUsage(a.completion_tokens_details, b.completion_tokens_details),
    server_tool_use: mergeServerToolUse(a.server_tool_use, b.server_tool_use),
  };
}

function mergeSubUsage<T extends Record<string, number | undefined>>(
  a: T | undefined,
  b: T | undefined
): T | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as T;
}

function mergeServerToolUse(
  a: Usage["server_tool_use"],
  b: Usage["server_tool_use"]
): Usage["server_tool_use"] {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as Usage["server_tool_use"];
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

function wireContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
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
  const llm: LLMConfig = {
    ...config.llm,
    ...(options.llm ?? {}),
  };

  emit({
    type: "agent:start",
    runId,
    parentRunId,
    agentName: config.agentName,
    display: safeDisplay(() => config.display?.start?.(input)),
  });

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
      const res = await config.client.complete(
        {
          ...llm,
          ...(opts?.llm ?? {}),
          messages: msgs,
          tools: opts?.tools,
        },
        signal
      );
      const choice = res.choices[0];
      return {
        content: choice?.message.content ?? null,
        usage: res.usage ?? zeroUsage(),
        tool_calls: choice?.message.tool_calls,
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

    let response: CompletionsResponse;
    try {
      response = await config.client.complete(
        { ...llm, messages: wireMessages(), tools: openrouterTools },
        signal
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
      emit({ type: "error", runId, error: { code: anyErr.code, message: error.message } });
      break;
    }

    generationIds.push(response.id);
    usage = addUsage(usage, response.usage);

    const choice = response.choices[0];
    if (!choice) {
      stopReason = "error";
      error = { message: "OpenRouter response had no choices" };
      emit({ type: "error", runId, error: { message: error.message } });
      break;
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    };
    messages.push(assistantMsg);
    emit({ type: "message", runId, message: assistantMsg });

    const fr = choice.finish_reason;
    if (fr === "stop") { stopReason = "done"; break; }
    if (fr === "length") { stopReason = "length"; break; }
    if (fr === "content_filter") { stopReason = "content_filter"; break; }
    if (fr === "error") {
      stopReason = "error";
      error = choice.error
        ? { code: choice.error.code, message: choice.error.message, metadata: choice.error.metadata }
        : { message: "Unknown error from provider" };
      emit({ type: "error", runId, error: { code: error.code, message: error.message } });
      break;
    }

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      stopReason = "done";
      break;
    }

    for (const toolCall of choice.message.tool_calls) {
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
          display: resolveToolDisplay(tool, parsedArgs, (d) => d.error?.(parsedArgs, err)),
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: ${err}`,
        });
      } else {
        const out = result.content;
        emit({
          type: "tool:end",
          runId,
          toolUseId,
          output: out,
          metadata: result.metadata,
          display: resolveToolDisplay(tool, parsedArgs, (d) => d.success?.(parsedArgs, out)),
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: wireContent(out),
        });
      }
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
    display: safeDisplay(() => config.display?.end?.(result)),
  });
}
