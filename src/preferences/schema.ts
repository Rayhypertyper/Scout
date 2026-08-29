import { z } from "zod";

import { TECHNOLOGY_NAMES } from "../classification/technologyExtractor.js";
import { CATEGORIES, CategorySchema, type Category } from "../domain/schemas.js";
import { SUPPORTED_CITY_OPTIONS } from "../parsing/locations.js";
import { stripDiacritics } from "../utils/text.js";

export const TERM_SEASONS = ["winter", "spring", "summer", "fall"] as const;
export const TermSeasonSchema = z.enum(TERM_SEASONS);
export type TermSeason = z.infer<typeof TermSeasonSchema>;

export const PREFERENCE_COUNTRIES = ["canada", "united_states"] as const;
export const PreferenceCountrySchema = z.enum(PREFERENCE_COUNTRIES);
export type PreferenceCountry = z.infer<typeof PreferenceCountrySchema>;

export const DEGREE_LEVELS = ["bachelors", "masters", "phd", "other"] as const;
export const DegreeLevelSchema = z.enum(DEGREE_LEVELS);
export type DegreeLevel = z.infer<typeof DegreeLevelSchema>;

export const WORK_AUTHORIZATION_STATES = ["authorized", "needs_assistance", "unsure"] as const;
export const WorkAuthorizationPreferenceSchema = z.enum(WORK_AUTHORIZATION_STATES);
export type WorkAuthorizationPreference = z.infer<typeof WorkAuthorizationPreferenceSchema>;

export const SPONSORSHIP_NEEDS = ["none", "now", "future", "unsure"] as const;
export const SponsorshipPreferenceSchema = z.enum(SPONSORSHIP_NEEDS);
export type SponsorshipPreference = z.infer<typeof SponsorshipPreferenceSchema>;

/** Canonical study-year values used by the deterministic eligibility engine. */
export const CURRENT_YEAR_OF_STUDY = [
  "first-year",
  "second-year",
  "third-year",
  "fourth-year",
  "fifth-year",
  "graduate",
  "other",
  "unsure",
] as const;
export const CurrentYearOfStudySchema = z.enum(CURRENT_YEAR_OF_STUDY);
export type CurrentYearOfStudy = z.infer<typeof CurrentYearOfStudySchema>;

export const CURRENT_ENROLLMENT_STATUSES = ["enrolled", "not_enrolled", "graduated", "unsure"] as const;
export const CurrentEnrollmentStatusSchema = z.enum(CURRENT_ENROLLMENT_STATUSES);
export type CurrentEnrollmentStatus = z.infer<typeof CurrentEnrollmentStatusSchema>;

export const RETURNING_TO_SCHOOL_ANSWERS = ["yes", "no", "unsure"] as const;
export const ReturningToSchoolPreferenceSchema = z.enum(RETURNING_TO_SCHOOL_ANSWERS);
export type ReturningToSchoolPreference = z.infer<typeof ReturningToSchoolPreferenceSchema>;

/** Optional month support remains separate from the existing year answer. */
export const GraduationMonthSchema = z.number().int().min(1).max(12).nullable();
export type GraduationMonth = z.infer<typeof GraduationMonthSchema>;

export const InternshipTermPreferenceSchema = z.object({
  term: TermSeasonSchema,
  year: z.number().int().min(2000).max(2200),
});
export type InternshipTermPreference = z.infer<typeof InternshipTermPreferenceSchema>;

function cityTaxonomyKey(value: string): string {
  // Keep comparison aligned with the parser's taxonomy: diacritics and
  // periods are presentation differences, while whitespace is significant
  // only as a separator. The submitted value itself is never coerced.
  return stripDiacritics(value).toLocaleLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

const supportedCityKeys = new Set(SUPPORTED_CITY_OPTIONS.map(({ name, country }) => (
  `${country === "Canada" ? "canada" : "united_states"}:${cityTaxonomyKey(name)}`
)));

export const CityPreferenceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  country: PreferenceCountrySchema,
}).superRefine(({ name, country }, context) => {
  if (supportedCityKeys.has(`${country}:${cityTaxonomyKey(name)}`)) return;
  context.addIssue({
    code: "custom",
    path: ["name"],
    message: "Choose a city from the supported Canada/United States city taxonomy.",
  });
});
export type CityPreference = z.infer<typeof CityPreferenceSchema>;

