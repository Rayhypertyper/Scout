import type { AnalyzedJob } from "../domain/types.js";
import type { Internship } from "../domain/schemas.js";
import { internshipContentHash } from "../classification/analyzeJob.js";
import { normalizeCompanyIdentity, normalizeIdentity, normalizeRoleIdentity, uniqueStrings } from "../utils/text.js";
import { canonicalizeUrl, extractJobId, isAggregatorUrl, isAtsUrl, isCompanyLandingUrl, normalizedJobUrl, organizationTokenFromUrl } from "../utils/url.js";
import { parseLocation } from "../parsing/locations.js";

/**
 * Minimal listing data available immediately after parsing a source listing.
 * It deliberately contains no detail-page-only fields, so callers can use the
 * identity helpers before deciding whether to fetch a full posting.
 */
export interface ListingIdentityInput {
  postingUrl?: string | null;
  applicationUrl?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  provider?: string | null;
  sourceProvider?: string | null;
  ats?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | string[] | null;
  locations?: string[] | null;
  department?: string | null;
  team?: string | null;
  /** Provider/ATS ID extracted from a structured listing, when available. */
  externalJobId?: string | null;
  externalId?: string | null;
  jobId?: string | null;
}

export type ListingIdentityKind = "canonical-url" | "provider-job" | "role-location";

export interface ListingIdentity {
  key: string;
  kind: ListingIdentityKind;
  provider: string | null;
  company: string;
  title: string;
  locations: string[];
  externalJobIds: string[];
}

function cleanProvider(value: string | null | undefined): string {
  return normalizeIdentity(value ?? "").replace(/\s+/g, "-");
}

function providerFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "").toLocaleLowerCase();
    if (/greenhouse\.io$/.test(host)) return "greenhouse";
    if (/lever\.co$/.test(host)) return "lever";
    if (/myworkdayjobs\.com$/.test(host)) return "workday";
    if (/ashbyhq\.com$/.test(host)) return "ashby";
    if (/smartrecruiters\.com$/.test(host)) return "smartrecruiters";
    if (/jobvite\.com$/.test(host)) return "jobvite";
    if (/icims\.com$/.test(host)) return "icims";
    if (/taleo\.net$/.test(host)) return "taleo";
    if (/eightfold\.ai$/.test(host)) return "eightfold";
    if (/github\.com$/.test(host) || /raw\.githubusercontent\.com$/.test(host)) return "github";
    return host;
  } catch {
    return "";
  }
}

function listingUrls(input: ListingIdentityInput): string[] {
  return uniqueStrings([
    input.canonicalUrl ?? "",
    input.url ?? "",
    input.postingUrl ?? "",
    input.applicationUrl ?? "",
  ].filter(Boolean).flatMap((value) => {
    try {
      return [canonicalizeUrl(value), normalizedJobUrl(value)];
    } catch {
      return [];
    }
  }));
}

function listingLocations(input: ListingIdentityInput): string[] {
  const rawValues = uniqueStrings([
    ...(input.locations ?? []),
    ...(Array.isArray(input.location) ? input.location : [input.location ?? ""]),
  ].flatMap((value) => value.split(/\s*(?:\||;|\n| • )\s*/))
    .map((value) => value.trim())
    .filter(Boolean));
  const aliases = rawValues.flatMap((raw) => {
    const normalized = normalizeIdentity(raw);
    const parsed = parseLocation(raw);
    const structured = [parsed.country, parsed.provinceState, parsed.city]
      .filter(Boolean)
      .map((value) => normalizeIdentity(value ?? ""));
    const country = normalizeIdentity(parsed.country ?? "");
    const city = normalizeIdentity(parsed.city ?? "");
    const state = normalizeIdentity(parsed.provinceState ?? "");
    return [
      normalized,
      ...(structured.length > 0 ? [structured.join("|")] : []),
      ...(country && city ? [`${country}|${city}`, `${country}|${state}|${city}`] : []),
      ...(!country && city ? [`unknown|${city}`] : []),
    ];
  });
  return uniqueStrings(aliases).filter(Boolean);
}

