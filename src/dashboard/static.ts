import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { encodeResponseBody, etagMatches, jsonResponse, responseWouldUseContentEncoding } from "./http.js";

// These pages are server rendered by their owning routers or have request-
// shaped metadata. Serving the raw templates would expose placeholders,
// create duplicate crawlable URLs, or bypass an auth response policy.
const ROUTED_TEMPLATE_PATHS = new Set([
  "/landing.html",
  "/index.html",
  "/privacy.html",
  "/terms.html",
  "/pro.html",
  "/owner-analytics.html",
  "/admin/operations.html",
  "/auth/auth.html",
  "/onboarding/onboarding.html",
]);

const STATIC_FILE_CACHE_MAX_ENTRIES = 128;
const STATIC_FILE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const STATIC_FILE_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const STATIC_TEMPLATE_CACHE_MAX_ENTRIES = 32;
const STATIC_TEMPLATE_CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface PublicFile {
  path: string;
  body: Buffer;
  hash: string;
}

interface PublicFileCacheEntry extends PublicFile {
  fingerprint: string;
  bytes: number;
}

interface TemplateCacheEntry {
  dependencyKey: string;
  body: Buffer;
  hash: string;
  bytes: number;
}

const publicFileCache = new Map<string, PublicFileCacheEntry>();
const templateCache = new Map<string, TemplateCacheEntry>();
let publicFileCacheBytes = 0;
let templateCacheBytes = 0;

/** Clear static metadata/template caches between isolated tests or benchmarks. */
export function clearStaticDeliveryCachesForTests(): void {
  publicFileCache.clear();
  templateCache.clear();
  publicFileCacheBytes = 0;
  templateCacheBytes = 0;
}

/** Expose cache bounds without exposing cached asset contents. */
export function getStaticDeliveryCacheStatsForTests(): {
  files: number;
  templates: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
} {
  return {
    files: publicFileCache.size,
    templates: templateCache.size,
    bytes: publicFileCacheBytes + templateCacheBytes,
    maxFiles: STATIC_FILE_CACHE_MAX_ENTRIES,
    maxBytes: STATIC_FILE_CACHE_MAX_BYTES + STATIC_TEMPLATE_CACHE_MAX_BYTES,
  };
}

export interface StaticServerOptions {
  publicRoot: string;
}

