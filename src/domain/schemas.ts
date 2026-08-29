import { z } from "zod";

import { MIN_LISTING_SCORE } from "../config/thresholds.js";

export const CATEGORIES = [
  "swe",
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "qa",
  "devops",
  "cloud",
  "data",
  "ml",
  "ai",
  "security",
  "embedded",
  "quant",
  "research",
  "other-code",
] as const;

/**
 * `other` was emitted by an older classifier before the canonical category
 * name was settled on `other-code`. Keep the persisted vocabulary stable and
 * normalize that legacy value at every schema boundary instead of letting one
 * historical row abort an entire crawl transaction.
 */
export function normalizeCategory(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "other" || normalized === "other_code" || normalized === "other code") return "other-code";
  return value;
}

export const CategorySchema = z.preprocess(normalizeCategory, z.enum(CATEGORIES));
export type Category = z.infer<typeof CategorySchema>;

export const RemoteStatusSchema = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

export const NormalizedLocationSchema = z.object({
  raw: z.string(),
  country: z.string().nullable(),
  provinceState: z.string().nullable(),
  city: z.string().nullable(),
  remote: z.boolean(),
  remoteScope: z.enum(["canada", "usa", "north-america", "worldwide", "unspecified"]).nullable(),
});
export type NormalizedLocation = z.infer<typeof NormalizedLocationSchema>;

export const LifecycleStatusSchema = z.enum(["NEW", "UPDATED", "UNCHANGED", "REMOVED_OR_CLOSED"]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

export const AvailabilityStatusSchema = z.enum(["open", "closed", "unknown"]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

/** Explicit structured states used by deterministic qualification parsing. */
export const QualificationTriStateSchema = z.enum(["yes", "no", "unknown"]);
export type QualificationTriState = z.infer<typeof QualificationTriStateSchema>;
export const WorkAuthorizationStateSchema = z.enum(["required", "not_required", "unknown"]);
export type WorkAuthorizationState = z.infer<typeof WorkAuthorizationStateSchema>;
export const SponsorshipStateSchema = z.enum(["available", "unavailable", "required", "unknown"]);
export type SponsorshipState = z.infer<typeof SponsorshipStateSchema>;

/**
 * A normalized posting requirement.  `preferred` is intentionally distinct
 * from `required`: a preference must never become a hard eligibility failure.
 * `conflict` is retained when deterministic extraction finds contradictory
 * structured evidence instead of guessing which statement wins.
 */
export const QualificationRequirementStateSchema = z.enum([
  "required",
  "preferred",
  "not_required",
  "unknown",
  "conflict",
]);
export type QualificationRequirementState = z.infer<typeof QualificationRequirementStateSchema>;

export const QualificationConflictKeySchema = z.enum([
  "graduation",
  "degree",
  "year_of_study",
  "work_authorization",
  "sponsorship",
  "student_status",
  "enrollment",
  "returning_to_school",
]);
export type QualificationConflictKey = z.infer<typeof QualificationConflictKeySchema>;

export const QualificationConflictSchema = z.object({
  key: QualificationConflictKeySchema,
  evidence: z.array(z.string()).min(1),
});
export type QualificationConflict = z.infer<typeof QualificationConflictSchema>;

export const GraduationYearRangeSchema = z.object({
  min: z.number().int().min(1900).max(2200),
  max: z.number().int().min(1900).max(2200),
}).refine(({ min, max }) => min <= max, "Graduation range must be ordered from earliest to latest year.");

/**
 * Structured facts are additive and defaulted so payloads written by older
 * crawler versions remain valid. Raw evidence continues to live in the
 * existing `*Requirements` arrays and is never discarded.
 */
export const QualificationDetailsSchema = z.object({
  graduationYears: z.array(z.number().int().min(1900).max(2200)).default([]),
  graduationYearRange: GraduationYearRangeSchema.nullable().default(null),
  expectedGraduation: z.string().nullable().default(null),
  yearOfStudy: z.array(z.string()).default([]),
  firstYearEligible: QualificationTriStateSchema.default("unknown"),
  upperYearRequired: QualificationTriStateSchema.default("unknown"),
  upperYearRequirement: z.string().nullable().default(null),
  degreeRequirements: z.array(z.string()).default([]),
  workAuthorization: WorkAuthorizationStateSchema.default("unknown"),
  sponsorship: SponsorshipStateSchema.default("unknown"),
  /** Whether the posting requires, prefers, or explicitly does not require a student. */
  studentStatusRequirement: QualificationRequirementStateSchema.default("unknown"),
  /** Whether current enrollment is an explicit posting requirement. */
  enrollmentRequirement: QualificationRequirementStateSchema.default("unknown"),
  /** Whether the candidate must return to school after the placement. */
  returningToSchoolRequirement: QualificationRequirementStateSchema.default("unknown"),
  /** Contradictory facts are retained for the eligibility engine to surface. */
  conflicts: z.array(QualificationConflictSchema).default([]),
  locationModality: RemoteStatusSchema.default("unknown"),
  applicationUrl: z.string().nullable().default(null),
  deadline: z.string().nullable().default(null),
  evidence: z.array(z.string()).default([]),
});
export type QualificationDetails = z.infer<typeof QualificationDetailsSchema>;

export const InternshipSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().nullable(),
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.array(z.string()),
  normalizedLocations: z.array(NormalizedLocationSchema),
  remoteStatus: RemoteStatusSchema,

  applicationUrl: z.url(),
  postingUrl: z.url(),
  sourceUrl: z.url(),
  sources: z.array(z.url()).min(1),

  description: z.string(),
  responsibilities: z.array(z.string()),
  requiredQualifications: z.array(z.string()),
  preferredQualifications: z.array(z.string()),
  technologies: z.array(z.string()),

  educationRequirements: z.array(z.string()),
  graduationRequirements: z.array(z.string()),
  experienceRequirements: z.array(z.string()),
  workAuthorizationRequirements: z.array(z.string()),
  sponsorshipInformation: z.string().nullable(),
  qualificationDetails: QualificationDetailsSchema.default({
    graduationYears: [],
    graduationYearRange: null,
    expectedGraduation: null,
    yearOfStudy: [],
    firstYearEligible: "unknown",
    upperYearRequired: "unknown",
    upperYearRequirement: null,
    degreeRequirements: [],
    workAuthorization: "unknown",
    sponsorship: "unknown",
    studentStatusRequirement: "unknown",
    enrollmentRequirement: "unknown",
    returningToSchoolRequirement: "unknown",
    conflicts: [],
    locationModality: "unknown",
    applicationUrl: null,
    deadline: null,
    evidence: [],
  }),

  internshipTerm: z.string().nullable(),
  internshipYear: z.string().nullable(),
  duration: z.string().nullable(),
  salary: z.string().nullable(),
  postingDate: z.string().nullable(),
  deadline: z.string().nullable(),

  categories: z.array(CategorySchema).min(1),
  relevanceScore: z.number().int().min(0).max(100),
  relevanceReason: z.string().min(1),

  lifecycleStatus: LifecycleStatusSchema,
  availabilityStatus: AvailabilityStatusSchema,
  discoveredAt: z.iso.datetime(),
  lastVerifiedAt: z.iso.datetime(),
});

