import type {
  Internship,
  QualificationConflictKey,
  QualificationRequirementState,
} from "../domain/schemas.js";
import type {
  CurrentYearOfStudy,
  DegreeLevel,
  InternshipPreferences,
  PreferenceCountry,
  SponsorshipPreference,
  TermSeason,
  WorkAuthorizationPreference,
} from "../preferences/schema.js";
import {
  ELIGIBILITY_ENGINE_VERSION,
  type EligibilityCriteria,
  type EligibilityCriterionKey,
  type EligibilityCriterionResult,
  type EligibilityCriterionState,
  type EligibilityEvidence,
  type EligibilityEvaluation,
  type EligibilityStatus,
  type EligibilityUnknownSource,
} from "./types.js";

const SEASON_PATTERN = /\b(winter|spring|summer|fall|autumn)\b/i;
const YEAR_PATTERN = /\b(20\d{2})\b/;
const SUPPORTED_COUNTRIES = new Set<PreferenceCountry>(["canada", "united_states"]);

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizedSeason(value: string | null | undefined): TermSeason | null {
  const match = SEASON_PATTERN.exec(value ?? "");
  if (!match?.[1]) return null;
  const season = match[1].toLocaleLowerCase() === "autumn" ? "fall" : match[1].toLocaleLowerCase();
  return season as TermSeason;
}