function listingProvider(input: ListingIdentityInput, urls: string[]): string | null {
  const explicit = cleanProvider(input.provider ?? input.sourceProvider ?? input.ats);
  if (explicit) return explicit;
  const inferred = urls.map(providerFromUrl).find(Boolean);
  return inferred || null;
}

function listingCompany(input: ListingIdentityInput): string {
  return normalizeCompanyIdentity(input.company ?? "");
}

function listingTitle(input: ListingIdentityInput): string {
  return normalizeRoleIdentity(input.title ?? "");
}

function listingExternalIds(input: ListingIdentityInput, urls: string[]): string[] {
  const explicit = [input.externalJobId, input.externalId, input.jobId]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeIdentity(value));
  const extracted = urls
    .map((url) => extractJobId(url))
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeIdentity(value));
  return uniqueStrings([...explicit, ...extracted]).filter(Boolean);
}

function listingDescriptor(input: ListingIdentityInput): Omit<ListingIdentity, "key" | "kind"> {
  const urls = listingUrls(input);
  return {
    provider: listingProvider(input, urls),
    company: listingCompany(input),
    title: listingTitle(input),
    locations: listingLocations(input),
    externalJobIds: listingExternalIds(input, urls),
  };
}

/**
 * Return stable, cheap identity aliases for a listing. Canonical URL aliases
 * include the posting/application form relationship; provider IDs are scoped
 * by provider and company; role-location is only a fallback when no URL/ID is
 * available. Consumers should use `listingIdentityMatches` for pair matching
 * when distinct direct requisitions must be protected.
 */
export function listingIdentityKeys(input: ListingIdentityInput): ListingIdentity[] {
  const urls = listingUrls(input);
  const descriptor = listingDescriptor(input);
  const identities: ListingIdentity[] = [];
  for (const url of urls) identities.push({ key: `url:${url}`, kind: "canonical-url", ...descriptor });
  if (descriptor.provider && descriptor.company && descriptor.externalJobIds.length > 0) {
    for (const id of descriptor.externalJobIds) {
      identities.push({
        key: `provider-job:${descriptor.provider}|${descriptor.company}|${id}`,
        kind: "provider-job",
        ...descriptor,
      });
    }
  }
  // Require a location for role fallback. A missing location is not evidence
  // that two otherwise-identical requisitions are the same posting.
  if (descriptor.company && descriptor.title && descriptor.locations.length > 0) {
    identities.push({
      key: `role-location:${descriptor.company}|${descriptor.title}|${descriptor.locations.toSorted().join(";")}`,
      kind: "role-location",
      ...descriptor,
    });
  }
  return identities;
}

export function listingIdentityKey(input: ListingIdentityInput): string | null {
  return listingIdentityKeys(input)[0]?.key ?? null;
}

function listingIdentityInputFromInternship(job: Internship): ListingIdentityInput {
  return {
    postingUrl: job.postingUrl,
    applicationUrl: job.applicationUrl,
    provider: job.sources[0] ? providerFromUrl(job.sources[0]) : null,
    company: job.company,
    title: job.title,
    locations: [
      ...job.location,
      ...job.normalizedLocations.map((location) => [location.city, location.provinceState, location.country].filter(Boolean).join(", ")),
    ],
    jobId: job.jobId,
  };
}

function sameLocation(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return left.some((value) => right.includes(value));
}

/** Pair-safe matching for pre-detail and post-detail deduplication. */
export function listingIdentityMatches(left: ListingIdentityInput, right: ListingIdentityInput): boolean {
  const leftKeys = listingIdentityKeys(left);
  const rightKeys = listingIdentityKeys(right);
  const rightUrls = new Set(rightKeys
    .filter(({ kind, key }) => kind === "canonical-url"
      && !isCompanyLandingUrl(key.slice("url:".length)))
    .map(({ key }) => key));
  if (leftKeys.some(({ kind, key }) => kind === "canonical-url"
    && !isCompanyLandingUrl(key.slice("url:".length))
    && rightUrls.has(key))) return true;

  const a = listingDescriptor(left);
  const b = listingDescriptor(right);
  const aIds = new Set(a.externalJobIds);
  const bIds = new Set(b.externalJobIds);
  const sharedIds = [...aIds].filter((id) => bIds.has(id));
  const sameProvider = Boolean(a.provider && b.provider && a.provider === b.provider);
  const sameCompany = Boolean(a.company && b.company && a.company === b.company);
  if (sharedIds.length > 0 && sameProvider && sameCompany) return true;
  // A source-specific company URL and its ATS copy can expose the same
  // numeric requisition under different provider hosts. Require the complete
  // role/location descriptor as an additional guard before accepting that
  // cross-provider alias.
  if (
    sharedIds.length > 0
    && sameCompany
    && a.title
    && a.title === b.title
    && sameLocation(a.locations, b.locations)
  ) return true;

  // Two direct records with different requisition IDs are never merged by a
  // title/location fallback. This is the key guard against collapsing Workday
  // requisitions that happen to share a title and city.
  if (aIds.size > 0 && bIds.size > 0) return false;
  if (!sameCompany || !a.title || !b.title || a.title !== b.title) return false;
  return sameLocation(a.locations, b.locations);
}