export type Internship = z.infer<typeof InternshipSchema>;

export const ScoutSettingsSchema = z.object({
  maxDepth: z.number().int().min(0).max(12).default(4),
  maxPagesPerSource: z.number().int().min(1).max(10_000).default(100),
  /** General request ceiling retained for backwards compatibility. */
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
  /** Staged transport budgets. Native fetch cannot expose connect/read
   * phases independently on every Node release, but these values let the
   * HTTP and browser lanes apply bounded operation deadlines consistently. */
  connectTimeoutMs: z.number().int().min(250).max(120_000).default(3_000),
  readTimeoutMs: z.number().int().min(500).max(300_000).default(7_000),
  navigationTimeoutMs: z.number().int().min(1_000).max(300_000).default(10_000),
  selectorTimeoutMs: z.number().int().min(250).max(120_000).default(5_000),
  pageTimeoutMs: z.number().int().min(1_000).max(600_000).default(15_000),
  httpConcurrency: z.number().int().min(1).max(64).default(24),
  browserConcurrency: z.number().int().min(1).max(16).default(4),
  perDomainConcurrency: z.number().int().min(1).max(16).default(3),
  concurrency: z.number().int().min(1).max(20).default(4),
  retryCount: z.number().int().min(0).max(8).default(2),
  cacheTtlMs: z.number().int().min(0).max(31_536_000_000).default(21_600_000),
  /** Maximum age for an identity-only listing sighting to avoid a deep fetch. */
  detailRecheckTtlMs: z.number().int().min(0).max(31_536_000_000).default(21_600_000),
  circuitBreakerFailureThreshold: z.number().int().min(1).max(10).default(3),
  circuitBreakerCooldownMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
  minRelevanceScore: z.number().int().min(0).max(100).default(MIN_LISTING_SCORE),
  // Per-domain semaphores provide the primary bound. This small delay keeps
  // the default crawl fast while still remaining polite and is raised by
  // robots.txt Crawl-delay and adaptive transport backoff when present.
  perHostDelayMs: z.number().int().min(0).max(60_000).default(100),
  maxLoadMoreClicks: z.number().int().min(0).max(20).default(6),
  closedAfterMisses: z.number().int().min(1).max(10).default(2),
  respectRobotsTxt: z.boolean().default(true),
  userAgent: z.string().min(1).default("InternshipScout/1.0 (+respectful job discovery crawler)"),
  databasePath: z.string().min(1).default("./output/internships.db"),
  outputDirectory: z.string().min(1).default("./output"),
  verbose: z.boolean().default(false),
  headless: z.boolean().default(true),
});

export type ScoutSettings = z.infer<typeof ScoutSettingsSchema>;

export const CliFiltersSchema = z.object({
  location: z.string().optional(),
  categories: z.array(CategorySchema).default([]),
  newOnly: z.boolean().default(false),
  minScore: z.number().int().min(0).max(100).default(MIN_LISTING_SCORE),
});

export type CliFilters = z.infer<typeof CliFiltersSchema>;
