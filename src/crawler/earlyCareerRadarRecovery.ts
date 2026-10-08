import type { AnalyzedJob, RawJob, PageSnapshot } from "../domain/types.js";
import { earlyCareerRadarDetailUrl, parseEarlyCareerRadarEmbeddedJobs, parseEarlyCareerRadarJobs, selectEarlyCareerRadarJobs, type EarlyCareerRadarJob } from "./adapters/earlyCareerRadar.js";
import { earlyCareerRadarSameSite, isEarlyCareerRadarSource } from "./publicSources.js";
import { canonicalizeUrl, safeCanonicalizeUrl } from "../utils/url.js";
import { decodeHtmlEntities, normalizeCompanyIdentity, normalizeRoleIdentity, oneLine, uniqueStrings } from "../utils/text.js";
import type { Internship } from "../domain/schemas.js";
import { internshipContentHash } from "../classification/analyzeJob.js";

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayText(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(textValue).filter((entry): entry is string => entry !== null)
    : [];
}

function recordText(job: EarlyCareerRadarJob, key: string): string | null {
  return textValue(job.rawRecord[key]);
}

function recordArray(job: EarlyCareerRadarJob, key: string): string[] {
  return arrayText(job.rawRecord[key]);
}

/**
 * Replace an iCIMS login portal with the public job-detail route when the
 * supplied destination has the canonical `/jobs/{id}/login` shape. This only
 * changes the saved outbound link; crawler robots checks are never bypassed.
 */
export function canonicalEarlyCareerRadarApplyUrl(value: string, baseUrl: string): string | null {
  const canonical = safeCanonicalizeUrl(value, baseUrl);
  if (!canonical) return null;
  try {
    const url = new URL(canonical);
    if (/(?:^|\.)icims\.com$/i.test(url.hostname) && /^\/jobs\/[^/]+\/login\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/login\/?$/i, "/job");
      url.search = "";
      url.searchParams.set("mobile", "true");
      url.searchParams.set("needsRedirect", "false");
    }
    return canonicalizeUrl(url.toString());
  } catch {
    return null;
  }
}

function metadataOnlyDescription(job: EarlyCareerRadarJob, detailUrl: string): string {
  const track = recordText(job, "track");
  const mode = recordText(job, "mode");
  const years = job.studentYears ?? recordArray(job, "studentYears");
  const authorization = recordArray(job, "workAuthorization");
  const postedAt = job.postedAt ?? recordText(job, "postedAt");
  const deadline = job.deadlineAt ?? recordText(job, "deadlineAt");
  const details = [
    `Early Career Radar's Summer Internships feed lists ${job.title} at ${job.company}.`,
    `Location listed by the source: ${job.location || "not stated"}.`,
    `Role track: ${track || "not stated"}; work model: ${mode || "not stated"}.`,
    `Student year listed by the source: ${years.length > 0 ? years.join(", ") : "not stated"}.`,
    `Work authorization listed by the source: ${authorization.length > 0 ? authorization.join(", ") : "not stated"}.`,
    postedAt ? `The source lists a posting date of ${postedAt}.` : "The source does not state a posting date.",
    deadline ? `The source lists a deadline of ${deadline}.` : "The source does not state an application deadline.",
    "The feed record does not include the employer's full job description, responsibilities, or qualifications.",
    `Open the source detail record for any additional information: ${detailUrl}`,
  ];
  return details.join(" ");
}

/**
 * Map one first-party Radar feed record to the shared parser contract without
 * resolving or requesting its employer destination. Missing role details stay
 * explicitly unknown instead of being inferred from the employer URL.
 */
export function earlyCareerRadarJobToRawJob(job: EarlyCareerRadarJob, sourceUrl: string): RawJob {
  const postingUrl = earlyCareerRadarDetailUrl(job.id);
  const exactDescription = textValue(job.description)
    ?? textValue(job.rawRecord.descriptionHtml)
    ?? textValue(job.rawRecord.description);
  const description = exactDescription
    ? oneLine(decodeHtmlEntities(exactDescription.replace(/<[^>]*>/g, " ")))
    : metadataOnlyDescription(job, postingUrl);
  const exactApplicationUrl = textValue(job.applyUrl) ?? textValue(job.rawRecord.applyUrl);
  const applicationUrl = exactApplicationUrl
    ? canonicalEarlyCareerRadarApplyUrl(exactApplicationUrl, sourceUrl) ?? postingUrl
    : postingUrl;
  const location = job.location || [
    ...recordArray(job, "placeStates"),
    ...recordArray(job, "placeCountries"),
  ].join(", ");

  return {
    company: job.company,
    title: job.title,
    ...(location ? { locations: [location] } : {}),
    description,
    applicationUrl,
    postingUrl,
    jobId: job.id,
    ...(job.postedAt ? { postingDate: job.postedAt } : {}),
    ...(job.deadlineAt ? { deadline: job.deadlineAt } : {}),
    sourceProvider: "early-career-radar",
  };
}

