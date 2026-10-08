/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The browser loader is JavaScript and has no emitted declaration file.
import { loadMotionRuntime, MOTION_SOURCES } from "../public/landing-motion.js";
import { serveStatic } from "../src/dashboard/static.js";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function pngDimensions(path: string): { width: number; height: number } {
  const body = readFileSync(path);
  expect(body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

function fontFaceKeys(css: string): string[] {
  return [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map(([, rawBlock]) => {
    const block = rawBlock ?? "";
    const family = block.match(/font-family:\s*"([^"]+)"/)?.[1] ?? "";
    const weight = block.match(/font-weight:\s*(\d+);/)?.[1] ?? "";
    const file = block.match(/url\("([^"]+)"\)/)?.[1] ?? "";
    return `${family}|${weight}|${file}`;
  });
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Buffer | string): void;
}

function response(): CapturedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    },
  };
}

interface FakeScript {
  src: string;
  async: boolean;
  dataset: Record<string, string>;
  onload?: () => void;
  onerror?: () => void;
}

interface FakeWindow {
  gsap?: object;
  ScrollTrigger?: object;
}

function fakeDocument(
  windowRef: FakeWindow,
  shouldFail?: (src: string, attempt: number) => boolean,
): { documentRef: { createElement: ReturnType<typeof vi.fn>; head: { append(script: FakeScript): void } }; scripts: FakeScript[] } {
  const scripts: FakeScript[] = [];
  const attempts = new Map<string, number>();
  const documentRef = {
    createElement: vi.fn((): FakeScript => ({ src: "", async: true, dataset: {} })),
    head: {
      append(script: FakeScript) {
        scripts.push(script);
        const attempt = (attempts.get(script.src) ?? 0) + 1;
        attempts.set(script.src, attempt);
        queueMicrotask(() => {
          if (shouldFail?.(script.src, attempt)) {
            script.onerror?.();
            return;
          }
          if (script.src.endsWith("gsap.min.js")) windowRef.gsap = { loaded: true };
          if (script.src.endsWith("ScrollTrigger.min.js")) windowRef.ScrollTrigger = { loaded: true };
          script.onload?.();
        });
      },
    },
  };
  return { documentRef, scripts };
}

