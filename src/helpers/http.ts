/**
 * High-level HTTP wrappers that compose {@link pipeEventsToNodeResponse} /
 * {@link eventsToWebResponse} with `agent.run`, AbortController wiring,
 * and `SessionBusyError` → 409 mapping. Suitable for the common case of
 * "POST /chat → stream events back". Drop down to the lower-level adapters
 * when you need custom logic between request receipt and stream start.
 */
import type { Message } from "../types/index.js";
import { Agent, type AgentRunOptions } from "../agent/index.js";
import { SessionBusyError } from "../session/index.js";
import {
  pipeEventsToNodeResponse,
  eventsToWebResponse,
  type NodeResponseLike,
} from "./responseAdapters.js";

/**
 * Options shared by the Node and Web variants of the high-level wrapper.
 */
export interface HandleAgentRunOptions {
  /** Session id forwarded to `agent.run` and (when echoed) to the response header. */
  sessionId?: string;
  /** Whether to echo `sessionId` back as a response header. Defaults to `true`. */
  echoSessionHeader?: boolean;
  /** Header name used when echoing the session id. Defaults to `"X-Session-Id"`. */
  sessionHeaderName?: string;
  /** Extra response headers merged on top of the NDJSON defaults. */
  headers?: Record<string, string>;
  /**
   * Per-run options forwarded to `agent.run`. `sessionId` and `signal` are
   * managed by the wrapper and excluded from this shape.
   */
  runOptions?: Omit<AgentRunOptions, "sessionId" | "signal">;
}

/**
 * Node-only options: adds a hook for {@link SessionBusyError}.
 */
export interface HandleAgentRunNodeOptions extends HandleAgentRunOptions {
  /**
   * Called instead of the default 409 response when `agent.run` throws
   * {@link SessionBusyError}. The handler is responsible for writing a
   * complete response (status, headers, body, end).
   */
  onSessionBusy?: (err: SessionBusyError, res: NodeResponseLike) => void;
}

/**
 * Stream an {@link Agent} run to a Node response. Creates an internal
 * AbortController, calls `agent.run(input, { sessionId, signal })`, and
 * delegates the body stream to {@link pipeEventsToNodeResponse}.
 *
 * On {@link SessionBusyError} (synchronously thrown by `agent.run`), the
 * default behavior writes a 409 JSON response. Provide
 * {@link HandleAgentRunNodeOptions.onSessionBusy} to override.
 *
 * @param agent The agent to run.
 * @param input The user prompt or message array.
 * @param res A Node response-shaped object satisfying {@link NodeResponseLike}.
 * @param options {@link HandleAgentRunNodeOptions}.
 * @returns A promise that resolves once the response has ended.
 *
 * @example
 * ```ts
 * import { handleAgentRun } from "./helpers";
 *
 * await handleAgentRun(agent, body.message, res, { sessionId: claimed });
 * ```
 */
export async function handleAgentRun(
  agent: Agent,
  input: string | Message[],
  res: NodeResponseLike,
  options: HandleAgentRunNodeOptions = {},
): Promise<void> {
  const sessionId = options.sessionId;
  const echoHeader = options.echoSessionHeader ?? true;
  const headerName = options.sessionHeaderName ?? "X-Session-Id";
  const sessionHeader: Record<string, string> =
    sessionId && echoHeader ? { [headerName]: sessionId } : {};

  const abort = new AbortController();
  let run: AsyncIterable<unknown>;
  try {
    run = agent.run(input, {
      sessionId,
      signal: abort.signal,
      ...(options.runOptions ?? {}),
    }) as AsyncIterable<unknown>;
  } catch (err) {
    if (err instanceof SessionBusyError) {
      if (options.onSessionBusy) {
        options.onSessionBusy(err, res);
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...sessionHeader,
        ...(options.headers ?? {}),
      };
      res.writeHead(409, headers);
      res.write(JSON.stringify({ error: "session busy", sessionId }));
      res.end();
      return;
    }
    throw err;
  }

  await pipeEventsToNodeResponse(
    run as AsyncIterable<import("../agent/events.js").AgentEvent>,
    res,
    {
      abort,
      headers: { ...sessionHeader, ...(options.headers ?? {}) },
    },
  );
}

/**
 * Stream an {@link Agent} run as a Web `Response` in NDJSON. Counterpart to
 * {@link handleAgentRun} for Cloudflare Workers, Deno, Bun, and any
 * `fetch`-style handler.
 *
 * On {@link SessionBusyError}, returns a 409 `Response` with
 * `Content-Type: application/json` and body `{ error, sessionId }`. Other
 * synchronous errors from `agent.run` propagate as a rejected promise.
 *
 * @param agent The agent to run.
 * @param input The user prompt or message array.
 * @param options {@link HandleAgentRunOptions}.
 * @returns A promise resolving to the `Response` to send back.
 *
 * @example
 * ```ts
 * export default {
 *   async fetch(req: Request): Promise<Response> {
 *     const { message, sessionId } = await req.json();
 *     return handleAgentRunWebResponse(agent, message, { sessionId });
 *   },
 * };
 * ```
 */
export async function handleAgentRunWebResponse(
  agent: Agent,
  input: string | Message[],
  options: HandleAgentRunOptions = {},
): Promise<Response> {
  const sessionId = options.sessionId;
  const echoHeader = options.echoSessionHeader ?? true;
  const headerName = options.sessionHeaderName ?? "X-Session-Id";
  const sessionHeader: Record<string, string> =
    sessionId && echoHeader ? { [headerName]: sessionId } : {};

  const abort = new AbortController();
  let run: AsyncIterable<unknown>;
  try {
    run = agent.run(input, {
      sessionId,
      signal: abort.signal,
      ...(options.runOptions ?? {}),
    }) as AsyncIterable<unknown>;
  } catch (err) {
    if (err instanceof SessionBusyError) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...sessionHeader,
        ...(options.headers ?? {}),
      };
      return new Response(
        JSON.stringify({ error: "session busy", sessionId }),
        { status: 409, headers },
      );
    }
    throw err;
  }

  return eventsToWebResponse(
    run as AsyncIterable<import("../agent/events.js").AgentEvent>,
    {
      abort,
      headers: { ...sessionHeader, ...(options.headers ?? {}) },
    },
  );
}
