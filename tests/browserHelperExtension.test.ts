import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { chromium, type BrowserContext, type Page } from "playwright";
import { describe, expect, it } from "vitest";

const extensionRoot = resolve("extension");
const fixtureRoot = resolve("tests/fixtures/browserHelperExtension");
const e2e = process.env.RUN_BROWSER_E2E === "1";

interface WorkdayStoreSession {
  startedAt?: number;
  userEditedKeys?: string[];
}

interface WorkdaySessionStore {
  read(): Promise<Record<string, WorkdayStoreSession>>;
  update<T>(mutator: (sessions: Record<string, WorkdayStoreSession>) => T | Promise<T>): Promise<T>;
}

interface WorkdaySessionStoreApi {
  create(storage: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> }, key: string): WorkdaySessionStore;
}

interface ApplicationContextApi {
  shouldKeepPreparedApplicationAt(prepared: Record<string, unknown> | null, tabId: number, url: string): boolean;
  preparedApplicationForManualLog(tab: { id: number; url: string }, prepared: Record<string, unknown>, accountId: string, now?: number): Record<string, string> | null;
  manualLogDetails(prepared: Record<string, string> | null, inputs: Record<string, string>): Record<string, string>;
}

interface PersonalProfilePresetApi {
  defaults: Record<string, unknown>;
  merge(profile: Record<string, unknown>): Record<string, unknown>;
  equal(left: unknown, right: unknown): boolean;
  shouldStageRemote(remoteApplied: boolean, hasLocalProfileDraft: boolean): boolean;
}

interface MercerAnswerDraftsApi {
  create(): Array<Record<string, unknown>>;
  normalize(value: Record<string, unknown>): Record<string, unknown> | null;
}

interface WorkdayAnswerDraftsApi {
  create(): Array<Record<string, unknown>>;
  normalize(value: Record<string, unknown>): Record<string, unknown> | null;
  inferJobCountry(url: string, locationEvidence?: string | string[]): string;
}

interface SyntheticWorkdayDocument {
  name: string;
  type: string;
  size: number;
  base64: string;
}

interface SyntheticWorkdayPayload {
  profile: Record<string, unknown>;
  answers: Array<Record<string, unknown>>;
  documents?: { resume?: SyntheticWorkdayDocument | null; coverLetter?: SyntheticWorkdayDocument | null };
}

interface AnswerIdentityApi {
  answerIdentityKey(value: Record<string, unknown>): string;
  workdayJobKey(url: string): string;
  inferWorkdayJobCountry(url: string, locationEvidence?: string | string[]): string;
  canonicalApplicationUrl(url: string): string;
  workdayPublicListingUrl(applicationUrl: string, expectedJobKey?: string): string;
  applicationCountryForJob(state: Record<string, unknown>, expectedJobKey: string): string;
  sameWrittenDraftInputs(before: Record<string, unknown>, current: Record<string, unknown>): boolean;
  isWrittenNarrativePrompt(value: string): boolean;
  answerScopeContext(question: string, context: { origin?: string; locale?: string; applicationCountry?: string }): Record<string, string>;
  isDirectEmployerHistoryPrompt(value: string): boolean;
  isResidenceCountryLegalPrompt(value: string): boolean;
  isResidenceCountryPrompt(value: string): boolean;
  isObservedCompoundEmployerHistoryPrompt(value: string): boolean;
  parseWorkdayDate(value: string): { year: string; month: string } | null;
  validProfileWebsite(value: string): boolean;
  profileRowIsMeaningful(kind: string, row: Record<string, unknown> | null): boolean;
  profileRowsForWorkday(profile: Record<string, unknown>, kind: string): {
    rows: Array<Record<string, unknown> | null>;
    targetCount: number;
    invalidCount: number;
  };
  planWorkdayRows(profile: Record<string, unknown>, kind: string, existingIdentities: unknown[]): {
    targetCount: number;
    rowsToAdd: number;
    excessRows: number;
    identityConflicts: number[];
    fillableRowIndices: number[];
  };
  shouldApplyWorkdayCurrentFlag(row: Record<string, unknown>, identityConflict: boolean): boolean;
  resolveAnswer(question: string, answers: Array<Record<string, unknown>>, context: Record<string, unknown>): { answer: Record<string, unknown> | null; ambiguous: boolean };
}

