import { describe, expect, it } from "vitest";

import { extractJobrightJobRecords } from "../src/extractors/jobright.js";
import { INTERN_LIST_CANADA_TAB_CATEGORY, INTERN_LIST_CANADA_TAB_URL, INTERN_LIST_MAX_RAW_LISTINGS, InternListAdapter, internListCategory, internListEndpoint, internListFeeds, parseInternListResponse } from "../src/crawler/adapters/internList.js";
import type { HttpResponseSnapshot } from "../src/crawler/http.js";
import { Logger } from "../src/utils/logger.js";

function response(url: string, value: unknown): HttpResponseSnapshot {
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
    headers: {},
    attempts: 1,
    fromCache: false,
  };
}

function job(id: string, index: number): Record<string, unknown> {
  return {
    jobId: id,
    tabCategory: ["intern:us:swe"],
    properties: {
      title: `Software Engineering Intern ${index}`,
      company: "Example Robotics",
      location: "Toronto, ON; Remote",
      salary: "$30/hr",
      workModel: "Hybrid",
      industry: ["Software"],
      companySize: "501-1000",
      qualifications: "1. Pursuing Computer Science.\n2. Experience with Python.",
    },
    postedAt: 1786803050000,
  };
}

function uniqueJobIdsFrom(snapshots: Array<{ text: string }>): number {
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    const payload = JSON.parse(snapshot.text) as { result?: { jobList?: Array<{ jobId?: unknown }> } };
    for (const record of payload.result?.jobList ?? []) {
      if (typeof record.jobId === "string" && record.jobId) ids.add(record.jobId);
    }
  }
  return ids.size;
}

const SELECTED_FEED_COUNT = 1;
const ROOT_FEED_COUNT = 2;

