import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handlePreferenceRequest } from "../src/preferences/http.js";
import { saveInternshipPreferenceStep } from "../src/preferences/store.js";
import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";
import { type AuthGateway, type AuthUser } from "../src/auth/types.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string | string[]>): void;
  end(body?: Buffer | string): void;
}

const VERIFIED_USER: AuthUser = {
  id: "preference-http-user",
  email: "student@example.com",
  emailVerified: true,
  createdAt: "2026-08-23T12:00:00.000Z",
};

const INCOMPLETE_USER: AuthUser = { ...VERIFIED_USER, emailVerified: false };
const csrf = "a".repeat(43);
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "roleradar-preferences-http-"));
  directories.push(directory);
  return join(directory, "preferences.db");
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
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    ...(body === undefined ? {} : {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield JSON.stringify(body);
      },
    }),
  } as unknown as IncomingMessage;
}

function payload(captured: CapturedResponse): Record<string, unknown> {
  return JSON.parse(captured.body.toString("utf8")) as Record<string, unknown>;
}

function fakeGateway(user: AuthUser | null): AuthGateway {
  return {
    async getCurrentUser() { return user; },
    async signUp() { throw new Error("not used"); },
    async signIn() { throw new Error("not used"); },
    async resendVerification() { throw new Error("not used"); },
    async requestPasswordReset() { throw new Error("not used"); },
    async verifyToken() { throw new Error("not used"); },
    async exchangeCode() { throw new Error("not used"); },
    async updatePassword() { throw new Error("not used"); },
    async signOut() { throw new Error("not used"); },
  };
}

