import { load } from "cheerio";

import type { LinkCandidate, PageSnapshot, RawJob } from "../domain/types.js";
import { decodeHtmlEntities, oneLine, uniqueStrings } from "../utils/text.js";
import { extractJobId, safeCanonicalizeUrl } from "../utils/url.js";
import {
  cleanContentText,
  companyFromEvidence,
  companyFromUrl,
  findApplyUrl,
  firstText,
  htmlFragmentToText,
  page$,
  sectionsFromText,
  texts,
} from "./helpers.js";

interface MarkdownColumn {
  name: string;
  index: number;
}

interface NextDataJob {
  id?: unknown;
  requisition_id?: unknown;
  apply_url?: unknown;
  job_information?: Record<string, unknown>;
  v5_processed_job_data?: Record<string, unknown>;
  enriched_company_data?: Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstString(object: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(object?.[key]);
    if (value) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (typeof item === "object" && item !== null) {
      const object = item as Record<string, unknown>;
      return [firstString(object, ["name", "label", "formatted", "location", "city"]) ?? ""];
    }
    return [];
  }).filter(Boolean);
}

function markdownCellLinks(value: string): string[] {
  const links: string[] = [];
  // Remove image syntax before parsing links. GitHub lists commonly wrap an
  // Apply badge in a Markdown link: [![Apply](badge)](real-job-url). Without
  // this, the inner badge URL is encountered first and becomes the fake
  // application destination.
  const withoutImages = value
    .replace(/!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)\s*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "");
  const markdown = /\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))\s*\)/g;
  for (const match of withoutImages.matchAll(markdown)) {
    const candidate = match[1] ?? match[2];
    if (candidate) links.push(candidate);
  }
  const htmlAnchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of withoutImages.matchAll(htmlAnchor)) {
    const candidate = match[1];
    if (candidate) links.push(candidate);
  }
  for (const match of withoutImages.matchAll(/https?:\/\/[^\s<>|)]+/gi)) links.push(match[0]);
  return uniqueStrings(links.map((link) => link.replace(/[.,;]+$/, "")));
}

function markdownCellText(value: string): string {
  return oneLine(decodeHtmlEntities(value)
    .replace(/<!--[^>]*-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/<[^>]+>/g, " "));
}

