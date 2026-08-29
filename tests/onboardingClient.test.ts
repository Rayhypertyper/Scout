import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as multiSelect from "../public/onboarding/multi-select.js";
import * as onboardingClient from "../public/onboarding/onboarding.js";

type PreferenceState = {
  terms: Array<{ term: string; year: number }>;
  countries: string[];
  cities: Array<{ name: string; country: string }>;
  remote: boolean;
  roleCategories: string[];
  technologies: string[];
  degree: string | null;
  graduationYear: number | null;
  graduationYearOrLater: boolean;
  workAuthorization: { canada: string | null; unitedStates: string | null };
  sponsorship: { canada: string | null; unitedStates: string | null };
};

type OnboardingClient = {
  createSubmissionGate: () => { enter: () => boolean; leave: () => void; isActive: () => boolean };
  graduationYearOptions: (values?: unknown[], selectedYear?: number | null) => Array<{ value: string; label: string }>;
  mergePreferenceState: (previous: unknown, next: unknown) => PreferenceState;
  mergeSavedStepState: (previous: PreferenceState, next: unknown, step: number) => PreferenceState;
  payloadForStep: (step: number, state: PreferenceState) => Record<string, unknown>;
  previousStepState: (step: number, state: PreferenceState) => { step: number; state: PreferenceState };
  requiredCountries: (state: unknown) => string[];
  stepForField: (field: unknown) => number;
  validationIssuesForStep: (step: number, state: unknown) => Array<{ field: string; message: string }>;
};

type MultiSelectClient = {
  activeDescendantOptionId: (activeKey: string | null, visibleKeys: string[], idsByKey: Map<string, string>) => string | null;
  createSelectorOptionId: (instanceId: string, ordinal: number) => string;
  nextActiveKey: (keys: string[], activeKey: string | null, direction: string) => string | null;
  selectionAfterToggle: (keys: string[], key: string, maximum?: number) => {
    keys: string[];
    selected: boolean;
    changed: boolean;
    blocked: boolean;
  };
};

const {
  createSubmissionGate,
  graduationYearOptions,
  mergePreferenceState,
  mergeSavedStepState,
  payloadForStep,
  previousStepState,
  requiredCountries,
  stepForField,
  validationIssuesForStep,
} = onboardingClient as unknown as OnboardingClient;

const {
  activeDescendantOptionId,
  createSelectorOptionId,
  nextActiveKey,
  selectionAfterToggle,
} = multiSelect as unknown as MultiSelectClient;

function answers() {
  return {
    terms: [{ term: "summer", year: 2027 }],
    countries: ["canada"],
    cities: [],
    remote: true,
    roleCategories: ["swe"],
    technologies: ["TypeScript"],
    degree: "bachelors",
    graduationYear: 2028,
    graduationYearOrLater: false,
    workAuthorization: { canada: "authorized", unitedStates: null },
    sponsorship: { canada: "none", unitedStates: null },
  };
}

