import { classifyRole, detectInternship } from "./roleClassifier.js";
import { MIN_LISTING_SCORE } from "../config/thresholds.js";
import { directApplicationOverride } from "../config/directApplicationOverrides.js";
import { isKnownNonProductionJobBoard } from "../config/nonProductionSources.js";
import type { AnalyzedJob, RawJob } from "../domain/types.js";
import type { FieldEvidence, Internship } from "../domain/schemas.js";
import { FieldEvidenceSchema, InternshipSchema } from "../domain/schemas.js";
import { extractTemporalDetails } from "../parsing/dates.js";
import { isAllowedPostingLocation, parseLocations } from "../parsing/locations.js";
import { extractJobSections, extractQualificationDetails, extractRequirementDetails } from "../parsing/qualifications.js";
import { extractWorkAuthorization } from "../parsing/workAuthorization.js";
import { companyFromEvidence, companyFromUrl } from "../extractors/helpers.js";
import { sha256 } from "../utils/hash.js";
import { decodeHtmlEntities, normalizeCompanyIdentity, normalizeIdentity, oneLine, uniqueStrings } from "../utils/text.js";
import { canonicalizeUrl, extractJobId, isAggregatorUrl, isJobrightJobUrl, isJobrightUrl, isLinkedInJobUrl } from "../utils/url.js";
import { excludedJobTitleReason } from "./titlePolicy.js";
import { alignFieldEvidence } from "../llm/evidence.js";

export type AnalyzeResult =
  | { accepted: true; value: AnalyzedJob }
  | { accepted: false; reason: string; title: string; closedUrl?: string; closedStatusCode?: number | null };

export interface AnalyzeOptions {
  /** Allow the structured Intern List feed to retain a Jobright detail URL
   * when its current unauthenticated UI does not expose an employer URL. */
  allowUnresolvedJobright?: boolean;
}

function evidenceValueMatches(left: string, right: string): boolean {
  return normalizeIdentity(oneLine(decodeHtmlEntities(left)))
    === normalizeIdentity(oneLine(decodeHtmlEntities(right)));
}

function sourceContains(source: FieldEvidence, value: string): boolean {
  const normalizedValue = evidenceValueMatches(source.quote, value);
  if (normalizedValue) return true;
  if (!value.trim()) return false;
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, "i").test(source.quote); } catch { return false; }
}

function internshipEvidence(raw: RawJob, internship: Omit<Internship, "provenance">): FieldEvidence[] {
  const output: FieldEvidence[] = [];
  for (const evidence of raw.provenance ?? []) {
    const arrayField = /^(locations|responsibilities|requiredQualifications|preferredQualifications)\[(\d+)\]$/.exec(evidence.field);
    let field = evidence.field;
    let value: string | undefined;
    if (arrayField) {
      const sourceField = arrayField[1];
      const sourceIndex = Number(arrayField[2]);
      const rawValues = sourceField === "locations" ? raw.locations
        : sourceField === "responsibilities" ? raw.responsibilities
          : sourceField === "requiredQualifications" ? raw.requiredQualifications
            : raw.preferredQualifications;
      const rawValue = rawValues?.[sourceIndex];
      if (!rawValue || !evidenceValueMatches(evidence.value, rawValue)) continue;
      const destination = sourceField === "locations" ? internship.location
        : sourceField === "responsibilities" ? internship.responsibilities
          : sourceField === "requiredQualifications" ? internship.requiredQualifications
            : internship.preferredQualifications;
      const index = destination.findIndex((candidate) => evidenceValueMatches(candidate, rawValue));
      if (index < 0) continue;
      field = `${sourceField === "locations" ? "location" : sourceField}[${index}]`;
      value = destination[index];
    } else {
      const destinationValues: Record<string, string | null | undefined> = {
        company: internship.company,
        title: internship.title,
        jobId: internship.jobId,
        description: internship.description,
        salary: internship.salary,
        postingDate: internship.postingDate,
        deadline: internship.deadline,
        applicationUrl: internship.applicationUrl,
        internshipTerm: internship.internshipTerm,
        internshipYear: internship.internshipYear,
        duration: internship.duration,
      };
      const destination = destinationValues[evidence.field];
      if (!destination || !(evidenceValueMatches(evidence.value, destination)
        || evidence.field === "description" && normalizeIdentity(destination).includes(normalizeIdentity(evidence.value)))) continue;
      value = evidence.field === "description" ? evidence.value : destination;
    }
    if (value) {
      const parsed = FieldEvidenceSchema.safeParse({ ...evidence, field, value });
      if (parsed.success) output.push(parsed.data);
    }
  }
  return output.filter((item, index) => output.findIndex((candidate) => candidate.field === item.field
    && candidate.value === item.value && candidate.pageUrl === item.pageUrl
    && candidate.start === item.start && candidate.end === item.end) === index);
}

