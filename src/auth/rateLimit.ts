import { createHash } from "node:crypto";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export interface AuthRateLimitInput {
  key: string;
  limit: number;
  windowMs: number;
}

export interface AuthRateLimiterBackend {
  consume(input: AuthRateLimitInput): Promise<RateLimitResult>;
}

export class RateLimitConfigurationError extends Error {
  constructor(message = "Authentication rate limiting is not configured safely.") {
    super(message);
    this.name = "RateLimitConfigurationError";
  }
}

export class RateLimitBackendError extends Error {
  constructor(message = "The shared authentication rate limiter is unavailable.") {
    super(message);
    this.name = "RateLimitBackendError";
  }
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
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return {
        allowed: existing.count <= limit,
        retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1_000)),
      };
    }

    if (this.buckets.size >= this.maxBuckets) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
      if (this.buckets.size >= this.maxBuckets) {
        return { allowed: false, retryAfter: 1 };
      }
    }

    const bucket = { count: 1, resetAt: now + Math.max(1, windowMs) };
    this.buckets.set(key, bucket);
    return {
      allowed: limit >= 1,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    };
  }

  clear(): void {
    this.buckets.clear();
  }
}

export class InMemoryAuthRateLimiterBackend implements AuthRateLimiterBackend {
  private readonly limiter: AuthRateLimiter;

  constructor(now: () => number = Date.now, maxBuckets = 50_000) {
    this.limiter = new AuthRateLimiter(now, maxBuckets);
  }

  async consume(input: AuthRateLimitInput): Promise<RateLimitResult> {
    return this.limiter.consume(input.key, input.limit, input.windowMs);
  }

  clear(): void {
    this.limiter.clear();
  }
}

const MAX_SHARED_RESPONSE_BYTES = 4_096;
const DEFAULT_BACKEND_TIMEOUT_MS = 2_000;

function validateSharedEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new RateLimitConfigurationError("The shared authentication rate limiter endpoint is invalid.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new RateLimitConfigurationError("The shared authentication rate limiter endpoint must be an HTTPS URL without embedded credentials or a fragment.");
  }
  return endpoint;
}

function validateInput(input: AuthRateLimitInput): void {
  if (!input.key || input.key.length > 512 || !Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.windowMs) || input.windowMs < 1) {
    throw new RateLimitConfigurationError("The authentication rate limit parameters are invalid.");
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SHARED_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RateLimitBackendError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseSharedResult(value: unknown): RateLimitResult {
  if (!value || typeof value !== "object" || !("allowed" in value) || !("retryAfter" in value)) {
    throw new RateLimitBackendError();
  }
  const result = value as { allowed?: unknown; retryAfter?: unknown };
  if (typeof result.allowed !== "boolean" || typeof result.retryAfter !== "number" || !Number.isFinite(result.retryAfter) || result.retryAfter < 0) {
    throw new RateLimitBackendError();
  }
  return { allowed: result.allowed, retryAfter: Math.max(1, Math.ceil(result.retryAfter)) };
}

export class SharedAuthRateLimiterBackend implements AuthRateLimiterBackend {
  protected readonly endpoint: URL;
  protected readonly token: string;
  protected readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { endpoint: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.endpoint = validateSharedEndpoint(options.endpoint);
    if (!options.token.trim()) throw new RateLimitConfigurationError("The shared authentication rate limiter token is missing.");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new RateLimitConfigurationError("The shared authentication rate limiter timeout is invalid.");
    }
  }

  async consume(input: AuthRateLimitInput): Promise<RateLimitResult> {
    validateInput(input);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    } catch {
      throw new RateLimitBackendError();
    }
    if (response.redirected || response.status < 200 || response.status >= 300) throw new RateLimitBackendError();
    try {
      const body = await readBoundedBody(response);
      return parseSharedResult(JSON.parse(body) as unknown);
    } catch (error) {
      if (error instanceof RateLimitBackendError) throw error;
      throw new RateLimitBackendError();
    }
  }
}

const UPSTASH_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if count == 1 then",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  "  ttl = tonumber(ARGV[1])",
  "elseif ttl < 0 then",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  "  ttl = tonumber(ARGV[1])",
  "end",
  "return {count, ttl}",
].join("\n");

