import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import type { AuthConfig } from "./types.js";

const developmentRecoverySecret = randomBytes(32).toString("base64url");

export class AuthConfigurationError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Authentication is missing required configuration: ${missing.join(", ")}`);
    this.name = "AuthConfigurationError";
    this.missing = missing;
  }
}

function requiredEnvironmentValue(name: string, fallbackName?: string): string | null {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (!fallbackName) return null;
  return process.env[fallbackName]?.trim() || null;
}

function validHttpUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AuthConfigurationError([name]);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AuthConfigurationError([name]);
  }
  return parsed;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validatePublishableKey(value: string): void {
  const normalized = value.trim();
  if (/^sb_secret_/i.test(normalized) || /(?:^|[_-])service[_-]?role(?:[_-]|$)/i.test(normalized)) {
    throw new AuthConfigurationError(["SUPABASE_PUBLISHABLE_KEY"]);
  }
  const parts = normalized.split(".");
  if (parts.length === 3) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
      if (payload && typeof payload === "object" && "role" in payload) {
        const role = (payload as { role?: unknown }).role;
        if (typeof role === "string" && role !== "anon") {
          throw new AuthConfigurationError(["SUPABASE_PUBLISHABLE_KEY"]);
        }
      }
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw error;
      // Non-JWT values are supported for Supabase's sb_publishable_* format.
    }
  }
}

function parseTrustedProxyAddresses(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const addresses = value.split(",").map((address) => address.trim());
  if (addresses.some((address) => {
    const unwrapped = address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address;
    return !address || isIP(unwrapped) === 0;
  })) {
    throw new AuthConfigurationError(["AUTH_TRUST_PROXY_ADDRESSES"]);
  }
  return addresses;
}

function readTrustedProxyHops(value: string | undefined, production: boolean, trustProxy: boolean): number | undefined {
  if (!value?.trim()) {
    if (production && trustProxy) throw new AuthConfigurationError(["AUTH_TRUST_PROXY_HOPS"]);
    return trustProxy ? 1 : undefined;
  }
  if (!/^\d+$/.test(value.trim())) throw new AuthConfigurationError(["AUTH_TRUST_PROXY_HOPS"]);
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops < 1 || hops > 8) {
    throw new AuthConfigurationError(["AUTH_TRUST_PROXY_HOPS"]);
  }
  return hops;
}

export function readAuthConfig(): AuthConfig {
  const supabaseUrl = requiredEnvironmentValue("SUPABASE_URL");
  const publishableKey = requiredEnvironmentValue("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY");
  const siteUrlValue = requiredEnvironmentValue("AUTH_SITE_URL");
  const missing = [
    ...(supabaseUrl ? [] : ["SUPABASE_URL"]),
    ...(publishableKey ? [] : ["SUPABASE_PUBLISHABLE_KEY"]),
    ...(siteUrlValue ? [] : ["AUTH_SITE_URL"]),
  ];
  if (missing.length > 0 || !supabaseUrl || !publishableKey || !siteUrlValue) {
    throw new AuthConfigurationError(missing);
  }

  const parsedSupabaseUrl = validHttpUrl(supabaseUrl, "SUPABASE_URL");
  const siteUrl = validHttpUrl(siteUrlValue, "AUTH_SITE_URL");
  validatePublishableKey(publishableKey);
  const production = process.env.NODE_ENV?.toLowerCase() === "production";
  const configuredRecoverySecret = process.env.AUTH_RECOVERY_SECRET?.trim();
  if (configuredRecoverySecret && configuredRecoverySecret.length < 32) {
    throw new AuthConfigurationError(["AUTH_RECOVERY_SECRET"]);
  }
  if (production && !configuredRecoverySecret) {
    throw new AuthConfigurationError(["AUTH_RECOVERY_SECRET"]);
  }
  const allowInsecureRemote = process.env.AUTH_ALLOW_INSECURE_HTTP === "1";
  if (production && allowInsecureRemote) {
    throw new AuthConfigurationError(["AUTH_ALLOW_INSECURE_HTTP"]);
  }
  if (production && parsedSupabaseUrl.protocol !== "https:") {
    throw new AuthConfigurationError(["SUPABASE_URL (HTTPS is required in production)"]);
  }
  if (parsedSupabaseUrl.protocol !== "https:" && !isLocalHostname(parsedSupabaseUrl.hostname) && !allowInsecureRemote) {
    throw new AuthConfigurationError(["SUPABASE_URL (HTTPS is required outside local development)"]);
  }
  if (production && siteUrl.protocol !== "https:") {
    throw new AuthConfigurationError(["AUTH_SITE_URL (HTTPS is required in production)"]);
  }
  if (siteUrl.protocol !== "https:" && !isLocalHostname(siteUrl.hostname) && !allowInsecureRemote) {
    throw new AuthConfigurationError(["AUTH_SITE_URL (HTTPS is required outside local development)"]);
  }

  const trustProxy = process.env.AUTH_TRUST_PROXY === "1";
  const trustedProxyHops = readTrustedProxyHops(process.env.AUTH_TRUST_PROXY_HOPS, production, trustProxy);
  const trustedProxyAddresses = parseTrustedProxyAddresses(process.env.AUTH_TRUST_PROXY_ADDRESSES);
  if (production && trustProxy && trustedProxyAddresses.length === 0) {
    throw new AuthConfigurationError(["AUTH_TRUST_PROXY_ADDRESSES"]);
  }

  return {
    supabaseUrl: parsedSupabaseUrl.origin,
    publishableKey,
    siteUrl: new URL(siteUrl.origin),
    secureCookies: siteUrl.protocol === "https:",
    trustProxy,
    ...(trustedProxyHops === undefined ? {} : { trustedProxyHops }),
    ...(trustedProxyAddresses.length === 0 ? {} : { trustedProxyAddresses }),
    recoverySecret: configuredRecoverySecret ?? developmentRecoverySecret,
  };
}