describe("preference HTTP boundaries", () => {
  const previousEnvironment = {
    supabaseUrl: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    siteUrl: process.env.AUTH_SITE_URL,
  };
  let currentUser: AuthUser | null = VERIFIED_USER;

  beforeAll(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    process.env.AUTH_SITE_URL = "http://127.0.0.1:4173";
  });

  beforeEach(() => {
    setAuthGatewayFactoryForTests(() => fakeGateway(currentUser));
    currentUser = VERIFIED_USER;
  });

  afterEach(() => {
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  afterAll(() => {
    setAuthGatewayFactoryForTests(null);
    if (previousEnvironment.supabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousEnvironment.supabaseUrl;
    if (previousEnvironment.publishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = previousEnvironment.publishableKey;
    if (previousEnvironment.siteUrl === undefined) delete process.env.AUTH_SITE_URL;
    else process.env.AUTH_SITE_URL = previousEnvironment.siteUrl;
  });

  async function dispatch(
    method: string,
    url: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ handled: boolean; response: CapturedResponse }> {
    const captured = response();
    const handled = await handlePreferenceRequest(
      request(method, url, headers, body),
      captured as unknown as ServerResponse,
      new URL(url, "http://127.0.0.1:4173"),
      path,
    );
    return { handled, response: captured };
  }

  function complete(path: string): void {
    saveInternshipPreferenceStep(path, VERIFIED_USER.id, 1, {
      terms: [{ term: "summer", year: 2027 }],
    });
    saveInternshipPreferenceStep(path, VERIFIED_USER.id, 2, {
      countries: ["canada"],
      cities: [{ name: "Toronto", country: "canada" }],
      remote: true,
      roleCategories: ["swe"],
      technologies: ["TypeScript"],
    });
    saveInternshipPreferenceStep(path, VERIFIED_USER.id, 3, {
      degree: "bachelors",
      graduationYear: 2028,
      graduationYearOrLater: false,
      workAuthorization: { canada: "authorized", unitedStates: null },
      sponsorship: { canada: "none", unitedStates: null },
    });
  }

  it("protects onboarding and preference APIs, including unverified sessions", async () => {
    const path = databasePath();
    currentUser = null;
    const anonymous = await dispatch("GET", "/onboarding", path);
    expect(anonymous.handled).toBe(true);
    expect(anonymous.response.statusCode).toBe(303);
    expect(anonymous.response.headers.Location).toBe("/login?next=%2Fonboarding");

    currentUser = INCOMPLETE_USER;
    const unverified = await dispatch("GET", "/api/preferences", path);
    expect(unverified.response.statusCode).toBe(403);
    expect((payload(unverified.response).error as Record<string, unknown>).code).toBe("EMAIL_NOT_VERIFIED");
    const unverifiedPage = await dispatch("GET", "/onboarding", path);
    expect(unverifiedPage.response.statusCode).toBe(303);
    expect(unverifiedPage.response.headers.Location).toBe("/verify-email");
    const unverifiedMatches = await dispatch("GET", "/jobs?view=matches", path);
    expect(unverifiedMatches.response.statusCode).toBe(303);
    expect(unverifiedMatches.response.headers.Location).toBe("/verify-email");

    currentUser = VERIFIED_USER;
    const missingCsrf = await dispatch("PUT", "/api/preferences/steps/1", path, {
      origin: "http://127.0.0.1:4173",
      "content-type": "application/json",
    }, { terms: [{ term: "summer", year: 2027 }] });
    expect(missingCsrf.response.statusCode).toBe(403);
    expect((payload(missingCsrf.response).error as Record<string, unknown>).code).toBe("CSRF_INVALID");

    const crossOrigin = await dispatch("PUT", "/api/preferences/steps/1", path, {
      origin: "https://evil.example",
      cookie: `rr-csrf=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    }, { terms: [{ term: "summer", year: 2027 }] });
    expect(crossOrigin.response.statusCode).toBe(403);
    expect((payload(crossOrigin.response).error as Record<string, unknown>).code).toBe("ORIGIN_MISMATCH");
  });

  it("routes incomplete and completed users with all internships as the default view", async () => {
    const path = databasePath();
    const postLoginIncomplete = await dispatch("GET", "/post-login", path);
    expect(postLoginIncomplete.response.statusCode).toBe(303);
    expect(postLoginIncomplete.response.headers.Location).toBe("/onboarding");
    const postLoginIncompleteReturn = await dispatch("GET", "/post-login?returnTo=%2Faccount", path);
    expect(postLoginIncompleteReturn.response.statusCode).toBe(303);
    expect(postLoginIncompleteReturn.response.headers.Location).toBe("/onboarding");

    const all = await dispatch("GET", "/jobs?view=all", path);
    expect(all.handled).toBe(false);
    const matchesIncomplete = await dispatch("GET", "/jobs?view=matches", path);
    expect(matchesIncomplete.response.statusCode).toBe(303);
    expect(matchesIncomplete.response.headers.Location).toBe("/onboarding");

    complete(path);
    const postLoginComplete = await dispatch("GET", "/post-login", path);
    expect(postLoginComplete.response.statusCode).toBe(303);
    expect(postLoginComplete.response.headers.Location).toBe("/jobs?view=all&tab=main&sort=posted");
    const postLoginCompleteReturn = await dispatch("GET", "/post-login?returnTo=%2Faccount%3Ffrom%3Dsaved", path);
    expect(postLoginCompleteReturn.response.statusCode).toBe(303);
    expect(postLoginCompleteReturn.response.headers.Location).toBe("/account?from=saved");
    const postLoginUnsafeReturn = await dispatch("GET", "/post-login?returnTo=https%3A%2F%2Fevil.example", path);
    expect(postLoginUnsafeReturn.response.statusCode).toBe(303);
    expect(postLoginUnsafeReturn.response.headers.Location).toBe("/jobs?view=all&tab=main&sort=posted");
    const onboardingComplete = await dispatch("GET", "/onboarding", path);
    expect(onboardingComplete.response.statusCode).toBe(303);
    expect(onboardingComplete.response.headers.Location).toBe("/jobs?view=all&tab=main&sort=posted");
  });

  it("returns a CSRF token for reads and persists a valid incremental step", async () => {
    const path = databasePath();
    const read = await dispatch("GET", "/api/preferences", path);
    expect(read.response.statusCode).toBe(200);
    expect(payload(read.response).csrfToken).toEqual(expect.any(String));

    const saved = await dispatch("PUT", "/api/preferences/steps/1", path, {
      origin: "http://127.0.0.1:4173",
      cookie: `rr-csrf=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    }, { terms: [{ term: "summer", year: 2027 }] });
    expect(saved.response.statusCode).toBe(200);
    expect((payload(saved.response).preferences as Record<string, unknown>).terms).toEqual([{ term: "summer", year: 2027 }]);
  });

  it("rejects unsupported or wrong-country cities without advancing the preference step", async () => {
    const path = databasePath();
    const headers = {
      origin: "http://127.0.0.1:4173",
      cookie: `rr-csrf=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const base = {
      countries: ["canada"],
      remote: false,
      roleCategories: ["swe"],
      technologies: [],
    };
    const unsupported = await dispatch("PUT", "/api/preferences/steps/2", path, headers, {
      ...base,
      cities: [{ name: "NotAParserCity", country: "canada" }],
    });
    expect(unsupported.response.statusCode).toBe(422);
    expect((payload(unsupported.response).error as Record<string, unknown>).code).toBe("PREFERENCES_INVALID");

    const wrongCountry = await dispatch("PUT", "/api/preferences/steps/2", path, headers, {
      ...base,
      cities: [{ name: "Toronto", country: "united_states" }],
    });
    expect(wrongCountry.response.statusCode).toBe(422);
    expect((payload(wrongCountry.response).error as Record<string, unknown>).code).toBe("PREFERENCES_INVALID");

    const restored = await dispatch("GET", "/api/preferences", path);
    const preferences = payload(restored.response).preferences as Record<string, unknown>;
    expect(restored.response.statusCode).toBe(200);
    expect(preferences.currentStep).toBe(1);
    expect(preferences.cities).toEqual([]);
  });

  it("does not mislabel a local preference database failure as an auth failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roleradar-preferences-http-broken-"));
    directories.push(directory);
    const brokenPath = join(directory, "missing", "preferences.db");
    const read = await dispatch("GET", "/api/preferences", brokenPath);
    expect(read.response.statusCode).toBe(503);
    const error = payload(read.response).error as Record<string, unknown>;
    expect(error.code).toBe("PREFERENCES_UNAVAILABLE");
  });
});