function normalizedYear(value: string | null | undefined): number | null {
  const match = YEAR_PATTERN.exec(value ?? "");
  if (!match?.[1]) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

function countryKey(value: string | null | undefined): PreferenceCountry | null {
  const normalized = normalizedText(value ?? "");
  if (normalized === "canada" || normalized === "canadian") return "canada";
  if (["united states", "united states of america", "usa", "us", "u s"].includes(normalized)) return "united_states";
  return null;
}

function locationCountry(
  country: string | null,
  remoteScope: "canada" | "usa" | "north-america" | "worldwide" | "unspecified" | null,
): PreferenceCountry | null {
  if (remoteScope === "canada") return "canada";
  if (remoteScope === "usa") return "united_states";
  return countryKey(country);
}

function selectedCountries(preferences: InternshipPreferences): Set<PreferenceCountry> {
  return new Set([
    ...preferences.countries,
    ...preferences.cities.map(({ country }) => country),
  ]);
}

function profileValue(
  field: string,
  value: string | number | boolean | null | undefined,
): EligibilityEvidence[] {
  return value === undefined ? [] : [{ source: "profile", field, value }];
}

function evidence(
  source: EligibilityEvidence["source"],
  field: string,
  value: string | number | boolean | null | undefined,
): EligibilityEvidence[] {
  return value === undefined ? [] : [{ source, field, value }];
}

function concatEvidence(...groups: EligibilityEvidence[][]): EligibilityEvidence[] {
  const seen = new Set<string>();
  const result: EligibilityEvidence[] = [];
  for (const group of groups) {
    for (const item of group) {
      const key = `${item.source}|${item.field}|${String(item.value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function result<K extends EligibilityCriterionKey>(
  key: K,
  state: EligibilityCriterionState,
  reason: string,
  facts: EligibilityEvidence[] = [],
  unknownSource: EligibilityUnknownSource | null = null,
): EligibilityCriterionResult & { key: K } {
  return {
    key,
    state,
    hard: true,
    applicable: state !== "not_applicable",
    reason,
    evidence: facts,
    unknownSource,
  };
}

function eligibilityKeyForConflict(key: QualificationConflictKey): EligibilityCriterionKey {
  switch (key) {
    case "year_of_study":
      return "year_of_study";
    case "student_status":
    case "enrollment":
      return "current_enrollment";
    case "returning_to_school":
      return "returning_to_school";
    case "work_authorization":
      return "work_authorization";
    default:
      // graduation, degree, and sponsorship use the same criterion key.
      return key;
  }
}

function conflictFor(details: Internship["qualificationDetails"], key: QualificationConflictKey): EligibilityCriterionResult | null {
  const conflict = details.conflicts.find((candidate) => candidate.key === key);
  if (!conflict) return null;
  return result(
    eligibilityKeyForConflict(key),
    "conflict",
    "The posting contains conflicting structured eligibility evidence.",
    conflict.evidence.map((value) => ({ source: "posting", field: `qualificationDetails.conflicts.${key}`, value })),
    "conflict",
  );
}

function termCriterion(preferences: InternshipPreferences, role: Internship): EligibilityCriterionResult & { key: "term" } {
  const terms = preferences.terms;
  if (terms.length === 0) {
    return result("term", "unknown", "Your selected internship terms are not available.", [], "profile");
  }
  const termSeason = normalizedSeason(role.internshipTerm);
  const titleSeason = normalizedSeason(role.title);
  const explicitYear = normalizedYear(role.internshipYear);
  const termYear = normalizedYear(role.internshipTerm);
  const titleYear = normalizedYear(role.title);
  const season = termSeason ?? titleSeason;
  const year = explicitYear ?? termYear ?? titleYear;
  const postingFacts = concatEvidence(
    evidence("posting", "internshipTerm", role.internshipTerm),
    evidence("posting", "internshipYear", role.internshipYear),
    season === null && role.internshipTerm === null ? evidence("posting", "title", role.title) : [],
  );
  const yearSignals = new Set([explicitYear, termYear, titleYear].filter((value): value is number => value !== null));
  if ((termSeason !== null && titleSeason !== null && termSeason !== titleSeason) || yearSignals.size > 1) {
    return result("term", "conflict", "The posting contains conflicting internship term evidence.", concatEvidence(
      postingFacts,
      evidence("posting", "title", role.title),
    ), "conflict");
  }
  if (season === null && year === null) {
    return result("term", "unknown", "The posting does not state a complete internship term.", postingFacts, "posting");
  }
  const exactMatch = season !== null && year !== null
    ? terms.some((term) => term.term === season && term.year === year)
    : null;
  const seasonMatches = season === null || terms.some((term) => term.term === season);
  const yearMatches = year === null || terms.some((term) => term.year === year);
  if (exactMatch === false || !seasonMatches || !yearMatches) {
    const label = [season, year].filter((value) => value !== null).join(" ");
    return result("term", "fail", `The posting's ${label} term is outside your selected terms.`, concatEvidence(
      postingFacts,
      evidence("profile", "terms", terms.map(({ term, year: selectedYear }) => `${term} ${selectedYear}`).join(", ")),
    ));
  }
  if (season === null || year === null) {
    return result("term", "unknown", "The posting states only part of an internship term.", postingFacts, "posting");
  }
  return result("term", "pass", "The posting's internship term matches a selected term.", concatEvidence(
    postingFacts,
    evidence("profile", "terms", terms.map(({ term: selectedTerm, year: selectedYear }) => `${selectedTerm} ${selectedYear}`).join(", ")),
  ));
}

