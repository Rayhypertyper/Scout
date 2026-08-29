import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateInternshipMatch, rankInternships } from "../src/preferences/matching.js";
import {
  parsePreferenceStep,
  PreferenceValidationError,
  preferenceOptions,
  type InternshipPreferences,
} from "../src/preferences/schema.js";
import { parseLocation, SUPPORTED_CITY_OPTIONS } from "../src/parsing/locations.js";
import {
  ensurePreferenceSchema,
  readInternshipPreferences,
  saveInternshipPreferenceStep,
} from "../src/preferences/store.js";
import { makeInternship } from "./helpers.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "roleradar-preferences-"));
  directories.push(directory);
  return join(directory, "preferences.db");
}

function completePreferences(overrides: Partial<InternshipPreferences> = {}): InternshipPreferences {
  return {
    terms: [{ term: "summer", year: 2027 }],
    countries: ["canada"],
    cities: [{ name: "Toronto", country: "canada" }],
    remote: false,
    roleCategories: ["swe", "frontend"],
    technologies: ["TypeScript", "React"],
    degree: "bachelors",
    graduationYear: 2028,
    graduationYearOrLater: false,
    workAuthorization: { canada: "authorized", unitedStates: null },
    sponsorship: { canada: "none", unitedStates: null },
    onboardingCompleted: true,
    currentStep: 3,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    completedAt: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("preference persistence", () => {
  it("treats a missing legacy profile as incomplete without failing", () => {
    const stored = readInternshipPreferences(databasePath(), "existing-user");

    expect(stored.onboardingCompleted).toBe(false);
    expect(stored.currentStep).toBe(1);
    expect(stored.terms).toEqual([]);
  });

  it("saves each step, restores progress, and marks completion only after the final valid save", () => {
    const path = databasePath();
    const stepOne = saveInternshipPreferenceStep(path, "student-1", 1, {
      terms: [{ term: "summer", year: 2027 }, { term: "fall", year: 2027 }],
    });
    expect(stepOne).toMatchObject({ currentStep: 2, onboardingCompleted: false });
    expect(readInternshipPreferences(path, "student-1").terms).toHaveLength(2);

    const stepTwo = saveInternshipPreferenceStep(path, "student-1", 2, {
      countries: ["canada"],
      cities: [{ name: "Toronto", country: "canada" }],
      remote: true,
      roleCategories: ["swe", "frontend"],
      technologies: ["TypeScript", "React"],
    });
    expect(stepTwo).toMatchObject({ currentStep: 3, onboardingCompleted: false, remote: true });

    const complete = saveInternshipPreferenceStep(path, "student-1", 3, {
      degree: "bachelors",
      graduationYear: 2028,
      graduationYearOrLater: false,
      workAuthorization: { canada: "authorized", unitedStates: null },
      sponsorship: { canada: "none", unitedStates: null },
    });
    expect(complete.onboardingCompleted).toBe(true);
    expect(complete.completedAt).toEqual(expect.any(String));
    expect(readInternshipPreferences(path, "student-1")).toEqual(complete);
  });

  it("rolls back an invalid final submission and keeps prior answers", () => {
    const path = databasePath();
    saveInternshipPreferenceStep(path, "student-2", 1, { terms: [{ term: "summer", year: 2027 }] });

    expect(() => saveInternshipPreferenceStep(path, "student-2", 3, {
      degree: "bachelors",
      graduationYear: 2028,
      graduationYearOrLater: false,
      workAuthorization: { canada: null, unitedStates: null },
      sponsorship: { canada: null, unitedStates: null },
    })).toThrow(PreferenceValidationError);

    const restored = readInternshipPreferences(path, "student-2");
    expect(restored.onboardingCompleted).toBe(false);
    expect(restored.terms).toEqual([{ term: "summer", year: 2027 }]);
  });

  it("keeps completion explicit when an already-completed user edits a step", () => {
    const path = databasePath();
    saveInternshipPreferenceStep(path, "student-edit", 1, { terms: [{ term: "summer", year: 2027 }] });
    saveInternshipPreferenceStep(path, "student-edit", 2, {
      countries: ["canada"],
      cities: [],
      remote: true,
      roleCategories: ["swe"],
      technologies: [],
    });
    const completed = saveInternshipPreferenceStep(path, "student-edit", 3, {
      degree: "bachelors",
      graduationYear: 2028,
      graduationYearOrLater: false,
      workAuthorization: { canada: "authorized", unitedStates: null },
      sponsorship: { canada: "none", unitedStates: null },
    });
    const edited = saveInternshipPreferenceStep(path, "student-edit", 1, {
      terms: [{ term: "fall", year: 2027 }],
    });
    expect(edited.onboardingCompleted).toBe(true);
    expect(edited.currentStep).toBe(3);
    expect(edited.completedAt).toBe(completed.completedAt);
    expect(edited.terms).toEqual([{ term: "fall", year: 2027 }]);
  });

  it("makes schema setup idempotent and migrates an older preference table", () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE user_internship_preferences (user_id TEXT PRIMARY KEY)");
    database.close();

    ensurePreferenceSchema(path);
    ensurePreferenceSchema(path);
    const restored = readInternshipPreferences(path, "legacy-user");
    expect(restored.onboardingCompleted).toBe(false);
    expect(restored.currentStep).toBe(1);

    const saved = saveInternshipPreferenceStep(path, "legacy-user", 1, {
      terms: [{ term: "winter", year: 2028 }],
    });
    expect(saved.terms).toEqual([{ term: "winter", year: 2028 }]);
  });

  it("serializes repeated step submissions without losing answers", async () => {
    const path = databasePath();
    const values = { terms: [{ term: "summer", year: 2027 }] };
    const saved = await Promise.all([
      Promise.resolve().then(() => saveInternshipPreferenceStep(path, "student-double", 1, values)),
      Promise.resolve().then(() => saveInternshipPreferenceStep(path, "student-double", 1, values)),
    ]);
    expect(saved[0]?.terms).toEqual(values.terms);
    expect(saved[1]?.terms).toEqual(values.terms);
    expect(readInternshipPreferences(path, "student-double").terms).toEqual(values.terms);
  });
});

describe("preference location taxonomy", () => {
  it("derives onboarding city options from every parser-supported Canada/US city", () => {
    const options = preferenceOptions().cities as Array<{ name: string; country: string; region: string }>;
    expect(options.length).toBeGreaterThan(14);
    expect(options.length).toBe(SUPPORTED_CITY_OPTIONS.length);
    expect(new Set(options.map(({ country }) => country))).toEqual(new Set(["canada", "united_states"]));
    for (const option of options) {
      const countryLabel = option.country === "canada" ? "Canada" : "United States";
      const parsed = parseLocation(`${option.name}, ${option.region}, ${countryLabel}`);
      expect(parsed.country).toBe(countryLabel);
      expect(parsed.city).toBe(option.name);
    }
  });

  it("accepts every canonical city/country pair, including expanded taxonomy entries", () => {
    const options = preferenceOptions().cities as Array<{ name: string; country: "canada" | "united_states"; region: string }>;
    expect(options.map(({ name }) => name)).toEqual(expect.arrayContaining(["Waterloo", "Falls Church"]));
    for (const option of options) {
      expect(() => parsePreferenceStep(2, {
        countries: [option.country],
        cities: [{ name: option.name, country: option.country }],
        remote: false,
        roleCategories: ["swe"],
        technologies: [],
      })).not.toThrow();
    }
  });

  it("rejects unsupported cities and valid cities paired with the wrong country", () => {
    const step = {
      countries: ["canada"],
      remote: false,
      roleCategories: ["swe"],
      technologies: [],
    };
    expect(() => parsePreferenceStep(2, {
      ...step,
      cities: [{ name: "NotAParserCity", country: "canada" }],
    })).toThrow(PreferenceValidationError);
    expect(() => parsePreferenceStep(2, {
      ...step,
      cities: [{ name: "Toronto", country: "united_states" }],
    })).toThrow(PreferenceValidationError);
  });
});

describe("deterministic internship matching", () => {
  it("filters a reliably incompatible term while retaining missing term metadata", () => {
    const preferences = completePreferences();
    const fall = makeInternship({ internshipTerm: "Fall", internshipYear: "2027" });
    const unknown = makeInternship({
      id: "unknown-term",
      internshipTerm: null,
      internshipYear: null,
      title: "Software Engineering Intern",
    });

    expect(evaluateInternshipMatch(preferences, fall).eligible).toBe(false);
    const unknownMatch = evaluateInternshipMatch(preferences, unknown);
    expect(unknownMatch.eligible).toBe(true);
    expect(unknownMatch.unknown.some((message) => message.includes("term"))).toBe(true);
  });

  it("applies country, city, and remote preferences without treating unknown locations as incompatible", () => {
    const preferences = completePreferences();
    const unitedStates = makeInternship({
      id: "us-role",
      location: ["New York, NY, United States"],
      normalizedLocations: [{
        raw: "New York, NY, United States",
        country: "United States",
        provinceState: "New York",
        city: "New York",
        remote: false,
        remoteScope: null,
      }],
    });
    const unknown = makeInternship({ id: "unknown-location", location: [], normalizedLocations: [], remoteStatus: "unknown" });
    const remote = makeInternship({
      id: "remote-role",
      location: ["Remote"],
      normalizedLocations: [{ raw: "Remote", country: null, provinceState: null, city: null, remote: true, remoteScope: "unspecified" }],
      remoteStatus: "remote",
    });

    expect(evaluateInternshipMatch(preferences, unitedStates).eligible).toBe(false);
    expect(evaluateInternshipMatch(preferences, unknown).eligible).toBe(true);
    expect(evaluateInternshipMatch({ ...preferences, countries: [], cities: [], remote: true }, remote).eligible).toBe(true);

    const cityOnly = evaluateInternshipMatch({ ...preferences, countries: [], cities: [{ name: "Toronto", country: "canada" }] }, makeInternship({
      id: "country-only",
      location: ["Canada"],
      normalizedLocations: [{ raw: "Canada", country: "Canada", provinceState: null, city: null, remote: false, remoteScope: null }],
    }));
    expect(cityOnly.eligible).toBe(true);

    const unmapped = evaluateInternshipMatch(preferences, makeInternship({
      id: "unmapped-location",
      location: ["London, United Kingdom"],
      normalizedLocations: [{ raw: "London, United Kingdom", country: "United Kingdom", provinceState: null, city: "London", remote: false, remoteScope: null }],
    }));
    expect(unmapped.eligible).toBe(true);
    expect(unmapped.unknown.join(" ")).toMatch(/location/i);
  });

  it("ranks role-category and technology overlap above an otherwise equivalent listing", () => {
    const preferences = completePreferences();
    const preferred = makeInternship({
      id: "preferred",
      categories: ["frontend", "swe"],
      technologies: ["TypeScript", "React"],
    });
    const unrelated = makeInternship({
      id: "unrelated",
      categories: ["data"],
      technologies: ["Python"],
    });

    const ranked = rankInternships(preferences, [unrelated, preferred]);
    expect(ranked.map(({ internship }) => internship.id)).toEqual(["preferred", "unrelated"]);
    expect(ranked[0]?.match.reasons.join(" ")).toContain("TypeScript");
  });

  it("filters ineligible roles from ranked matches while preserving eligibility details", () => {
    const preferences = completePreferences();
    const eligible = makeInternship({ id: "eligible", relevanceScore: 80 });
    const ineligible = makeInternship({
      id: "ineligible",
      internshipTerm: "Fall",
      internshipYear: "2027",
      relevanceScore: 80,
    });
    const expectedEligible = evaluateInternshipMatch(preferences, eligible);
    const expectedIneligible = evaluateInternshipMatch(preferences, ineligible);

    expect(expectedEligible.score).toBe(94);
    expect(expectedIneligible.score).toBe(0);
    expect(expectedIneligible.eligible).toBe(false);
    expect(expectedIneligible.eligibility.status).toBe("not_eligible");

    const ranked = rankInternships(preferences, [ineligible, eligible]);

    expect(ranked.map(({ internship }) => internship.id)).toEqual(["eligible"]);
    expect(ranked).toHaveLength(1);
    expect(ranked.find(({ internship }) => internship.id === "eligible")?.match).toEqual(expectedEligible);
    expect(expectedIneligible.eligible).toBe(false);
    expect(expectedIneligible.incompatibilities.join(" ")).toMatch(/term/i);
  });

  it("rejects reliable authorization, sponsorship, and graduation incompatibilities", () => {
    const base = makeInternship();
    const restricted = makeInternship({
      qualificationDetails: {
        ...base.qualificationDetails,
        graduationYears: [2027],
        graduationYearRange: { min: 2027, max: 2027 },
        workAuthorization: "required",
        sponsorship: "unavailable",
      },
    });
    const preferences = completePreferences({
      graduationYear: 2029,
      workAuthorization: { canada: "needs_assistance", unitedStates: null },
      sponsorship: { canada: "now", unitedStates: null },
    });

    const match = evaluateInternshipMatch(preferences, restricted);
    expect(match.eligible).toBe(false);
    expect(match.incompatibilities.join(" ")).toMatch(/graduation|authorization|sponsorship/i);
  });

  it("handles both-country eligibility independently and keeps unknown metadata eligible", () => {
    const preferences = completePreferences({
      countries: ["canada", "united_states"],
      cities: [],
      remote: false,
      workAuthorization: { canada: "authorized", unitedStates: "needs_assistance" },
      sponsorship: { canada: "none", unitedStates: "now" },
    });
    const canada = makeInternship({
      id: "canada-eligible",
      normalizedLocations: [{
        raw: "Toronto, ON, Canada",
        country: "Canada",
        provinceState: "Ontario",
        city: "Toronto",
        remote: false,
        remoteScope: null,
      }],
      location: ["Toronto, ON, Canada"],
      qualificationDetails: {
        ...makeInternship().qualificationDetails,
        workAuthorization: "required",
        sponsorship: "unavailable",
      },
    });
    const us = makeInternship({
      id: "us-ineligible",
      normalizedLocations: [{
        raw: "New York, NY, United States",
        country: "United States",
        provinceState: "New York",
        city: "New York",
        remote: false,
        remoteScope: null,
      }],
      location: ["New York, NY, United States"],
      qualificationDetails: {
        ...makeInternship().qualificationDetails,
        workAuthorization: "required",
        sponsorship: "unavailable",
      },
    });
    expect(evaluateInternshipMatch(preferences, canada).eligible).toBe(true);
    expect(evaluateInternshipMatch(preferences, us).eligible).toBe(false);

    const unknown = makeInternship({ id: "unknown-eligibility", normalizedLocations: [], location: [], remoteStatus: "unknown" });
    const unknownMatch = evaluateInternshipMatch(preferences, unknown);
    expect(unknownMatch.eligible).toBe(true);
    expect(unknownMatch.unknown.length).toBeGreaterThan(0);
  });

  it("does not reject a broad remote role for a selected country and handles range bounds", () => {
    const preferences = completePreferences({ cities: [], remote: false });
    const remote = makeInternship({
      id: "worldwide-remote",
      location: ["Remote"],
      normalizedLocations: [{
        raw: "Remote",
        country: null,
        provinceState: null,
        city: null,
        remote: true,
        remoteScope: "worldwide",
      }],
      remoteStatus: "remote",
    });
    expect(evaluateInternshipMatch(preferences, remote).eligible).toBe(true);

    const outsideRange = makeInternship({
      id: "outside-range",
      qualificationDetails: {
        ...makeInternship().qualificationDetails,
        graduationYears: [],
        graduationYearRange: { min: 2027, max: 2028 },
      },
    });
    expect(evaluateInternshipMatch({ ...preferences, graduationYear: 2029 }, outsideRange).eligible).toBe(false);
  });

  it("uses the listing id as a final deterministic tie breaker", () => {
    const preferences = completePreferences();
    const first = makeInternship({ id: "a-role", company: "Same", title: "Same", relevanceScore: 50 });
    const second = makeInternship({ id: "b-role", company: "Same", title: "Same", relevanceScore: 50 });
    expect(rankInternships(preferences, [second, first]).map(({ internship }) => internship.id)).toEqual(["a-role", "b-role"]);
  });
});