export function isEarlyCareerRadarMetadataOnlyDescription(value: string): boolean {
  return value.includes("does not include the employer's full job description");
}

/** Keep previously retrieved employer detail content when today's source row
 * has only metadata. The Radar observation makes availability unknown, and
 * the old employer-verification timestamp is deliberately not advanced. */
export function mergeEarlyCareerRadarMetadataWithPrior(
  incoming: AnalyzedJob,
  prior: Internship,
): AnalyzedJob {
  if (!isEarlyCareerRadarMetadataOnlyDescription(incoming.internship.description)
    || isEarlyCareerRadarMetadataOnlyDescription(prior.description)
    || normalizeCompanyIdentity(incoming.internship.company) !== normalizeCompanyIdentity(prior.company)
    || normalizeRoleIdentity(incoming.internship.title) !== normalizeRoleIdentity(prior.title)
    || !sameEarlyCareerRadarIdentity(incoming.internship, prior)) return incoming;

  const updated: Internship = {
    ...prior,
    ...incoming.internship,
    sources: uniqueStrings([...prior.sources, ...incoming.internship.sources]),
    description: prior.description,
    responsibilities: prior.responsibilities,
    requiredQualifications: prior.requiredQualifications,
    preferredQualifications: prior.preferredQualifications,
    technologies: prior.technologies,
    educationRequirements: prior.educationRequirements,
    graduationRequirements: prior.graduationRequirements,
    experienceRequirements: prior.experienceRequirements,
    workAuthorizationRequirements: prior.workAuthorizationRequirements,
    sponsorshipInformation: prior.sponsorshipInformation,
    qualificationDetails: {
      ...prior.qualificationDetails,
      applicationUrl: incoming.internship.applicationUrl,
      deadline: incoming.internship.deadline ?? prior.qualificationDetails.deadline,
    },
    internshipTerm: incoming.internship.internshipTerm ?? prior.internshipTerm,
    internshipYear: incoming.internship.internshipYear ?? prior.internshipYear,
    duration: incoming.internship.duration ?? prior.duration,
    salary: incoming.internship.salary ?? prior.salary,
    postingDate: incoming.internship.postingDate ?? prior.postingDate,
    deadline: incoming.internship.deadline ?? prior.deadline,
    categories: prior.categories,
    relevanceScore: prior.relevanceScore,
    relevanceReason: prior.relevanceReason,
    provenance: prior.provenance.filter(({ field }) => field !== "applicationUrl"
      && field !== "qualificationDetails.applicationUrl"),
    availabilityStatus: "unknown",
    discoveredAt: prior.discoveredAt,
    lastVerifiedAt: prior.lastVerifiedAt,
  };
  return { internship: updated, contentHash: internshipContentHash(updated) };
}

function sameEarlyCareerRadarIdentity(incoming: Internship, prior: Internship): boolean {
  const incomingPostingUrl = safeCanonicalizeUrl(incoming.postingUrl);
  const priorPostingUrl = safeCanonicalizeUrl(prior.postingUrl);
  if (incomingPostingUrl && priorPostingUrl && incomingPostingUrl === priorPostingUrl) return true;
  return Boolean(incoming.jobId && prior.jobId && incoming.jobId === prior.jobId);
}

/**
 * Enrich one feed record with its own first-party detail response while
 * retaining the feed's stable identity and outbound apply destination. A
 * detail page can redirect or expose stale structured identity, so only its
 * content and qualifications are merged into the authoritative feed row.
 */
