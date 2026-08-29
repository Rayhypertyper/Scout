import { describe, expect, it } from "vitest";

import {
  isNewSinceLastScan,
  isRecentListing,
  isWithinRecentListingWindow,
  RECENT_LISTING_WINDOW_MS,
} from "../public/newRole.js";
import { makeInternship } from "./helpers.js";

describe("dashboard new-role banner", () => {
  it("keeps a role marked new until the 16-hour listing set drops it", () => {
    const role = {
      ...makeInternship({ lifecycleStatus: "UNCHANGED" }),
      listingType: "internship",
      listingId: "job-1",
      statusRunId: 12,
    };

    expect(isNewSinceLastScan(role, {
      latestCompletedRun: { id: 12 },
      newListingKeys: ["internship:job-1"],
    })).toBe(true);
    expect(isNewSinceLastScan(role, {
      latestCompletedRun: { id: 13 },
      newListingKeys: [],
    })).toBe(false);
  });

  it("shows a listing found in the active run immediately", () => {
    const role = {
      ...makeInternship({ lifecycleStatus: "NEW" }),
      listingType: "internship",
      listingId: "job-2",
      statusRunId: 14,
    };

    expect(isNewSinceLastScan(role, {
      latestCompletedRun: { id: 13 },
      latestRun: { id: 14, status: "RUNNING" },
      newListingKeys: ["internship:job-2"],
    })).toBe(true);
  });

  it("keeps a derived NEW state when the stored lifecycle was updated later in the same run", () => {
    const role = {
      ...makeInternship({ lifecycleStatus: "UNCHANGED" }),
      listingType: "internship",
      listingId: "job-3",
      statusRunId: 15,
    };

    expect(isNewSinceLastScan(role, {
      latestCompletedRun: { id: 14 },
      latestRun: { id: 15, status: "RUNNING" },
      newListingKeys: ["internship:job-3"],
    })).toBe(true);
  });

  it("marks a listing recent when its posting date is inside the 24-hour window", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const role = {
      ...makeInternship({
        lifecycleStatus: "UNCHANGED",
        postingDate: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
        discoveredAt: new Date(now - 3 * 86_400_000).toISOString(),
      }),
      isNew: false,
    };

    expect(isRecentListing(role, {}, now)).toBe(true);
    expect(isWithinRecentListingWindow("Posting Date: 2026-08-20", now)).toBe(true);
  });

  it("marks a listing recent when it was found inside the 24-hour window", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const role = {
      ...makeInternship({
        lifecycleStatus: "UNCHANGED",
        postingDate: null,
        discoveredAt: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
      }),
      isNew: false,
    };

    expect(isRecentListing(role, {}, now)).toBe(true);
  });

  it("does not mark expired or future timestamps as recent", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");

    expect(isWithinRecentListingWindow(new Date(now - RECENT_LISTING_WINDOW_MS).toISOString(), now)).toBe(false);
    expect(isWithinRecentListingWindow(new Date(now + 1_000).toISOString(), now)).toBe(false);
    expect(isRecentListing({ isNew: false, postingDate: "2 days ago", discoveredAt: "3 days ago" }, {}, now)).toBe(false);
  });
});