/** Deduplicate lightweight candidates before detail retrieval. */
export function deduplicateListings<T extends ListingIdentityInput>(listings: T[]): T[] {
  const records: T[] = [];
  for (const candidate of listings) {
    if (records.some((existing) => listingIdentityMatches(existing, candidate))) continue;
    records.push(candidate);
  }
  return records;
}

export const dedupeListings = deduplicateListings;
export const buildListingIdentities = listingIdentityKeys;
export const canonicalListingIdentity = listingIdentityKey;
export const listingIdentitiesMatch = listingIdentityMatches;
export const deduplicateListingCandidates = deduplicateListings;

function locationIdentity(job: Internship): string {
  const normalized = job.normalizedLocations.map((location) => [
    location.country,
    location.provinceState,
    location.city,
    location.remote ? location.remoteScope ?? "remote" : "onsite",
  ].map((value) => normalizeIdentity(value ?? "")).join("|")).filter(Boolean).sort();
  return normalized.length > 0
    ? normalized.join(";")
    : job.location.map(normalizeIdentity).sort().join("|");
}

function primaryLocationKeys(job: Internship): string[] {
  return uniqueStrings(job.normalizedLocations
    .filter(({ country, provinceState, city }) => Boolean(country || provinceState || city))
    .map(({ country, provinceState, city }) => [country, provinceState, city]
      .map((value) => normalizeIdentity(value ?? ""))
      .join("|")));
}

function hasAggregatorSurface(job: Internship): boolean {
  return isAggregatorUrl(job.applicationUrl) || isAggregatorUrl(job.postingUrl);
}

function mergeQualificationDetails(primary: Internship["qualificationDetails"], secondary: Internship["qualificationDetails"]): Internship["qualificationDetails"] {
  const left = primary ?? {};
  const right = secondary ?? {};
  const choose = <T>(a: T | undefined, b: T | undefined, unknownValue: T): T => (
    a === undefined || a === unknownValue ? (b === undefined ? unknownValue : b) : a
  );
  return {
    graduationYears: uniqueStrings([...(left.graduationYears ?? []), ...(right.graduationYears ?? [])].map(String)).map(Number),
    graduationYearRange: left.graduationYearRange ?? right.graduationYearRange ?? null,
    expectedGraduation: choose(left.expectedGraduation, right.expectedGraduation, null),
    yearOfStudy: uniqueStrings([...(left.yearOfStudy ?? []), ...(right.yearOfStudy ?? [])]),
    firstYearEligible: choose(left.firstYearEligible, right.firstYearEligible, "unknown"),
    upperYearRequired: choose(left.upperYearRequired, right.upperYearRequired, "unknown"),
    upperYearRequirement: choose(left.upperYearRequirement, right.upperYearRequirement, null),
    degreeRequirements: uniqueStrings([...(left.degreeRequirements ?? []), ...(right.degreeRequirements ?? [])]),
    workAuthorization: choose(left.workAuthorization, right.workAuthorization, "unknown"),
    sponsorship: choose(left.sponsorship, right.sponsorship, "unknown"),
    studentStatusRequirement: choose(left.studentStatusRequirement, right.studentStatusRequirement, "unknown"),
    enrollmentRequirement: choose(left.enrollmentRequirement, right.enrollmentRequirement, "unknown"),
    returningToSchoolRequirement: choose(left.returningToSchoolRequirement, right.returningToSchoolRequirement, "unknown"),
    conflicts: [
      ...(left.conflicts ?? []),
      ...(right.conflicts ?? []),
    ].filter((conflict, index, values) => values.findIndex((candidate) => candidate.key === conflict.key
      && JSON.stringify(candidate.evidence) === JSON.stringify(conflict.evidence)) === index),
    locationModality: choose(left.locationModality, right.locationModality, "unknown"),
    applicationUrl: choose(left.applicationUrl, right.applicationUrl, null),
    deadline: choose(left.deadline, right.deadline, null),
    evidence: uniqueStrings([...(left.evidence ?? []), ...(right.evidence ?? [])]),
  };
}