describe("onboarding client state", () => {
  it("blocks advancement only for genuinely required answers", () => {
    expect(validationIssuesForStep(1, { ...answers(), terms: [] })).toEqual([
      expect.objectContaining({ field: "terms" }),
    ]);
    expect(validationIssuesForStep(2, { ...answers(), countries: [], cities: [], remote: false })).toEqual([
      expect.objectContaining({ field: "countries" }),
    ]);
    expect(validationIssuesForStep(2, { ...answers(), technologies: [] })).toEqual([]);
    expect(validationIssuesForStep(3, { ...answers(), degree: null })).toEqual([
      expect.objectContaining({ field: "degree" }),
    ]);
  });

  it("retains answers when navigating backward", () => {
    const state = answers();
    const previous = previousStepState(3, state);
    expect(previous.step).toBe(2);
    expect(previous.state).toBe(state);
    expect(previous.state).toEqual(answers());
  });

  it("keeps step payloads isolated and prevents double submission", () => {
    const state = answers();
    expect(payloadForStep(1, state)).toEqual({ terms: state.terms });
    expect(payloadForStep(2, state)).not.toHaveProperty("degree");
    expect(payloadForStep(3, state)).not.toHaveProperty("terms");

    const gate = createSubmissionGate();
    expect(gate.enter()).toBe(true);
    expect(gate.enter()).toBe(false);
    gate.leave();
    expect(gate.enter()).toBe(true);
  });

  it("requires regional eligibility for every selected country, including city-only choices", () => {
    const state = {
      ...answers(),
      countries: ["canada"],
      cities: [{ name: "New York", country: "united_states" }],
      workAuthorization: { canada: "authorized", unitedStates: null },
      sponsorship: { canada: "none", unitedStates: null },
    };
    expect(requiredCountries(state)).toEqual(["canada", "united_states"]);
    expect(validationIssuesForStep(3, state)).toEqual([
      expect.objectContaining({ field: "workAuthorization.unitedStates" }),
      expect.objectContaining({ field: "sponsorship.unitedStates" }),
    ]);
  });

  it("maps server validation paths back to the visible step", () => {
    expect(stepForField("terms.0.year")).toBe(1);
    expect(stepForField("cities.0.name")).toBe(2);
    expect(stepForField("workAuthorization.unitedStates")).toBe(3);
  });

  it("deep-merges partial server state without dropping the other regional answer", () => {
    const merged = mergePreferenceState({
      ...answers(),
      workAuthorization: { canada: "authorized", unitedStates: "unsure" },
      sponsorship: { canada: "none", unitedStates: "future" },
    }, {
      workAuthorization: { canada: "needs_assistance" },
    });
    expect(merged.workAuthorization).toEqual({ canada: "needs_assistance", unitedStates: "unsure" });
    expect(merged.sponsorship).toEqual({ canada: "none", unitedStates: "future" });
  });

  it("keeps unsaved answers from later steps when an earlier step is saved after going back", () => {
    const local = {
      ...answers(),
      countries: ["canada", "united_states"],
      roleCategories: ["backend"],
      degree: "masters",
    };
    const serverAfterStepOne = {
      ...answers(),
      terms: [{ term: "fall", year: 2028 }],
      currentStep: 2,
    };
    const merged = mergeSavedStepState(local, serverAfterStepOne, 1);
    expect(merged.terms).toEqual([{ term: "fall", year: 2028 }]);
    expect(merged.countries).toEqual(local.countries);
    expect(merged.roleCategories).toEqual(local.roleCategories);
    expect(merged.degree).toBe("masters");
  });

  it("builds a current/future graduation range and keeps a saved year in the options", () => {
    expect(graduationYearOptions([2027, 2028, 2029])).toEqual([
      { value: "2027", label: "2027" },
      { value: "2028", label: "2028" },
      { value: "2029+", label: "2029+" },
    ]);
    expect(graduationYearOptions([2027, 2028], 2026)).toEqual([
      { value: "2026", label: "2026" },
      { value: "2027", label: "2027" },
      { value: "2028+", label: "2028+" },
    ]);
  });

  it("moves the active descendant without moving DOM focus into options", () => {
    expect(nextActiveKey(["a", "b", "c"], null, "next")).toBe("a");
    expect(nextActiveKey(["a", "b", "c"], "a", "next")).toBe("b");
    expect(nextActiveKey(["a", "b", "c"], "a", "previous")).toBe("a");
    expect(nextActiveKey(["a", "b", "c"], null, "previous")).toBe("c");
    expect(nextActiveKey(["a", "b", "c"], "a", "last")).toBe("c");
    expect(nextActiveKey(["a", "b", "c"], "c", "first")).toBe("a");
    expect(nextActiveKey([], null, "next")).toBeNull();
  });

  it("keeps selector option IDs stable per key and isolated per selector", () => {
    const cityFirst = createSelectorOptionId("city-search-instance", 1);
    const cityFirstAgain = createSelectorOptionId("city-search-instance", 1);
    const technologyFirst = createSelectorOptionId("technology-search-instance", 1);
    expect(cityFirst).toBe(cityFirstAgain);
    expect(cityFirst).not.toBe(technologyFirst);
    expect(cityFirst).toMatch(/-option-1$/);
  });

  it("rejects stale active descendants and gates selection at the maximum", () => {
    const ids = new Map([["city", "city-option-1"]]);
    expect(activeDescendantOptionId("city", ["city"], ids)).toBe("city-option-1");
    expect(activeDescendantOptionId("removed-city", ["city"], ids)).toBeNull();
    expect(selectionAfterToggle([], "city", 1)).toEqual({
      keys: ["city"],
      selected: true,
      changed: true,
      blocked: false,
    });
    expect(selectionAfterToggle(["city"], "other-city", 1)).toEqual({
      keys: ["city"],
      selected: false,
      changed: false,
      blocked: true,
    });
    expect(selectionAfterToggle(["city"], "city", 1)).toEqual({
      keys: [],
      selected: false,
      changed: true,
      blocked: false,
    });
  });

  it("keeps the combobox/listbox contract in the selector module", () => {
    const source = readFileSync(new URL("../public/onboarding/multi-select.js", import.meta.url), "utf8");
    expect(source).toContain('input.setAttribute("aria-activedescendant"');
    expect(source).toContain('input.setAttribute("aria-controls"');
    expect(source).toContain('optionNode.setAttribute("aria-selected"');
    expect(source).toContain('optionNode.setAttribute("aria-disabled"');
    expect(source).toContain("createSelectorOptionId");
    expect(source).toContain('event.key === "Enter" && !list.hidden');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("input.focus();");
    expect(source).not.toContain('button.setAttribute("role", "option")');
    expect(source).not.toContain('list.addEventListener("keydown"');
  });
});