describe("Intern List structured feed", () => {
  it("maps page filters to the Jobright category key", () => {
    expect(internListCategory("https://www.intern-list.com/?k=swe")).toBe("intern:us:swe");
    expect(internListCategory("https://www.intern-list.com/?k=aiml")).toBe("intern:us:ml_ai");
    expect(internListCategory("https://www.intern-list.com/?k=eng")).toBe("intern:us:engineering_development");
    expect(internListCategory("https://www.intern-list.com/")).toBe("intern:us:swe");
    expect(internListFeeds("https://www.intern-list.com/?k=swe")).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "intern:us:swe", country: "us" }),
      expect.objectContaining({ category: INTERN_LIST_CANADA_TAB_CATEGORY, country: "ca", embeddedUrl: INTERN_LIST_CANADA_TAB_URL }),
    ]));
    const aimlFeeds = internListFeeds("https://www.intern-list.com/?k=aiml");
    expect(aimlFeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "intern:us:ml_ai", country: "us" }),
      expect.objectContaining({ category: INTERN_LIST_CANADA_TAB_CATEGORY, country: "ca", embeddedUrl: INTERN_LIST_CANADA_TAB_URL }),
    ]));
    const engineeringFeeds = internListFeeds("https://www.intern-list.com/?k=eng");
    expect(engineeringFeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "intern:us:engineering_development", country: "us" }),
    ]));
    expect(internListFeeds("https://www.intern-list.com/").map(({ category }) => category))
      .toEqual(["intern:us:swe", INTERN_LIST_CANADA_TAB_CATEGORY]);
    expect(internListFeeds("https://www.intern-list.com/?k=eng")).toHaveLength(SELECTED_FEED_COUNT);
    expect(internListEndpoint(50, 50)).toContain("count=50");
    expect(internListEndpoint(50, 50)).toContain("position=50");
  });

  it("normalizes the configured category paths and aliases", () => {
    expect(internListCategory("https://www.intern-list.com/?k=swe")).toBe("intern:us:swe");
    expect(internListCategory("https://www.intern-list.com/?k=aiml")).toBe("intern:us:ml_ai");
    expect(internListCategory("https://www.intern-list.com/?k=eng")).toBe("intern:us:engineering_development");
    expect(internListCategory("https://www.intern-list.com/")).toBe("intern:us:swe");
    expect(internListCategory("https://www.intern-list.com/?k=ml")).toBe("intern:us:ml_ai");
    expect(INTERN_LIST_CANADA_TAB_CATEGORY).toBe("intern:ca:engineering_development");
    expect(INTERN_LIST_CANADA_TAB_URL).toBe("https://jobright.ai/minisites-jobs/intern/ca/engineering_development?embed=true");
  });

  it("validates the API response envelope", () => {
    const parsed = parseInternListResponse({ success: true, result: { total: 1, jobList: [job("one", 1)] } });
    expect(parsed?.total).toBe(1);
    expect(parsed?.jobList).toHaveLength(1);
    expect(parseInternListResponse({ success: false, result: { total: 1, jobList: [] } })).toBeNull();
  });

  it("probes cheaply, requests the exact total, and falls back to bounded offset pages", async () => {
    const records = Array.from({ length: 51 }, (_value, index) => job(`job-${index}`, index));
    const calls: string[] = [];
    const counts: number[] = [];
    const fakeHttp = {
      postJson: async (url: string, body: { category: string }) => {
        calls.push(`${url}:${body.category}`);
        const parsed = new URL(url);
        const position = Number(parsed.searchParams.get("position"));
        const count = Number(parsed.searchParams.get("count"));
        counts.push(count);
        const page = count === 51
          ? records.slice(0, 50)
          : records.slice(position, position + count);
        return response(url, { success: true, result: { total: 51, jobList: page } });
      },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.failures).toHaveLength(0);
    expect(result.snapshots).toHaveLength(2 * SELECTED_FEED_COUNT);
    expect(result.notes.join(" ")).toContain("51/51 unique records");
    expect(result.maxRawListings).toBe(INTERN_LIST_MAX_RAW_LISTINGS);
    expect(calls).toHaveLength(3 * SELECTED_FEED_COUNT);
    expect(counts).toEqual(Array.from({ length: SELECTED_FEED_COUNT }, () => [50, 51, 1000]).flat());
  });

  it("accepts a complete probe snapshot without an unnecessary bulk request", async () => {
    const records = Array.from({ length: 50 }, (_value, index) => job(`shrinking-${index}`, index));
    const fakeHttp = {
      postJson: async (url: string) => {
        return response(url, { success: true, result: { total: 50, jobList: records } });
      },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.failures).toHaveLength(0);
    expect(result.snapshots).toHaveLength(SELECTED_FEED_COUNT);
    expect(result.notes.join(" ")).toContain("50/50 records in one complete structured snapshot");
  });

  it("keeps paging past the advertised total when duplicate windows displace unique jobs", async () => {
    const records = Array.from({ length: 80 }, (_value, index) => job(`shifted-${index}`, index));
    const fakeHttp = {
      postJson: async (url: string) => {
        const position = Number(new URL(url).searchParams.get("position"));
        const page = position === 0
          ? records.slice(0, 50)
          : position >= 80
            ? records.slice(70, 80)
            : records.slice(40, 70);
        return response(url, { success: true, result: { total: 80, jobList: page } });
      },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.failures).toHaveLength(0);
    expect(uniqueJobIdsFrom(result.snapshots)).toBe(80);
    expect(result.notes.join(" ")).toContain("80/80 unique records");
  });

  it("accepts a complete bulk snapshot whose payload includes duplicate job IDs", async () => {
    const unique = Array.from({ length: 45 }, (_value, index) => job(`bulk-dup-${index}`, index));
    const records = [...unique, ...unique.slice(0, 6)];
    const fakeHttp = {
      postJson: async (url: string) => {
        const count = Number(new URL(url).searchParams.get("count"));
        const position = Number(new URL(url).searchParams.get("position"));
        return response(url, {
          success: true,
          result: { total: records.length, jobList: records.slice(position, position + count) },
        });
      },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.failures).toHaveLength(0);
    expect(result.snapshots).toHaveLength(SELECTED_FEED_COUNT);
    expect(result.notes.join(" ")).toContain("45/51 unique records in one complete structured snapshot");
  });

  it("accepts a fully walked feed whose advertised total includes duplicate source rows", async () => {
    const unique = Array.from({ length: 90 }, (_value, index) => job(`dup-src-${index}`, index));
    const records = [...unique, ...unique.slice(0, 10)];
    const fakeHttp = {
      postJson: async (url: string) => {
        const count = Number(new URL(url).searchParams.get("count"));
        const position = Number(new URL(url).searchParams.get("position"));
        const page = count === records.length
          ? records.slice(0, 50)
          : records.slice(position, position + count);
        return response(url, {
          success: true,
          result: { total: records.length, jobList: page },
        });
      },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.failures).toHaveLength(0);
    expect(uniqueJobIdsFrom(result.snapshots)).toBe(90);
    expect(result.notes.join(" ")).toContain("90/100 unique records");
    expect(result.notes.join(" ")).toContain("duplicate rows in the live feed");
  });

  it("does not treat a repeating offset window as complete coverage", async () => {
    const records = Array.from({ length: 80 }, (_value, index) => job(`repeat-${index}`, index));
    const fakeHttp = {
      postJson: async (url: string) => {
        const position = Number(new URL(url).searchParams.get("position"));
        const page = position === 0 ? records.slice(0, 50) : records.slice(0, 50);
        return response(url, { success: true, result: { total: 80, jobList: page } });
      },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.failures).toHaveLength(SELECTED_FEED_COUNT);
    expect(result.failures[0]?.message).toMatch(/Structured coverage is incomplete/u);
  });

  it("preserves HTTP cache provenance on structured snapshots", async () => {
    const fakeHttp = {
      postJson: async (url: string) => ({ ...response(url, { success: true, result: { total: 1, jobList: [job("cached", 1)] } }), fromCache: true }),
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.snapshots[0]?.fromCache).toBe(true);
  });

  it("retains an initial transport failure for source health and fallback decisions", async () => {
    const fakeHttp = {
      postJson: async () => { throw new Error("Jobright API unavailable"); },
    };
    const result = await new InternListAdapter(fakeHttp as never, new Logger("error")).collect("https://www.intern-list.com/?k=eng");

    expect(result.snapshots).toHaveLength(0);
    expect(result.failures).toHaveLength(SELECTED_FEED_COUNT);
    expect(result.notes.join(" ")).toContain("could not be retrieved");
  });

  it("shares overlapping root and SWE feed requests within one crawl", async () => {
    const calls: string[] = [];
    const fakeHttp = {
      postJson: async (url: string, body: { category: string }) => {
        calls.push(body.category);
        return response(url, { success: true, result: { total: 1, jobList: [job(body.category, 1)] } });
      },
    };
    const adapter = new InternListAdapter(fakeHttp as never, new Logger("error"));
    const [root, swe] = await Promise.all([
      adapter.collect("https://www.intern-list.com/"),
      adapter.collect("https://www.intern-list.com/?k=swe"),
    ]);

    expect(new Set(calls)).toEqual(new Set(["intern:us:swe", INTERN_LIST_CANADA_TAB_CATEGORY]));
    expect(calls).toHaveLength(ROOT_FEED_COUNT);
    expect(root.snapshots).toHaveLength(ROOT_FEED_COUNT);
    expect(swe.snapshots).toHaveLength(ROOT_FEED_COUNT);
  });

  it("maps a structured Jobright record to a RawJob", () => {
    const jobs = extractJobrightJobRecords({ success: true, result: { total: 1, jobList: [job("abc123", 1)] } });
    expect(jobs[0]).toMatchObject({
      jobId: "abc123",
      company: "Example Robotics",
      title: "Software Engineering Intern 1",
      locations: ["Toronto, ON", "Remote"],
      salary: "$30/hr",
      postingUrl: "https://jobright.ai/jobs/info/abc123",
      applicationUrl: "https://jobright.ai/jobs/info/abc123",
      sourceProvider: "jobright-intern-list",
    });
    expect(jobs[0]?.description).toContain("Experience with Python");
    expect(jobs[0]?.postingDate).toBe("2026-08-15T14:10:50.000Z");
  });
});