export function directProviderJobIds(job: Internship): string[] {
  if (hasAggregatorSurface(job)) return [];
  return uniqueStrings([
    extractJobId(job.applicationUrl) ?? "",
    extractJobId(job.postingUrl) ?? "",
    job.jobId ?? "",
  ].filter((id) => /\d/.test(id)).map((id) => id.toLocaleLowerCase()));
}

export function conflictingDirectJobIds(left: Internship, right: Internship): boolean {
  const leftIds = directProviderJobIds(left);
  const rightIds = new Set(directProviderJobIds(right));
  return leftIds.length > 0 && rightIds.size > 0 && !leftIds.some((id) => rightIds.has(id));
}

export function providerJobIdentityKeys(job: Internship): string[] {
  const urls = [job.applicationUrl, job.postingUrl];
  const identities = urls.flatMap((url) => {
    const token = organizationTokenFromUrl(url);
    const ids = uniqueStrings([job.jobId ?? "", extractJobId(url) ?? ""])
      .filter((id) => /\d/.test(id));
    return ids.map((id) => `provider-job:${token}|${id.toLocaleLowerCase()}`);
  });
  return uniqueStrings(identities.filter((value) => !value.endsWith("|")));
}

function identityKeys(job: Internship): string[] {
  const company = normalizeCompanyIdentity(job.company);
  const title = normalizeRoleIdentity(job.title);
  const location = locationIdentity(job);
  const directIds = directProviderJobIds(job);
  const fallbackScope = directIds.length > 0 ? `|req:${directIds.toSorted().join(",")}` : "";
  const keys = [
    `url:${job.applicationUrl}`,
    `url:${job.postingUrl}`,
    `url:${normalizedJobUrl(job.applicationUrl)}`,
    `url:${normalizedJobUrl(job.postingUrl)}`,
    `fallback:${company}|${title}|${location}${fallbackScope}`,
    ...primaryLocationKeys(job).map((key) => `fallback-location:${company}|${title}|${key}${fallbackScope}`),
  ];
  if (job.jobId) keys.push(`job:${company}|${job.jobId.toLocaleLowerCase()}`);
  keys.push(...providerJobIdentityKeys(job));
  return uniqueStrings(keys);
}

export function internshipQuality(job: Internship): number {
  return (isAtsUrl(job.applicationUrl) ? 40 : 0)
    + (!isAggregatorUrl(job.postingUrl) ? 30 : 0)
    - (isAggregatorUrl(job.applicationUrl) ? 35 : 0)
    + (job.applicationUrl !== job.postingUrl ? 15 : 0)
    + Math.min(25, Math.floor(job.description.length / 500))
    + job.requiredQualifications.length
    + job.preferredQualifications.length;
}

