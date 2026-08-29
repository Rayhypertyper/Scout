import { createHash } from "node:crypto";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export class AuthRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;

  constructor(now: () => number = Date.now, maxBuckets = 5_000) {
    this.now = now;
    this.maxBuckets = Math.max(1, Math.floor(maxBuckets));
  }

  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.now();
    const existing = this.buckets.get(key);
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;
    if (!existing || existing.resetAt <= now) this.ensureCapacity(now, existing ? key : undefined);
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxBuckets) this.prune(now);
    return {
      allowed: bucket.count <= limit,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    };
  }

  clear(): void {
    this.buckets.clear();
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (typeof oldest !== "string") break;
      this.buckets.delete(oldest);
    }
  }

  private ensureCapacity(now: number, replacingKey?: string): void {
    if (this.buckets.size < this.maxBuckets) return;
    this.prune(now);
    if (this.buckets.size < this.maxBuckets) return;
    // A flood of unique identifiers must not grow this process without bound.
    // Evict the oldest bucket; the next request from that identifier starts a
    // fresh window, while all other active buckets remain protected.
    const oldest = this.buckets.keys().next().value;
    if (typeof oldest === "string" && oldest !== replacingKey) this.buckets.delete(oldest);
  }
}

const authRateLimiter = new AuthRateLimiter();

export function authRateLimitKey(action: string, ip: string, identifier = ""): string {
  const digest = createHash("sha256").update(identifier.trim().toLowerCase()).digest("base64url").slice(0, 22);
  return `${action}:${ip}:${digest}`;
}

export function consumeAuthRateLimit(
  action: string,
  ip: string,
  identifier: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  return authRateLimiter.consume(authRateLimitKey(action, ip, identifier), limit, windowMs);
}

export function resetAuthRateLimitsForTests(): void {
  authRateLimiter.clear();
}
