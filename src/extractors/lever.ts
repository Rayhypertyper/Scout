import type { PageSnapshot, RawJob } from "../domain/types.js";
import { extractJobId } from "../utils/url.js";
import { cleanContentText, companyFromEvidence, companyFromUrl, findApplyUrl, firstText, htmlFragmentToText, page$, sectionsFromText, texts } from "./helpers.js";

interface LeverApiPosting {
  id?: unknown;
  text?: unknown;
  description?: unknown;
  descriptionPlain?: unknown;
  hostedUrl?: unknown;
  applyUrl?: unknown;
  categories?: Record<string, unknown>;
  createdAt?: unknown;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function leverApiJob(snapshot: PageSnapshot): RawJob | null {
  if (!/json/i.test(snapshot.contentType)) return null;
  let value: unknown;
  try { value = JSON.parse(snapshot.text) as unknown; } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const job = value as LeverApiPosting;
  const title = stringValue(job.text);
  const description = stringValue(job.descriptionPlain) ?? htmlFragmentToText(stringValue(job.description) ?? "");
  if (!title || description.length < 80 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const categories = job.categories;
  const locations = [
    stringValue(categories?.location),
    ...(Array.isArray(categories?.allLocations) ? categories.allLocations.map(stringValue) : []),
  ].filter((value): value is string => Boolean(value));
  const applicationUrl = stringValue(job.applyUrl) ?? stringValue(job.hostedUrl) ?? snapshot.url;
  const jobId = stringValue(job.id);
  return {
    company: companyFromEvidence(undefined, description, companyFromUrl(applicationUrl)),
    title,
    locations,
    description,
    ...sectionsFromText(description),
    applicationUrl,
    postingUrl: stringValue(job.hostedUrl) ?? snapshot.url,
    ...(jobId ? { jobId } : {}),
    ...(stringValue(job.createdAt) ? { postingDate: stringValue(job.createdAt) } : {}),
    sourceProvider: "lever",
  };
}

export function isLeverPage(url: string): boolean {
  return /(?:jobs|api)\.lever\.co/i.test(url);
}

export function extractLeverJob(snapshot: PageSnapshot): RawJob | null {
  if (!isLeverPage(snapshot.url)) return null;
  const apiJob = leverApiJob(snapshot);
  if (apiJob) return apiJob;
  const $ = page$(snapshot);
  const title = firstText($, [".posting-headline h2", "main h1", "h1"]);
  const description = cleanContentText($, [".posting-page", ".content", "main"]);
  if (!title || description.length < 100 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  return {
    company: companyFromEvidence(
      firstText($, [".main-header-logo img[alt]", ".company-name"]),
      description,
      companyFromUrl(snapshot.url),
    ),
    title,
    locations: texts($, [".posting-categories .location", ".posting-categories .sort-by-location", ".location"]),
    description,
    ...sectionsFromText(description),
    applicationUrl: findApplyUrl($, snapshot.url) ?? snapshot.url.replace(/\/$/, "") + "/apply",
    postingUrl: snapshot.url,
    jobId: extractJobId(snapshot.url) ?? undefined,
    sourceProvider: "lever",
  };
}
