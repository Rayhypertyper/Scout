/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";

// @ts-expect-error The browser client is JavaScript and has no emitted declaration file.
import { formatPosted, shouldRefreshRoleListings } from "../public/app.js";

describe("listing freshness", () => {
  it("refreshes published listings during a crawl without refreshing for heartbeats", () => {
    expect(shouldRefreshRoleListings("cards-1", "cards-2", "status-1", "status-2", true)).toBe(true);
    expect(shouldRefreshRoleListings("cards-1", "cards-1", "status-1", "heartbeat-2", true)).toBe(false);
    // A stale catalog response must be retried even when the status version is unchanged.
    expect(shouldRefreshRoleListings("cards-1", "cards-2", "status-2", "status-2", true)).toBe(true);
    expect(shouldRefreshRoleListings("cards-1", "cards-1", "status-1", "status-2", false)).toBe(true);
    expect(shouldRefreshRoleListings(null, null, "status-1", "status-2", true)).toBe(true);
  });

  it("does not invent hour precision from a calendar posting date", () => {
    const now = new Date(2026, 9, 5, 13, 30).valueOf();
    expect(formatPosted("2026-10-05", now)).toBe("Today");
    expect(formatPosted("Posted: 2026-10-05", now)).toBe("Today");
    expect(formatPosted("2026-10-04", now)).toBe("1d ago");
    expect(formatPosted(new Date(2026, 9, 5, 11, 30).toISOString(), now)).toBe("2h ago");
    // Calendar arithmetic still shows one day across a daylight-saving transition.
    expect(formatPosted("2026-11-01", new Date(2026, 10, 2, 0, 30).valueOf())).toBe("1d ago");
  });
});
