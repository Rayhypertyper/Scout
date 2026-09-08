import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import { STATIC_CONFIGURED_SOURCES } from "../src/config/sourceCatalog.js";
import { requestHandler } from "../src/dashboard.js";

const projectRoot = resolve(import.meta.dirname, "..");
const publicRoot = resolve(projectRoot, "public");
// SHA-256 of the supplied policy after removing Markdown-only formatting and
// collapsing whitespace. This keeps the exact-copy guard portable beyond the
// private attachment path used to provide the policy.
const EXPECTED_PRIVACY_POLICY_TEXT_HASH = "a6c0cf0dc358de8299ac4a7587a73e2f97c56ab3ffad1a4afbf20ff1d7aa7f54";

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

function request(url: string, method = "GET"): IncomingMessage {
  return {
    method,
    url,
    headers: { host: "scout.test" },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function bodyOf(captured: CapturedResponse): string {
  return captured.body.toString("utf8");
}

function serverResponse(captured: CapturedResponse): ServerResponse {
  return captured as unknown as ServerResponse;
}

function normalizePolicyText(value: string): string {
  return value
    .replace(/^\s*#{1,3}\s*/gm, "")
    .replace(/^\s*\*\s+/gm, "")
    .replaceAll("**", "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("public Scout Privacy Policy", () => {
  it("serves /privacy publicly with the attached policy copy and metadata", async () => {
    const captured = response();
    await requestHandler(request("/privacy"), serverResponse(captured), "/tmp/privacy-policy-test.db");

    expect(captured.statusCode).toBe(200);
    expect(captured.headers["Content-Type"]).toBe("text/html; charset=utf-8");

    const page = load(bodyOf(captured));
    const normalizedPageText = normalizePolicyText(page(".privacy-document").text());
    expect(createHash("sha256").update(normalizedPageText).digest("hex")).toBe(EXPECTED_PRIVACY_POLICY_TEXT_HASH);
    expect(page("title").text()).toBe("Privacy Policy | Scout");
    expect(page('meta[name="robots"]').attr("content")).toBe("index, follow");
    expect(page('meta[name="description"]').attr("content")).toContain("collects, uses, stores, and shares");
    expect(page('link[rel="canonical"]').attr("href")).toBe("http://scout.test/privacy");
    expect(bodyOf(captured)).toContain("Effective Date: August 30, 2026");
  });

  it("serves the slash variant and does not require authentication", async () => {
    const captured = response();
    await requestHandler(request("/privacy/"), serverResponse(captured), "/tmp/privacy-policy-test.db");

    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured)).toContain("Scout Privacy Policy");
  });

  it("does not render private configuration, source inventory, or secrets", async () => {
    const captured = response();
    await requestHandler(request("/privacy"), serverResponse(captured), "/tmp/privacy-policy-test.db");
    const body = bodyOf(captured);

    expect(body).not.toContain("SUPABASE_URL");
    expect(body).not.toContain("SUPABASE_PUBLISHABLE_KEY");
    expect(body).not.toContain("SCOUT_DATABASE_PATH");
    expect(body).not.toContain("SERVICE_ROLE");
    expect(body).not.toContain("sourceCatalog");
    for (const source of STATIC_CONFIGURED_SOURCES) expect(body).not.toContain(source);
  });

  it("links to Privacy from public, account, onboarding, and dashboard surfaces", async () => {
    const [landing, auth, onboarding, dashboard] = await Promise.all([
      readFile(resolve(publicRoot, "landing.html"), "utf8"),
      readFile(resolve(publicRoot, "auth/auth.html"), "utf8"),
      readFile(resolve(publicRoot, "onboarding/onboarding.html"), "utf8"),
      readFile(resolve(publicRoot, "index.html"), "utf8"),
    ]);

    expect(landing).toContain('href="/privacy"');
    expect(auth).toContain("By creating an account, you agree to Scout's");
    expect(auth).toContain('href="/terms">Terms of Service</a>');
    expect(auth).toContain('<a href="/privacy">Privacy Policy</a>');
    expect(onboarding).toContain('<a class="privacy-link" href="/privacy">Privacy Policy</a>');
    expect(dashboard).toContain('<a class="privacy-link" href="/privacy">Privacy Policy</a>');
    expect(dashboard).toContain('data-user-menu-action="privacy"');
  });

  it("labels external job and application destinations in the dashboard UI", async () => {
    const app = await readFile(resolve(publicRoot, "app.js"), "utf8");

    expect(app).toContain("Apply now (external site)");
    expect(app).toContain("Apply (external site)");
    expect(app).toContain("View posting (external site)");
    expect(app).toContain("Open application (external site)");
    expect(app).toContain("Apply directly (external site)");
    expect(app).toContain('rel="noopener noreferrer"');
  });
});
