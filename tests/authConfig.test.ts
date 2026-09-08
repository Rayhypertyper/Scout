import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthConfigurationError, readAuthConfig } from "../src/auth/config.js";

const ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "AUTH_SITE_URL",
  "AUTH_ALLOW_INSECURE_HTTP",
  "AUTH_TRUST_PROXY",
  "AUTH_TRUST_PROXY_HOPS",
  "AUTH_TRUST_PROXY_ADDRESSES",
  "AUTH_RECOVERY_SECRET",
] as const;

const previousEnvironment = new Map<string, string | undefined>();

describe("authentication configuration", () => {
  beforeEach(() => {
    previousEnvironment.clear();
    for (const key of ENVIRONMENT_KEYS) previousEnvironment.set(key, process.env[key]);
    process.env.NODE_ENV = "test";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    delete process.env.SUPABASE_ANON_KEY;
    process.env.AUTH_SITE_URL = "http://127.0.0.1:4173";
    process.env.AUTH_ALLOW_INSECURE_HTTP = "0";
    process.env.AUTH_TRUST_PROXY = "0";
    delete process.env.AUTH_TRUST_PROXY_HOPS;
    delete process.env.AUTH_TRUST_PROXY_ADDRESSES;
    delete process.env.AUTH_RECOVERY_SECRET;
  });

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("rejects privileged Supabase credentials in the publishable key slot", () => {
    for (const key of [
      "service_role_server_key",
      "sb_secret_server_key",
      `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`,
    ]) {
      process.env.SUPABASE_PUBLISHABLE_KEY = key;
      expect(() => readAuthConfig()).toThrow(AuthConfigurationError);
    }
  });

  it("requires a recovery secret and rejects insecure production overrides", () => {
    process.env.NODE_ENV = "PRODUCTION";
    delete process.env.AUTH_RECOVERY_SECRET;
    expect(() => readAuthConfig()).toThrowError(/AUTH_RECOVERY_SECRET/);

    process.env.AUTH_RECOVERY_SECRET = "a".repeat(32);
    process.env.AUTH_ALLOW_INSECURE_HTTP = "1";
    expect(() => readAuthConfig()).toThrowError(/AUTH_ALLOW_INSECURE_HTTP/);

    process.env.AUTH_ALLOW_INSECURE_HTTP = "0";
    expect(() => readAuthConfig()).toThrowError(/AUTH_SITE_URL/);
  });

  it("requires an explicit proxy address allowlist in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_RECOVERY_SECRET = "a".repeat(32);
    process.env.AUTH_SITE_URL = "https://app.example.com";
    process.env.AUTH_TRUST_PROXY = "1";
    process.env.AUTH_TRUST_PROXY_HOPS = "2";
    expect(() => readAuthConfig()).toThrowError(/AUTH_TRUST_PROXY_ADDRESSES/);

    process.env.AUTH_TRUST_PROXY_ADDRESSES = "127.0.0.1, [::1]";
    const config = readAuthConfig();
    expect(config.trustProxy).toBe(true);
    expect(config.trustedProxyHops).toBe(2);
    expect(config.trustedProxyAddresses).toEqual(["127.0.0.1", "[::1]"]);
    expect(config.secureCookies).toBe(true);
  });

  it("keeps proxy and recovery settings bounded in development", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    process.env.AUTH_TRUST_PROXY_HOPS = "1";
    process.env.AUTH_TRUST_PROXY_ADDRESSES = "not-an-ip";
    expect(() => readAuthConfig()).toThrowError(/AUTH_TRUST_PROXY_ADDRESSES/);

    process.env.AUTH_TRUST_PROXY_ADDRESSES = "127.0.0.1";
    process.env.AUTH_RECOVERY_SECRET = "short";
    expect(() => readAuthConfig()).toThrowError(/AUTH_RECOVERY_SECRET/);

    process.env.AUTH_RECOVERY_SECRET = "a".repeat(32);
    const config = readAuthConfig();
    expect(config.recoverySecret).toBe("a".repeat(32));
  });
});
