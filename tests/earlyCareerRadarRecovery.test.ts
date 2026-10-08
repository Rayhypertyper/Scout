import { describe, expect, it, vi } from "vitest";

import {
  canonicalEarlyCareerRadarApplyUrl,
  earlyCareerRadarDetailToRawJob,
  earlyCareerRadarInventoryFromSnapshot,
  earlyCareerRadarJobToRawJob,
  mergeEarlyCareerRadarMetadataWithPrior,
} from "../src/crawler/earlyCareerRadarRecovery.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { parseEarlyCareerRadarEmbeddedJobs } from "../src/crawler/adapters/earlyCareerRadar.js";
import type { PageSnapshot, RawJob } from "../src/domain/types.js";
import type { SourceAdapterResult } from "../src/crawler/adapters/types.js";
import { resolveSettings } from "../src/config/settings.js";
import { Logger } from "../src/utils/logger.js";
import { HttpRequestError } from "../src/crawler/http.js";
import { analyzed, makeInternship } from "./helpers.js";

const sourceUrl = "https://earlycareerradar.com/summer-internships?locations=all";

function embeddedHtml(records: readonly Record<string, unknown>[]): string {
  const payload = `5:["$","$L16",null,{"currentRadar":"summer-2027","initialJobs":${JSON.stringify(records)}}]`;
  return `<html><head><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></head><body>Early Career Radar</body></html>`;
}

function listingSnapshot(records: readonly Record<string, unknown>[], url = sourceUrl): PageSnapshot {
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "text/html; charset=utf-8",
    title: "2027 Summer Internships | Internship Radar",
    html: embeddedHtml(records),
    text: "Early Career Radar summer internship feed",
    links: records.map((record) => ({
      url: `https://earlycareerradar.com/jobs/${String(record.id)}`,
      text: `${String(record.company)} — ${String(record.title)}`,
      rel: "early-career-radar-embedded-feed",
    })),
    fetchedAt: "2026-10-05T17:00:00.000Z",
  };
}

function adapterResult(snapshot: PageSnapshot): SourceAdapterResult {
  return {
    snapshots: [snapshot],
    retrievalMethod: "Early Career Radar server-rendered HTML (Next RSC embedded feed)",
    retrievalUrls: [snapshot.url],
    attempts: 1,
    httpStatus: 200,
    notes: ["Retrieved the complete first-party Radar listing inventory."],
    failures: [],
    strategy: "static_html",
    inventoryComplete: true,
    // Four records are present in the feed, including one explicitly closed row.
    maxRawListings: 4,
  };
}

const records = [
  {
    id: "job-jpmc-403",
    company: "JPMorgan Chase",
    title: "Software Engineering Intern - Summer 2027",
    location: "New York, NY",
    hub: "Other U.S.",
    track: "SWE",
    mode: "Not specified",
    postedAt: "2026-10-04",
    deadlineAt: null,
    applyUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210690693",
    studentYears: ["Not stated"],
    workAuthorization: ["Not stated"],
    closed: false,
  },
  {
    id: "job-icims-login",
    company: "Susquehanna International Group",
    title: "Software Engineering Intern - Summer 2027",
    location: "New York, NY",
    hub: "Other U.S.",
    track: "SWE",
    mode: "Not specified",
    applyUrl: "https://careers-sig.icims.com/jobs/10723/login",
    studentYears: ["Not stated"],
    workAuthorization: ["Not stated"],
    closed: false,
  },
  {
    id: "job-closed-feed-record",
    company: "Example Analytics",
    title: "Data Science Intern - Summer 2027",
    location: "Toronto, ON",
    hub: "International",
    track: "Data",
    mode: "Not specified",
    closed: true,
  },
  {
    id: "job-detail-404",
    company: "Example Analytics",
    title: "Data Science Intern - Summer 2027",
    location: "San Francisco, CA",
    hub: "Other U.S.",
    track: "Data",
    mode: "Hybrid",
    applyUrl: "https://jobs.example-analytics.test/roles/404",
    closed: false,
  },
] as const;

