import { describe, expect, it } from "vitest";

import { clearListingSnapshots, LISTING_SNAPSHOT_KEY, LISTING_SNAPSHOT_MAX_AGE_MS, readListingSnapshot, rememberListingSnapshot } from "../public/app/listing-snapshot.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const card = { id: "role-1", listingId: "role-1", listingType: "internship", company: "Example", title: "Software Intern", applicationUrl: "https://example.com/jobs/1" };
const payload = { filters: { view: "all" }, items: [card], pagination: { total: 200, nextOffset: 40, hasMore: true }, version: "old-version" };

describe("return-visit listing previews", () => {
  it("restores an hours-old preview without restoring pagination offsets or validators", () => {
    const target = storage();
    rememberListingSnapshot("canada", payload, { storage: target, now: 100 });
    const snapshot = readListingSnapshot("canada", { storage: target, now: 100 + 4 * 60 * 60 * 1_000 });
    expect(snapshot?.items).toEqual([card]);
    expect(snapshot?.pagination).toMatchObject({ total: 1, hasMore: false, nextOffset: null });
    expect(snapshot).not.toHaveProperty("version");
    expect(readListingSnapshot("different-filters", { storage: target, now: 100 })).toBeNull();
  });

  it("persists public card facts without account actions, matching, auth, or resume data", () => {
    const target = storage();
    rememberListingSnapshot("all", { ...payload, user: { email: "private@example.com" }, csrfToken: "secret",
      items: [{ ...card, action: "applied", actionContext: { userId: "private-user" }, matchScore: 90,
        eligibility: { criterionResults: ["private preference"] }, description: "Large detail payload", resume: "private resume" }],
    }, { storage: target, now: 100 });
    expect(readListingSnapshot("all", { storage: target, now: 100 })?.items).toEqual([card]);
    expect(target.getItem(LISTING_SNAPSHOT_KEY)).not.toMatch(/private|secret|matchScore|description|actionContext/);
    expect(rememberListingSnapshot("matches", { ...payload, filters: { view: "matches" } }, { storage: target })).toBe(false);
    expect(readListingSnapshot("matches", { storage: target })).toBeNull();
  });

  it("rejects expired, future, corrupt, or unavailable storage without interrupting live reads", () => {
    const target = storage();
    rememberListingSnapshot("all", payload, { storage: target, now: 100 });
    expect(readListingSnapshot("all", { storage: target, now: 99 })).toBeNull();
    expect(readListingSnapshot("all", { storage: target, now: 101 + Number(LISTING_SNAPSHOT_MAX_AGE_MS) })).toBeNull();
    target.setItem(LISTING_SNAPSHOT_KEY, "{broken");
    expect(readListingSnapshot("all", { storage: target })).toBeNull();
    expect(rememberListingSnapshot("all", payload, { storage: target, now: 200 })).toBe(true);
    expect(readListingSnapshot("all", { storage: target, now: 200 })?.items).toEqual([card]);
    const denied = { getItem(): string | null { throw new Error("Storage denied"); }, setItem() { throw new Error("Storage denied"); }, removeItem() { throw new Error("Storage denied"); } };
    expect(readListingSnapshot("all", { storage: denied })).toBeNull();
    expect(rememberListingSnapshot("all", payload, { storage: denied })).toBe(false);
    expect(() => clearListingSnapshots({ storage: denied })).not.toThrow();
  });

  it("bounds cached views and cards, removes obsolete empty views, and clears after decisions", () => {
    const target = storage();
    for (let index = 0; index < 8; index += 1) rememberListingSnapshot(`view-${index}`, {
      ...payload, items: Array.from({ length: 100 }, (_, id) => ({ ...card, id: `role-${id}`, listingId: `role-${id}` })),
    }, { storage: target, now: 100 + index });
    expect(readListingSnapshot("view-0", { storage: target, now: 200 })).toBeNull();
    expect(readListingSnapshot("view-7", { storage: target, now: 200 })?.items).toHaveLength(40);
    rememberListingSnapshot("view-7", { ...payload, items: [] }, { storage: target, now: 200 });
    expect(readListingSnapshot("view-7", { storage: target, now: 200 })).toBeNull();
    clearListingSnapshots({ storage: target });
    expect(target.getItem(LISTING_SNAPSHOT_KEY)).toBeNull();
  });
});
