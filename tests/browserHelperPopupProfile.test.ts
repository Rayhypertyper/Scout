import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface ProfileContract {
  EMPTY_PROFILE: Record<string, unknown>;
  normalizeProfile(value: Record<string, unknown>): Record<string, unknown>;
  monthInputField(value: string): { type: string; value: string };
  shouldStageRemoteStarter(profileSaved: boolean | null | undefined): boolean;
}

interface WorkdayCountryContract {
  workdayJobKey(url: string): string;
  inferWorkdayJobCountry(url: string, evidence?: string | string[]): string;
  applicationCountryForJob(state: Record<string, unknown>, expectedJobKey: string): string;
}

function loadProfileContract(): ProfileContract {
  const context: { structuredClone: typeof structuredClone; ScoutProfileContract?: ProfileContract } = { structuredClone };
  runInNewContext(readFileSync(resolve("extension/profile-contract.js"), "utf8"), context);
  if (!context.ScoutProfileContract) throw new Error("ScoutProfileContract did not initialize");
  return context.ScoutProfileContract;
}

function loadWorkdayCountryContract(): WorkdayCountryContract {
  const context: { URL: typeof URL; ScoutAnswerContract?: WorkdayCountryContract } = { URL };
  runInNewContext(readFileSync(resolve("extension/answer-contract.js"), "utf8"), context);
  if (!context.ScoutAnswerContract) throw new Error("ScoutAnswerContract did not initialize");
  return context.ScoutAnswerContract;
}