function parsedRecord(id: string) {
  const job = parseEarlyCareerRadarEmbeddedJobs(embeddedHtml(records))?.find((record) => record.id === id);
  if (!job) throw new Error(`Missing Radar fixture ${id}`);
  return job;
}

const detailDescription = [
  "First-party detail narrative for the job record.",
  "Responsibilities include designing, implementing, testing, and documenting software used by financial services teams.",
  "The intern will collaborate with experienced engineers, investigate defects, and improve production services.",
  "Qualifications include current enrollment in a computer science or related bachelor's degree program and experience with one programming language.",
  "The role offers mentorship, code review, and exposure to scalable cloud software systems.",
  "Additional details explain the team, project scope, expected communication, and professional development opportunities.",
].join(" ");

function detailHtml(): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Stale Software Engineer Listing",
    url: "https://earlycareerradar.com/jobs/stale-detail-id",
    identifier: "stale-detail-id",
    hiringOrganization: { "@type": "Organization", name: "Stale Detail Company" },
    description: `<p>${detailDescription}</p>`,
    jobLocation: { "@type": "Place", address: { addressLocality: "Boston", addressRegion: "MA", addressCountry: "US" } },
  })}</script></head><body><a href="https://stale-detail-company.test/apply">Apply</a></body></html>`;
}

describe("Early Career Radar first-party recovery", () => {
  it("maps first-party facts without inventing employer details and preserves ATS link aliases", () => {
    const parsed = parseEarlyCareerRadarEmbeddedJobs(embeddedHtml(records));
    const sig = parsed?.find(({ id }) => id === "job-icims-login");
    expect(sig).toBeDefined();
    const raw = earlyCareerRadarJobToRawJob(sig!, sourceUrl);

    expect(raw).toMatchObject({
      company: "Susquehanna International Group",
      title: "Software Engineering Intern - Summer 2027",
      applicationUrl: "https://careers-sig.icims.com/jobs/10723/job?mobile=true&needsRedirect=false",
      postingUrl: "https://earlycareerradar.com/jobs/job-icims-login",
      jobId: "job-icims-login",
      sourceProvider: "early-career-radar",
    });
    expect(raw.description).toContain("does not include the employer's full job description");
    expect(raw.description).toContain("Student year listed by the source: Not stated.");
    expect(raw.responsibilities).toBeUndefined();
    expect(raw.requiredQualifications).toBeUndefined();
    expect(canonicalEarlyCareerRadarApplyUrl("https://careers-sig.icims.com/jobs/10723/login", sourceUrl))
      .toBe("https://careers-sig.icims.com/jobs/10723/job?mobile=true&needsRedirect=false");
  });

  it("parses the exact first-party API fallback snapshot as the same bounded inventory", () => {
    const snapshot: PageSnapshot = {
      ...listingSnapshot(records),
      url: "https://earlycareerradar.com/api/jobs",
      contentType: "application/json",
      html: JSON.stringify({ jobs: records }),
    };
    const inventory = earlyCareerRadarInventoryFromSnapshot(snapshot, sourceUrl);

    expect(inventory?.records).toHaveLength(4);
    expect(inventory?.rawJobs).toHaveLength(3);
    expect(inventory?.rawJobs[0]?.postingUrl).toBe("https://earlycareerradar.com/jobs/job-jpmc-403");
  });

  it("does not request optional first-party details at depth zero and counts closed feed rows without a false cap", async () => {
    const snapshot = listingSnapshot(records);
    const crawler = new InternshipCrawler(resolveSettings({
      maxDepth: 0,
      maxPagesPerSource: 4,
      httpConcurrency: 4,
      retryCount: 0,
    }), new Logger("error"));
    (crawler as unknown as { adapterRouter: { collect: () => Promise<SourceAdapterResult> } }).adapterRouter = {
      collect: async () => adapterResult(snapshot),
    };
    const http = (crawler as unknown as { http: { get: (...args: unknown[]) => Promise<unknown> } }).http;
    const requests = vi.spyOn(http, "get").mockRejectedValue(new Error("Depth-zero Radar crawl must not fetch details"));

    const result = await crawler.crawl([sourceUrl]);
    const source = result.sourceResults[0];

    expect(requests).not.toHaveBeenCalled();
    expect(source).toMatchObject({
      completed: true,
      coverageComplete: true,
      status: "success",
      pagesVisited: 1,
      potentialPostingsInspected: 4,
      failures: [],
    });
    expect(source?.jobs).toHaveLength(3);
    expect(source?.closedPages).toEqual([{
      url: "https://earlycareerradar.com/jobs/job-closed-feed-record",
      reason: "Early Career Radar marks the source record closed",
      statusCode: null,
    }]);
    expect(source?.failures.some(({ errorType }) => errorType === "source_limit")).toBe(false);
    expect(source?.jobs.every(({ internship }) => internship.responsibilities.length === 0
      && internship.requiredQualifications.length === 0)).toBe(true);
    expect(source?.coverageNotes?.join(" ")).toContain("Employer destinations were retained without verification");
  });

  it("uses same-site detail content, binds it to the feed identity, and retains rows when detail fetches fail", async () => {
    const snapshot = listingSnapshot(records);
    const crawler = new InternshipCrawler(resolveSettings({
      maxDepth: 1,
      maxPagesPerSource: 4,
      httpConcurrency: 4,
      retryCount: 0,
      respectRobotsTxt: false,
    }), new Logger("error"));
    (crawler as unknown as { adapterRouter: { collect: () => Promise<SourceAdapterResult> } }).adapterRouter = {
      collect: async () => adapterResult(snapshot),
    };
    const http = (crawler as unknown as { http: { get: (url: string, ...args: unknown[]) => Promise<unknown> } }).http;
    const requests: string[] = [];
    const requestOptions: Array<Record<string, unknown> | undefined> = [];
    vi.spyOn(http, "get").mockImplementation(async (url: string, ...args: unknown[]) => {
      requests.push(url);
      requestOptions.push(args[0] as Record<string, unknown> | undefined);
      if (url === "https://earlycareerradar.com/jobs/job-jpmc-403") {
        return {
          requestedUrl: url,
          url,
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: detailHtml(),
          headers: {},
          attempts: 1,
          fromCache: false,
        };
      }
      if (url === "https://earlycareerradar.com/jobs/job-icims-login") {
        throw new HttpRequestError("HTTP 403 access denied", 403, 1, "access_denied");
      }
      if (url === "https://earlycareerradar.com/jobs/job-detail-404") {
        throw new HttpRequestError("HTTP 404 not found", 404, 1, "not_found");
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const extractor = crawler as unknown as {
      extractJobsWithFallback: (snapshot: PageSnapshot, source: string) => Promise<RawJob[]>;
    };
    const originalExtract = extractor.extractJobsWithFallback.bind(crawler);
    const extractedDetails: Array<{ url: string; jobs: RawJob[] }> = [];
    vi.spyOn(extractor, "extractJobsWithFallback").mockImplementation(async (detailSnapshot, detailSource) => {
      const jobs = await originalExtract(detailSnapshot, detailSource);
      extractedDetails.push({ url: detailSnapshot.url, jobs });
      return jobs;
    });
    const result = await crawler.crawl([sourceUrl], new Map(), undefined, undefined, {
      classifyListing: () => ({
        disposition: "unchanged",
        validatorsMatch: true,
        reason: "cached open Radar row",
        record: null,
      } as never),
    });
    const source = result.sourceResults[0];
    const jpmc = source?.jobs.find(({ internship }) => internship.company === "JPMorgan Chase");
    const sig = source?.jobs.find(({ internship }) => internship.company === "Susquehanna International Group");
    const example = source?.jobs.find(({ internship }) => internship.company === "Example Analytics");
    expect(new Set(requests)).toEqual(new Set([
      "https://earlycareerradar.com/jobs/job-jpmc-403",
      "https://earlycareerradar.com/jobs/job-icims-login",
      "https://earlycareerradar.com/jobs/job-detail-404",
    ]));
    expect(requestOptions).toHaveLength(3);
    expect(requestOptions.every((options) => options?.cache === false)).toBe(true);
    expect(requestOptions.every((options) => (options?.allowedRedirectOrigins as string[] | undefined)?.includes("https://earlycareerradar.com"))).toBe(true);
    expect(extractedDetails.find(({ url }) => url === "https://earlycareerradar.com/jobs/job-jpmc-403")?.jobs[0]?.description)
      .toContain("First-party detail narrative for the job record.");
    expect(requests.every((url) => new URL(url).hostname === "earlycareerradar.com")).toBe(true);
    expect(source).toMatchObject({
      completed: true,
      coverageComplete: true,
      inventoryCount: 4,
      trustedInventory: true,
      inventoryStatus: "trusted",
      status: "partial",
      pagesVisited: 4,
      potentialPostingsInspected: 4,
    });
    expect(source?.jobs).toHaveLength(3);
    expect(source?.failures.map(({ statusCode }) => statusCode)).toEqual([403]);
    expect(source?.closedPages.some(({ url }) => url.endsWith("job-detail-404"))).toBe(false);
    expect(source?.coverageNotes?.join(" ")).toContain("not-found page(s) skipped without retry");
    expect(source?.failures.some(({ errorType }) => errorType === "source_limit")).toBe(false);
    expect(jpmc?.internship).toMatchObject({
      company: "JPMorgan Chase",
      title: "Software Engineering Intern - Summer 2027",
      applicationUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210690693",
      postingUrl: "https://earlycareerradar.com/jobs/job-jpmc-403",
      jobId: "job-jpmc-403",
      availabilityStatus: "unknown",
    });
    expect(jpmc?.internship.description).toContain("First-party detail narrative for the job record.");
    expect(jpmc?.internship.description).not.toContain("does not include the employer's full job description");
    expect(sig?.internship.description).toContain("does not include the employer's full job description");
    expect(sig?.internship.applicationUrl).toBe("https://careers-sig.icims.com/jobs/10723/job?mobile=true&needsRedirect=false");
    expect(example?.internship.description).toContain("does not include the employer's full job description");
  });

  it("preserves prior rich employer content only for the same Radar identity", () => {
    const feedRaw = earlyCareerRadarJobToRawJob(parsedRecord("job-icims-login"), sourceUrl);
    const incoming = analyzed(makeInternship({
      company: feedRaw.company!,
      title: feedRaw.title!,
      jobId: feedRaw.jobId!,
      postingUrl: feedRaw.postingUrl,
      applicationUrl: feedRaw.applicationUrl!,
      sourceUrl,
      sources: [sourceUrl],
      description: feedRaw.description!,
      responsibilities: [],
      requiredQualifications: [],
      preferredQualifications: [],
      availabilityStatus: "unknown",
      lastVerifiedAt: "2026-10-05T17:00:00.000Z",
    }));
    const prior = makeInternship({
      company: feedRaw.company!,
      title: feedRaw.title!,
      jobId: feedRaw.jobId!,
      postingUrl: feedRaw.postingUrl,
      applicationUrl: "https://careers-sig.icims.com/jobs/10723/job",
      description: "Previously fetched employer content with detailed engineering responsibilities and qualifications.",
      responsibilities: ["Implement and test software features."],
      requiredQualifications: ["Current enrollment in a related undergraduate program."],
      availabilityStatus: "open",
      lastVerifiedAt: "2026-10-01T12:00:00.000Z",
    });

    const merged = mergeEarlyCareerRadarMetadataWithPrior(incoming, prior);
    expect(merged.internship.description).toBe(prior.description);
    expect(merged.internship.responsibilities).toEqual(prior.responsibilities);
    expect(merged.internship.requiredQualifications).toEqual(prior.requiredQualifications);
    expect(merged.internship.applicationUrl).toBe("https://careers-sig.icims.com/jobs/10723/job?mobile=true&needsRedirect=false");
    expect(merged.internship.availabilityStatus).toBe("unknown");
    expect(merged.internship.lastVerifiedAt).toBe(prior.lastVerifiedAt);

    const wrongIdentity = makeInternship({
      ...prior,
      jobId: "different-radar-id",
      postingUrl: "https://earlycareerradar.com/jobs/different-radar-id",
    });
    expect(mergeEarlyCareerRadarMetadataWithPrior(incoming, wrongIdentity).internship.description)
      .toBe(incoming.internship.description);
  });

  it("keeps feed identity and its canonical application destination over stale detail identity", () => {
    const enriched = earlyCareerRadarDetailToRawJob(parsedRecord("job-jpmc-403"), {
      company: "Stale Detail Company",
      title: "Stale Software Engineer Listing",
      locations: ["Boston, MA"],
      description: detailDescription,
      responsibilities: ["Implement unrelated software."],
      applicationUrl: "https://stale-detail-company.test/apply",
      postingUrl: "https://earlycareerradar.com/jobs/stale-detail-id",
      jobId: "stale-detail-id",
      sourceProvider: "json-ld",
    } satisfies RawJob, sourceUrl);

    expect(enriched).toMatchObject({
      company: "JPMorgan Chase",
      title: "Software Engineering Intern - Summer 2027",
      applicationUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210690693",
      postingUrl: "https://earlycareerradar.com/jobs/job-jpmc-403",
      jobId: "job-jpmc-403",
      sourceProvider: "early-career-radar",
    });
    expect(enriched.description).toBe(detailDescription);
    expect(enriched.responsibilities).toEqual(["Implement unrelated software."]);
  });

  it("keeps browser fallback first-party, normalizes cached availability, and reports incomplete inventory", async () => {
    const crawler = new InternshipCrawler(resolveSettings({
      maxDepth: 3,
      maxPagesPerSource: 100,
      browserConcurrency: 2,
      respectRobotsTxt: false,
    }), new Logger("error"));
    (crawler as unknown as { adapterRouter: { collect: () => Promise<SourceAdapterResult> } }).adapterRouter = {
      collect: async () => ({
        snapshots: [],
        retrievalMethod: "Radar feed unavailable",
        retrievalUrls: [sourceUrl],
        attempts: 2,
        httpStatus: null,
        notes: ["Both first-party feed parsers failed."],
        failures: [],
        strategy: "browser_required",
        browserRequired: true,
      }),
    };
    const cachedUrl = "https://earlycareerradar.com/jobs/cached-radar-job";
    const freshUrl = "https://earlycareerradar.com/jobs/fresh-radar-job";
    const employerUrl = "https://careers-example.icims.com/jobs/123/job";
    const rootSnapshot: PageSnapshot = {
      requestedUrl: sourceUrl,
      url: sourceUrl,
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Early Career Radar",
      html: "<html><body>Internship listings</body></html>",
      text: "Software internship listings for 2027",
      links: [
        { url: cachedUrl, text: "Software Engineering Intern - Summer 2027", rel: "" },
        { url: freshUrl, text: "Data Engineering Intern - Summer 2027", rel: "" },
        { url: employerUrl, text: "Apply on employer site", rel: "apply" },
      ],
      fetchedAt: "2026-10-05T17:00:00.000Z",
    };
    const cached = makeInternship({
      id: "cached-radar-job",
      jobId: "cached-radar-job",
      company: "Cached Radar Company",
      title: "Software Engineering Intern - Summer 2027",
      postingUrl: cachedUrl,
      applicationUrl: employerUrl,
      sourceUrl,
      sources: [sourceUrl],
      availabilityStatus: "open",
    });
    const cachedDecision = {
      disposition: "unchanged",
      validatorsMatch: true,
      reason: "same cached listing",
      record: {
        internship: cached,
        contentHash: "cached-content-hash",
        etag: null,
        lastModified: null,
        canonicalUrl: cachedUrl,
        externalJobId: "cached-radar-job",
        providerIdentity: "early-career-radar",
        availabilityStatus: "open",
        failureState: "none",
        lastCheckedAt: new Date().toISOString(),
      },
    } as never;
    const detailSnapshot: PageSnapshot = {
      requestedUrl: freshUrl,
      url: freshUrl,
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Data Engineering Intern - Summer 2027",
      html: "<html><body>first-party detail response</body></html>",
      text: "first-party detail response",
      links: [{ url: employerUrl, text: "Apply on employer site", rel: "apply" }],
      fetchedAt: "2026-10-05T17:00:00.000Z",
    };
    const browser = (crawler as unknown as { browser: {
      fetchPage: (url: string, ...args: unknown[]) => Promise<PageSnapshot>;
      resolveApplicationUrl: (...args: unknown[]) => Promise<string | null>;
      resolveOriginalJobPostUrl: (...args: unknown[]) => Promise<string | null>;
    } }).browser;
    const fetchedUrls: string[] = [];
    vi.spyOn(browser, "fetchPage").mockImplementation(async (url: string) => {
      fetchedUrls.push(url);
      return url === sourceUrl
        ? rootSnapshot
        : { ...detailSnapshot, requestedUrl: url, url };
    });
    const resolveApplication = vi.spyOn(browser, "resolveApplicationUrl").mockRejectedValue(new Error("Employer resolution must not run"));
    const resolveOriginal = vi.spyOn(browser, "resolveOriginalJobPostUrl").mockRejectedValue(new Error("Employer resolution must not run"));
    const extraction = vi.spyOn(crawler as unknown as { extractJobsWithFallback: (snapshot: PageSnapshot, source: string) => Promise<RawJob[]> }, "extractJobsWithFallback")
      .mockImplementation(async (snapshot: PageSnapshot) => {
        if (snapshot.url === sourceUrl) return [];
        const cachedPage = snapshot.url === cachedUrl;
        return [{
          company: cachedPage ? "Cached Radar Company" : "Fresh Radar Company",
          title: cachedPage ? "Software Engineering Intern - Summer 2027" : "Data Engineering Intern - Summer 2027",
          locations: ["San Francisco, CA"],
          description: detailDescription,
          responsibilities: ["Build data systems."],
          applicationUrl: cachedPage ? employerUrl : "https://careers-fresh.icims.com/jobs/456/job",
          postingUrl: snapshot.url,
          jobId: cachedPage ? "cached-radar-job" : "fresh-radar-job",
          sourceProvider: "generic",
        }];
      });

    const result = await crawler.crawl(
      [sourceUrl],
      new Map([[sourceUrl, [cachedUrl]]]),
      undefined,
      undefined,
      {
        classifyListing: (_source, hint) => hint.postingUrl === cachedUrl
          ? cachedDecision
          : { disposition: "new", validatorsMatch: false, reason: "not cached", record: null },
      },
    );
    const source = result.sourceResults[0];

    expect(new Set(fetchedUrls)).toEqual(new Set([sourceUrl, cachedUrl, freshUrl]));
    expect(resolveApplication).not.toHaveBeenCalled();
    expect(resolveOriginal).not.toHaveBeenCalled();
    expect(extraction).toHaveBeenCalledTimes(3);
    expect(source).toMatchObject({
      completed: true,
      coverageComplete: false,
      status: "partial",
      pagesVisited: 3,
    });
    expect(source?.coverageNotes?.join(" ")).toContain("could not prove a complete inventory");
    expect(source?.jobs).toHaveLength(2);
    expect(source?.jobs.every(({ internship }) => internship.availabilityStatus === "unknown")).toBe(true);
  });
});
