import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getResumeProfileDatabasePath, readBrowserHelperState, saveBrowserHelperProfile, saveResumeProfile } from "../src/resume/profile.js";
import { seedBrowserHelperProfile } from "../src/browserHelper/profile.js";
import { createAuthenticatedHarness, type AuthenticatedHarness } from "./authenticatedHarness.js";

interface HelperProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneType: string;
  phoneCountryCode: string;
  phoneExtension: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  education: Array<{ school: string; degree: string; fieldOfStudy: string; startDate: string; endDate: string; gradeAverage: string }>;
  experience: Array<{ company: string; title: string; startDate: string; endDate: string; description: string; location: string; currentlyWorkHere: boolean | null }>;
  experienceCount: number | null;
  workAuthorization: string;
  requiresSponsorship: string;
  previousWorker: boolean | null;
  hasPreferredName: boolean | null;
  preferredFirstName: string;
  preferredLastName: string;
  referralSources: string[];
  websites: Array<{ url: string }>;
  languages: Array<{ language: string; fluent: boolean | null; comprehension: string; overall: string; reading: string; speaking: string; writing: string }>;
}

interface HelperResponse {
  contract: string;
  accountId: string;
  profileSaved: boolean;
  profile: HelperProfile;
  answers: Array<{
    id: string;
    question: string;
    answer: string;
    answerType?: "text" | "single-choice" | "multi-choice" | "boolean";
    selectedChoices?: string[];
    booleanValue?: boolean;
    scope?: { origin?: string; country?: string; locale?: string };
    updatedAt?: string;
  }>;
  updatedAt: string | null;
  csrfToken?: string;
}

const resume = {
  name: "Morgan Lee",
  contact: ["morgan@example.com", "416-555-0100", "https://www.linkedin.com/in/morgan-lee"],
  education: [{ title: "University of Waterloo", subtitle: "Computer Science", date: "2024–2028", bullets: [] }],
  experience: [{ title: "Software Intern", subtitle: "Northstar Labs", date: "Summer 2025", bullets: ["Built TypeScript services"] }],
  projects: [],
  awards: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
};

function emptyProfile(email: string): HelperProfile {
  return {
    firstName: "", lastName: "", email, phone: "", phoneType: "", phoneCountryCode: "", phoneExtension: "",
    address: "", city: "", region: "", postalCode: "", country: "", linkedin: "", github: "", portfolio: "",
    education: [], experience: [], experienceCount: null, workAuthorization: "", requiresSponsorship: "", websites: [], languages: [],
    previousWorker: null, hasPreferredName: null, preferredFirstName: "", preferredLastName: "", referralSources: [],
  };
}

