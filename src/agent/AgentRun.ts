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
 */
export class AgentRun implements PromiseLike<Result>, AsyncIterable<AgentEvent> {
  private readonly buffer: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private iteratorAttached = false;
  private done = false;
  private error: unknown = undefined;

  private outerRunId: string | undefined;
  private resultValue: Result | undefined;
  private resultPromise: Promise<Result>;
  private resolveResult!: (r: Result) => void;
  private rejectResult!: (err: unknown) => void;

  /**
   * @param start Callback invoked immediately with an `emit` function that
   *   feeds events into this handle. Its returned promise completes the run.
   */
  constructor(start: (emit: EventEmit) => Promise<void>) {
    this.resultPromise = new Promise<Result>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Avoid unhandled-rejection warnings if nobody awaits result.
    this.resultPromise.catch(() => {});

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

  /** Promise for the final `Result`. Memoized; safe to await multiple times. */
  get result(): Promise<Result> {
    return this.resultPromise;
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.resultPromise.then(onfulfilled, onrejected);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iteratorAttached) {
      throw new Error("AgentRun iterator already attached; only one consumer supported");
    }
    this.iteratorAttached = true;

    const self = this;
    return {
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
      async return(): Promise<IteratorResult<AgentEvent>> {
        // Consumer bailed early. We don't cancel the underlying run — the
        // caller owns the signal for that.
        return { value: undefined as any, done: true };
      },
    };
  }
}
