import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import { runScout } from "../src/scout.js";
import { analyzed, makeInternship } from "./helpers.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function options(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scout-ready-listing-"));
  directories.push(directory);
  return {
    sources: [source],
    settings: resolveSettings({
      databasePath: join(directory, "crawl.db"), outputDirectory: directory,
      respectRobotsTxt: false, retryCount: 0, perHostDelayMs: 0,
      httpConcurrency: 2, perDomainConcurrency: 2, maxDepth: 1,
    }),
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
}

function detail(id: string) {
  return `<html><script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "Software Engineering Intern - Summer 2027",
    hiringOrganization: { name: `Ready ${id} Labs` }, identifier: id,
    description: "Develop and test Python software services, build APIs and debug production applications. Collaborate with software engineers during this summer internship.",
    jobLocation: { address: { addressLocality: "Toronto", addressRegion: "ON", addressCountry: "Canada" } },
  })}</script><a href="https://jobs.example.test/${id}/apply">Apply</a></html>`;
}

describe("ready listing publication", () => {
  it.each([
    "https://example.test/careers",
    "https://www.applybolt.app/jobs/2027-internships",
  ])("publishes a ready detail before a slow sibling finishes for %s", async (source) => {
    const opts = options(source);
    const controller = new AbortController();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/job/slow")) {
        await Promise.race([slow, new Promise<never>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })]);
      }
      const body = url === source
        ? '<main><a href="/job/fast">Software Engineering Intern</a><a href="/job/slow">Software Engineering Intern</a></main>'
        : detail(url.includes("slow") ? "slow" : "fast");
      return new Response(body, { headers: { "content-type": "text/html" } });
    });
    const settled = vi.fn();
    const execution = runScout({ ...opts, cancellationSignal: controller.signal, onSourceSettled: settled });
    // Attach rejection handling immediately so a failed assertion can safely cancel the worker.
    const outcome = execution.then((value) => ({ value }), (error: unknown) => ({ error }));
    const reader = new DatabaseSync(opts.settings.databasePath, { readOnly: true });
    try {
      await vi.waitFor(() => {
        const rows = reader.prepare("SELECT company, payload_json FROM internships").all() as Array<{ company: string; payload_json: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.company).toBe("Ready fast Labs");
        const payload = JSON.parse(rows[0]!.payload_json) as { salary: unknown; deadline: unknown; sponsorshipInformation: unknown };
        expect(payload).toMatchObject({ salary: null, deadline: null, sponsorshipInformation: null });
      }, { timeout: 5_000 });
      expect(reader.prepare("SELECT status FROM crawl_runs").get()).toMatchObject({ status: "RUNNING" });
      expect(reader.prepare("SELECT settled FROM source_run_results").get()).toMatchObject({ settled: 0 });
      expect(settled).not.toHaveBeenCalled();
      releaseSlow();
      const result = await execution;
      expect(result.persisted.counts.NEW).toBe(2);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM internships").get()).toMatchObject({ count: 2 });
      expect(reader.prepare("SELECT DISTINCT lifecycle_status FROM internships").all()).toEqual([{ lifecycle_status: "NEW" }]);
    } finally {
      controller.abort();
      releaseSlow();
      await outcome;
      reader.close();
    }
  });

  it("retains published jobs after cancellation and rejects later writes", () => {
    const opts = options("https://example.test/careers");
    const database = new InternshipDatabase(opts.settings.databasePath);
    try {
      const runId = database.startRun(opts);
      const job = analyzed(makeInternship({ sourceUrl: opts.sources[0]!, sources: opts.sources }));
      database.persistReadyJobs(runId, [job, job]);
      database.markRunCancelled(runId);
      expect(database.getRunInternships(runId)).toHaveLength(1);
      expect(database.getRunInternships(runId)[0]?.lifecycleStatus).toBe("NEW");
      expect(() => database.persistReadyJobs(runId, [job])).toThrow("no longer running");
    } finally { database.close(); }
  });
});