function helperHeaders(harness: AuthenticatedHarness, session: "complete" | "zero", csrf: string): Record<string, string> {
  return {
    cookie: `${harness.sessionCookie(session)}; rr-csrf=${csrf}`,
    origin: harness.baseUrl,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
}

function body<T>(result: { text: string }): T {
  return JSON.parse(result.text) as T;
}

describe("browser helper account API", () => {
  let harness: AuthenticatedHarness;
  beforeAll(async () => { harness = await createAuthenticatedHarness(); });
  afterAll(async () => { await harness.close(); });

  async function getHelper(session: "complete" | "zero" = "complete"): Promise<{ payload: HelperResponse; csrf: string }> {
    const result = await harness.request("/api/browser-helper/profile", { headers: { cookie: harness.sessionCookie(session) } });
    expect(result.response.status, result.text).toBe(200);
    expect(result.response.headers.get("cache-control")).toContain("no-store");
    const payload = body<HelperResponse>(result);
    return { payload, csrf: payload.csrfToken! };
  }

  it("returns a conservative resume seed and stable account identity", async () => {
    const untouched = await getHelper("zero");
    expect(untouched.payload.profileSaved).toBe(false);

    saveResumeProfile(harness.databasePath, "e2e-complete-user", "complete@e2e.example.test", resume, "Morgan.pdf");
    const { payload } = await getHelper();
    expect(payload.profileSaved).toBe(false);
    expect(payload.contract).toBe("scout.browser-helper.v1");
    expect(payload.accountId).toBe("e2e-complete-user");
    expect(payload.profile).toMatchObject({
      firstName: "Morgan",
      lastName: "Lee",
      email: "complete@e2e.example.test",
      phone: "416-555-0100",
      linkedin: "https://www.linkedin.com/in/morgan-lee",
      workAuthorization: "",
      requiresSponsorship: "",
      phoneType: "",
      phoneCountryCode: "",
      phoneExtension: "",
      previousWorker: null,
      hasPreferredName: null,
      preferredFirstName: "",
      preferredLastName: "",
      referralSources: [],
      websites: [],
      languages: [],
      experienceCount: null,
      education: [{ school: "University of Waterloo", gradeAverage: "", degree: "", fieldOfStudy: "" }],
      experience: [{ company: "Northstar Labs", title: "Software Intern", description: "Built TypeScript services", location: "", currentlyWorkHere: null }],
    });
    expect(payload.answers).toEqual([]);
  });

  it("requires a verified account before returning helper profile data", async () => {
    // A real loopback listener intentionally supports the established local-private
    // development identity. Mark this request as proxied so the assertion exercises
    // the authenticated/non-local boundary consistently in network and in-process runs.
    const anonymous = await harness.request("/api/browser-helper/profile", {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.headers.get("cache-control")).toContain("no-store");
    const unverified = await harness.request("/api/browser-helper/profile", {
      headers: { cookie: harness.sessionCookie("unverified") },
    });
    expect(unverified.response.status).toBe(403);
  });

  it("stores exact typed answers and distinct, canonical scoped variants", async () => {
    const { csrf } = await getHelper();
    const saveAnswer = async (value: Record<string, unknown>) => harness.request("/api/browser-helper/answers", {
      method: "PUT",
      headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify(value),
    });

    for (const invalid of [
      { question: "Bad single selection", answerType: "single-choice", selectedChoices: [] },
      { question: "Duplicate options", answerType: "multi-choice", selectedChoices: ["C++", "C++"] },
      { question: "Case-folded duplicate options", answerType: "multi-choice", selectedChoices: ["Mobile", "mobile"] },
      { question: "Whitespace duplicate options", answerType: "multi-choice", selectedChoices: ["Option  Alpha", "option   alpha"] },
      { question: "Unicode duplicate options", answerType: "multi-choice", selectedChoices: ["Café", "Cafe\u0301"] },
      { question: "Implicit boolean", answerType: "boolean", booleanValue: "false" },
      { question: "Unsafe scope", answerType: "text", answer: "No", scope: { origin: "ftp://jobs.example.test" } },
    ]) {
      const rejected = await saveAnswer(invalid);
      expect(rejected.response.status, rejected.text).toBe(400);
    }
    expect((await getHelper()).payload.answers).toEqual([]);

    const normalizedLabels = await saveAnswer({
      question: "Which exact labels did you review?",
      answerType: "multi-choice",
      selectedChoices: ["  Ｏｐｔｉｏｎ   Ａｌｐｈａ  ", "Café"],
    });
    expect(normalizedLabels.response.status, normalizedLabels.text).toBe(200);
    const normalizedLabelsSaved = body<{ answer: HelperResponse["answers"][number] }>(normalizedLabels).answer;
    expect(normalizedLabelsSaved.selectedChoices).toEqual(["Option Alpha", "Café"]);
    expect((await getHelper()).payload.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: normalizedLabelsSaved.id, selectedChoices: ["Option Alpha", "Café"] }),
    ]));

    const punctuationDistinct = await saveAnswer({
      question: "Which language labels are distinct?",
      answerType: "multi-choice",
      selectedChoices: ["C++", "C#"],
    });
    expect(punctuationDistinct.response.status, punctuationDistinct.text).toBe(200);
    const punctuationDistinctSaved = body<{ answer: HelperResponse["answers"][number] }>(punctuationDistinct).answer;
    expect(punctuationDistinctSaved.selectedChoices).toEqual(["C++", "C#"]);

    const globalNo = await saveAnswer({ question: "Do you agree to this reviewed statement?", answerType: "boolean", booleanValue: false });
    expect(globalNo.response.status, globalNo.text).toBe(200);
    const globalNoSaved = body<{ answer: HelperResponse["answers"][number] }>(globalNo).answer;
    expect(globalNoSaved).toMatchObject({ answerType: "boolean", answer: "", booleanValue: false });

    const countryYes = await saveAnswer({
      question: "Do you agree to this reviewed statement?",
      answerType: "boolean",
      booleanValue: true,
      scope: { country: "Canada" },
    });
    expect(countryYes.response.status, countryYes.text).toBe(200);
    const countryYesSaved = body<{ answer: HelperResponse["answers"][number] }>(countryYes).answer;
    expect(countryYesSaved.id).not.toBe(globalNoSaved.id);
    expect(countryYesSaved).toMatchObject({ answerType: "boolean", booleanValue: true, scope: { country: "Canada" } });

    const sameCountry = await saveAnswer({
      question: "  DO YOU AGREE TO THIS REVIEWED STATEMENT? ",
      answerType: "boolean",
      booleanValue: false,
      scope: { country: "canada" },
    });
    expect(body<{ answer: HelperResponse["answers"][number] }>(sameCountry).answer.id).toBe(countryYesSaved.id);

    const emptyMultiChoice = await saveAnswer({
      question: "Which optional groups did you select?",
      answerType: "multi-choice",
      selectedChoices: [],
      scope: { origin: "https://JOBS.example.test/career/apply" },
    });
    expect(emptyMultiChoice.response.status, emptyMultiChoice.text).toBe(200);
    const emptyChoiceSaved = body<{ answer: HelperResponse["answers"][number] }>(emptyMultiChoice).answer;
    expect(emptyChoiceSaved).toMatchObject({
      answerType: "multi-choice",
      answer: "",
      selectedChoices: [],
      scope: { origin: "https://jobs.example.test" },
    });

    const canonicalOrigin = await saveAnswer({
      question: "Which optional groups did you select?",
      answerType: "multi-choice",
      selectedChoices: ["First generation", "Transfer student"],
      scope: { origin: "https://jobs.example.test/another/path" },
    });
    expect(body<{ answer: HelperResponse["answers"][number] }>(canonicalOrigin).answer.id).toBe(emptyChoiceSaved.id);
    expect((await getHelper()).payload.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: globalNoSaved.id, booleanValue: false }),
      expect.objectContaining({ id: countryYesSaved.id, booleanValue: false, scope: { country: "canada" } }),
      expect.objectContaining({ id: emptyChoiceSaved.id, selectedChoices: ["First generation", "Transfer student"] }),
    ]));
    expect((await getHelper("zero")).payload.answers).toEqual([]);

    for (const id of [globalNoSaved.id, countryYesSaved.id, emptyChoiceSaved.id, normalizedLabelsSaved.id, punctuationDistinctSaved.id]) {
      const deleted = await harness.request("/api/browser-helper/answers", {
        method: "DELETE",
        headers: helperHeaders(harness, "complete", csrf),
        body: JSON.stringify({ id }),
      });
      expect(body<{ deleted: boolean }>(deleted).deleted).toBe(true);
    }
    expect((await getHelper()).payload.answers).toEqual([]);
  });

  it("migrates legacy text answers without changing their identity or content", () => {
    const directory = mkdtempSync(join(tmpdir(), "scout-browser-helper-migration-"));
    const crawlerPath = join(directory, "crawler.sqlite");
    const profilePath = getResumeProfileDatabasePath(crawlerPath);
    try {
      const database = new DatabaseSync(profilePath);
      try {
        database.exec("PRAGMA application_id = 0x52505246");
        database.exec(`CREATE TABLE browser_helper_answers (
          user_id TEXT NOT NULL,
          id TEXT NOT NULL,
          normalized_question TEXT NOT NULL,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, id),
          UNIQUE (user_id, normalized_question)
        )`);
        database.prepare(`INSERT INTO browser_helper_answers (
          user_id, id, normalized_question, question, answer, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "legacy-user", "legacy-answer-1", "what is your experience?", "What is your experience?", "Five years", "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z",
        );
        database.exec(`CREATE TRIGGER marked_answer_touch AFTER UPDATE ON browser_helper_answers
          BEGIN
            UPDATE browser_helper_answers
            SET updated_at = '2025-03-01T00:00:00.000Z'
            WHERE user_id = NEW.user_id AND id = NEW.id;
          END`);
      } finally {
        database.close();
      }
      chmodSync(profilePath, 0o600);

      const state = readBrowserHelperState(crawlerPath, "legacy-user");
      expect(state.answers).toEqual([expect.objectContaining({
        id: "legacy-answer-1",
        question: "What is your experience?",
        answer: "Five years",
        answerType: "text",
        updatedAt: "2025-02-01T00:00:00.000Z",
      })]);

      const migratedDatabase = new DatabaseSync(profilePath);
      try {
        const trigger = migratedDatabase.prepare(`
          SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'marked_answer_touch'
        `).get() as { sql?: string } | undefined;
        expect(trigger?.sql).toContain("ON browser_helper_answers");
        migratedDatabase.prepare(`
          UPDATE browser_helper_answers SET answer = ? WHERE user_id = ? AND id = ?
        `).run("Six years", "legacy-user", "legacy-answer-1");
      } finally {
        migratedDatabase.close();
      }
      expect(readBrowserHelperState(crawlerPath, "legacy-user").answers).toEqual([expect.objectContaining({
        id: "legacy-answer-1",
        answer: "Six years",
        updatedAt: "2025-03-01T00:00:00.000Z",
      })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires same-origin CSRF, validates profile fields, and isolates profile and answers by account", async () => {
    const { csrf } = await getHelper();
    const missingCsrf = await harness.request("/api/browser-helper/profile", {
      method: "PUT", headers: { cookie: harness.sessionCookie("complete"), "content-type": "application/json" },
      body: JSON.stringify({ profile: emptyProfile("complete@e2e.example.test") }),
    });
    expect(missingCsrf.response.status).toBe(403);

    const crossOrigin = await harness.request("/api/browser-helper/profile", {
      method: "PUT", headers: { ...helperHeaders(harness, "complete", csrf), origin: "https://attacker.example" },
      body: JSON.stringify({ profile: emptyProfile("complete@e2e.example.test") }),
    });
    expect(crossOrigin.response.status).toBe(403);

    for (const invalidProfile of [
      { ...emptyProfile("complete@e2e.example.test"), admin: true },
      { ...emptyProfile("complete@e2e.example.test"), referralSources: ["LinkedIn", "LinkedIn"] },
      { ...emptyProfile("complete@e2e.example.test"), phoneCountryCode: "x".repeat(101) },
      { ...emptyProfile("complete@e2e.example.test"), previousWorker: "false" },
      { ...emptyProfile("complete@e2e.example.test"), preferredFirstName: "x".repeat(501) },
      { ...emptyProfile("complete@e2e.example.test"), websites: [{ url: "javascript:alert(1)" }] },
      { ...emptyProfile("complete@e2e.example.test"), websites: [{ url: "https://user:pass@example.test" }] },
      { ...emptyProfile("complete@e2e.example.test"), languages: Array.from({ length: 21 }, (_, index) => ({ language: `Language ${index}`, fluent: null, comprehension: "", overall: "", reading: "", speaking: "", writing: "" })) },
      { ...emptyProfile("complete@e2e.example.test"), languages: [{ language: "Examplelang", fluent: true, comprehension: "", overall: "", reading: "", speaking: "", writing: "" }, { language: " exampleLANG ", fluent: false, comprehension: "", overall: "", reading: "", speaking: "", writing: "" }] },
      { ...emptyProfile("complete@e2e.example.test"), experienceCount: -1 },
      { ...emptyProfile("complete@e2e.example.test"), experienceCount: 21 },
      { ...emptyProfile("complete@e2e.example.test"), experienceCount: 1.5 },
    ]) {
      const invalid = await harness.request("/api/browser-helper/profile", {
        method: "PUT", headers: helperHeaders(harness, "complete", csrf),
        body: JSON.stringify({ profile: invalidProfile }),
      });
      expect(invalid.response.status).toBe(400);
    }

    const profile = {
      ...emptyProfile("complete@e2e.example.test"),
      firstName: "Morgan",
      workAuthorization: "Authorized to work in Canada",
      phoneType: "Mobile",
      phoneCountryCode: "Canada (+1)",
      phoneExtension: "042",
      previousWorker: false,
      hasPreferredName: true,
      preferredFirstName: "Morgan",
      preferredLastName: "M.",
      referralSources: ["University career center", "Employee referral"],
      websites: Array.from({ length: 40 }, (_, index) => ({ url: index % 2 === 0 ? `https://site-${index}.example.test` : "" })),
      experienceCount: 1,
      languages: [
        { language: "Examplelang", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" },
        { language: "Second Example Language", fluent: false, comprehension: "2 - Basic", overall: "2 - Basic", reading: "2 - Basic", speaking: "2 - Basic", writing: "2 - Basic" },
      ],
    };
    const saved = await harness.request("/api/browser-helper/profile", {
      method: "PUT", headers: helperHeaders(harness, "complete", csrf), body: JSON.stringify({ profile }),
    });
    expect(saved.response.status, saved.text).toBe(200);
    expect(body<HelperResponse>(saved).profile).toEqual(profile);

    const answerOne = await harness.request("/api/browser-helper/answers", {
      method: "PUT", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ question: "Will you require sponsorship?", answer: "No" }),
    });
    expect(answerOne.response.status, answerOne.text).toBe(200);
    const firstId = body<{ answer: { id: string } }>(answerOne).answer.id;
    const answerTwo = await harness.request("/api/browser-helper/answers", {
      method: "PUT", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ question: "  WILL   you require sponsorship? ", answer: "No, I am authorized to work in Canada." }),
    });
    expect(body<{ answer: { id: string } }>(answerTwo).answer.id).toBe(firstId);
    const cPlus = await harness.request("/api/browser-helper/answers", {
      method: "PUT", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ question: "Which languages have you used: C++?", answer: "C++" }),
    });
    const cSharp = await harness.request("/api/browser-helper/answers", {
      method: "PUT", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ question: "Which languages have you used: C#?", answer: "C#" }),
    });
    expect(body<{ answer: { id: string } }>(cPlus).answer.id).not.toBe(body<{ answer: { id: string } }>(cSharp).answer.id);

    const ownProfile = (await getHelper("complete")).payload;
    expect(ownProfile.profile.firstName).toBe("Morgan");
    expect(ownProfile.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstId, answer: "No, I am authorized to work in Canada." }),
      expect.objectContaining({ question: "Which languages have you used: C++?", answer: "C++" }),
      expect.objectContaining({ question: "Which languages have you used: C#?", answer: "C#" }),
    ]));
    const otherProfile = (await getHelper("zero")).payload;
    expect(otherProfile.accountId).toBe("e2e-zero-user");
    expect(otherProfile.profile).toEqual(emptyProfile("zero@e2e.example.test"));
    expect(otherProfile.answers).toEqual([]);

    const foreignDelete = await harness.request("/api/browser-helper/answers", {
      method: "DELETE", headers: helperHeaders(harness, "zero", csrf), body: JSON.stringify({ id: firstId }),
    });
    expect(foreignDelete.response.status).toBe(200);
    expect(body<{ deleted: boolean }>(foreignDelete).deleted).toBe(false);
    expect((await getHelper("complete")).payload.answers).toHaveLength(3);
    const ownDelete = await harness.request("/api/browser-helper/answers", {
      method: "DELETE", headers: helperHeaders(harness, "complete", csrf), body: JSON.stringify({ id: firstId }),
    });
    expect(body<{ deleted: boolean }>(ownDelete).deleted).toBe(true);
    expect((await getHelper("complete")).payload.answers).toHaveLength(2);
  });

  it("rejects helper mutations when the session account changes after the extension read", async () => {
    const { payload: before, csrf } = await getHelper("zero");
    const seedAnswer = await harness.request("/api/browser-helper/answers", {
      method: "PUT", headers: helperHeaders(harness, "zero", csrf),
      body: JSON.stringify({ question: "Account binding sentinel?", answer: "Keep this answer" }),
    });
    expect(seedAnswer.response.status, seedAnswer.text).toBe(200);
    const answerId = body<{ answer: { id: string } }>(seedAnswer).answer.id;
    const priorApplications = body<{ applications: unknown[] }>(
      await harness.request("/api/applications", { headers: { cookie: harness.sessionCookie("zero") } }),
    ).applications;
    const staleAccountHeaders = {
      ...helperHeaders(harness, "zero", csrf),
      "x-scout-account-id": "e2e-complete-user",
    };
    const changedProfile = await harness.request("/api/browser-helper/profile", {
      method: "PUT", headers: staleAccountHeaders,
      body: JSON.stringify({ profile: { ...before.profile, firstName: "Must not persist" } }),
    });
    expect(changedProfile.response.status).toBe(409);
    expect(body<{ error: string }>(changedProfile).error).toContain("account changed");

    const changedAnswer = await harness.request("/api/browser-helper/answers", {
      method: "PUT", headers: staleAccountHeaders,
      body: JSON.stringify({ question: "Must not be added?", answer: "No" }),
    });
    expect(changedAnswer.response.status).toBe(409);
    const changedDelete = await harness.request("/api/browser-helper/answers", {
      method: "DELETE", headers: staleAccountHeaders, body: JSON.stringify({ id: answerId }),
    });
    expect(changedDelete.response.status).toBe(409);

    const changedApplication = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: staleAccountHeaders,
      body: JSON.stringify({
        company: "Must not be tracked", title: "Backend Intern",
        applicationUrl: "https://account-race.example.test/apply", confirmedSubmitted: true,
      }),
    });
    expect(changedApplication.response.status).toBe(409);

    const after = (await getHelper("zero")).payload;
    expect(after.profile).toEqual(before.profile);
    expect(after.answers).toContainEqual(expect.objectContaining({ id: answerId, answer: "Keep this answer" }));
    expect(after.answers.some((answer) => answer.question === "Must not be added?")).toBe(false);
    const afterApplications = body<{ applications: unknown[] }>(
      await harness.request("/api/applications", { headers: { cookie: harness.sessionCookie("zero") } }),
    ).applications;
    expect(afterApplications).toEqual(priorApplications);
  });

  it("requires confirmed submission and logs by the resolved Scout listing without resetting progress", async () => {
    const { csrf } = await getHelper();
    const base = {
      company: "Untrusted company from the extension",
      title: "Untrusted title from the extension",
      applicationUrl: "https://jobs.example.test/match-preferred/apply?utm_source=scout",
    };
    const notConfirmed = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ ...base, confirmedSubmitted: false }),
    });
    expect(notConfirmed.response.status).toBe(400);

    const invalidUrl = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ ...base, applicationUrl: "javascript:alert(1)", confirmedSubmitted: true }),
    });
    expect(invalidUrl.response.status).toBe(400);

    const logged = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ ...base, confirmedSubmitted: true }),
    });
    expect(logged.response.status, logged.text).toBe(200);
    expect(body<{ logged: boolean; listingKey: string; alreadyLogged: boolean }>(logged)).toEqual({
      logged: true, listingKey: "internship:match-preferred", alreadyLogged: false,
    });

    const stage = await harness.request("/api/applications/status", {
      method: "POST", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ listingType: "internship", listingId: "match-preferred", stage: "interview" }),
    });
    expect(stage.response.status, stage.text).toBe(200);
    const before = body<{ applications: Array<{ listingId: string; company: string; title: string; stage: string; appliedAt: string }> }>(
      await harness.request("/api/applications", { headers: { cookie: `${harness.sessionCookie("complete")}; rr-csrf=${csrf}` } }),
    ).applications[0]!;
    expect(before).toMatchObject({ listingId: "match-preferred", company: "Alpha Match", title: "Software Engineering Intern", stage: "interview" });

    const retry = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: helperHeaders(harness, "complete", csrf),
      body: JSON.stringify({ ...base, confirmedSubmitted: true }),
    });
    expect(body<{ logged: boolean; listingKey: string; alreadyLogged: boolean }>(retry)).toEqual({
      logged: true, listingKey: "internship:match-preferred", alreadyLogged: true,
    });
    const after = body<{ applications: Array<{ listingId: string; stage: string; appliedAt: string }> }>(
      await harness.request("/api/applications", { headers: { cookie: `${harness.sessionCookie("complete")}; rr-csrf=${csrf}` } }),
    ).applications[0]!;
    expect(after.stage).toBe("interview");
    expect(after.appliedAt).toBe(before.appliedAt);
    const other = await harness.request("/api/applications", { headers: { cookie: harness.sessionCookie("zero") } });
    expect(body<{ applications: unknown[] }>(other).applications).toEqual([]);
  });

  it("rejects unpaired or unknown listing identities", async () => {
    const { csrf } = await getHelper();
    for (const payload of [
      { listingType: "internship", confirmedSubmitted: true },
      { listingType: "internship", listingId: "missing", confirmedSubmitted: true },
    ]) {
      const result = await harness.request("/api/browser-helper/applications", {
        method: "POST", headers: helperHeaders(harness, "complete", csrf),
        body: JSON.stringify({ company: "Acme", title: "Intern", applicationUrl: "https://example.org/apply", ...payload }),
      });
      expect(result.response.status).toBe(payload.listingId ? 404 : 400);
    }
  });

  it("caps a legacy resume seed and keeps saved helper data usable with long resume fields", async () => {
    const long = "A".repeat(1_800);
    const longResume = {
      name: long,
      contact: ["zero@e2e.example.test", "416-555-0101"],
      education: [{ title: long, subtitle: long, date: "2025", bullets: [] }],
      experience: [{ title: long, subtitle: long, date: "2025", bullets: [long, long, long] }],
      projects: [], awards: [], skills: [{ label: "Skills", items: ["TypeScript"] }],
    };
    saveResumeProfile(harness.databasePath, "e2e-zero-user", "zero@e2e.example.test", longResume, "Long.pdf");
    const unicodeSeed = seedBrowserHelperProfile({ ...longResume, ownerEmail: "zero@e2e.example.test", name: `A${"🙂".repeat(300)}` }, "zero@e2e.example.test");
    expect(unicodeSeed.firstName.length).toBeLessThanOrEqual(500);
    expect(unicodeSeed.phoneType).toBe("");
    expect(unicodeSeed.previousWorker).toBeNull();
    expect(unicodeSeed.hasPreferredName).toBeNull();
    expect(unicodeSeed.phoneCountryCode).toBe("");
    expect(unicodeSeed.phoneExtension).toBe("");
    expect(unicodeSeed.referralSources).toEqual([]);
    expect(/[\uD800-\uDBFF]$/u.test(unicodeSeed.firstName)).toBe(false);
    const initial = await getHelper("zero");
    expect(initial.payload.profile.firstName.length).toBeLessThanOrEqual(500);
    expect(initial.payload.profile.lastName.length).toBeLessThanOrEqual(500);
    expect(initial.payload.profile.education[0]?.school.length).toBeLessThanOrEqual(500);
    expect(initial.payload.profile.experience[0]?.description.length).toBeLessThanOrEqual(4_000);

    const savedProfile = { ...emptyProfile("zero@e2e.example.test"), firstName: "Saved", country: "Canada" };
    const saved = await harness.request("/api/browser-helper/profile", {
      method: "PUT", headers: helperHeaders(harness, "zero", initial.csrf), body: JSON.stringify({ profile: savedProfile }),
    });
    expect(saved.response.status, saved.text).toBe(200);
    expect(body<HelperResponse>(saved).profileSaved).toBe(true);
    expect((await getHelper("zero")).payload.profile).toEqual(savedProfile);
    expect((await getHelper("zero")).payload.profileSaved).toBe(true);
  });

  it("defaults new fields on old profiles and preserves them for an old client PUT", async () => {
    const legacyProfile: Record<string, unknown> = { ...emptyProfile("zero@e2e.example.test"), firstName: "Taylor" };
    delete legacyProfile.phoneType;
    delete legacyProfile.phoneCountryCode;
    delete legacyProfile.phoneExtension;
    delete legacyProfile.previousWorker;
    delete legacyProfile.hasPreferredName;
    delete legacyProfile.preferredFirstName;
    delete legacyProfile.preferredLastName;
    delete legacyProfile.referralSources;
    delete legacyProfile.websites;
    delete legacyProfile.languages;
    delete legacyProfile.experienceCount;
    legacyProfile.education = [{ school: "Legacy School", degree: "Degree", fieldOfStudy: "Field", startDate: "2024-09", endDate: "2028-04" }];
    legacyProfile.experience = [{ company: "Legacy Company", title: "Role", startDate: "2025-05", endDate: "", description: "Prior entry" }];
    saveBrowserHelperProfile(harness.databasePath, "e2e-zero-user", legacyProfile);

    const initial = await getHelper("zero");
    expect(initial.payload.profile).toMatchObject({
      phoneType: "",
      phoneCountryCode: "",
      phoneExtension: "",
      previousWorker: null,
      hasPreferredName: null,
      preferredFirstName: "",
      preferredLastName: "",
      referralSources: [],
      websites: [],
      languages: [],
      experienceCount: null,
      education: [{ school: "Legacy School", gradeAverage: "", degree: "Degree", fieldOfStudy: "Field", startDate: "2024-09", endDate: "2028-04" }],
      experience: [{ company: "Legacy Company", title: "Role", startDate: "2025-05", endDate: "", description: "Prior entry", location: "", currentlyWorkHere: null }],
    });
    const modernProfile = {
      ...initial.payload.profile,
      phoneType: "Mobile",
      phoneCountryCode: "Canada (+1)",
      phoneExtension: "17",
      previousWorker: false,
      hasPreferredName: true,
      preferredFirstName: "Tay",
      preferredLastName: "Ng",
      referralSources: ["University career center"],
      websites: [{ url: "https://portfolio.example.test" }, { url: "" }, { url: "" }, { url: "" }],
      languages: [{ language: "Examplelang", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" }],
      experienceCount: 1,
      education: [{ school: "Example University", degree: "BS", fieldOfStudy: "Computing", startDate: "2024-09", endDate: "2028-04", gradeAverage: "A" }],
      experience: [{ company: "Example Co", title: "Intern", startDate: "2025-05", endDate: "", description: "", location: "Remote", currentlyWorkHere: true }],
    };
    const modernSave = await harness.request("/api/browser-helper/profile", {
      method: "PUT",
      headers: helperHeaders(harness, "zero", initial.csrf),
      body: JSON.stringify({ profile: modernProfile }),
    });
    expect(modernSave.response.status, modernSave.text).toBe(200);

    const oldClientProfile = { ...modernProfile } as Record<string, unknown>;
    delete oldClientProfile.phoneType;
    delete oldClientProfile.phoneCountryCode;
    delete oldClientProfile.phoneExtension;
    delete oldClientProfile.previousWorker;
    delete oldClientProfile.hasPreferredName;
    delete oldClientProfile.preferredFirstName;
    delete oldClientProfile.preferredLastName;
    delete oldClientProfile.referralSources;
    delete oldClientProfile.websites;
    delete oldClientProfile.languages;
    delete oldClientProfile.experienceCount;
    const oldEducation = oldClientProfile.education as Array<Record<string, unknown>>;
    delete oldEducation[0]?.gradeAverage;
    const oldExperience = oldClientProfile.experience as Array<Record<string, unknown>>;
    delete oldExperience[0]?.location;
    delete oldExperience[0]?.currentlyWorkHere;
    oldClientProfile.firstName = "Updated by an older client";
    const oldClientSave = await harness.request("/api/browser-helper/profile", {
      method: "PUT",
      headers: helperHeaders(harness, "zero", initial.csrf),
      body: JSON.stringify({ profile: oldClientProfile }),
    });
    expect(oldClientSave.response.status, oldClientSave.text).toBe(200);
    expect(body<HelperResponse>(oldClientSave).profile).toMatchObject({
      firstName: "Updated by an older client",
      phoneType: "Mobile",
      phoneCountryCode: "Canada (+1)",
      phoneExtension: "17",
      previousWorker: false,
      hasPreferredName: true,
      preferredFirstName: "Tay",
      preferredLastName: "Ng",
      referralSources: ["University career center"],
      websites: [{ url: "https://portfolio.example.test" }, { url: "" }, { url: "" }, { url: "" }],
      languages: [{ language: "Examplelang", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" }],
      experienceCount: 1,
      education: [{ school: "Example University", degree: "BS", fieldOfStudy: "Computing", startDate: "2024-09", endDate: "2028-04", gradeAverage: "A" }],
      experience: [{ company: "Example Co", title: "Intern", startDate: "2025-05", endDate: "", description: "", location: "Remote", currentlyWorkHere: true }],
    });

    const explicitlyCleared = {
      ...body<HelperResponse>(oldClientSave).profile,
      previousWorker: null,
      hasPreferredName: null,
      preferredFirstName: "",
      preferredLastName: "",
      experienceCount: null,
      websites: [],
      languages: [],
      education: [{ school: "Example University", degree: "BS", fieldOfStudy: "Computing", startDate: "2024-09", endDate: "2028-04", gradeAverage: "" }],
      experience: [{ company: "Example Co", title: "Intern", startDate: "2025-05", endDate: "", description: "", location: "", currentlyWorkHere: null }],
    };
    const clearSave = await harness.request("/api/browser-helper/profile", {
      method: "PUT",
      headers: helperHeaders(harness, "zero", initial.csrf),
      body: JSON.stringify({ profile: explicitlyCleared }),
    });
    expect(clearSave.response.status, clearSave.text).toBe(200);
    expect(body<HelperResponse>(clearSave).profile).toMatchObject({
      previousWorker: null,
      hasPreferredName: null,
      preferredFirstName: "",
      preferredLastName: "",
      experienceCount: null,
      websites: [],
      languages: [],
      education: [{ gradeAverage: "" }],
      experience: [{ location: "", currentlyWorkHere: null }],
    });
    const zeroExperienceCount = {
      ...body<HelperResponse>(clearSave).profile,
      experienceCount: 0,
    };
    const zeroCountSave = await harness.request("/api/browser-helper/profile", {
      method: "PUT",
      headers: helperHeaders(harness, "zero", initial.csrf),
      body: JSON.stringify({ profile: zeroExperienceCount }),
    });
    expect(zeroCountSave.response.status, zeroCountSave.text).toBe(200);
    expect(body<HelperResponse>(zeroCountSave).profile).toMatchObject({
      experienceCount: 0,
      experience: [{ company: "Example Co" }],
    });

    const explicitlyEmpty = await harness.request("/api/browser-helper/profile", {
      method: "PUT",
      headers: helperHeaders(harness, "zero", initial.csrf),
      body: JSON.stringify({ profile: emptyProfile("zero@e2e.example.test") }),
    });
    expect(explicitlyEmpty.response.status, explicitlyEmpty.text).toBe(200);
    expect(body<HelperResponse>(explicitlyEmpty)).toMatchObject({ profileSaved: true, profile: emptyProfile("zero@e2e.example.test") });
    expect((await getHelper("zero")).payload.profileSaved).toBe(true);
  });

  it("logs external applications by a stable URL identity and deduplicates retries", async () => {
    const { csrf } = await getHelper("zero");
    const base = {
      company: "External Example",
      title: "Backend Intern",
      applicationUrl: "https://external.example.test/careers/backend-intern/apply?utm_campaign=browser-helper",
      confirmedSubmitted: true,
    };
    const first = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: helperHeaders(harness, "zero", csrf), body: JSON.stringify(base),
    });
    expect(first.response.status, first.text).toBe(200);
    const firstResult = body<{ logged: boolean; listingKey: string; alreadyLogged: boolean }>(first);
    expect(firstResult).toMatchObject({ logged: true, alreadyLogged: false });
    expect(firstResult.listingKey).toMatch(/^internship:browser-helper-[a-f0-9]{40}$/);

    const stage = await harness.request("/api/applications/status", {
      method: "POST", headers: helperHeaders(harness, "zero", csrf),
      body: JSON.stringify({ listingType: "internship", listingId: firstResult.listingKey.slice("internship:".length), stage: "recruiter" }),
    });
    expect(stage.response.status, stage.text).toBe(200);
    const retry = await harness.request("/api/browser-helper/applications", {
      method: "POST", headers: helperHeaders(harness, "zero", csrf),
      body: JSON.stringify({ ...base, applicationUrl: "https://external.example.test/careers/backend-intern/apply", confirmedSubmitted: true }),
    });
    expect(body<{ logged: boolean; listingKey: string; alreadyLogged: boolean }>(retry)).toEqual({
      logged: true, listingKey: firstResult.listingKey, alreadyLogged: true,
    });
    const tracked = body<{ applications: Array<{ listingKey: string; company: string; title: string; stage: string }> }>(
      await harness.request("/api/applications", { headers: { cookie: `${harness.sessionCookie("zero")}; rr-csrf=${csrf}` } }),
    ).applications;
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({
      listingKey: firstResult.listingKey,
      company: "External Example",
      title: "Backend Intern",
      stage: "recruiter",
    });
  });

  it("rejects oversized JSON before reading its body", async () => {
    const { csrf } = await getHelper();
    const { requestHandler } = await import("../src/dashboard.js");
    const request = {
      method: "PUT",
      url: "/api/browser-helper/profile",
      headers: {
        host: new URL(harness.baseUrl).host,
        origin: harness.baseUrl,
        cookie: `${harness.sessionCookie("complete")}; rr-csrf=${csrf}`,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        "content-length": String(256 * 1024 + 1),
      },
      socket: { remoteAddress: "127.0.0.1" },
      [Symbol.asyncIterator]() {
        return { async next() { throw new Error("An oversized request body should not be read."); } };
      },
    };
    let status = 500;
    let responseBody = "";
    const response = {
      writeHead(value: number) { status = value; },
      end(value?: string | Buffer) { responseBody = value?.toString() ?? ""; },
      setHeader() {},
    };
    await requestHandler(request as never, response as never, harness.databasePath);
    expect(status).toBe(413);
    expect(responseBody).toContain("too large");
  });
});
