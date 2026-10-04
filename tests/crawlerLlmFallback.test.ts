import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeRawJob } from "../src/classification/analyzeJob.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { resolveSettings } from "../src/config/settings.js";
import { runWithSourceAbortSignal, SourceStalledError } from "../src/domain/cancellation.js";
import type { PageSnapshot, RawJob } from "../src/domain/types.js";
import { extractJobs } from "../src/extractors/index.js";
import { sha256 } from "../src/utils/hash.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

function snapshot(status = 200, textSuffix = "", unsupportedLayout = false): PageSnapshot {
  const url = "https://careers.harbor.example/jobs/role-123";
  const description = [
    "Responsibilities",
    "Build and test TypeScript services used by customers.",
    "Work with engineers to debug APIs and ship production features.",
    "Qualifications",
    "Pursuing a Computer Science degree with experience in TypeScript.",
  ].join("\n");
  const text = [
    "Software Engineering Intern",
    "Harbor Cloud",
    "Toronto, Ontario, Canada",
    description,
    "Placement term: Summer 2027",
    "Pay: $42 per hour",
    textSuffix,
  ].filter(Boolean).join("\n");
  const detailMarkup = `<h2>Responsibilities</h2>
      <p>Build and test TypeScript services used by customers.</p>
      <p>Work with engineers to debug APIs and ship production features.</p>
      <h2>Qualifications</h2>
      <p>Pursuing a Computer Science degree with experience in TypeScript.</p>`;
  const html = unsupportedLayout ? `<div id="custom-career-page">
    <h1>Software Engineering Intern</h1>
    <div class="company-name">Harbor Cloud</div>
    <div class="job-location">Toronto, Ontario, Canada</div>
    <div id="role-copy">${detailMarkup}</div>
    <aside>Placement term: Summer 2027<br>Pay: $42 per hour</aside>
  </div>` : `<main>
    <h1>Software Engineering Intern</h1>
    <div class="company-name">Harbor Cloud</div>
    <div class="job-location">Toronto, Ontario, Canada</div>
    <div class="job-description">${detailMarkup}</div>
    <aside>Placement term: Summer 2027<br>Pay: $42 per hour</aside>
  </main>`;
  return {
    requestedUrl: url,
    url,
    status,
    contentType: "text/html; charset=utf-8",
    title: "Software Engineering Intern | Harbor Cloud",
    html,
    text,
    links: [],
    fetchedAt: "2026-10-01T12:00:00.000Z",
  };
}

function evidenceFor(page: PageSnapshot, field: string, value: string, quote: string) {
  const start = page.text.indexOf(quote);
  if (start < 0) throw new Error(`Fixture is missing evidence quote: ${quote}`);
  return {
    field,
    value,
    provider: "openai" as const,
    model: "gpt-6-luna",
    pageUrl: page.url,
    contentHash: sha256(page.text),
    quote,
    start,
    end: start + quote.length,
  };
}

function makeCrawler(
  recover: (page: PageSnapshot, jobs: RawJob[], sourceUrl: string, signal?: AbortSignal) => Promise<RawJob[]>,
  respectRobotsTxt = false,
) {
  const directory = mkdtempSync(join(tmpdir(), "scout-llm-crawler-"));
  temporaryDirectories.push(directory);
  const crawler = new InternshipCrawler(resolveSettings({
    outputDirectory: directory,
    databasePath: join(directory, "scout.db"),
    respectRobotsTxt,
    maxDepth: 0,
    maxPagesPerSource: 1,
  }), new Logger("error"), { openaiJobFallback: { recover } });
  return { crawler, directory };
}

