import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CookieOptions } from "@supabase/ssr";

import type { AuthConfig, AuthResponseState } from "./types.js";

const MAX_AUTH_BODY_BYTES = 16 * 1024;
const CSRF_COOKIE = "rr-csrf";
const RECOVERY_COOKIE = "rr-recovery";

export class AuthHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, options: { field?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = "AuthHttpError";
    this.status = status;
    this.code = code;
    if (options.field !== undefined) this.field = options.field;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

export function parseCookies(request: IncomingMessage): Map<string, string> {
  const parsed = new Map<string, string>();
  const header = request.headers.cookie;
  if (!header) return parsed;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      parsed.set(name, decodeURIComponent(rawValue));
    } catch {
      parsed.set(name, rawValue);
    }
  }
  return parsed;
}

function sameSiteValue(value: CookieOptions["sameSite"]): string | null {
  if (value === true) return "Strict";
  if (typeof value !== "string") return null;
  return `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error("Invalid cookie name");
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  const sameSite = sameSiteValue(options.sameSite);
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (options.priority) parts.push(`Priority=${`${options.priority}`.replace(/^./, (letter) => letter.toUpperCase())}`);
  if (options.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

export function createAuthResponseState(): AuthResponseState {
  return { cookies: [], headers: {} };
}

export function createSupabaseCookieMethods(
  request: IncomingMessage,
  config: AuthConfig,
  state: AuthResponseState,
): {
  encode: "tokens-only";
  getAll(): Array<{ name: string; value: string }>;
  setAll(
    cookies: Array<{ name: string; value: string; options: CookieOptions }>,
    headers: Record<string, string>,
  ): void;
} {
  const values = parseCookies(request);
  return {
    encode: "tokens-only",
    getAll() {
      return [...values.entries()].map(([name, value]) => ({ name, value }));
    },
    setAll(cookies, headers) {
      for (const [name, value] of Object.entries(headers)) state.headers[name] = value;
      for (const cookie of cookies) {
        values.set(cookie.name, cookie.value);
        state.cookies.push(serializeCookie(cookie.name, cookie.value, {
          ...cookie.options,
          path: cookie.options.path ?? "/",
          httpOnly: true,
          secure: config.secureCookies,
          sameSite: cookie.options.sameSite ?? "lax",
        }));
      }
    },
  };
}

function authSecurityHeaders(config: AuthConfig): Record<string, string> {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    ...(config.secureCookies ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Security-Policy": contentSecurityPolicy,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    Vary: "Cookie",
    ...(config.secureCookies ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

export function writeAuthResponse(
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  contentType: string,
  config: AuthConfig,
  state: AuthResponseState,
  extraHeaders: Record<string, string> = {},
  head = false,
): void {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const headers: Record<string, string | string[]> = {
    ...authSecurityHeaders(config),
    ...state.headers,
    ...extraHeaders,
    "Content-Type": contentType,
    "Content-Length": String(payload.byteLength),
  };
  if (state.cookies.length > 0) headers["Set-Cookie"] = state.cookies;
  response.writeHead(status, headers);
  if (head) response.end();
  else response.end(payload);
}

export function writeAuthJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  config: AuthConfig,
  state: AuthResponseState,
  extraHeaders: Record<string, string> = {},
  head = false,
): void {
  writeAuthResponse(
    response,
    status,
    JSON.stringify(payload),
    "application/json; charset=utf-8",
    config,
    state,
    extraHeaders,
    head,
  );
}

export function redirectAuthResponse(
  response: ServerResponse,
  location: string,
  config: AuthConfig,
  state: AuthResponseState,
): void {
  writeAuthResponse(response, 303, "", "text/plain; charset=utf-8", config, state, { Location: location });
}

export async function readAuthJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AuthHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send authentication requests as JSON.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const unknownChunk: unknown = chunk;
    const buffer = typeof unknownChunk === "string"
      ? Buffer.from(unknownChunk)
      : Buffer.isBuffer(unknownChunk)
        ? Buffer.from(unknownChunk)
        : Buffer.from(unknownChunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_AUTH_BODY_BYTES) throw new AuthHttpError(413, "REQUEST_TOO_LARGE", "The authentication request is too large.");
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthHttpError(400, "INVALID_JSON", "The authentication request could not be read. Try again.");
  }
}

export function safeReturnPath(value: unknown, fallback = "/account"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return fallback;
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || hasControlCharacter) return fallback;
  try {
    const parsed = new URL(value, "https://roleradar.invalid");
    if (parsed.origin !== "https://roleradar.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function requestIp(request: IncomingMessage, config: AuthConfig): string {
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim().slice(0, 128);
  }
  return request.socket.remoteAddress?.slice(0, 128) ?? "unknown";
}

export function assertSameOrigin(request: IncomingMessage, config: AuthConfig): void {
  const origin = request.headers.origin;
  if (origin && origin !== config.siteUrl.origin) {
    throw new AuthHttpError(403, "ORIGIN_MISMATCH", "This request did not come from Scout. Reload the page and try again.");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    throw new AuthHttpError(403, "ORIGIN_MISMATCH", "This request did not come from Scout. Reload the page and try again.");
  }
}

function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function validCsrfToken(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function ensureCsrfToken(request: IncomingMessage, config: AuthConfig, state: AuthResponseState): string {
  const existing = parseCookies(request).get(CSRF_COOKIE);
  if (validCsrfToken(existing)) return existing;
  const token = newCsrfToken();
  state.cookies.push(serializeCookie(CSRF_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60,
  }));
  return token;
}

export function assertCsrfToken(request: IncomingMessage): void {
  const cookie = parseCookies(request).get(CSRF_COOKIE);
  const header = request.headers["x-csrf-token"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (!validCsrfToken(cookie) || !validCsrfToken(headerValue)) {
    throw new AuthHttpError(403, "CSRF_INVALID", "Your form session expired. Reload the page and try again.");
  }
  const left = Buffer.from(cookie);
  const right = Buffer.from(headerValue);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new AuthHttpError(403, "CSRF_INVALID", "Your form session expired. Reload the page and try again.");
  }
}

export function hasRecoveryGrant(request: IncomingMessage): boolean {
  return parseCookies(request).get(RECOVERY_COOKIE) === "1";
}

export function setRecoveryGrant(config: AuthConfig, state: AuthResponseState): void {
  state.cookies.push(serializeCookie(RECOVERY_COOKIE, "1", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  }));
}

export function clearRecoveryGrant(config: AuthConfig, state: AuthResponseState): void {
  state.cookies.push(serializeCookie(RECOVERY_COOKIE, "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  }));
}
