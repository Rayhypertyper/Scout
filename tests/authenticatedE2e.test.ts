import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";
import {
  createAuthenticatedHarness,
  type AuthenticatedHarness,
} from "./authenticatedHarness.js";

type HarnessResult = Awaited<ReturnType<AuthenticatedHarness["request"]>>;
interface ErrorResponse {
  error: { code: string };
}

interface PreferenceState {
  currentStep: number;
  onboardingCompleted: boolean;
  completedAt: string | null;
  terms: unknown[];
  countries: unknown[];
  cities: unknown[];
}

interface PreferenceResponse extends ErrorResponse {
  csrfToken: string;
  preferences: PreferenceState;
  savedStep?: number;
  redirect?: string;
}

interface MatchItem {
  id: string;
  eligibility?: unknown;
  eligibilityStatus: string;
  eligibilityVersion: string;
  eligibilityReasons: string[];
  eligibilityUnknown: string[];
  matchReasons: string[];
}

interface RolesResponse {
  contract: string;
  view: string;
  pagination: { total: number; hasMore: boolean };
  items: MatchItem[];
}

interface ApplicationsResponse {
  applications: unknown[];
  counts: { all: number };
}

function payload<T extends object = Record<string, unknown>>(result: HarnessResult): T {
  return JSON.parse(result.text) as T;
}

function location(result: HarnessResult): string {
  return result.response.headers.get("location") ?? "";
}

function csrfHeaders(harness: AuthenticatedHarness, token: string): Record<string, string> {
  return {
    origin: harness.baseUrl,
    "content-type": "application/json",
    "x-csrf-token": token,
  };
}

const canadaTerms = { terms: [{ term: "summer", year: 2027 }] };
const canadaSearch = {
  countries: ["canada"],
  cities: [{ name: "Toronto", country: "canada" }],
  remote: false,
  roleCategories: ["swe"],
  technologies: ["TypeScript"],
};
const canadaEligibility = {
  degree: "bachelors",
  graduationYear: 2028,
  graduationYearOrLater: false,
  workAuthorization: { canada: "authorized", unitedStates: null },
  sponsorship: { canada: "none", unitedStates: null },
};

async function saveStep(
  harness: AuthenticatedHarness,
  token: string,
  step: 1 | 2 | 3,
  body: Record<string, unknown>,
): Promise<HarnessResult> {
  return harness.request(`/api/preferences/steps/${step}`, {
    method: "PUT",
    headers: csrfHeaders(harness, token),
    body: JSON.stringify(body),
  });
}

