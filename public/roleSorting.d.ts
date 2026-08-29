export function parseSortDate(value: unknown, relativeBase?: number): number | null;

export function isDashboardPostingTooOld(value: string | null | undefined, relativeBase?: number): boolean;

export const ROLE_SEASONS: readonly ["winter", "spring", "summer", "fall"];
export const ROLE_SEASON_FILTERS: readonly ["winter", "spring", "summer", "fall", "unknown"];
export function normalizeRoleSeason(value: unknown): "winter" | "spring" | "summer" | "fall" | null;
export function roleSeason(role: {
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
