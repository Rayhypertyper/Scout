import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetBrowserHelperWrittenDraftCacheForTests } from "../src/browserHelper/writtenDraft.js";
import { saveResumeProfile } from "../src/resume/profile.js";
import type { Resume } from "../src/resume/tailor.js";
import { openAIResponse } from "./helpers/openaiResponse.js";
import { createAuthenticatedHarness, type AuthenticatedHarness } from "./authenticatedHarness.js";

const resume: Resume = {
  ownerEmail: "complete@e2e.example.test",
  name: "Morgan Lee",
  contact: ["morgan@example.test", "+1 416-555-0100", "12 Private Road, Toronto"],
  education: [{ title: "Waterloo University", subtitle: "Computer Science", date: "2024–2028", bullets: [] }],
  experience: [{ title: "Software Intern", subtitle: "Northstar Labs", date: "Summer 2025", bullets: ["Built a TypeScript REST API for account tools."] }],
  projects: [],
  awards: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
};

const draftRequest = {
  requestId: "draft-request-001",
  question: "Describe an example of your experience building software.",
  applicationUrl: "https://careers.example.test/jobs/role-1/apply#questions",
  company: "Northstar Labs",
  title: "Software Engineering Intern",
  applicationCountry: "Canada",
  locale: "en-CA",
  jobDescription: "Build and maintain software tools with a team. Candidates should discuss relevant development and testing experience.",
  candidateProfile: {
    experience: [{ company: "Northstar Labs", title: "Software Intern", startDate: "2025-05", endDate: "2025-08", description: "Built a TypeScript REST API for account tools.", currentlyWorkHere: false }],
    education: [{ school: "Waterloo University", degree: "BSc", fieldOfStudy: "Computer Science", startDate: "2024-09", endDate: "2028-04", gradeAverage: "" }],
    projects: [],
    languages: [{ language: "English", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" }],
    skills: [{ label: "Languages", items: ["TypeScript"] }],
  },
};

describe("browser helper Luna written-draft API", () => {
  let harness: AuthenticatedHarness;
  beforeAll(async () => { harness = await createAuthenticatedHarness(); });
  afterAll(async () => { await harness.close(); });
  afterEach(() => {
    resetBrowserHelperWrittenDraftCacheForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function authHeaders(session: "complete" | "zero" = "complete", includeCsrf = true): Promise<Record<string, string>> {
    const profile = await harness.request("/api/browser-helper/profile", { headers: { cookie: harness.sessionCookie(session) } });
    const csrf = (JSON.parse(profile.text) as { csrfToken: string }).csrfToken;
    return {
      cookie: `${harness.sessionCookie(session)}; rr-csrf=${csrf}`,
      origin: harness.baseUrl,
      ...(includeCsrf ? { "x-csrf-token": csrf } : {}),
      "x-scout-account-id": `e2e-${session}-user`,
      "content-type": "application/json",
    };
  }

  it("uses verified profile evidence, excludes identity and private contact data, pins Luna, and reuses the same scoped result", async () => {
    const headers = await authHeaders();
    saveResumeProfile(harness.databasePath, "e2e-complete-user", "complete@e2e.example.test", resume, "Morgan.pdf");
    const calls: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("OPENAI_MODEL", "some-other-model");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com")) return realFetch(input, init);
      const rawBody = init?.body;
      if (typeof rawBody !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) return Promise.resolve(openAIResponse({
        status: "ready",
        draft: "I built a TypeScript REST API for account tools during my software internship.",
        sourceRefs: ["resume.experience.0.bullets.0"],
        reason: "",
      }));
      return Promise.resolve(openAIResponse({ supported: true, unsupportedClaims: [] }));
    }));

    const first = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: JSON.stringify(draftRequest),
    });
    expect(first.response.status, first.text).toBe(200);
    expect(first.response.headers.get("cache-control")).toContain("no-store");
    const result = JSON.parse(first.text) as {
      draft: string; draftId: string; requestId: string; applicationUrl: string;
      sources: Array<{ sourceRef: string; label: string }>; model: string;
    };
    expect(result).toMatchObject({
      draft: "I built a TypeScript REST API for account tools during my software internship.",
      requestId: "draft-request-001",
      applicationUrl: "https://careers.example.test/jobs/role-1/apply",
      model: "gpt-6-luna",
      sources: [{ sourceRef: "resume.experience.0.bullets.0", label: "Saved resume · experience 1" }],
    });
    expect(result.draftId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.model).toBe("gpt-6-luna");
    const firstInput = JSON.stringify(calls[0]?.input);
    expect(firstInput).toContain("Built a TypeScript REST API for account tools.");
    expect(firstInput).not.toContain("Morgan Lee");
    expect(firstInput).not.toContain("morgan@example.test");
    expect(firstInput).not.toContain("416-555-0100");
    expect(firstInput).not.toContain("12 Private Road");
    expect(JSON.stringify(calls[1]?.input)).not.toContain("Morgan Lee");

    const retry = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, requestId: "draft-request-retry" }),
    });
    expect(retry.response.status, retry.text).toBe(200);
    const retryResult = JSON.parse(retry.text) as typeof result;
    expect(retryResult.requestId).toBe("draft-request-retry");
    expect(retryResult.draftId).toBe(result.draftId);
    expect(calls).toHaveLength(2);
  });

  it("rejects unverified mutations, CSRF/account mismatches, sensitive prompts, missing posting context, and unsafe data", async () => {
    const headers = await authHeaders();
    const noCsrf = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers: await authHeaders("complete", false), body: JSON.stringify(draftRequest),
    });
    expect(noCsrf.response.status).toBe(403);

    const changedAccount = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers: { ...headers, "x-scout-account-id": "e2e-zero-user" }, body: JSON.stringify(draftRequest),
    });
    expect(changedAccount.response.status).toBe(409);

    const unverified = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers: {
        cookie: harness.sessionCookie("unverified"), origin: harness.baseUrl,
        "content-type": "application/json", "x-scout-account-id": "e2e-unverified-user",
      },
      body: JSON.stringify(draftRequest),
    });
    expect(unverified.response.status).toBe(403);

    const sensitive = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, question: "Are you authorized to work in Canada?" }),
    });
    expect(sensitive.response.status).toBe(422);

    const missingPosting = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, jobDescription: "Software internship." }),
    });
    expect(missingPosting.response.status).toBe(422);

    const badCandidate = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, candidateProfile: { ...draftRequest.candidateProfile, email: "private@example.test" } }),
    });
    expect(badCandidate.response.status).toBe(400);

    const unsafeUrl = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, applicationUrl: "https://user:pass@careers.example.test/apply" }),
    });
    expect(unsafeUrl.response.status).toBe(400);

    const oversized = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: `{"extra":"${"x".repeat(100_000)}"}`,
    });
    expect(oversized.response.status).toBe(413);
  });

  it("returns no draft when Luna cannot support or verify its claims", async () => {
    const headers = await authHeaders();
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const realFetch = globalThis.fetch.bind(globalThis);
    let call = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com")) return realFetch(input, init);
      call += 1;
      if (call === 1) return Promise.resolve(openAIResponse({
        status: "insufficient_evidence", draft: "", sourceRefs: [], reason: "The saved facts do not cover this question.",
      }));
      if (call === 2) return Promise.resolve(openAIResponse({
        status: "ready", draft: "I built a TypeScript REST API for account tools.",
        sourceRefs: ["resume.experience.0.bullets.0"], reason: "",
      }));
      return Promise.resolve(openAIResponse({ supported: false, unsupportedClaims: ["unsupported"] }));
    }));
    const noRelevantEvidence = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, question: "Describe your language skills.", candidateProfile: { experience: [], education: [], projects: [], languages: [], skills: [] } }),
    });
    expect(noRelevantEvidence.response.status).toBe(422);
    expect(call).toBe(0);

    const noEvidence = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: JSON.stringify({ ...draftRequest, candidateProfile: { experience: [], education: [], projects: [], languages: [], skills: [] } }),
    });
    expect(noEvidence.response.status).toBe(422);
    expect(JSON.parse(noEvidence.text)).not.toHaveProperty("draft");
    expect(call).toBe(1);

    const unsupported = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: JSON.stringify(draftRequest),
    });
    expect(unsupported.response.status).toBe(422);
    expect(JSON.parse(unsupported.text)).not.toHaveProperty("draft");
    expect(call).toBe(3);
  });

  it("accepts the observed professional narrative prompts but keeps a plain yes/no prompt manual", async () => {
    const headers = await authHeaders();
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const realFetch = globalThis.fetch.bind(globalThis);
    let call = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com")) return realFetch(input, init);
      call += 1;
      return Promise.resolve(openAIResponse(call % 2 === 1
        ? {
          status: "ready", draft: "I built a TypeScript REST API for account tools.",
          sourceRefs: ["profile.experience.0.description"], reason: "",
        }
        : { supported: true, unsupportedClaims: [] }));
    }));

    const observedQuestions = [
      "Please take a moment to briefly highlight your relevant work experience.",
      "Do you have experience using the tools/systems/technology outlined in the job posting? Please explain.",
    ];
    for (const [index, question] of observedQuestions.entries()) {
      const response = await harness.request("/api/browser-helper/written-draft", {
        method: "POST", headers,
        body: JSON.stringify({
          ...draftRequest,
          requestId: `observed-question-${index}`,
          question,
          candidateProfile: {
            experience: [{ company: "Northstar Labs", title: "Software Intern", description: "Built a TypeScript REST API for account tools." }],
            education: [], projects: [], languages: [], skills: [],
          },
        }),
      });
      expect(response.response.status, response.text).toBe(200);
      expect(JSON.parse(response.text)).toMatchObject({ draft: "I built a TypeScript REST API for account tools.", requestId: `observed-question-${index}` });
    }

    const plainYesNo = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, question: "Do you have experience using the tools outlined in this role?" }),
    });
    expect(plainYesNo.response.status).toBe(422);
    expect(call).toBe(4);
  });

  it("prefers the matching Scout listing description and role details to client-supplied posting context", async () => {
    const headers = await authHeaders();
    saveResumeProfile(harness.databasePath, "e2e-complete-user", "complete@e2e.example.test", resume, "Morgan.pdf");
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const realFetch = globalThis.fetch.bind(globalThis);
    let call = 0;
    let modelPrompt = "";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com")) return realFetch(input, init);
      call += 1;
      const rawBody = init?.body;
      if (typeof rawBody !== "string") throw new Error("Expected a JSON request body.");
      const modelRequest = JSON.parse(rawBody) as { input?: Array<{ content?: Array<{ text?: string }> }> };
      const prompt = modelRequest.input?.[0]?.content?.[0]?.text ?? "";
      if (call === 1) {
        modelPrompt = prompt;
        return Promise.resolve(openAIResponse({
          status: "ready", draft: "I built a TypeScript REST API for account tools.",
          sourceRefs: ["resume.experience.0.bullets.0"], reason: "",
        }));
      }
      return Promise.resolve(openAIResponse({ supported: true, unsupportedClaims: [] }));
    }));

    const response = await harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({
        ...draftRequest,
        requestId: "scout-listing-context",
        applicationUrl: "https://jobs.example.test/match-preferred/apply",
        company: "Client Company Override",
        title: "Client Title Override",
        jobDescription: "Client Description Override is stale and must not be trusted for a matching Scout listing.",
      }),
    });
    expect(response.response.status, response.text).toBe(200);
    expect(call).toBe(2);
    expect(modelPrompt).toContain("Develop and test TypeScript software services");
    expect(modelPrompt).toContain("Alpha Match");
    expect(modelPrompt).toContain("Software Engineering Intern");
    expect(modelPrompt).not.toContain("Client Company Override");
    expect(modelPrompt).not.toContain("Client Description Override");
  });

  it("rejects a generated response if the saved resume changes while Luna is drafting", async () => {
    const headers = await authHeaders();
    saveResumeProfile(harness.databasePath, "e2e-complete-user", "complete@e2e.example.test", resume, "Morgan.pdf");
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const realFetch = globalThis.fetch.bind(globalThis);
    let call = 0;
    let releaseFirst: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstProviderResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com")) return realFetch(input, init);
      call += 1;
      if (call === 1) {
        markStarted?.();
        return firstProviderResponse;
      }
      return Promise.resolve(openAIResponse({ supported: true, unsupportedClaims: [] }));
    }));

    const pendingRequest = harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: JSON.stringify(draftRequest),
    });
    await providerStarted;
    const updatedResume = {
      ...resume,
      experience: [{ ...resume.experience[0]!, bullets: ["Updated evidence from the user's newly saved resume."] }],
    };
    saveResumeProfile(
      harness.databasePath,
      "e2e-complete-user",
      "complete@e2e.example.test",
      updatedResume,
      "Morgan.pdf",
      new Date(Date.now() + 60_000),
    );
    releaseFirst?.(openAIResponse({
      status: "ready",
      draft: "I built a TypeScript REST API for account tools during my software internship.",
      sourceRefs: ["resume.experience.0.bullets.0"],
      reason: "",
    }));

    const response = await pendingRequest;
    expect(response.response.status, response.text).toBe(409);
    expect(JSON.parse(response.text)).toMatchObject({ error: "The saved resume changed while Luna was drafting. Refresh the profile and try again." });
    expect(JSON.parse(response.text)).not.toHaveProperty("draft");
    expect(call).toBe(2);
  });

  it("deduplicates identical in-flight requests and limits concurrent drafts per account", async () => {
    const headers = await authHeaders();
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const realFetch = globalThis.fetch.bind(globalThis);
    let call = 0;
    let releaseFirst: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstProviderResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com")) return realFetch(input, init);
      call += 1;
      if (call === 1) {
        markStarted?.();
        return firstProviderResponse;
      }
      return Promise.resolve(openAIResponse({ supported: true, unsupportedClaims: [] }));
    }));

    const firstRequest = harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: JSON.stringify(draftRequest),
    });
    await providerStarted;
    const duplicateRequest = harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers, body: JSON.stringify({ ...draftRequest, requestId: "concurrent-retry" }),
    });
    const otherRequest = harness.request("/api/browser-helper/written-draft", {
      method: "POST", headers,
      body: JSON.stringify({ ...draftRequest, requestId: "another-question", question: "Please describe your approach to developing software." }),
    });
    const rejected = await otherRequest;
    expect(rejected.response.status).toBe(429);
    releaseFirst?.(openAIResponse({
      status: "ready", draft: "I built a TypeScript REST API for account tools.",
      sourceRefs: ["profile.experience.0.description"], reason: "",
    }));
    const [first, duplicate] = await Promise.all([firstRequest, duplicateRequest]);
    expect(first.response.status, first.text).toBe(200);
    expect(duplicate.response.status, duplicate.text).toBe(200);
    expect(JSON.parse(first.text)).toMatchObject({ requestId: "draft-request-001" });
    expect(JSON.parse(duplicate.text)).toMatchObject({ requestId: "concurrent-retry" });
    expect(call).toBe(2);
  });
});
