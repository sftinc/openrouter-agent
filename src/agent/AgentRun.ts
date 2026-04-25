/**
 * `AgentRun` — the dual-purpose handle returned by {@link Agent.run}.
 *
 * Implements both `PromiseLike<Result>` (for callers that just want the
 * final {@link Result}) and `AsyncIterable<AgentEvent>` (for callers that
 * want to observe every event as the run progresses). The underlying run
 * starts eagerly when the constructor runs, so awaiting `result` without
 * iterating is fully supported and events are buffered until consumed.
 */
import type { Result } from "../types/index.js";
import type { AgentEvent, EventEmit } from "./events.js";

/**
 * Handle returned by `Agent.run`. Both awaitable (resolves to `Result`) and
 * async-iterable (yields every `AgentEvent` in order).
 *
 * - The underlying run is started eagerly by the constructor.
 * - `[Symbol.asyncIterator]()` may be called at most once.
 * - Events emitted before an iterator is attached are buffered; they flush
 *   on the first `next()` calls.
 * - `await run` and `await run.result` resolve to the same memoized Result.
 * - Loop errors reject both `result` and the iterator's `next()`.
 *
 * Note: subagent events bubble through `deps.emit` to the parent's stream,
 * so this handle filters its terminal `agent:end` strictly by the *outer*
 * `runId` recorded from its own `agent:start`.
 */
export class AgentRun implements PromiseLike<Result>, AsyncIterable<AgentEvent> {
  /** FIFO of events received before they have been pulled by an iterator consumer. */
  private readonly buffer: AgentEvent[] = [];
  /**
   * Pending resolver for an awaiting iterator `next()`. Set when the
   * iterator is blocked waiting for more events; called and cleared whenever
   * a new event arrives or the run terminates.
   */
  private resolveNext: (() => void) | null = null;
  /** True after `[Symbol.asyncIterator]()` has been invoked. Iteration is single-consumer. */
  private iteratorAttached = false;
  /** True once the start callback has settled (success or failure). */
  private done = false;
  /** Captured loop error if `start()` rejected; rethrown from the iterator's `next()`. */
  private error: unknown = undefined;

  /**
   * Run id of the *outer* agent, captured from the first `agent:start` we
   * see. Used to filter `agent:end` events so subagent terminal events
   * (which bubble through this stream) don't prematurely resolve the result.
   */
  private outerRunId: string | undefined;
  /** Memoized terminal {@link Result} extracted from the matching `agent:end` event. */
  private resultValue: Result | undefined;
  /** The promise returned by {@link AgentRun.result}. Memoized for repeated awaits. */
  private resultPromise: Promise<Result>;
  /** Resolver for {@link resultPromise}. Initialized inside the constructor's Promise executor. */
  private resolveResult!: (r: Result) => void;
  /** Rejecter for {@link resultPromise}. Initialized inside the constructor's Promise executor. */
  private rejectResult!: (err: unknown) => void;

  /**
   * Eagerly starts the run.
   *
   * @param start Callback invoked immediately with an `emit` function that
   *   feeds events into this handle. Its returned promise completes the run.
   *   On resolution, the captured `agent:end` result is delivered to
   *   `result`; if no matching `agent:end` was seen, `result` rejects with
   *   `"run finished without agent:end event"`. On rejection, the error is
   *   stored and rethrown from both `result` and the iterator's `next()`.
   */
  constructor(start: (emit: EventEmit) => Promise<void>) {
    this.resultPromise = new Promise<Result>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Avoid unhandled-rejection warnings if nobody awaits result.
    this.resultPromise.catch(() => {});

    /**
     * Internal sink passed to the `start` callback. Captures the outer run
     * id, snapshots the matching terminal `agent:end` result, buffers the
     * event for any attached iterator, and wakes a pending `next()` if one
     * is waiting.
     */
    const emit: EventEmit = (ev) => {
      if (this.done) return;
      if (ev.type === "agent:start" && this.outerRunId === undefined) {
        this.outerRunId = ev.runId;
      }
      if (
        ev.type === "agent:end" &&
        this.outerRunId !== undefined &&
        ev.runId === this.outerRunId &&
        this.resultValue === undefined
      ) {
        this.resultValue = ev.result;
      }
      this.buffer.push(ev);
      const r = this.resolveNext;
      this.resolveNext = null;
      r?.();
    };

    start(emit)
      .then(() => {
        this.done = true;
        if (this.resultValue !== undefined) {
          this.resolveResult(this.resultValue);
        } else {
          this.rejectResult(
            new Error("run finished without agent:end event")
          );
        }
        const r = this.resolveNext;
        this.resolveNext = null;
        r?.();
      })
      .catch((err) => {
        this.done = true;
        this.error = err;
        this.rejectResult(err);
        const r = this.resolveNext;
        this.resolveNext = null;
        r?.();
      });
  }

  /**
   * Promise for the final {@link Result}. Memoized; safe to await multiple
   * times. Rejects if the run errored or terminated without an
   * `agent:end` event.
   */
  get result(): Promise<Result> {
    return this.resultPromise;
  }

  /**
   * `PromiseLike` implementation so `await run` is equivalent to
   * `await run.result`. Delegates directly to the memoized result promise.
   *
   * @template TResult1 Type returned by the fulfillment handler.
   * @template TResult2 Type returned by the rejection handler.
   * @param onfulfilled Optional callback invoked with the resolved {@link Result}.
   * @param onrejected Optional callback invoked with the rejection reason.
   * @returns A `PromiseLike` resolving to whichever handler value applies.
   */
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.resultPromise.then(onfulfilled, onrejected);
  }

  /**
   * Returns an async iterator over every {@link AgentEvent} produced by the
   * run, in emission order. Buffered events drain first, then the iterator
   * blocks on subsequent emissions.
   *
   * Single-consumer: throws on the second invocation. The iterator's
   * `return()` is a no-op for the underlying run — the caller owns the
   * `AbortSignal` if cancellation is needed.
   *
   * @throws {Error} If called more than once on the same `AgentRun`.
   * @returns An `AsyncIterator<AgentEvent>` that completes when the run
   *   terminates (or rethrows the loop error if `start` rejected).
   */
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iteratorAttached) {
      throw new Error("AgentRun iterator already attached; only one consumer supported");
    }
    this.iteratorAttached = true;

    const self = this;
    return {
      /**
       * Advance the iterator. Drains buffered events first; otherwise waits
       * for the next emission or terminal signal.
       *
       * @returns The next event, or `{ done: true }` once the run has
       *   terminated and the buffer is empty.
       * @throws Re-throws any error captured from the run's start callback.
       */
      async next(): Promise<IteratorResult<AgentEvent>> {
        while (true) {
          if (self.buffer.length > 0) {
            return { value: self.buffer.shift()!, done: false };
          }
          if (self.done) {
            if (self.error) throw self.error;
            return { value: undefined as any, done: true };
          }
          await new Promise<void>((resolve) => {
            self.resolveNext = resolve;
          });
        }
      },
      /**
       * Called when the consumer bails early (e.g. `break` in a `for await`).
       * Marks the iterator as completed without cancelling the underlying
       * run; cancellation is the caller's responsibility via `AbortSignal`.
       */
      async return(): Promise<IteratorResult<AgentEvent>> {
        // Consumer bailed early. We don't cancel the underlying run — the
        // caller owns the signal for that.
        return { value: undefined as any, done: true };
      },
    };
  }
}
