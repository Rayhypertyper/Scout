import { classifyRole, detectInternship } from "./roleClassifier.js";
import { MIN_LISTING_SCORE } from "../config/thresholds.js";
import { directApplicationOverride } from "../config/directApplicationOverrides.js";
import { isKnownNonProductionJobBoard } from "../config/nonProductionSources.js";
import type { AnalyzedJob, RawJob } from "../domain/types.js";
import type { Internship } from "../domain/schemas.js";
import { InternshipSchema } from "../domain/schemas.js";
import { extractTemporalDetails } from "../parsing/dates.js";
import { isAllowedPostingLocation, parseLocations } from "../parsing/locations.js";
import { extractJobSections, extractQualificationDetails, extractRequirementDetails } from "../parsing/qualifications.js";
import { extractWorkAuthorization } from "../parsing/workAuthorization.js";
import { companyFromEvidence, companyFromUrl } from "../extractors/helpers.js";
import { sha256 } from "../utils/hash.js";
import { decodeHtmlEntities, normalizeCompanyIdentity, normalizeIdentity, oneLine, uniqueStrings } from "../utils/text.js";
import { canonicalizeUrl, extractJobId, isAggregatorUrl, isJobrightJobUrl, isJobrightUrl, isLinkedInJobUrl } from "../utils/url.js";
import { excludedJobTitleReason } from "./titlePolicy.js";

export type AnalyzeResult =
  | { accepted: true; value: AnalyzedJob }
  | { accepted: false; reason: string; title: string; closedUrl?: string; closedStatusCode?: number | null };

export interface AnalyzeOptions {
  /** Allow the structured Intern List feed to retain a Jobright detail URL
   * when its current unauthenticated UI does not expose an employer URL. */
  allowUnresolvedJobright?: boolean;
}

function inferredLocations(text: string): string[] {
  const matches = [...text.matchAll(/(?:^|\n)\s*(?:locations?|work location)\b\s*:?\s*([^\n]{2,160})/gim)];
  return uniqueStrings(matches.map((match) => match[1] ?? ""))
    .filter((value) => !/:$|^(?:&\s*)?details?\b|^(?:flexibility|you may join)\b/i.test(value));
}

export function internshipContentHash(internship: Internship): string {
  const stable = {
    jobId: internship.jobId,
    company: internship.company,
    title: internship.title,
    location: internship.location,
    remoteStatus: internship.remoteStatus,
    applicationUrl: internship.applicationUrl,
    postingUrl: internship.postingUrl,
    description: internship.description,
    responsibilities: internship.responsibilities,
    requiredQualifications: internship.requiredQualifications,
    preferredQualifications: internship.preferredQualifications,
    technologies: internship.technologies,
    educationRequirements: internship.educationRequirements,
    graduationRequirements: internship.graduationRequirements,
    experienceRequirements: internship.experienceRequirements,
    workAuthorizationRequirements: internship.workAuthorizationRequirements,
    sponsorshipInformation: internship.sponsorshipInformation,
    qualificationDetails: internship.qualificationDetails,
    internshipTerm: internship.internshipTerm,
    internshipYear: internship.internshipYear,
    duration: internship.duration,
    salary: internship.salary,
    postingDate: internship.postingDate,
    deadline: internship.deadline,
    categories: internship.categories,
    relevanceScore: internship.relevanceScore,
  };
  return sha256(JSON.stringify(stable));
}

function makeId(company: string, title: string, locations: string[], jobId: string | null, applicationUrl: string): string {
  const identity = jobId
    ? `${normalizeCompanyIdentity(company)}|job:${jobId.toLocaleLowerCase()}`
    : `${normalizeCompanyIdentity(company)}|${normalizeIdentity(title)}|${locations.map(normalizeIdentity).sort().join("|")}|${applicationUrl}`;
  return sha256(identity).slice(0, 24);
}

