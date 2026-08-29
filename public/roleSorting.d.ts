export function parseSortDate(value: unknown, relativeBase?: number): number | null;

export function isDashboardPostingTooOld(value: string | null | undefined, relativeBase?: number): boolean;

export const ROLE_SEASONS: readonly ["winter", "spring", "summer", "fall"];
export const ROLE_SEASON_FILTERS: readonly ["winter", "spring", "summer", "fall", "unknown"];
export function normalizeRoleSeason(value: unknown): "winter" | "spring" | "summer" | "fall" | null;
export function roleSeasons(role: {
  seasons?: string[];
  title?: string | null;
  description?: string | null;
  responsibilities?: string[];
  requiredQualifications?: string[];
  preferredQualifications?: string[];
  technologies?: string[];
  educationRequirements?: string[];
  graduationRequirements?: string[];
  experienceRequirements?: string[];
  workAuthorizationRequirements?: string[];
  sponsorshipInformation?: string | null;
  qualificationDetails?: unknown;
  internshipTerm?: string | null;
  internshipYear?: string | null;
  duration?: string | null;
  salary?: string | null;
}): Array<"winter" | "spring" | "summer" | "fall">;
export function roleHasSeason(role: Parameters<typeof roleSeasons>[0], season: "winter" | "spring" | "summer" | "fall" | "unknown"): boolean;
export function roleSeason(role: {
  seasons?: string[];
  internshipTerm?: string | null;
  internshipYear?: string | null;
  title?: string | null;
}): "winter" | "spring" | "summer" | "fall" | "unknown";
export function compareBySeason(left: {
  company: string;
  title: string;
  relevanceScore: number;
  internshipTerm?: string | null;
  internshipYear?: string | null;
}, right: {
  company: string;
  title: string;
  relevanceScore: number;
  internshipTerm?: string | null;
  internshipYear?: string | null;
}): number;

export function compareByPostedDate(left: {
  company: string;
  postingDate: string | null;
  relevanceScore: number;
  title: string;
}, right: {
  company: string;
  postingDate: string | null;
  relevanceScore: number;
  title: string;
}): number;
