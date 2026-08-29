import type { Internship, NormalizedLocation } from "./domain/schemas.js";
import { detectInternship } from "./classification/roleClassifier.js";
import { parseLocation } from "./parsing/locations.js";
import { dashboardRoleHasSeason } from "./dashboardSort.js";
import { stripDiacritics } from "./utils/text.js";

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
const CANADIAN_CITY_KEYS = new Set([
  "ottawa", "montreal", "calgary", "vancouver", "toronto", "waterloo",
]);

function normalizedCityKey(value: string): string {
  return stripDiacritics(value).toLocaleLowerCase().replace(/\./g, "").trim();
}

function isCanadianLocation(
  location: Pick<NormalizedLocation, "raw" | "country" | "provinceState" | "city" | "remoteScope">,
): boolean {
  const country = location.country?.toLocaleLowerCase() ?? "";
  // A city name alone is enough only for the explicit Canadian city list.
  // Province/state and country markers remain valid evidence, while the
  // parsed country prevents a city such as Toronto in a U.S. location from
  // overriding the U.S. state.
  return location.remoteScope === "canada"
    || (country === "canada" && (
      location.provinceState !== null
      || /\b(?:canada|canadian)\b/i.test(location.raw)
      || (location.city !== null && CANADIAN_CITY_KEYS.has(normalizedCityKey(location.city)))
    ));
}

function rawLocationsForCanada(role: TabRole): string[] {
  // Some aggregators append unrelated location values while merging similar
  // listings. The first value is the location shown on the card and is the
  // only value that should decide whether that card belongs in Canada.
  return role.location.slice(0, 1);
}

/**
 * Return the location that makes a posting eligible for the Canada tab.
 *
 * The primary raw location remains authoritative because older rows can
 * contain stale normalized metadata. When normalized metadata identifies a
 * cleaner fragment inside that same raw value, prefer that fragment for
 * display.
 */
export function canadianLocationForRole(role: TabRole): string | null {
  const rawLocations = rawLocationsForCanada(role);
  if (rawLocations.length > 0) {
    const rawMatch = rawLocations
      .map((raw) => ({ raw, parsed: parseLocation(raw) }))
      .find(({ parsed }) => isCanadianLocation(parsed));
    if (!rawMatch) return null;

    const normalizedMatch = role.normalizedLocations.find((location) => (
      isCanadianLocation(location)
      && isCanadianLocation(parseLocation(location.raw))
      && rawLocations.some((raw) => raw === location.raw || raw.includes(location.raw))
    ));
    return normalizedMatch?.raw ?? rawMatch.raw;
  }

  return role.normalizedLocations.find((location) => (
    isCanadianLocation(location) && isCanadianLocation(parseLocation(location.raw))
  ))?.raw ?? null;
}

export function isCanadaRole(role: TabRole): boolean {
  return canadianLocationForRole(role) !== null;
}

export function isQuantRole(role: TabRole): boolean {
  return role.categories.includes("quant") || QUANT_TITLE_PATTERN.test(role.title);
}

export function isSummerRole(role: TabRole): boolean {
  return isInternshipRole(role) && dashboardRoleHasSeason(role, "summer");
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