describe("extension popup profile contract", () => {
  it("keeps four editable blank website slots by default while preserving an explicit zero-row choice", () => {
    const contract = loadProfileContract();
    expect(contract.EMPTY_PROFILE.experienceCount).toBeNull();
    expect(contract.normalizeProfile({ experienceCount: 0 }).experienceCount).toBe(0);
    expect(contract.normalizeProfile({ experienceCount: 1 }).experienceCount).toBe(1);
    expect(contract.normalizeProfile({ experienceCount: 21 }).experienceCount).toBeNull();
    expect(contract.EMPTY_PROFILE.websites).toEqual([{ url: "" }, { url: "" }, { url: "" }, { url: "" }]);
    expect(contract.normalizeProfile({ websites: [{ url: "" }, { url: "https://example.test" }] }).websites)
      .toEqual([{ url: "" }, { url: "https://example.test" }]);
    expect(contract.normalizeProfile({ websites: [] }).websites).toEqual([]);
    expect(contract.normalizeProfile({}).websites).toEqual(contract.EMPTY_PROFILE.websites);
  });

  it("round-trips added Workday profile fields, explicit false values, and language ratings", () => {
    const contract = loadProfileContract();
    const value = {
      education: [{ school: "Example University", degree: "Bachelor's", fieldOfStudy: "Computer Science", startDate: "2022-09", endDate: "2026-05", gradeAverage: "A" }],
      experience: [{ title: "Developer", company: "Example Co", location: "Toronto", startDate: "2025-05", endDate: "2025-08", description: "Synthetic test role", currentlyWorkHere: false }],
      languages: [{ language: "Chinese", fluent: false, comprehension: "5 - Fluent", overall: "4 - Advanced", reading: "5 - Fluent", speaking: "4 - Advanced", writing: "3 - Intermediate" }],
      websites: [{ url: "" }, { url: "https://example.test/profile" }],
    };

    expect(contract.normalizeProfile(value)).toMatchObject(value);
    expect(contract.normalizeProfile({ experience: [{ currentlyWorkHere: null }] }).experience)
      .toEqual([{ company: "", title: "", location: "", startDate: "", endDate: "", description: "", currentlyWorkHere: null }]);
  });

  it("renders repeatable profile controls with editable counts and month/year date fields", () => {
    const html = readFileSync(resolve("extension/popup.html"), "utf8");
    const script = readFileSync(resolve("extension/popup.js"), "utf8");
    expect(html).toContain('<script src="profile-contract.js"></script>');
    for (const id of ["education-count", "experience-count", "languages-count", "websites-count", "education-list", "experience-list", "languages-list", "websites-list"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('id="websites-count" type="number" min="0"');
    expect(html).toContain('id="websites-count" type="number" min="0" step="1" value="4"');
    expect(html).toContain('id="experience-count" name="experienceCount" type="number" min="0" max="20" step="1" value="1"');
    expect(html).toContain("Work experiences to include");
    expect(html).toContain("Extra Workday experience entries will be removed to match this count.");
    expect(script).toContain("PROFILE_CONTRACT.monthInputField(originalValue)");
    expect(script).toContain('currentlyWorkHere: false');
    expect(script).toContain('for (const warning of report.sectionWarnings ?? [])');
  });

  it("preserves year-only dates instead of clearing them when a month input cannot represent them", () => {
    const contract = loadProfileContract();
    expect(contract.monthInputField("2024")).toEqual({ type: "text", value: "2024" });
    expect(contract.monthInputField("2024-5")).toEqual({ type: "month", value: "2024-05" });
    expect(contract.monthInputField("")).toEqual({ type: "month", value: "" });
  });

  it("does not restage starter values when an older Scout server omits the profileSaved signal", () => {
    const contract = loadProfileContract();
    expect(contract.shouldStageRemoteStarter(false)).toBe(true);
    expect(contract.shouldStageRemoteStarter(true)).toBe(false);
    expect(contract.shouldStageRemoteStarter(null)).toBe(false);
    expect(contract.shouldStageRemoteStarter(undefined)).toBe(false);
    const popup = readFileSync(resolve("extension/popup.js"), "utf8");
    expect(popup).toContain('typeof value.profileSaved === "boolean" ? value.profileSaved : null');
    expect(popup).toContain('typeof remote.profileSaved === "boolean" ? remote.profileSaved : null');
    expect(popup).toContain("PROFILE_CONTRACT.shouldStageRemoteStarter(remoteProfileSaved)");
  });

  it("loads exact Canadian Workday drafts without using locale or applicant address as country", () => {
    type WorkdayDraftContract = {
      create(): Array<Record<string, unknown>>;
      inferJobCountry(url: string, evidence?: string | string[]): string;
    };
    const context: { URL: typeof URL; ScoutAnswerContract?: unknown; ScoutWorkdayAnswerDrafts?: WorkdayDraftContract } = { URL };
    runInNewContext(readFileSync(resolve("extension/answer-contract.js"), "utf8"), context);
    runInNewContext(readFileSync(resolve("extension/workday-answer-drafts.js"), "utf8"), context);
    const drafts = context.ScoutWorkdayAnswerDrafts?.create() ?? [];
    expect(drafts).toHaveLength(9);
    expect(drafts.every((draft) => String(draft.draftId).startsWith("semtech-"))).toBe(true);
    expect(drafts.find((draft) => draft.draftId === "semtech-canada-eligibility")?.scope).toEqual({ country: "Canada" });
    expect(drafts.find((draft) => draft.draftId === "semtech-canada-related-employee")?.scope)
      .toEqual({ origin: "https://semtech.wd1.myworkdayjobs.com", country: "Canada" });
    expect(drafts.find((draft) => draft.draftId === "semtech-us-eligibility")?.scope).toEqual({ country: "United States" });
    expect(drafts.every((draft) => (draft.scope as Record<string, string>).locale === undefined)).toBe(true);
    expect(context.ScoutWorkdayAnswerDrafts?.inferJobCountry("https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/CAN---Richmond%2C-BC/Synthetic-Role/apply"))
      .toBe("Canada");
    expect(context.ScoutWorkdayAnswerDrafts?.inferJobCountry("https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/USA---Synthetic/Synthetic-Role/apply"))
      .toBe("United States");
    expect(context.ScoutWorkdayAnswerDrafts?.inferJobCountry("https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/Warner-Robins-31088/Synthetic-Role/apply"))
      .toBe("");
    expect(context.ScoutWorkdayAnswerDrafts?.inferJobCountry(
      "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/Synthetic-Country/Synthetic-Role/apply",
      ["CAN - Richmond, BC"],
    )).toBe("Canada");
  });

  it("keeps explicit blank country overrides and rejects conflicting or locale-only inference", () => {
    const contract = loadWorkdayCountryContract();
    const canadaUrl = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/CAN---Richmond%2C-BC/Synthetic-Role/apply/myInformation";
    const unknownSlugUrl = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/Synthetic-Country/Synthetic-Role/apply/myInformation";
    const canadaKey = contract.workdayJobKey(canadaUrl);

    expect(contract.inferWorkdayJobCountry(canadaUrl)).toBe("Canada");
    expect(contract.inferWorkdayJobCountry(unknownSlugUrl)).toBe("");
    expect(contract.inferWorkdayJobCountry(unknownSlugUrl, ["Richmond, British Columbia"])).toBe("");
    expect(contract.inferWorkdayJobCountry(unknownSlugUrl, ["United States"])).toBe("United States");
    expect(contract.inferWorkdayJobCountry(canadaUrl, ["United States"])).toBe("");

    expect(contract.applicationCountryForJob({
      applicationCountryApplicationUrl: canadaUrl,
      applicationCountry: "",
      applicationCountryReviewed: true,
      applicationCountryEvidence: ["Canada"],
    }, canadaKey)).toBe("");
    expect(contract.applicationCountryForJob({
      applicationCountryApplicationUrl: canadaUrl,
      applicationCountry: "United States",
      applicationCountryReviewed: false,
      applicationCountryEvidence: ["CAN - Richmond, BC"],
    }, canadaKey)).toBe("Canada");
    expect(contract.applicationCountryForJob({
      applicationCountryApplicationUrl: canadaUrl,
      applicationCountry: "Canada",
      applicationCountryEvidence: [],
    }, canadaKey)).toBe("Canada");
  });

  it("keeps the popup country and Luna controls scoped to the active job", () => {
    const html = readFileSync(resolve("extension/popup.html"), "utf8");
    const script = readFileSync(resolve("extension/popup.js"), "utf8");
    expect(html).toContain('id="application-country" name="applicationCountry"');
    expect(html).toContain('<option value="">Unknown / choose if reviewed</option>');
    expect(html).toContain('<option value="Canada">Canada</option>');
    expect(html).toContain('<option value="United States">United States</option>');
    expect(html).toContain('id="written-answer-drafting" type="checkbox" checked');
    expect(html).toContain('id="workday-written-drafts"');
    expect(html).toContain('<script src="workday-answer-drafts.js"></script>');
    expect(html.indexOf('id="written-answer-drafting"')).toBeLessThan(html.indexOf('id="unknown-answers"'));
    expect(html).toContain("Use Luna for professional written responses");
    expect(html).toContain("Generated responses fill blank professional fields");
    expect(script).toContain("applicationCountryForUrl(currentReport.applicationUrl, currentReport.jobCountryEvidence)");
    expect(script).toContain('jobDescriptionContext?.jobKey === report.jobKey');
    expect(script).toContain('String(reportDescription || matchingJobDescription?.description || "").slice(0, 20_000)');
    expect(script).toContain("locale: workdayLocaleForReport(currentReport)");
    expect(script).toContain('postingUrl: String(matchingJobDescription?.postingUrl ?? currentReport.postingUrl ?? "").slice(0, 4_096)');
    expect(script).toContain("function workdayLocaleForReport(report)");
    expect(script).toContain('message?.type === "scout.workdayWrittenDraftStatus"');
    expect(script).toContain("const sameWorkdayJob = typeof currentScan.jobKey === \"string\"");
    expect(script).toContain("applicationCountryReviewed: false");
    expect(script).toContain("applicationCountryEvidence: []");
    expect(script).toContain("applicationCountryReviewed: typeof value.applicationCountryReviewed === \"boolean\"");
    expect(script).toContain("Boolean(legacyReviewedCountry)");
    expect(script).toContain("ANSWER_CONTRACT.inferWorkdayJobCountry(urlValue, evidence)");
    expect(script).toContain("applicationCountryReviewed: countryBinding.applicationCountryReviewed");
    expect(script).toContain("jobCountryEvidence: countryBinding.jobCountryEvidence");
    expect(script).toContain('type: "scout.applyWrittenDraft"');
  });
});
