import type { Internship } from "../domain/schemas.js";
import { evaluateInternshipEligibility, type EligibilityEvaluation } from "../eligibility/index.js";
import type {
  DegreeLevel,
  InternshipPreferences,
  PreferenceCountry,
  SponsorshipPreference,
  WorkAuthorizationPreference,
} from "./schema.js";

export interface MatchEvaluation {
  /** Legacy matcher fields remain stable for ranking/filter consumers. */
  eligible: boolean;
  score: number;
  reasons: string[];
  incompatibilities: string[];
  unknown: string[];
  /** Pure, versioned criterion-level eligibility result. */
  eligibility: EligibilityEvaluation;
}

export interface RankedInternship {
  internship: Internship;
  match: MatchEvaluation;
}

const SEASON_PATTERN = /\b(winter|spring|summer|fall|autumn)\b/i;
const YEAR_PATTERN = /\b(20\d{2})\b/;

function normalizedSeason(value: string | null): string | null {
  const match = SEASON_PATTERN.exec(value ?? "");
  if (!match?.[1]) return null;
  return match[1].toLocaleLowerCase() === "autumn" ? "fall" : match[1].toLocaleLowerCase();
}

function normalizedYear(value: string | null): number | null {
  const match = YEAR_PATTERN.exec(value ?? "");
  if (!match?.[1]) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function countryKey(value: string | null): PreferenceCountry | null {
  const normalized = normalizedText(value ?? "");
  if (normalized === "canada" || normalized === "canadian") return "canada";
  if (["united states", "united states of america", "usa", "us", "u s"].includes(normalized)) return "united_states";
  return null;
}

function roleCountries(role: Internship): Set<PreferenceCountry> {
  return new Set(role.normalizedLocations.map(({ country, remoteScope }) => {
    if (remoteScope === "canada") return "canada";
    if (remoteScope === "usa") return "united_states";
    return countryKey(country);
  }).filter((value): value is PreferenceCountry => value !== null));
}

function termEvaluation(preferences: InternshipPreferences, role: Internship, incompatibilities: string[], unknown: string[]): number {
  const season = normalizedSeason(role.internshipTerm) ?? normalizedSeason(role.title);
  const year = normalizedYear(role.internshipYear) ?? normalizedYear(role.title);
  if (season === null && year === null) {
    unknown.push("The posting does not name a specific internship term.");
    return 0;
  }
  if (season === null || year === null) {
    unknown.push("The posting does not name a complete internship term.");
  }
  const exact = preferences.terms.some((term) => term.term === season && term.year === year);
  if (season !== null && year !== null && !exact) {
    incompatibilities.push(`The posting is for ${season} ${year}, outside your selected terms.`);
    return 0;
  }
  if (season !== null && !preferences.terms.some((term) => term.term === season)) {
    incompatibilities.push(`The posting’s ${season} term is outside your selected terms.`);
    return 0;
  }
  if (year !== null && !preferences.terms.some((term) => term.year === year)) {
    incompatibilities.push(`The posting’s ${year} term is outside your selected years.`);
    return 0;
  }
  return exact ? 30 : 14;
}

function remoteScopeCompatible(role: Internship, preferences: InternshipPreferences): boolean {
  const scopes = new Set(role.normalizedLocations.filter(({ remote }) => remote).map(({ remoteScope }) => remoteScope));
  if (scopes.size === 0 || scopes.has(null) || scopes.has("unspecified") || scopes.has("worldwide")) return true;
  const selectedCountries = new Set([
    ...preferences.countries,
    ...preferences.cities.map(({ country }) => country),
  ]);
  if (selectedCountries.size === 0) return true;
  if (scopes.has("north-america")) return true;
  return (scopes.has("canada") && selectedCountries.has("canada"))
    || (scopes.has("usa") && selectedCountries.has("united_states"));
}

function locationEvaluation(preferences: InternshipPreferences, role: Internship, incompatibilities: string[], unknown: string[], reasons: string[]): number {
  const locations = role.normalizedLocations;
  const hasReliableLocation = locations.some(({ city, country, remote }) => Boolean(city || country || remote));
  if (!hasReliableLocation) {
    unknown.push("The posting’s location metadata is incomplete.");
    return 0;
  }
  let best = 0;
  const selectedCountries = new Set([
    ...preferences.countries,
    ...preferences.cities.map(({ country }) => country),
  ]);
  const preferredCities = new Set(preferences.cities.map(({ name, country }) => `${country}:${normalizedText(name)}`));
  const hasUnknownLocation = locations.some((location) => {
    if (location.remote) return false;
    const mappedCountry = countryKey(location.country)
      ?? (location.remoteScope === "canada" ? "canada" : location.remoteScope === "usa" ? "united_states" : null);
    return mappedCountry === null;
  });
  for (const location of locations) {
    const country = countryKey(location.country)
      ?? (location.remoteScope === "canada" ? "canada" : location.remoteScope === "usa" ? "united_states" : null);
    if (location.city && country && preferredCities.has(`${country}:${normalizedText(location.city)}`)) {
      best = Math.max(best, 30);
    }
    if (country && selectedCountries.has(country)) best = Math.max(best, 20);
    if (preferences.remote && (location.remote || role.remoteStatus === "remote") && remoteScopeCompatible(role, preferences)) {
      best = Math.max(best, 24);
    }
    // A remote posting with a broad/unknown scope is still a plausible fit for
    // a selected country.  Remote is a soft preference (and can be combined
    // with country/city choices), so do not discard a worldwide remote role
    // merely because the source did not repeat the candidate's country.
    if (location.remote && country === null && selectedCountries.size > 0) {
      best = Math.max(best, 16);
    }
  }
  if (best === 0 && preferences.remote && role.remoteStatus === "remote" && remoteScopeCompatible(role, preferences)) best = 24;
  if (best === 0) {
    if (hasUnknownLocation) {
      unknown.push("The posting’s location metadata cannot be mapped to a supported country.");
      return 0;
    }
    incompatibilities.push("The posting’s known location is outside your selected locations.");
    return 0;
  }
  reasons.push(best >= 30 ? "Preferred city" : best >= 24 ? "Remote option" : "Preferred country");
  return best;
}

function degreeSignals(role: Internship): Set<DegreeLevel> {
  const degreeEvidence = role.qualificationDetails.degreeRequirements.length > 0
    ? role.qualificationDetails.degreeRequirements
    : role.educationRequirements;
  const text = degreeEvidence
    .filter((value) => !/\b(?:preferred|nice to have|nice-to-have|desired|bonus|ideal|plus|asset)\b/i.test(value))
    .join("\n");
  const signals = new Set<DegreeLevel>();
  // A trailing `\b` cannot match after the final period in `B.S.`/`M.S.`;
  // use a letter-safe lookahead so punctuation-delimited degree tokens are
  // recognized without matching the middle of another word.
  if (/(?:\bbachelor(?:['’]s|s)?\b|\bundergraduate(?:\s+degree)?\b|\bbsc(?=$|[^A-Za-z])|\bb\.?\s*s\.(?=$|[^A-Za-z])|\bbs(?=$|[^A-Za-z]))/i.test(text)) {
    signals.add("bachelors");
  }
  if (/(?:\bmaster(?:['’]s|s)?\b|\bgraduate(?:-level)?\s+degree\b|\bgraduate\s+student\b|\bmsc(?=$|[^A-Za-z])|\bm\.?\s*s\.(?=$|[^A-Za-z])|\bms(?=$|[^A-Za-z]))/i.test(text)) {
    signals.add("masters");
  }
  if (/\b(?:ph\.?d|doctoral|doctorate)\b/i.test(text)) signals.add("phd");
  return signals;
}

function eligibilityEvaluation(preferences: InternshipPreferences, role: Internship, incompatibilities: string[], unknown: string[]): number {
  let score = 0;
  const requiredDegrees = degreeSignals(role);
  if (requiredDegrees.size > 0 && preferences.degree !== null) {
    if (!requiredDegrees.has(preferences.degree)) incompatibilities.push("The posting names a different degree level as an eligibility requirement.");
    else score += 5;
  } else {
    unknown.push("The posting does not provide structured degree eligibility.");
  }

  const graduationYears = role.qualificationDetails.graduationYears;
  const graduationRange = role.qualificationDetails.graduationYearRange;
  if (preferences.graduationYear !== null && (graduationYears.length > 0 || graduationRange !== null)) {
    const lowerBound = preferences.graduationYear;
    const exactAllowed = graduationYears.includes(lowerBound);
    const rangeAllowed = graduationRange !== null
      && lowerBound >= graduationRange.min
      && lowerBound <= graduationRange.max;
    const latestAllowed = Math.max(...graduationYears, graduationRange?.max ?? Number.NEGATIVE_INFINITY);
    const earliestAllowed = Math.min(...graduationYears, graduationRange?.min ?? Number.POSITIVE_INFINITY);
    // The listing's extracted years are explicit eligibility facts.  A
    // candidate who selected "year+" can satisfy an open-ended listing only
    // when the listing's known lower bound is not after their graduation;
    // otherwise an explicit finite range/year list remains incompatible.
    const laterAllowed = preferences.graduationYearOrLater
      && earliestAllowed <= lowerBound
      && latestAllowed >= lowerBound;
    if (!exactAllowed && !rangeAllowed && !laterAllowed) {
      incompatibilities.push("The posting’s stated graduation window does not include your graduation year.");
    } else {
      score += 5;
    }
  } else {
    unknown.push("The posting does not provide a structured graduation window.");
  }
  return score;
}

function regionalValues<T>(
  countries: Set<PreferenceCountry>,
  values: { canada: T | null; unitedStates: T | null },
): Array<T | null> {
  return [...countries].map((country) => country === "canada" ? values.canada : values.unitedStates);
}

function authorizationEvaluation(preferences: InternshipPreferences, role: Internship, incompatibilities: string[], unknown: string[]): number {
  const countries = roleCountries(role);
  const workAuthorization = role.qualificationDetails.workAuthorization;
  const sponsorship = role.qualificationDetails.sponsorship;
  let score = 0;
  if (countries.size === 0) {
    if (workAuthorization !== "unknown" || sponsorship !== "unknown") {
      unknown.push("The posting states authorization rules without a reliable country mapping.");
    }
    return score;
  }

  if (workAuthorization === "required") {
    const values = regionalValues<WorkAuthorizationPreference>(countries, preferences.workAuthorization);
    if (values.some((value) => value === "authorized")) score += 5;
    else if (values.length > 0 && values.every((value) => value === "needs_assistance")) {
      incompatibilities.push("The posting requires existing work authorization in its location.");
    } else {
      unknown.push("Your work authorization answer is uncertain for this posting.");
    }
  } else if (workAuthorization === "unknown") {
    unknown.push("The posting does not clearly state work authorization requirements.");
  }

  if (sponsorship === "unavailable") {
    const values = regionalValues<SponsorshipPreference>(countries, preferences.sponsorship);
    if (values.length > 0 && values.every((value) => value === "now" || value === "future")) {
      incompatibilities.push("The posting says employer sponsorship is unavailable.");
    } else if (values.some((value) => value === "unsure" || value === null)) {
      unknown.push("Sponsorship fit is uncertain for this posting.");
    } else {
      score += 5;
    }
  } else if (sponsorship === "unknown") {
    unknown.push("The posting does not clearly state sponsorship availability.");
  }
  return score;
}

function softPreferenceScore(preferences: InternshipPreferences, role: Internship, reasons: string[]): number {
  const selectedCategories = new Set(preferences.roleCategories);
  const categoryOverlap = role.categories.filter((category) => selectedCategories.has(category));
  const broadSoftwareOverlap = categoryOverlap.length === 0
    && selectedCategories.has("swe")
    && role.categories.some((category) => ["frontend", "backend", "fullstack", "mobile", "qa", "devops", "cloud"].includes(category));
  const categoryScore = Math.min(36, categoryOverlap.length * 12 + (broadSoftwareOverlap ? 6 : 0));
  if (categoryOverlap.length > 0) reasons.push(`${categoryOverlap.length} preferred role ${categoryOverlap.length === 1 ? "category" : "categories"}`);
  else if (broadSoftwareOverlap) reasons.push("Software engineering overlap");

  const selectedTechnologies = new Set(preferences.technologies.map((value) => normalizedText(value)));
  const technologyOverlap = role.technologies.filter((technology) => selectedTechnologies.has(normalizedText(technology)));
  const technologyScore = Math.min(25, technologyOverlap.length * 5);
  if (technologyOverlap.length > 0) reasons.push(`${technologyOverlap.slice(0, 3).join(", ")} overlap`);

  const qualityScore = Math.round(Math.max(0, Math.min(100, role.relevanceScore)) / 10);
  const freshnessScore = role.lifecycleStatus === "NEW" ? 4 : role.lifecycleStatus === "UPDATED" ? 2 : 0;
  return categoryScore + technologyScore + qualityScore + freshnessScore;
}

export function evaluateInternshipMatch(preferences: InternshipPreferences, role: Internship): MatchEvaluation {
  const reasons: string[] = [];
  // These legacy components still contribute a conservative ranking signal,
  // but their hard arrays are deliberately not used as an authority. The
  // versioned eligibility engine below is the sole source for hard status,
  // failure reasons, and unknown metadata.
  const legacyIncompatibilities: string[] = [];
  const legacyUnknown: string[] = [];
  const hardScore = termEvaluation(preferences, role, legacyIncompatibilities, legacyUnknown)
    + locationEvaluation(preferences, role, legacyIncompatibilities, legacyUnknown, reasons)
    + eligibilityEvaluation(preferences, role, legacyIncompatibilities, legacyUnknown)
    + authorizationEvaluation(preferences, role, legacyIncompatibilities, legacyUnknown);
  const softScore = softPreferenceScore(preferences, role, reasons);
  const eligibility = evaluateInternshipEligibility(preferences, role);
  const incompatibilities = eligibility.criterionResults
    .filter(({ state }) => state === "fail")
    .map(({ reason }) => reason);
  const unknown = eligibility.criterionResults
    .filter(({ state }) => state === "unknown" || state === "conflict")
    .map(({ reason }) => reason);
  const criterionReasons = eligibility.criterionResults
    .filter(({ state }) => state === "pass" || state === "not_applicable")
    .map(({ reason }) => reason);
  const eligible = eligibility.status !== "not_eligible";
  const score = eligible ? Math.min(100, hardScore + softScore) : 0;
  const matchReasons = [...reasons, ...criterionReasons].slice(0, 5);
  return {
    eligible,
    score,
    reasons: matchReasons.length > 0
      ? matchReasons
      : (eligible ? ["Eligible based on the metadata available"] : []),
    incompatibilities,
    unknown,
    eligibility,
  };
}

export function rankInternships(preferences: InternshipPreferences, internships: readonly Internship[]): RankedInternship[] {
  return internships
    .map((internship) => ({ internship, match: evaluateInternshipMatch(preferences, internship) }))
    .filter(({ match }) => match.eligible)
    .toSorted((left, right) => right.match.score - left.match.score
      || right.internship.relevanceScore - left.internship.relevanceScore
      || left.internship.company.localeCompare(right.internship.company)
      || left.internship.title.localeCompare(right.internship.title)
      || left.internship.id.localeCompare(right.internship.id));
}
