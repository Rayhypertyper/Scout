import type { CheerioAPI } from "cheerio";

import type { PageSnapshot, RawJob } from "../domain/types.js";
import { extractJobId, safeCanonicalizeUrl } from "../utils/url.js";
import {
  cleanContentText,
  companyFromEvidence,
  companyFromPostingUrl,
  companyFromUrl,
  findApplyUrl,
  firstText,
  htmlFragmentToText,
  page$,
  sectionsFromText,
  texts,
} from "./helpers.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectJobPostings(value: unknown, output: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostings(item, output);
    return;
  }
  if (!isObject(value)) return;
  const type = value["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) output.push(value);
  for (const child of Object.values(value)) {
    if (isObject(child) || Array.isArray(child)) collectJobPostings(child, output);
  }
}

function structuredJobs($: CheerioAPI): JsonObject[] {
  const jobs: JsonObject[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    const source = $(element).text().trim();
    if (!source) return;
    try {
      collectJobPostings(JSON.parse(source) as unknown, jobs);
    } catch {
      // Malformed structured data should not prevent semantic extraction.
    }
  });
  return jobs;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function organizationName(value: unknown): string | undefined {
  if (isObject(value)) return stringValue(value.name);
  return stringValue(value);
}

function addressToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isObject(value)) return undefined;
  const address = isObject(value.address) ? value.address : value;
  const pieces = [address.addressLocality, address.addressRegion, address.addressCountry]
    .map((part) => isObject(part) ? stringValue(part.name) : stringValue(part))
    .filter((part): part is string => Boolean(part));
  return pieces.length > 0 ? pieces.join(", ") : undefined;
}

function structuredLocations(job: JsonObject): string[] {
  const raw = job.jobLocation;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const locations = entries.map(addressToString).filter((value): value is string => Boolean(value));
  if (job.jobLocationType === "TELECOMMUTE") {
    const requirements = job.applicantLocationRequirements;
    const remotePlaces = (Array.isArray(requirements) ? requirements : requirements ? [requirements] : [])
      .map(addressToString)
      .filter((value): value is string => Boolean(value));
    locations.push(remotePlaces.length > 0 ? `Remote — ${remotePlaces.join(", ")}` : "Remote");
  }
  return locations;
}

function salaryValue(value: unknown): string | undefined {
  if (!isObject(value)) return stringValue(value);
  const currency = stringValue(value.currency) ?? "";
  const amount = isObject(value.value) ? value.value : value;
  const minimum = stringValue(amount.minValue);
  const maximum = stringValue(amount.maxValue);
  const unit = stringValue(amount.unitText);
  if (!minimum && !maximum) return undefined;
  const range = minimum && maximum ? `${minimum}–${maximum}` : (minimum ?? maximum ?? "");
  return [currency, range, unit ? `per ${unit.toLocaleLowerCase()}` : ""].filter(Boolean).join(" ");
}

function fromStructuredData(job: JsonObject, snapshot: PageSnapshot): RawJob | null {
  const title = stringValue(job.title);
  const descriptionHtml = stringValue(job.description) ?? "";
  if (!title || !descriptionHtml) return null;
  const description = htmlFragmentToText(descriptionHtml);
  const sections = sectionsFromText(description);
  const structuredUrl = stringValue(job.url);
  const postingUrl = structuredUrl ? (safeCanonicalizeUrl(structuredUrl, snapshot.url) ?? snapshot.url) : snapshot.url;
  const fallbackCompany = companyFromPostingUrl(snapshot.url) ?? companyFromUrl(snapshot.url);
  return {
    company: companyFromEvidence(organizationName(job.hiringOrganization), description, fallbackCompany),
    title,
    locations: structuredLocations(job),
    description,
    ...sections,
    applicationUrl: findApplyUrl(page$(snapshot), snapshot.url) ?? postingUrl,
    postingUrl,
    jobId: stringValue(job.identifier) ?? (isObject(job.identifier) ? stringValue(job.identifier.value) : undefined) ?? extractJobId(snapshot.url) ?? undefined,
    salary: salaryValue(job.baseSalary),
    postingDate: stringValue(job.datePosted),
    deadline: stringValue(job.validThrough),
    sourceProvider: "json-ld",
  };
}

function semanticJob(snapshot: PageSnapshot, $: CheerioAPI): RawJob | null {
  const title = firstText($, [
    "h2.banner__text__title",
    "main h1",
    "[role='main'] h1",
    "[data-automation-id='jobPostingHeader'] h2",
    "[data-testid='job-title']",
    ".job-title",
    ".posting-headline h2",
    "h1",
  ]);
  const description = cleanContentText($, [
    "[data-automation-id='jobPostingDescription']",
    "[data-testid='job-description']",
    ".job-description",
    ".job__description",
    ".posting-page",
    "article",
    "main",
    "[role='main']",
  ]);
  if (!title || description.length < 100) return null;
  const internshipSignal = /\b(?:intern(?:ship)?|co[ -]?op|student program|university program)\b/i.test(`${title}\n${description}`);
  const jobSignal = /\b(?:responsibilities|qualifications|requirements|apply|about the role|what you(?:'|’)ll do)\b/i.test(description);
  if (!internshipSignal || !jobSignal) return null;
  const sections = sectionsFromText(description);
  const companyCandidate = firstText($, ["[data-testid='company-name']", ".company-name", ".posting-categories .sort-by-team"])
    || $("meta[property='og:site_name']").attr("content")?.trim()
    || "";
  const company = companyFromEvidence(
    companyCandidate,
    description,
    companyFromPostingUrl(snapshot.url) ?? companyFromUrl(snapshot.url),
  );
  const locations = texts($, [
    ".card-item-location",
    "[data-testid='job-location']",
    "[data-automation-id='locations']",
    ".job-location",
    ".location",
    ".posting-categories .sort-by-location",
  ]);
  return {
    company,
    title,
    locations,
    description,
    ...sections,
    applicationUrl: findApplyUrl($, snapshot.url) ?? snapshot.url,
    postingUrl: snapshot.url,
    jobId: extractJobId(snapshot.url) ?? undefined,
    sourceProvider: "generic",
  };
}

export function extractGenericJobs(snapshot: PageSnapshot): RawJob[] {
  const $ = page$(snapshot);
  const jobs = structuredJobs($).map((job) => fromStructuredData(job, snapshot)).filter((job): job is RawJob => Boolean(job));
  if (jobs.length > 0) return jobs;
  const semantic = semanticJob(snapshot, $);
  return semantic ? [semantic] : [];
}