function splitMarkdownRow(line: string): string[] {
  let value = line.trim();
  if (!value.startsWith("|")) return [];
  if (value.endsWith("|")) value = value.slice(0, -1);
  value = value.slice(1);
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function isMarkdownSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isClosedMarkdownRow(row: string[], applyIndex: number): boolean {
  if (applyIndex < 0) return false;
  return /\bclosed\b/i.test(markdownCellText(row[applyIndex] ?? ""));
}

function columnIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function headerName(value: string): string {
  return markdownCellText(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function markdownTableColumns(headers: string[]): MarkdownColumn[] {
  return headers.map((header, index) => ({ name: headerName(header), index }));
}

function cellAt(row: string[], index: number): string {
  return index >= 0 ? markdownCellText(row[index] ?? "") : "";
}

function firstMarkdownUrl(values: string[], sourceUrl: string, excludedUrls: ReadonlySet<string> = new Set()): string | null {
  return values
    .flatMap(markdownCellLinks)
    .map((link) => safeCanonicalizeUrl(link, sourceUrl))
    .find((link): link is string => link !== null && !excludedUrls.has(link)) ?? null;
}

function extractMarkdownTableJobs(markdown: string, sourceUrl: string): RawJob[] {
  const jobs: RawJob[] = [];
  const lines = markdown.split(/\r?\n/);
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const heading = /^(?:#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      section = markdownCellText(heading[1] ?? "");
      continue;
    }
    const headers = splitMarkdownRow(line);
    const separator = splitMarkdownRow(lines[index + 1] ?? "");
    if (headers.length < 3 || !isMarkdownSeparator(separator)) continue;

    const columns = markdownTableColumns(headers);
    const headerNames = columns.map(({ name }) => name);
    const companyIndex = columnIndex(headerNames, [/^company$/, /employer/, /organization/]);
    const titleIndex = columnIndex(headerNames, [/^title$/, /^position$/, /^role$/, /^job(?: title)?$/]);
    const locationIndex = columnIndex(headerNames, [/location/, /city/]);
    const applyIndex = columnIndex(headerNames, [/apply/, /application/, /posting/, /^link$/, /url/]);
    const dateIndex = columnIndex(headerNames, [/date/, /posted/, /age/]);
    if (companyIndex < 0 || titleIndex < 0) continue;

    let previousCompany = "";
    for (index += 2; index < lines.length; index += 1) {
      const row = splitMarkdownRow(lines[index] ?? "");
      if (row.length < 2) break;
      if (isMarkdownSeparator(row)) continue;
      if (row.length < Math.max(companyIndex, titleIndex) + 1) continue;
      const title = cellAt(row, titleIndex);
      const listedCompany = cellAt(row, companyIndex);
      const company = /^↳$/.test(listedCompany) ? previousCompany : listedCompany;
      if (!title || !company || /^(?:title|position|role|company)$/i.test(title)) continue;
      // A closed marker is not an application destination. Do not turn the
      // source README into a false direct-apply link for a role that the
      // publishing list explicitly says is no longer accepting applications.
      if (isClosedMarkdownRow(row, applyIndex)) continue;
      previousCompany = company;
      const location = cellAt(row, locationIndex);
      // A company cell commonly links to a shared employer landing page while
      // the title cell links to the actual requisition. The shared page must
      // never become this row's identity, otherwise every role for that
      // employer can be merged into one listing.
      const companyUrls = new Set(
        (companyIndex >= 0 ? markdownCellLinks(row[companyIndex] ?? "") : [])
          .map((link) => safeCanonicalizeUrl(link, sourceUrl))
          .filter((link): link is string => Boolean(link)),
      );
      const applyUrl = firstMarkdownUrl(
        applyIndex >= 0 ? [row[applyIndex] ?? ""] : [],
        sourceUrl,
        companyUrls,
      );
      const titleUrl = firstMarkdownUrl(
        titleIndex >= 0 ? [row[titleIndex] ?? ""] : [],
        sourceUrl,
        companyUrls,
      );
      const otherRowUrl = firstMarkdownUrl(
        row.filter((_cell, cellIndex) => ![companyIndex, titleIndex, applyIndex].includes(cellIndex)),
        sourceUrl,
        companyUrls,
      );
      const postingUrl = titleUrl ?? applyUrl ?? otherRowUrl ?? sourceUrl;
      const applicationUrl = applyUrl ?? titleUrl ?? otherRowUrl;
      const metadata = columns
        .filter(({ index: column }) => ![companyIndex, titleIndex, locationIndex, applyIndex].includes(column))
        .map(({ index: column }) => cellAt(row, column))
        .filter(Boolean);
      const roleDetails = [
        `Role: ${title}.`,
        `Company: ${company}.`,
        location ? `Location: ${location}.` : "",
        section ? `List section: ${section}.` : "",
        ...metadata,
      ].filter(Boolean).join(" ");
      const identifier = /<!--\s*id:\s*([^>]+?)\s*-->/i.exec(lines[index] ?? "")?.[1]?.trim();
      jobs.push({
        company,
        title,
        locations: location ? [location] : [],
        description: roleDetails,
        ...(applicationUrl ? { applicationUrl } : {}),
        postingUrl,
        ...(identifier ? { jobId: identifier } : {}),
        ...(dateIndex >= 0 && cellAt(row, dateIndex) ? { postingDate: cellAt(row, dateIndex) } : {}),
        sourceProvider: "github-markdown",
      });
    }
  }
  return jobs;
}

function nextData(snapshot: PageSnapshot): Record<string, unknown> | null {
  const $ = page$(snapshot);
  const value = $("script#__NEXT_DATA__").first().text().trim();
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function nextDataJob(snapshot: PageSnapshot): NextDataJob | null {
  const payload = nextData(snapshot);
  const props = payload?.props;
  const pageProps = typeof props === "object" && props !== null ? (props as Record<string, unknown>).pageProps : null;
  const job = typeof pageProps === "object" && pageProps !== null ? (pageProps as Record<string, unknown>).job : null;
  return typeof job === "object" && job !== null ? job : null;
}

function hiringCafeJob(snapshot: PageSnapshot): RawJob | null {
  const job = nextDataJob(snapshot);
  if (!job) return null;
  const info = job.job_information;
  const processed = job.v5_processed_job_data;
  const companyData = job.enriched_company_data;
  const title = firstString(info, ["title", "job_title"]) ?? firstString(processed, ["title", "job_title", "role_title"]);
  if (!title) return null;
  const description = htmlFragmentToText(firstString(info, ["description", "job_description"]) ?? "");
  const extraDescription = [
    firstString(processed, ["requirements_summary", "summary", "role_summary"]),
    ...stringArray(processed?.technical_tools).map((value) => `Technical tools: ${value}`),
    ...stringArray(processed?.role_activities).map((value) => `Role activity: ${value}`),
  ].filter(Boolean).join("\n");
  const fullDescription = [description, extraDescription].filter(Boolean).join("\n\n");
  if (fullDescription.length < 80) return null;
  const company = firstString(companyData, ["name", "company_name"])
    ?? firstString(info, ["company_name", "company"])
    ?? companyFromUrl(snapshot.url);
  const locations = uniqueStrings([
    ...stringArray(processed?.workplace_locations),
    ...stringArray(processed?.locations),
    firstString(processed, ["formatted_workplace_location", "workplace_location"]),
    firstString(info, ["location", "locations"]),
  ].filter((value): value is string => Boolean(value)));
  const sections = sectionsFromText(fullDescription);
  const applicationUrl = safeCanonicalizeUrl(stringValue(job.apply_url) ?? snapshot.url, snapshot.url) ?? snapshot.url;
  const jobId = stringValue(job.id) ?? stringValue(job.requisition_id);
  return {
    company: companyFromEvidence(company, fullDescription, companyFromUrl(applicationUrl)),
    title,
    locations,
    description: fullDescription,
    ...sections,
    applicationUrl,
    postingUrl: snapshot.url,
    ...(jobId ? { jobId } : {}),
    salary: firstString(processed, ["compensation", "salary", "estimated_salary"]),
    postingDate: firstString(processed, ["estimated_publish_date", "publish_date", "date_posted"])
      ?? firstString(info, ["date_posted", "posted_at"]),
    sourceProvider: "hiringcafe",
  };
}

function applyBoltJob(snapshot: PageSnapshot): RawJob | null {
  const $ = page$(snapshot);
  const title = firstText($, [".job-title", "main h1", "h1"]);
  const company = firstText($, [".job-company-name", "[data-testid='company-name']"]);
  const description = cleanContentText($, [".job-description", "main", "article"]);
  if (!title || !company || description.length < 80) return null;
  const location = firstText($, [".job-company-location", ".job-facts-row:contains('Location') .job-facts-value"]);
  const applicationUrl = safeCanonicalizeUrl(
    $("a.job-seo-applylink").first().attr("href") ?? findApplyUrl($, snapshot.url) ?? snapshot.url,
    snapshot.url,
  ) ?? snapshot.url;
  const postingDate = firstText($, [
    ".job-facts-row:contains('Posted') .job-facts-value",
    "[data-testid='job-posted']",
  ]) || /\bPosted\s+([^\n]+)/i.exec(snapshot.text)?.[1]?.trim();
  const sections = sectionsFromText(description);
  return {
    company: companyFromEvidence(company, description, companyFromUrl(applicationUrl)),
    title,
    locations: location ? [location] : [],
    description,
    ...sections,
    applicationUrl,
    postingUrl: snapshot.url,
    ...(extractJobId(snapshot.url) ? { jobId: extractJobId(snapshot.url) ?? undefined } : {}),
    ...(postingDate ? { postingDate } : {}),
    sourceProvider: "applybolt",
  };
}

function wellfoundJob(snapshot: PageSnapshot): RawJob | null {
  const url = new URL(snapshot.url);
  if (!/^\/jobs\/[^/]+/i.test(url.pathname)) return null;
  const $ = page$(snapshot);
  const title = firstText($, ["main h1", "h1"]);
  const description = cleanContentText($, ["main", "article"]);
  if (!title || description.length < 80) return null;
  const company = texts($, ["a[href^='/company/']"]).find(Boolean)
    ?? companyFromUrl(snapshot.url);
  const locations = texts($, ["a[href^='/location/']", "[data-testid='job-location']"]);
  const salary = /\$[\d,.]+(?:\s*[kKmM])?(?:\s*[–—-]\s*\$?[\d,.]+(?:\s*[kKmM])?)?(?:\s*CAD)?/i.exec(snapshot.text)?.[0];
  const postingDate = /\bPosted:\s*([^•\n]+)/i.exec(snapshot.text)?.[1]?.trim();
  const sections = sectionsFromText(description);
  const applicationUrl = findApplyUrl($, snapshot.url) ?? snapshot.url;
  return {
    company: companyFromEvidence(company, description, companyFromUrl(snapshot.url)),
    title,
    locations,
    description,
    ...sections,
    applicationUrl,
    postingUrl: snapshot.url,
    ...(extractJobId(snapshot.url) ? { jobId: extractJobId(snapshot.url) ?? undefined } : {}),
    ...(salary ? { salary } : {}),
    ...(postingDate ? { postingDate } : {}),
    sourceProvider: "wellfound",
  };
}

export function extractPublicBoardJobs(snapshot: PageSnapshot): RawJob[] {
  const host = new URL(snapshot.url).hostname.replace(/^www\./i, "");
  if (host === "raw.githubusercontent.com") {
    const markdown = snapshot.text.trim() || load(snapshot.html).root().text().trim();
    return extractMarkdownTableJobs(markdown, snapshot.url);
  }
  if (host === "hiringcafe.com") {
    const job = hiringCafeJob(snapshot);
    return job ? [job] : [];
  }
  if (host === "applybolt.app") {
    const job = applyBoltJob(snapshot);
    return job ? [job] : [];
  }
  if (host === "wellfound.com") {
    const job = wellfoundJob(snapshot);
    return job ? [job] : [];
  }
  return [];
}

export function discoverPublicBoardLinks(snapshot: PageSnapshot): LinkCandidate[] {
  const host = new URL(snapshot.url).hostname.replace(/^www\./i, "");
  if (host !== "csjobs.ca") return [];
  const $ = page$(snapshot);
  const links: LinkCandidate[] = [];
  $("[data-job-id]").each((_index, element) => {
    const id = $(element).attr("data-job-id")?.trim();
    if (!id || !/^\d+$/.test(id)) return;
    links.push({
      url: safeCanonicalizeUrl(`/jobs/${id}`, snapshot.url) ?? `${new URL(snapshot.url).origin}/jobs/${id}`,
      text: `CSJobs job ${id}`,
      rel: "derived-job-detail",
    });
  });
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}
