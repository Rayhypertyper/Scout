import { openAIEnvelope as responseEnvelope } from "./helpers/openaiResponse.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createAuthenticatedHarness } from "./authenticatedHarness.js";
import { saveResumeProfile } from "../src/resume/profile.js";
import type { Resume } from "../src/resume/tailor.js";

const profile: Resume = {
  ownerEmail: "complete@e2e.example.test",
  name: "Morgan Lee",
  contact: ["morgan@example.test"],
  education: [{ title: "University", subtitle: "Computer Science", date: "2024–2028", bullets: [] }],
  experience: [{ title: "Software Intern", subtitle: "Northstar Labs", date: "Summer 2025", bullets: ["Built a TypeScript REST API for account tools."] }],
  projects: [],
  awards: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
};

function openaiEnvelope(value: unknown): Response {
  if (value && typeof value === "object" && "bullets" in value && Array.isArray(value.bullets)) {
    value = { ...value, bullets: value.bullets.map((bullet: Record<string, unknown>) => ({ roleKeyword: "TypeScript", roleRequirement: "TypeScript", ...bullet })) };
  }
  return new Response(JSON.stringify({
    ...responseEnvelope(value),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

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
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

function request(url: URL, csrfToken: string, includeCsrf: boolean, kind: "resume" | "cover-letter" = "resume"): IncomingMessage {
  const body = Buffer.from(JSON.stringify({ kind }));
  const headers: Record<string, string> = {
    host: url.host,
    origin: url.origin,
    cookie: `rr-e2e-session=complete; rr-csrf=${csrfToken}`,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  if (includeCsrf) headers["x-csrf-token"] = csrfToken;
  return {
    method: "POST",
    url: `${url.pathname}`,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield body; },
  } as unknown as IncomingMessage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("authenticated application draft API", () => {
  it.each([false, true])("uses the signed-in account profile, requires CSRF, and returns an AI draft (correction needed: %s)", async (needsCorrection) => {
    const harness = await createAuthenticatedHarness();
    const providerPayloads = [
      ...(needsCorrection ? [{ bullets: [{ sourceRef: "experience.0.bullets.0", text: "Created 10 TypeScript REST services for account tools.", sourceRefs: ["experience.0.bullets.0"] }] }] : []),
      { bullets: [{ sourceRef: "experience.0.bullets.0", text: "Created a TypeScript REST service for account tools.", sourceRefs: ["experience.0.bullets.0"] }] },
      { checks: [{ id: "experience.0.bullets.0", supported: true, unsupportedClaims: [] }] },
    ];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (inputUrl.includes("api.openai.com")) {
        return Promise.resolve(openaiEnvelope(providerPayloads.shift()));
      }
      return realFetch(input, init);
    }));
    try {
      harness.useSession("complete");
      saveResumeProfile(harness.databasePath, "e2e-complete-user", "complete@e2e.example.test", profile, "Morgan.txt");
      const session = await harness.request("/api/auth/session");
      expect(session.response.status).toBe(200);
      const csrfToken = (JSON.parse(session.text) as { csrfToken: string }).csrfToken;

      const { requestHandler } = await import("../src/dashboard.js");
      const requestUrl = new URL("/api/application-drafts/internship/match-preferred", harness.baseUrl);
      const csrfRejected = response();
      await requestHandler(request(requestUrl, csrfToken, false), csrfRejected as unknown as ServerResponse, harness.databasePath);
      expect(csrfRejected.statusCode).toBe(403);
      expect(csrfRejected.headers["Cache-Control"]).toBe("private, no-store");

      const accepted = response();
      await requestHandler(request(requestUrl, csrfToken, true), accepted as unknown as ServerResponse, harness.databasePath);
      expect(accepted.statusCode, accepted.body.toString("utf8")).toBe(200);
      expect(accepted.headers["Cache-Control"]).toBe("private, no-store");
      const payload = JSON.parse(accepted.body.toString("utf8")) as { source: string; resume: Resume; warnings: string[] };
      expect(payload.source).toBe("llm");
      expect(payload.resume.name).toBe("Morgan Lee");
      expect(payload.resume.experience[0]?.title).toBe("Software Intern");
      expect(payload.resume.experience[0]?.bullets).toEqual(["Created a TypeScript REST service for account tools."]);
      expect(payload.warnings.join(" ")).toContain("Review every statement");
      expect(providerPayloads).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it.each(["success", "repair", "exhausted"] as const)("returns a private account-based cover letter or an actionable error (%s)", async (scenario) => {
    const harness = await createAuthenticatedHarness();
    const firstParagraph = { text: "My experience includes building a TypeScript REST API for account tools.", sourceRefs: ["experience.0.bullets.0"] };
    const secondParagraph = { text: "TypeScript is listed in my Languages skills.", sourceRefs: ["skills.0.items.0", "skills.0.label"] };
    const rejectedParagraph = { ...firstParagraph, text: "My experience includes building 10 TypeScript REST APIs for account tools." };
    const review = { checks: [
      { id: "cover-letter:paragraph.0", supported: true, unsupportedClaims: [] },
      { id: "cover-letter:paragraph.1", supported: true, unsupportedClaims: [] },
    ] };
    const correction = { paragraphs: [{ id: "cover-letter:paragraph.0", ...(scenario === "exhausted" ? rejectedParagraph : firstParagraph) }] };
    const providerPayloads: unknown[] = [
      { paragraphs: [scenario === "success" ? firstParagraph : rejectedParagraph, secondParagraph] },
      ...(scenario === "success" ? [review] : scenario === "repair" ? [correction, review] : [correction, correction]),
    ];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("OPENAI_MODEL", "gpt-6-luna");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("api.openai.com") ? Promise.resolve(openaiEnvelope(providerPayloads.shift())) : realFetch(input, init);
    }));
    try {
      harness.useSession("complete");
      saveResumeProfile(harness.databasePath, "e2e-complete-user", "complete@e2e.example.test", profile, "Morgan.txt");
      const session = await harness.request("/api/auth/session");
      const csrfToken = (JSON.parse(session.text) as { csrfToken: string }).csrfToken;
      const { requestHandler } = await import("../src/dashboard.js");
      const url = new URL("/api/application-drafts/internship/match-preferred", harness.baseUrl);
      const csrfRejected = response();
      await requestHandler(request(url, csrfToken, false, "cover-letter"), csrfRejected as unknown as ServerResponse, harness.databasePath);
      expect(csrfRejected.statusCode).toBe(403);
      const result = response();
      await requestHandler(request(url, csrfToken, true, "cover-letter"), result as unknown as ServerResponse, harness.databasePath);
      expect(result.headers["Cache-Control"]).toBe("private, no-store");
      if (scenario === "exhausted") {
        expect(result.statusCode).toBe(422);
        const payload = JSON.parse(result.body.toString("utf8")) as Record<string, unknown>;
        expect(payload.error).toContain("after 3 attempts");
        expect(payload).not.toHaveProperty("text");
        expect(payload).not.toHaveProperty("source");
      } else {
        expect(result.statusCode, result.body.toString("utf8")).toBe(200);
        const payload = JSON.parse(result.body.toString("utf8")) as { kind: string; source: string; text: string };
        expect(payload.kind).toBe("cover-letter");
        expect(payload.source).toBe("llm");
        expect(payload.text).toContain(firstParagraph.text);
        expect(payload.text).toContain(secondParagraph.text);
        expect(payload.text).toContain("Sincerely,\nMorgan Lee");
        expect(payload.text).not.toContain("10 TypeScript");
      }
      expect(providerPayloads).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
