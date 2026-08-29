import type { AuthConfig } from "./types.js";

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
  const allowInsecureRemote = process.env.AUTH_ALLOW_INSECURE_HTTP === "1";
  if (parsedSupabaseUrl.protocol !== "https:" && !isLocalHostname(parsedSupabaseUrl.hostname) && !allowInsecureRemote) {
    throw new AuthConfigurationError(["SUPABASE_URL (HTTPS is required outside local development)"]);
  }
  if (siteUrl.protocol !== "https:" && !isLocalHostname(siteUrl.hostname) && !allowInsecureRemote) {
    throw new AuthConfigurationError(["AUTH_SITE_URL (HTTPS is required outside local development)"]);
  }

  return {
    supabaseUrl: parsedSupabaseUrl.origin,
    publishableKey,
    siteUrl: new URL(siteUrl.origin),
    secureCookies: siteUrl.protocol === "https:",
    trustProxy: process.env.AUTH_TRUST_PROXY === "1",
  };
}
