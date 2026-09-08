import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import { canonicalizeUrl } from "../utils/url.js";
import type { ListingAction, ListingType } from "../database/actions.js";

export const MAX_DASHBOARD_BODY_BYTES = 100_000;

export interface JsonResponseOptions {
  request?: IncomingMessage;
  etag?: string;
  cacheControl?: string;
  head?: boolean;
}

type ContentEncoding = "br" | "gzip";

interface EncodedResponseBody {
  body: Buffer;
  encoding: ContentEncoding | null;
}

const MIN_COMPRESSIBLE_BODY_BYTES = 1_024;
const BROTLI_QUALITY = 5;
const RESPONSE_REPRESENTATION_CACHE_MAX_ENTRIES = 128;
const RESPONSE_REPRESENTATION_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const RESPONSE_REPRESENTATION_CACHE_MAX_ENTRY_BYTES = 512 * 1024;

interface EncodedResponseCacheEntry {
  body: Buffer;
  bytes: number;
}

const encodedResponseCache = new Map<string, EncodedResponseCacheEntry>();
let encodedResponseCacheBytes = 0;
let encodedResponseCacheHits = 0;
let encodedResponseCacheMisses = 0;

/** Clear the bounded representation cache between isolated tests/benchmarks. */
export function clearResponseRepresentationCacheForTests(): void {
  encodedResponseCache.clear();
  encodedResponseCacheBytes = 0;
  encodedResponseCacheHits = 0;
  encodedResponseCacheMisses = 0;
}

/** Expose cache bounds and counters without exposing response bodies. */
export function getResponseRepresentationCacheStatsForTests(): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  maxEntries: number;
  maxBytes: number;
} {
  return {
    entries: encodedResponseCache.size,
    bytes: encodedResponseCacheBytes,
    hits: encodedResponseCacheHits,
    misses: encodedResponseCacheMisses,
    maxEntries: RESPONSE_REPRESENTATION_CACHE_MAX_ENTRIES,
    maxBytes: RESPONSE_REPRESENTATION_CACHE_MAX_BYTES,
  };
}

/** Headers shared by every dashboard JSON response, including errors. */
function dashboardSecurityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://picsum.photos https://logos.hunter.io https://www.google.com",
      "font-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export class DashboardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardValidationError";
  }
}

function encodingQuality(request: IncomingMessage | undefined, encoding: "br" | "gzip"): number {
  const rawHeader = request?.headers["accept-encoding"];
  const header = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader;
  if (typeof header !== "string") return 0;
  let wildcard: number | null = null;
  let explicit: number | null = null;
  for (const item of header.split(",")) {
    const [rawName, ...parameters] = item.trim().toLocaleLowerCase().split(";");
    const name = (rawName ?? "").trim();
    if (!name) continue;
    const qParameter = parameters.find((parameter) => /^q\s*=/i.test(parameter.trim()));
    const rawQuality = qParameter?.trim().replace(/^q\s*=\s*/i, "");
    const parsedQuality = rawQuality === undefined || rawQuality === "" ? 0 : Number(rawQuality);
    const quality = rawQuality === undefined
      ? 1
      : Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;
    if (name === encoding) explicit = quality;
    if (name === "*") wildcard = quality;
  }
  return explicit ?? wildcard ?? 0;
}

function chooseEncoding(request: IncomingMessage | undefined): ContentEncoding | null {
  const brQuality = encodingQuality(request, "br");
  const gzipQuality = encodingQuality(request, "gzip");
  if (brQuality <= 0 && gzipQuality <= 0) return null;
  if (brQuality >= gzipQuality && brQuality > 0) return "br";
  return gzipQuality > 0 ? "gzip" : null;
}

/** Whether a GET for this body would select a coded representation. */
export function responseWouldUseContentEncoding(
  body: Buffer,
  request: IncomingMessage | undefined,
  compressible = true,
): boolean {
  return compressible && body.byteLength >= MIN_COMPRESSIBLE_BODY_BYTES && chooseEncoding(request) !== null;
}

function representationCacheKey(body: Buffer, encoding: ContentEncoding): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `${encoding}:${body.byteLength}:${digest}`;
}

function rememberEncodedResponse(key: string, body: Buffer): void {
  if (body.byteLength > RESPONSE_REPRESENTATION_CACHE_MAX_ENTRY_BYTES) return;
  const previous = encodedResponseCache.get(key);
  if (previous) {
    encodedResponseCacheBytes -= previous.bytes;
    encodedResponseCache.delete(key);
  }
  encodedResponseCache.set(key, { body, bytes: body.byteLength });
  encodedResponseCacheBytes += body.byteLength;
  while (
    encodedResponseCache.size > RESPONSE_REPRESENTATION_CACHE_MAX_ENTRIES
    || encodedResponseCacheBytes > RESPONSE_REPRESENTATION_CACHE_MAX_BYTES
  ) {
    const oldestKey = encodedResponseCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = encodedResponseCache.get(oldestKey);
    encodedResponseCache.delete(oldestKey);
    encodedResponseCacheBytes -= oldest?.bytes ?? 0;
  }
}

