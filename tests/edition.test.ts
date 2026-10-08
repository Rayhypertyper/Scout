import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { analyzeRawJob } from "../src/classification/analyzeJob.js";
import {
  PERSONAL_EDITION_CONFIG,
  PUBLIC_EDITION_CONFIG,
  parseScoutEdition,
  resolveScoutEditionConfig,
  scoutEditionFromEnvironment,
} from "../src/config/edition.js";
import { editionSwitcherEnabled } from "../src/config/editionSwitcher.js";
import { resolveSettings } from "../src/config/settings.js";
import { parseCli } from "../src/cli.js";
import { decideListingAcquisition } from "../src/crawler/acquisition.js";
import { compileMatcher } from "../src/preferences/matching.js";
import type { InternshipPreferences } from "../src/preferences/schema.js";
import { makeInternship } from "./helpers.js";

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  SCOUT_ENABLE_EDITION_SWITCHER: process.env.SCOUT_ENABLE_EDITION_SWITCHER,
  SCOUT_EDITION: process.env.SCOUT_EDITION,
};

function completePreferences(overrides: Partial<InternshipPreferences> = {}): InternshipPreferences {
  return {
    terms: [{ term: "summer", year: 2027 }],
    countries: ["canada"],
    cities: [{ name: "Toronto", country: "canada" }],
    remote: false,
    roleCategories: ["swe"],
    technologies: ["TypeScript"],
    degree: "bachelors",
    graduationYear: 2028,
    graduationYearOrLater: false,
    workAuthorization: { canada: "authorized", unitedStates: null },
    sponsorship: { canada: "none", unitedStates: null },
    onboardingCompleted: true,
    currentStep: 3,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    completedAt: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("Scout editions", () => {
  it("has explicit personal and public profiles with shared canonical admission", () => {
    expect(PERSONAL_EDITION_CONFIG.edition).toBe("personal");
    expect(PUBLIC_EDITION_CONFIG.edition).toBe("public");
    expect(PERSONAL_EDITION_CONFIG.canonicalAdmission).toEqual(PUBLIC_EDITION_CONFIG.canonicalAdmission);
    expect(PERSONAL_EDITION_CONFIG.acquisitionProfile.allowHighConfidenceEarlyReject).toBe(true);
    expect(PUBLIC_EDITION_CONFIG.acquisitionProfile.allowHighConfidenceEarlyReject).toBe(false);
    expect(PERSONAL_EDITION_CONFIG.features.crawlerAdministration).toBe(true);
    expect(PUBLIC_EDITION_CONFIG.features.crawlerAdministration).toBe(false);
  });

  it("defaults missing and invalid deployment editions to public", () => {
    expect(scoutEditionFromEnvironment({})).toBe("public");
    expect(scoutEditionFromEnvironment({ SCOUT_EDITION: "not-an-edition" })).toBe("public");
    expect(scoutEditionFromEnvironment({ SCOUT_EDITION: "PERSONAL" })).toBe("personal");
    expect(resolveScoutEditionConfig("not-an-edition" as never).edition).toBe("public");
    expect(parseScoutEdition("personal")).toBe("personal");
    expect(() => parseScoutEdition("owner")).toThrow(/personal.*public/i);
    expect(editionSwitcherEnabled({})).toBe(true);
    expect(editionSwitcherEnabled({ SCOUT_ENABLE_EDITION_SWITCHER: "false" })).toBe(false);
    expect(editionSwitcherEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(editionSwitcherEnabled({ NODE_ENV: "test", SCOUT_ENABLE_EDITION_SWITCHER: "true" })).toBe(true);
    expect(editionSwitcherEnabled({ NODE_ENV: "production", SCOUT_ENABLE_EDITION_SWITCHER: "true" })).toBe(false);
  });

  it("aligns score defaults with the resolved edition while honoring explicit scores", () => {
    expect(resolveSettings({ edition: "public" }).minRelevanceScore).toBe(0);
    expect(resolveSettings({ edition: "personal" }).minRelevanceScore).toBe(60);
    expect(resolveSettings({ edition: "invalid" as never }).edition).toBe("public");

    const previousEdition = process.env.SCOUT_EDITION;
    try {
      process.env.SCOUT_EDITION = "public";
      expect(parseCli([]).filters.minScore).toBe(0);
      expect(parseCli(["--min-score", "37"]).filters.minScore).toBe(37);
      process.env.SCOUT_EDITION = "personal";
      expect(parseCli([]).filters.minScore).toBe(60);
      process.env.SCOUT_EDITION = "invalid";
      expect(parseCli([]).filters.minScore).toBe(0);
    } finally {
      if (previousEdition === undefined) delete process.env.SCOUT_EDITION;
      else process.env.SCOUT_EDITION = previousEdition;
    }
  });

  it("only early-rejects strong nontechnical title evidence in personal mode", () => {
    const personal = decideListingAcquisition(
      { title: "Marketing Intern", snippet: "cold calling and social media campaign" },
      PERSONAL_EDITION_CONFIG,
    );
    const neutralTitle = decideListingAcquisition(
      { title: "Intern", snippet: "cold calling" },
      PERSONAL_EDITION_CONFIG,
    );
    const publicDecision = decideListingAcquisition(
      { title: "Marketing Intern" },
      PUBLIC_EDITION_CONFIG,
    );
    expect(personal.shouldFetchDetail).toBe(false);
    expect(personal.reason).toContain("early-reject");
    expect(neutralTitle.shouldFetchDetail).toBe(true);
    expect(publicDecision.shouldFetchDetail).toBe(true);
  });

  it.each([
    "Technology Intern",
    "Engineering Intern",
    "Research Intern",
    "Systems Intern",
    "Technical Intern",
    "Automation Intern",
  ])("keeps ambiguous personal listing %s on the detail path", (title) => {
    const decision = decideListingAcquisition({ title }, PERSONAL_EDITION_CONFIG);
    expect(decision.shouldFetchDetail).toBe(true);
    expect(decision.disposition).toBe("detail");
    expect(decision.reason).toContain("detail");
  });

  it("lets technical department or snippet evidence rescue a nontechnical title", () => {
    expect(decideListingAcquisition({
      title: "Marketing Intern",
      department: "Software Engineering",
    }, PERSONAL_EDITION_CONFIG).shouldFetchDetail).toBe(true);
    expect(decideListingAcquisition({
      title: "Accounting Intern",
      snippet: "Build Python data pipelines and write code for reporting automation.",
    }, PERSONAL_EDITION_CONFIG).shouldFetchDetail).toBe(true);
  });

  it("compiles preference sets once while preserving per-role matching", () => {
    const role = makeInternship();
    const canonicalBeforeMatching = JSON.stringify(role);
    const matcher = compileMatcher(completePreferences());
    const evaluations = matcher.evaluateMany([role, makeInternship({ id: "second" })]);
    expect(evaluations).toHaveLength(2);
    expect(matcher.diagnostics).toEqual({ evaluated: 2, userMatched: 2, userFiltered: 0 });
    expect(matcher.matches(role)).toBe(true);
    expect(matcher.diagnostics.evaluated).toBe(3);
    const differentUser = compileMatcher(completePreferences({ terms: [{ term: "winter", year: 2027 }] }));
    expect(differentUser.matches(role)).toBe(false);
    expect(differentUser.diagnostics).toEqual({ evaluated: 1, userMatched: 0, userFiltered: 1 });
    expect(JSON.stringify(role)).toBe(canonicalBeforeMatching);
  });

  it("classifies a fetched job identically in both editions, including a foreign location", async () => {
    const raw = {
      title: "Marketing Intern",
      company: "Example Labs",
      description: "This paid summer internship supports product marketing research, customer interviews, campaign analysis, and weekly reporting for the product organization.",
      locations: ["Paris, France"],
      postingUrl: "https://careers.example.test/jobs/marketing-intern",
      applicationUrl: "https://careers.example.test/jobs/marketing-intern",
      sourceProvider: "example",
    };
    const resolveApplicationUrl = async (url: string) => url;
    const analyzeFor = async (config: typeof PERSONAL_EDITION_CONFIG) => analyzeRawJob(
      raw,
      "https://careers.example.test/jobs",
      60,
      resolveApplicationUrl,
      "2026-08-30T12:00:00.000Z",
      config.canonicalAdmission,
    );
    const personal = await analyzeFor(PERSONAL_EDITION_CONFIG);
    const publicResult = await analyzeFor(PUBLIC_EDITION_CONFIG);
    expect(personal.accepted).toBe(true);
    expect(publicResult.accepted).toBe(true);
    if (!personal.accepted || !publicResult.accepted) return;
    expect(personal.value.internship).toEqual(publicResult.value.internship);
    expect(personal.value.internship.categories).toEqual(["other-internship"]);
    expect(personal.value.internship.normalizedLocations[0]?.country).toBe("France");
  });
});

describe("development edition switcher", () => {
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let getDashboardEditionForTests: typeof import("../src/dashboard.js").getDashboardEditionForTests;
  let getDashboardEditionSettingsForTests: typeof import("../src/dashboard.js").getDashboardEditionSettingsForTests;
  let roleForBrowserClientForTests: typeof import("../src/dashboard.js").roleForBrowserClientForTests;
  let setDashboardEditionForTests: typeof import("../src/dashboard.js").setDashboardEditionForTests;

  function response(): {
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer;
    writeHead(status: number, headers: Record<string, string>): void;
    end(body?: Buffer | string): void;
  } {
    return {
      statusCode: 0,
      headers: {},
      body: Buffer.alloc(0),
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
      },
    };
  }

  function request(
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    remoteAddress = "127.0.0.1",
    url = "/api/dev/edition",
  ): Record<string, unknown> {
    return {
      method,
      url,
      headers: {
        host: "127.0.0.1:4173",
        ...headers,
      },
      socket: { remoteAddress },
      ...(body === undefined ? {} : {
        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
          yield JSON.stringify(body);
        },
      }),
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.SCOUT_ENABLE_EDITION_SWITCHER = "true";
    process.env.SCOUT_EDITION = "public";
    ({ requestHandler, getDashboardEditionForTests, getDashboardEditionSettingsForTests, roleForBrowserClientForTests, setDashboardEditionForTests } = await import("../src/dashboard.js"));
  });

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.SCOUT_ENABLE_EDITION_SWITCHER = "true";
    setDashboardEditionForTests?.("public");
  });

  afterAll(() => {
    if (originalEnvironment.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment.NODE_ENV;
    if (originalEnvironment.SCOUT_ENABLE_EDITION_SWITCHER === undefined) delete process.env.SCOUT_ENABLE_EDITION_SWITCHER;
    else process.env.SCOUT_ENABLE_EDITION_SWITCHER = originalEnvironment.SCOUT_ENABLE_EDITION_SWITCHER;
    if (originalEnvironment.SCOUT_EDITION === undefined) delete process.env.SCOUT_EDITION;
    else process.env.SCOUT_EDITION = originalEnvironment.SCOUT_EDITION;
  });

  it("is 404 and immutable for both reads and writes in production", async () => {
    process.env.NODE_ENV = "production";
    const before = getDashboardEditionForTests();
    const read = response();
    await requestHandler(request("GET") as never, read as never, "/tmp/does-not-need-to-exist.db");
    expect(read.statusCode).toBe(404);
    const write = response();
    await requestHandler(request("POST", { edition: "personal" }) as never, write as never, "/tmp/does-not-need-to-exist.db");
    expect(write.statusCode).toBe(404);
    expect(getDashboardEditionForTests()).toBe(before);
  });

  it("stays hidden when disabled outside an explicitly safe development environment", async () => {
    process.env.NODE_ENV = "test";
    process.env.SCOUT_ENABLE_EDITION_SWITCHER = "false";
    expect(editionSwitcherEnabled(process.env)).toBe(false);
    const captured = response();
    await requestHandler(request("GET") as never, captured as never, "/tmp/unused.db");
    expect(captured.statusCode).toBe(404);
  });

  it("rejects non-loopback peers and Host headers without advertising the control", async () => {
    const remotePeer = response();
    await requestHandler(request("GET", undefined, {}, "192.0.2.10") as never, remotePeer as never, "/tmp/unused.db");
    expect(remotePeer.statusCode).toBe(404);

    const publicHost = response();
    await requestHandler(request("GET", undefined, { host: "scout.example.com" }) as never, publicHost as never, "/tmp/unused.db");
    expect(publicHost.statusCode).toBe(404);

    const missingPeer = response();
    await requestHandler({ ...request("GET"), socket: {} } as never, missingPeer as never, "/tmp/unused.db");
    expect(missingPeer.statusCode).toBe(404);

    const forwardedPeer = response();
    await requestHandler(request("GET", undefined, {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
    }, "192.0.2.10") as never, forwardedPeer as never, "/tmp/unused.db");
    expect(forwardedPeer.statusCode).toBe(404);
  });

  it("accepts same-origin IPv6 loopback but rejects mismatched ports and cross-site requests", async () => {
    const local = response();
    await requestHandler(request("POST", { edition: "personal" }, {
      host: "[::1]:4173",
      origin: "http://[::1]:4173",
    }, "::1") as never, local as never, "/tmp/unused.db");
    expect(local.statusCode).toBe(200);
    expect(getDashboardEditionForTests()).toBe("personal");

    for (const headers of [
      { origin: "http://127.0.0.1:9999" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const rejected = response();
      await requestHandler(request("POST", { edition: "public" }, headers) as never, rejected as never, "/tmp/unused.db");
      expect(rejected.statusCode).toBe(404);
      expect(getDashboardEditionForTests()).toBe("personal");
    }
  });

  it("validates same-origin local writes and changes the in-memory profile", async () => {
    const crossOrigin = response();
    await requestHandler(request("POST", { edition: "personal" }, { origin: "https://attacker.example" }) as never, crossOrigin as never, "/tmp/unused.db");
    expect(crossOrigin.statusCode).toBe(404);

    const invalid = response();
    await requestHandler(request("POST", { edition: "admin" }) as never, invalid as never, "/tmp/unused.db");
    expect(invalid.statusCode).toBe(400);

    const changed = response();
    await requestHandler(request("POST", { edition: "personal" }) as never, changed as never, "/tmp/unused.db");
    expect(changed.statusCode).toBe(200);
    expect(changed.headers["Cache-Control"]).toBe("no-store");
    expect(getDashboardEditionForTests()).toBe("personal");
    expect(getDashboardEditionSettingsForTests()).toEqual({ edition: "personal", minRelevanceScore: 60 });

    const read = response();
    await requestHandler(request("GET") as never, read as never, "/tmp/unused.db");
    expect(JSON.parse(read.body.toString("utf8"))).toMatchObject({ enabled: true, edition: "personal" });

    const backToPublic = response();
    await requestHandler(request("POST", { edition: "public" }) as never, backToPublic as never, "/tmp/unused.db");
    expect(backToPublic.statusCode).toBe(200);
    expect(getDashboardEditionSettingsForTests()).toEqual({ edition: "public", minRelevanceScore: 0 });
  });

  it("keeps crawler administration and source diagnostics server-side in public edition", async () => {
    setDashboardEditionForTests("public");
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const retiredSnapshot = response();
      await requestHandler(request(method, undefined, {}, "127.0.0.1", "/api/data") as never, retiredSnapshot as never, "/tmp/unused.db");
      expect(retiredSnapshot.statusCode).toBe(410);
      expect(retiredSnapshot.headers["Cache-Control"]).toBe("private, no-store");
    }
    for (const [method, pathname] of [
      ["POST", "/api/terminate"],
      ["POST", "/api/sources"],
      ["POST", "/api/refresh"],
      ["POST", "/api/scan"],
    ] as const) {
      const captured = response();
      await requestHandler(request(method, undefined, {}, "127.0.0.1", pathname) as never, captured as never, "/tmp/unused.db");
      expect(captured.statusCode, pathname).toBe(404);
      expect(captured.headers["Cache-Control"], pathname).toBe("no-store");
    }

    const canonicalRole = {
      id: "role-1",
      company: "Example Labs",
      sourceUrl: "https://private-source.example/jobs",
      listingSource: "https://private-source.example/feed",
      sources: [{ sourceUrl: "https://private-source.example/jobs", provider: "private" }],
      relevanceReason: "private classifier diagnostic",
      statusRunId: 42,
      missCount: 3,
      postingUrl: "https://careers.example/jobs/role-1",
    };
    expect(roleForBrowserClientForTests(canonicalRole)).toEqual({
      id: "role-1",
      company: "Example Labs",
      postingUrl: "https://careers.example/jobs/role-1",
    });

    setDashboardEditionForTests("personal");
    expect(roleForBrowserClientForTests(canonicalRole)).toEqual(canonicalRole);
  });
});