const technologySet = new Set(TECHNOLOGY_NAMES);
const TechnologyPreferenceSchema = z.string().refine(
  (value) => technologySet.has(value),
  "Choose a technology from the supported listing taxonomy.",
);

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

export const TermStepSchema = z.object({
  terms: z.array(InternshipTermPreferenceSchema)
    .min(1, "Add at least 1 internship term.")
    .max(8, "Choose no more than 8 internship terms.")
    .refine((values) => uniqueBy(values, ({ term, year }) => `${term}:${year}`), "Remove duplicate internship terms."),
});
export type TermStep = z.infer<typeof TermStepSchema>;

export const PreferenceStepSchema = z.object({
  countries: z.array(PreferenceCountrySchema)
    .max(PREFERENCE_COUNTRIES.length)
    .refine((values) => uniqueBy(values, String), "Remove duplicate countries."),
  cities: z.array(CityPreferenceSchema)
    .max(12, "Choose no more than 12 cities.")
    .refine((values) => uniqueBy(values, ({ name, country }) => `${country}:${name.toLocaleLowerCase()}`), "Remove duplicate cities."),
  remote: z.boolean(),
  roleCategories: z.array(CategorySchema)
    .min(1, "Choose at least 1 role category.")
    .max(CATEGORIES.length)
    .refine((values) => uniqueBy(values, String), "Remove duplicate role categories."),
  technologies: z.array(TechnologyPreferenceSchema)
    .max(12, "Choose no more than 12 technologies.")
    .refine((values) => uniqueBy(values, (value) => value.toLocaleLowerCase()), "Remove duplicate technologies."),
}).superRefine((value, context) => {
  if (value.countries.length === 0 && value.cities.length === 0 && !value.remote) {
    context.addIssue({
      code: "custom",
      path: ["countries"],
      message: "Choose a country, a city, or remote roles.",
    });
  }
});
export type PreferenceStep = z.infer<typeof PreferenceStepSchema>;

const RegionalWorkAuthorizationSchema = z.object({
  canada: WorkAuthorizationPreferenceSchema.nullable().default(null),
  unitedStates: WorkAuthorizationPreferenceSchema.nullable().default(null),
});

const RegionalSponsorshipSchema = z.object({
  canada: SponsorshipPreferenceSchema.nullable().default(null),
  unitedStates: SponsorshipPreferenceSchema.nullable().default(null),
});

export const EligibilityStepSchema = z.object({
  degree: DegreeLevelSchema,
  graduationYear: z.number().int().min(2000).max(2200),
  graduationYearOrLater: z.boolean(),
  currentYearOfStudy: CurrentYearOfStudySchema.default("unsure"),
  currentEnrollmentStatus: CurrentEnrollmentStatusSchema.default("unsure"),
  returningToSchool: ReturningToSchoolPreferenceSchema.default("unsure"),
  graduationMonth: GraduationMonthSchema.default(null),
  workAuthorization: RegionalWorkAuthorizationSchema,
  sponsorship: RegionalSponsorshipSchema,
});
export type EligibilityStep = z.infer<typeof EligibilityStepSchema>;

/**
 * The persisted representation is intentionally looser than the final
 * submission schema.  During onboarding, step 1 and step 2 are valid partial
 * states, so reading a row must not run the completion-only refinements.  The
 * defaults also let rows written by an earlier version of the feature restore
 * safely when a newly-added field is absent.
 */