describe("Scout frontend asset loading", () => {
  it("self-hosts the exact used font weights and removes third-party font startup requests", () => {
    const indexMarkup = source("public/index.html");
    const landingMarkup = source("public/landing.html");
    const dashboardStyles = source("public/styles.css");
    const landingStyles = source("public/landing.css");
    const dashboardFaces = fontFaceKeys(dashboardStyles);
    const landingFaces = fontFaceKeys(landingStyles);
    const geistFaces = [
      ["Geist", "400", "/fonts/geist/Geist-Regular.woff2"],
      ["Geist", "500", "/fonts/geist/Geist-Medium.woff2"],
      ["Geist", "600", "/fonts/geist/Geist-SemiBold.woff2"],
      ["Geist", "700", "/fonts/geist/Geist-Bold.woff2"],
      ["Geist Mono", "500", "/fonts/geist/GeistMono-Medium.woff2"],
      ["Geist Mono", "600", "/fonts/geist/GeistMono-SemiBold.woff2"],
    ].map(([family, weight, file]) => `${family}|${weight}|${file}`);

    expect(dashboardFaces).toEqual(expect.arrayContaining(geistFaces));
    expect(landingFaces).toEqual(expect.arrayContaining(geistFaces));
    for (const [weight, file] of [["400", "/fonts/outfit/Outfit-latin.woff2"], ["400", "/fonts/outfit/Outfit-latin-ext.woff2"], ["500", "/fonts/outfit/Outfit-latin.woff2"], ["500", "/fonts/outfit/Outfit-latin-ext.woff2"], ["600", "/fonts/outfit/Outfit-latin.woff2"], ["600", "/fonts/outfit/Outfit-latin-ext.woff2"], ["700", "/fonts/outfit/Outfit-latin.woff2"], ["700", "/fonts/outfit/Outfit-latin-ext.woff2"]]) {
      expect(landingFaces).toContain(`Outfit|${weight}|${file}`);
    }

    expect(indexMarkup).not.toMatch(/fonts\.googleapis|fonts\.gstatic|preconnect/);
    expect(landingMarkup).not.toMatch(/fonts\.googleapis|fonts\.gstatic|preconnect/);
    expect(dashboardStyles).toContain("font-display: swap;");
    expect(landingStyles).toContain("font-display: swap;");
  });

  it("uses smaller 2x transparent renditions without removing the original artwork", () => {
    const assets = [
      ["scout-logo.png", "scout-logo-2x.png", 264, 96],
      ["scout-icon.png", "scout-icon-2x.png", 512, 512],
      ["scout-favicon.png", "scout-favicon-2x.png", 128, 117],
    ] as const;
    for (const [original, rendition, width, height] of assets) {
      const originalPath = `${publicRoot}assets/brand/${original}`;
      const renditionPath = `${publicRoot}assets/brand/${rendition}`;
      expect(statSync(originalPath).size).toBeGreaterThan(statSync(renditionPath).size);
      expect(pngDimensions(renditionPath)).toEqual({ width, height });
      expect(readFileSync(renditionPath).subarray(24, 26)).toEqual(Buffer.from([8, 6]));
    }

    expect(source("public/index.html")).toContain("/assets/brand/scout-logo-2x.png");
    expect(source("public/index.html")).toContain("/assets/brand/scout-favicon-2x.png");
    expect(source("public/landing.html")).toContain("/assets/brand/scout-logo-2x.png");
    expect(source("public/landing.html")).toContain("/assets/brand/scout-icon-2x.png");
    expect(source("public/landing.html")).toContain("/assets/brand/scout-favicon-2x.png");
  });

  it("keeps motion optional and removes disabled Source Ledger markup", () => {
    const markup = source("public/landing.html");
    const script = source("public/landing.js");
    const styles = source("public/landing.css");
    const reducedOrStaticGuard = script.indexOf("if (prefersReducedMotion || staticCapture) return;");
    const loaderImport = script.indexOf('import("/landing-motion.js")');

    expect(markup).toContain('<script defer src="/landing.js"></script>');
    expect(markup).not.toContain('/vendor/gsap.min.js');
    expect(markup).not.toContain('/vendor/ScrollTrigger.min.js');
    expect(reducedOrStaticGuard).toBeGreaterThanOrEqual(0);
    expect(loaderImport).toBeGreaterThan(reducedOrStaticGuard);
    const authFetch = script.indexOf('fetch("/api/auth/session"');
    const authIdle = script.indexOf("requestIdleCallback(hydrateAuth");
    expect(authFetch).toBeGreaterThanOrEqual(0);
    expect(authIdle).toBeGreaterThan(authFetch);
    expect(script).toContain('window.addEventListener("load", scheduleAuth');
    expect(script).toContain("timeout: 1500");
    expect(script).toContain("window.setTimeout(hydrateAuth, 350)");
    expect(script).toContain("window.setTimeout(scheduleAuth, 2500)");
    expect(markup).not.toContain('<div class="source-ledger"');
    expect(styles).not.toMatch(/source-ledger|ledger-heading|ledger-row|ledger-source|ledger-raw|ledger-intake|ledger-role|source-glyph/);
  });

  it("loads motion dependencies once in order, retries a failed request, and skips preloaded globals", async () => {
    const windowRef: FakeWindow = {};
    const first = fakeDocument(windowRef);
    const pendingA = loadMotionRuntime({ documentRef: first.documentRef, windowRef });
    const pendingB = loadMotionRuntime({ documentRef: first.documentRef, windowRef });
    const [runtimeA, runtimeB] = await Promise.all([pendingA, pendingB]);
    expect(runtimeA).toEqual({ gsap: { loaded: true }, ScrollTrigger: { loaded: true } });
    expect(runtimeB).toBe(runtimeA);
    expect(first.scripts.map(({ src }) => src)).toEqual([...MOTION_SOURCES]);
    expect(first.scripts.every(({ async }) => async === false)).toBe(true);

    const retryWindow: FakeWindow = {};
    const retry = fakeDocument(retryWindow, (src, attempt) => src.endsWith("gsap.min.js") && attempt === 1);
    await expect(loadMotionRuntime({ documentRef: retry.documentRef, windowRef: retryWindow })).resolves.toBeNull();
    await expect(loadMotionRuntime({ documentRef: retry.documentRef, windowRef: retryWindow })).resolves.toEqual({
      gsap: { loaded: true },
      ScrollTrigger: { loaded: true },
    });
    expect(retry.scripts.map(({ src }) => src)).toEqual([
      MOTION_SOURCES[0],
      MOTION_SOURCES[0],
      MOTION_SOURCES[1],
    ]);

    const preloadedWindow: FakeWindow = { gsap: {}, ScrollTrigger: {} };
    const preloaded = fakeDocument(preloadedWindow);
    await expect(loadMotionRuntime({ documentRef: preloaded.documentRef, windowRef: preloadedWindow })).resolves.toEqual({
      gsap: preloadedWindow.gsap,
      ScrollTrigger: preloadedWindow.ScrollTrigger,
    });
    expect(preloaded.scripts).toHaveLength(0);
  });

  it("serves the new font and image paths with their binary MIME types and same-origin policy", async () => {
    for (const [path, type] of [
      ["/landing-motion.js", "text/javascript; charset=utf-8"],
      ["/fonts/geist/Geist-Bold.woff2", "font/woff2"],
      ["/fonts/geist/GeistMono-Medium.woff2", "font/woff2"],
      ["/fonts/outfit/Outfit-latin.woff2", "font/woff2"],
      ["/fonts/outfit/Outfit-latin-ext.woff2", "font/woff2"],
      ["/assets/brand/scout-logo-2x.png", "image/png"],
      ["/assets/brand/scout-icon-2x.png", "image/png"],
      ["/assets/brand/scout-favicon-2x.png", "image/png"],
    ] as const) {
      const captured = response();
      await serveStatic(
        { method: "GET", url: path, headers: {} } as never,
        captured as never,
        path,
        { publicRoot },
      );
      expect(captured.statusCode).toBe(200);
      expect(captured.headers["Content-Type"]).toBe(type);
      expect(captured.headers["Content-Security-Policy"]).toContain("default-src 'self'");
      expect(captured.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(captured.headers["Cache-Control"]).toBe("no-cache");
      expect(captured.body.byteLength).toBeGreaterThan(0);
    }
  });
});
