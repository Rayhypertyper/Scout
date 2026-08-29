import { describe, expect, it } from "vitest";

import {
  CLOSING_SOON_WINDOW_MS,
  buildClosingSoonNotifications,
  nextClosingSoonRefreshAt,
  parseDeadlineTimestamp,
} from "../src/dashboardDeadlines.js";
import { makeInternship } from "./helpers.js";

describe("dashboard closing-soon deadlines", () => {
  const now = Date.parse("2026-08-23T12:00:00.000Z");

  it("parses timestamp, numeric, named, and date-only deadline evidence", () => {
    expect(parseDeadlineTimestamp("2026-08-24T18:30:00.000Z", now)).toBe(Date.parse("2026-08-24T18:30:00.000Z"));
    expect(parseDeadlineTimestamp("11/06/2026, 12:00 AM", now)).toBe(new Date(2026, 10, 6, 0, 0, 0).valueOf());
    expect(parseDeadlineTimestamp("Application Deadline: September 1, 2026 at 11:59 pm EST", now)).toBe(
      Date.parse("2026-09-02T04:59:00.000Z"),
    );
    expect(parseDeadlineTimestamp("2026-08-24", now)).toBe(new Date(2026, 7, 24, 23, 59, 59, 999).valueOf());
    expect(parseDeadlineTimestamp("Candidates who apply by this date", now)).toBeNull();
  });

  it("returns only open roles with a strict less-than-24-hour deadline", () => {
    const roles = [
      makeInternship({ id: "soon", deadline: "2026-08-24T11:00:00.000Z" }),
      makeInternship({ id: "exactly-one-day", deadline: new Date(now + CLOSING_SOON_WINDOW_MS).toISOString() }),
      makeInternship({ id: "past", deadline: "2026-08-23T11:59:00.000Z" }),
      makeInternship({ id: "closed", deadline: "2026-08-24T18:00:00.000Z", availabilityStatus: "closed" }),
      makeInternship({ id: "unknown-date", deadline: "Apply by this date" }),
    ];

    expect(buildClosingSoonNotifications(roles, now)).toEqual([
      expect.objectContaining({
        id: "deadline-internship-soon-1787569200000",
        listingId: "soon",
        deadlineAt: "2026-08-24T11:00:00.000Z",
        roleTitle: "Software Engineering Intern",
      }),
    ]);
  });

  it("exposes the next alert transition for efficient polling", () => {
    const role = makeInternship({ id: "future", deadline: new Date(now + CLOSING_SOON_WINDOW_MS + 30 * 60_000).toISOString() });
    expect(nextClosingSoonRefreshAt([role], now)).toBe(now + 30 * 60_000);
    expect(nextClosingSoonRefreshAt([makeInternship({ deadline: null })], now)).toBeNull();
  });
});
