import { sleep } from "../utils/async.js";
import { throwIfAborted } from "../domain/cancellation.js";

export class HostRateLimitTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostRateLimitTimeoutError";
  }
}

export class HostRateLimiter {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  public async wait(
    url: string,
    configuredDelayMs: number,
    robotsDelayMs: number | null,
    maxWaitMs = Number.POSITIVE_INFINITY,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const origin = new URL(url).origin;
    const previous = this.locks.get(origin) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(origin, previous.then(() => current));
    await previous;
    try {
      throwIfAborted(signal);
      const delay = Math.max(configuredDelayMs, robotsDelayMs ?? 0);
      const remaining = (this.nextAllowedAt.get(origin) ?? 0) - Date.now();
      if (delay > maxWaitMs || remaining > maxWaitMs) {
        throw new HostRateLimitTimeoutError(`Host rate-limit wait for ${origin} exceeded the ${maxWaitMs}ms page limit.`);
      }
      if (remaining > 0) await sleep(remaining, signal);
      throwIfAborted(signal);
      this.nextAllowedAt.set(origin, Date.now() + delay);
    } finally {
      release?.();
    }
  }
}
