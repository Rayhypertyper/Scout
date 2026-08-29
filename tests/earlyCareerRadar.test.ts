import { describe, expect, it, vi } from "vitest";

import {
  EARLY_CAREER_RADAR_API_URL,
  EARLY_CAREER_RADAR_LISTING_URL,
  EARLY_CAREER_RADAR_MAX_FEED_JOBS,
  EarlyCareerRadarAdapter,
  normalizeEarlyCareerRadarCountry,
  parseEarlyCareerRadarEmbeddedJobs,
  parseEarlyCareerRadarJobs,
  selectEarlyCareerRadarJobs,
} from "../src/crawler/adapters/earlyCareerRadar.js";
import type { HttpClient, HttpResponseSnapshot } from "../src/crawler/http.js";
import { Logger } from "../src/utils/logger.js";

const sourceUrl = "https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus&years=1st+year%2C2nd+year%2C3rd+year%2C4th+year%2CAny+undergraduate+year%2CUndergraduate+%E2%80%94+year+not+stated%2CNot+stated";

const feedJobs = [
  {
    id: "us-eligible",
    company: "Acme",
    title: "Software Engineering Intern",
    location: "Austin, TX",
    hub: "Other U.S.",
    track: "SWE",
    mode: "Hybrid",
    postedAt: "2026-08-16",
    applyUrl: "https://jobs.example.com/acme/us-eligible",
    studentYears: ["3rd year"],
  },
  {
    id: "canada-eligible",
    company: "Maple",
    title: "Data Intern",
    location: "Toronto, Canada",
    hub: "International",
    track: "Other",
    mode: "Not specified",
    postedAt: "2026-08-15",
    applyUrl: "https://jobs.example.com/maple/canada-eligible",
    studentYears: ["Not stated"],
  },
  { id: "international-role", company: "Paris", title: "Data Intern", location: "Paris, France", hub: "International", studentYears: ["3rd year"] },
  { id: "graduate-role", company: "Acme", title: "Graduate Software Intern", location: "Boston, MA", hub: "Other U.S.", studentYears: ["Graduate student"] },
  { id: "closed-role", company: "Acme", title: "Closed Intern", location: "Seattle, WA", hub: "Seattle", studentYears: ["Not stated"], closed: true },
  { id: "applied-role", company: "Acme", title: "Applied Intern", location: "Seattle, WA", hub: "Seattle", studentYears: ["Not stated"], applied: true },
] as const;

function embeddedHtml(jobs: readonly unknown[]): string {
  // This mirrors the public Next RSC shape observed on the live listing page:
  // self.__next_f.push([1, JSON.stringify("...initialJobs...")]).
  const payload = `5:["$","$L16",null,{"currentRadar":"summer-2027","initialJobs":${JSON.stringify(jobs)}}]`;
  return `<html><head><script>${`self.__next_f.push([1,${JSON.stringify(payload)}])`}</script></head><body><main>Internship Radar</main></body></html>`;
}

function response(body: string, url = sourceUrl): HttpResponseSnapshot {
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body,
    headers: {},
    attempts: 1,
    fromCache: false,
  };
}

