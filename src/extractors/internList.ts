import { load } from "cheerio";
import type { PageSnapshot, RawJob } from "../domain/types.js";
import { safeCanonicalizeUrl } from "../utils/url.js";
import { extractGenericJobs } from "./generic.js";
import { extractJobrightJobRecords } from "./jobright.js";

export interface InternListTabPage {
  total: number;
  jobs: RawJob[];
  rowCount: number;
}

/** Only read the public SSR payload; executing the embed would call the dead API. */
export function parseInternListTab(html: string, category: string): InternListTabPage | null {
  try {
    const $ = load(html);
    const payload = JSON.parse($("script#__NEXT_DATA__").text()) as {
      props?: { pageProps?: { initialJobs?: unknown; initialTotal?: unknown; initialActiveTab?: unknown } };
    };
    const props = payload.props?.pageProps;
    if (!props || props.initialActiveTab !== category || !Number.isSafeInteger(props.initialTotal)
      || Number(props.initialTotal) < 0 || !Array.isArray(props.initialJobs)
      || props.initialJobs.length > Number(props.initialTotal)) return null;
    const jobs = props.initialJobs.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(row.id)) return [];
      return extractJobrightJobRecords({ result: { jobList: [{
        jobId: row.id, tabCategory: category, properties: row, postedAt: row.postedDate,
      }] } }).map((job) => ({ ...job, sourceProvider: "intern-list-public-tab" }));
    });
    return { total: Number(props.initialTotal), rowCount: props.initialJobs.length, jobs };
  } catch { return null; }
}

export function parseInternListDetail(html: string, url: string): { job: RawJob | null; closed: boolean; incompleteJob?: RawJob } {
  const $ = load(html);
  $(".w-condition-invisible, [hidden], [aria-hidden='true']").remove();
  $("[style]").each((_index, element) => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/iu.test($(element).attr("style") ?? "")) $(element).remove();
  });
  const closed = /\bthis job has closed\b/iu.test($("body").text());
  const snapshot: PageSnapshot = {
    requestedUrl: url, url, status: 200, contentType: "text/html", title: $("title").text(),
    html: $.html(), text: $("body").text(), links: [], fetchedAt: new Date().toISOString(),
  };
  const job = extractGenericJobs(snapshot).find((candidate) => candidate.sourceProvider === "json-ld") ?? null;
  if (!job) {
    // The data-science CMS template currently renders h1="Heading" and
    // Apply href="#". Save its real content without inventing either field
    // or passing an unusable application link into the publication pipeline.
    const company = $(".text-block-66").first().text().trim();
    const summary = $(".rich-text-block-20").first().text().trim();
    if (!new URL(url).pathname.startsWith("/data-science-internships/") || !company || !summary) return { job: null, closed };
    const values = (label: string): string[] => {
      const heading = $("h2,h3").toArray().find((element) => $(element).text().trim().toLowerCase() === label);
      return heading ? $(heading).nextUntil("h2,h3").first().find("li").toArray().map((element) => $(element).text().trim()).filter(Boolean) : [];
    };
    const responsibilities = values("responsibilities");
    const requiredQualifications = values("required");
    const preferredQualifications = values("preferred");
    const benefits = values("benefits");
    return { job: null, closed, incompleteJob: {
      company, postingUrl: url, locations: [$(".text-block-47").first().text().trim()].filter(Boolean),
      postingDate: $(".text-block-65").toArray().map((element) => $(element).text().trim()).find((text) => Number.isFinite(Date.parse(text))),
      description: [summary, "Responsibilities", ...responsibilities, "Required", ...requiredQualifications, "Preferred", ...preferredQualifications, "Benefits", ...benefits,
        "Source limitation: the page displays a placeholder title and its Apply links point to #."].join("\n"),
      responsibilities, requiredQualifications, preferredQualifications, sourceProvider: "intern-list-incomplete-html",
    } };
  }
  const applyHref = $("a[href]").toArray().find((element) => /^(?:apply now|apply(?: to)?(?: this)? job)$/iu.test($(element).text().trim()));
  const applicationUrl = applyHref ? safeCanonicalizeUrl($(applyHref).attr("href") ?? "", url) : null;
  const section = (labels: string[]): string[] | undefined => {
    const heading = $("h2,h3").toArray().find((element) => labels.includes($(element).text().trim().toLowerCase()));
    if (!heading) return undefined;
    return $(heading).nextUntil("h2,h3").first().find("li").toArray().map((element) => $(element).text().trim()).filter((text) => text && !/^none$/iu.test(text));
  };
  // Parse source section boundaries explicitly: Benefits and Company Overview
  // must not become qualifications merely because they follow the Skills list.
  let descriptionHtml = "";
  $("script[type='application/ld+json']").each((_index, element) => {
    try {
      const value = JSON.parse($(element).text()) as { description?: unknown };
      if (typeof value.description === "string") descriptionHtml = value.description;
    } catch { /* Generic extraction already validates the JobPosting. */ }
  });
  const description$ = load(descriptionHtml);
  const structuredSection = (labels: string[]): string[] => {
    const heading = description$("p,h2,h3").toArray().find((element) => labels.includes(description$(element).text().trim().toLowerCase()));
    return heading ? description$(heading).nextUntil("p,h2,h3").find("li").toArray().map((element) => description$(element).text().trim()).filter(Boolean) : [];
  };
  // The CMS repeats datePosted in validThrough, even for new open roles.
  const deadline = job.deadline && Date.parse(job.deadline) !== Date.parse(job.postingDate ?? "") ? job.deadline : undefined;
  return { closed, job: {
    ...job, postingUrl: url, applicationUrl: applicationUrl ?? job.applicationUrl ?? url,
    responsibilities: section(["responsibilities"]) ?? structuredSection(["responsibilities"]),
    requiredQualifications: section(["required"]) ?? structuredSection(["skills", "required", "qualifications"]),
    preferredQualifications: section(["preferred"]) ?? structuredSection(["preferred"]),
    deadline, sourceProvider: "intern-list-html",
  } };
}

/** Compact transport between the HTTP inventory adapter and the existing pipeline. */
export function internListInventorySnapshot(url: string, jobs: RawJob[]): PageSnapshot {
  return {
    requestedUrl: url, url, status: 200, contentType: "application/json", title: "Intern List public inventory",
    html: JSON.stringify({ internListPublicInventory: 1, jobs }),
    text: `Intern List: ${jobs.length} public internship records.`, links: [], fetchedAt: new Date().toISOString(),
  };
}

export function extractInternListJobs(snapshot: PageSnapshot): RawJob[] | null {
  if (snapshot.contentType !== "application/json" || !snapshot.html.startsWith('{"internListPublicInventory":1,')) return null;
  try {
    const payload = JSON.parse(snapshot.html) as { jobs: RawJob[] };
    return payload.jobs;
  } catch { return []; }
}
