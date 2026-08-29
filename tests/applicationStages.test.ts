import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ensureListingActionSchema } from "../src/database/actions.js";
import {
  applicationStageFromLegacyStatus,
  isApplicationStage,
  legacyApplicationStatusForStage,
} from "../src/domain/applicationStages.js";

describe("application stages", () => {
  it("keeps the funnel vocabulary and maps legacy outcomes safely", () => {
    expect(isApplicationStage("applied")).toBe(true);
    expect(isApplicationStage("interview")).toBe(true);
    expect(isApplicationStage("accepted")).toBe(false);
    expect(applicationStageFromLegacyStatus("pending")).toBe("applied");
    expect(applicationStageFromLegacyStatus("accepted")).toBe("offer");
    expect(applicationStageFromLegacyStatus("rejected")).toBe("rejected");
    expect(legacyApplicationStatusForStage("interview")).toBe("pending");
    expect(legacyApplicationStatusForStage("offer")).toBe("accepted");
  });

  it("backfills existing binary outcomes when the action schema gains stages", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE listing_actions (
          listing_key TEXT PRIMARY KEY,
          listing_type TEXT NOT NULL,
          listing_id TEXT NOT NULL,
          action TEXT NOT NULL,
          application_status TEXT NOT NULL DEFAULT 'pending',
          company TEXT NOT NULL,
          normalized_company TEXT NOT NULL,
          title TEXT NOT NULL,
          application_url TEXT,
          posting_url TEXT,
          job_id TEXT,
          location TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO listing_actions (listing_key, listing_type, listing_id, action, application_status, company, normalized_company, title, created_at)
        VALUES
          ('internship:legacy-offer', 'internship', 'legacy-offer', 'applied', 'accepted', 'Acme', 'acme', 'Intern', '2026-08-20T00:00:00.000Z'),
          ('internship:legacy-rejected', 'internship', 'legacy-rejected', 'applied', 'rejected', 'Beta', 'beta', 'Intern', '2026-08-20T00:00:00.000Z'),
          ('internship:legacy-pending', 'internship', 'legacy-pending', 'applied', 'pending', 'Gamma', 'gamma', 'Intern', '2026-08-20T00:00:00.000Z');
      `);
      ensureListingActionSchema(database);
      expect(database.prepare("SELECT listing_key, application_stage FROM listing_actions ORDER BY listing_key").all()).toEqual([
        { listing_key: "internship:legacy-offer", application_stage: "offer" },
        { listing_key: "internship:legacy-pending", application_stage: "applied" },
        { listing_key: "internship:legacy-rejected", application_stage: "rejected" },
      ]);
    } finally {
      database.close();
    }
  });
});