function derivedEvidence(internship: Internship, source: FieldEvidence[]): FieldEvidence[] {
  const output: FieldEvidence[] = [];
  const addStringArrays = (field: string, values: string[]): void => {
    values.forEach((value, index) => {
      for (const evidence of source) {
        if (sourceContains(evidence, value)) output.push({ ...evidence, field: `${field}[${index}]`, value });
      }
    });
  };
  addStringArrays("technologies", internship.technologies);
  addStringArrays("educationRequirements", internship.educationRequirements);
  addStringArrays("graduationRequirements", internship.graduationRequirements);
  addStringArrays("experienceRequirements", internship.experienceRequirements);
  addStringArrays("workAuthorizationRequirements", internship.workAuthorizationRequirements);
  addStringArrays("qualificationDetails.evidence", internship.qualificationDetails.evidence);
  addStringArrays("qualificationDetails.yearOfStudy", internship.qualificationDetails.yearOfStudy);
  addStringArrays("qualificationDetails.degreeRequirements", internship.qualificationDetails.degreeRequirements);
  addStringArrays("qualificationDetails.graduationYears", internship.qualificationDetails.graduationYears.map(String));
  internship.normalizedLocations.forEach((location, index) => {
    for (const key of ["country", "provinceState", "city"] as const) {
      const value = location[key];
      if (!value) continue;
      for (const evidence of source) if (sourceContains(evidence, value)) {
        output.push({ ...evidence, field: `normalizedLocations[${index}].${key}`, value });
      }
    }
  });
  const modality = internship.remoteStatus;
  const modalityPattern = modality === "remote" ? /\bremote\b/i
    : modality === "hybrid" ? /\bhybrid\b/i
      : modality === "onsite" ? /\b(?:on[ -]?site|in person|in-office)\b/i : null;
  if (modalityPattern) {
    for (const evidence of source) if (modalityPattern.test(evidence.quote)) {
      output.push({ ...evidence, field: "remoteStatus", value: modality });
      if (internship.qualificationDetails.locationModality === modality) {
        output.push({ ...evidence, field: "qualificationDetails.locationModality", value: modality });
      }
    }
  }
  const details = internship.qualificationDetails;
  const directQualificationValues: Array<[string, string | null]> = [
    ["qualificationDetails.expectedGraduation", details.expectedGraduation],
    ["qualificationDetails.upperYearRequirement", details.upperYearRequirement],
    ["qualificationDetails.applicationUrl", details.applicationUrl],
    ["qualificationDetails.deadline", details.deadline],
  ];
  for (const [field, value] of directQualificationValues) {
    if (!value) continue;
    for (const evidence of source) if (sourceContains(evidence, value)) output.push({ ...evidence, field, value });
  }
  const enumSupport: Array<{ field: string; value: string; matches: (quote: string) => boolean }> = [
    { field: "qualificationDetails.workAuthorization", value: details.workAuthorization, matches: (quote) => details.workAuthorization === "required"
      ? /\b(?:must|required|requirement)\b[^.\n]{0,100}\b(?:authorized|authorised|authorization|citizen|permanent resident)\b/i.test(quote)
      : details.workAuthorization === "not_required" && /\b(?:no|not)\b[^.\n]{0,60}\b(?:work authorization|authorization|sponsorship)\b/i.test(quote) },
    { field: "qualificationDetails.sponsorship", value: details.sponsorship, matches: (quote) => details.sponsorship === "available"
      ? /\b(?:will|can|may|offer|provide|available)\b[^.\n]{0,100}\b(?:sponsor|sponsorship|visa)\b/i.test(quote)
      : details.sponsorship === "unavailable" && /\b(?:no|not|cannot|can't|unable to|will not)\b[^.\n]{0,100}\b(?:sponsor|sponsorship|visa)\b/i.test(quote) },
    { field: "qualificationDetails.studentStatusRequirement", value: details.studentStatusRequirement, matches: (quote) => details.studentStatusRequirement === "required"
      ? /\b(?:must|required|requirement)\b[^.\n]{0,100}\b(?:student|enrolled|enrollment|return to school)\b/i.test(quote)
      : details.studentStatusRequirement === "preferred" && /\b(?:preferred|nice to have|desired)\b[^.\n]{0,100}\b(?:student|enrolled|enrollment)\b/i.test(quote) },
    { field: "qualificationDetails.enrollmentRequirement", value: details.enrollmentRequirement, matches: (quote) => details.enrollmentRequirement === "required"
      ? /\b(?:must|required|requirement)\b[^.\n]{0,100}\b(?:enrolled|enrollment|currently pursuing)\b/i.test(quote)
      : details.enrollmentRequirement === "preferred" && /\b(?:preferred|nice to have|desired)\b[^.\n]{0,100}\b(?:enrolled|enrollment|currently pursuing)\b/i.test(quote) },
    { field: "qualificationDetails.returningToSchoolRequirement", value: details.returningToSchoolRequirement, matches: (quote) => details.returningToSchoolRequirement === "required"
      ? /\b(?:must|required|requirement)\b[^.\n]{0,100}\breturn to school\b/i.test(quote)
      : details.returningToSchoolRequirement === "preferred" && /\b(?:preferred|nice to have|desired)\b[^.\n]{0,100}\breturn to school\b/i.test(quote) },
  ];
  for (const item of enumSupport) {
    if (item.value === "unknown" || item.value === "conflict") continue;
    for (const evidence of source) if (item.matches(evidence.quote)) {
      output.push({ ...evidence, field: item.field, value: item.value });
    }
  }
  for (const [field, value] of [
    ["internshipTerm", internship.internshipTerm],
    ["internshipYear", internship.internshipYear],
    ["duration", internship.duration],
    ["salary", internship.salary],
    ["postingDate", internship.postingDate],
    ["deadline", internship.deadline],
  ] as const) {
    if (!value) continue;
    for (const evidence of source) if (sourceContains(evidence, value)) {
      const context = evidence.quote;
      const temporallyBound = field === "internshipYear" ? /\b(?:fall|winter|spring|summer|internship|co[\s-]?op|term|semester)\b/i.test(context)
        : field === "postingDate" ? /\b(?:posted|date posted|posting date)\b/i.test(context)
          : field === "deadline" ? /\b(?:deadline|apply by|closing date|applications close)\b/i.test(context)
            : field === "salary" ? /\b(?:salary|compensation|pay|hourly|per hour)\b/i.test(context)
              : true;
      if (temporallyBound) output.push({ ...evidence, field, value });
    }
  }
  return alignFieldEvidence(internship, output);
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
  const internshipTerm = temporal.internshipTerm ?? raw.internshipTerm?.trim() ?? null;
  const internshipYear = temporal.internshipYear ?? raw.internshipYear?.trim() ?? null;
  const duration = temporal.duration ?? raw.duration?.trim() ?? null;
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
    internshipTerm,
    internshipYear,
    duration,
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
    provenance: [],
  });
  const directEvidence = internshipEvidence(raw, internship);
  const value = InternshipSchema.parse({
    ...internship,
    provenance: alignFieldEvidence(internship, [
      ...directEvidence,
      ...derivedEvidence(internship, directEvidence),
    ]),
  });
  return { accepted: true, value: { internship: value, contentHash: internshipContentHash(value) } };
}
