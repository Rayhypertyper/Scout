import type { Internship } from "./domain/schemas.js";
import { detectInternship } from "./classification/roleClassifier.js";
import { parseLocation } from "./parsing/locations.js";

export const ROLE_TABS = ["main", "canada", "summer", "internship", "quant", "non-intern"] as const;
export type RoleTab = typeof ROLE_TABS[number];

type TabRole = Pick<
  Internship,
  | "title"
  | "categories"
  | "description"
  | "responsibilities"
  | "requiredQualifications"
  | "preferredQualifications"
  | "workAuthorizationRequirements"
  | "qualificationDetails"
  | "internshipTerm"
  | "internshipYear"
  | "location"
  | "normalizedLocations"
  | "sourceUrl"
>;

const QUANT_TITLE_PATTERN = /\b(?:quant|quantitative|trade|trader|trading)\b/i;
const SUMMER_PATTERN = /\bsummer\b/i;

export function isCanadaRole(role: TabRole): boolean {
  const rawLocations = /(?:^|\.)useno\.app\/internship-masterlist(?:\/|$)/i.test(role.sourceUrl)
    ? role.location.slice(0, 1)
    : role.location;
  if (rawLocations.length > 0) {
    return rawLocations.some((rawLocation) => {
      const location = parseLocation(rawLocation);
      return location.remoteScope === "canada"
        || ["canada", "canadian"].includes(location.country?.toLocaleLowerCase() ?? "");
    });
  }
  return role.normalizedLocations.some((location) => (
    location.remoteScope === "canada"
    || ["canada", "canadian"].includes(location.country?.toLocaleLowerCase() ?? "")
  ));
}

export function isQuantRole(role: TabRole): boolean {
  return role.categories.includes("quant") || QUANT_TITLE_PATTERN.test(role.title);
}

export function isSummerRole(role: TabRole): boolean {
  const postingText = [
    role.description,
    ...role.responsibilities,
    ...role.requiredQualifications,
    ...role.preferredQualifications,
  ].join("\n");
  const summerText = [
    role.title,
    postingText,
    role.internshipTerm,
    role.internshipYear,
  ].filter(Boolean).join("\n");
  return isInternshipRole(role) && SUMMER_PATTERN.test(summerText);
}

export function isInternshipRole(role: TabRole): boolean {
  const postingText = [role.description, ...role.responsibilities].join("\n");
  const qualificationText = [
    ...role.requiredQualifications,
    ...role.preferredQualifications,
    ...role.workAuthorizationRequirements,
  ].join("\n");
  return detectInternship(role.title, postingText, qualificationText).isInternship;
}

export function roleMatchesTab(role: TabRole, tab: RoleTab): boolean {
  const quant = isQuantRole(role);
  if (tab === "quant") return quant;
  if (quant) return false;
  if (tab === "main") return true;
  if (tab === "canada") return isCanadaRole(role);
  const internship = isInternshipRole(role);
  if (tab === "summer") return isSummerRole(role);
  if (tab === "internship") return internship;
  if (tab === "non-intern") return !internship;
  return true;
}

export function buildRoleTabKeys<T extends TabRole>(
  roles: readonly T[],
  keyForRole: (role: T) => string,
): Record<RoleTab, string[]> {
  return Object.fromEntries(ROLE_TABS.map((tab) => [
    tab,
    roles.filter((role) => roleMatchesTab(role, tab)).map(keyForRole),
  ])) as Record<RoleTab, string[]>;
}
