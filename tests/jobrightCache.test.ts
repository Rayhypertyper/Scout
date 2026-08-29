import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InternshipDatabase } from "../src/database/db.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Jobright destination cache", () => {
  it("makes a resolver result available by both Jobright URL and job id", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-cache-"));
    directories.push(directory);
    const databasePath = join(directory, "crawl.db");
    const database = new InternshipDatabase(databasePath);
    database.recordJobrightDestination(
      "https://jobright.ai/jobs/info/abc123",
      "https://careers.example.com/jobs/software-intern-abc123",
    );
    const destinations = database.getJobrightDestinations("https://www.intern-list.com/?k=swe");
    expect(destinations.get("https://jobright.ai/jobs/info/abc123")).toBe("https://careers.example.com/jobs/software-intern-abc123");
    expect(destinations.get("abc123")).toBe("https://careers.example.com/jobs/software-intern-abc123");
    database.close();
  });

  it("rejects another aggregator as the cached destination", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-cache-invalid-"));
    directories.push(directory);
    const database = new InternshipDatabase(join(directory, "crawl.db"));
    expect(() => database.recordJobrightDestination(
      "https://jobright.ai/jobs/info/abc123",
      "https://jobright.ai/jobs/info/other",
    )).toThrow("employer or ATS");
    database.close();
  });

  it("remembers recent failed attempts without treating them as destinations", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-cache-failed-"));
    directories.push(directory);
    const database = new InternshipDatabase(join(directory, "crawl.db"));
    database.recordJobrightDestination(
      "https://jobright.ai/jobs/info/failed123",
      null,
      "Original Job Post anchor was not present",
    );
    expect(database.getJobrightDestinations("https://www.intern-list.com/?k=swe").has("failed123")).toBe(false);
    expect(database.getJobrightResolutionKeys().has("failed123")).toBe(true);
    database.close();
  });
});