export function mergeInternships(primary: Internship, secondary: Internship): Internship {
  const choose = <T>(left: T, right: T, empty: (value: T) => boolean): T => empty(left) && !empty(right) ? right : left;
  return {
    ...primary,
    company: isAggregatorUrl(primary.postingUrl) && !isAggregatorUrl(secondary.postingUrl) ? secondary.company : primary.company,
    jobId: primary.jobId ?? secondary.jobId,
    location: uniqueStrings([...primary.location, ...secondary.location]),
    normalizedLocations: primary.normalizedLocations.length >= secondary.normalizedLocations.length ? primary.normalizedLocations : secondary.normalizedLocations,
    sources: uniqueStrings([...primary.sources, ...secondary.sources]),
    description: choose(primary.description, secondary.description, (value) => value.length < 100),
    responsibilities: uniqueStrings([...primary.responsibilities, ...secondary.responsibilities]),
    requiredQualifications: uniqueStrings([...primary.requiredQualifications, ...secondary.requiredQualifications]),
    preferredQualifications: uniqueStrings([...primary.preferredQualifications, ...secondary.preferredQualifications]),
    technologies: uniqueStrings([...primary.technologies, ...secondary.technologies]),
    educationRequirements: uniqueStrings([...primary.educationRequirements, ...secondary.educationRequirements]),
    graduationRequirements: uniqueStrings([...primary.graduationRequirements, ...secondary.graduationRequirements]),
    experienceRequirements: uniqueStrings([...primary.experienceRequirements, ...secondary.experienceRequirements]),
    workAuthorizationRequirements: uniqueStrings([...primary.workAuthorizationRequirements, ...secondary.workAuthorizationRequirements]),
    sponsorshipInformation: primary.sponsorshipInformation ?? secondary.sponsorshipInformation,
    qualificationDetails: mergeQualificationDetails(primary.qualificationDetails, secondary.qualificationDetails),
    internshipTerm: primary.internshipTerm ?? secondary.internshipTerm,
    internshipYear: primary.internshipYear ?? secondary.internshipYear,
    duration: primary.duration ?? secondary.duration,
    salary: primary.salary ?? secondary.salary,
    postingDate: primary.postingDate ?? secondary.postingDate,
    deadline: primary.deadline ?? secondary.deadline,
    categories: uniqueStrings([...primary.categories, ...secondary.categories]) as Internship["categories"],
    relevanceScore: Math.max(primary.relevanceScore, secondary.relevanceScore),
    relevanceReason: primary.relevanceScore >= secondary.relevanceScore ? primary.relevanceReason : secondary.relevanceReason,
    discoveredAt: primary.discoveredAt < secondary.discoveredAt ? primary.discoveredAt : secondary.discoveredAt,
    lastVerifiedAt: primary.lastVerifiedAt > secondary.lastVerifiedAt ? primary.lastVerifiedAt : secondary.lastVerifiedAt,
  };
}

export function deduplicateJobs(jobs: AnalyzedJob[]): AnalyzedJob[] {
  const records: AnalyzedJob[] = [];
  const keyToIndices = new Map<string, Set<number>>();
  for (const candidate of jobs) {
    const candidateKeys = [
      ...identityKeys(candidate.internship),
      ...listingIdentityKeys(listingIdentityInputFromInternship(candidate.internship)).map(({ key }) => key),
    ];
    const possibleIndices = new Set<number>();
    for (const key of candidateKeys) {
      for (const index of keyToIndices.get(key) ?? []) possibleIndices.add(index);
    }
    const matchingIndex = [...possibleIndices]
      .toSorted((left, right) => left - right)
      .find((index) => {
        const existing = records[index];
        return existing ? listingIdentityMatches(existing.internship, candidate.internship) : false;
      });
    if (matchingIndex === undefined) {
      const nextIndex = records.length;
      records.push(candidate);
      for (const key of candidateKeys) {
        const indexes = keyToIndices.get(key) ?? new Set<number>();
        indexes.add(nextIndex);
        keyToIndices.set(key, indexes);
      }
      continue;
    }

    const existing = records[matchingIndex];
    if (!existing) continue;
    const [primary, secondary] = internshipQuality(candidate.internship) > internshipQuality(existing.internship)
      ? [candidate.internship, existing.internship]
      : [existing.internship, candidate.internship];
    const internship = mergeInternships(primary, secondary);
    records[matchingIndex] = { internship, contentHash: internshipContentHash(internship) };
    const mergedKeys = [
      ...identityKeys(internship),
      ...listingIdentityKeys(listingIdentityInputFromInternship(internship)).map(({ key }) => key),
    ];
    for (const key of mergedKeys) {
      const indexes = keyToIndices.get(key) ?? new Set<number>();
      indexes.add(matchingIndex);
      keyToIndices.set(key, indexes);
    }
  }
  return records;
}
