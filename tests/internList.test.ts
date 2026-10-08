import { describe, expect, it, vi } from "vitest";
import { extractJobrightJobRecords } from "../src/extractors/jobright.js";
import { INTERN_LIST_CANADA_TAB_CATEGORY, INTERN_LIST_CANADA_TAB_URL, InternListAdapter, internListCategory, internListEndpoint, internListFeeds, parseInternListResponse } from "../src/crawler/adapters/internList.js";
import { RETIRED_JOBRIGHT_LIST_URL } from "../src/config/retiredSources.js";
import { Logger } from "../src/utils/logger.js";

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


describe("archived Intern List feed parsing and retired endpoint guard", () => {
  it.each([
    RETIRED_JOBRIGHT_LIST_URL,
    `${RETIRED_JOBRIGHT_LIST_URL}?position=0&count=50`,
    `${RETIRED_JOBRIGHT_LIST_URL}/obsolete`,
  ])("settles %s without any HTTP request", async (source) => {
    const http = { get: vi.fn(), postJson: vi.fn() };
    const adapter = new InternListAdapter(http as never, new Logger("error"));
    expect(adapter.canHandle(source)).toBe(true);
    const result = await adapter.collect(source);
    expect(result).toMatchObject({ snapshots: [], retrievalUrls: [], attempts: 0, inventoryComplete: false, browserRequired: false });
    expect(result.failures).toEqual([expect.objectContaining({ errorType: "source_retired" })]);
    expect(http.get).not.toHaveBeenCalled();
    expect(http.postJson).not.toHaveBeenCalled();
  });

  it("maps page filters to the Jobright category key", () => {
    expect(internListCategory("https://www.intern-list.com/?k=swe")).toBe("intern:us:swe");
    expect(internListCategory("https://www.intern-list.com/?k=aiml")).toBe("intern:us:ml_ai");
    expect(internListCategory("https://www.intern-list.com/?k=eng")).toBe("intern:us:engineering_development");
    expect(internListCategory("https://www.intern-list.com/")).toBe("intern:us:swe");
    const expectedMappings = [
      ["https://www.intern-list.com/", "intern:us:swe"],
      ["https://www.intern-list.com/?k=aiml", "intern:us:ml_ai"],
      ["https://www.intern-list.com/?k=eng", "intern:us:engineering_development"],
      ["https://www.intern-list.com/?k=swe", "intern:us:swe"],
    ] as const;
    for (const [source, usCategory] of expectedMappings) {
      expect(internListFeeds(source).map(({ category }) => category)).toEqual([usCategory, INTERN_LIST_CANADA_TAB_CATEGORY]);
      expect(internListFeeds(source)[1]).toMatchObject({ country: "ca", embeddedUrl: INTERN_LIST_CANADA_TAB_URL });
    }
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
