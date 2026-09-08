import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearResponseRepresentationCacheForTests,
  getResponseRepresentationCacheStatsForTests,
  jsonResponseBody,
} from "../src/dashboard/http.js";
import {
  clearStaticDeliveryCachesForTests,
  getStaticDeliveryCacheStatsForTests,
  serveStatic,
} from "../src/dashboard/static.js";

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

function request(
  url = "/",
  method = "GET",
  headers: Record<string, string> = {},
): Record<string, unknown> {
  return { method, url, headers };
}

function jsonCapture(
  body: string,
  headers: Record<string, string> = {},
  options: { method?: string; etag?: string } = {},
): CapturedResponse {
  const captured = response();
  jsonResponseBody(captured as never, 200, body, {
    request: request("/api/roles", options.method ?? "GET", headers) as never,
    ...(options.etag === undefined ? {} : { etag: options.etag }),
  });
  return captured;
}

function decodedBody(captured: CapturedResponse): Buffer {
  if (captured.headers["Content-Encoding"] === "br") return brotliDecompressSync(captured.body);
  if (captured.headers["Content-Encoding"] === "gzip") return gunzipSync(captured.body);
  return captured.body;
}

describe("dashboard HTTP delivery", () => {
  let directory = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-delivery-"));
    const publicDirectory = join(directory, "public");
    mkdirSync(publicDirectory, { recursive: true });
    mkdirSync(join(publicDirectory, "vendor"), { recursive: true });
    writeFileSync(join(publicDirectory, "app.js"), `${"const listing = 'Software Engineering Intern';\n".repeat(5_000)}`);
    writeFileSync(join(publicDirectory, "small.js"), "export const ready = true;\n");
    for (const fileName of [
      "styles.css",
      "redesign.css",
      "catalog-freshness.css",
      "conversion.css",
      "themed-select.css",
      "landing.css",
    ]) {
      writeFileSync(
        join(publicDirectory, fileName),
        fileName === "landing.css"
          ? "/* " + fileName + " */\n@font-face { font-family: Fixture; src: url(\"/font.woff2\") format(\"woff2\"); }\nbody { color: #123456; }\n"
          : "/* " + fileName + " */\nbody { color: #123456; }\n",
      );
    }
    for (const fileName of ["themed-select.js", "vendor.js", "conversion.js"]) {
      writeFileSync(join(publicDirectory, fileName), `/* ${fileName} */\nexport const ready = true;\n`);
    }
    writeFileSync(join(publicDirectory, "landing.js"), 'import("/landing-motion.js");\nexport const ready = true;\n');
    writeFileSync(join(publicDirectory, "landing-motion.js"), 'const MOTION_SOURCES = ["/vendor/gsap.js"];\nexport const ready = true;\n');
    writeFileSync(join(publicDirectory, "vendor", "gsap.js"), "window.gsap = {};\n");
    writeFileSync(join(publicDirectory, "font.woff2"), Buffer.from([0, 1, 2, 3, 4, 5]));
    writeFileSync(join(publicDirectory, "icon.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(join(publicDirectory, "icon-2x.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 11]));
    writeFileSync(join(publicDirectory, "site.webmanifest"), '{"name":"Scout"}');
    writeFileSync(join(publicDirectory, "index.html"), [
      "<!doctype html>",
      '<link rel="icon" href="/icon.png">',
      '<link rel="apple-touch-icon" href="/icon.png">',
      '<link rel="manifest" href="/site.webmanifest">',
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/redesign.css">',
      '<link rel="stylesheet" href="/catalog-freshness.css">',
      '<link rel="stylesheet" href="/conversion.css">',
      '<link rel="stylesheet" href="/themed-select.css">',
      '<script src="/vendor.js"></script>',
      '<script type="module" src="/themed-select.js"></script>',
      '<script type="module" src="/app.js"></script>',
      '<img src="/icon.png" srcset="/icon.png 1x, /icon-2x.png 2x">',
      '<a href="/jobs">Jobs</a>',
      '<script src="https://cdn.example.test/external.js"></script>',
    ].join(""));
    writeFileSync(join(publicDirectory, "landing.html"), [
      "<!doctype html>",
      '<link rel="icon" href="/icon.png">',
      '<link rel="preload" href="/font.woff2" as="font" type="font/woff2">',
      '<link rel="stylesheet" href="/landing.css">',
      '<script defer src="/landing.js"></script>',
      '<script type="module" src="/conversion.js"></script>',
      '<picture><source srcset="/icon.png 1x, /icon-2x.png 2x"><img src="/icon.png"></picture>',
      '<a href="/jobs">Jobs</a>',
      '<script src="https://cdn.example.test/external.js"></script>',
    ].join(""));
  });

  beforeEach(() => {
    clearResponseRepresentationCacheForTests();
    clearStaticDeliveryCachesForTests();
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("negotiates br/gzip/identity and reuses bounded encoded representations", () => {
    const body = JSON.stringify({
      items: Array.from({ length: 40 }, (_, index) => ({
        id: index,
        title: "Software Engineering Intern",
        description: "Repeated representative payload text for compression testing.",
      })),
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(1_024);

    const br = jsonCapture(body, { "accept-encoding": "br, gzip" });
    expect(br.statusCode).toBe(200);
    expect(br.headers["Content-Encoding"]).toBe("br");
    expect(br.headers["Cache-Control"]).toBe("no-store");
    expect(decodedBody(br).toString("utf8")).toBe(body);
    const afterFirst = getResponseRepresentationCacheStatsForTests();
    expect(afterFirst).toMatchObject({ entries: 1, misses: 1, hits: 0 });

    const brAgain = jsonCapture(body, { "accept-encoding": "br" });
    expect(brAgain.body.equals(br.body)).toBe(true);
    expect(getResponseRepresentationCacheStatsForTests().hits).toBe(1);

    const gzip = jsonCapture(body, { "accept-encoding": "br;q=0.2, gzip;q=1" });
    expect(gzip.headers["Content-Encoding"]).toBe("gzip");
    expect(decodedBody(gzip).toString("utf8")).toBe(body);

    const identity = jsonCapture(body, { "accept-encoding": "br;q=0, gzip;q=0" });
    expect(identity.headers["Content-Encoding"]).toBeUndefined();
    expect(identity.body.toString("utf8")).toBe(body);
    expect(identity.headers.Vary).toBe("Accept-Encoding, Cookie");
    expect(identity.headers["Content-Security-Policy"]).not.toContain("fonts.googleapis.com");
    expect(identity.headers["Content-Security-Policy"]).not.toContain("fonts.gstatic.com");

    const wildcard = jsonCapture(body, { "accept-encoding": "*;q=0.5" });
    expect(wildcard.headers["Content-Encoding"]).toBe("br");
    const malformedQuality = jsonCapture(body, { "accept-encoding": "br;q=invalid, gzip;q=0.2" });
    expect(malformedQuality.headers["Content-Encoding"]).toBe("gzip");
    const outOfRangeQuality = jsonCapture(body, { "accept-encoding": "br;q=1.1, gzip;q=0.2" });
    expect(outOfRangeQuality.headers["Content-Encoding"]).toBe("gzip");

    for (let index = 0; index < 180; index += 1) {
      jsonCapture(`${body}${index}`, { "accept-encoding": "br" });
    }
    const bounded = getResponseRepresentationCacheStatsForTests();
    expect(bounded.entries).toBeLessThanOrEqual(bounded.maxEntries);
    expect(bounded.bytes).toBeLessThanOrEqual(bounded.maxBytes);
  });

  it("keeps ETag validators representation independent and preserves HEAD framing", () => {
    const body = JSON.stringify({ items: ["x".repeat(2_000)] });
    const etag = "\"roles-v1\"";
    const coldStats = getResponseRepresentationCacheStatsForTests();
    const coldHead = jsonCapture(body, { "accept-encoding": "br" }, { method: "HEAD", etag: "\"cold\"" });
    expect(coldHead.statusCode).toBe(200);
    expect(coldHead.body.byteLength).toBe(0);
    expect(coldHead.headers["Content-Encoding"]).toBeUndefined();
    expect(coldHead.headers["Content-Length"]).toBeUndefined();
    expect(getResponseRepresentationCacheStatsForTests()).toEqual(coldStats);

    const first = jsonCapture(body, { "accept-encoding": "br" }, { etag });
    expect(first.statusCode).toBe(200);
    expect(first.headers.ETag).toBe(`W/${etag}`);
    expect(first.headers["Content-Encoding"]).toBe("br");

    const representationStatsBefore304 = getResponseRepresentationCacheStatsForTests();
    const unchanged = jsonCapture(body, {
      "accept-encoding": "gzip",
      "if-none-match": `"different", W/${etag}`,
    }, { etag });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body.byteLength).toBe(0);
    expect(unchanged.headers["Content-Length"]).toBeUndefined();
    expect(unchanged.headers["Content-Encoding"]).toBeUndefined();
    expect(unchanged.headers.Vary).toBe("Accept-Encoding, Cookie");
    expect(getResponseRepresentationCacheStatsForTests()).toEqual(representationStatsBefore304);

    const head = jsonCapture(body, { "accept-encoding": "gzip" }, { method: "HEAD", etag: "\"new\"" });
    expect(head.statusCode).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers["Content-Encoding"]).toBeUndefined();
    expect(head.headers["Content-Length"]).toBeUndefined();
  });

  it("compresses static text, validates immutable versions, and keeps binary MIME types uncompressed", async () => {
    const app = Buffer.from(`${"const listing = 'Software Engineering Intern';\n".repeat(5_000)}`);
    const version = createHash("sha256").update(app).digest("hex").slice(0, 12);
    const first = response();
    await serveStatic(
      request("/app.js", "GET", { "accept-encoding": "gzip" }) as never,
      first as never,
      "/app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(first.statusCode).toBe(200);
    expect(first.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(first.headers["Cache-Control"]).toBe("no-cache");
    expect(first.headers["Content-Encoding"]).toBe("gzip");
    expect(decodedBody(first).equals(app)).toBe(true);
    expect(first.headers.ETag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    expect(first.headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(first.headers["Content-Security-Policy"]).not.toContain("fonts.googleapis.com");
    expect(first.headers["Content-Security-Policy"]).not.toContain("fonts.gstatic.com");
    expect(first.headers["X-Content-Type-Options"]).toBe("nosniff");

    const immutable = response();
    await serveStatic(
      request(`/app.js?v=${version}`, "GET", { "accept-encoding": "br" }) as never,
      immutable as never,
      "/app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(immutable.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(immutable.headers["Content-Encoding"]).toBe("br");

    const staleVersion = response();
    await serveStatic(
      request("/app.js?v=000000000000", "GET", { "accept-encoding": "br" }) as never,
      staleVersion as never,
      "/app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(staleVersion.headers["Cache-Control"]).toBe("no-cache");

    const staticRepresentationStatsBefore304 = getResponseRepresentationCacheStatsForTests();
    const unchanged = response();
    await serveStatic(
      request("/app.js", "GET", { "if-none-match": first.headers.ETag ?? "" }) as never,
      unchanged as never,
      "/app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body.byteLength).toBe(0);
    expect(unchanged.headers["Content-Length"]).toBeUndefined();
    expect(unchanged.headers["Content-Encoding"]).toBeUndefined();
    expect(getResponseRepresentationCacheStatsForTests()).toEqual(staticRepresentationStatsBefore304);

    const representationStatsBeforeHead = getResponseRepresentationCacheStatsForTests();
    const head = response();
    await serveStatic(
      request(`/app.js?v=${version}`, "HEAD", { "accept-encoding": "br" }) as never,
      head as never,
      "/app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(head.statusCode).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers["Content-Encoding"]).toBeUndefined();
    expect(head.headers["Content-Length"]).toBeUndefined();
    expect(getResponseRepresentationCacheStatsForTests()).toEqual(representationStatsBeforeHead);
    const identityHead = response();
    await serveStatic(
      request("/app.js?v=" + version, "HEAD", { "accept-encoding": "identity" }) as never,
      identityHead as never,
      "/app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(identityHead.headers["Content-Encoding"]).toBeUndefined();
    expect(Number(identityHead.headers["Content-Length"])).toBe(app.byteLength);

    const index = response();
    await serveStatic(
      request("/jobs/", "GET", { "accept-encoding": "identity" }) as never,
      index as never,
      "/jobs/",
      { publicRoot: join(directory, "public") },
    );
    const indexBody = decodedBody(index).toString("utf8");
    const expectedIndexAssets: Array<["href" | "src", string]> = [
      ["href", "icon.png"],
      ["href", "site.webmanifest"],
      ["href", "styles.css"],
      ["href", "redesign.css"],
      ["href", "catalog-freshness.css"],
      ["href", "conversion.css"],
      ["href", "themed-select.css"],
      ["src", "vendor.js"],
      ["src", "themed-select.js"],
      ["src", "app.js"],
    ];
    for (const [attribute, fileName] of expectedIndexAssets) {
      const hash = createHash("sha256").update(readFileSync(join(directory, "public", fileName))).digest("hex").slice(0, 12);
      expect(indexBody).toContain(`${attribute}="/${fileName}?v=${hash}"`);
    }
    const iconHash = createHash("sha256").update(readFileSync(join(directory, "public", "icon.png"))).digest("hex").slice(0, 12);
    const icon2xHash = createHash("sha256").update(readFileSync(join(directory, "public", "icon-2x.png"))).digest("hex").slice(0, 12);
    expect(indexBody).toContain('src="/icon.png?v=' + iconHash + '"');
    expect(indexBody).toContain('srcset="/icon.png?v=' + iconHash + ' 1x, /icon-2x.png?v=' + icon2xHash + ' 2x"');
    expect(indexBody).toContain('<a href="/jobs">Jobs</a>');
    expect(indexBody).toContain('src="https://cdn.example.test/external.js"');

    const landing = response();
    await serveStatic(
      request("/", "GET", { "accept-encoding": "identity" }) as never,
      landing as never,
      "/",
      { publicRoot: join(directory, "public") },
    );
    const landingBody = decodedBody(landing).toString("utf8");
    const landingCss = response();
    await serveStatic(
      request("/landing.css", "GET", { "accept-encoding": "identity" }) as never,
      landingCss as never,
      "/landing.css",
      { publicRoot: join(directory, "public") },
    );
    const landingCssBody = decodedBody(landingCss);
    const landingCssHash = createHash("sha256").update(landingCssBody).digest("hex").slice(0, 12);
    const landingJs = response();
    await serveStatic(
      request("/landing.js", "GET", { "accept-encoding": "identity" }) as never,
      landingJs as never,
      "/landing.js",
      { publicRoot: join(directory, "public") },
    );
    const landingJsBody = decodedBody(landingJs).toString("utf8");
    const landingJsHash = createHash("sha256").update(Buffer.from(landingJsBody)).digest("hex").slice(0, 12);
    const landingMotion = response();
    await serveStatic(
      request("/landing-motion.js", "GET", { "accept-encoding": "identity" }) as never,
      landingMotion as never,
      "/landing-motion.js",
      { publicRoot: join(directory, "public") },
    );
    const landingMotionBody = decodedBody(landingMotion).toString("utf8");
    const landingMotionHash = createHash("sha256").update(Buffer.from(landingMotionBody)).digest("hex").slice(0, 12);
    const fontHash = createHash("sha256").update(readFileSync(join(directory, "public", "font.woff2"))).digest("hex").slice(0, 12);
    const vendorHash = createHash("sha256").update(readFileSync(join(directory, "public", "vendor", "gsap.js"))).digest("hex").slice(0, 12);
    for (const [attribute, fileName] of [
      ["href", "icon.png"],
      ["href", "font.woff2"],
      ["src", "conversion.js"],
    ] as const) {
      const hash = createHash("sha256").update(readFileSync(join(directory, "public", fileName))).digest("hex").slice(0, 12);
      expect(landingBody).toContain(`${attribute}="/${fileName}?v=${hash}"`);
    }
    expect(landingBody).toContain('href="/landing.css?v=' + landingCssHash + '"');
    expect(landingBody).toContain('src="/landing.js?v=' + landingJsHash + '"');
    expect(landingBody).toContain('href="/font.woff2?v=' + fontHash + '"');
    expect(landingBody).toContain('src="/icon.png?v=' + iconHash + '"');
    expect(landingBody).toContain('srcset="/icon.png?v=' + iconHash + ' 1x, /icon-2x.png?v=' + icon2xHash + ' 2x"');
    expect(landingCssBody.toString("utf8")).toContain('url("/font.woff2?v=' + fontHash + '")');
    expect(landingJsBody).toContain('import("/landing-motion.js?v=' + landingMotionHash + '")');
    expect(landingMotionBody).toContain('"/vendor/gsap.js?v=' + vendorHash + '"');
    expect(landingBody).toContain('<a href="/jobs">Jobs</a>');
    expect(landingBody).toContain('src="https://cdn.example.test/external.js"');

    const font = response();
    await serveStatic(
      request("/font.woff2", "GET", { "accept-encoding": "br" }) as never,
      font as never,
      "/font.woff2",
      { publicRoot: join(directory, "public") },
    );
    expect(font.statusCode).toBe(200);
    expect(font.headers["Content-Type"]).toBe("font/woff2");
    expect(font.headers["Content-Encoding"]).toBeUndefined();
    expect(font.body).toEqual(Buffer.from([0, 1, 2, 3, 4, 5]));

    const immutableFont = response();
    await serveStatic(
      request("/font.woff2?v=" + fontHash, "GET", { "accept-encoding": "br" }) as never,
      immutableFont as never,
      "/font.woff2",
      { publicRoot: join(directory, "public") },
    );
    expect(immutableFont.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    const staleFont = response();
    await serveStatic(
      request("/font.woff2?v=000000000000", "GET", { "accept-encoding": "br" }) as never,
      staleFont as never,
      "/font.woff2",
      { publicRoot: join(directory, "public") },
    );
    expect(staleFont.headers["Cache-Control"]).toBe("no-cache");

    const image = response();
    await serveStatic(
      request("/icon.png", "GET", { "accept-encoding": "gzip" }) as never,
      image as never,
      "/icon.png",
      { publicRoot: join(directory, "public") },
    );
    expect(image.headers["Content-Type"]).toBe("image/png");
    expect(image.headers["Content-Encoding"]).toBeUndefined();
  });

  it("invalidates bounded file and transformed-template caches after content changes", async () => {
    const publicRoot = join(directory, "public");
    const initialPage = response();
    await serveStatic(request("/jobs/", "GET", { "accept-encoding": "identity" }) as never, initialPage as never, "/jobs/", { publicRoot });
    const initialBody = decodedBody(initialPage);
    const initialStats = getStaticDeliveryCacheStatsForTests();
    expect(initialStats.files).toBeGreaterThan(0);
    expect(initialStats.templates).toBeGreaterThanOrEqual(1);

    const changedApp = Buffer.from("export const changed = true;\n".repeat(2_000));
    writeFileSync(join(publicRoot, "app.js"), changedApp);
    const changedPage = response();
    await serveStatic(request("/jobs/", "GET", { "accept-encoding": "identity" }) as never, changedPage as never, "/jobs/", { publicRoot });
    expect(decodedBody(changedPage)).not.toEqual(initialBody);
    expect(decodedBody(changedPage).toString("utf8")).toContain(`app.js?v=${createHash("sha256").update(changedApp).digest("hex").slice(0, 12)}`);
    expect(getStaticDeliveryCacheStatsForTests().templates).toBeGreaterThanOrEqual(1);

    const changedAsset = response();
    await serveStatic(request("/app.js", "GET", { "accept-encoding": "identity" }) as never, changedAsset as never, "/app.js", { publicRoot });
    expect(changedAsset.body).toEqual(changedApp);

    const changedRedesign = Buffer.from(".changed { color: #abcdef; }\n".repeat(100));
    writeFileSync(join(publicRoot, "redesign.css"), changedRedesign);
    const changedDependencyPage = response();
    await serveStatic(request("/jobs/", "GET", { "accept-encoding": "identity" }) as never, changedDependencyPage as never, "/jobs/", { publicRoot });
    const changedDependencyBody = decodedBody(changedDependencyPage).toString("utf8");
    expect(changedDependencyBody).toContain(`redesign.css?v=${createHash("sha256").update(changedRedesign).digest("hex").slice(0, 12)}`);

    for (let index = 0; index < 150; index += 1) {
      writeFileSync(join(publicRoot, `bounded-${index}.css`), `.bounded-${index} { color: #123456; }\n`);
      const asset = response();
      await serveStatic(request(`/bounded-${index}.css`, "GET", { "accept-encoding": "identity" }) as never, asset as never, `/bounded-${index}.css`, { publicRoot });
    }
    const bounded = getStaticDeliveryCacheStatsForTests();
    expect(bounded.files).toBeLessThanOrEqual(bounded.maxFiles);
    expect(bounded.bytes).toBeLessThanOrEqual(bounded.maxBytes);
  });

  it("preserves routed-template and path-containment boundaries", async () => {
    const rawTemplate = response();
    await serveStatic(
      request("/landing.html") as never,
      rawTemplate as never,
      "/landing.html",
      { publicRoot: join(directory, "public") },
    );
    expect(rawTemplate.statusCode).toBe(404);

    const traversal = response();
    await serveStatic(
      request("/../app.js") as never,
      traversal as never,
      "/../app.js",
      { publicRoot: join(directory, "public") },
    );
    expect(traversal.statusCode).toBe(400);
  });
});