function cachedEncodedResponse(key: string): Buffer | null {
  const cached = encodedResponseCache.get(key);
  if (!cached) return null;
  // Reinsert for bounded LRU behavior. A dynamic response can legitimately
  // alternate between a handful of users/filters, so recency is more useful
  // than retaining the first 128 representations ever observed.
  encodedResponseCache.delete(key);
  encodedResponseCache.set(key, cached);
  return cached.body;
}

/**
 * Encode a response only when the client accepts that representation. The
 * compressed bytes are shared by exact body hash and encoding, with strict
 * byte/entry bounds so a high-cardinality query stream cannot grow memory
 * without limit. Brotli quality 5 keeps the small API payloads compact while
 * avoiding the ~20 ms synchronous quality-11 cost on every cache miss.
 */
export function encodeResponseBody(
  body: Buffer,
  request: IncomingMessage | undefined,
  compressible = true,
): EncodedResponseBody {
  if (!responseWouldUseContentEncoding(body, request, compressible)) return { body, encoding: null };
  const selectedEncoding = chooseEncoding(request);
  if (selectedEncoding === null) return { body, encoding: null };
  const key = representationCacheKey(body, selectedEncoding);
  const cached = cachedEncodedResponse(key);
  if (cached) {
    encodedResponseCacheHits += 1;
    return { body: cached, encoding: selectedEncoding };
  }
  encodedResponseCacheMisses += 1;
  const encoded = selectedEncoding === "br"
    ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
    : gzipSync(body);
  rememberEncodedResponse(key, encoded);
  return { body: encoded, encoding: selectedEncoding };
}

function normalizedEtag(value: string): string {
  return value.trim().replace(/^W\//i, "");
}

export function etagMatches(request: IncomingMessage | undefined, etag: string | undefined): boolean {
  if (!etag) return false;
  const header = request?.headers["if-none-match"];
  if (typeof header !== "string") return false;
  const target = normalizedEtag(etag);
  return header.split(",").map((value) => value.trim()).some((value) => value === "*" || normalizedEtag(value) === target);
}

function weakEtag(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("W/") ? normalized : `W/${normalized}`;
}

export function jsonResponseBody(
  response: ServerResponse,
  status: number,
  body: string,
  options: JsonResponseOptions = {},
): void {
  const headers: Record<string, string> = {
    ...dashboardSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": options.cacheControl ?? "no-store",
  };
  if (options.etag) headers.ETag = weakEtag(options.etag);
  if (options.request) headers.Vary = "Accept-Encoding, Cookie";
  const bodyBuffer = Buffer.from(body, "utf8");
  if (etagMatches(options.request, options.etag)) {
    // A 304 has no payload; omit payload framing and content coding rather
    // than claiming a length for the request-dependent JSON representation.
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const isHead = options.head || options.request?.method === "HEAD";
  if (isHead) {
    // HEAD avoids synchronous compression and cache work. If a GET would
    // negotiate Brotli/gzip, omit Content-Length because its value would
    // describe the coded bytes that this fast path deliberately does not
    // materialize. For an identity GET the raw length remains exact.
    if (!responseWouldUseContentEncoding(bodyBuffer, options.request)) {
      headers["Content-Length"] = String(bodyBuffer.byteLength);
    }
    response.writeHead(status, headers);
    response.end();
    return;
  }
  const encoded = encodeResponseBody(bodyBuffer, options.request);
  if (encoded.encoding === "br") {
    headers["Content-Encoding"] = "br";
  } else if (encoded.encoding === "gzip") {
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = String(encoded.body.byteLength);
  response.writeHead(status, headers);
  response.end(encoded.body);
}

export function jsonResponse(
  response: ServerResponse,
  status: number,
  payload: unknown,
  options: JsonResponseOptions = {},
): void {
  jsonResponseBody(response, status, JSON.stringify(payload), options);
}

export function isListingType(value: unknown): value is ListingType {
  return value === "internship" || value === "grind";
}

export function isListingAction(value: unknown): value is ListingAction {
  return value === "applied" || value === "cant_fit";
}

export function requiredString(value: unknown, field: string, maximumLength = 500): string {
  if (typeof value !== "string") throw new DashboardValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new DashboardValidationError(`${field} is required`);
  if (normalized.length > maximumLength) throw new DashboardValidationError(`${field} is too long`);
  return normalized;
}

export function optionalString(value: unknown, field: string, maximumLength = 2_000): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, maximumLength);
}

export function optionalHttpUrl(value: unknown, field: string): string | null {
  const normalized = optionalString(value, field);
  if (!normalized) return null;
  try {
    const canonical = canonicalizeUrl(normalized);
    if (!/^https?:$/i.test(new URL(canonical).protocol)) throw new DashboardValidationError(`${field} must be an HTTP(S) URL`);
    return canonical;
  } catch (error) {
    if (error instanceof DashboardValidationError) throw error;
    throw new DashboardValidationError(error instanceof Error ? error.message : String(error));
  }
}

export async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const advertisedLength = typeof request.headers["content-length"] === "string"
    ? Number(request.headers["content-length"])
    : null;
  if (advertisedLength !== null && Number.isFinite(advertisedLength) && advertisedLength > MAX_DASHBOARD_BODY_BYTES) {
    throw new DashboardValidationError("Request body is too large");
  }
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_DASHBOARD_BODY_BYTES) throw new DashboardValidationError("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