export const PreferenceAnswersStorageSchema = z.object({
  terms: z.array(InternshipTermPreferenceSchema).max(8).default([]),
  countries: z.array(PreferenceCountrySchema).max(PREFERENCE_COUNTRIES.length).default([]),
  cities: z.array(CityPreferenceSchema).max(12).default([]),
  remote: z.boolean().default(false),
  roleCategories: z.array(CategorySchema).max(CATEGORIES.length).default([]),
  technologies: z.array(TechnologyPreferenceSchema).max(12).default([]),
  degree: DegreeLevelSchema.nullable().default(null),
  graduationYear: z.number().int().min(2000).max(2200).nullable().default(null),
  graduationYearOrLater: z.boolean().default(false),
  currentYearOfStudy: CurrentYearOfStudySchema.default("unsure"),
  currentEnrollmentStatus: CurrentEnrollmentStatusSchema.default("unsure"),
  returningToSchool: ReturningToSchoolPreferenceSchema.default("unsure"),
  graduationMonth: GraduationMonthSchema.default(null),
  workAuthorization: RegionalWorkAuthorizationSchema.default({ canada: null, unitedStates: null }),
  sponsorship: RegionalSponsorshipSchema.default({ canada: null, unitedStates: null }),
});

const BasePreferenceAnswersSchema = PreferenceAnswersStorageSchema.extend({
  // Completion requires the step-specific minimums and uniqueness rules.
  terms: TermStepSchema.shape.terms,
  countries: PreferenceStepSchema.shape.countries,
  cities: PreferenceStepSchema.shape.cities,
  roleCategories: PreferenceStepSchema.shape.roleCategories,
  technologies: PreferenceStepSchema.shape.technologies,
});

function countriesRequiringEligibility(value: z.infer<typeof BasePreferenceAnswersSchema>): Set<PreferenceCountry> {
  return new Set([
    ...value.countries,
    ...value.cities.map(({ country }) => country),
  ]);
}

export const PreferenceAnswersSchema = BasePreferenceAnswersSchema.superRefine((value, context) => {
  if (value.countries.length === 0 && value.cities.length === 0 && !value.remote) {
    context.addIssue({ code: "custom", path: ["countries"], message: "Choose a country, a city, or remote roles." });
  }
  if (value.degree === null) {
    context.addIssue({ code: "custom", path: ["degree"], message: "Choose your current degree." });
  }
  if (value.graduationYear === null) {
    context.addIssue({ code: "custom", path: ["graduationYear"], message: "Choose your expected graduation year." });
  }
  for (const country of countriesRequiringEligibility(value)) {
    const key = country === "canada" ? "canada" : "unitedStates";
    if (value.workAuthorization[key] === null) {
      context.addIssue({ code: "custom", path: ["workAuthorization", key], message: "Choose a work authorization answer for this location." });
    }
    if (value.sponsorship[key] === null) {
      context.addIssue({ code: "custom", path: ["sponsorship", key], message: "Choose a sponsorship answer for this location." });
    }
  }
});
type ParsedPreferenceAnswers = z.infer<typeof PreferenceAnswersSchema>;

/**
 * New eligibility answers are optional at the TypeScript boundary so callers
 * holding an older completed profile remain source-compatible.  All parser
 * and storage paths materialize the explicit `unsure`/null defaults above.
 */
export type PreferenceAnswers = Omit<ParsedPreferenceAnswers, "currentYearOfStudy" | "currentEnrollmentStatus" | "returningToSchool" | "graduationMonth">
  & Partial<Pick<ParsedPreferenceAnswers, "currentYearOfStudy" | "currentEnrollmentStatus" | "returningToSchool" | "graduationMonth">>;

export interface InternshipPreferences extends PreferenceAnswers {
  onboardingCompleted: boolean;
  currentStep: 1 | 2 | 3;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface PreferenceValidationIssue {
  field: string;
  message: string;
}

export class PreferenceValidationError extends Error {
  readonly issues: PreferenceValidationIssue[];

  constructor(issues: PreferenceValidationIssue[]) {
    super(issues[0]?.message ?? "Check your preferences and try again.");
    this.name = "PreferenceValidationError";
    this.issues = issues;
  }
}

function validationError(error: z.ZodError): PreferenceValidationError {
  return new PreferenceValidationError(error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  })));
}