function contentType(path: string): string {
  const normalizedPath = path.toLocaleLowerCase();
  if (normalizedPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (normalizedPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (normalizedPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (normalizedPath.endsWith(".svg")) return "image/svg+xml";
  if (normalizedPath.endsWith(".json") || normalizedPath.endsWith(".map")) return "application/json; charset=utf-8";
  if (normalizedPath.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (normalizedPath.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (normalizedPath.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (normalizedPath.endsWith(".woff2")) return "font/woff2";
  if (normalizedPath.endsWith(".woff")) return "font/woff";
  if (normalizedPath.endsWith(".ttf")) return "font/ttf";
  if (normalizedPath.endsWith(".otf")) return "font/otf";
  if (normalizedPath.endsWith(".png")) return "image/png";
  if (normalizedPath.endsWith(".jpg") || normalizedPath.endsWith(".jpeg")) return "image/jpeg";
  if (normalizedPath.endsWith(".webp")) return "image/webp";
  if (normalizedPath.endsWith(".gif")) return "image/gif";
  if (normalizedPath.endsWith(".ico")) return "image/x-icon";
  if (normalizedPath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function bodyHash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function requestedAssetVersion(request: IncomingMessage): string | null {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const version = requestUrl.searchParams.get("v")?.trim().toLocaleLowerCase() ?? "";
    return /^[a-f0-9]{12}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

function staticCacheControl(relativePath: string, request: IncomingMessage, hash: string): string {
  // HTML is request-shaped (legal canonical URLs and asset references) and
  // stays no-store so auth/template semantics cannot be relaxed by accident.
  if (relativePath.toLocaleLowerCase().endsWith(".html")) return "no-store";
  const version = requestedAssetVersion(request);
  // Only a version token that matches the served bytes is immutable. An
  // arbitrary `?v=` must continue to revalidate so content changes are seen.
  return version !== null && hash.startsWith(version)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function isCompressibleContentType(type: string): boolean {
  return type.startsWith("text/") || type === "image/svg+xml";
}

function siteOrigin(request: IncomingMessage): URL {
  // Production must set AUTH_SITE_URL so a spoofed Host header cannot change
  // canonical or sitemap URLs. With no configured origin, only loopback Host
  // values are useful for local development; all other hosts use a stable
  // loopback fallback rather than becoming an origin trust boundary.
  const configuredSiteUrl = process.env.AUTH_SITE_URL?.trim();
  if (!configuredSiteUrl) {
    const requestHost = typeof request.headers.host === "string" ? request.headers.host.trim() : "";
    try {
      const localUrl = new URL("http://" + requestHost);
      const localHost = localUrl.hostname.toLocaleLowerCase();
      if (
        (localHost === "localhost" || localHost === "127.0.0.1" || localHost === "[::1]")
        && localUrl.username === ""
        && localUrl.password === ""
        && localUrl.pathname === "/"
        && localUrl.search === ""
        && localUrl.hash === ""
      ) {
        return new URL(localUrl.origin);
      }
    } catch {
      // Fall through to the fixed local origin.
    }
    return new URL("http://127.0.0.1:4173");
  }
  try {
    const siteUrl = new URL(configuredSiteUrl);
    if (siteUrl.protocol !== "http:" && siteUrl.protocol !== "https:") throw new Error("unsupported site URL");
    return new URL(siteUrl.origin);
  } catch {
    return new URL("http://127.0.0.1:4173");
  }
}

function publicUrl(request: IncomingMessage, pathname: string): string {
  return new URL(pathname, siteOrigin(request)).toString();
}

function legalCanonicalUrl(request: IncomingMessage, pathname: "/privacy" | "/terms"): string {
  return publicUrl(request, pathname);
}

function jobsRobotsDirective(request: IncomingMessage): string {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    return requestUrl.searchParams.get("view") === "matches"
      ? "noindex, nofollow, noarchive"
      : "index, follow, max-image-preview:large";
  } catch {
    return "index, follow, max-image-preview:large";
  }
}

function replacePublicMetadata(body: Buffer, request: IncomingMessage, relativePath: string): Buffer {
  let content = body.toString("utf8");
  if (relativePath === "landing.html") {
    content = content
      .replaceAll("__LANDING_CANONICAL_URL__", publicUrl(request, "/"))
      .replaceAll("__LANDING_SOCIAL_IMAGE_URL__", publicUrl(request, "/assets/brand/scout-logo.png"));
  } else if (relativePath === "index.html") {
    content = content
      .replaceAll("__JOBS_CANONICAL_URL__", publicUrl(request, "/jobs"))
      .replaceAll("__JOBS_SOCIAL_IMAGE_URL__", publicUrl(request, "/assets/brand/scout-logo.png"))
      .replaceAll("__JOBS_ROBOTS__", jobsRobotsDirective(request));
  } else if (relativePath === "pro.html") {
    content = content
      .replaceAll("__PRO_CANONICAL_URL__", publicUrl(request, "/pro"))
      .replaceAll("__PRO_SOCIAL_IMAGE_URL__", publicUrl(request, "/assets/brand/scout-logo.png"));
  } else if (relativePath === "robots.txt") {
    content = content.replaceAll("__SITEMAP_URL__", publicUrl(request, "/sitemap.xml"));
  } else if (relativePath === "sitemap.xml") {
    content = content.replaceAll("__SITEMAP_SITE_ORIGIN__", siteOrigin(request).origin);
  }
  return Buffer.from(content, "utf8");
}

function fileFingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function rememberPublicFile(key: string, file: PublicFile, fingerprint: string): void {
  if (file.body.byteLength > STATIC_FILE_CACHE_MAX_ENTRY_BYTES) return;
  const previous = publicFileCache.get(key);
  if (previous) {
    publicFileCacheBytes -= previous.bytes;
    publicFileCache.delete(key);
  }
  publicFileCache.set(key, { ...file, fingerprint, bytes: file.body.byteLength });
  publicFileCacheBytes += file.body.byteLength;
  while (publicFileCache.size > STATIC_FILE_CACHE_MAX_ENTRIES || publicFileCacheBytes > STATIC_FILE_CACHE_MAX_BYTES) {
    const oldestKey = publicFileCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = publicFileCache.get(oldestKey);
    publicFileCache.delete(oldestKey);
    publicFileCacheBytes -= oldest?.bytes ?? 0;
  }
}

function rememberTemplate(key: string, dependencyKey: string, body: Buffer): PublicFile {
  const hash = bodyHash(body);
  if (body.byteLength > STATIC_TEMPLATE_CACHE_MAX_BYTES) return { path: key, body, hash };
  const previous = templateCache.get(key);
  if (previous) {
    templateCacheBytes -= previous.bytes;
    templateCache.delete(key);
  }
  templateCache.set(key, { dependencyKey, body, hash, bytes: body.byteLength });
  templateCacheBytes += body.byteLength;
  while (templateCache.size > STATIC_TEMPLATE_CACHE_MAX_ENTRIES || templateCacheBytes > STATIC_TEMPLATE_CACHE_MAX_BYTES) {
    const oldestKey = templateCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = templateCache.get(oldestKey);
    templateCache.delete(oldestKey);
    templateCacheBytes -= oldest?.bytes ?? 0;
  }
  return { path: key, body, hash };
}

function cachedTemplate(key: string, dependencyKey: string): PublicFile | null {
  const cached = templateCache.get(key);
  if (!cached || cached.dependencyKey !== dependencyKey) return null;
  templateCache.delete(key);
  templateCache.set(key, cached);
  return { path: key, body: cached.body, hash: cached.hash };
}

async function safePublicFile(publicRoot: string, relativePath: string): Promise<PublicFile> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("invalid path");
  const root = await realpath(publicRoot);
  const candidate = resolve(root, relativePath);
  const containment = relative(root, candidate);
  if (containment === "" || containment === ".." || containment.startsWith(`..${sep}`)) throw new Error("invalid path");
  const stat = await lstat(candidate, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid file");
  const resolved = await realpath(candidate);
  const resolvedRelative = relative(root, resolved);
  if (resolvedRelative === "" || resolvedRelative === ".." || resolvedRelative.startsWith(`..${sep}`)) throw new Error("invalid file");
  const key = `${root}\u0000${relativePath}\u0000${resolved}`;
  const fingerprint = fileFingerprint(stat);
  const cached = publicFileCache.get(key);
  if (cached?.fingerprint === fingerprint) {
    // Reinsert for LRU behavior while retaining the fresh stat and realpath
    // checks above for symlink/path containment safety.
    publicFileCache.delete(key);
    publicFileCache.set(key, cached);
    return { path: resolved, body: cached.body, hash: cached.hash };
  }
  const body = await readFile(resolved);
  const file = { path: resolved, body, hash: bodyHash(body) };
  rememberPublicFile(key, file, fingerprint);
  return file;
}

type HtmlAssetAttribute = "href" | "src" | "srcset";

interface HtmlAssetReference {
  attribute: HtmlAssetAttribute;
  value: string;
}

interface VersionedHtmlAssetReference extends HtmlAssetReference {
  asset: PublicFile;
}

const HTML_ASSET_TAG_RE = /<(script|link|img|source)\b[^>]*>/gi;

function htmlAttribute(tag: string, attribute: "href" | "rel" | "src" | "srcset"): string | null {
  const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function isVersionableLocalAsset(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("?") && !value.includes("#");
}

function srcsetAssetValues(value: string): string[] {
  const values: string[] = [];
  for (const candidate of value.split(",")) {
    const assetValue = candidate.trim().split(/\s+/u, 1)[0] ?? "";
    if (isVersionableLocalAsset(assetValue)) values.push(assetValue);
  }
  return values;
}

function htmlAssetReferences(html: string): HtmlAssetReference[] {
  const references: HtmlAssetReference[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(HTML_ASSET_TAG_RE)) {
    const tag = match[0] ?? "";
    const tagName = match[1]?.toLocaleLowerCase();
    if (tagName === "link") {
      const rel = htmlAttribute(tag, "rel")?.toLocaleLowerCase().split(/\s+/u) ?? [];
      if (!rel.some((token) => ["stylesheet", "icon", "mask-icon", "apple-touch-icon", "manifest", "modulepreload", "preload"].includes(token))) continue;
    }
    const attributes: HtmlAssetAttribute[] = tagName === "script"
      ? ["src"]
      : tagName === "link"
        ? ["href"]
        : ["src", "srcset"];
    for (const attribute of attributes) {
      const value = htmlAttribute(tag, attribute);
      if (!value) continue;
      const values = attribute === "srcset" ? srcsetAssetValues(value) : [value];
      for (const assetValue of values) {
        if (!isVersionableLocalAsset(assetValue)) continue;
        const key = `${attribute}\u0000${assetValue}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({ attribute, value: assetValue });
      }
    }
  }
  return references;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAssetLiteral(source: string, value: string, version: string): string {
  const pattern = new RegExp(`(["'])${escapeRegularExpression(value)}\\1`, "g");
  return source.replace(pattern, `$1${value}?v=${version}$1`);
}

const CSS_URL_RE = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;

function cssAssetReferences(css: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const match of css.matchAll(CSS_URL_RE)) {
    const value = (match[2] ?? match[3] ?? "").trim();
    if (!isVersionableLocalAsset(value) || seen.has(value)) continue;
    seen.add(value);
    references.push(value);
  }
  return references;
}

interface JavaScriptAssetReference {
  value: string;
  path: string;
}

const DYNAMIC_JS_IMPORT_RE = /\bimport\(\s*(["'])((?:\/|\.\/)[^"'?#]+\.(?:m?js))\1\s*\)/g;
const MOTION_VENDOR_RE = /(["'])(\/vendor\/[^"'?#]+\.(?:m?js))\1/g;

function javaScriptAssetReferences(source: string, relativePath: string): JavaScriptAssetReference[] {
  const references: JavaScriptAssetReference[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    if (!value || value.includes("?") || value.includes("#") || value.startsWith("//")) return;
    const path = value.startsWith("/")
      ? value.slice(1)
      : value.startsWith("./") && !value.slice(2).includes("..")
        ? (relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/") + 1) : "") + value.slice(2)
        : "";
    if (!path || path.includes("..") || seen.has(value)) return;
    seen.add(value);
    references.push({ value, path });
  };
  for (const match of source.matchAll(DYNAMIC_JS_IMPORT_RE)) add(match[2] ?? "");
  // landing-motion.js has a deliberately tiny runtime dependency list. Keep
  // this scoped to that file so arbitrary API/path strings in other scripts
  // are never rewritten without a build manifest.
  if (relativePath === "landing-motion.js") {
    for (const match of source.matchAll(MOTION_VENDOR_RE)) add(match[2] ?? "");
  }
  return references;
}

async function safePublicAsset(
  publicRoot: string,
  relativePath: string,
  stack: ReadonlySet<string> = new Set(),
): Promise<PublicFile> {
  const source = await safePublicFile(publicRoot, relativePath);
  const normalizedPath = relativePath.toLocaleLowerCase();
  if (!normalizedPath.endsWith(".css") && !normalizedPath.endsWith(".js") && !normalizedPath.endsWith(".mjs")) return source;

  const cacheKey = `asset:${source.path}`;
  if (stack.has(cacheKey)) return source;
  const nextStack = new Set(stack);
  nextStack.add(cacheKey);
  const sourceText = source.body.toString("utf8");
  const references: Array<{ value: string; path: string }> = normalizedPath.endsWith(".css")
    ? cssAssetReferences(sourceText).map((value) => ({ value, path: value.slice(1) }))
    : javaScriptAssetReferences(sourceText, relativePath);
  const dependencies = await Promise.all(references.map(async (reference) => ({
    reference,
    asset: await safePublicAsset(publicRoot, reference.path, nextStack),
  })));
  const dependencyKey = [source.hash, ...dependencies.map(({ reference, asset }) => reference.value + ":" + asset.hash)].join("|");
  const cached = cachedTemplate(cacheKey, dependencyKey);
  if (cached) return cached;

  let transformed = sourceText;
  for (const { reference, asset } of dependencies) {
    const version = asset.hash.slice(0, 12);
    transformed = normalizedPath.endsWith(".css")
      ? transformed.replace(CSS_URL_RE, (match, quote: string | undefined, quotedValue: string | undefined, unquotedValue: string | undefined) => {
        const value = (quotedValue ?? unquotedValue ?? "").trim();
        if (value !== reference.value) return match;
        const replacement = reference.value + "?v=" + version;
        if (quote) return match.replace(value, replacement);
        return match.replace(value, replacement);
      })
      : replaceAssetLiteral(transformed, reference.value, version);
  }
  return rememberTemplate(cacheKey, dependencyKey, Buffer.from(transformed, "utf8"));
}

async function versionHtmlAssets(html: string, publicRoot: string): Promise<{ body: Buffer; dependencyKey: string }> {
  const references = htmlAssetReferences(html);
  const versioned = await Promise.all(references.map(async (reference): Promise<VersionedHtmlAssetReference> => ({
    ...reference,
    asset: await safePublicAsset(publicRoot, reference.value.slice(1)),
  })));
  const dependencyKey = versioned.map(({ attribute, value, asset }) => `${attribute}=${value}:${asset.hash}`).join("|");
  const body = html.replace(HTML_ASSET_TAG_RE, (tag) => {
    let transformed = tag;
    for (const reference of versioned) {
      if (reference.attribute === "srcset") {
        const pattern = new RegExp(`(\\bsrcset\\s*=\\s*)(["'])(.*?)\\2`, "i");
        transformed = transformed.replace(pattern, (_match, prefix: string, quote: string, value: string) => {
          const rewritten = value.replace(/(^|,)\s*(\/[^,\s?#]+)/g, (candidate, separator: string, assetValue: string) => {
            if (assetValue !== reference.value) return candidate;
            return `${separator}${candidate.slice(separator.length).replace(assetValue, `${assetValue}?v=${reference.asset.hash.slice(0, 12)}`)}`;
          });
          return `${prefix}${quote}${rewritten}${quote}`;
        });
      } else {
        const pattern = new RegExp(`(\\b${reference.attribute}\\s*=\\s*)(["'])${escapeRegularExpression(reference.value)}\\2`, "i");
        transformed = transformed.replace(pattern, `$1$2${reference.value}?v=${reference.asset.hash.slice(0, 12)}$2`);
      }
    }
    return transformed;
  });
  return { body: Buffer.from(body, "utf8"), dependencyKey };
}

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: StaticServerOptions,
): Promise<void> {
  const { publicRoot } = options;
  if (ROUTED_TEMPLATE_PATHS.has(pathname)) {
    jsonResponse(response, 404, { error: "Not found" }, { request, cacheControl: "no-store" });
    return;
  }
  const relativePath = pathname === "/"
    ? "landing.html"
    : pathname === "/jobs" || pathname === "/jobs/"
      ? "index.html"
      : pathname === "/privacy" || pathname === "/privacy/"
        ? "privacy.html"
      : pathname === "/terms" || pathname === "/terms/"
        ? "terms.html"
      : pathname === "/pro" || pathname === "/pro/"
        ? "pro.html"
      : pathname === "/robots.txt"
        ? "robots.txt"
      : pathname === "/sitemap.xml"
        ? "sitemap.xml"
      : pathname === "/site.webmanifest"
        ? "site.webmanifest"
      : pathname.replace(/^\/+/, "");
  if (relativePath.includes("..") || relativePath.includes("\\")) {
    jsonResponse(response, 400, { error: "Invalid path" }, { request });
    return;
  }
  try {
    const sourceFile = await safePublicFile(publicRoot, relativePath);
    const safeFile = relativePath.toLocaleLowerCase().endsWith(".html")
      ? sourceFile
      : await safePublicAsset(publicRoot, relativePath);
    const filePath = safeFile.path;
    let body = safeFile.body;
    let contentHash = safeFile.hash;
    if (relativePath.toLocaleLowerCase().endsWith(".html")) {
      const versioned = await versionHtmlAssets(body.toString("utf8"), publicRoot);
      const dependencyKey = [sourceFile.hash, versioned.dependencyKey].join(":");
      // Legal pages contain a request-origin canonical URL, so their final
      // bytes cannot be shared between requests. Their local assets still
      // receive content hashes; dashboard/landing/pro templates are cached by
      // source plus every referenced asset hash below.
      const requestSpecificTemplate = relativePath === "privacy.html" || relativePath === "terms.html";
      if (requestSpecificTemplate) {
        body = versioned.body;
        contentHash = bodyHash(body);
      } else {
        const cached = cachedTemplate(filePath, dependencyKey);
        if (cached) {
          body = cached.body;
          contentHash = cached.hash;
        } else {
          const template = rememberTemplate(filePath, dependencyKey, versioned.body);
          body = template.body;
          contentHash = template.hash;
        }
      }
    }
    if (relativePath === "privacy.html") {
      body = Buffer.from(
        body.toString("utf8").replaceAll("__PRIVACY_CANONICAL_URL__", legalCanonicalUrl(request, "/privacy")),
        "utf8",
      );
      contentHash = bodyHash(body);
    } else if (relativePath === "terms.html") {
      body = Buffer.from(
        body.toString("utf8").replaceAll("__TERMS_CANONICAL_URL__", legalCanonicalUrl(request, "/terms")),
        "utf8",
      );
      contentHash = bodyHash(body);
    }
    if (relativePath === "landing.html" || relativePath === "index.html" || relativePath === "pro.html" || relativePath === "robots.txt" || relativePath === "sitemap.xml") {
      body = replacePublicMetadata(body, request, relativePath);
      contentHash = bodyHash(body);
    }
    const type = contentType(filePath);
    const hash = contentHash;
    const etag = `W/"${hash}"`;
    const compressible = isCompressibleContentType(type);
    const headers: Record<string, string> = {
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
      "Content-Type": type,
      "Cache-Control": staticCacheControl(relativePath, request, hash),
      ETag: etag,
      ...(compressible ? { Vary: "Accept-Encoding" } : {}),
      ...(relativePath === "index.html" && jobsRobotsDirective(request).startsWith("noindex")
        ? { "X-Robots-Tag": "noindex, nofollow" }
        : {}),
    };
    if (etagMatches(request, etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    if (request.method === "HEAD") {
      // Avoid synchronous compression for HEAD. If a GET would negotiate a
      // coded representation, omit Content-Length because this fast path does
      // not materialize those bytes. Identity GETs retain their exact length.
      if (!responseWouldUseContentEncoding(body, request, compressible)) {
        headers["Content-Length"] = String(body.byteLength);
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }
    const encoded = encodeResponseBody(body, request, compressible);
    if (encoded.encoding !== null) headers["Content-Encoding"] = encoded.encoding;
    headers["Content-Length"] = String(encoded.body.byteLength);
    response.writeHead(200, headers);
    response.end(encoded.body);
  } catch {
    jsonResponse(response, 404, { error: "Not found" }, { request });
  }
}
