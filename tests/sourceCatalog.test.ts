import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readConfiguredSourcesAtPath } from "../src/config/sourceCatalog.js";
import { InternshipDatabase } from "../src/database/db.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("configured source catalog", () => {
  it("includes a user-configured source in the recurring crawl catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-source-catalog-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "internships.db");
    const database = new InternshipDatabase(databasePath);
    database.configureSource("https://custom.example/careers/?utm_source=dashboard");
    database.close();

    expect(readConfiguredSourcesAtPath(databasePath)).toContain("https://custom.example/careers");
  });
});
