import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

const { fchmodFailure } = vi.hoisted(() => ({ fchmodFailure: { enabled: false } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fchmodSync: (descriptor: number, fileMode: number) => {
      if (fchmodFailure.enabled) {
        const error = new Error("synthetic permission denial") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return actual.fchmodSync(descriptor, fileMode);
    },
  };
});

import {
  deleteResumeProfile,
  getResumeProfileDatabasePath,
  readResumeProfile,
  ResumeProfileStorageError,
  saveResumeProfile,
} from "../src/resume/profile.js";

const resume = {
  name: "Morgan Lee",
  contact: ["morgan@example.com", "416-555-0100"],
  education: [{ title: "University of Waterloo", subtitle: "BMath Computer Science", date: "2024–2028", bullets: [] }],
  experience: [{ title: "Software Intern", subtitle: "Northstar Labs", date: "Summer 2025", bullets: ["Built TypeScript services"] }],
  projects: [{ title: "Course Planner", subtitle: "React application", date: "2024", bullets: ["Built a course planner with React"] }],
  awards: ["Dean's List"],
  skills: [{ label: "Languages", items: ["TypeScript", "Python"] }],
};

const legacySchema = `
  CREATE TABLE resume_profiles (
    user_id TEXT PRIMARY KEY,
    resume_json TEXT NOT NULL,
    filename TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "scout-profile-storage-"));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function crawlerDatabaseSnapshot(databasePath: string): unknown {
  const database = new DatabaseSync(databasePath);
  try {
    return {
      applicationId: database.prepare("PRAGMA application_id").get(),
      schema: database.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
      `).all(),
      rows: database.prepare("SELECT id, payload FROM crawler_records ORDER BY id").all(),
    };
  } finally {
    database.close();
  }
}

function createCrawlerDatabase(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE crawler_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    database.prepare("INSERT INTO crawler_records VALUES (?, ?)").run("crawler-row", "retained");
  } finally {
    database.close();
  }
}

function insertLegacyProfile(databasePath: string, userId: string, name: string, updatedAt = "2026-09-01T00:00:00.000Z"): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(legacySchema);
    database.prepare("INSERT INTO resume_profiles VALUES (?, ?, ?, ?)")
      .run(userId, JSON.stringify({ ...resume, ownerEmail: `${userId}@example.com`, name }), `${userId}.pdf`, updatedAt);
  } finally {
    database.close();
  }
}

function seedDestinationProfile(databasePath: string, userId: string, name: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(legacySchema);
    database.prepare("INSERT INTO resume_profiles VALUES (?, ?, ?, ?)")
      .run(userId, JSON.stringify({ ...resume, ownerEmail: `${userId}@example.com`, name }), `${userId}-current.pdf`, "2026-10-01T12:00:00.000Z");
  } finally {
    database.close();
  }
}

afterEach(() => {
  fchmodFailure.enabled = false;
  vi.restoreAllMocks();
});