function countryLocationCriterion(
  preferences: InternshipPreferences,
  role: Internship,
): EligibilityCriterionResult & { key: "country_location" } {
  const countries = selectedCountries(preferences);
  const locations = role.normalizedLocations;
  const hasLocationFacts = locations.some(({ city, country, remote }) => Boolean(city || country || remote));
  if (countries.size === 0 && !preferences.remote) {
    return result("country_location", "unknown", "Your supported work locations are not available.", [], "profile");
  }
  if (!hasLocationFacts) {
    return result("country_location", "unknown", "The posting does not provide a reliable country or remote location.", [], "posting");
  }

  let unknownScope = false;
  let unsupportedCountry = false;
  let knownMismatch = false;
  const roleFacts: EligibilityEvidence[] = [];
  for (const location of locations) {
    const mapped = locationCountry(location.country, location.remoteScope);
    roleFacts.push(...evidence("posting", "normalizedLocations", location.raw));
    if (!location.remote) {
      if (mapped === null) {
        unsupportedCountry = true;
      } else if (countries.has(mapped)) {
        return result("country_location", "pass", "At least one posting location is in a selected supported country.", concatEvidence(
          roleFacts,
          evidence("profile", "countries", [...countries].join(", ")),
        ));
      } else {
        knownMismatch = true;
      }
      continue;
    }

    // A remote label without a country scope cannot establish legal/work fit.
    if (location.remoteScope === null || location.remoteScope === "unspecified" || location.remoteScope === "worldwide") {
      unknownScope = true;
    } else if (location.remoteScope === "north-america") {
      if ([...countries].some((country) => SUPPORTED_COUNTRIES.has(country))) {
        return result("country_location", "pass", "The remote scope includes a selected supported country.", concatEvidence(
          roleFacts,
          evidence("profile", "countries", [...countries].join(", ")),
        ));
      }
      if (preferences.remote && countries.size === 0) {
        return result("country_location", "pass", "The posting is explicitly remote within the supported North-American scope.", concatEvidence(
          roleFacts,
          evidence("profile", "remote", preferences.remote),
        ));
      }
      unknownScope = true;
    } else if (mapped !== null && countries.has(mapped)) {
      return result("country_location", "pass", "The remote scope matches a selected supported country.", concatEvidence(
        roleFacts,
        evidence("profile", "countries", [...countries].join(", ")),
      ));
    } else if (preferences.remote && countries.size === 0 && mapped !== null) {
      // Remote-only onboarding intentionally does not ask for a country.
      // Keep the location modality compatible and let authorization and
      // sponsorship remain profile-unknown until a legal country is known.
      return result("country_location", "pass", "The posting is explicitly remote in a supported country.", concatEvidence(
        roleFacts,
        evidence("profile", "remote", preferences.remote),
      ));
    } else {
      knownMismatch = true;
    }
  }
  if (unknownScope) {
    return result("country_location", "unknown", "The posting does not state the country scope for its remote work.", roleFacts, "posting");
  }
  // Foreign countries are outside the crawler's supported work-country scope;
  // keep them unknown instead of asserting a hard failure from an unsupported
  // geography that should not have entered the product's feed.
  if (unsupportedCountry && !knownMismatch) {
    return result("country_location", "unknown", "The posting location country is outside the supported work-country scope.", roleFacts, "posting");
  }
  if (knownMismatch) {
    return result("country_location", "fail", "The posting's known location is outside your selected supported locations.", concatEvidence(
      roleFacts,
      evidence("profile", "countries", [...countries].join(", ")),
    ));
  }
  return result("country_location", "unknown", "The posting location cannot be mapped to a supported country.", roleFacts, "posting");
}

function roleCountries(role: Internship, preferences?: InternshipPreferences): Set<PreferenceCountry> {
  const countries = new Set<PreferenceCountry>();
  const selected = preferences ? selectedCountries(preferences) : new Set<PreferenceCountry>();
  for (const { country, remoteScope } of role.normalizedLocations) {
    if (remoteScope === "north-america") {
      // A candidate who selected one country has a concrete legal lane for a
      // broad North-America remote posting. With no country answer, retain
      // both supported possibilities so authorization remains unresolved.
      if (selected.size > 0) {
        for (const value of selected) countries.add(value);
      } else {
        countries.add("canada");
        countries.add("united_states");
      }
      continue;
    }
    const mapped = locationCountry(country, remoteScope);
    if (mapped !== null) countries.add(mapped);
  }
  return countries;
}

function regionalValues<T>(
  countries: Set<PreferenceCountry>,
  values: { canada: T | null; unitedStates: T | null },
): Array<T | null> {
  return [...countries].map((country) => country === "canada" ? values.canada : values.unitedStates);
}