export function parsePreferenceStep(step: 1, value: unknown): TermStep;
export function parsePreferenceStep(step: 2, value: unknown): PreferenceStep;
export function parsePreferenceStep(step: 3, value: unknown): EligibilityStep;
export function parsePreferenceStep(step: 1 | 2 | 3, value: unknown): TermStep | PreferenceStep | EligibilityStep {
  const schema = step === 1 ? TermStepSchema : step === 2 ? PreferenceStepSchema : EligibilityStepSchema;
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function parseCompletePreferenceAnswers(value: unknown): PreferenceAnswers {
  const result = PreferenceAnswersSchema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function emptyPreferenceAnswers(): PreferenceAnswers {
  return {
    terms: [],
    countries: [],
    cities: [],
    remote: false,
    roleCategories: [],
    technologies: [],
    degree: null,
    graduationYear: null,
    graduationYearOrLater: false,
    currentYearOfStudy: "unsure",
    currentEnrollmentStatus: "unsure",
    returningToSchool: "unsure",
    graduationMonth: null,
    workAuthorization: { canada: null, unitedStates: null },
    sponsorship: { canada: null, unitedStates: null },
  };
}

const CATEGORY_LABELS: Record<Category, string> = {
  swe: "Software Engineering",
  frontend: "Frontend",
  backend: "Backend",
  fullstack: "Full Stack",
  mobile: "Mobile",
  qa: "QA / Test Automation",
  devops: "DevOps / Infrastructure",
  cloud: "Cloud Engineering",
  data: "Data Science & Engineering",
  ml: "Machine Learning",
  ai: "AI / Applied AI",
  security: "Cybersecurity",
  embedded: "Embedded / Firmware",
  quant: "Quant / Trading",
  research: "Research",
  "other-code": "Other Technical Roles",
};

const CITY_OPTIONS: Array<CityPreference & { region: string }> = SUPPORTED_CITY_OPTIONS.map(({ name, country, region }) => ({
  name,
  country: country === "Canada" ? "canada" : "united_states",
  region,
}));

export function preferenceOptions(now = new Date()): Record<string, unknown> {
  const currentYear = now.getUTCFullYear();
  return {
    seasons: TERM_SEASONS.map((value) => ({ value, label: `${value.charAt(0).toUpperCase()}${value.slice(1)}` })),
    termYears: Array.from({ length: 7 }, (_, index) => currentYear + index),
    countries: [
      { value: "canada", label: "Canada" },
      { value: "united_states", label: "United States" },
    ],
    cities: CITY_OPTIONS,
    roleCategories: CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
    technologies: TECHNOLOGY_NAMES,
    degrees: [
      { value: "bachelors", label: "Bachelor’s" },
      { value: "masters", label: "Master’s" },
      { value: "phd", label: "PhD" },
      { value: "other", label: "Other" },
    ],
    graduationYears: Array.from({ length: 7 }, (_, index) => currentYear + index),
    graduationMonths: Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: new Date(Date.UTC(2020, index, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" }) })),
    currentYearOfStudy: CURRENT_YEAR_OF_STUDY.map((value) => ({
      value,
      label: value === "unsure" ? "Not sure" : value === "other" ? "Other" : value.replace("-", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase()),
    })),
    currentEnrollmentStatus: CURRENT_ENROLLMENT_STATUSES.map((value) => ({
      value,
      label: value === "unsure" ? "Not sure" : value === "not_enrolled" ? "Not currently enrolled" : value === "graduated" ? "Graduated" : "Currently enrolled",
    })),
    returningToSchool: RETURNING_TO_SCHOOL_ANSWERS.map((value) => ({
      value,
      label: value === "yes" ? "Yes" : value === "no" ? "No" : "Not sure",
    })),
    workAuthorization: [
      { value: "authorized", label: "Authorized to work" },
      { value: "needs_assistance", label: "Would require work authorization assistance" },
      { value: "unsure", label: "Not sure" },
    ],
    sponsorship: [
      { value: "none", label: "Do not need employer sponsorship" },
      { value: "now", label: "Need sponsorship now" },
      { value: "future", label: "May need sponsorship in the future" },
      { value: "unsure", label: "Not sure" },
    ],
  };
}
