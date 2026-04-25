/**
 * Response adapters that stream {@link AgentEvent}s as NDJSON over HTTP.
 *
 * Two adapters share the same options shape: {@link pipeEventsToNodeResponse}
 * for Node `http.ServerResponse` (structurally typed; no `node:http`
 * import), and {@link eventsToWebResponse} for Web `Response` (Workers,
 * Deno, Bun, fetch-style handlers). Both delegate body production to
 * {@link serializeEventsAsNDJSON} from `./ndjson.js`.
 */
import type { AgentEvent } from "../agent/events.js";
import { serializeEventsAsNDJSON } from "./ndjson.js";

/**
 * Structural type compatible with Node's `http.ServerResponse`. Defined
 * inline so this module does not import `node:http` (which would break
 * browser/Workers consumers).
 */
export interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  on(event: "close", listener: () => void): unknown;
  readonly writableEnded: boolean;
}

/**
 * Shared options for both response adapters.
 */
export interface ResponseAdapterOptions {
  /**
   * Optional controller. If provided, the adapter calls `abort.abort()` when
   * the underlying transport closes/cancels before iteration completes.
   * Caller is responsible for passing `abort.signal` into `agent.run(...)`.
   */
  abort?: AbortController;
  /**
   * Headers merged on top of the NDJSON defaults
   * (`Content-Type: application/x-ndjson`, `Cache-Control: no-cache`,
   * `X-Accel-Buffering: no`). Caller's values win on key collisions.
   */
  headers?: Record<string, string>;
  /** HTTP status. Defaults to `200`. */
  status?: number;
}

/** Sentinel value returned by {@link abortPromise} when the signal fires. */
const ABORTED = Symbol("aborted");

/**
 * Returns a promise that resolves to {@link ABORTED} when `signal` fires, or
 * never resolves if the signal is never aborted. Used to race the NDJSON
 * iteration against an abort signal so client disconnect stops the loop
 * without waiting for the next event.
 */
function abortPromise(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<typeof ABORTED>((resolve) => {
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

const NDJSON_DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

/**
 * Stream an {@link AgentEvent} source to a Node `http.ServerResponse`-shaped
 * object as NDJSON. Sets default headers, writes one line per event, and
 * calls `res.end()` in a `finally`. If `options.abort` is provided, hooks
 * `res.on('close')` so a client disconnect aborts the run.
 *
 * @example
 * ```ts
 * import { pipeEventsToNodeResponse } from "./helpers";
 * import http from "node:http";
 *
 * http.createServer(async (req, res) => {
 *   const abort = new AbortController();
 *   const stream = agent.runStream("hello", { signal: abort.signal });
 *   await pipeEventsToNodeResponse(stream, res, { abort });
 * }).listen(3000);
 * ```
 *
 * @param source Any `AsyncIterable<AgentEvent>` (e.g. an `AgentRun`).
 * @param res A Node response-shaped object satisfying {@link NodeResponseLike}.
 * @param options {@link ResponseAdapterOptions}.
 * @returns A promise that resolves when the response has ended.
 */
export async function pipeEventsToNodeResponse(
  source: AsyncIterable<AgentEvent>,
  res: NodeResponseLike,
  options: ResponseAdapterOptions = {},
): Promise<void> {
  const headers = { ...NDJSON_DEFAULT_HEADERS, ...(options.headers ?? {}) };
  res.writeHead(options.status ?? 200, headers);
  const abort = options.abort;
  if (abort) {
    res.on("close", () => {
      if (!res.writableEnded && !abort.signal.aborted) abort.abort();
    });
  }
  try {
    const iter = serializeEventsAsNDJSON(source)[Symbol.asyncIterator]();
    while (true) {
      const next = iter.next();
      const result = abort
        ? await Promise.race([next, abortPromise(abort.signal)])
        : await next;
      if (result === ABORTED || result.done) break;
      res.write(result.value);
    }
  } finally {
    res.end();
  }
}
