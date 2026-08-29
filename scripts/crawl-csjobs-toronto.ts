import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { load } from "cheerio";

const SOURCE_URL = "https://csjobs.ca/internships/toronto";
const OUTPUT_DIRECTORY = process.env.CSJOBS_OUTPUT_DIR ?? "./output/csjobs-toronto";
const PAGE_CACHE_PATH = join(OUTPUT_DIRECTORY, "page-cache.json");
const PAGE_SNAPSHOT_PATH = join(OUTPUT_DIRECTORY, "page-snapshot.json");
const PAGE_CSV_PATH = join(OUTPUT_DIRECTORY, "page-internships.csv");
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_COUNT = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface CachedPage {
  body: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
}

interface InternshipCard {
  id: string | null;
  title: string;
  company: string;
  location: string;
  posted: string;
  url: string;
}

interface PageSnapshot {
  sourceUrl: string;
  retrievedAt: string;
  httpStatus: number;
  notModified: boolean;
  title: string;
  description: string;
  stats: Array<{ value: string; label: string }>;
  internships: InternshipCard[];
  pageText: string;
  stale: boolean;
}

function transientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:aborted due to timeout|timed out|timeout|fetch failed|econnreset|eai_again|socket|network)/i.test(message);
}

function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  return Math.min(5_000, Math.max(retryAfterMs ?? 0, 500 * (2 ** attempt)));
}

async function waitBeforeRetry(attempt: number, retryAfterMs: number | null): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs(attempt, retryAfterMs)));
}

async function readCache(): Promise<CachedPage | null> {
  try {
    return JSON.parse(await readFile(PAGE_CACHE_PATH, "utf8")) as CachedPage;
  } catch {
    return null;
  }
}

async function fetchPage(): Promise<{ html: string; status: number; notModified: boolean; stale: boolean }> {
  const cached = await readCache();
  const headers = new Headers({
    accept: "text/html,application/xhtml+xml",
    "user-agent": "Internshipmatic/1.0 (+respectful job discovery crawler)",
  });
  if (cached?.etag) headers.set("if-none-match", cached.etag);
  if (cached?.lastModified) headers.set("if-modified-since", cached.lastModified);

  let lastError: unknown = new Error("CSJobs request failed.");
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(SOURCE_URL, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 304 && cached) return { html: cached.body, status: 304, notModified: true, stale: false };
      if (!response.ok) {
        const error = new Error(`CSJobs returned HTTP ${response.status}`);
        lastError = error;
        if (cached && attempt >= 1 && RETRYABLE_STATUS_CODES.has(response.status)) {
          return { html: cached.body, status: 200, notModified: false, stale: true };
        }
        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= RETRY_COUNT) throw error;
        await waitBeforeRetry(attempt, Number(response.headers.get("retry-after")) * 1_000 || null);
        continue;
      }

      const body = await response.text();
      await writeFile(PAGE_CACHE_PATH, JSON.stringify({
        body,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        fetchedAt: new Date().toISOString(),
      } satisfies CachedPage));
      return { html: body, status: response.status, notModified: false, stale: false };
    } catch (error) {
      lastError = error;
      if (cached && attempt >= 1 && transientError(error)) {
        return { html: cached.body, status: 200, notModified: false, stale: true };
      }
      if (attempt >= RETRY_COUNT || !transientError(error)) throw error;
      await waitBeforeRetry(attempt, null);
    }
  }
  throw lastError;
}

function extractCards(html: string): { title: string; description: string; stats: Array<{ value: string; label: string }>; internships: InternshipCard[]; pageText: string } {
  const $ = load(html);
  const heading = $("h2").filter((_index, element) => /internships\s*&\s*co-ops/i.test($(element).text())).first();
  if (heading.length === 0) throw new Error("CSJobs internship heading was not found; refusing to treat a changed page as complete.");
  const grid = heading.nextAll(".live-grid").first();
  if (grid.length === 0) throw new Error("CSJobs internship grid was not found; refusing to treat a changed page as complete.");

  const internships: InternshipCard[] = [];
  grid.find("a.live-card[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const titleNode = $(element).find(".live-card-title").clone();
    titleNode.find(".company-avatar").remove();
    const title = titleNode.text().trim();
    const meta = $(element).find(".live-card-meta").text().split("·").map((part) => part.trim());
    const id = new URL(href, SOURCE_URL).pathname.match(/^\/jobs\/(\d+)/)?.[1] ?? null;
    internships.push({
      id,
      title,
      company: meta[0] ?? "",
      location: meta[1] ?? "",
      posted: meta[2] ?? "",
      url: new URL(href, SOURCE_URL).href,
    });
  });
  if (internships.length === 0) throw new Error("CSJobs internship grid contained no cards; refusing to report an empty crawl as complete.");

  const body = $("body").clone();
  body.find("script,style,noscript,template").remove();
  body.find("br").replaceWith("\n");
  const pageText = body.text().replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const stats = $(".stat").map((_index, element) => ({
    value: $(element).find(".stat-val").text().trim(),
    label: $(element).find(".stat-label").text().trim(),
  })).get();
  return {
    title: $("title").first().text().trim(),
    description: $("meta[name='description']").attr("content")?.trim() ?? "",
    stats,
    internships,
    pageText,
  };
}

function csvCell(value: string | null): string {
  const normalized = value ?? "";
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const fetched = await fetchPage();
  const parsed = extractCards(fetched.html);
  const retrievedAt = new Date().toISOString();
  const snapshot: PageSnapshot = {
    sourceUrl: SOURCE_URL,
    retrievedAt,
    httpStatus: fetched.status,
    notModified: fetched.notModified,
    stale: fetched.stale,
    ...parsed,
  };
  await writeFile(PAGE_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  const rows = [
    ["id", "title", "company", "location", "posted", "url"],
    ...parsed.internships.map((internship) => [internship.id, internship.title, internship.company, internship.location, internship.posted, internship.url]),
  ];
  await writeFile(PAGE_CSV_PATH, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`);
  console.log(`Retrieved ${parsed.internships.length} Toronto internship/co-op cards from ${SOURCE_URL}`);
  console.log(`Page snapshot: ${PAGE_SNAPSHOT_PATH}`);
  console.log(`Card CSV: ${PAGE_CSV_PATH}`);
}

main().catch((error: unknown) => {
  console.error(`[FATAL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
