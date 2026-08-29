import type { PageSnapshot, RawJob } from "../domain/types.js";
import { extractJobId } from "../utils/url.js";
import { cleanContentText, companyFromEvidence, companyFromUrl, findApplyUrl, firstText, page$, sectionsFromText, texts } from "./helpers.js";

export function isWorkdayPage(url: string): boolean {
  return /myworkdayjobs\.com/i.test(url);
}

export function extractWorkdayJob(snapshot: PageSnapshot): RawJob | null {
  if (!isWorkdayPage(snapshot.url)) return null;
  const $ = page$(snapshot);
  const title = firstText($, ["[data-automation-id='jobPostingHeader'] h2", "[data-automation-id='jobPostingHeader']", "main h1", "h1"]);
  const description = cleanContentText($, ["[data-automation-id='jobPostingDescription']", "main", "[role='main']"]);
  if (!title || description.length < 100 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const metadataCompany = $("meta[property='og:site_name']").attr("content")?.trim()
    || $("header img[alt], [data-automation-id='navigation'] img[alt]").first().attr("alt")?.trim()
    || "";
  const selectedCompany = firstText($, ["[data-automation-id='company']", "[data-automation-id='jobPostingCompany']"])
    || metadataCompany;
  return {
    company: companyFromEvidence(selectedCompany, description, companyFromUrl(snapshot.url)),
    title,
    locations: texts($, ["[data-automation-id='locations']", "[data-automation-id='location']"]),
    description,
    ...sectionsFromText(description),
    applicationUrl: findApplyUrl($, snapshot.url) ?? snapshot.url,
    postingUrl: snapshot.url,
    jobId: extractJobId(snapshot.url) ?? undefined,
    postingDate: firstText($, ["[data-automation-id='postedOn']"]) || undefined,
    sourceProvider: "workday",
  };
}