function workAuthorizationCriterion(
  preferences: InternshipPreferences,
  role: Internship,
): EligibilityCriterionResult & { key: "work_authorization" } {
  const conflict = conflictFor(role.qualificationDetails, "work_authorization");
  if (conflict?.key === "work_authorization") return { ...conflict, key: "work_authorization" };
  const state = role.qualificationDetails.workAuthorization;
  const postingFacts = concatEvidence(
    evidence("posting", "qualificationDetails.workAuthorization", state),
    evidence("posting", "workAuthorizationRequirements", role.workAuthorizationRequirements.join(" ")),
  );
  if (state === "not_required") {
    return result("work_authorization", "not_applicable", "The posting explicitly does not require existing work authorization.", postingFacts);
  }
  const countries = roleCountries(role, preferences);
  if (state === "unknown") {
    const profileCountries = countries.size > 0 ? countries : selectedCountries(preferences);
    const values = regionalValues<WorkAuthorizationPreference>(profileCountries, preferences.workAuthorization);
    const profileUnknown = values.length === 0 || values.some((value) => value === null || value === "unsure");
    return result(
      "work_authorization",
      "unknown",
      "The posting does not clearly state work authorization requirements.",
      concatEvidence(postingFacts, evidence("profile", "workAuthorization", values.map((value) => value ?? "unsure").join(", "))),
      profileUnknown ? "both" : "posting",
    );
  }
  if (countries.size === 0) {
    return result("work_authorization", "unknown", "The posting requires authorization but its work country is not reliably mapped.", postingFacts, "posting");
  }
  const values = regionalValues<WorkAuthorizationPreference>(countries, preferences.workAuthorization);
  const profileFacts = evidence("profile", "workAuthorization", values.map((value) => value ?? "unsure").join(", "));
  if (values.some((value) => value === "authorized")) {
    return result("work_authorization", "pass", "Existing work authorization is confirmed for at least one posting location.", concatEvidence(postingFacts, profileFacts));
  }
  if (values.length > 0 && values.every((value) => value === "needs_assistance")) {
    return result("work_authorization", "fail", "The posting requires existing work authorization, but your profile says assistance is needed.", concatEvidence(postingFacts, profileFacts));
  }
  return result("work_authorization", "unknown", "Your work authorization answer is uncertain for the posting location.", concatEvidence(postingFacts, profileFacts), "profile");
}

