import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStaticDeliveryCachesForTests, serveStatic } from "../src/dashboard/static.js";

const publicRoot = resolve(import.meta.dirname, "../public");

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string | string[]>): void;
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

function request(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: { host: "request-host.invalid", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

async function render(url: string, host = "request-host.invalid"): Promise<CapturedResponse> {
  const captured = response();
  const pathname = new URL(url, "http://" + host).pathname;
  await serveStatic(request(url, { host }), captured as unknown as ServerResponse, pathname, { publicRoot });
  return captured;
}

function bodyOf(captured: CapturedResponse): string {
  return captured.body.toString("utf8");
}

describe("public Scout SEO delivery", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SITE_URL", "https://scout.example");
    clearStaticDeliveryCachesForTests();
  });

  afterEach(() => {
    clearStaticDeliveryCachesForTests();
    vi.unstubAllEnvs();
  });

  it("renders crawlable landing metadata with absolute canonical and share URLs", async () => {
    const captured = await render("/?utm_source=share");
    const body = bodyOf(captured);

    expect(captured.statusCode).toBe(200);
    expect(body).toContain('<title>Software Internships &amp; Tech Internship Listings | Scout</title>');
    expect(body).toContain('name="robots" content="index, follow, max-image-preview:large"');
    expect(body).toContain('rel="canonical" href="https://scout.example/"');
    expect(body).toContain('property="og:url" content="https://scout.example/"');
    expect(body).toContain('property="og:image" content="https://scout.example/assets/brand/scout-logo.png"');
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    expect(body).toContain('name="twitter:image" content="https://scout.example/assets/brand/scout-logo.png"');
    expect(body).toContain('"@type": "WebSite"');
    expect(body).not.toContain("__LANDING_CANONICAL_URL__");
    expect(body).not.toContain("picsum.photos");
    expect(body).not.toContain("fonts.googleapis.com");
    expect(body).not.toContain("fonts.gstatic.com");
  });

  it("hands every landing-page browse action to the Canada tab", async () => {
    const body = bodyOf(await render("/"));
    const canadaHandoffs = body.match(/href="\/jobs\?view=all&amp;tab=canada&amp;sort=posted"/g) ?? [];

    expect(canadaHandoffs).toHaveLength(4);
    expect(body).not.toMatch(/href="\/jobs"/);
  });

  it("does not trust an arbitrary Host header when AUTH_SITE_URL is absent", async () => {
    vi.stubEnv("AUTH_SITE_URL", "");
    const captured = await render("/", "attacker.example");
    const body = bodyOf(captured);

    expect(body).toContain('rel="canonical" href="http://127.0.0.1:4173/"');
    expect(body).not.toContain("attacker.example");
  });

  it("keeps public listing discovery indexable while excluding personalized matches", async () => {
    const publicListings = await render("/jobs?view=all&tab=main&sort=posted&q=software");
    expect(bodyOf(publicListings)).toContain('rel="canonical" href="https://scout.example/jobs"');
    expect(bodyOf(publicListings)).toContain('name="robots" content="index, follow, max-image-preview:large"');
    expect(publicListings.headers["X-Robots-Tag"]).toBeUndefined();

    const matches = await render("/jobs?view=matches&tab=main&sort=relevance");
    expect(bodyOf(matches)).toContain('rel="canonical" href="https://scout.example/jobs"');
    expect(bodyOf(matches)).toContain('name="robots" content="noindex, nofollow, noarchive"');
    expect(matches.headers["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  it("does not leak request-shaped canonical metadata through the template cache", async () => {
    const first = await render("/");
    vi.stubEnv("AUTH_SITE_URL", "https://another.example");
    const second = await render("/");

    expect(bodyOf(first)).toContain('rel="canonical" href="https://scout.example/"');
    expect(bodyOf(second)).toContain('rel="canonical" href="https://another.example/"');
    expect(bodyOf(second)).not.toContain("https://scout.example/");
  });

  it("serves crawler discovery files, the manifest, and the social image as same-origin assets", async () => {
    const robots = await render("/robots.txt");
    expect(robots.statusCode).toBe(200);
    expect(robots.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(bodyOf(robots)).toContain("Disallow: /api/");
    expect(bodyOf(robots)).toContain("Sitemap: https://scout.example/sitemap.xml");

    const sitemap = await render("/sitemap.xml");
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers["Content-Type"]).toBe("application/xml; charset=utf-8");
    expect(bodyOf(sitemap)).toContain("<loc>https://scout.example/</loc>");
    expect(bodyOf(sitemap)).toContain("<loc>https://scout.example/jobs</loc>");
    expect(bodyOf(sitemap)).not.toContain("__SITEMAP_SITE_ORIGIN__");

    const manifest = await render("/site.webmanifest");
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["Content-Type"]).toBe("application/manifest+json; charset=utf-8");
    expect(JSON.parse(bodyOf(manifest))).toMatchObject({ start_url: "/", scope: "/" });

    const socialImage = await render("/assets/brand/scout-logo.png");
    expect(socialImage.statusCode).toBe(200);
    expect(socialImage.headers["Content-Type"]).toBe("image/png");
  });

  it("returns 404 for raw routed templates and unknown public paths", async () => {
    const rawTemplate = await render("/landing.html");
    expect(rawTemplate.statusCode).toBe(404);

    const missing = await render("/does-not-exist");
    expect(missing.statusCode).toBe(404);
  });

  it("marks account and preference templates as private crawl surfaces", async () => {
    const [authTemplate, preferenceTemplate] = await Promise.all([
      readFile(resolve(publicRoot, "auth/auth.html"), "utf8"),
      readFile(resolve(publicRoot, "onboarding/onboarding.html"), "utf8"),
    ]);

    expect(authTemplate).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />');
    expect(preferenceTemplate).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />');
  });
});