describe("authenticated onboarding and matches harness", () => {
  let harness: AuthenticatedHarness;

  beforeAll(async () => {
    harness = await createAuthenticatedHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("fails closed for anonymous and unverified sessions, while preserving explicit all access", async () => {
    harness.useSession("anonymous");

    const anonymousOnboarding = await harness.request("/onboarding");
    expect(anonymousOnboarding.response.status).toBe(303);
    expect(location(anonymousOnboarding)).toBe("/login?next=%2Fonboarding");

    const anonymousPreferences = await harness.request("/api/preferences");
    expect(anonymousPreferences.response.status).toBe(401);
    expect(payload<ErrorResponse>(anonymousPreferences).error.code).toBe("AUTH_REQUIRED");

    const anonymousMatches = await harness.request("/api/roles?view=matches&tab=main&sort=relevance");
    expect(anonymousMatches.response.status).toBe(401);
    expect(payload<ErrorResponse>(anonymousMatches).error.code).toBe("AUTH_REQUIRED");

    const allPage = await harness.request("/jobs?view=all&tab=main&sort=posted");
    expect(allPage.response.status).toBe(200);
    expect(allPage.text).toContain('id="role-list"');

    const allApi = await harness.request("/api/roles?view=all&tab=main&sort=posted&limit=10");
    expect(allApi.response.status).toBe(200);
    const allPayload = payload<RolesResponse>(allApi);
    expect(allPayload.view).toBe("all");
    expect(allPayload.items.length).toBeGreaterThan(0);
    expect(allPayload.items[0]?.eligibility).toBeUndefined();

    harness.useSession("unverified");
    const unverifiedOnboarding = await harness.request("/onboarding");
    expect(unverifiedOnboarding.response.status).toBe(303);
    expect(location(unverifiedOnboarding)).toBe("/verify-email");

    const unverifiedPreferences = await harness.request("/api/preferences");
    expect(unverifiedPreferences.response.status).toBe(403);
    expect(payload<ErrorResponse>(unverifiedPreferences).error.code).toBe("EMAIL_NOT_VERIFIED");

    const unverifiedMatches = await harness.request("/jobs?view=matches&tab=main");
    expect(unverifiedMatches.response.status).toBe(303);
    expect(location(unverifiedMatches)).toBe("/verify-email");
  });

  it("routes incomplete users through post-login onboarding and persists each step across refresh", async () => {
    harness.useSession("incomplete");

    const postLogin = await harness.request("/post-login?returnTo=%2Faccount%3Ffrom%3Dsaved");
    expect(postLogin.response.status).toBe(303);
    expect(location(postLogin)).toBe("/onboarding");

    const onboarding = await harness.request("/onboarding");
    expect(onboarding.response.status).toBe(200);
    expect(onboarding.text).toContain('id="preference-form"');
    expect(onboarding.text).toContain('id="step-count"');
    expect(onboarding.text).toContain('id="continue-button"');
    expect(onboarding.text).toContain('id="back-button"');
    expect(onboarding.text).toContain('data-preference-mode="onboarding"');

    const initial = await harness.request("/api/preferences");
    expect(initial.response.status).toBe(200);
    const initialPayload = payload<PreferenceResponse>(initial);
    expect(initialPayload.preferences.currentStep).toBe(1);
    expect(initialPayload.preferences.onboardingCompleted).toBe(false);
    expect(initialPayload.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const csrfToken = initialPayload.csrfToken;

    const first = await saveStep(harness, csrfToken, 1, canadaTerms);
    expect(first.response.status).toBe(200);
    const firstPayload = payload<PreferenceResponse>(first);
    expect(firstPayload.savedStep).toBe(1);
    expect(firstPayload.preferences.currentStep).toBe(2);
    expect(firstPayload.preferences.onboardingCompleted).toBe(false);

    // The same request path used by the browser after a refresh/back action
    // restores the persisted partial state rather than restarting at step 1.
    const refreshedPage = await harness.request("/onboarding");
    expect(refreshedPage.response.status).toBe(200);
    const refreshed = await harness.request("/api/preferences");
    const refreshedPayload = payload<PreferenceResponse>(refreshed);
    expect(refreshedPayload.preferences.currentStep).toBe(2);
    expect(refreshedPayload.preferences.terms).toEqual(canadaTerms.terms);
  });

  it("rejects failed saves without advancing, and makes duplicate step saves idempotent", async () => {
    harness.useSession("incomplete");
    const initial = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    const csrfToken = initial.csrfToken;

    const invalidStep = await saveStep(harness, csrfToken, 2, {
      countries: [],
      cities: [],
      remote: false,
      roleCategories: [],
      technologies: [],
    });
    expect(invalidStep.response.status).toBe(422);
    expect(payload<ErrorResponse>(invalidStep).error.code).toBe("PREFERENCES_INVALID");

    const afterInvalid = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    expect(afterInvalid.preferences.currentStep).toBe(2);
    expect(afterInvalid.preferences.onboardingCompleted).toBe(false);
    expect(afterInvalid.preferences.countries).toEqual([]);

    const duplicateResults = await Promise.all([
      saveStep(harness, csrfToken, 2, canadaSearch),
      saveStep(harness, csrfToken, 2, canadaSearch),
    ]);
    expect(duplicateResults.map((result) => result.response.status)).toEqual([200, 200]);
    for (const result of duplicateResults) {
      const duplicate = payload<PreferenceResponse>(result);
      expect(duplicate.savedStep).toBe(2);
      expect(duplicate.preferences.currentStep).toBe(3);
      expect(duplicate.preferences.onboardingCompleted).toBe(false);
    }

    const afterDuplicate = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    expect(afterDuplicate.preferences.currentStep).toBe(3);
    expect(afterDuplicate.preferences.cities).toEqual(canadaSearch.cities);
  });

  it("does not finalize on an invalid last step, then renders deterministic personalized matches", async () => {
    harness.useSession("incomplete");
    const beforeFinal = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    const csrfToken = beforeFinal.csrfToken;

    const invalidFinal = await saveStep(harness, csrfToken, 3, {
      degree: null,
      graduationYear: null,
      graduationYearOrLater: false,
      workAuthorization: { canada: null, unitedStates: null },
      sponsorship: { canada: null, unitedStates: null },
    });
    expect(invalidFinal.response.status).toBe(422);
    expect(payload<ErrorResponse>(invalidFinal).error.code).toBe("PREFERENCES_INVALID");

    const stillIncomplete = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    expect(stillIncomplete.preferences.currentStep).toBe(3);
    expect(stillIncomplete.preferences.onboardingCompleted).toBe(false);
    expect(stillIncomplete.preferences.completedAt).toBeNull();

    const final = await saveStep(harness, csrfToken, 3, canadaEligibility);
    expect(final.response.status).toBe(200);
    const finalPayload = payload<PreferenceResponse>(final);
    expect(finalPayload.redirect).toBe("/jobs?view=all&tab=main&sort=posted");
    expect(finalPayload.preferences.onboardingCompleted).toBe(true);
    expect(finalPayload.preferences.completedAt).toEqual(expect.any(String));

    const defaultJobs = await harness.request("/jobs");
    expect(defaultJobs.response.status).toBe(303);
    expect(location(defaultJobs)).toBe("/jobs?view=all&tab=main&sort=posted");
    const postLogin = await harness.request("/post-login");
    expect(postLogin.response.status).toBe(303);
    expect(location(postLogin)).toBe("/jobs?view=all&tab=main&sort=posted");
    const onboardingAfterCompletion = await harness.request("/onboarding");
    expect(onboardingAfterCompletion.response.status).toBe(303);
    expect(location(onboardingAfterCompletion)).toBe("/jobs?view=all&tab=main&sort=posted");

    const matches = await harness.request("/api/roles?view=matches&tab=main&sort=relevance&limit=10");
    expect(matches.response.status).toBe(200);
    const matchPayload = payload<RolesResponse>(matches);
    expect(matchPayload.contract).toBe("dashboard.roles.v1");
    expect(matchPayload.view).toBe("matches");
    expect(matchPayload.pagination.total).toBe(matchPayload.items.length);
    expect(matchPayload.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      "match-preferred",
      "match-secondary",
      "match-unknown",
    ]));
    expect(matchPayload.items).toHaveLength(3);
    for (const item of matchPayload.items) {
      expect(item.eligibilityStatus).not.toBe("not_eligible");
      expect(item.eligibilityVersion).toBe("eligibility-v1");
      expect(item.eligibilityReasons).toEqual(expect.any(Array));
      expect(item.eligibilityUnknown).toEqual(expect.any(Array));
      expect(item.matchReasons).toEqual(expect.any(Array));
      expect(item.matchReasons.join(" ")).not.toContain("relevance");
    }
    const repeatedMatches = payload<RolesResponse>(await harness.request("/api/roles?view=matches&tab=main&sort=relevance&limit=10"));
    expect(repeatedMatches.items.map((item) => item.id)).toEqual(matchPayload.items.map((item) => item.id));
  });

  it("keeps a completed profile complete while editing, and exposes the zero-match state", async () => {
    harness.useSession("complete");
    const editPage = await harness.request("/preferences");
    expect(editPage.response.status).toBe(200);
    expect(editPage.text).toContain('data-preference-mode="edit"');
    expect(editPage.text).toContain('id="preference-form"');
    const editState = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    expect(editState.preferences.onboardingCompleted).toBe(true);
    const editCsrf = editState.csrfToken;
    const edited = await saveStep(harness, editCsrf, 1, { terms: [{ term: "fall", year: 2027 }] });
    expect(edited.response.status).toBe(200);
    expect(payload<PreferenceResponse>(edited).preferences.onboardingCompleted).toBe(true);
    const editedPostLogin = await harness.request("/post-login");
    expect(editedPostLogin.response.status).toBe(303);
    expect(location(editedPostLogin)).toBe("/jobs?view=all&tab=main&sort=posted");

    // The zero profile selects a reliably incompatible country and term. The
    // fixture's unknown-term role has an explicit Canadian remote scope, so
    // it is not accidentally counted as a US match.
    harness.useSession("zero");
    const zeroInitial = payload<PreferenceResponse>(await harness.request("/api/preferences"));
    const zeroCsrf = zeroInitial.csrfToken;
    expect((await saveStep(harness, zeroCsrf, 1, { terms: [{ term: "winter", year: 2026 }] })).response.status).toBe(200);
    expect((await saveStep(harness, zeroCsrf, 2, {
      countries: ["united_states"],
      cities: [],
      remote: false,
      roleCategories: ["swe"],
      technologies: ["TypeScript"],
    })).response.status).toBe(200);
    const zeroFinal = await saveStep(harness, zeroCsrf, 3, {
      degree: "bachelors",
      graduationYear: 2028,
      graduationYearOrLater: false,
      workAuthorization: { canada: null, unitedStates: "authorized" },
      sponsorship: { canada: null, unitedStates: "none" },
    });
    expect(zeroFinal.response.status).toBe(200);
    expect(payload<PreferenceResponse>(zeroFinal).preferences.onboardingCompleted).toBe(true);
    const zeroMatches = payload<RolesResponse>(await harness.request("/api/roles?view=matches&tab=main&sort=relevance&limit=10"));
    expect(zeroMatches.pagination.total).toBe(0);
    expect(zeroMatches.pagination.hasMore).toBe(false);
    expect(zeroMatches.items).toEqual([]);
    const applications = payload<ApplicationsResponse>(await harness.request("/api/applications"));
    expect(applications.applications).toEqual([]);
    expect(applications.counts.all).toBe(0);
  });

  it("cannot activate the injected session through production requests or user-controlled headers", async () => {
    harness.useSession("anonymous");
    const previous = {
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_PUBLISHABLE_KEY,
      site: process.env.AUTH_SITE_URL,
    };
    setAuthGatewayFactoryForTests(null);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    try {
      const spoofed = await harness.request("/api/preferences", {
        headers: {
          cookie: harness.sessionCookie("complete"),
          "x-e2e-session": "complete",
          "x-test-auth-user": "e2e-complete-user",
        },
      });
      expect(spoofed.response.status).toBe(503);
      expect(payload<ErrorResponse>(spoofed).error.code).toBe("AUTH_NOT_CONFIGURED");
    } finally {
      if (previous.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
      else process.env.SUPABASE_PUBLISHABLE_KEY = previous.key;
      if (previous.site === undefined) delete process.env.AUTH_SITE_URL;
      else process.env.AUTH_SITE_URL = previous.site;
      harness.installAuthFactory();
    }
  });
});