describe("private resume profile storage", () => {
  it("stores profiles beside the crawler database without creating or adding PII to it", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "not-created", "crawler.db");
    const profileDatabasePath = join(directory, "not-created", "crawler.db.resume-profiles.db");
    try {
      expect(getResumeProfileDatabasePath(databasePath)).toBe(resolve(databasePath) + ".resume-profiles.db");
      expect(getResumeProfileDatabasePath("relative/crawler.db")).toBe(resolve("relative/crawler.db") + ".resume-profiles.db");
      const saved = saveResumeProfile(databasePath, "student-a", "student@example.com", resume, "Morgan.pdf");

      expect(readResumeProfile(databasePath, "student-a")).toEqual(saved);
      expect(existsSync(databasePath)).toBe(false);
      expect(existsSync(profileDatabasePath)).toBe(true);

      const profileDb = new DatabaseSync(profileDatabasePath);
      try {
        const tables = profileDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        expect(tables.map(({ name }) => name)).toContain("resume_profiles");
        expect(profileDb.prepare("SELECT user_id FROM resume_profiles").all()).toEqual([{ user_id: "student-a" }]);
      } finally {
        profileDb.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("creates a mode-0600 profile database with a permissive umask", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    const previousUmask = process.umask(0);
    try {
      saveResumeProfile(databasePath, "student-a", "student@example.com", resume, "Morgan.pdf");
      expect(mode(getResumeProfileDatabasePath(databasePath))).toBe(0o600);
    } finally {
      process.umask(previousUmask);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves an existing crawler database without a resume profile table", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    try {
      createCrawlerDatabase(databasePath);
      saveResumeProfile(databasePath, "student-a", "student@example.com", resume, "Morgan.pdf");

      const crawlerDb = new DatabaseSync(databasePath);
      try {
        expect(crawlerDb.prepare("SELECT payload FROM crawler_records WHERE id = ?").get("crawler-row")).toEqual({ payload: "retained" });
        expect(crawlerDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resume_profiles'").get()).toBeUndefined();
      } finally {
        crawlerDb.close();
      }
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Morgan Lee");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a foreign database at the derived path without changing it, including when it is another crawler database", () => {
    const directory = tempDirectory();
    const firstCrawlerPath = join(directory, "first-crawler.db");
    const overlappingCrawlerPath = getResumeProfileDatabasePath(firstCrawlerPath);
    try {
      createCrawlerDatabase(firstCrawlerPath);
      // The first crawler's derived profile path is also configured here as a second crawler database.
      createCrawlerDatabase(overlappingCrawlerPath);
      const firstBefore = crawlerDatabaseSnapshot(firstCrawlerPath);
      const foreignBefore = crawlerDatabaseSnapshot(overlappingCrawlerPath);

      let saveFailure: unknown;
      try {
        saveResumeProfile(firstCrawlerPath, "student-a", "student@example.com", resume, "Morgan.pdf");
      } catch (error) {
        saveFailure = error;
      }
      expect(saveFailure).toBeInstanceOf(ResumeProfileStorageError);
      expect(saveFailure).toMatchObject({ message: "The saved resume profile is temporarily unavailable." });
      expect(String(saveFailure)).not.toContain(directory);

      let readFailure: unknown;
      try {
        readResumeProfile(firstCrawlerPath, "student-a");
      } catch (error) {
        readFailure = error;
      }
      expect(readFailure).toBeInstanceOf(ResumeProfileStorageError);
      expect(readFailure).toMatchObject({ message: "The saved resume profile is temporarily unavailable." });
      expect(String(readFailure)).not.toContain(directory);
      expect(crawlerDatabaseSnapshot(firstCrawlerPath)).toEqual(firstBefore);
      expect(crawlerDatabaseSnapshot(overlappingCrawlerPath)).toEqual(foreignBefore);

      const secondProfile = saveResumeProfile(overlappingCrawlerPath, "student-b", "second@example.com", { ...resume, name: "Second crawler profile" }, "second.pdf");
      expect(readResumeProfile(overlappingCrawlerPath, "student-b")).toEqual(secondProfile);
      expect(crawlerDatabaseSnapshot(overlappingCrawlerPath)).toEqual(foreignBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a marked profile database used as a crawler path without damaging the original profile", () => {
    const directory = tempDirectory();
    const crawlerPath = join(directory, "crawler.db");
    const profileDatabasePath = getResumeProfileDatabasePath(crawlerPath);
    try {
      const saved = saveResumeProfile(crawlerPath, "student-a", "student@example.com", resume, "Morgan.pdf");

      let failure: unknown;
      try {
        readResumeProfile(profileDatabasePath, "student-a");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ResumeProfileStorageError);
      expect(failure).toMatchObject({ message: "The saved resume profile is temporarily unavailable." });
      expect(String(failure)).not.toContain(directory);
      expect(readResumeProfile(crawlerPath, "student-a")).toEqual(saved);

      const originalProfileDb = new DatabaseSync(profileDatabasePath);
      try {
        expect(originalProfileDb.prepare("SELECT user_id FROM resume_profiles").all()).toEqual([{ user_id: "student-a" }]);
      } finally {
        originalProfileDb.close();
      }
      expect(existsSync(getResumeProfileDatabasePath(profileDatabasePath))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads and saves promptly when another connection holds a writer lock on a crawler database without legacy profiles", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    let keeper: DatabaseSync | undefined;
    try {
      createCrawlerDatabase(databasePath);
      keeper = new DatabaseSync(databasePath);
      keeper.exec("BEGIN IMMEDIATE; UPDATE crawler_records SET payload = 'uncommitted' WHERE id = 'crawler-row';");

      const startedAt = Date.now();
      saveResumeProfile(databasePath, "student-a", "student@example.com", resume, "Morgan.pdf");
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Morgan Lee");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      try {
        try { keeper?.exec("ROLLBACK"); } catch { /* The transaction may already have ended. */ }
        keeper?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform === "win32")("repairs readable database and active WAL/SHM sidecars when reopening storage", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    const profileDatabasePath = getResumeProfileDatabasePath(databasePath);
    const walPath = `${profileDatabasePath}-wal`;
    const shmPath = `${profileDatabasePath}-shm`;
    let keeper: DatabaseSync | undefined;
    try {
      saveResumeProfile(databasePath, "student-a", "student@example.com", resume, "Morgan.pdf");
      keeper = new DatabaseSync(profileDatabasePath);
      const journalMode = keeper.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
      keeper.exec("UPDATE resume_profiles SET updated_at = '2026-10-01T13:00:00.000Z' WHERE user_id = 'student-a';");
      expect(existsSync(walPath)).toBe(true);
      expect(existsSync(shmPath)).toBe(true);

      chmodSync(profileDatabasePath, 0o644);
      chmodSync(walPath, 0o644);
      chmodSync(shmPath, 0o644);
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Morgan Lee");

      expect(mode(profileDatabasePath)).toBe(0o600);
      expect(mode(walPath)).toBe(0o600);
      expect(mode(shmPath)).toBe(0o600);

      keeper.close();
      keeper = undefined;
      keeper = new DatabaseSync(profileDatabasePath);
      const deleteJournalMode = keeper.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
      expect(deleteJournalMode.journal_mode.toLowerCase()).toBe("delete");
      keeper.exec("BEGIN IMMEDIATE; UPDATE resume_profiles SET updated_at = '2026-10-02T00:00:00.000Z' WHERE user_id = 'student-a';");
      const journalPath = `${profileDatabasePath}-journal`;
      expect(existsSync(journalPath)).toBe(true);
      chmodSync(profileDatabasePath, 0o644);
      chmodSync(journalPath, 0o644);
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Morgan Lee");
      expect(mode(profileDatabasePath)).toBe(0o600);
      expect(mode(journalPath)).toBe(0o600);
    } finally {
      try {
        try { keeper?.exec("ROLLBACK"); } catch { /* The transaction may already have ended. */ }
        keeper?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform === "win32")("hardens actual crawler WAL/SHM files when the configured database path is a symlink", () => {
    const directory = tempDirectory();
    const crawlerTarget = join(directory, "actual-crawler.db");
    const crawlerAlias = join(directory, "configured-crawler.db");
    const targetWalPath = `${crawlerTarget}-wal`;
    const targetShmPath = `${crawlerTarget}-shm`;
    let keeper: DatabaseSync | undefined;
    try {
      createCrawlerDatabase(crawlerTarget);
      keeper = new DatabaseSync(crawlerTarget);
      const journalMode = keeper.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
      keeper.exec("BEGIN IMMEDIATE; UPDATE crawler_records SET payload = 'uncommitted' WHERE id = 'crawler-row';");
      expect(existsSync(targetWalPath)).toBe(true);
      expect(existsSync(targetShmPath)).toBe(true);
      chmodSync(crawlerTarget, 0o644);
      chmodSync(targetWalPath, 0o644);
      chmodSync(targetShmPath, 0o644);
      symlinkSync(crawlerTarget, crawlerAlias);

      expect(readResumeProfile(crawlerAlias, "missing-user")).toBeNull();

      expect(mode(crawlerTarget)).toBe(0o600);
      expect(mode(targetWalPath)).toBe(0o600);
      expect(mode(targetShmPath)).toBe(0o600);
      const aliasProfilePath = getResumeProfileDatabasePath(crawlerAlias);
      expect(existsSync(aliasProfilePath)).toBe(true);
      expect(existsSync(getResumeProfileDatabasePath(crawlerTarget))).toBe(false);
    } finally {
      try {
        try { keeper?.exec("ROLLBACK"); } catch { /* The transaction may already have ended. */ }
        keeper?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("keeps reads, updates, and deletes scoped to the requested account", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    try {
      const first = saveResumeProfile(databasePath, "student-a", "a@example.com", { ...resume, name: "Account A" }, "a.pdf");
      const second = saveResumeProfile(databasePath, "student-b", "b@example.com", { ...resume, name: "Account B" }, "b.pdf");

      expect(readResumeProfile(databasePath, "student-b")).toEqual(second);
      expect(readResumeProfile(databasePath, "student-b")).not.toEqual(first);
      saveResumeProfile(databasePath, "student-b", "b@example.com", { ...resume, name: "Updated B" }, "updated-b.pdf");
      expect(readResumeProfile(databasePath, "student-a")).toEqual(first);
      deleteResumeProfile(databasePath, "student-b");
      expect(readResumeProfile(databasePath, "student-b")).toBeNull();
      expect(readResumeProfile(databasePath, "student-a")).toEqual(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed with a safe error when the OS rejects private-file permission enforcement", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    const profileDatabasePath = getResumeProfileDatabasePath(databasePath);
    try {
      fchmodFailure.enabled = true;
      let failure: unknown;
      try {
        saveResumeProfile(databasePath, "student-a", "student@example.com", resume, "Morgan.pdf");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ResumeProfileStorageError);
      expect(failure).toMatchObject({ message: "The saved resume profile is temporarily unavailable." });
      expect(String(failure)).not.toContain(directory);
      expect(existsSync(databasePath)).toBe(false);

      fchmodFailure.enabled = false;
      const profileDb = new DatabaseSync(profileDatabasePath);
      try {
        expect(profileDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resume_profiles'").get()).toBeUndefined();
      } finally {
        profileDb.close();
      }
    } finally {
      fchmodFailure.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates identical account IDs across crawler databases in the same directory", () => {
    const directory = tempDirectory();
    const firstDatabase = join(directory, "first.db");
    const secondDatabase = join(directory, "second.db");
    try {
      saveResumeProfile(firstDatabase, "same-user", "user@example.com", { ...resume, name: "First crawler" }, "first.pdf");
      saveResumeProfile(secondDatabase, "same-user", "user@example.com", { ...resume, name: "Second crawler" }, "second.pdf");

      expect(getResumeProfileDatabasePath(firstDatabase)).not.toBe(getResumeProfileDatabasePath(secondDatabase));
      expect(readResumeProfile(firstDatabase, "same-user")?.resume.name).toBe("First crawler");
      expect(readResumeProfile(secondDatabase, "same-user")?.resume.name).toBe("Second crawler");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates every legacy account while preserving crawler data and an existing destination row", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    const profileDatabasePath = getResumeProfileDatabasePath(databasePath);
    try {
      createCrawlerDatabase(databasePath);
      insertLegacyProfile(databasePath, "student-a", "Migrated A");
      // Add the second legacy row without recreating the table.
      const legacyDb = new DatabaseSync(databasePath);
      try {
        legacyDb.prepare("INSERT INTO resume_profiles VALUES (?, ?, ?, ?)")
          .run("student-b", JSON.stringify({ ...resume, ownerEmail: "student-b@example.com", name: "Legacy B" }), "student-b.pdf", "2026-09-02T00:00:00.000Z");
      } finally {
        legacyDb.close();
      }
      seedDestinationProfile(profileDatabasePath, "student-b", "Destination B");

      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Migrated A");
      expect(readResumeProfile(databasePath, "student-b")?.resume.name).toBe("Destination B");

      const crawlerDb = new DatabaseSync(databasePath);
      try {
        expect(crawlerDb.prepare("SELECT payload FROM crawler_records WHERE id = ?").get("crawler-row")).toEqual({ payload: "retained" });
        expect(crawlerDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resume_profiles'").get()).toBeUndefined();
      } finally {
        crawlerDb.close();
      }
      const profileDb = new DatabaseSync(profileDatabasePath);
      try {
        expect(profileDb.prepare("SELECT COUNT(*) AS count FROM resume_profiles").get()).toEqual({ count: 2 });
      } finally {
        profileDb.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps legacy rows after a failed migration, retries successfully, and does not resurrect deleted data", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    const profileDatabasePath = getResumeProfileDatabasePath(databasePath);
    try {
      createCrawlerDatabase(databasePath);
      insertLegacyProfile(databasePath, "student-a", "Retry me");
      // A directory at the destination path makes SQLite fail consistently without relying on chmod or the test user's privileges.
      mkdirSync(profileDatabasePath);

      let failure: unknown;
      try {
        readResumeProfile(databasePath, "student-a");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ResumeProfileStorageError);
      expect(failure).toMatchObject({ message: "The saved resume profile is temporarily unavailable." });
      expect(String(failure)).not.toContain(directory);
      if (process.platform !== "win32") expect(mode(databasePath)).toBe(0o600);

      const stillLegacy = new DatabaseSync(databasePath);
      try {
        expect(stillLegacy.prepare("SELECT COUNT(*) AS count FROM resume_profiles").get()).toEqual({ count: 1 });
      } finally {
        stillLegacy.close();
      }

      rmSync(profileDatabasePath, { recursive: true, force: true });
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Retry me");
      deleteResumeProfile(databasePath, "student-a");
      expect(readResumeProfile(databasePath, "student-a")).toBeNull();
      expect(readResumeProfile(databasePath, "student-a")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("retains every source row after a destination insert failure and retries the complete migration", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "crawler.db");
    const profileDatabasePath = getResumeProfileDatabasePath(databasePath);
    try {
      // Create a recognized private destination before the crawler DB exists, then make
      // one legacy insert fail inside migration's destination transaction.
      saveResumeProfile(databasePath, "destination-user", "destination@example.com", { ...resume, name: "Existing destination" }, "existing.pdf");
      createCrawlerDatabase(databasePath);
      insertLegacyProfile(databasePath, "student-a", "Migrated A");
      const legacyDb = new DatabaseSync(databasePath);
      try {
        legacyDb.prepare("INSERT INTO resume_profiles VALUES (?, ?, ?, ?)")
          .run("student-b", JSON.stringify({ ...resume, ownerEmail: "student-b@example.com", name: "Migrated B" }), "student-b.pdf", "2026-09-02T00:00:00.000Z");
      } finally {
        legacyDb.close();
      }

      const destination = new DatabaseSync(profileDatabasePath);
      try {
        destination.exec(`
          CREATE TRIGGER reject_student_b BEFORE INSERT ON resume_profiles
          WHEN NEW.user_id = 'student-b'
          BEGIN SELECT RAISE(ABORT, 'migration fixture rejection'); END;
        `);
      } finally {
        destination.close();
      }

      let failure: unknown;
      try {
        readResumeProfile(databasePath, "student-a");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ResumeProfileStorageError);
      expect(failure).toMatchObject({ message: "The saved resume profile is temporarily unavailable." });
      expect(String(failure)).not.toContain(directory);
      expect(mode(databasePath)).toBe(0o600);

      const sourceAfterFailure = new DatabaseSync(databasePath);
      try {
        expect(sourceAfterFailure.prepare("SELECT COUNT(*) AS count FROM resume_profiles").get()).toEqual({ count: 2 });
      } finally {
        sourceAfterFailure.close();
      }

      const destinationAfterFailure = new DatabaseSync(profileDatabasePath);
      try {
        expect(destinationAfterFailure.prepare("SELECT user_id FROM resume_profiles").all()).toEqual([{ user_id: "destination-user" }]);
        destinationAfterFailure.exec("DROP TRIGGER reject_student_b");
      } finally {
        destinationAfterFailure.close();
      }
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Migrated A");
      expect(readResumeProfile(databasePath, "student-b")?.resume.name).toBe("Migrated B");
      expect(readResumeProfile(databasePath, "destination-user")?.resume.name).toBe("Existing destination");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
