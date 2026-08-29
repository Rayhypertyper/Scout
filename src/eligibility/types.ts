import type { PreferenceCountry } from "../preferences/schema.js";

/** Bump only when criterion semantics or the public result contract changes. */
export const ELIGIBILITY_ENGINE_VERSION = "eligibility-v1" as const;

export const ELIGIBILITY_STATUSES = [
  "not_eligible",
  "unclear",
  "likely_eligible",
  "eligible",
] as const;
export type EligibilityStatus = typeof ELIGIBILITY_STATUSES[number];

export const ELIGIBILITY_CRITERION_KEYS = [
  "term",
  "country_location",
  "work_authorization",
  "sponsorship",
  "degree",
  "graduation",
  "year_of_study",
  "current_enrollment",
  "returning_to_school",
] as const;
export type EligibilityCriterionKey = typeof ELIGIBILITY_CRITERION_KEYS[number];

export const ELIGIBILITY_CRITERION_STATES = [
  "pass",
  "fail",
  "unknown",
  "not_applicable",
  "conflict",
] as const;
export type EligibilityCriterionState = typeof ELIGIBILITY_CRITERION_STATES[number];

export type EligibilityUnknownSource = "profile" | "posting" | "both" | "conflict";

/** Evidence is always a value copied from a normalized posting/profile fact. */
export interface EligibilityEvidence {
  source: "profile" | "posting";
  field: string;
  value: string | number | boolean | null;
}

export interface EligibilityCriterionResult {
  key: EligibilityCriterionKey;
  state: EligibilityCriterionState;
  /** Every criterion in this engine is a hard criterion when applicable. */
  hard: true;
  applicable: boolean;
  reason: string;
  evidence: EligibilityEvidence[];
  /** Null for resolved states; useful for deterministic status aggregation. */
  unknownSource: EligibilityUnknownSource | null;
}

export type EligibilityCriteria = {
  [Key in EligibilityCriterionKey]: EligibilityCriterionResult & { key: Key };
};

export interface EligibilityEvaluation {
  version: typeof ELIGIBILITY_ENGINE_VERSION;
  status: EligibilityStatus;
  /** Stable-key lookup for API/UI consumers. */
  criteria: EligibilityCriteria;
  /** Stable criterion order for table/list rendering. */
  criterionResults: EligibilityCriterionResult[];
}

/** Kept public for clients that need to label a criterion by supported country. */
export type SupportedEligibilityCountry = PreferenceCountry;