function sponsorshipCriterion(
  preferences: InternshipPreferences,
  role: Internship,
): EligibilityCriterionResult & { key: "sponsorship" } {
  const conflict = conflictFor(role.qualificationDetails, "sponsorship");
  if (conflict?.key === "sponsorship") return { ...conflict, key: "sponsorship" };
  const state = role.qualificationDetails.sponsorship;
  const postingFacts = concatEvidence(
    evidence("posting", "qualificationDetails.sponsorship", state),
    evidence("posting", "sponsorshipInformation", role.sponsorshipInformation),
  );
  const countries = roleCountries(role, preferences);
  if (countries.size === 0 && state !== "unknown") {
    return result("sponsorship", "unknown", "The posting states sponsorship rules without a reliable work-country mapping.", postingFacts, "posting");
  }
  if (state === "available") {
    return result("sponsorship", "pass", "The posting states that employer sponsorship is available.", postingFacts);
  }
  if (state === "required") {
    const values = regionalValues<SponsorshipPreference>(countries, preferences.sponsorship);
    const profileFacts = evidence("profile", "sponsorship", values.map((value) => value ?? "unsure").join(", "));
    if (values.some((value) => value === "none")) {
      return result("sponsorship", "pass", "Your profile says employer sponsorship is not needed for at least one posting location.", concatEvidence(postingFacts, profileFacts));
    }
    if (values.length > 0 && values.every((value) => value === "now" || value === "future")) {
      return result("sponsorship", "pass", "The posting explicitly allows the sponsorship path your profile says may be needed.", concatEvidence(postingFacts, profileFacts));
    }
    return result("sponsorship", "unknown", "Your sponsorship answer is uncertain for a posting with an explicit sponsorship requirement.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  if (state === "unavailable") {
    const values = regionalValues<SponsorshipPreference>(countries, preferences.sponsorship);
    const profileFacts = evidence("profile", "sponsorship", values.map((value) => value ?? "unsure").join(", "));
    if (values.some((value) => value === "none")) {
      return result("sponsorship", "pass", "The posting does not offer sponsorship, and your profile says it is not needed for at least one posting location.", concatEvidence(postingFacts, profileFacts));
    }
    if (values.length > 0 && values.every((value) => value === "now" || value === "future")) {
      return result("sponsorship", "fail", "The posting says employer sponsorship is unavailable, but your profile says it may be needed.", concatEvidence(postingFacts, profileFacts));
    }
    return result("sponsorship", "unknown", "Your sponsorship answer is uncertain for a posting that does not offer sponsorship.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  const countriesForUnknown = countries.size > 0 ? countries : selectedCountries(preferences);
  const values = regionalValues<SponsorshipPreference>(countriesForUnknown, preferences.sponsorship);
  const profileFacts = evidence("profile", "sponsorship", values.map((value) => value ?? "unsure").join(", "));
  if (values.length > 0 && values.every((value) => value === "none")) {
    return result("sponsorship", "pass", "Your profile says employer sponsorship is not needed.", profileFacts);
  }
  const profileUnknown = values.length === 0 || values.some((value) => value === null || value === "unsure");
  return result("sponsorship", "unknown", "The posting does not clearly state sponsorship availability.", concatEvidence(postingFacts, profileFacts), profileUnknown ? "both" : "posting");
}

function degreeSignals(role: Internship): Set<DegreeLevel> {
  const degreeEvidence = role.qualificationDetails.degreeRequirements.length > 0
    ? role.qualificationDetails.degreeRequirements
    : role.educationRequirements;
  const text = degreeEvidence
    // Preferred/nice-to-have education must not become a hard mismatch. The
    // parser keeps raw qualification evidence, so filter the sentence at the
    // point where it is used as a hard eligibility signal.
    .filter((value) => !/\b(?:preferred|nice to have|nice-to-have|desired|bonus|ideal|plus|asset)\b/i.test(value))
    .join("\n");
  const signals = new Set<DegreeLevel>();
  if (/(?:\bbachelor(?:['’]s|s)?\b|\bundergraduate(?:\s+degree)?\b|\bundergrad\b|\bbsc(?=$|[^A-Za-z])|\bb\.?\s*s\.(?=$|[^A-Za-z])|\bbs(?=$|[^A-Za-z]))/i.test(text)) {
    signals.add("bachelors");
  }
  if (/(?:\bmaster(?:['’]s|s)?\b|\bgraduate(?:-level)?\s+degree\b|\bgraduate\s+student\b|\bmsc(?=$|[^A-Za-z])|\bm\.?\s*s\.(?=$|[^A-Za-z])|\bms(?=$|[^A-Za-z]))/i.test(text)) {
    signals.add("masters");
  }
  if (/\b(?:ph\.?d|doctoral|doctorate)\b/i.test(text)) signals.add("phd");
  if (/\b(?:associate|diploma|certificate)\b/i.test(text)) signals.add("other");
  return signals;
}

function degreeCriterion(preferences: InternshipPreferences, role: Internship): EligibilityCriterionResult & { key: "degree" } {
  const conflict = conflictFor(role.qualificationDetails, "degree");
  if (conflict?.key === "degree") return { ...conflict, key: "degree" };
  const postingFacts = evidence("posting", "qualificationDetails.degreeRequirements", role.qualificationDetails.degreeRequirements.join(" "));
  const requiredDegrees = degreeSignals(role);
  if (requiredDegrees.size === 0) {
    return result("degree", "unknown", "The posting does not state a structured degree-level requirement.", postingFacts, "posting");
  }
  const profileDegree = preferences.degree;
  const profileFacts = profileValue("degree", profileDegree);
  if (profileDegree === null || profileDegree === undefined) {
    return result("degree", "unknown", "Your degree level is not available.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  if (requiredDegrees.has(profileDegree)) {
    return result("degree", "pass", "Your degree level matches a stated posting requirement.", concatEvidence(
      postingFacts,
      profileFacts,
    ));
  }
  return result("degree", "fail", "Your degree level does not match the posting's stated requirement.", concatEvidence(
    postingFacts,
    profileFacts,
  ));
}

function roleGraduationBounds(role: Internship): { min: number; max: number } | null {
  const years = [...new Set(role.qualificationDetails.graduationYears)].sort((left, right) => left - right);
  const range = role.qualificationDetails.graduationYearRange;
  if (years.length === 0 && range === null) return null;
  if (range !== null) return range;
  if (years.length > 0) return { min: years[0]!, max: years[years.length - 1]! };
  return null;
}

function roleAllowsGraduation(role: Internship, year: number): boolean {
  const years = [...new Set(role.qualificationDetails.graduationYears)].sort((left, right) => left - right);
  const range = role.qualificationDetails.graduationYearRange;
  if (range !== null) return year >= range.min && year <= range.max;
  if (years.length > 0) {
    if (years.includes(year)) return true;
    return false;
  }
  return false;
}

function graduationCriterion(preferences: InternshipPreferences, role: Internship): EligibilityCriterionResult & { key: "graduation" } {
  const conflict = conflictFor(role.qualificationDetails, "graduation");
  if (conflict?.key === "graduation") return { ...conflict, key: "graduation" };
  const bounds = roleGraduationBounds(role);
  const postingFacts = concatEvidence(
    evidence("posting", "qualificationDetails.graduationYears", role.qualificationDetails.graduationYears.join(", ")),
    evidence("posting", "qualificationDetails.graduationYearRange", role.qualificationDetails.graduationYearRange
      ? `${role.qualificationDetails.graduationYearRange.min}-${role.qualificationDetails.graduationYearRange.max}` : null),
    evidence("posting", "qualificationDetails.expectedGraduation", role.qualificationDetails.expectedGraduation),
  );
  if (bounds === null) {
    return result("graduation", "unknown", "The posting does not state a structured graduation window.", postingFacts, "posting");
  }
  const year = preferences.graduationYear;
  const profileFacts = concatEvidence(
    profileValue("graduationYear", year),
    evidence("profile", "graduationYearOrLater", preferences.graduationYearOrLater),
  );
  if (year === null || year === undefined) {
    return result("graduation", "unknown", "Your expected graduation year is not available.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  const matches = preferences.graduationYearOrLater
    ? bounds.max >= year
    : roleAllowsGraduation(role, year);
  if (!matches) {
    return result("graduation", "fail", "The posting's graduation window does not include your expected graduation timing.", concatEvidence(postingFacts, profileFacts));
  }
  return result("graduation", "pass", "Your expected graduation timing fits the posting's stated window.", concatEvidence(postingFacts, profileFacts));
}

function upperYear(value: CurrentYearOfStudy | undefined): boolean | null {
  if (value === undefined || value === "unsure" || value === "other") return null;
  return value !== "first-year";
}

function normalizedStudyYear(value: string): string | null {
  const normalized = normalizedText(value);
  const aliases: Record<string, string> = {
    "first year": "first-year",
    "second year": "second-year",
    "third year": "third-year",
    "fourth year": "fourth-year",
    "fifth year": "fifth-year",
    freshman: "first-year",
    freshmen: "first-year",
    sophomore: "second-year",
    sophomores: "second-year",
    junior: "third-year",
    juniors: "third-year",
    senior: "fourth-year",
    seniors: "fourth-year",
    "upper year": "upper-year",
    upperclassman: "upper-year",
    upperclassmen: "upper-year",
  };
  return aliases[normalized] ?? [
    "first-year",
    "second-year",
    "third-year",
    "fourth-year",
    "fifth-year",
    "upper-year",
  ].includes(normalized) ? (aliases[normalized] ?? normalized) : null;
}

function studyYearCriterion(preferences: InternshipPreferences, role: Internship): EligibilityCriterionResult & { key: "year_of_study" } {
  const conflict = conflictFor(role.qualificationDetails, "year_of_study");
  if (conflict?.key === "year_of_study") return { ...conflict, key: "year_of_study" };
  const details = role.qualificationDetails;
  const postingFacts = concatEvidence(
    evidence("posting", "qualificationDetails.yearOfStudy", details.yearOfStudy.join(", ")),
    evidence("posting", "qualificationDetails.firstYearEligible", details.firstYearEligible),
    evidence("posting", "qualificationDetails.upperYearRequired", details.upperYearRequired),
  );
  const specificYears = new Set(details.yearOfStudy
    .map(normalizedStudyYear)
    .filter((value): value is string => value !== null));
  const hardUpperRequirement = details.upperYearRequired === "yes" || details.firstYearEligible === "no";
  // A normalized exact year is itself useful structured evidence when the
  // parser has not emitted a separate upper-year boolean.  A value marked
  // `upperYearRequired: no` is intentionally treated as a preference only.
  const hardSpecificRequirement = specificYears.size > 0
    && details.upperYearRequired !== "no"
    && details.firstYearEligible !== "yes";
  if (!hardUpperRequirement && !hardSpecificRequirement) {
    if (details.firstYearEligible === "yes") {
      return result("year_of_study", "pass", "The posting explicitly accepts first-year students and states no stricter year gate.", postingFacts);
    }
    return result("year_of_study", "unknown", "The posting does not state a structured year-of-study requirement.", postingFacts, "posting");
  }
  const currentYear = preferences.currentYearOfStudy;
  const profileFacts = profileValue("currentYearOfStudy", currentYear ?? "unsure");
  if (currentYear === undefined || currentYear === "unsure" || currentYear === "other") {
    return result("year_of_study", "unknown", "Your current year of study is uncertain for a posting with a year requirement.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  if (hardUpperRequirement && upperYear(currentYear) === false) {
    return result("year_of_study", "fail", "The posting requires an upper-year student, but your profile says first-year.", concatEvidence(postingFacts, profileFacts));
  }
  if (!hardUpperRequirement && specificYears.size > 0
    && !specificYears.has(currentYear)
    && !(specificYears.has("upper-year") && upperYear(currentYear) === true)) {
    return result("year_of_study", "fail", "Your current year of study does not match the posting's stated year requirement.", concatEvidence(postingFacts, profileFacts));
  }
  return result("year_of_study", "pass", "Your current year of study satisfies the posting's upper-year requirement.", concatEvidence(postingFacts, profileFacts));
}

function requirementIsHard(state: QualificationRequirementState): boolean {
  return state === "required" || state === "conflict";
}

function enrollmentCriterion(preferences: InternshipPreferences, role: Internship): EligibilityCriterionResult & { key: "current_enrollment" } {
  const studentConflict = conflictFor(role.qualificationDetails, "student_status");
  if (studentConflict?.key === "current_enrollment") return { ...studentConflict, key: "current_enrollment" };
  const enrollmentConflict = conflictFor(role.qualificationDetails, "enrollment");
  if (enrollmentConflict?.key === "current_enrollment") return { ...enrollmentConflict, key: "current_enrollment" };
  const details = role.qualificationDetails;
  const studentRequirement = details.studentStatusRequirement;
  const enrollmentRequirement = details.enrollmentRequirement;
  const postingFacts = concatEvidence(
    evidence("posting", "qualificationDetails.studentStatusRequirement", studentRequirement),
    evidence("posting", "qualificationDetails.enrollmentRequirement", enrollmentRequirement),
  );
  if (studentRequirement === "conflict" || enrollmentRequirement === "conflict") {
    return result("current_enrollment", "conflict", "The posting contains conflicting student or enrollment requirements.", postingFacts, "conflict");
  }
  if (!requirementIsHard(studentRequirement) && !requirementIsHard(enrollmentRequirement)) {
    if (studentRequirement === "unknown" && enrollmentRequirement === "unknown") {
      return result("current_enrollment", "unknown", "The posting does not clearly state current student or enrollment requirements.", postingFacts, "posting");
    }
    return result("current_enrollment", "not_applicable", "The posting does not make current student status a hard requirement.", postingFacts);
  }
  const currentStatus = preferences.currentEnrollmentStatus;
  const profileFacts = profileValue("currentEnrollmentStatus", currentStatus ?? "unsure");
  if (currentStatus === undefined || currentStatus === "unsure") {
    return result("current_enrollment", "unknown", "Your current enrollment or student status is uncertain for this posting.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  if (currentStatus === "enrolled") {
    return result("current_enrollment", "pass", "Your profile says you are currently enrolled, satisfying the posting's student requirement.", concatEvidence(postingFacts, profileFacts));
  }
  return result("current_enrollment", "fail", "The posting requires a current student or enrollment status, but your profile says you are not currently enrolled.", concatEvidence(postingFacts, profileFacts));
}

function returningToSchoolCriterion(preferences: InternshipPreferences, role: Internship): EligibilityCriterionResult & { key: "returning_to_school" } {
  const conflict = conflictFor(role.qualificationDetails, "returning_to_school");
  if (conflict?.key === "returning_to_school") return { ...conflict, key: "returning_to_school" };
  const requirement = role.qualificationDetails.returningToSchoolRequirement;
  const postingFacts = evidence("posting", "qualificationDetails.returningToSchoolRequirement", requirement);
  if (requirement === "conflict") {
    return result("returning_to_school", "conflict", "The posting contains conflicting returning-to-school requirements.", postingFacts, "conflict");
  }
  if (requirement === "unknown") {
    return result("returning_to_school", "unknown", "The posting does not clearly state a returning-to-school requirement.", postingFacts, "posting");
  }
  if (requirement !== "required") {
    return result("returning_to_school", "not_applicable", "The posting does not make returning to school a hard requirement.", postingFacts);
  }
  const answer = preferences.returningToSchool;
  const profileFacts = profileValue("returningToSchool", answer ?? "unsure");
  if (answer === undefined || answer === "unsure") {
    return result("returning_to_school", "unknown", "Your plans to return to school are uncertain for this posting.", concatEvidence(postingFacts, profileFacts), "profile");
  }
  if (answer === "yes") {
    return result("returning_to_school", "pass", "Your profile says you will return to school after the internship.", concatEvidence(postingFacts, profileFacts));
  }
  return result("returning_to_school", "fail", "The posting requires returning to school after the internship, but your profile says no.", concatEvidence(postingFacts, profileFacts));
}

function aggregateStatus(criteria: EligibilityCriterionResult[]): EligibilityStatus {
  if (criteria.some(({ state }) => state === "fail")) return "not_eligible";
  if (criteria.some(({ state }) => state === "conflict")) return "unclear";
  const unknown = criteria.filter(({ state }) => state === "unknown");
  if (unknown.length === 0) return "eligible";
  if (unknown.some(({ unknownSource }) => unknownSource !== "posting")) return "unclear";
  return "likely_eligible";
}

export function evaluateInternshipEligibility(
  preferences: InternshipPreferences,
  role: Internship,
): EligibilityEvaluation {
  const criteria = [
    termCriterion(preferences, role),
    countryLocationCriterion(preferences, role),
    workAuthorizationCriterion(preferences, role),
    sponsorshipCriterion(preferences, role),
    degreeCriterion(preferences, role),
    graduationCriterion(preferences, role),
    studyYearCriterion(preferences, role),
    enrollmentCriterion(preferences, role),
    returningToSchoolCriterion(preferences, role),
  ] as const;
  const byKey = Object.fromEntries(criteria.map((criterion) => [criterion.key, criterion])) as EligibilityCriteria;
  return {
    version: ELIGIBILITY_ENGINE_VERSION,
    status: aggregateStatus([...criteria]),
    criteria: byKey,
    criterionResults: [...criteria],
  };
}

/** Short alias for callers that do not need the longer function name. */
export const evaluateEligibility = evaluateInternshipEligibility;
