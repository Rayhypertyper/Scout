import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveSettings } from "../src/config/settings.js";
import { BrowserManager } from "../src/crawler/browser.js";
import { InternListAdapter, internListCategory, internListFeeds } from "../src/crawler/adapters/internList.js";
import { HttpClient } from "../src/crawler/http.js";
import { extractJobrightJobs } from "../src/extractors/jobright.js";
import { canonicalizeUrl, isAggregatorUrl } from "../src/utils/url.js";
import { Logger } from "../src/utils/logger.js";

const sourceUrl = process.argv[2] ?? "https://www.intern-list.com/?k=swe";
const category = internListCategory(sourceUrl);
if (!category) throw new Error(`Unsupported Intern List URL: ${sourceUrl}`);
const feeds = internListFeeds(sourceUrl);

const defaultOutputDirectory = resolve("output/intern-list-crawl");
const outputPath = resolve(process.argv[3] ?? join(defaultOutputDirectory, `${category.replaceAll(":", "-")}.json`));
const outputDirectory = dirname(outputPath);
const settings = resolveSettings({
  outputDirectory,
  databasePath: join(outputDirectory, "crawl.db"),
  httpConcurrency: 8,
  browserConcurrency: 1,
  perDomainConcurrency: 2,
  perHostDelayMs: 100,
  retryCount: 2,
  cacheTtlMs: 21_600_000,
});
const logger = new Logger("error");
const http = new HttpClient(settings, logger);
const adapter = new InternListAdapter(http, logger);
const startedAt = Date.now();
let pageContext: Record<string, unknown> = {
  url: sourceUrl,
  embeddedFeedUrl: feeds[0]?.embeddedUrl ?? "",
  embeddedFeedUrls: feeds.map(({ embeddedUrl }) => embeddedUrl),
  category,
  feeds: feeds.map(({ category: feedCategory, country, label, embeddedUrl }) => ({ category: feedCategory, country, label, embeddedUrl })),
};
try {
  const parent = await http.get(sourceUrl, { cache: true });
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(parent.body)?.[1]?.replace(/\s+/gu, " ").trim() ?? "";
  const headings = [...parent.body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => match[1]?.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim() ?? "")
    .filter(Boolean);
  const iframeUrls = [...parent.body.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1]).filter(Boolean);
  const visibleText = parent.body
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  pageContext = { ...pageContext, status: parent.status, title, headings, iframeUrls, text: visibleText };
} catch (error) {
  pageContext = { ...pageContext, error: error instanceof Error ? error.message : String(error) };
}
const collected = await adapter.collect(sourceUrl);
const jobs = collected.snapshots.flatMap((snapshot) => extractJobrightJobs(snapshot));
const uniqueJobs = [...new Map(jobs.filter((job) => job.jobId).map((job) => [job.jobId as string, job])).values()];
const browser = new BrowserManager(settings, logger);
const resolvedJobs = [];
try {
  for (const job of uniqueJobs) {
    const fallback = canonicalizeUrl(job.applicationUrl ?? job.postingUrl, job.postingUrl);
    let resolved: string | null = null;
    try {
      const originalPost = await browser.resolveOriginalJobPostUrl(job.postingUrl, sourceUrl);
      resolved = originalPost ? canonicalizeUrl(originalPost, fallback) : null;
    } catch (error) {
      logger.warn("ORIGINAL", `Could not resolve Jobright Original job post for ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resolved || isAggregatorUrl(resolved)) {
      logger.warn("ORIGINAL", `Skipped Jobright listing ${job.jobId}: no employer/ATS Original job post was resolved.`);
      continue;
    }
    resolvedJobs.push({ ...job, applicationUrl: resolved, postingUrl: resolved });
  }
} finally {
  await browser.close();
}
const pages = collected.snapshots.map((snapshot) => {
  try {
    return { url: snapshot.url, payload: JSON.parse(snapshot.text) as unknown };
  } catch {
    return { url: snapshot.url, payload: null };
  }
});
const feedCoverage = feeds.map((feed) => {
  const feedPages = pages.filter((page) => {
    try {
      return new URL(page.url).searchParams.get("feedCategory") === feed.category;
    } catch {
      return false;
    }
  });
  const feedJobs = feedPages.flatMap((page) => page.payload ? extractJobrightJobs({
    ...page,
    requestedUrl: page.url,
    url: page.url,
    status: 200,
    contentType: "application/json",
    title: "",
    html: "",
    text: JSON.stringify(page.payload),
    links: [],
    fetchedAt: new Date().toISOString(),
  }) : []);
  const expectedTotal = feedPages.map((page) => {
    const result = page.payload && typeof page.payload === "object" ? (page.payload as { result?: unknown }).result : null;
    return result && typeof result === "object" && typeof (result as { total?: unknown }).total === "number"
      ? (result as { total: number }).total
      : null;
  }).find((value): value is number => value !== null) ?? null;
  const uniqueIds = new Set(feedJobs.map((job) => job.jobId).filter((jobId): jobId is string => Boolean(jobId)));
  return {
    category: feed.category,
    country: feed.country,
    label: feed.label,
    embeddedUrl: feed.embeddedUrl,
    expectedTotal,
    retrievedRows: feedJobs.length,
    uniqueJobIds: uniqueIds.size,
    complete: expectedTotal !== null && uniqueIds.size > 0 && (uniqueIds.size >= expectedTotal || feedJobs.length >= expectedTotal),
  };
});
const expectedTotal = feedCoverage.every(({ expectedTotal: value }) => value !== null)
  ? feedCoverage.reduce((sum, { expectedTotal: value }) => sum + (value ?? 0), 0)
  : null;
const artifact = {
  sourceUrl,
  category,
  pageContext,
  fetchedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  expectedTotal,
  retrievedRows: jobs.length,
  uniqueJobIds: uniqueJobs.length,
  complete: collected.failures.length === 0 && feedCoverage.length > 0 && feedCoverage.every(({ complete }) => complete),
  feedCoverage,
  retrievalMethod: collected.retrievalMethod,
  retrievalUrls: collected.retrievalUrls,
  notes: collected.notes,
  failures: collected.failures,
  pages,
  internships: resolvedJobs,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, category, expectedTotal, retrievedRows: jobs.length, uniqueJobIds: uniqueJobs.length, complete: artifact.complete, feedCoverage, durationMs: artifact.durationMs, pages: pages.length }, null, 2));
if (!artifact.complete) process.exitCode = 1;
