import type { Profiler } from "../observability/profiler.js";
import { performance } from "node:perf_hooks";

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
    return Promise.reject(reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const reason = signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
      reject(reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  public constructor(private readonly limit: number) {}

  public async use<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
      throw reason;
    }
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: {
        resolve: () => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, ...(signal ? { signal } : {}) };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        const reason = signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
        reject(reason);
      };
      if (signal) waiter.onAbort = onAbort;
      this.waiting.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const waiter = this.waiting.shift();
    if (!waiter) return;
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    waiter.resolve();
  }
}

/**
 * A small bounded async queue used by crawl stages. `push` waits while the
 * queue is full, `pop` waits while it is empty, and `close` wakes all waiters
 * once producers have finished. Cancellation rejects pending operations and
 * drops buffered values so a failed crawl cannot leave worker promises stuck.
 */
export class BoundedAsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly producers: Array<{ value: T; resolve: () => void; reject: (error: unknown) => void }> = [];
  private readonly consumers: Array<{ resolve: (value: T | undefined) => void; reject: (error: unknown) => void }> = [];
  private closed = false;
  private cancellation: unknown = null;
  private readonly cancellationSignal: AbortSignal | undefined;
  private readonly onSignalAbort: (() => void) | undefined;

  private cancellationError(): Error {
    if (this.cancellation instanceof Error) return this.cancellation;
    return new Error(typeof this.cancellation === "string" ? this.cancellation : "Queue cancelled.");
  }

  public constructor(private readonly capacity = 128, private readonly profiler?: Profiler, cancellationSignal?: AbortSignal) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("BoundedAsyncQueue capacity must be a positive integer.");
    this.cancellationSignal = cancellationSignal;
    if (cancellationSignal) {
      this.onSignalAbort = () => this.cancel(cancellationSignal.reason);
      cancellationSignal.addEventListener("abort", this.onSignalAbort, { once: true });
      if (cancellationSignal.aborted) this.onSignalAbort();
    }
  }

  public get size(): number { return this.values.length; }
  public get isClosed(): boolean { return this.closed; }

  /** Non-blocking admission used by producer workers to avoid producer-only
   * deadlocks when a fan-out page fills the bounded queue. */
  public tryPush(value: T): boolean {
    if (this.cancellation !== null || this.closed) return false;
    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve(value);
      return true;
    }
    if (this.values.length >= this.capacity) return false;
    this.values.push(value);
    return true;
  }

  public async push(value: T): Promise<void> {
    if (this.cancellation !== null) throw this.cancellationError();
    if (this.closed) throw new Error("Cannot push to a closed queue.");
    if (this.tryPush(value)) return;
    const startedAt = performance.now();
    await new Promise<void>((resolve, reject) => this.producers.push({ value, resolve, reject }));
    this.profiler?.recordSpan("queue_wait", performance.now() - startedAt);
  }

  public async pop(): Promise<T | undefined> {
    if (this.cancellation !== null) throw this.cancellationError();
    const value = this.values.shift();
    if (value !== undefined) {
      this.promoteProducer();
      return value;
    }
    if (this.closed) return undefined;
    const startedAt = performance.now();
    const result = await new Promise<T | undefined>((resolve, reject) => this.consumers.push({ resolve, reject }));
    this.profiler?.recordSpan("queue_wait", performance.now() - startedAt);
    return result;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeCancellationListener();
    while (this.consumers.length > 0) this.consumers.shift()?.resolve(undefined);
    while (this.producers.length > 0) this.producers.shift()?.reject(new Error("Queue closed while a producer was waiting."));
  }

  public cancel(error: unknown = new Error("Queue cancelled.")): void {
    if (this.cancellation !== null) return;
    this.cancellation = error;
    this.closed = true;
    this.removeCancellationListener();
    this.values.length = 0;
    const normalized = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Queue cancelled.");
    while (this.consumers.length > 0) this.consumers.shift()?.reject(normalized);
    while (this.producers.length > 0) this.producers.shift()?.reject(normalized);
  }

  public async drain(): Promise<T[]> {
    const drained = [...this.values];
    this.values.length = 0;
    while (this.values.length < this.capacity && this.producers.length > 0) this.promoteProducer();
    return drained;
  }

  private promoteProducer(): void {
    if (this.values.length >= this.capacity) return;
    const producer = this.producers.shift();
    if (!producer) return;
    const consumer = this.consumers.shift();
    if (consumer) consumer.resolve(producer.value);
    else this.values.push(producer.value);
    producer.resolve();
  }

  private removeCancellationListener(): void {
    if (this.cancellationSignal && this.onSignalAbort) {
      this.cancellationSignal.removeEventListener("abort", this.onSignalAbort);
    }
  }
}

/** Alias used by pipeline callers that prefer the shorter name. */
export { BoundedAsyncQueue as AsyncQueue };
