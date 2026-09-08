import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";

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

function request(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:4173" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("public legal pages", () => {
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;

  beforeAll(async () => {
    ({ requestHandler } = await import("../src/dashboard.js"));
  });

  async function dispatch(method: string, url: string): Promise<CapturedResponse> {
    const captured = response();
    await requestHandler(
      request(method, url),
      captured as unknown as ServerResponse,
      "/tmp/legal-pages-test.db",
    );
    return captured;
  }

  it("serves Terms publicly without authentication and injects the canonical URL", async () => {
    const captured = await dispatch("GET", "/terms");
    const body = captured.body.toString("utf8");

    expect(captured.statusCode).toBe(200);
    expect(captured.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(body).toContain("<title>Terms of Service | Scout</title>");
    expect(body).toContain("Effective Date: August 30, 2026");
    expect(body).toContain('<link rel="canonical" href="http://127.0.0.1:4173/terms" />');
    expect(body).not.toContain("__TERMS_CANONICAL_URL__");
    expect(body).toContain("1. About Scout");
    expect(body).toContain("36. Contact");
    expect(body.match(/<section id=/g)).toHaveLength(36);
  });

  it("serves both legal routes publicly and links the documents to each other", async () => {
    const terms = await dispatch("GET", "/terms/");
    const privacy = await dispatch("GET", "/privacy");

    expect(terms.statusCode).toBe(200);
    expect(privacy.statusCode).toBe(200);
    expect(terms.body.toString("utf8")).toContain('href="/privacy"');
    expect(privacy.body.toString("utf8")).toContain('href="/terms"');
  });

  it("keeps the approved public entry points linked to both legal pages", async () => {
    const [landing, auth, dashboard, onboarding] = await Promise.all([
      readFile("public/landing.html", "utf8"),
      readFile("public/auth/auth.html", "utf8"),
      readFile("public/index.html", "utf8"),
      readFile("public/onboarding/onboarding.html", "utf8"),
    ]);

    expect(landing).toContain('href="/privacy"');
    expect(landing).toContain('href="/terms"');
    expect(auth).toContain(
      "By creating an account, you agree to Scout's <a href=\"/terms\">Terms of Service</a> and acknowledge the <a href=\"/privacy\">Privacy Policy</a>.",
    );
    expect(dashboard).toContain('href="/terms"');
    expect(onboarding).toContain('href="/terms"');
  });

  it("does not render secrets, private source inventory, admin controls, or sensitive profile fields", async () => {
    const terms = await dispatch("GET", "/terms");
    const body = terms.body.toString("utf8");

    expect(body).not.toMatch(/(?:SUPABASE|SERVICE_ROLE|SECRET_KEY|sk_live_|api\/dev\/edition|SCOUT_ENABLE_EDITION_SWITCHER)/i);
    expect(body).not.toMatch(/(?:@|street address|phone number|graduation year|work authorization answers|government identifier)/i);
    expect(body).not.toMatch(/(?:greenhouse|lever\.co|workday|linkedin\.com|jobright\.ai)\//i);
  });
});