export function earlyCareerRadarDetailToRawJob(
  job: EarlyCareerRadarJob,
  detail: RawJob,
  sourceUrl: string,
): RawJob {
  const feed = earlyCareerRadarJobToRawJob(job, sourceUrl);
  const feedDescription = feed.description ?? "";
  const detailDescription = detail.description?.trim() ?? "";
  const useDetailDescription = Boolean(detailDescription)
    && (isEarlyCareerRadarMetadataOnlyDescription(feedDescription) || detailDescription.length > feedDescription.length);
  return {
    ...feed,
    ...(useDetailDescription ? { description: detailDescription } : {}),
    ...(detail.responsibilities?.length ? { responsibilities: detail.responsibilities } : {}),
    ...(detail.requiredQualifications?.length ? { requiredQualifications: detail.requiredQualifications } : {}),
    ...(detail.preferredQualifications?.length ? { preferredQualifications: detail.preferredQualifications } : {}),
    ...(detail.salary ? { salary: detail.salary } : {}),
    ...(detail.internshipTerm ? { internshipTerm: detail.internshipTerm } : {}),
    ...(detail.internshipYear ? { internshipYear: detail.internshipYear } : {}),
    ...(detail.duration ? { duration: detail.duration } : {}),
    company: feed.company,
    title: feed.title,
    locations: feed.locations,
    applicationUrl: feed.applicationUrl,
    postingUrl: feed.postingUrl,
    jobId: feed.jobId,
    sourceProvider: feed.sourceProvider,
  };
}

/**
 * Generic deduplication scores description length, which can make the Radar
 * feed's verbose metadata disclaimer outrank a shorter but real detail-page
 * description. After ordinary identity-safe deduplication, restore the best
 * non-metadata description observed for that exact Radar row.
 */
export function preferEarlyCareerRadarDetailDescriptions(
  deduplicated: readonly AnalyzedJob[],
  observed: readonly AnalyzedJob[],
): AnalyzedJob[] {
  const identityKeys = (job: Internship): string[] => {
    const company = normalizeCompanyIdentity(job.company);
    const title = normalizeRoleIdentity(job.title);
    if (!company || !title) return [];
    const roleKey = `${company}|${title}`;
    const postingUrl = safeCanonicalizeUrl(job.postingUrl);
    return [
      ...(postingUrl ? [`posting:${roleKey}|${postingUrl}`] : []),
      ...(job.jobId ? [`id:${roleKey}|${job.jobId}`] : []),
    ];
  };
  const detailsByIdentity = new Map<string, Internship[]>();
  for (const candidate of observed) {
    const detail = candidate.internship;
    if (isEarlyCareerRadarMetadataOnlyDescription(detail.description) || !detail.description.trim()) continue;
    for (const key of identityKeys(detail)) {
      const rows = detailsByIdentity.get(key) ?? [];
      rows.push(detail);
      detailsByIdentity.set(key, rows);
    }
  }
  return deduplicated.map((job) => {
    const current = job.internship;
    const details = new Set(identityKeys(current).flatMap((key) => detailsByIdentity.get(key) ?? []));
    const richest = [...details].toSorted((left, right) => right.description.length - left.description.length)[0];
    if (!richest) return job;
    if (!isEarlyCareerRadarMetadataOnlyDescription(current.description)
      && richest.description.length <= current.description.length) return job;
    const internship = { ...current, description: richest.description };
    return { internship, contentHash: internshipContentHash(internship) };
  });
}

export interface EarlyCareerRadarRecoveryInventory {
  records: EarlyCareerRadarJob[];
  rawJobs: RawJob[];
}

/** Parse the first-party listing feed, retaining status rows for inventory accounting. */
export function earlyCareerRadarInventoryFromSnapshot(
  snapshot: PageSnapshot,
  sourceUrl: string,
): EarlyCareerRadarRecoveryInventory | null {
  let parsed: EarlyCareerRadarJob[] | null = null;
  if (isEarlyCareerRadarSource(snapshot.url)) {
    parsed = parseEarlyCareerRadarEmbeddedJobs(snapshot.html);
  } else {
    try {
      const snapshotUrl = new URL(snapshot.url);
      if (snapshotUrl.hostname === "earlycareerradar.com" && snapshotUrl.pathname === "/api/jobs"
        && earlyCareerRadarSameSite(sourceUrl, snapshot.url)) {
        parsed = parseEarlyCareerRadarJobs(JSON.parse(snapshot.html) as unknown);
      }
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return null;
  const records = selectEarlyCareerRadarJobs(sourceUrl, parsed);
  return {
    records,
    rawJobs: records.filter((job) => job.closed !== true)
      .map((job) => earlyCareerRadarJobToRawJob(job, sourceUrl)),
  };
}

export function earlyCareerRadarFeedDetailUrl(job: EarlyCareerRadarJob): string {
  return earlyCareerRadarDetailUrl(job.id);
}