describe("Scout Chromium helper extension", () => {
  it("ships only the intended MV3 permissions and does not auto-inject into ATS pages", () => {
    const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    const helper = readFileSync(resolve(extensionRoot, "ats.js"), "utf8");
    expect(helper).not.toMatch(/\.requestSubmit\s*\(/);
    expect(helper).not.toMatch(/\.submit\s*\(/);
    expect(helper).not.toMatch(/\.click\s*\(/);
  });

  it("stages the Mercer personal starter values only into blank profile fields", () => {
    const context: { ScoutPersonalProfilePreset?: PersonalProfilePresetApi } = {};
    runInNewContext(readFileSync(resolve(extensionRoot, "personal-profile-preset.js"), "utf8"), context);
    const preset = context.ScoutPersonalProfilePreset;
    expect(preset).toBeDefined();
    const blank = {
      country: "", phoneType: "", phoneCountryCode: "", previousWorker: null, hasPreferredName: null,
      experienceCount: null,
      referralSources: [], firstName: "", preferredFirstName: "", preferredLastName: "", linkedin: "", certifications: [],
    };
    const staged = preset!.merge(blank);
    expect(staged).toMatchObject({
      country: "Canada",
      phoneType: "Mobile",
      phoneCountryCode: "Canada (+1)",
      previousWorker: false,
      hasPreferredName: true,
      experienceCount: 1,
      experience: [{ currentlyWorkHere: false }],
      referralSources: ["LinkedIn"],
      firstName: "",
      preferredFirstName: "",
      preferredLastName: "",
      linkedin: "",
      certifications: [],
    });
    expect(staged.languages).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: "Chinese", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" }),
      expect.objectContaining({ language: "English", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" }),
    ]));
    expect(staged.websites).toEqual(Array.from({ length: 4 }, () => ({ url: "" })));
    expect(preset!.defaults).not.toHaveProperty("certifications");
    expect(preset!.defaults).not.toHaveProperty("linkedin");
    expect(preset!.defaults).not.toHaveProperty("preferredFirstName");
    expect(preset!.defaults).not.toHaveProperty("preferredLastName");

    const reviewed = {
      country: "United States", phoneType: "Landline", phoneCountryCode: "+1 United States",
      previousWorker: true, hasPreferredName: false, experienceCount: 0, referralSources: ["Employee"], firstName: "Ada", linkedin: "https://linkedin.example/ada",
    };
    expect(preset!.merge(reviewed)).toMatchObject(reviewed);
    expect(preset!.merge({ languages: [{ language: "French", fluent: false }], websites: [{ url: "https://example.test" }] })).toMatchObject({
      languages: [{ language: "French", fluent: false }],
      websites: [{ url: "https://example.test" }],
    });
    expect(preset!.merge({ experience: [{ company: "Northwind", currentlyWorkHere: null }, { company: "Contoso", currentlyWorkHere: true }] }).experience)
      .toEqual([{ company: "Northwind", currentlyWorkHere: false }, { company: "Contoso", currentlyWorkHere: true }]);
    expect(preset!.merge({ experienceCount: 0 }).experienceCount).toBe(0);
  });

  it("plans Workday repeatable rows by profile index and preserves existing record identities", () => {
    const context: { URL: typeof URL; ScoutAnswerContract?: AnswerIdentityApi } = { URL };
    runInNewContext(readFileSync(resolve(extensionRoot, "answer-contract.js"), "utf8"), context);
    const contract = context.ScoutAnswerContract;
    expect(contract).toBeDefined();
    expect(contract!.parseWorkdayDate("2024-03")).toEqual({ year: "2024", month: "3" });
    expect(contract!.parseWorkdayDate("2024")).toEqual({ year: "2024", month: "" });
    expect(contract!.parseWorkdayDate("2024-3")).toBeNull();
    expect(contract!.parseWorkdayDate("2024-03-12")).toBeNull();
    expect(contract!.parseWorkdayDate("0000")).toBeNull();

    const profile = {
      experience: [
        { company: "Northwind", title: "Engineer", currentlyWorkHere: false, startDate: "2020-02" },
        null,
        { company: "Contoso", title: "Intern", currentlyWorkHere: false, startDate: "2024" },
      ],
    };
    const rows = contract!.profileRowsForWorkday(profile, "experience");
    expect(rows).toMatchObject({ targetCount: 3, invalidCount: 0 });
    expect(rows.rows[1]).toBeNull();
    const partialPlan = contract!.planWorkdayRows(profile, "experience", ["Northwind"]);
    expect(partialPlan).toMatchObject({ targetCount: 3, rowsToAdd: 2, excessRows: 0, identityConflicts: [], fillableRowIndices: [0] });
    const mismatchPlan = contract!.planWorkdayRows(profile, "experience", ["Another company", "", "Contoso", "Existing extra"]);
    expect(mismatchPlan).toMatchObject({ targetCount: 3, rowsToAdd: 0, excessRows: 1, identityConflicts: [0], fillableRowIndices: [2] });
    const oneRowPlan = contract!.planWorkdayRows({
      experienceCount: 1,
      experience: [{ company: "Northwind" }, { company: "Contoso" }],
    }, "experience", ["Northwind", "Contoso"]);
    expect(oneRowPlan).toMatchObject({ targetCount: 1, rowsToAdd: 0, excessRows: 1, fillableRowIndices: [0] });
    const unknownIdentityPlan = contract!.planWorkdayRows({ experience: [{ title: "Engineer" }] }, "experience", ["Existing employer"]);
    expect(unknownIdentityPlan.identityConflicts).toEqual([0]);
    const checkboxDefaultPlan = contract!.planWorkdayRows({
      experienceCount: 1,
      experience: [{ currentlyWorkHere: false }],
    }, "experience", ["Parsed resume employer"]);
    expect(checkboxDefaultPlan).toMatchObject({ targetCount: 1, identityConflicts: [0], fillableRowIndices: [] });
    expect(contract!.shouldApplyWorkdayCurrentFlag({ currentlyWorkHere: false }, true)).toBe(true);
    expect(contract!.shouldApplyWorkdayCurrentFlag({ company: "Northwind", currentlyWorkHere: false }, true)).toBe(false);
    expect(contract!.shouldApplyWorkdayCurrentFlag({ company: "Northwind", currentlyWorkHere: true }, true)).toBe(false);
    expect(contract!.shouldApplyWorkdayCurrentFlag({ company: "Northwind", currentlyWorkHere: false }, false)).toBe(true);

    expect(contract!.profileRowIsMeaningful("experience", { currentlyWorkHere: false })).toBe(false);
    expect(contract!.profileRowIsMeaningful("experience", { currentlyWorkHere: false, company: "Northwind" })).toBe(true);
    const websites = contract!.profileRowsForWorkday({ websites: [{ url: "" }, { url: "javascript:alert(1)" }, { url: "https://example.test/profile" }] }, "websites");
    expect(websites).toMatchObject({ targetCount: 1, invalidCount: 1, rows: [{ url: "https://example.test/profile" }] });
    const sparseWebsites = contract!.profileRowsForWorkday({ websites: [
      { url: "" }, { url: "https://first.example/profile" }, { url: "javascript:alert(1)" }, { url: "https://second.example/profile" },
    ] }, "websites");
    expect(sparseWebsites).toMatchObject({
      targetCount: 2, invalidCount: 1, rows: [{ url: "https://first.example/profile" }, { url: "https://second.example/profile" }],
    });
    expect(contract!.validProfileWebsite("https://example.test/profile")).toBe(true);
    expect(contract!.validProfileWebsite("javascript:alert(1)")).toBe(false);
  });

  it("scopes written narrative drafts to professional prompts and the same Workday job", () => {
    const context: { URL: typeof URL; ScoutAnswerContract?: AnswerIdentityApi } = { URL };
    runInNewContext(readFileSync(resolve(extensionRoot, "answer-contract.js"), "utf8"), context);
    const contract = context.ScoutAnswerContract;
    expect(contract).toBeDefined();
    const observedEssayPrompts = [
      "Please take a moment to briefly highlight your relevant work experience.",
      "Do you have experience using the tools, systems, or technology outlined in the job posting? Please explain.",
    ];
    for (const prompt of observedEssayPrompts) expect(contract!.isWrittenNarrativePrompt(prompt)).toBe(true);
    expect(contract!.isWrittenNarrativePrompt("Do you have experience working in the semiconductor industry?" )).toBe(false);
    expect(contract!.isWrittenNarrativePrompt("What are your base salary expectations (CAD)?" )).toBe(false);
    expect(contract!.isWrittenNarrativePrompt("Are you legally eligible to work in the country where you are applying?" )).toBe(false);
    expect(contract!.isWrittenNarrativePrompt("Please explain your citizenship and immigration status." )).toBe(false);
    expect(contract!.isWrittenNarrativePrompt("Please describe why you agree to the terms and conditions." )).toBe(false);
    expect(contract!.isWrittenNarrativePrompt("Describe your background check and security credentials." )).toBe(false);

    const listingUrl = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/CAN---Richmond%2C-BC/Software-Developer---Web-Cloud-Application--Co-op_REQ3644";
    const applicationUrl = `${listingUrl}/apply/autofillWithResume`;
    expect(contract!.workdayJobKey(listingUrl)).toBe(contract!.workdayJobKey(applicationUrl));
    expect(contract!.workdayJobKey(applicationUrl)).toContain("|can---richmond,-bc|software-developer---web-cloud-application--co-op_req3644");
    expect(contract!.workdayJobKey("https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/USA---California/Software-Developer_REQ1/apply")).not.toBe(contract!.workdayJobKey(applicationUrl));
    expect(contract!.workdayJobKey("https://jobs.example.test/job/CAN---Richmond/Software-Developer_REQ1/apply")).toBe("");
    expect(contract!.workdayPublicListingUrl(applicationUrl, contract!.workdayJobKey(applicationUrl))).toBe(listingUrl);
    expect(contract!.workdayPublicListingUrl("https://other.example.test/job/CAN---Richmond/Software-Developer_REQ1/apply", "x")).toBe("");
    expect(contract!.canonicalApplicationUrl(`${applicationUrl}?utm_source=mail&reqId=REQ3644&token=secret#apply`))
      .toBe(`${applicationUrl}?reqId=REQ3644`);
    const boundSettings = {
      accountId: "account-1", startedAt: 10, applicationUrl, jobKey: contract!.workdayJobKey(applicationUrl),
      applicationCountry: "Canada", autoDraftWrittenAnswers: true, jobDescription: "Same job description",
      professionalProfile: { experience: [{ title: "Developer" }] }, answers: [{ question: "Exact prompt", answer: "No" }],
    };
    expect(contract!.sameWrittenDraftInputs(boundSettings, { ...boundSettings })).toBe(true);
    expect(contract!.sameWrittenDraftInputs(boundSettings, { ...boundSettings, autoDraftWrittenAnswers: false })).toBe(false);
    expect(contract!.sameWrittenDraftInputs(boundSettings, { ...boundSettings, applicationCountry: "United States" })).toBe(false);
    expect(contract!.sameWrittenDraftInputs(boundSettings, { ...boundSettings, answers: [{ question: "Exact prompt", answer: "Yes" }] })).toBe(false);
    expect(contract!.applicationCountryForJob({
      applicationCountry: "Canada", applicationCountryApplicationUrl: listingUrl,
    }, contract!.workdayJobKey(applicationUrl))).toBe("Canada");
    expect(contract!.applicationCountryForJob({
      applicationCountry: "United States", applicationCountryApplicationUrl: "https://semtech.wd1.myworkdayjobs.com/job/USA/Other",
    }, contract!.workdayJobKey(applicationUrl))).toBe("");
    expect(contract!.answerScopeContext("Tell us how you found this role", {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US", applicationCountry: "Canada",
    }).country).toBe("canada");
    expect(contract!.answerScopeContext("Tell us how you found this role", {}).country).toBeUndefined();
    expect(contract!.answerScopeContext("Are you eligible to work in the US?", { applicationCountry: "Canada" }).country).toBe("united states");
    expect(contract!.answerScopeContext("Are you eligible to work in the USA?", { applicationCountry: "Canada" }).country).toBe("united states");
    expect(contract!.answerScopeContext("Are you eligible to work in U.S.?", { applicationCountry: "Canada" }).country).toBe("united states");

    const background = readFileSync(resolve(extensionRoot, "background.js"), "utf8");
    expect(background).toContain('"X-CSRF-Token": csrfToken');
    expect(background).toContain('"X-Scout-Account-Id": expectedAccountId');
    expect(background).toContain("response?.requestId !== request.requestId");
    expect(background).toContain("jobDescription: latestSession?.payload?.jobDescription ?? \"\"");
    expect(background).toContain("sameWrittenDraftInputs(inputSnapshot, latestInputs)");
    expect(background).toContain("answers: latestState.answers ?? []");
    expect(background).toContain("applicationCountry: globalThis.ScoutAnswerContract.applicationCountryForJob(state, session.payload?.jobKey)");
    expect(background).toContain("autoDraftWrittenAnswers: state.writtenAnswerDraftingEnabled !== false");
    expect(background).toContain("automatic && (state.writtenAnswerDraftingEnabled === false || session.payload?.autoDraftWrittenAnswers === false)");
    expect(background).toContain("writtenDrafts?.[key]");
    expect(background).toContain("chrome.tabs.create({ url: listingUrl, active: false })");
    expect(background).toContain("readWorkdayJobDescription?.(jobKey)");
    expect(background).toContain("finally {\n    if (temporaryTab?.id) await chrome.tabs.remove(temporaryTab.id).catch(() => undefined);");
    expect(background).toContain("jobDescription.length >= 40");
    expect(background).not.toMatch(/\.requestSubmit\s*\(/);
    expect(background).not.toMatch(/\.submit\s*\(/);
  });

  it("normalizes all editable Mercer answer drafts and stages personal presets only once", () => {
    const context: {
      URL: typeof URL;
      ScoutAnswerContract?: AnswerIdentityApi;
      ScoutMercerAnswerDrafts?: MercerAnswerDraftsApi;
      ScoutPersonalProfilePreset?: PersonalProfilePresetApi;
    } = { URL };
    runInNewContext(readFileSync(resolve(extensionRoot, "answer-contract.js"), "utf8"), context);
    runInNewContext(readFileSync(resolve(extensionRoot, "mercer-answer-drafts.js"), "utf8"), context);
    runInNewContext(readFileSync(resolve(extensionRoot, "personal-profile-preset.js"), "utf8"), context);
    const draftsApi = context.ScoutMercerAnswerDrafts;
    const contract = context.ScoutAnswerContract;
    const preset = context.ScoutPersonalProfilePreset;
    expect(draftsApi).toBeDefined();
    expect(contract).toBeDefined();
    expect(preset).toBeDefined();

    const drafts = draftsApi!.create().map((draft) => draftsApi!.normalize(draft)).filter((draft) => draft !== null);
    expect(drafts).toHaveLength(13);
    expect(drafts.every((draft) => draft?.scope && (draft.scope as Record<string, unknown>).origin === "https://merceruniversity.wd1.myworkdayjobs.com"
      && (draft.scope as Record<string, unknown>).locale === "en-US")).toBe(true);
    expect(drafts.find((draft) => draft?.draftId === "mercer-conviction-history")?.booleanValue).toBe(false);
    expect(drafts.find((draft) => draft?.draftId === "mercer-salary-negotiable")?.booleanValue).toBe(true);
    expect(drafts.find((draft) => draft?.draftId === "mercer-race-category")?.selectedChoices).toEqual(["Asian (United States of America)"]);
    expect(drafts.some((draft) => /currently enrolled as a student/i.test(String(draft?.question)))).toBe(false);
    expect(drafts.some((draft) => /authorize representatives|certify that i have read/i.test(String(draft?.question)))).toBe(false);
    expect(draftsApi!.normalize({ ...draftsApi!.create()[0], answerType: "multi-choice", selectedChoices: ["Maybe"] })).toBeNull();

    const globalAnswer = { question: drafts[0]!.question, answer: "No" };
    const mercerAnswer = { question: drafts[0]!.question, answer: "No", scope: drafts[0]!.scope };
    expect(contract!.answerIdentityKey(globalAnswer)).not.toBe(contract!.answerIdentityKey(mercerAnswer));
    expect(readFileSync(resolve(extensionRoot, "popup.js"), "utf8")).toContain("ANSWER_CONTRACT.answerIdentityKey(answer) === ANSWER_CONTRACT.answerIdentityKey(draft)");
    expect(contract!.isDirectEmployerHistoryPrompt("Have you ever been employed at Example Corp?")).toBe(true);
    expect(contract!.isDirectEmployerHistoryPrompt("Have you previously worked for Example Corp?")).toBe(true);
    expect(contract!.isDirectEmployerHistoryPrompt("Have you previously been employed by Semtech as a Full-time, Part-time, Contractor or Temporary worker in any of our global locations?*")).toBe(true);
    expect(contract!.isDirectEmployerHistoryPrompt("Are you currently enrolled as a student at Example University?")).toBe(false);
    expect(contract!.isDirectEmployerHistoryPrompt("Describe how long you worked at Example Corp.")).toBe(false);
    expect(contract!.isDirectEmployerHistoryPrompt("Are you authorized to work in the United States?")).toBe(false);
    expect(contract!.isResidenceCountryLegalPrompt("Country of Citizenship")).toBe(true);
    expect(contract!.isResidenceCountryLegalPrompt("What country are you a citizen of?")).toBe(true);
    expect(contract!.isResidenceCountryLegalPrompt("What is your nationality?" )).toBe(true);
    expect(contract!.isResidenceCountryLegalPrompt("What country were you born in?")).toBe(true);
    expect(contract!.isResidenceCountryLegalPrompt("Birth Country")).toBe(true);
    expect(contract!.isResidenceCountryLegalPrompt("Country")).toBe(false);
    expect(contract!.isResidenceCountryPrompt("Country")).toBe(true);
    expect(contract!.isResidenceCountryPrompt("Country/Region")).toBe(true);
    expect(contract!.isResidenceCountryPrompt("Country of Residence")).toBe(true);
    expect(contract!.isResidenceCountryPrompt("Address Country")).toBe(true);
    expect(contract!.isResidenceCountryPrompt("What country are you legally entitled to work in?")).toBe(false);
    expect(contract!.isResidenceCountryPrompt("What country are you a citizen of?")).toBe(false);
    expect(contract!.isResidenceCountryPrompt("What country were you born in?")).toBe(false);
    expect(contract!.isResidenceCountryPrompt("Are you a permanent resident of Canada?")).toBe(false);
    expect(contract!.isObservedCompoundEmployerHistoryPrompt("Previous Worker Confirmation Text: Were you a previous employee or student at Mercer University OR are you a current Mercer Engineering Research Center (MERC) employee? If so, please enter your information below. FOR CURRENT MERCER UNIVERSITY EMPLOYEES ONLY: You must apply via the internal career portal. Please log in to your Workday account to submit your application.")).toBe(true);
    expect(contract!.isObservedCompoundEmployerHistoryPrompt("Previous Worker Confirmation Text: Were you a previous employee or student at Example University OR are you a current Example Research Center employee? If so, please enter your information below. FOR CURRENT EXAMPLE UNIVERSITY EMPLOYEES ONLY: You must apply via the internal career portal. Please log in to your Workday account to submit your application.")).toBe(true);
    expect(contract!.isObservedCompoundEmployerHistoryPrompt("Are you currently enrolled as a student at Example University?")).toBe(false);

    const neutralSponsorshipQuestion = "Will you now or in the future require sponsorship?";
    const countryScopedSponsorship = {
      question: neutralSponsorshipQuestion,
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      scope: { origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada", locale: "en-US" },
    };
    expect(contract!.resolveAnswer(neutralSponsorshipQuestion, [countryScopedSponsorship], {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US",
    }).answer).toBeNull();
    expect(contract!.resolveAnswer(neutralSponsorshipQuestion, [countryScopedSponsorship], {
      origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada", locale: "en-US",
    }).answer).toMatchObject({ booleanValue: false });
    const canadaDefault = {
      ...countryScopedSponsorship,
      booleanValue: false,
      scope: { origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada" },
    };
    const unitedStatesDefault = {
      ...countryScopedSponsorship,
      booleanValue: true,
      scope: { origin: "https://semtech.wd1.myworkdayjobs.com", country: "United States" },
    };
    expect(contract!.resolveAnswer(neutralSponsorshipQuestion, [canadaDefault, unitedStatesDefault], {
      origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada", locale: "en-US",
    }).answer).toMatchObject({ booleanValue: false, scope: { country: "Canada" } });
    expect(contract!.resolveAnswer(neutralSponsorshipQuestion, [canadaDefault, unitedStatesDefault], {
      origin: "https://semtech.wd1.myworkdayjobs.com", country: "United States", locale: "en-US",
    }).answer).toMatchObject({ booleanValue: true, scope: { country: "United States" } });
    expect(contract!.answerScopeContext(neutralSponsorshipQuestion, {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US", applicationCountry: "Canada",
    })).toMatchObject({ country: "canada" });
    expect(contract!.answerScopeContext(neutralSponsorshipQuestion, {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US", applicationCountry: "United States",
    })).toMatchObject({ country: "united states" });
    expect(contract!.answerScopeContext(neutralSponsorshipQuestion, {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US",
    })).not.toHaveProperty("country");
    expect(contract!.answerScopeContext("Are you authorized to work in Canada or the United States?", {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US", applicationCountry: "Canada",
    })).not.toHaveProperty("country");
    expect(contract!.answerScopeContext("Can you work remotely anywhere in North America?", {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US", applicationCountry: "Canada",
    })).not.toHaveProperty("country");
    expect(contract!.answerScopeContext("Are you authorized to work in the United States?", {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US", applicationCountry: "Canada",
    })).toMatchObject({ country: "united states" });
    const explicitlyReviewedSponsorship = {
      ...countryScopedSponsorship,
      scope: { origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US" },
    };
    expect(contract!.resolveAnswer(neutralSponsorshipQuestion, [explicitlyReviewedSponsorship], {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US",
    }).answer).toMatchObject({ booleanValue: false });

    const citizenshipQuestion = "What country are you a citizen of?";
    const reviewedCitizenship = { question: citizenshipQuestion, answer: "Canada", scope: { origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US" } };
    expect(contract!.resolveAnswer(citizenshipQuestion, [reviewedCitizenship], {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US",
    }).answer).toMatchObject({ answer: "Canada" });

    const helper = readFileSync(resolve(extensionRoot, "ats.js"), "utf8");
    const profileResolver = helper.slice(helper.indexOf("function exactProfileAnswer"), helper.indexOf("function choiceElements"));
    expect(profileResolver.indexOf("isResidenceCountryLegalPrompt(field)")).toBeGreaterThan(-1);
    expect(profileResolver.indexOf("isResidenceCountryLegalPrompt(field)")).toBeLessThan(profileResolver.indexOf("profile.country ??"));
    expect(profileResolver).toContain("ANSWER_CONTRACT.isResidenceCountryPrompt(q)");
    expect(profileResolver).not.toMatch(/country-name\|\^country\$/);
    expect(profileResolver).not.toContain("profile.requiresSponsorship");
    expect(helper).toContain("legally entitled to work|legally allowed to work|entitled to work|allowed to work");
    expect(helper).toContain("\\bcitizen(?:ship)?\\b|nationality|country of (?:birth|origin)|place of birth|birth country|country (?:were you )?born in|national origin");
    const answerResolver = helper.slice(helper.indexOf("function answerFor"), helper.indexOf("function workdayQuestionnaireCurrentLabel"));
    expect(answerResolver.indexOf("ANSWER_CONTRACT.resolveAnswer")).toBeLessThan(answerResolver.indexOf("exactProfileAnswer("));

    let remoteApplied = false;
    let profile: Record<string, unknown> = { country: "", phoneType: "", phoneCountryCode: "", referralSources: [], previousWorker: null, hasPreferredName: null };
    if (preset!.shouldStageRemote(remoteApplied, false)) {
      profile = preset!.merge(profile);
      remoteApplied = true;
    }
    profile.referralSources = [];
    profile.languages = [];
    profile.websites = [];
    if (preset!.shouldStageRemote(remoteApplied, false)) profile = preset!.merge(profile);
    expect(profile.referralSources).toEqual([]);
    expect(profile.languages).toEqual([]);
    expect(profile.websites).toEqual([]);
    expect(preset!.merge({ hasPreferredName: false }).hasPreferredName).toBe(false);
    expect(preset!.shouldStageRemote(true, false)).toBe(false);
    expect(preset!.shouldStageRemote(false, true)).toBe(false);
  });

  it("keeps Semtech exact answers editable and scoped to known application countries", () => {
    const context: {
      URL: typeof URL;
      ScoutAnswerContract?: AnswerIdentityApi;
      ScoutWorkdayAnswerDrafts?: WorkdayAnswerDraftsApi;
    } = { URL };
    runInNewContext(readFileSync(resolve(extensionRoot, "answer-contract.js"), "utf8"), context);
    runInNewContext(readFileSync(resolve(extensionRoot, "workday-answer-drafts.js"), "utf8"), context);
    const draftsApi = context.ScoutWorkdayAnswerDrafts;
    const contract = context.ScoutAnswerContract;
    expect(draftsApi).toBeDefined();
    expect(contract).toBeDefined();
    const drafts = draftsApi!.create().map((draft) => draftsApi!.normalize(draft)).filter(Boolean);
    expect(drafts).toHaveLength(9);
    const byId = new Map(drafts.map((draft) => [draft!.draftId, draft! as Record<string, unknown> & { scope?: Record<string, string>; booleanValue?: boolean; answer?: string }]));
    expect(byId.get("semtech-canada-eligibility")).toMatchObject({ booleanValue: true, scope: { country: "Canada" } });
    expect(byId.get("semtech-us-eligibility")).toMatchObject({ booleanValue: false, scope: { country: "United States" } });
    expect(byId.get("semtech-canada-sponsorship")).toMatchObject({ booleanValue: false, scope: { country: "Canada" } });
    expect(byId.get("semtech-us-sponsorship")).toMatchObject({ booleanValue: true, scope: { country: "United States" } });
    expect(byId.get("semtech-canada-relocation")).toMatchObject({ booleanValue: true, scope: { country: "Canada" } });
    expect(byId.get("semtech-canada-salary-range")).toMatchObject({ answer: "30,000 CAD  - 42,000 CAD", scope: { country: "Canada" } });
    expect(byId.get("semtech-canada-related-employee")).toMatchObject({
      booleanValue: false,
      scope: { origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada" },
    });
    expect(byId.get("semtech-canada-education-requirements")).toMatchObject({ booleanValue: true, scope: { country: "Canada" } });
    expect(byId.get("semtech-canada-industry-experience")).toMatchObject({ booleanValue: false, scope: { country: "Canada" } });
    expect(drafts.every((draft) => !String(draft!.question).toLowerCase().includes("tools and systems"))).toBe(true);

    const eligibilityPrompt = "Are you legally eligible to work in the country in which you are applying?";
    const canadaAnswer = byId.get("semtech-canada-eligibility")!;
    const usAnswer = byId.get("semtech-us-eligibility")!;
    expect(contract!.resolveAnswer(eligibilityPrompt, [canadaAnswer, usAnswer], {
      origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada", locale: "en-US",
    }).answer).toMatchObject({ booleanValue: true });
    expect(contract!.resolveAnswer(eligibilityPrompt, [canadaAnswer, usAnswer], {
      origin: "https://semtech.wd1.myworkdayjobs.com", country: "United States", locale: "en-US",
    }).answer).toMatchObject({ booleanValue: false });
    expect(contract!.resolveAnswer(eligibilityPrompt, [canadaAnswer, usAnswer], {
      origin: "https://semtech.wd1.myworkdayjobs.com", locale: "en-US",
    }).answer).toBeNull();
    expect(draftsApi!.inferJobCountry("https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/CAN---Richmond-BC/Software-Developer/apply/autofillWithResume")).toBe("Canada");
    expect(draftsApi!.inferJobCountry("https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/USA---Seattle/Software-Developer/apply")).toBe("United States");
    expect(draftsApi!.inferJobCountry("https://example.test/job/CAN---Richmond-BC/apply")).toBe("");
  });

  it("infers a Workday application country only from unambiguous job-bound location evidence", () => {
    const context: { URL: typeof URL; ScoutAnswerContract?: AnswerIdentityApi } = { URL };
    runInNewContext(readFileSync(resolve(extensionRoot, "answer-contract.js"), "utf8"), context);
    const contract = context.ScoutAnswerContract;
    expect(contract).toBeDefined();

    const workdayUrl = (slug: string, role = "Software-Developer") =>
      `https://any-tenant.wd1.myworkdayjobs.com/en-US/jobs/job/${slug}/${role}/apply`;
    expect(contract!.inferWorkdayJobCountry(workdayUrl("CAN---Richmond-BC"))).toBe("Canada");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("Canada---Vancouver-BC"))).toBe("Canada");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("USA---Seattle-WA"))).toBe("United States");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("United-States---Seattle-WA"))).toBe("United States");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("Richmond-BC"), ["Richmond, BC, Canada"])).toBe("Canada");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("Seattle-WA"), ["Seattle, Washington, United States"])).toBe("United States");

    expect(contract!.inferWorkdayJobCountry(workdayUrl("Richmond-BC"))).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("Richmond-BC"), ["Richmond, BC"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("Austin-TX"), ["Austin, Texas"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Tell us why you want to work here"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["en-US"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("CAN---Richmond-BC"), ["Seattle, United States"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Vancouver, Canada", "Seattle, USA"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Seattle, United States", "London, United Kingdom"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Vancouver, Canada", "Bengaluru, India"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Seattle, USA / London, UK"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Seattle, USA / London, U.K."])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("unknown"), ["Seattle, United States", "Remote location"])).toBe("");
    expect(contract!.inferWorkdayJobCountry(workdayUrl("GBR---London"), ["Seattle, United States"])).toBe("");
    expect(contract!.inferWorkdayJobCountry("https://example.test/en-US/job/CAN---Richmond-BC/Role/apply", ["Canada"])).toBe("");

    const canadaKey = contract!.workdayJobKey(workdayUrl("CAN---Richmond-BC"));
    expect(contract!.applicationCountryForJob({
      applicationCountry: "United States",
      applicationCountryReviewed: true,
      applicationCountryApplicationUrl: workdayUrl("CAN---Richmond-BC"),
      applicationCountryEvidence: ["Canada"],
    }, canadaKey)).toBe("United States");
    expect(contract!.applicationCountryForJob({
      applicationCountry: "",
      applicationCountryReviewed: true,
      applicationCountryApplicationUrl: workdayUrl("CAN---Richmond-BC"),
      applicationCountryEvidence: ["Canada"],
    }, canadaKey)).toBe("");
    expect(contract!.applicationCountryForJob({
      applicationCountry: "",
      applicationCountryReviewed: false,
      applicationCountryApplicationUrl: workdayUrl("Richmond-BC"),
      applicationCountryEvidence: ["Richmond, BC, Canada"],
    }, contract!.workdayJobKey(workdayUrl("Richmond-BC")))).toBe("Canada");
    expect(contract!.applicationCountryForJob({
      applicationCountry: "Canada",
      applicationCountryReviewed: false,
      applicationCountryApplicationUrl: workdayUrl("CAN---Richmond-BC"),
      applicationCountryEvidence: ["Seattle, United States"],
    }, canadaKey)).toBe("");
    expect(contract!.applicationCountryForJob({
      applicationCountry: "United States",
      applicationCountryReviewed: false,
      applicationCountryApplicationUrl: workdayUrl("CAN---Richmond-BC"),
      applicationCountryEvidence: [],
    }, canadaKey)).toBe("Canada");

    const ats = readFileSync(resolve(extensionRoot, "ats.js"), "utf8");
    expect(ats).toContain("function workdayJobLocationEvidence()");
    const locationExtractor = ats.slice(ats.indexOf("function workdayJobLocationEvidence()"), ats.indexOf("function readWorkdayJobDescription", ats.indexOf("function workdayJobLocationEvidence()")));
    expect(locationExtractor).toContain('[data-automation-id="locations"], [data-automation-id="location"]');
    expect(locationExtractor).not.toContain('data-automation-id="jobPostingHeader"');
    expect(ats).toContain("inferWorkdayJobCountry(location.href, jobCountryEvidence)");
    expect(ats).toContain("payload.applicationCountryReviewed === true");
    expect(ats).toContain(": ANSWER_CONTRACT.inferWorkdayJobCountry(location.href,");
    const background = readFileSync(resolve(extensionRoot, "background.js"), "utf8");
    expect(background).toContain("const needsCountry = ![\"Canada\", \"United States\"]");
    expect(background).toContain("inferWorkdayJobCountry(listingUrl, jobCountryEvidence)");
  });

  it("limits Mercer personal Workday choices to the observed exact controls and resume widget", () => {
    const helper = readFileSync(resolve(extensionRoot, "ats.js"), "utf8");
    expect(helper).toContain('element.id === "name--preferredCheck"');
    expect(helper).toContain('element.getAttribute("data-automation-id") !== "file-upload-input-ref"');
    expect(helper).toContain('[data-automation-id="attachments-FileUpload"]');
    expect(helper).toContain('#resumeAttachments--attachments[data-automation-id="select-files"]');
    expect(helper).toContain('button[id^="primaryQuestionnaire--"][aria-haspopup="listbox"]');
    expect(helper).toContain("workdayQuestionnairePrompt");
    expect(helper).toContain("preferred.*first name");
    expect(helper).toContain("preferred.*last name");
    expect(helper.indexOf("preferred.*first name")).toBeLessThan(helper.indexOf("given-name|first-name"));
    expect(helper.indexOf("preferred.*last name")).toBeLessThan(helper.indexOf("family-name|last-name"));
    expect(helper).toContain('[data-automation-id="file-upload-item-name"]');
    expect(helper).toMatch(/function workdayStepTitle\(\)[\s\S]*?querySelectorAll\("h3"\)/);
    const profileChoices = helper.slice(helper.indexOf("function workdayProfileChoiceAnswer"), helper.indexOf("function dispatchValue"));
    expect(profileChoices).toContain("ANSWER_CONTRACT.isDirectEmployerHistoryPrompt(descriptor.question)");
    expect(profileChoices).toContain('element.getAttribute("name") === "candidateIsPreviousWorker"');
    expect(profileChoices).toContain("ANSWER_CONTRACT.isObservedCompoundEmployerHistoryPrompt(descriptor.question)");
    expect(profileChoices).toContain("element instanceof HTMLSelectElement");
    expect(helper).toMatch(/function dispatchChecked\(element, checked\)[\s\S]*?element\.dispatchEvent\(new MouseEvent\("click"[\s\S]*?return element\.checked === checked/);
    expect(helper).not.toMatch(/if \([^\n]*worked[^\n]*\) return profile\./i);
  });

  it.skipIf(!e2e)("uses native click activation for controlled Workday radio and checkbox state", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/synthetic-tenant/Synthetic-Role/apply/applyManually";
      await context.route("https://merceruniversity.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(resolve("tests/fixtures/browserHelperWorkday/synthetic-session.html"), "utf8") });
      });
      await page.goto(url);
      const observation = JSON.parse(readFileSync(resolve("tests/fixtures/browserHelperWorkday/mercer-my-information.json"), "utf8")) as {
        controls: Array<{ name?: string; prompt: string }>;
        locale: string;
      };
      const previousWorkerPrompt = observation.controls.find((control) => control.name === "candidateIsPreviousWorker")?.prompt;
      expect(previousWorkerPrompt).toBeTruthy();
      await page.evaluate(() => {
        const directGroup = document.createElement("fieldset");
        directGroup.innerHTML = '<legend>Have you ever been employed at Example Corp?</legend><label><input type="radio" name="direct-employer-history" value="Yes"> Yes</label><label><input type="radio" name="direct-employer-history" value="No"> No</label>';
        const studentGroup = document.createElement("fieldset");
        studentGroup.innerHTML = '<legend>Are you currently enrolled as a student at Example University?</legend><label><input type="radio" name="student-enrollment" value="Yes"> Yes</label><label><input type="radio" name="student-enrollment" value="No"> No</label>';
        document.querySelector("#synthetic-application")?.append(directGroup, studentGroup);
        const view = window as unknown as Window & { __controlledState?: { preferredName: boolean; previousWorker: string; directEmployer: string; studentEnrollment: string } };
        const state = { preferredName: false, previousWorker: "", directEmployer: "", studentEnrollment: "" };
        view.__controlledState = state;
        const preferred = document.querySelector<HTMLInputElement>("#name--preferredCheck");
        const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="candidateIsPreviousWorker"]'));
        const otherRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="direct-employer-history"], input[name="student-enrollment"]'));
        document.addEventListener("click", (event) => {
          const target = event.target;
          if (target === preferred && preferred) {
            state.preferredName = preferred.checked;
            queueMicrotask(() => { preferred.checked = state.preferredName; });
          }
          if (target instanceof HTMLInputElement && radios.includes(target)) {
            if (target.checked) state.previousWorker = target.value;
            queueMicrotask(() => radios.forEach((radio) => { radio.checked = radio.value === state.previousWorker; }));
          }
          if (target instanceof HTMLInputElement && otherRadios.includes(target)) {
            if (target.checked && target.name === "direct-employer-history") state.directEmployer = target.value;
            if (target.checked && target.name === "student-enrollment") state.studentEnrollment = target.value;
            queueMicrotask(() => otherRadios.forEach((radio) => {
              const selected = radio.name === "direct-employer-history" ? state.directEmployer : state.studentEnrollment;
              radio.checked = radio.value === selected;
            }));
          }
        });
      });
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const result = await page.evaluate(async ({ question }: { question: string }) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: {
          startWorkdaySession(input: { profile: Record<string, unknown>; answers: Array<Record<string, unknown>> }): Promise<{ sessionActive: boolean }>;
          stopWorkdaySession(): { stopped: boolean };
        } }).ScoutFormHelper;
        const scope = { origin: location.origin, locale: document.documentElement.lang };
        const report = await helper.startWorkdaySession({
          profile: { previousWorker: false, hasPreferredName: true },
          answers: [{ question, answer: "", answerType: "boolean", booleanValue: false, scope }],
        });
        const state = (window as unknown as Window & { __controlledState: { preferredName: boolean; previousWorker: string; directEmployer: string; studentEnrollment: string } }).__controlledState;
        const checked = {
          preferred: document.querySelector<HTMLInputElement>("#name--preferredCheck")?.checked,
          previousWorkerNo: document.querySelector<HTMLInputElement>('input[name="candidateIsPreviousWorker"][value="No"]')?.checked,
          directEmployerNo: document.querySelector<HTMLInputElement>('input[name="direct-employer-history"][value="No"]')?.checked,
          studentSelectionCount: document.querySelectorAll<HTMLInputElement>('input[name="student-enrollment"]:checked').length,
          submitCount: Number(document.querySelector("#synthetic-submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { report, state, checked };
      }, { question: previousWorkerPrompt! });
      expect(result.report.sessionActive).toBe(true);
      expect(result.state).toEqual({ preferredName: true, previousWorker: "No", directEmployer: "No", studentEnrollment: "" });
      expect(result.checked).toEqual({ preferred: true, previousWorkerNo: true, directEmployerNo: true, studentSelectionCount: 0, submitCount: 0 });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!e2e)("attaches resume and cover letter together in the empty shared Workday upload and preserves existing uploads", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/synthetic-tenant/Synthetic-Role/apply/applyManually";
      await context.route("https://merceruniversity.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(resolve("tests/fixtures/browserHelperWorkday/synthetic-experience-session.html"), "utf8") });
      });
      const bytes = readFileSync(resolve("tests/fixtures/browserHelperWorkday/scout-upload-test.pdf"));
      const makeDocument = (name: string) => ({ name, type: "application/pdf", size: bytes.byteLength, base64: bytes.toString("base64") });
      const payload: SyntheticWorkdayPayload = {
        profile: {},
        answers: [],
        documents: { resume: makeDocument("resume.pdf"), coverLetter: makeDocument("cover-letter.pdf") },
      };
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const result = await page.evaluate(async (input: SyntheticWorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: {
          startWorkdaySession(value: SyntheticWorkdayPayload): Promise<{ attachments: string[]; sessionActive: boolean }>;
          stopWorkdaySession(): { stopped: boolean };
        } }).ScoutFormHelper;
        const first = await helper.startWorkdaySession(input);
        const inputElement = document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]');
        const uploaded = Array.from(inputElement?.files ?? [], (file) => file.name);
        const uploadEvents = Number(document.querySelector("#upload-change-count")?.textContent ?? "0");
        helper.stopWorkdaySession();
        const second = await helper.startWorkdaySession({
          profile: {},
          answers: [],
          documents: { resume: { ...input.documents!.resume!, name: "replacement-resume.pdf" }, coverLetter: { ...input.documents!.coverLetter!, name: "replacement-cover-letter.pdf" } },
        });
        const afterRestart = {
          files: Array.from(inputElement?.files ?? [], (file) => file.name),
          uploadEvents: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
          visibleFileName: document.querySelector('[data-automation-id="file-upload-item-name"]')?.textContent?.trim(),
          submitCount: Number(document.querySelector("#experience-submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { first, second, uploaded, uploadEvents, afterRestart };
      }, payload);
      expect(result.first.sessionActive).toBe(true);
      expect(result.first.attachments).toContain("Resume / CV attachments");
      expect(result.uploaded).toEqual(["resume.pdf", "cover-letter.pdf"]);
      expect(result.uploadEvents).toBe(1);
      expect(result.second.attachments).toEqual([]);
      expect(result.afterRestart).toEqual({
        files: ["resume.pdf", "cover-letter.pdf"],
        uploadEvents: 1,
        visibleFileName: "resume.pdf, cover-letter.pdf",
        submitCount: 0,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("keeps per-application Workday agreements manual and binds pickers, preferred names, uploads, and sync conflicts safely", () => {
    const helper = readFileSync(resolve(extensionRoot, "ats.js"), "utf8");
    expect(helper).toContain('element.id === "termsAndConditions--acceptTermsAndAgreements"');
    expect(helper).toContain("isWorkdayNonReusableAgreement(question)");
    expect(helper).toContain("isWorkdayNonReusableConsent(descriptor)");
    expect(helper).toMatch(/function workdayPreferredNameField\(descriptor\)[\s\S]*?preferredName--firstName[\s\S]*?preferredName--lastName/);
    expect(helper).toMatch(/preferredNameField && !questionNamesPreferred/);
    expect(helper).toMatch(/function workdayListboxRoots\(control\)[\s\S]*?if \(!referenced\.length\) return \[\];[\s\S]*?belongsToControl[\s\S]*?listboxes\.length === 1/);
    expect(helper).toContain("function attachWorkdayDocuments(descriptor, documents)");
    expect(helper).toContain('return parser && isVisible(parser) && selectFile && isVisible(selectFile)');
    expect(helper).toContain('&& normalizedKey(textOf(selectFile)) === "select file" ? "resume-parser" : ""');
    expect(helper).toContain('widgetKind === "resume-parser" ? [documents?.resume] : [documents?.resume, documents?.coverLetter]');
    expect(helper).toContain('[data-automation-id="progressBarActiveStep"]');
    expect(helper).toMatch(/function workdayStepTitle\(\)[\s\S]*?const activeIsCounter[\s\S]*?textOf\(heading\)/);
    expect(helper).toMatch(/function fileUploadAlreadyHasItems\(input\)[\s\S]*?input\.files\?\.length[\s\S]*?attachments-FileUpload[\s\S]*?resumeUpload[\s\S]*?file-upload-item/);
    expect(helper).toMatch(/function workdayCustomKind\(field, control\)[\s\S]*?profileField === "referralSources"[\s\S]*?HTMLButtonElement\)[\s\S]*?return "single"/);
    expect(helper).toMatch(/function workdayCustomUsesSearchInput\(field, control\)[\s\S]*?profileField === "referralSources"[\s\S]*?HTMLButtonElement/);
    expect(helper).toContain('widgetSelector = workdayResumeUploadKind(element) === "resume-parser"');
    expect(helper).toContain("fileUploadAlreadyHasItems(input)");
    expect(helper).toMatch(/savedDocumentMismatch/);
    expect(helper).toMatch(/function workdayRepeatableStructureKey\(element\)[\s\S]*?return `repeatable:\$\{section\.kind\}:structure`/);
    expect(helper).toContain('session.userEditedKeys.delete("repeatable:experience:structure")');

    const background = readFileSync(resolve(extensionRoot, "background.js"), "utf8");
    expect(background).toContain('message?.type === "scout.workdayUserEditCleared"');
    expect(background).toMatch(/async function clearWorkdayUserEdit\(message, sender\)[\s\S]*?session\.userEditedKeys = \(session\.userEditedKeys \?\? \[\]\)\.filter\(\(key\) => key !== message\.fieldKey\)/);

    const popup = readFileSync(resolve(extensionRoot, "popup.js"), "utf8");
    expect(popup).toContain("PERSONAL_PROFILE_PRESET.shouldStageRemote(state.personalPresetRemoteApplied, hadLocalProfileDraft)");
    expect(popup).toContain("ANSWER_CONTRACT.answerIdentityKey(answer) === ANSWER_CONTRACT.answerIdentityKey(candidate)");
    expect(popup).toContain('state.accountId = error.accountId');
    expect(popup).toContain('fail("SYNC_CONFLICT", detail, { remoteSnapshot, orphanedAnswerIds, accountId })');
  });

  it("serializes rapid Workday edits and prevents an account clear from being undone by a stale start", async () => {
    const context: { ScoutWorkdaySessionStore?: WorkdaySessionStoreApi } = {};
    runInNewContext(readFileSync(resolve(extensionRoot, "workday-session-store.js"), "utf8"), context);
    const memory: Record<string, unknown> = { workday: { "17": { startedAt: 42, userEditedKeys: [] } } };
    const storage = {
      async get(key: string) { return { [key]: structuredClone(memory[key] ?? {}) }; },
      async set(value: Record<string, unknown>) { Object.assign(memory, structuredClone(value)); },
    };
    const store = context.ScoutWorkdaySessionStore?.create(storage, "workday");
    expect(store).toBeDefined();
    const sessions = store!;

    await Promise.all([
      sessions.update(async (state) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        const session = state["17"];
        if (session) session.userEditedKeys = [...new Set([...(session.userEditedKeys ?? []), "country--country"])];
      }),
      sessions.update((state) => {
        const session = state["17"];
        if (session) session.userEditedKeys = [...new Set([...(session.userEditedKeys ?? []), "phoneNumber--phoneType"])];
      }),
    ]);
    expect((await sessions.read())["17"]?.userEditedKeys?.sort()).toEqual(["country--country", "phoneNumber--phoneType"]);

    let accountId: string | null = "account-1";
    let releaseStart!: () => void;
    const enteredStart = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise; });
    const staleStart = sessions.update(async (state) => {
      releaseStart();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      if (accountId !== "account-1") return false;
      state["17"] = { startedAt: 99, userEditedKeys: [] };
      return true;
    });
    await enteredStart;
    accountId = null;
    const accountClear = sessions.update((state) => {
      for (const [tabId, session] of Object.entries(state)) {
        if (session.startedAt !== 99) delete state[tabId];
      }
    });
    expect(await staleStart).toBe(false);
    await accountClear;
    expect(await sessions.read()).toEqual({});

    const clearThenStart = sessions.update((state) => {
      for (const key of Object.keys(state)) delete state[key];
    });
    const staleAccountStart = sessions.update((state) => {
      if (accountId === "account-1") state["17"] = { startedAt: 100, userEditedKeys: [] };
    });
    await Promise.all([clearThenStart, staleAccountStart]);
    expect(await sessions.read()).toEqual({});
  });

  it("keeps manual recovery tied to the prepared role, clears it on a different job, and honors reviewed metadata edits", () => {
    const context: { ScoutApplicationContext?: ApplicationContextApi; URL: typeof URL } = { URL };
    runInNewContext(readFileSync(resolve(extensionRoot, "application-context.js"), "utf8"), context);
    const helper = context.ScoutApplicationContext;
    expect(helper).toBeDefined();
    const prepared = {
      tabId: 17,
      accountId: "account-1",
      company: "Mercer University",
      title: "Software Engineer",
      location: "Warner Robins",
      applicationUrl: "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/123/Software-Engineer/apply/applyManually",
      preparedAt: 1_000,
      ats: "Workday",
    };
    const stepUrl = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/123/Software-Engineer/apply/applicationQuestions";
    const confirmationUrl = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/thank-you";
    const otherJobUrl = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/456/Analyst/apply/applyManually";
    expect(helper!.shouldKeepPreparedApplicationAt(prepared, 17, stepUrl)).toBe(true);
    expect(helper!.shouldKeepPreparedApplicationAt(prepared, 17, confirmationUrl)).toBe(true);
    expect(helper!.shouldKeepPreparedApplicationAt(prepared, 17, otherJobUrl)).toBe(false);
    const queryScoped = { ...prepared, ats: "Greenhouse", applicationUrl: "https://boards.greenhouse.io/acme/jobs/apply?job=123" };
    expect(helper!.shouldKeepPreparedApplicationAt(queryScoped, 17, "https://boards.greenhouse.io/acme/jobs/apply?job=456")).toBe(false);

    let retained: Record<string, unknown> | null = prepared;
    if (!helper!.shouldKeepPreparedApplicationAt(retained, 17, otherJobUrl)) retained = null;
    expect(helper!.preparedApplicationForManualLog({ id: 17, url: confirmationUrl }, retained ?? {}, "account-1", 2_000)).toBeNull();

    const recovery = helper!.preparedApplicationForManualLog({ id: 17, url: confirmationUrl }, prepared, "account-1", 2_000);
    expect(recovery?.applicationUrl).toBe(prepared.applicationUrl);
    expect(helper!.manualLogDetails(recovery, { company: "Reviewed employer", title: "Reviewed role", location: "Ottawa" })).toEqual({
      company: "Reviewed employer", title: "Reviewed role", location: "Ottawa", applicationUrl: prepared.applicationUrl,
    });

    const background = readFileSync(resolve(extensionRoot, "background.js"), "utf8");
    expect(background).toContain('message?.type === "scout.applicationRouteChanged"');
    expect(background).toContain("clearPreparedApplicationIfNavigationLeaves(tabId, changedUrl)");
  });

  it.skipIf(!e2e)("fills only reviewed blank fields on Greenhouse and preserves manual files", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await serveFixture(context, "greenhouse.html", "https://boards.greenhouse.io/**");
      await page.goto("https://boards.greenhouse.io/acme/jobs/123");
      await page.locator("#manual-file").setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: Buffer.from("manual") });
      await page.evaluate(() => {
        (window as unknown as Window & { __submits?: number }).__submits = 0;
        document.querySelector("form")?.addEventListener("submit", (event) => {
          event.preventDefault();
          const testWindow = window as unknown as Window & { __submits?: number };
          testWindow.__submits = (testWindow.__submits ?? 0) + 1;
        });
      });
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const result = await page.evaluate(() => {
        const helper = (window as unknown as Window & { ScoutFormHelper: { fill: (payload: unknown) => Record<string, unknown>; normalizeQuestion: (value: string) => string } }).ScoutFormHelper;
        const profile = {
          firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "+1 416 555 0100",
          address: "1 Main Street", city: "Toronto", region: "Ontario", postalCode: "M5V 1A1", country: "Canada",
          linkedin: "", github: "", portfolio: "", workAuthorization: "Authorized to work in Canada", requiresSponsorship: "false",
          education: [], experience: [{ company: "OldCo" }, { company: "NewCo" }],
        };
        const answers = [
          { question: "Why us?", answer: "The reviewed answer for this exact prompt." },
          { question: "What is your C++ experience?", answer: "C++ answer" },
          { question: "What is your C# experience?", answer: "C# answer" },
          { question: "Which country option?", answer: "", answerType: "single-choice", selectedChoices: ["Canada"] },
          { question: "Please confirm the reviewed option", answer: "", answerType: "boolean", booleanValue: true },
        ];
        const report = helper.fill({ profile, answers, documents: {
          resume: { name: "resume.pdf", type: "application/pdf", base64: btoa("%PDF-1.4 test") },
          coverLetter: null,
        } });
        return {
          report,
          values: Object.fromEntries(Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"), (input) => [input.id || input.name, input.value])),
          files: {
            manual: Array.from((document.querySelector<HTMLInputElement>("#manual-file")?.files ?? []), (file) => file.name),
            resume: Array.from((document.querySelector<HTMLInputElement>("#resume")?.files ?? []), (file) => file.name),
            unrelated: Array.from((document.querySelector<HTMLInputElement>("#profile-resume")?.files ?? []), (file) => file.name),
          },
          checked: {
            futureYes: (document.querySelector<HTMLInputElement>('input[name="future_sponsorship"][value="yes"]'))?.checked,
            futureNo: (document.querySelector<HTMLInputElement>('input[name="future_sponsorship"][value="no"]'))?.checked,
            consent: (document.querySelector<HTMLInputElement>("#consent"))?.checked,
          },
          submitCount: (window as unknown as Window & { __submits?: number }).__submits,
          normalizedCpp: helper.normalizeQuestion(" C++ "),
          normalizedC: helper.normalizeQuestion("C"),
        };
      });

      const values = result.values as Record<string, string>;
      expect(values.first).toBe("Ada");
      expect(values.last).toBe("Already present");
      expect(values.email).toBe("ada@example.test");
      expect(values.phone).toBe("+1 416 555 0100");
      expect(values.why).toBe("The reviewed answer for this exact prompt.");
      expect(values["company-essay"]).toBe("");
      expect(values.tell).toBe("");
      expect(values.work).toBe("");
      expect(values["canada-work"]).toBe("Authorized to work in Canada");
      expect(values["multi-country-work"]).toBe("");
      expect(values.region).toBe("Ontario");
      expect(values.sponsorship).toBe("");
      expect(values["choice-label-wins"]).toBe("USA");
      expect(values["boolean-label-only"]).toBe("");
      expect(values.company1).toBe("NewCo");
      expect(values.cpp).toBe("C++ answer");
      expect(values.csharp).toBe("C# answer");
      expect(result.checked).toEqual({ futureYes: false, futureNo: true, consent: false });
      expect(result.files).toEqual({ manual: ["manual.pdf"], resume: ["resume.pdf"], unrelated: [] });
      expect(result.submitCount).toBe(0);
      expect(result.normalizedCpp).not.toBe(result.normalizedC);
      expect((result.report as { iframeWarning: string }).iframeWarning).toContain("embedded frames");
      expect((result.report as { unknownQuestions: Array<{ question: string }> }).unknownQuestions.map((item) => item.question)).toContain("Why do you want to work at our company?");
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!e2e)("keeps non-application Workday routes and iframe-only forms manual; supports Lever and Ashby patterns", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await serveFixture(context, "workday.html", "https://myworkdayjobs.com/**");
      await serveFixture(context, "iframe-only.html", "https://boards.greenhouse.io/**");
      await serveFixture(context, "lever.html", "https://jobs.lever.co/**");
      await serveFixture(context, "ashby.html", "https://jobs.ashbyhq.com/**");
      const page = await context.newPage();
      await page.goto("https://myworkdayjobs.com/acme");
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const workday = await page.evaluate(() => (window as unknown as Window & { ScoutFormHelper: { scan: () => { supported: boolean; manualReason: string } } }).ScoutFormHelper.scan());
      expect(workday.supported).toBe(false);
      expect(workday.manualReason).toContain("Workday");
      await page.goto("https://boards.greenhouse.io/acme/jobs/iframe");
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const iframe = await page.evaluate(() => (window as unknown as Window & { ScoutFormHelper: { scan: () => { supported: boolean; manualReason: string } } }).ScoutFormHelper.scan());
      expect(iframe.supported).toBe(false);
      expect(iframe.manualReason).toContain("embedded frame");
      for (const [url, ats] of [["https://jobs.lever.co/acme/123", "Lever"], ["https://jobs.ashbyhq.com/acme/123", "Ashby"]] as const) {
        await page.goto(url);
        await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
        await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
        const report = await page.evaluate(() => (window as unknown as Window & { ScoutFormHelper: { scan: () => { supported: boolean; ats: string } } }).ScoutFormHelper.scan());
        expect(report.supported).toBe(true);
        expect(report.ats).toBe(ats);
      }
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!e2e)("requires an observed trusted submit and cancels tracking after navigation to another job", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await serveFixture(context, "greenhouse.html", "https://boards.greenhouse.io/**");
      const page = await context.newPage();
      await page.goto("https://boards.greenhouse.io/acme/jobs/123");
      await page.evaluate(() => {
        const messages: unknown[] = [];
        (window as unknown as Window & { __scoutMessages: unknown[] }).__scoutMessages = messages;
        (window as unknown as Window & { chrome?: unknown }).chrome = { runtime: { sendMessage: (message: { type?: string }) => {
          messages.push(message);
          return Promise.resolve(message.type === "scout.trustedSubmission" ? { trusted: true } : { queued: true });
        } } };
        document.querySelector("form")?.addEventListener("submit", (event) => event.preventDefault());
      });
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      await page.evaluate(() => {
        const helper = (window as unknown as Window & { ScoutFormHelper: { watchForConfirmation: (context: unknown) => unknown } }).ScoutFormHelper;
        helper.watchForConfirmation({ applicationUrl: location.href, company: "Acme", title: "Software Engineer Intern", preparedAt: Date.now() });
      });
      await page.evaluate(() => {
        const existing = document.createElement("p");
        existing.id = "confirmation-copy";
        existing.textContent = "Application received";
        document.body.append(existing);
      });
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => (window as unknown as Window & { __scoutMessages: unknown[] }).__scoutMessages)).toEqual([]);
      await page.evaluate(() => (document.querySelector("form") as HTMLFormElement).requestSubmit());
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => (window as unknown as Window & { __scoutMessages: unknown[] }).__scoutMessages)).toEqual([]);
      await page.locator('button[type="submit"]').click();
      await page.waitForFunction(() => (window as unknown as Window & { __scoutMessages: Array<{ type?: string }> }).__scoutMessages.some((message) => message.type === "scout.trustedSubmission"));
      expect(await page.evaluate(() => (window as unknown as Window & { __scoutMessages: Array<{ type: string }> }).__scoutMessages.map((message) => message.type))).toEqual(["scout.trustedSubmission"]);
      await page.locator("#confirmation-copy").evaluate((element) => { element.textContent = "Application submitted successfully"; });
      await page.waitForFunction(() => (window as unknown as Window & { __scoutMessages: Array<{ type?: string }> }).__scoutMessages.some((message) => message.type === "scout.applicationConfirmation"));
      const messages = await page.evaluate(() => (window as unknown as Window & { __scoutMessages: Array<{ type: string; application: { trustedSubmitted?: boolean; applicationUrl: string } }> }).__scoutMessages);
      expect(messages[0]?.type).toBe("scout.trustedSubmission");
      expect(messages[1]?.type).toBe("scout.applicationConfirmation");
      expect(messages[1]?.application.trustedSubmitted).toBe(true);
      expect(messages[1]?.application.applicationUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");

      await page.goto("https://boards.greenhouse.io/acme/jobs/123");
      await page.evaluate(() => {
        const messages: unknown[] = [];
        (window as unknown as Window & { __scoutMessages: unknown[] }).__scoutMessages = messages;
        (window as unknown as Window & { chrome?: unknown }).chrome = { runtime: { sendMessage: (message: { type?: string }) => {
          messages.push(message);
          return Promise.resolve(message.type === "scout.trustedSubmission" ? { trusted: true } : { queued: true });
        } } };
        document.querySelector("form")?.addEventListener("submit", (event) => event.preventDefault());
      });
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      await page.evaluate(() => {
        (window as unknown as Window & { ScoutFormHelper: { watchForConfirmation: (context: unknown) => unknown } }).ScoutFormHelper.watchForConfirmation({ applicationUrl: location.href, company: "Acme", title: "Job A", preparedAt: Date.now() });
        history.pushState({}, "", "/acme/jobs/456");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.locator('button[type="submit"]').click();
      await page.evaluate(() => { document.body.append(" Application submitted successfully"); });
      await page.waitForTimeout(75);
      expect(await page.evaluate(() => (window as unknown as Window & { __scoutMessages: unknown[] }).__scoutMessages)).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!e2e)("loads the unpacked MV3 popup and preserves queued logs across stale popup saves and account clearing", async () => {
    const userData = mkdtempSync(join(tmpdir(), "scout-helper-extension-"));
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(userData, {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`, "--no-first-run"],
      });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
      const extensionId = new URL(worker.url()).host;
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.getByRole("heading", { name: "Your Scout account" }).waitFor();
      expect(await popup.title()).toBe("Scout Application Helper");
      const manualTarget = await popup.evaluate(() => {
        const resolveTarget = (window as unknown as Window & { preparedApplicationForManualLog: (tab: unknown, state: unknown) => { applicationUrl: string } | null }).preparedApplicationForManualLog;
        const prepared = { tabId: 42, accountId: "account-1", company: "Acme", title: "Engineer", location: "Toronto", applicationUrl: "https://boards.greenhouse.io/acme/jobs/123", preparedAt: Date.now() };
        const state = { accountId: "account-1", preparedApplication: prepared };
        return {
          confirmation: resolveTarget({ id: 42, url: "https://boards.greenhouse.io/acme/thank-you" }, state),
          otherJob: resolveTarget({ id: 42, url: "https://boards.greenhouse.io/acme/jobs/456" }, state),
        };
      });
      expect(manualTarget.confirmation?.applicationUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
      expect(manualTarget.otherJob).toBeNull();
      mkdirSync(resolve(".impeccable/review"), { recursive: true });
      await popup.screenshot({ path: resolve(".impeccable/review/browser-helper-popup.png"), fullPage: true });
      const stateSeed = {
        version: 1, scoutOrigin: "https://scout.test", accountId: "account-1", profile: { firstName: "Ada", lastName: "Lovelace", requiresSponsorship: "false", education: [], experience: [] },
        profileDirty: false, documents: { resume: null, coverLetter: null }, answers: [], pendingAnswerUpserts: [], deletedAnswers: [], pendingApplications: [],
        lastSyncedRemote: null, syncConflict: false, syncConflictBaseline: null, preparedApplication: null, lastConfirmation: null, lastLoggedApplication: null,
      };
      const queued = { localId: "queued-1", accountId: "account-1", company: "Acme", title: "Engineer", applicationUrl: "https://boards.greenhouse.io/acme/jobs/123", confirmedSubmitted: true };
      const saved = await popup.evaluate(async ({ seed, queuedApplication }) => {
        const chromeApi = (window as unknown as Window & { chrome: { runtime: { sendMessage: (message: unknown) => Promise<{ saved?: boolean; state?: unknown }> }; storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome;
        await chromeApi.runtime.sendMessage({ type: "scout.saveHelperState", state: seed, operation: { accountTransition: true } });
        await chromeApi.runtime.sendMessage({ type: "scout.saveHelperState", state: seed, operation: { enqueueApplication: queuedApplication } });
        const stale = structuredClone(seed);
        stale.profile.firstName = "Grace";
        const write = await chromeApi.runtime.sendMessage({ type: "scout.saveHelperState", state: stale, operation: {} });
        const after = await chromeApi.storage.local.get("scoutApplicationHelper");
        return { write, state: after.scoutApplicationHelper };
      }, { seed: stateSeed, queuedApplication: queued });
      expect(saved.write.saved).toBe(true);
      expect((saved.state as { pendingApplications: Array<{ localId: string }> }).pendingApplications.map((item) => item.localId)).toEqual(["queued-1"]);
      expect((saved.state as { profile: { firstName: string } }).profile.firstName).toBe("Grace");

      await popup.close();
      const reopenedPopup = await context.newPage();
      await reopenedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
      await reopenedPopup.getByRole("heading", { name: "Your Scout account" }).waitFor();
      const persistedQueue = await reopenedPopup.evaluate(async () => {
        const storage = (window as unknown as Window & { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome.storage.local;
        const stored = await storage.get("scoutApplicationHelper");
        return stored.scoutApplicationHelper as { pendingApplications: Array<{ localId: string }> };
      });
      expect(persistedQueue.pendingApplications.map((item) => item.localId)).toEqual(["queued-1"]);

      const cleared = await reopenedPopup.evaluate(async (seed) => {
        const api = (window as unknown as Window & { chrome: { runtime: { sendMessage: (message: unknown) => Promise<{ saved?: boolean; state?: unknown }> }; storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome;
        const result = await api.runtime.sendMessage({ type: "scout.saveHelperState", state: seed, operation: { clearAccountBoundData: true, expectedAccountId: "account-1" } });
        const stale = await api.runtime.sendMessage({ type: "scout.saveHelperState", state: seed, operation: {} });
        const after = await api.storage.local.get("scoutApplicationHelper");
        return { result, stale, state: after.scoutApplicationHelper };
      }, stateSeed);
      expect(cleared.result.saved).toBe(true);
      expect(cleared.stale.saved).toBe(false);
      expect((cleared.state as { accountId: string | null }).accountId).toBeNull();
      expect((cleared.state as { pendingApplications: unknown[] }).pendingApplications).toEqual([]);
      expect((cleared.state as { profile: { firstName: string } }).profile.firstName).toBe("");
      await context.close();
    } finally {
      await context?.close();
      rmSync(userData, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!e2e)("stages local changes, detects remote conflicts, confirms reviewed sync, and removes a stored document", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const remoteProfile = emptyProfile("Web Ada");
      const remoteAnswers = [{ id: "answer-1", question: "Why this company?", answer: "Remote answer" }];
      const writes: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
      await mockPopup(context, page, { remoteProfile, remoteAnswers, writes });
      await page.getByRole("button", { name: "Set up" }).click();
      await page.locator("#scout-origin").fill("https://scout.test");
      await page.locator("#connect-scout").click();
      await page.getByText("Scout profile loaded. Your editable personal starter values are staged locally; choose Sync with Scout when ready.").waitFor();
      expect(await page.locator('[name="firstName"]').inputValue()).toBe("Web Ada");
      expect(await page.locator('[name="country"]').inputValue()).toBe("Canada");
      expect(await page.locator('[name="phoneType"]').inputValue()).toBe("Mobile");
      expect(await page.locator('[name="phoneCountryCode"]').inputValue()).toBe("Canada (+1)");
      expect(await page.locator('[name="previousWorker"]').inputValue()).toBe("false");
      expect(await page.locator('[name="hasPreferredName"]').inputValue()).toBe("true");
      expect(await page.locator('[name="referralSources"]').inputValue()).toBe("LinkedIn");
      expect(await page.getByText("Remote answer", { exact: true }).isVisible()).toBe(true);
      expect(writes.filter((item) => item.method === "PUT")).toHaveLength(0);

      await page.locator("#sync-now").click();
      await page.getByText("Profile and saved answers synced with Scout.").waitFor();
      expect(remoteProfile.previousWorker).toBe(false);
      expect(remoteProfile.hasPreferredName).toBe(true);
      expect(remoteProfile.referralSources).toEqual(["LinkedIn"]);
      expect(writes.filter((item) => item.path === "/api/browser-helper/profile" && item.method === "PUT")).toHaveLength(1);

      await page.locator('[name="firstName"]').fill("Local Draft");
      await page.getByRole("button", { name: "Save profile" }).click();
      await page.getByText("Profile saved in this browser.").waitFor();
      remoteProfile.firstName = "Web Changed";
      await page.locator("#sync-now").click();
      await page.getByText("Scout has newer profile or answer changes.").waitFor();
      expect(await page.locator('[name="firstName"]').inputValue()).toBe("Local Draft");
      expect(writes.filter((item) => item.path === "/api/browser-helper/profile" && item.method === "PUT")).toHaveLength(1);

      await page.locator("#sync-now").click();
      await page.getByText("Profile and saved answers synced with Scout.").waitFor();
      expect(remoteProfile.firstName).toBe("Local Draft");
      expect(writes.filter((item) => item.path === "/api/browser-helper/profile" && item.method === "PUT")).toHaveLength(2);

      await page.locator('[name="email"]').fill("");
      await page.getByRole("button", { name: "Save profile" }).click();
      await page.locator("#sync-now").click();
      await page.getByText("Profile and saved answers synced with Scout.").waitFor();
      expect(remoteProfile.email).toBe("");
      expect(writes.at(-1)?.body?.profile).toBeDefined();

      await page.evaluate(async () => {
        await (window as unknown as Window & { saveExactAnswer: (question: string, answer: string) => Promise<void> }).saveExactAnswer("Why this company?", "Local answer");
      });
      remoteAnswers.splice(0, remoteAnswers.length);
      const beforeOrphanSync = writes.length;
      await page.locator("#sync-now").click();
      await page.getByText("A saved answer was deleted in Scout.").waitFor();
      expect(writes.slice(beforeOrphanSync).filter((item) => item.path === "/api/browser-helper/answers" && item.method === "PUT")).toHaveLength(0);

      const storedDocument = { name: "resume.pdf", type: "application/pdf", size: 12, base64: "JVBERi0xLjQ=" };
      await page.evaluate((documentValue) => {
        const state = JSON.parse(localStorage.getItem("__scoutMockState") ?? "{}") as { documents: { resume: unknown } };
        state.documents.resume = documentValue;
        localStorage.setItem("__scoutMockState", JSON.stringify(state));
      }, storedDocument);
      await page.reload();
      await page.locator("#remove-resume").click();
      await page.getByText("Resume removed from this browser.").waitFor();
      const finalState = await page.evaluate(() => JSON.parse(localStorage.getItem("__scoutMockState") ?? "{}") as { documents: { resume: unknown }; profile: { firstName: string } });
      expect(finalState.documents.resume).toBeNull();
      expect(finalState.profile.firstName).toBe("Local Draft");
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);
});

async function serveFixture(context: BrowserContext, fileName: string, urlPattern = `https://**/${fileName}`): Promise<void> {
  const body = readFileSync(join(fixtureRoot, fileName));
  await context.route(urlPattern, async (route) => route.fulfill({ status: 200, contentType: "text/html", body }));
}

function emptyProfile(firstName = "") {
  return {
    firstName, lastName: "Lovelace", preferredFirstName: "", preferredLastName: "", email: "ada@example.test", phone: "", address: "", city: "", region: "", postalCode: "", country: "Canada",
    linkedin: "", github: "", portfolio: "", workAuthorization: "", requiresSponsorship: "", previousWorker: null, hasPreferredName: null, education: [], experience: [], referralSources: [],
  };
}

async function mockPopup(
  context: BrowserContext,
  page: Page,
  mock: { remoteProfile: ReturnType<typeof emptyProfile>; remoteAnswers: Array<{ id: string; question: string; answer: string }>; writes: Array<{ method: string; path: string; body?: Record<string, unknown> }> },
): Promise<void> {
  await page.addInitScript(() => {
    const key = "scoutApplicationHelper";
    const getState = () => {
      const value = localStorage.getItem("__scoutMockState");
      return value ? JSON.parse(value) as Record<string, unknown> : null;
    };
    const setState = (value: unknown) => localStorage.setItem("__scoutMockState", JSON.stringify(value));
    const initialState = {
      version: 1, scoutOrigin: "", accountId: null,
      profile: { firstName: "", lastName: "", email: "", phone: "", address: "", city: "", region: "", postalCode: "", country: "", linkedin: "", github: "", portfolio: "", workAuthorization: "", requiresSponsorship: "", education: [], experience: [] },
      profileDirty: false, documents: { resume: null, coverLetter: null }, answers: [], pendingAnswerUpserts: [], deletedAnswers: [], pendingApplications: [],
      lastSyncedRemote: null, syncConflict: false, syncConflictBaseline: null, preparedApplication: null, lastConfirmation: null, lastLoggedApplication: null,
    };
    if (!getState()) setState(initialState);
    const mockState = () => getState() ?? initialState;
    const saveMockState = (next: Record<string, unknown>, operation: Record<string, unknown>) => {
      const current = mockState();
      if (operation.clearLocal === true) { setState(initialState); return { saved: true, state: initialState }; }
      if (operation.clearAccountBoundData === true) {
        if (current.accountId !== operation.expectedAccountId) return { saved: false, state: current };
        setState(initialState);
        return { saved: true, state: initialState };
      }
      if (operation.accountTransition === true) { setState(next); return { saved: true, state: next }; }
      if (current.accountId !== next.accountId) return { saved: false, state: current };
      const saved = { ...current, ...next, pendingApplications: current.pendingApplications, lastLoggedApplication: current.lastLoggedApplication, lastConfirmation: current.lastConfirmation, preparedApplication: current.preparedApplication };
      if (operation.enqueueApplication) saved.pendingApplications = [...(current.pendingApplications as unknown[]), operation.enqueueApplication];
      if (operation.ackApplication) saved.pendingApplications = (current.pendingApplications as Array<{ localId: string }>).filter((item) => item.localId !== (operation.ackApplication as { localId: string }).localId);
      setState(saved);
      return { saved: true, state: saved };
    };
    const chromeMock = {
      runtime: { id: "mock-extension", sendMessage: async (message: { type: string; state: Record<string, unknown>; operation?: Record<string, unknown> }) => message.type === "scout.saveHelperState" ? saveMockState(message.state, message.operation ?? {}) : { saved: false } },
      storage: { local: { setAccessLevel: async () => undefined, get: async () => ({ [key]: mockState() }) }, onChanged: { addListener: () => undefined } },
      permissions: { contains: async () => true, request: async () => true, remove: async () => true },
      tabs: {
        query: async (query?: { active?: boolean }) => query?.active ? [{ id: 11, url: "https://boards.greenhouse.io/acme/jobs/123", status: "complete" }] : [{ id: 10, url: "https://scout.test/jobs", status: "complete" }],
        get: async (id: number) => ({ id, url: "https://scout.test/jobs", status: "complete" }),
        create: async () => ({ id: 10, url: "https://scout.test/jobs", status: "complete" }),
        remove: async () => undefined,
      },
      scripting: { executeScript: async (details: { func?: (...args: unknown[]) => unknown; args?: unknown[] }) => details.func ? [{ result: await details.func(...(details.args ?? [])) }] : [] },
    };
    (window as unknown as Window & { chrome?: unknown }).chrome = chromeMock;
  });
  await context.route("https://scout.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, csrfToken: "csrf", user: { id: "account-1", emailVerified: true } }) });
      return;
    }
    if (url.pathname === "/api/browser-helper/profile") {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contract: "scout.browser-helper.v1", accountId: "account-1", csrfToken: "csrf", profile: mock.remoteProfile, answers: mock.remoteAnswers, updatedAt: "2026-10-01T00:00:00.000Z" }) });
        return;
      }
      const body = route.request().postDataJSON() as { profile: typeof mock.remoteProfile };
      mock.writes.push({ method: route.request().method(), path: url.pathname, body: { ...body } });
      Object.assign(mock.remoteProfile, body.profile);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profile: mock.remoteProfile }) });
      return;
    }
    if (url.pathname === "/api/browser-helper/answers") {
      const body = route.request().postDataJSON() as { id?: string; question?: string; answer?: string };
      mock.writes.push({ method: route.request().method(), path: url.pathname, body: { ...body } });
      if (route.request().method() === "DELETE") {
        const index = mock.remoteAnswers.findIndex((item) => item.id === body.id);
        if (index >= 0) mock.remoteAnswers.splice(index, 1);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
        return;
      }
      const previous = mock.remoteAnswers.find((item) => item.question === body.question);
      if (previous) previous.answer = body.answer ?? "";
      else mock.remoteAnswers.push({ id: `answer-${mock.remoteAnswers.length + 1}`, question: body.question ?? "", answer: body.answer ?? "" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: mock.remoteAnswers.at(-1) }) });
      return;
    }
    if (url.pathname.endsWith(".html")) {
      await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(resolve(extensionRoot, "popup.html")) });
      return;
    }
    if (url.pathname === "/popup.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(resolve(extensionRoot, "popup.js")) });
      return;
    }
    if (url.pathname === "/popup.css") {
      await route.fulfill({ status: 200, contentType: "text/css", body: readFileSync(resolve(extensionRoot, "popup.css")) });
      return;
    }
    if (url.pathname === "/answer-contract.js" || url.pathname === "/application-context.js") {
      const fileName = url.pathname.slice(1);
      await route.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(resolve(extensionRoot, fileName)) });
      return;
    }
    await route.abort();
  });
  await page.goto("https://scout.test/popup.html");
}
