import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTodayListings, ensureTodaySchema, readTodayVisit, recordTodayVisit, saveApplicationReminders,
  type TodayRole, type TodayApplication } from "../src/dashboard/today.js";
import { createAuthenticatedHarness, type AuthenticatedHarness } from "./authenticatedHarness.js";

const now = Date.parse("2026-10-08T01:30:00Z");
const since = "2026-10-06T16:00:00.000Z";
const role = (id: string, overrides: Partial<TodayRole> = {}): TodayRole => ({
  id, listingType: "internship", listingId: id, company: "Example", title: "Software Engineering Intern",
  firstSeenAt: "2026-10-07T16:00:00Z", availabilityStatus: "open", deadline: null,
  location: ["Toronto, Canada"], remoteStatus: "hybrid", salary: null,
  internshipTerm: "Summer", internshipYear: "2027", applicationUrl: "https://example.com/apply",
  postingUrl: "https://example.com/job", ...overrides,
});

describe("Today new listings", () => {
  it("shows only new open listings, newest first, using discovery timestamps", () => {
    const summary = buildTodayListings({ now, since, roles: [
      role("older", { firstSeenAt: "2026-10-06T17:00:00Z" }),
      role("newer"), role("same-time"),
      role("boundary", { firstSeenAt: since }),
      role("closed", { availabilityStatus: "closed" }),
      role("unknown", { availabilityStatus: "unknown" }),
      role("invalid", { firstSeenAt: "not-a-date" }),
      role("future", { firstSeenAt: "2026-11-01T00:00:00Z" }),
      { ...role("rescanned", { firstSeenAt: "2026-09-01T00:00:00Z" }), lastSeenAt: new Date(now).toISOString() },
    ] });
    expect(summary.counts).toEqual({ newListings: 3 });
    expect(summary.newListings.map((item) => item.id)).toEqual(["newer", "same-time", "older"]);
    expect(Object.keys(summary)).toEqual(["contract", "generatedAt", "since", "counts", "newListings"]);
  });

  it("covers the last seven days on a first visit and returns all listings without a 50-row cap", () => {
    const roles = Array.from({ length: 60 }, (_, index) => role(`listing-${index}`));
    const summary = buildTodayListings({ now, since: null, roles: [
      ...roles, role("old", { firstSeenAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString() }),
    ] });
    expect(summary.since).toBeNull();
    expect(summary.counts.newListings).toBe(60);
    expect(summary.newListings).toHaveLength(60);
    expect(summary.newListings.map((item) => item.id)).not.toContain("old");
  });

  it("stores monotonic visit checkpoints separately for every account", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureTodaySchema(db);
      recordTodayVisit(db, "one", since, undefined, Date.parse(since) + 1000);
      expect(readTodayVisit(db, "two")).toEqual({ visitedAt: null, savedRoles: [] });
      expect(readTodayVisit(db, "one")).toEqual({ visitedAt: since, savedRoles: [] });
      recordTodayVisit(db, "one", "2026-10-06T15:00:00Z", [], Date.parse(since));
      expect(readTodayVisit(db, "one").visitedAt).toBe(since);
      expect(() => recordTodayVisit(db, "one", "2026-11-01", [], now)).toThrow("Refresh Today");
    } finally { db.close(); }
  });

  it("keeps account-owned application reminders available in Applications", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE user_listing_actions (user_id TEXT, listing_key TEXT, action TEXT)");
      db.prepare("INSERT INTO user_listing_actions VALUES (?, ?, 'applied')").run("owner", "internship:one");
      expect(() => saveApplicationReminders(db, "other", "internship:one", since, null)).toThrow("not found");
      expect(() => saveApplicationReminders(db, "owner", "internship:one", "2026-10-08", null)).toThrow("timezone");
      saveApplicationReminders(db, "owner", "internship:one", since, null);
      expect(db.prepare("SELECT follow_up_at FROM user_application_reminders WHERE user_id = 'owner'").get()).toEqual({ follow_up_at: since });
    } finally { db.close(); }
  });
});

