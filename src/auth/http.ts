import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CookieOptions } from "@supabase/ssr";

import type { AuthConfig, AuthResponseState } from "./types.js";

const MAX_AUTH_BODY_BYTES = 16 * 1024;
const CSRF_COOKIE = "rr-csrf";
const RECOVERY_COOKIE = "rr-recovery";
const RECOVERY_GRANT_SECONDS = 15 * 60;

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

function parseIpv6Groups(address: string): number[] | null {
  const doubleColon = address.indexOf("::");
  if (doubleColon !== -1 && address.indexOf("::", doubleColon + 2) !== -1) return null;
  const leftText = doubleColon === -1 ? address : address.slice(0, doubleColon);
  const rightText = doubleColon === -1 ? "" : address.slice(doubleColon + 2);
  const parseSide = (value: string): number[] | null => {
    if (!value) return [];
    const segments = value.split(":");
    const groups: number[] = [];
    for (const [index, segment] of segments.entries()) {
      if (segment.includes(".")) {
        if (index !== segments.length - 1) return null;
        const octets = segment.split(".");
        if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
        groups.push((Number(octets[0]) << 8) | Number(octets[1]), (Number(octets[2]) << 8) | Number(octets[3]));
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(segment)) return null;
        groups.push(Number.parseInt(segment, 16));
      }
    }
    return groups;
  };
  const left = parseSide(leftText);
  const right = parseSide(rightText);
  if (!left || !right) return null;
  if (doubleColon === -1) return left.length === 8 ? left : null;
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function canonicalIpAddress(value: string): string | null {
  const trimmed = value.trim();
  const address = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const version = isIP(address);
  if (version === 4) return address.split(".").map((part) => String(Number(part))).join(".");
  if (version !== 6) return null;
  const groups = parseIpv6Groups(address.toLowerCase());
  if (!groups) return null;
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >>> 8}.${groups[6]! & 0xff}.${groups[7]! >>> 8}.${groups[7]! & 0xff}`;
  }
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const formatted = groups.map((part) => part.toString(16));
  if (bestStart === -1) return formatted.join(":");
  const before = formatted.slice(0, bestStart).join(":");
  const after = formatted.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

export function requestIp(request: IncomingMessage, config: AuthConfig): string {
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  const canonicalRemote = canonicalIpAddress(remoteAddress);
  const allowedProxies = new Set((config.trustedProxyAddresses ?? [])
    .map(canonicalIpAddress)
    .filter((address): address is string => address !== null));
  if (config.trustProxy && canonicalRemote && allowedProxies.has(canonicalRemote)) {
    const forwarded = request.headers["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const chain = header?.split(",").map((address) => canonicalIpAddress(address));
    if (
      chain
      && chain.length === config.trustedProxyHops
      && chain.every((address): address is string => address !== null)
      && chain[0]
    ) {
      return chain[0];
    }
  }
  return canonicalRemote ?? remoteAddress.slice(0, 128);
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

function recoverySignature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function hasRecoveryGrant(request: IncomingMessage, config: AuthConfig, userId: string): boolean {
  const secret = config.recoverySecret;
  if (!secret || !userId || userId.length > 1_024) return false;
  const value = parseCookies(request).get(RECOVERY_COOKIE);
  if (!value || value.length > 2_048) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [encodedUserId, expiryText, encodedSignature] = parts;
  if (!encodedUserId || !expiryText || !encodedSignature || !/^\d+$/.test(expiryText)) return false;
  const expiresAt = Number(expiryText);
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > RECOVERY_GRANT_SECONDS) return false;
  let grantedUserId: string;
  let signature: Buffer;
  try {
    const userIdBytes = Buffer.from(encodedUserId, "base64url");
    signature = Buffer.from(encodedSignature, "base64url");
    if (userIdBytes.toString("base64url") !== encodedUserId || signature.toString("base64url") !== encodedSignature) return false;
    grantedUserId = userIdBytes.toString("utf8");
  } catch {
    return false;
  }
  if (!grantedUserId || grantedUserId !== userId || signature.length !== 32) return false;
  const payload = `${encodedUserId}.${expiryText}`;
  const expected = recoverySignature(secret, payload);
  return expected.length === signature.length && timingSafeEqual(expected, signature);
}

export function setRecoveryGrant(config: AuthConfig, state: AuthResponseState, userId: string): void {
  const secret = config.recoverySecret;
  if (!secret || secret.length < 32) throw new Error("A recovery signing secret of at least 32 characters is required.");
  if (!userId || userId.length > 1_024) throw new Error("A valid user is required for a recovery grant.");
  const encodedUserId = Buffer.from(userId, "utf8").toString("base64url");
  const expiryText = String(Math.floor(Date.now() / 1_000) + RECOVERY_GRANT_SECONDS);
  const payload = `${encodedUserId}.${expiryText}`;
  const value = `${payload}.${recoverySignature(secret, payload).toString("base64url")}`;
  state.cookies.push(serializeCookie(RECOVERY_COOKIE, value, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: RECOVERY_GRANT_SECONDS,
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
