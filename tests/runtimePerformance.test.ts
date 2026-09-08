import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PriorityQueue } from "../src/crawler/queue.js";
import { backfillListingActionIdentities, ensureListingActionSchema, readPersistedListingActionIdentities } from "../src/database/actions.js";
import { InternshipSchema } from "../src/domain/schemas.js";
import type { CrawlQueueItem } from "../src/domain/types.js";
import { makeInternship } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

function queueItem(index: number, priority: number): CrawlQueueItem {
  return { url: `https://example.test/jobs/${index}`, sourceUrl: "https://example.test/jobs", referrerUrl: null, depth: 1, priority, reason: "test" };
}

describe("runtime performance contracts", () => {
  it("preserves stable priorities across interleaved discovery and dequeue", () => {
    const queue = new PriorityQueue();
    const expected: CrawlQueueItem[] = [];
    expect(queue.pop()).toBeUndefined();
    for (let index = 0; index < 1_500; index += 1) {
      const item = queueItem(index, (index * 7919) % 101 - 50);
      queue.push(item);
      expected.push(item);
      if (index % 3 === 0) {
        expected.sort((left, right) => right.priority - left.priority);
        expect(queue.pop()).toBe(expected.shift());
      }
      expect(queue.size).toBe(expected.length);
    }
    expected.sort((left, right) => right.priority - left.priority);
    for (const item of expected) expect(queue.pop()).toBe(item);
    expect(queue.size).toBe(0);
    expect(queue.pop()).toBeUndefined();
    const reused = queueItem(2_000, 0);
    queue.push(reused);
    expect(queue.pop()).toBe(reused);
  });

  it("keeps FIFO order for equal priorities, including infinite priorities", () => {
    const queue = new PriorityQueue();
    const items = [queueItem(0, Infinity), queueItem(1, 5), queueItem(2, Infinity), queueItem(3, 5), queueItem(4, -Infinity)];
    items.forEach((item) => queue.push(item));
    expect(items.map(() => queue.pop())).toEqual([items[0], items[2], items[1], items[3], items[4]]);
  });

  it("backfills only action-linked payloads and preserves missing/malformed listing fallbacks", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE internships (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)");
      ensureListingActionSchema(database);
      const insertRole = database.prepare("INSERT INTO internships VALUES (?, ?)");
      const linked = makeInternship({ id: "linked" });
      insertRole.run(linked.id, JSON.stringify(linked));
      insertRole.run("malformed", "invalid json");
      for (let index = 0; index < 100; index += 1) {
        insertRole.run(`unrelated-${index}`, JSON.stringify(makeInternship({ id: `unrelated-${index}` })));
      }
      const parse = vi.spyOn(InternshipSchema, "parse");
      backfillListingActionIdentities(database);
      expect(parse).not.toHaveBeenCalled();

      const insertAction = database.prepare(`
        INSERT INTO listing_actions (listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at)
        VALUES (?, 'internship', ?, 'applied', 'Northstar Labs', 'northstar labs', 'Software Engineering Intern', '2026-08-30T12:00:00.000Z')
      `);
      for (const id of ["linked", "missing", "malformed"]) insertAction.run(`internship:${id}`, id);
      backfillListingActionIdentities(database);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0]?.[0]).toMatchObject({ id: "linked" });
      const identities = readPersistedListingActionIdentities(database);
      expect(new Set(identities.map((identity) => identity.listingKey))).toEqual(new Set(["internship:linked", "internship:missing", "internship:malformed"]));
      expect(database.prepare("SELECT application_url, job_id FROM listing_actions WHERE listing_id = 'linked'").get()).toEqual({ application_url: linked.applicationUrl, job_id: linked.jobId });
      const before = readPersistedListingActionIdentities(database);
      backfillListingActionIdentities(database);
      expect(readPersistedListingActionIdentities(database)).toEqual(before);
    } finally {
      database.close();
    }
  });
});
