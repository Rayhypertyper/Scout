import type { PageSnapshot, RawJob } from "../domain/types.js";
import { safeCanonicalizeUrl } from "../utils/url.js";
import { htmlFragmentToText } from "./helpers.js";

interface JobrightProperties {
  title?: unknown;
  company?: unknown;
  location?: unknown;
  salary?: unknown;
  workModel?: unknown;
  industry?: unknown;
  companySize?: unknown;
  qualifications?: unknown;
  expLevel?: unknown;
  jobFunction?: unknown;
  h1bSponsored?: unknown;
  isNewGrad?: unknown;
  roleType?: unknown;
  hireTime?: unknown;
  graduateTime?: unknown;
}

interface JobrightRecord {
  jobId?: unknown;
  tabCategory?: unknown;
  properties?: JobrightProperties;
  postedAt?: unknown;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function recordsFromPayload(value: unknown): JobrightRecord[] {
  if (!value || typeof value !== "object") return [];
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return [];
  const jobs = (result as { jobList?: unknown }).jobList;
  return Array.isArray(jobs)
    ? jobs.filter((job): job is JobrightRecord => Boolean(job && typeof job === "object"))
    : [];
}

function parsePayload(snapshot: PageSnapshot): unknown {
  if (!/swan-api\.jobright\.ai$/i.test(new URL(snapshot.url).hostname)) return null;
  if (!/\/swan\/mini-sites\/list$/i.test(new URL(snapshot.url).pathname)) return null;
  try {
    return JSON.parse(snapshot.text) as unknown;
  } catch {
    return null;
  }
}

function postedDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const text = stringValue(value);
  return text || undefined;
}

function locations(value: unknown): string[] {
  return stringArray(value).flatMap((item) => item.split(/\s*;\s*|\s+\|\s+/).map((part) => part.trim()).filter(Boolean));
}

function jobrightUrl(jobId: string): string {
  return `https://jobright.ai/jobs/info/${encodeURIComponent(jobId)}`;
}

function rawJob(record: JobrightRecord): RawJob | null {
  const jobId = stringValue(record.jobId);
  const properties = record.properties ?? {};
  const title = stringValue(properties.title);
  const company = stringValue(properties.company);
  if (!jobId || !title || !company) return null;
  const location = locations(properties.location);
  const salary = stringValue(properties.salary);
  const workModel = stringValue(properties.workModel);
  const industry = stringArray(properties.industry);
  const qualifications = htmlFragmentToText(stringValue(properties.qualifications));
  const metadata = [
    location.length > 0 ? `Location: ${location.join("; ")}.` : "",
    workModel ? `Work model: ${workModel}.` : "",
    salary ? `Salary: ${salary}.` : "",
    industry.length > 0 ? `Industry: ${industry.join(", ")}.` : "",
    stringValue(properties.companySize) ? `Company size: ${stringValue(properties.companySize)}.` : "",
    stringValue(properties.hireTime) ? `Internship term: ${stringValue(properties.hireTime)}.` : "",
    stringValue(properties.graduateTime) ? `Graduate time: ${stringValue(properties.graduateTime)}.` : "",
  ].filter(Boolean);
  const description = [
    `Role: ${title}.`,
    `Company: ${company}.`,
    ...metadata,
    qualifications ? `Qualifications:\n${qualifications}` : "",
  ].filter(Boolean).join("\n");
  const postingUrl = safeCanonicalizeUrl(jobrightUrl(jobId)) ?? jobrightUrl(jobId);
  return {
    company,
    title,
    locations: location,
    description,
    requiredQualifications: qualifications ? [qualifications] : [],
    applicationUrl: postingUrl,
    postingUrl,
    jobId,
    ...(salary ? { salary } : {}),
    ...(postedDate(record.postedAt) ? { postingDate: postedDate(record.postedAt) } : {}),
    sourceProvider: "jobright-intern-list",
  };
}

/** Extract the structured Jobright records used by Intern List's embed. */
export function extractJobrightJobs(snapshot: PageSnapshot): RawJob[] {
  const payload = parsePayload(snapshot);
  if (!payload) return [];
  return recordsFromPayload(payload).map(rawJob).filter((job): job is RawJob => Boolean(job));
}

/** Exported for focused fixture tests and offline feed validation. */
export function extractJobrightJobRecords(value: unknown): RawJob[] {
  return recordsFromPayload(value).map(rawJob).filter((job): job is RawJob => Boolean(job));
}
