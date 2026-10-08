import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { readConfiguredSourcesAtPath } from "../src/config/sourceCatalog.js";
import { ZSHAH_DASHBOARD_URL, ZSHAH_README_URL, ZSHAH_REPOSITORY_URL } from "../src/config/zshahSource.js";
import { isRetiredInternListSource, RETIRED_JOBRIGHT_LIST_URL } from "../src/config/retiredSources.js";
import { InternshipDatabase } from "../src/database/db.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("configured source catalog", () => {
  it("replaces saved zshah repository URLs with one dashboard source while preserving history", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-zshah-catalog-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "internships.db");
    const database = new InternshipDatabase(databasePath);
    database.configureSource(ZSHAH_REPOSITORY_URL);
    database.configureSource(ZSHAH_README_URL);
    database.close();

    const catalog = readConfiguredSourcesAtPath(databasePath);
    expect(catalog.filter((source) => source.includes("zshah101"))).toEqual([ZSHAH_DASHBOARD_URL.replace(/\/$/, "")]);
    const stored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(stored.prepare("SELECT COUNT(*) AS count FROM sources WHERE url LIKE '%zshah101%' AND is_configured = 1").get()?.count).toBe(2);
    } finally { stored.close(); }
  });

  it("includes a user-configured source in the recurring crawl catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-source-catalog-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "internships.db");
    const database = new InternshipDatabase(databasePath);
    database.configureSource("https://custom.example/careers/?utm_source=dashboard");
    database.close();

    expect(readConfiguredSourcesAtPath(databasePath)).toContain("https://custom.example/careers");
  });

  it("ignores durable retired sources while preserving their historical rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-retired-catalog-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "internships.db");
    const database = new InternshipDatabase(databasePath);
    expect(() => database.configureSource(`${RETIRED_JOBRIGHT_LIST_URL}?count=50`)).toThrow(/retired/);
    database.close();
    const stored = new DatabaseSync(databasePath);
    const obsolete = ["https://www.intern-list.com/?k=swe", `${RETIRED_JOBRIGHT_LIST_URL}?position=50`, "https://jobright.ai/minisites-jobs/intern/us/swe?embed=true"];
    try {
      for (const url of obsolete) stored.prepare("INSERT INTO sources (url, created_at, is_configured) VALUES (?, ?, 1)").run(url, new Date().toISOString());
      const catalog = readConfiguredSourcesAtPath(databasePath);
      expect(catalog.some(isRetiredInternListSource)).toBe(false);
      expect(catalog.filter((source) => source.includes("intern-list.com") || source.includes("minisites-jobs/intern"))).toEqual(["https://www.intern-list.com/"]);
      expect(catalog).toContain("https://github.com/speedyapply/2027-AI-College-Jobs/blob/main/README.md");
      expect(stored.prepare("SELECT COUNT(*) AS count FROM sources WHERE is_configured = 1").get()?.count).toBe(obsolete.length);
    } finally { stored.close(); }
  });
});