export async function analyzeRawJob(
  raw: RawJob,
  sourceUrl: string,
  minimumScore: number,
  resolveApplicationUrl: (url: string) => Promise<string | null>,
  now = new Date().toISOString(),
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const titleIndicatesRemote = /^\[remote\]\s*/i.test(raw.title ?? "");
  const title = oneLine(decodeHtmlEntities(raw.title ?? ""))
    .replace(/^\[(?:remote|hybrid|onsite|on-site)\]\s*/i, "")
    .replace(/\s+Job Details\s*\|\s*.+$/i, "")
    .trim();
  const rawCompany = oneLine(raw.company ?? "");
  const description = raw.description?.trim() ?? "";
  const excludedTitleReason = excludedJobTitleReason(title);
  if (excludedTitleReason) {
    return { accepted: false, reason: `The job title contains ${excludedTitleReason}, which is excluded.`, title };
  }
  if (!title || !rawCompany || description.length < 80) {
    return { accepted: false, reason: "The page did not contain a complete title, company, and job description.", title: title || "Unknown job" };
  }

  const textSections = extractJobSections(description);
  const responsibilities = uniqueStrings([...(raw.responsibilities ?? []), ...textSections.responsibilities]);
  const requiredQualifications = uniqueStrings([...(raw.requiredQualifications ?? []), ...textSections.requiredQualifications]);
  const preferredQualifications = uniqueStrings([...(raw.preferredQualifications ?? []), ...textSections.preferredQualifications]);
  const qualificationText = [...requiredQualifications, ...preferredQualifications].join("\n");
  const temporal = extractTemporalDetails(description, title);
  const temporalEvidence = [
    raw.postingDate,
    raw.deadline,
    temporal.internshipTerm && temporal.internshipYear ? `${temporal.internshipTerm} ${temporal.internshipYear}` : null,
  ].filter(Boolean).join("\n");
  const classificationDescription = `${responsibilities.join("\n")}\n${description}`;
  const internshipDetection = detectInternship(title, classificationDescription, qualificationText);
  const relevance = classifyRole(title, classificationDescription, qualificationText, temporalEvidence);
  if (!internshipDetection.isInternship) {
    return { accepted: false, reason: `${relevance.reason} ${internshipDetection.reason}`, title };
  }
  const effectiveMinimumScore = Math.max(minimumScore, MIN_LISTING_SCORE);
  if (relevance.score < effectiveMinimumScore || relevance.categories.length === 0) {
    return { accepted: false, reason: `${relevance.reason} Minimum required score is ${effectiveMinimumScore}.`, title };
  }

  const discoveredPostingUrl = canonicalizeUrl(raw.postingUrl);
  const extractedApplicationUrl = canonicalizeUrl(raw.applicationUrl ?? discoveredPostingUrl, discoveredPostingUrl);
  if (isKnownNonProductionJobBoard(discoveredPostingUrl) || isKnownNonProductionJobBoard(extractedApplicationUrl)) {
    return { accepted: false, reason: "The destination is a known ATS integration sandbox, not a production job board.", title };
  }
  const rawLocations = uniqueStrings([
    ...(raw.locations ?? []),
    ...(titleIndicatesRemote ? ["Remote"] : []),
    ...inferredLocations(description),
  ]);
  const locations = parseLocations(rawLocations, description);
  if (!isAllowedPostingLocation(locations.normalized, locations.remoteStatus)) {
    return { accepted: false, reason: "The posting is not located in Canada, the United States, or a remote work arrangement.", title };
  }
  const extractedUrl = new URL(extractedApplicationUrl);
  const postingPageUrl = new URL(discoveredPostingUrl);
  const extractedPathDepth = extractedUrl.pathname.split("/").filter(Boolean).length;
  const postingPathDepth = postingPageUrl.pathname.split("/").filter(Boolean).length;
  const proposedApplicationUrl = (
    /^\/apply\/?$/i.test(extractedUrl.pathname)
      || (extractedUrl.hostname === postingPageUrl.hostname && extractedPathDepth === 0)
  ) && postingPathDepth > 1
    ? discoveredPostingUrl
    : extractedApplicationUrl;
  const resolvedApplicationUrl = await resolveApplicationUrl(proposedApplicationUrl);
  const hasJobrightUrl = isJobrightUrl(discoveredPostingUrl) || isJobrightUrl(proposedApplicationUrl);
  const requiresJobrightOriginalPost = isJobrightJobUrl(discoveredPostingUrl)
    || isJobrightJobUrl(proposedApplicationUrl);
  if (hasJobrightUrl && (!requiresJobrightOriginalPost || !resolvedApplicationUrl || isAggregatorUrl(resolvedApplicationUrl))) {
    return {
      accepted: false,
      reason: "Jobright's Original job post could not be resolved to an employer or ATS posting.",
      title,
    };
  }
  const resolvedApplicationDestination = directApplicationOverride(proposedApplicationUrl) ?? proposedApplicationUrl;
  const linkedInApplicationDestination = isLinkedInJobUrl(proposedApplicationUrl)
    || isLinkedInJobUrl(resolvedApplicationDestination);
  if (resolvedApplicationUrl === null && linkedInApplicationDestination) {
    return {
      accepted: false,
      reason: "LinkedIn posting is closed or no longer accepting applications",
      title,
      closedUrl: canonicalizeUrl(resolvedApplicationDestination),
      closedStatusCode: null,
    };
  }
  if (resolvedApplicationUrl === null && proposedApplicationUrl === discoveredPostingUrl && !(hasJobrightUrl && options.allowUnresolvedJobright)) {
    return {
      accepted: false,
      reason: "The posting page was unavailable or not found.",
      title,
      closedUrl: discoveredPostingUrl,
      closedStatusCode: null,
    };
  }
  if (isLinkedInJobUrl(discoveredPostingUrl) && proposedApplicationUrl !== discoveredPostingUrl) {
    const resolvedPostingUrl = await resolveApplicationUrl(discoveredPostingUrl);
    if (resolvedPostingUrl === null) {
      return {
        accepted: false,
        reason: "LinkedIn posting is closed or no longer accepting applications",
        title,
        closedUrl: discoveredPostingUrl,
        closedStatusCode: null,
      };
    }
  }
  const applicationUrl = canonicalizeUrl(resolvedApplicationUrl ?? proposedApplicationUrl, discoveredPostingUrl);
  const verifiedPostingOverride = directApplicationOverride(discoveredPostingUrl);
  const postingUrl = verifiedPostingOverride && !requiresJobrightOriginalPost
    ? canonicalizeUrl(verifiedPostingOverride)
    : requiresJobrightOriginalPost
      ? applicationUrl
      : isAggregatorUrl(discoveredPostingUrl) && !isAggregatorUrl(applicationUrl)
      ? applicationUrl
      : discoveredPostingUrl;
  const company = companyFromEvidence(rawCompany, description, companyFromUrl(applicationUrl));
  const canonicalSourceUrl = canonicalizeUrl(sourceUrl);
  const requirementDetails = extractRequirementDetails(`${qualificationText}\n${description}`);
  const authorization = extractWorkAuthorization(`${qualificationText}\n${description}`);
  const qualificationDetails = extractQualificationDetails(`${qualificationText}\n${description}`, {
    applicationUrl,
    deadline: raw.deadline?.trim() || temporal.deadline,
  });
  const jobId = raw.jobId?.trim() || extractJobId(postingUrl) || extractJobId(applicationUrl);

  const internship = InternshipSchema.parse({
    id: makeId(company, title, locations.raw, jobId, applicationUrl),
    jobId,
    company,
    title,
    location: locations.raw,
    normalizedLocations: locations.normalized,
    remoteStatus: locations.remoteStatus,
    applicationUrl,
    postingUrl,
    sourceUrl: canonicalSourceUrl,
    sources: [canonicalSourceUrl],
    description,
    responsibilities,
    requiredQualifications,
    preferredQualifications,
    technologies: relevance.technologies,
    educationRequirements: requirementDetails.education,
    graduationRequirements: requirementDetails.graduation,
    experienceRequirements: requirementDetails.experience,
    workAuthorizationRequirements: authorization.requirements,
    sponsorshipInformation: authorization.sponsorshipInformation,
    qualificationDetails,
    internshipTerm: temporal.internshipTerm,
    internshipYear: temporal.internshipYear,
    duration: temporal.duration,
    salary: raw.salary?.trim() || temporal.salary,
    postingDate: raw.postingDate?.trim() || temporal.postingDate,
    deadline: raw.deadline?.trim() || temporal.deadline,
    categories: relevance.categories,
    relevanceScore: relevance.score,
    relevanceReason: `${relevance.reason} ${internshipDetection.reason}`,
    lifecycleStatus: "NEW",
    availabilityStatus: "open",
    discoveredAt: now,
    lastVerifiedAt: now,
  });
  return { accepted: true, value: { internship, contentHash: internshipContentHash(internship) } };
}