// Today routes are intentionally dormant; re-enable this suite with the feature.
describe.skip("Today routes and account data", () => {
  let harness: AuthenticatedHarness;
  const csrf = "t".repeat(43);
  beforeAll(async () => {
    harness = await createAuthenticatedHarness();
    const db = new DatabaseSync(harness.databasePath);
    try { db.prepare("UPDATE internships SET first_seen_at = ?").run(new Date(Date.now() - 60_000).toISOString()); }
    finally { db.close(); }
  });
  afterAll(async () => { await harness.close(); });
  const headers = (session: "complete" | "zero" = "complete") => ({ cookie: `${harness.sessionCookie(session)}; rr-csrf=${csrf}`,
    "x-csrf-token": csrf, "content-type": "application/json" });
  const post = (path: string, body: unknown, session: "complete" | "zero" = "complete") => harness.request(path, { method: "POST", headers: headers(session), body: JSON.stringify(body) });

  it("makes Today the verified home while protecting the page and APIs", async () => {
    harness.useSession("complete");
    for (const path of ["/jobs", "/post-login", "/onboarding"]) {
      expect((await harness.request(path)).response.headers.get("location"), path).toBe("/today");
    }
    const today = await harness.request("/today");
    expect(today.response.status).toBe(200);
    expect(today.text).toContain('id="today-title"');
    expect(today.text).toContain("Loading new listings…");
    expect(today.response.headers.get("cache-control")).toBe("no-store");
    harness.useSession("anonymous");
    expect((await harness.request("/today")).response.headers.get("location")).toContain("/login");
    expect((await harness.request("/api/today", { method: "POST", body: "{}", headers: { cookie: "" } })).response.status).toBe(401);
    expect((await harness.request("/api/today", { method: "POST", headers: { cookie: harness.sessionCookie("complete") }, body: "{}" })).response.status).toBe(403);
    expect((await harness.request("/today", { headers: { cookie: harness.sessionCookie("incomplete") } })).response.headers.get("location")).toBe("/onboarding");
    expect((await harness.request("/api/today", { method: "POST", headers: { ...headers(), cookie: `${harness.sessionCookie("unverified")}; rr-csrf=${csrf}` }, body: "{}" })).response.status).toBe(403);
  });

  it("reads the full new-listing feed without preference filtering or any external/model requests", async () => {
    const originalFetch = globalThis.fetch;
    const requests = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== harness.baseUrl) throw new Error(`Today attempted an external request: ${url.origin}`);
      return originalFetch(input, init);
    });
    try {
      const result = await post("/api/today", {});
      expect(result.response.status, result.text).toBe(200);
      const initial = JSON.parse(result.text) as { contract: string; since: null; counts: { newListings: number }; newListings: TodayRole[] };
      expect(initial.contract).toBe("dashboard.today.v2");
      expect(initial.since).toBeNull();
      expect(initial.counts.newListings).toBe(4);
      // This posting falls outside the account's selected internship term.
      expect(initial.newListings.map((item) => item.id)).toContain("match-ineligible");
      expect(Object.keys(initial.counts)).toEqual(["newListings"]);
      expect(initial).not.toHaveProperty("followUps");
      const other = await post("/api/today", {}, "zero");
      expect(other.response.status, other.text).toBe(200);
      expect((JSON.parse(other.text) as typeof initial).counts).toEqual(initial.counts);
    } finally { requests.mockRestore(); }
  });

  it("keeps visits account-specific and does not advance the checkpoint on failed loads", async () => {
    const initial = JSON.parse((await post("/api/today", {})).text) as { generatedAt: string; since: null; counts: { newListings: number } };
    expect((await post("/api/today", { since: "invalid-date" })).response.status).toBe(400);
    expect((JSON.parse((await post("/api/today", {})).text) as typeof initial).since).toBeNull();
    expect((await post("/api/today/visit", { visitedAt: initial.generatedAt })).response.status).toBe(200);
    const returning = JSON.parse((await post("/api/today", {})).text) as { since: string; counts: { newListings: number } };
    expect(returning.since).toBe(initial.generatedAt);
    expect(returning.counts.newListings).toBe(0);
    expect((JSON.parse((await post("/api/today", {}, "zero")).text) as typeof initial).since).toBeNull();
  });

  it("persists and clears real reminder dates in the application tracker", async () => {
    expect((await post("/api/actions", { listingType: "internship", listingId: "match-preferred", action: "applied", company: "Alpha Match", title: "Software Engineering Intern" })).response.status).toBe(200);
    const followUpAt = new Date(Date.now() - 1000).toISOString();
    const interviewAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const body = { listingType: "internship", listingId: "match-preferred", followUpAt, interviewAt };
    expect((await post("/api/applications/reminders", body, "zero")).response.status).toBe(400);
    expect((await post("/api/applications/reminders", body)).response.status).toBe(200);
    const tracker = JSON.parse((await harness.request("/api/applications", { headers: headers() })).text) as { applications: TodayApplication[] };
    expect(tracker.applications[0]?.interviewAt).toBe(interviewAt);
    expect((await post("/api/applications/reminders", { ...body, followUpAt: null, interviewAt: null })).response.status).toBe(200);
    const cleared = JSON.parse((await harness.request("/api/applications", { headers: headers() })).text) as typeof tracker;
    expect(cleared.applications[0]?.followUpAt).toBeNull();
    expect(cleared.applications[0]?.interviewAt).toBeNull();
  });
});