describe("Early Career Radar feed adapter", () => {
  it("matches the page country classifier for Canada and US locations", () => {
    expect(normalizeEarlyCareerRadarCountry("Toronto, Canada")).toBe("Canada");
    expect(normalizeEarlyCareerRadarCountry("US, California, San Francisco")).toBe("United States");
  });

  it("parses the first-party Next RSC initialJobs payload", () => {
    const parsed = parseEarlyCareerRadarEmbeddedJobs(embeddedHtml(feedJobs));

    expect(parsed).not.toBeNull();
    expect(parsed?.map(({ id, company, title, location, hub }) => ({ id, company, title, location, hub }))).toEqual([
      { id: "us-eligible", company: "Acme", title: "Software Engineering Intern", location: "Austin, TX", hub: "Other U.S." },
      { id: "canada-eligible", company: "Maple", title: "Data Intern", location: "Toronto, Canada", hub: "International" },
      { id: "international-role", company: "Paris", title: "Data Intern", location: "Paris, France", hub: "International" },
      { id: "graduate-role", company: "Acme", title: "Graduate Software Intern", location: "Boston, MA", hub: "Other U.S." },
      { id: "closed-role", company: "Acme", title: "Closed Intern", location: "Seattle, WA", hub: "Seattle" },
      { id: "applied-role", company: "Acme", title: "Applied Intern", location: "Seattle, WA", hub: "Seattle" },
    ]);
  });

  it("applies explicit location/year filters while retaining source status flags", () => {
    const parsed = parseEarlyCareerRadarJobs({ jobs: feedJobs });
    expect(parsed).not.toBeNull();
    const filteredSourceUrl = "https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus&years=1st+year%2C2nd+year%2C3rd+year%2C4th+year%2CAny+undergraduate+year%2CUndergraduate+%E2%80%94+year+not+stated%2CNot+stated";
    expect(selectEarlyCareerRadarJobs(filteredSourceUrl, parsed ?? []).map(({ id }) => id)).toEqual([
      "us-eligible",
      "canada-eligible",
      "closed-role",
      "applied-role",
    ]);
    expect(selectEarlyCareerRadarJobs(sourceUrl, parsed ?? []).map(({ id }) => id)).toEqual([
      "us-eligible",
      "canada-eligible",
      "closed-role",
      "applied-role",
    ]);
  });

  it("returns every matching detail URL from one HTML request", async () => {
    const get = vi.fn(async (url: string) => response(embeddedHtml(feedJobs), url));
    const adapter = new EarlyCareerRadarAdapter({ get } as unknown as HttpClient, new Logger("error"));
    const result = await adapter.collect(sourceUrl);

    expect(get).toHaveBeenCalledWith(sourceUrl, expect.objectContaining({
      cache: false,
      headers: { accept: "text/html,application/xhtml+xml" },
      respectRobots: false,
    }));
    expect(result.strategy).toBe("static_html");
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.links.map(({ url }) => url)).toEqual([
      "https://earlycareerradar.com/jobs/us-eligible",
      "https://earlycareerradar.com/jobs/canada-eligible",
      "https://earlycareerradar.com/jobs/closed-role",
      "https://earlycareerradar.com/jobs/applied-role",
    ]);
    expect(result.snapshots[0]?.html).toContain("initialJobs");
    expect(result.notes[0]).toContain("4 matched");
  });

  it("bounds unexpectedly broad feeds before building the synthetic snapshot", async () => {
    const largeFeed = Array.from({ length: EARLY_CAREER_RADAR_MAX_FEED_JOBS + 1 }, (_, index) => ({
      id: `large-${index}`,
      company: "Acme",
      title: `Software Engineering Intern ${index}`,
      location: "Toronto, Canada",
      hub: "International",
      studentYears: ["3rd year"],
    }));
    const get = vi.fn(async (url: string) => response(embeddedHtml(largeFeed), url));
    const adapter = new EarlyCareerRadarAdapter({ get } as unknown as HttpClient, new Logger("error"));
    const result = await adapter.collect(sourceUrl);

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.links).toHaveLength(EARLY_CAREER_RADAR_MAX_FEED_JOBS);
    expect(result.failures[0]?.errorType).toBe("source_limit");
    expect(result.notes[1]).toContain("bounded prefix");
    expect(result.snapshots[0]?.html).not.toContain("initialJobs");
  });

  it("coalesces concurrent canonical and legacy feed requests", async () => {
    const legacySourceUrl = "https://internship-radar-2027.yuxhuang.com/?locations=country%3ACanada%7Cus";
    let releaseRequest: (() => void) | undefined;
    const requestHeld = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const get = vi.fn(async (url: string) => {
      await requestHeld;
      return response(embeddedHtml(feedJobs), url);
    });
    const adapter = new EarlyCareerRadarAdapter({ get } as unknown as HttpClient, new Logger("error"));
    const first = adapter.collect(sourceUrl);
    const second = adapter.collect(legacySourceUrl);
    releaseRequest?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(firstResult.snapshots[0]?.links).toHaveLength(4);
    expect(secondResult.snapshots[0]?.links).toHaveLength(5);
  });

  it("uses the first-party data feed before browser fallback when page markup changes", async () => {
    const get = vi.fn(async (url: string) => url === EARLY_CAREER_RADAR_API_URL
      ? response(JSON.stringify({ jobs: feedJobs }), url)
      : response("<html><body>Markup changed</body></html>", url));
    const adapter = new EarlyCareerRadarAdapter({ get } as unknown as HttpClient, new Logger("error"));
    const result = await adapter.collect(sourceUrl);

    expect(get).toHaveBeenNthCalledWith(1, sourceUrl, expect.objectContaining({ respectRobots: false }));
    expect(get).toHaveBeenNthCalledWith(2, EARLY_CAREER_RADAR_API_URL, expect.objectContaining({
      cache: false,
      headers: { accept: "application/json" },
      respectRobots: false,
    }));
    expect(result.retrievalMethod).toContain("first-party data fallback");
    expect(result.strategy).toBe("static_html");
    expect(result.snapshots[0]?.links).toHaveLength(4);
  });

  it("requests browser fallback when the public HTML has no usable feed", async () => {
    const get = vi.fn(async (url: string) => response("<html><body>JavaScript shell</body></html>", url));
    const adapter = new EarlyCareerRadarAdapter({ get } as unknown as HttpClient, new Logger("error"));
    const result = await adapter.collect(sourceUrl);

    expect(get).toHaveBeenCalledWith(sourceUrl, expect.anything());
    expect(result.retrievalUrls).toEqual([sourceUrl]);
    expect(result.strategy).toBe("browser_required");
    expect(result.browserRequired).toBe(true);
    expect(result.snapshots).toHaveLength(0);
    expect(result.notes[0]).toContain("initialJobs");
  });

  it("keeps the discovered first-party page route explicit", () => {
    expect(EARLY_CAREER_RADAR_LISTING_URL).toBe("https://earlycareerradar.com/summer-internships");
  });
});
