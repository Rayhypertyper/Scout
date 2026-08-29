import { AsyncLocalStorage } from "node:async_hooks";

export class CrawlCancelledError extends Error {
  public constructor(message = "Crawl terminated by user.") {
    super(message);
    this.name = "CrawlCancelledError";
  }
}

export class CrawlDeadlineExceededError extends Error {
  public constructor(public readonly maxDurationMs: number) {
    super(`Crawl exceeded its ${Math.round(maxDurationMs / 60_000)}-minute wall-clock limit.`);
    this.name = "CrawlDeadlineExceededError";
  }
}

export class SourceStalledError extends Error {
  public constructor(
    public readonly sourceUrl: string,
    public readonly stallMs: number,
    message?: string,
  ) {
    super(message ?? `Source ${sourceUrl} exceeded its ${stallMs}ms wall-clock budget.`);
    this.name = "SourceStalledError";
  }
}

const sourceAbortStorage = new AsyncLocalStorage<AbortSignal>();

export function runWithSourceAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  return sourceAbortStorage.run(signal, fn);
}

export function currentSourceAbortSignal(): AbortSignal | undefined {
  return sourceAbortStorage.getStore();
}

export function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export function cancellationError(reason: unknown = undefined): CrawlCancelledError | CrawlDeadlineExceededError {
  if (reason instanceof CrawlCancelledError || reason instanceof CrawlDeadlineExceededError) return reason;
  return new CrawlCancelledError(
    reason instanceof Error && reason.message
      ? reason.message
      : "Crawl terminated by user.",
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof SourceStalledError || signal.reason instanceof CrawlDeadlineExceededError) throw signal.reason;
  throw cancellationError(signal.reason);
}

export function isSourceStalledError(error: unknown): error is SourceStalledError {
  return error instanceof SourceStalledError;
}

export function isCrawlDeadlineExceededError(error: unknown): error is CrawlDeadlineExceededError {
  return error instanceof CrawlDeadlineExceededError;
}
