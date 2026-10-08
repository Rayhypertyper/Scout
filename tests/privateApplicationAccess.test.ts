import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureListingActionSchema, LISTING_ACTIONS_SCHEMA } from "../src/database/actions.js";
import { createAuthenticatedHarness, type AuthenticatedHarness } from "./authenticatedHarness.js";

describe("private application API boundary", () => {
  let harness: AuthenticatedHarness;
  const csrf = "a".repeat(43);

  beforeAll(async () => { harness = await createAuthenticatedHarness(); });
  afterAll(async () => { await harness.close(); });

  const headers = (session: "complete" | "zero") => ({
    cookie: `${harness.sessionCookie(session)}; rr-csrf=${csrf}`,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  });
  const application = (session: "complete" | "zero", listingId = "match-preferred") => harness.request("/api/actions", {
    method: "POST", headers: headers(session),
    body: JSON.stringify({ listingType: "internship", listingId, action: "applied",
      company: "Alpha Match", title: "Software Engineering Intern", userId: "e2e-zero-user" }),
  });
  const applications = async (session: "complete" | "zero") => {
    const result = await harness.request("/api/applications", { headers: headers(session) });
    expect(result.response.status).toBe(200);
    return JSON.parse(result.text) as { applications: Array<{ listingId: string; stage: string }>; counts: { all: number } };
  };
  const roles = async (session?: "complete" | "zero", etag?: string) => {
    const result = await harness.request("/api/roles?tab=main&status=open&limit=100", {
      headers: { cookie: session ? harness.sessionCookie(session) : "", ...(etag ? { "if-none-match": etag } : {}) },
    });
    expect(result.response.status).toBe(200);
    return { result, payload: JSON.parse(result.text) as { items: Array<{ id: string }>; appliedRoleCount: number } };
  };

  it("rejects anonymous, invalid, and unverified sessions before private reads or writes", async () => {
    for (const cookie of ["", "rr-e2e-session=invalid", harness.sessionCookie("unverified")]) {
      for (const [method, path] of [["GET", "/api/applications"], ["HEAD", "/api/applications"],
        ["POST", "/api/actions"], ["DELETE", "/api/actions?listingType=internship&listingId=match-preferred"],
        ["POST", "/api/applications/status"]]) {
        const result = await harness.request(path!, { method: method!, headers: { cookie } });
        expect(result.response.status).toBe(cookie.includes("unverified") ? 403 : 401);
        expect(result.response.headers.get("cache-control")).toContain("no-store");
        if (method === "HEAD") expect(result.text).toBe("");
        else expect(result.text).not.toContain('"applications":');
      }
    }
  });

  it("retires the full snapshot for every method and session", async () => {
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const result = await harness.request("/api/data", { method, headers: headers("complete") });
      expect(result.response.status).toBe(410);
      expect(result.response.headers.get("cache-control")).toBe("private, no-store");
      expect(result.text.length).toBeLessThan(200);
    }
  });

  it("requires same-origin CSRF protection for account mutations", async () => {
    for (const path of ["/api/actions", "/api/applications/status"]) {
      const missing = await harness.request(path, { method: "POST", headers: { cookie: harness.sessionCookie("complete") } });
      expect(missing.response.status).toBe(403);
      expect(missing.text).toContain("CSRF_INVALID");
      const crossSite = await harness.request(path, {
        method: "POST", headers: { ...headers("complete"), origin: "https://attacker.example" },
      });
      expect(crossSite.response.status).toBe(403);
    }
    expect((await applications("complete")).counts.all).toBe(0);
  });

  it("isolates tracker rows, feed hiding, counts, and validators between accounts", async () => {
    const saved = await application("complete");
    expect(saved.response.status, saved.text).toBe(200);
    expect((await applications("complete")).applications.map((row) => row.listingId)).toEqual(["match-preferred"]);
    expect((await applications("zero")).counts.all).toBe(0);

    const firstFeed = await roles("complete");
    expect(firstFeed.payload.items.map((row) => row.id)).not.toContain("match-preferred");
    expect(firstFeed.payload.appliedRoleCount).toBe(1);
    const secondFeed = await roles("zero", firstFeed.result.response.headers.get("etag")!);
    expect(secondFeed.payload.items.map((row) => row.id)).toContain("match-preferred");
    expect(secondFeed.payload.appliedRoleCount).toBe(0);
    expect(secondFeed.result.response.headers.get("etag")).not.toBe(firstFeed.result.response.headers.get("etag"));
    expect(secondFeed.result.response.headers.get("vary")).toContain("Cookie");
    const publicFeed = await roles();
    expect(publicFeed.payload.items.map((row) => row.id)).toContain("match-preferred");
    expect(publicFeed.payload.appliedRoleCount).toBe(0);

    const changes = await Promise.all(["complete", "zero"].map((session) => harness.request("/api/changes", {
      headers: headers(session as "complete" | "zero"),
    })));
    expect(changes.map((result) => (JSON.parse(result.text) as { appliedRoleCount: number }).appliedRoleCount)).toEqual([1, 0]);
    const repeated = await Promise.all(Array.from({ length: 8 }, (_, index) => applications(index % 2 ? "zero" : "complete")));
    expect(repeated.map((result) => result.counts.all)).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it("cannot update or undo another account's rows and allows both to track the same listing", async () => {
    const foreignStage = await harness.request("/api/applications/status", {
      method: "POST", headers: headers("zero"),
      body: JSON.stringify({ listingType: "internship", listingId: "match-preferred", stage: "offer", user_id: "e2e-complete-user" }),
    });
    expect(foreignStage.response.status).toBe(400);
    const foreignUndo = await harness.request("/api/actions?listingType=internship&listingId=match-preferred&userId=e2e-complete-user", {
      method: "DELETE", headers: headers("zero"),
    });
    expect(foreignUndo.response.status, foreignUndo.text).toBe(200);
    expect((JSON.parse(foreignUndo.text) as { removed: boolean }).removed).toBe(false);
    expect((await applications("complete")).counts.all).toBe(1);

    expect((await application("zero")).response.status).toBe(200);
    const stage = await harness.request("/api/applications/status", {
      method: "POST", headers: headers("complete"),
      body: JSON.stringify({ listingType: "internship", listingId: "match-preferred", stage: "interview" }),
    });
    expect(stage.response.status, stage.text).toBe(200);
    expect((await applications("complete")).applications[0]?.stage).toBe("interview");
    expect((await applications("zero")).applications[0]?.stage).toBe("applied");
    const undo = await harness.request("/api/actions?listingType=internship&listingId=match-preferred", {
      method: "DELETE", headers: headers("complete"),
    });
    expect(undo.response.status, undo.text).toBe(200);
    expect((await applications("complete")).counts.all).toBe(0);
    expect((await applications("zero")).counts.all).toBe(1);
    const database = new DatabaseSync(harness.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT DISTINCT user_id FROM user_listing_action_identities").all()).toEqual([{ user_id: "e2e-zero-user" }]);
    } finally { database.close(); }
  });

  it("keeps offline legacy decisions out of public and account responses", async () => {
    const database = new DatabaseSync(harness.databasePath);
    try {
      database.exec(`INSERT INTO listing_actions
        (listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at)
        VALUES ('internship:match-secondary', 'internship', 'match-secondary', 'applied',
          'Legacy Private Company', 'legacy private company', 'Private application', '2026-01-01')`);
    } finally { database.close(); }
    const publicFeed = await roles();
    expect(publicFeed.payload.items.map((row) => row.id)).toContain("match-secondary");
    expect(publicFeed.payload.appliedRoleCount).toBe(0);
    expect((await applications("complete")).counts.all).toBe(0);
    expect((await applications("zero")).counts.all).toBe(1);
    const parallelFeeds = await Promise.all(Array.from({ length: 6 }, (_, index) => roles(index % 2 ? "zero" : "complete")));
    expect(parallelFeeds.map((feed) => feed.payload.appliedRoleCount)).toEqual([0, 1, 0, 1, 0, 1]);
  });
});

describe("legacy action migration", () => {
  it("quarantines unowned data without giving it to any account, idempotently", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(LISTING_ACTIONS_SCHEMA);
      database.exec(`INSERT INTO listing_actions (listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at)
        VALUES ('internship:private', 'internship', 'private', 'applied', 'Private Company', 'private', 'Intern', '2026-01-01')`);
      ensureListingActionSchema(database);
      ensureListingActionSchema(database);
      expect(database.prepare("SELECT company FROM legacy_listing_actions_quarantine").all()).toEqual([{ company: "Private Company" }]);
      expect(database.prepare("SELECT * FROM user_listing_actions").all()).toEqual([]);
    } finally { database.close(); }
  });

  it("preserves explicit legacy ownership, quarantines the legacy sentinel, and never reimports deleted rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const schema = LISTING_ACTIONS_SCHEMA
        .replace("listing_key TEXT PRIMARY KEY,", "user_id TEXT NOT NULL, listing_key TEXT NOT NULL,")
        .replace("UNIQUE(listing_type, listing_id)", "PRIMARY KEY (user_id, listing_key), UNIQUE(user_id, listing_type, listing_id)")
        .replace("CREATE TABLE IF NOT EXISTS listing_action_identities (", "CREATE TABLE IF NOT EXISTS listing_action_identities (user_id TEXT NOT NULL,")
        .replace("PRIMARY KEY (listing_key, identity_key)", "PRIMARY KEY (user_id, listing_key, identity_key)");
      database.exec(schema);
      const insert = database.prepare(`INSERT INTO listing_actions
        (user_id, listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at)
        VALUES (?, 'internship:shared', 'internship', 'shared', 'applied', 'Company', 'company', 'Intern', '2026-01-01')`);
      for (const user of ["user-a", "user-b", "__legacy__"]) insert.run(user);
      ensureListingActionSchema(database);
      expect(database.prepare("SELECT user_id FROM user_listing_actions ORDER BY user_id").all()).toEqual([{ user_id: "user-a" }, { user_id: "user-b" }]);
      expect(database.prepare("SELECT user_id FROM legacy_listing_actions_quarantine").all()).toEqual([{ user_id: "__legacy__" }]);
      database.exec("DELETE FROM user_listing_actions WHERE user_id = 'user-a'");
      ensureListingActionSchema(database);
      expect(database.prepare("SELECT user_id FROM user_listing_actions").all()).toEqual([{ user_id: "user-b" }]);
    } finally { database.close(); }
  });
});