function extractWithFallback(crawler: InternshipCrawler, page: PageSnapshot, sourceUrl = page.url): Promise<RawJob[]> {
  const internal = crawler as unknown as {
    extractJobsWithFallback(snapshot: PageSnapshot, source: string): Promise<RawJob[]>;
  };
  return internal.extractJobsWithFallback(page, sourceUrl);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("crawler OpenAI fallback integration", () => {
  it("recovers a parser-unsupported page, then applies the ordinary analyzer and preserves evidence", async () => {
    const page = snapshot(200, "", true);
    expect(extractJobs(page)).toEqual([]);
    const recoveredJob: RawJob = {
      company: "Harbor Cloud",
      title: "Software Engineering Intern",
      locations: ["Toronto, Ontario, Canada"],
      description: "Build and test TypeScript services used by customers. Work with engineers to debug APIs and ship production features. Pursuing a Computer Science degree with experience in TypeScript.",
      responsibilities: ["Build and test TypeScript services used by customers."],
      requiredQualifications: ["Pursuing a Computer Science degree with experience in TypeScript."],
      applicationUrl: page.url,
      postingUrl: page.url,
      internshipTerm: "Summer 2027",
      salary: "$42 per hour",
      sourceProvider: "openai",
      provenance: [
        evidenceFor(page, "internshipTerm", "Summer 2027", "Placement term: Summer 2027"),
        evidenceFor(page, "salary", "$42 per hour", "Pay: $42 per hour"),
      ],
    };
    const recover = vi.fn(async () => [recoveredJob]);
    const { crawler } = makeCrawler(recover);

    const recovered = await extractWithFallback(crawler, page);
    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith(page, [], page.url, undefined);
    expect(recovered).toEqual([recoveredJob]);

    const analyzed = await analyzeRawJob(recovered[0]!, page.url, 60, async (url) => url, page.fetchedAt);
    expect(analyzed.accepted).toBe(true);
    if (!analyzed.accepted) return;
    expect(analyzed.value.internship).toMatchObject({
      company: "Harbor Cloud",
      title: "Software Engineering Intern",
      internshipTerm: "Summer 2027",
      salary: "$42 per hour",
    });
    expect(analyzed.value.internship.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "internshipTerm", quote: "Placement term: Summer 2027" }),
      expect.objectContaining({ field: "salary", quote: "Pay: $42 per hour" }),
    ]));
  });

  it("fills an unknown detail on a deterministic result without changing the deterministic fields", async () => {
    const page = snapshot();
    const deterministic = extractJobs(page);
    // This fixture contains a recognizable job but the term and pay are outside
    // the deterministic description field selected by the generic parser.
    expect(deterministic).toHaveLength(1);
    expect(deterministic[0]?.internshipTerm).toBeUndefined();
    expect(deterministic[0]?.salary).toBeUndefined();
    const enriched = {
      ...deterministic[0]!,
      internshipTerm: "Summer 2027",
      salary: "$42 per hour",
      provenance: [
        evidenceFor(page, "internshipTerm", "Summer 2027", "Placement term: Summer 2027"),
        evidenceFor(page, "salary", "$42 per hour", "Pay: $42 per hour"),
      ],
    } satisfies RawJob;
    const recover = vi.fn(async (_page: PageSnapshot, jobs: RawJob[]) => [enriched, ...jobs.slice(1)]);
    const { crawler } = makeCrawler(recover);

    const result = await extractWithFallback(crawler, page);

    expect(recover).toHaveBeenCalledWith(page, deterministic, page.url, undefined);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      company: deterministic[0]?.company,
      title: deterministic[0]?.title,
      description: deterministic[0]?.description,
      internshipTerm: "Summer 2027",
      salary: "$42 per hour",
    });
  });

  it("keeps deterministic output if the fallback service throws", async () => {
    const page = snapshot();
    const deterministic = extractJobs(page);
    const recover = vi.fn(async () => { throw new Error("provider failure details must not replace parser output"); });
    const { crawler } = makeCrawler(recover);

    await expect(extractWithFallback(crawler, page)).resolves.toEqual(deterministic);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not call OpenAI for closed or access-denied page content", async () => {
    const recover = vi.fn(async (_page: PageSnapshot, jobs: RawJob[]) => jobs);
    const { crawler } = makeCrawler(recover);
    const openPage = snapshot();
    const closedPage = { ...openPage, text: `This job has been removed\n${openPage.text}` };
    const deniedPage = { ...openPage, text: "Access denied. Your request was blocked by the site." };

    await extractWithFallback(crawler, closedPage);
    await extractWithFallback(crawler, deniedPage);

    expect(recover).not.toHaveBeenCalled();
  });

  it("does not block a valid role because its work mentions CAPTCHA", async () => {
    const page = snapshot(200, "Work includes building CAPTCHA challenge detection for customer sign-in.");
    const deterministic = extractJobs(page);
    expect(deterministic).toHaveLength(1);
    const recover = vi.fn(async (_page: PageSnapshot, jobs: RawJob[]) => jobs);
    const { crawler } = makeCrawler(recover);

    await expect(extractWithFallback(crawler, page)).resolves.toEqual(deterministic);

    expect(recover).toHaveBeenCalledOnce();
  });

  it("passes the source watchdog signal to an in-flight fallback and propagates its abort", async () => {
    const page = snapshot();
    const controller = new AbortController();
    const stalled = new SourceStalledError(page.url, 10);
    let receivedSignal: AbortSignal | undefined;
    const recover = vi.fn((_page: PageSnapshot, _jobs: RawJob[], _sourceUrl: string, signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<RawJob[]>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("missing source signal"));
          return;
        }
        const rejectAborted = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("source aborted"));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      });
    });
    const { crawler } = makeCrawler(recover);
    const attempt = runWithSourceAbortSignal(controller.signal, () => extractWithFallback(crawler, page));
    const timer = setTimeout(() => controller.abort(stalled), 0);

    try {
      await expect(attempt).rejects.toBe(stalled);
    } finally {
      clearTimeout(timer);
    }

    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("does not invoke OpenAI after the source robots gate denies the page", async () => {
    const recover = vi.fn(async (_page: PageSnapshot, jobs: RawJob[]) => jobs);
    const { crawler } = makeCrawler(recover, true);
    const internal = crawler as unknown as {
      robots: { check(url: string): Promise<{ allowed: boolean; crawlDelayMs: number | null }> };
    };
    internal.robots = { check: async () => ({ allowed: false, crawlDelayMs: null }) };

    const result = await crawler.crawl(["https://jobs.example.com/careers"]);

    expect(result.sourceResults[0]?.status).toBe("robots_disallowed");
    expect(recover).not.toHaveBeenCalled();
  });
});