export class UpstashAuthRateLimiterBackend extends SharedAuthRateLimiterBackend {
  override async consume(input: AuthRateLimitInput): Promise<RateLimitResult> {
    validateInput(input);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["EVAL", UPSTASH_SCRIPT, "1", input.key, String(input.windowMs)]),
      });
    } catch {
      throw new RateLimitBackendError();
    }
    if (response.redirected || response.status < 200 || response.status >= 300) throw new RateLimitBackendError();
    try {
      const body = await readBoundedBody(response);
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || !("result" in parsed)) throw new RateLimitBackendError();
      const result = parsed.result;
      if (!Array.isArray(result) || result.length < 2) throw new RateLimitBackendError();
      const count = typeof result[0] === "number" ? result[0] : Number(result[0]);
      const ttl = typeof result[1] === "number" ? result[1] : Number(result[1]);
      if (!Number.isFinite(count) || count < 1 || !Number.isFinite(ttl) || ttl < 0) throw new RateLimitBackendError();
      return { allowed: count <= input.limit, retryAfter: Math.max(1, Math.ceil(ttl / 1_000)) };
    } catch (error) {
      if (error instanceof RateLimitBackendError) throw error;
      throw new RateLimitBackendError();
    }
  }
}

export function createAuthRateLimiter(backend: AuthRateLimiterBackend): AuthRateLimiterBackend {
  return {
    consume(input) {
      return backend.consume(input);
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

export function authRateLimitIdentifierKey(action: string, identifier: string): string {
  return `${action}:account:${digest(identifier.trim().toLowerCase())}`;
}

export function authRateLimitIpKey(action: string, ip: string): string {
  return `${action}:ip:${digest(ip.trim().toLowerCase())}`;
}

export function authRateLimitKey(action: string, ip: string, identifier = ""): string {
  return `${authRateLimitIpKey(action, ip)}:${digest(identifier.trim().toLowerCase())}`;
}

let backendForTests: AuthRateLimiterBackend | null = null;
const localBackend = new InMemoryAuthRateLimiterBackend();
const compatibilityLimiter = new AuthRateLimiter();

export function setAuthRateLimiterBackendForTests(backend: AuthRateLimiterBackend | null): void {
  backendForTests = backend;
}

function configuredBackend(): AuthRateLimiterBackend {
  if (backendForTests) return backendForTests;
  const production = process.env.NODE_ENV?.toLowerCase() === "production";
  const configuredBackendName = process.env.AUTH_RATE_LIMIT_BACKEND?.trim().toLowerCase();
  if (configuredBackendName === "upstash" || configuredBackendName === "shared") {
    const endpoint = process.env.AUTH_RATE_LIMIT_SHARED_URL?.trim();
    const token = process.env.AUTH_RATE_LIMIT_SHARED_TOKEN?.trim();
    if (!endpoint || !token) throw new RateLimitConfigurationError("The shared authentication rate limiter URL and token are required.");
    return configuredBackendName === "upstash"
      ? new UpstashAuthRateLimiterBackend({ endpoint, token })
      : new SharedAuthRateLimiterBackend({ endpoint, token });
  }
  if (production) {
    throw new RateLimitConfigurationError("Production authentication requires a shared rate limiter backend.");
  }
  if (configuredBackendName && configuredBackendName !== "memory") {
    throw new RateLimitConfigurationError("The configured authentication rate limiter backend is unknown.");
  }
  return localBackend;
}

export function consumeAuthRateLimitKeyAsync(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const backend = configuredBackend();
  return backend.consume({ key, limit, windowMs });
}

export async function consumeAuthRateLimitDimensions(
  action: string,
  ip: string,
  identifier: string,
  ipLimit: number,
  identifierLimit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const [ipResult, identifierResult] = await Promise.all([
    consumeAuthRateLimitKeyAsync(authRateLimitIpKey(action, ip), ipLimit, windowMs),
    consumeAuthRateLimitKeyAsync(authRateLimitIdentifierKey(action, identifier), identifierLimit, windowMs),
  ]);
  return {
    allowed: ipResult.allowed && identifierResult.allowed,
    retryAfter: Math.max(ipResult.retryAfter, identifierResult.retryAfter),
  };
}

/** Compatibility API for older local callers; auth routes use the shared backend above. */
export function consumeAuthRateLimit(
  action: string,
  ip: string,
  identifier: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  return compatibilityLimiter.consume(authRateLimitKey(action, ip, identifier), limit, windowMs);
}

export function resetAuthRateLimitsForTests(): void {
  compatibilityLimiter.clear();
  localBackend.clear();
}
