import type { PageSnapshot, RawJob } from "../domain/types.js";
import { extractJobId } from "../utils/url.js";
import { cleanContentText, companyFromEvidence, companyFromUrl, findApplyUrl, firstText, htmlFragmentToText, page$, sectionsFromText, texts } from "./helpers.js";

interface GreenhouseApiJob {
  id?: unknown;
  title?: unknown;
  content?: unknown;
  absolute_url?: unknown;
  location?: unknown;
  updated_at?: unknown;
  metadata?: unknown;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function greenhouseApiJob(snapshot: PageSnapshot): RawJob | null {
  if (!/json/i.test(snapshot.contentType)) return null;
  let value: unknown;
  try { value = JSON.parse(snapshot.text) as unknown; } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const job = value as GreenhouseApiJob;
  const title = stringValue(job.title);
  const description = htmlFragmentToText(stringValue(job.content) ?? "");
  if (!title || description.length < 80 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const location = typeof job.location === "string"
    ? job.location
    : job.location && typeof job.location === "object"
      ? stringValue((job.location as Record<string, unknown>).name)
      : undefined;
  const applicationUrl = stringValue(job.absolute_url) ?? snapshot.url;
  const jobId = stringValue(job.id);
  return {
    company: companyFromEvidence(undefined, description, companyFromUrl(applicationUrl)),
    title,
    locations: location ? [location] : [],
    description,
    ...sectionsFromText(description),
    applicationUrl,
    postingUrl: snapshot.url,
    ...(jobId ? { jobId } : {}),
    ...(stringValue(job.updated_at) ? { postingDate: stringValue(job.updated_at) } : {}),
    sourceProvider: "greenhouse",
  };
}

export function isGreenhousePage(url: string): boolean {
  return /(?:greenhouse\.io|greenhouse\.com)/i.test(url);
}

export function extractGreenhouseJob(snapshot: PageSnapshot): RawJob | null {
  if (!isGreenhousePage(snapshot.url)) return null;
  const apiJob = greenhouseApiJob(snapshot);
  if (apiJob) return apiJob;
  const $ = page$(snapshot);
  const title = firstText($, ["h1.app-title", ".job__title h1", "main h1", "h1"]);
  const description = cleanContentText($, ["#content", ".job__description", ".job-post", "main"]);
  if (!title || description.length < 100 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const sections = sectionsFromText(description);
  const titleCompany = /\sat\s+(.+?)\s*$/.exec(snapshot.title)?.[1];
  const logoCompany = $("img[alt*='Logo'], img[alt*='logo']").first().attr("alt")?.replace(/\s+logo$/i, "").trim();
  const companyCandidate = logoCompany
    || firstText($, [".company-name", ".job__company", "#header .logo + span"])
    || titleCompany;
  return {
    company: companyFromEvidence(companyCandidate, description, companyFromUrl(snapshot.url)),
    title,
    locations: texts($, [".location", ".job__location"]),
    description,
    ...sections,
    applicationUrl: findApplyUrl($, snapshot.url) ?? snapshot.url,
    postingUrl: snapshot.url,
    jobId: extractJobId(snapshot.url) ?? undefined,
    sourceProvider: "greenhouse",
  };
}
