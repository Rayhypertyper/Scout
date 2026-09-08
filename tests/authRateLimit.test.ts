import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { requestIp } from "../src/auth/http.js";
import type { AuthConfig } from "../src/auth/types.js";
import {
  AuthRateLimiter,
  InMemoryAuthRateLimiterBackend,
  RateLimitBackendError,
  RateLimitConfigurationError,
  SharedAuthRateLimiterBackend,
  UpstashAuthRateLimiterBackend,
  consumeAuthRateLimitKeyAsync,
  consumeAuthRateLimitDimensions,
  createAuthRateLimiter,
  authRateLimitIdentifierKey,
  authRateLimitIpKey,
  setAuthRateLimiterBackendForTests,
} from "../src/auth/rateLimit.js";

function request(remoteAddress: string, forwarded?: string): IncomingMessage {
  return {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("authentication rate limiting", () => {
  afterEach(() => setAuthRateLimiterBackendForTests(null));

  it("keeps account buckets independent of rotating client addresses while retaining aggregate IP buckets", () => {
    const accountKey = authRateLimitIdentifierKey("login", "Student@Example.com");
    expect(accountKey).toBe(authRateLimitIdentifierKey("login", " student@example.com "));
    expect(accountKey).not.toContain("student@example.com");
    expect(accountKey).toBe(authRateLimitIdentifierKey("login", "student@example.com"));
    expect(authRateLimitIpKey("login", "203.0.113.10")).not.toContain("203.0.113.10");
    expect(authRateLimitIpKey("login", "203.0.113.10")).not.toBe(authRateLimitIpKey("login", "203.0.113.11"));
  });

  it("shares atomic counters across independent limiter callers and expires them", async () => {
    let now = 1_000;
    const backend = new InMemoryAuthRateLimiterBackend(() => now);
    const first = createAuthRateLimiter(backend);
    const second = createAuthRateLimiter(backend);
    const results = await Promise.all([
      first.consume({ key: "shared-key", limit: 5, windowMs: 100 }),
      second.consume({ key: "shared-key", limit: 5, windowMs: 100 }),
      first.consume({ key: "shared-key", limit: 5, windowMs: 100 }),
      second.consume({ key: "shared-key", limit: 5, windowMs: 100 }),
      first.consume({ key: "shared-key", limit: 5, windowMs: 100 }),
      second.consume({ key: "shared-key", limit: 5, windowMs: 100 }),
    ]);
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(5);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(1);

    now += 101;
    await expect(first.consume({ key: "shared-key", limit: 1, windowMs: 100 })).resolves.toMatchObject({ allowed: true });
  });

  it("keeps concurrent local increments bounded without evicting active buckets", async () => {
    const limiter = new AuthRateLimiter(() => 1_000, 1);
    expect(limiter.consume("first", 1, 10_000).allowed).toBe(true);
    expect(limiter.consume("second", 1, 10_000)).toMatchObject({ allowed: false });
    const backend = new InMemoryAuthRateLimiterBackend();
    const results = await Promise.all(Array.from({ length: 20 }, () => backend.consume({ key: "burst", limit: 5, windowMs: 60_000 })));
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(5);
  });

  it("fails closed when the configured shared backend is unavailable", async () => {
    setAuthRateLimiterBackendForTests({
      async consume() {
        throw new RateLimitBackendError();
      },
    });
    await expect(consumeAuthRateLimitDimensions("login", "203.0.113.10", "student@example.com", 50, 10, 60_000))
      .rejects.toBeInstanceOf(RateLimitBackendError);
  });

  it("uses one atomic Upstash EVAL request and never sends raw identifiers", async () => {
    const counts = new Map<string, number>();
    const calls: Array<{ body: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      calls.push({ body, authorization });
      const command = JSON.parse(body) as string[];
      const key = command[3] ?? "";
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return new Response(JSON.stringify({ result: [count, 60_000] }), { status: 200 });
    };
    const backend = new UpstashAuthRateLimiterBackend({
      endpoint: "https://example.upstash.io",
      token: "server-token",
      fetchImpl,
    });
    const result = await backend.consume({ key: authRateLimitIdentifierKey("login", "student@example.com"), limit: 1, windowMs: 60_000 });
    expect(result).toEqual({ allowed: true, retryAfter: 60 });
    expect(calls[0]?.authorization).toBe("Bearer server-token");
    expect(calls[0]?.body).toContain('"EVAL"');
    expect(calls[0]?.body).toContain("if ttl < 0 then");
    expect(calls[0]?.body).not.toContain("student@example.com");
  });

  it("rejects unsafe shared endpoints and redirected backend responses", async () => {
    expect(() => new SharedAuthRateLimiterBackend({ endpoint: "http://public.example", token: "server-token" }))
      .toThrow(RateLimitConfigurationError);
    expect(() => new SharedAuthRateLimiterBackend({ endpoint: "https://user:pass@example.com", token: "server-token" }))
      .toThrow(RateLimitConfigurationError);
    expect(() => new UpstashAuthRateLimiterBackend({ endpoint: "https://example.upstash.io#fragment", token: "server-token" }))
      .toThrow(RateLimitConfigurationError);

    const redirected = new Response(JSON.stringify({ allowed: true, retryAfter: 60 }), { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    const backend = new SharedAuthRateLimiterBackend({
      endpoint: "https://ratelimit.example",
      token: "server-token",
      fetchImpl: async () => redirected,
    });
    await expect(backend.consume({ key: "key", limit: 1, windowMs: 60_000 }))
      .rejects.toBeInstanceOf(RateLimitBackendError);
  });

  it("does not fall back to memory when production shared limiting is unset", () => {
    const keys = ["NODE_ENV", "AUTH_RATE_LIMIT_BACKEND", "AUTH_RATE_LIMIT_SHARED_URL", "AUTH_RATE_LIMIT_SHARED_TOKEN"] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.NODE_ENV = "production";
      process.env.AUTH_RATE_LIMIT_BACKEND = "memory";
      delete process.env.AUTH_RATE_LIMIT_SHARED_URL;
      delete process.env.AUTH_RATE_LIMIT_SHARED_TOKEN;
      setAuthRateLimiterBackendForTests(null);
      expect(() => consumeAuthRateLimitKeyAsync("auth:test", 1, 60_000)).toThrow(RateLimitConfigurationError);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      setAuthRateLimiterBackendForTests(null);
    }
  });

  it("only trusts a well formed forwarded chain from an allowlisted proxy", () => {
    const config: AuthConfig = {
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
      siteUrl: new URL("https://example.test"),
      secureCookies: true,
      trustProxy: true,
      trustedProxyHops: 2,
      trustedProxyAddresses: ["127.0.0.1"],
    };
    expect(requestIp(request("127.0.0.1", "203.0.113.9, 10.0.0.2"), config)).toBe("203.0.113.9");
    expect(requestIp(request("127.0.0.1", "not-an-ip, 10.0.0.2"), config)).toBe("127.0.0.1");
    expect(requestIp(request("127.0.0.1", "10.0.0.2"), config)).toBe("127.0.0.1");
    expect(requestIp(request("192.0.2.5", "203.0.113.9"), { ...config, trustedProxyHops: 1 })).toBe("192.0.2.5");
    expect(requestIp(request("127.0.0.1", "::ffff:203.0.113.9"), { ...config, trustedProxyHops: 1 })).toBe("203.0.113.9");
  });
});
