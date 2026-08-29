import type { PageSnapshot, RawJob } from "../domain/types.js";
import { extractJobId } from "../utils/url.js";
import { cleanContentText, companyFromEvidence, companyFromUrl, findApplyUrl, firstText, page$, sectionsFromText, texts } from "./helpers.js";

export function isAshbyPage(url: string): boolean {
  return /ashbyhq\.com/i.test(url);
}

export function extractAshbyJob(snapshot: PageSnapshot): RawJob | null {
  if (!isAshbyPage(snapshot.url)) return null;
  const $ = page$(snapshot);
  const title = firstText($, ["[data-testid='job-title']", "main h1", "h1"]);
  const description = cleanContentText($, ["[data-testid='job-description']", "main", "article"]);
  if (!title || description.length < 100 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const titleCompany = /\sat\s+(.+?)\s*$/.exec(snapshot.title)?.[1];
  const logoCompany = $("img[alt*='Logo'], img[alt*='logo']").first().attr("alt")?.replace(/\s+logo$/i, "").trim();
  const companyCandidate = firstText($, ["[data-testid='company-name']", ".company-name"]) || logoCompany || titleCompany;
  return {
    company: companyFromEvidence(companyCandidate, description, companyFromUrl(snapshot.url)),
    title,
    locations: texts($, ["[data-testid='job-location']", "[class*='location']"]),
    description,
    ...sectionsFromText(description),
    applicationUrl: findApplyUrl($, snapshot.url) ?? snapshot.url.replace(/\/$/, "") + "/application",
    postingUrl: snapshot.url,
    jobId: extractJobId(snapshot.url) ?? undefined,
    sourceProvider: "ashby",
  };
}
