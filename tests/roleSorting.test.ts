import { describe, expect, it } from "vitest";

import { compareByPostedDate, compareBySeason, isDashboardPostingTooOld, parseSortDate, roleSeason } from "../public/roleSorting.js";

type SortableRole = {
  company: string;
  postingDate: string | null;
  relevanceScore: number;
  title: string;
  internshipTerm?: string | null;
  internshipYear?: string | null;
};

function role(
  id: string,
  postingDate: string | null,
  relevanceScore = 50,
  internshipTerm: string | null = null,
  internshipYear: string | null = null,
): SortableRole {
  return { company: id, postingDate, relevanceScore, title: id, internshipTerm, internshipYear };
}

describe("dashboard posted-date sorting", () => {
  it("parses explicit and relative posting dates", () => {
    const base = Date.parse("2026-08-14T12:00:00.000Z");

    expect(parseSortDate("2026-08-12")).toBe(new Date(2026, 7, 12).valueOf());
    expect(parseSortDate("Posted: yesterday", base)).toBe(base - 86_400_000);
    expect(parseSortDate("not provided", base)).toBeNull();
  });

  it("orders dated roles from most recent to oldest and leaves unknown dates last", () => {
    const roles = [
      role("undated", null, 100),
      role("older", "2026-08-10", 80),
      role("newest", "2026-08-14", 60),
    ];

    expect(roles.toSorted(compareByPostedDate).map(({ company }) => company)).toEqual([
      "newest",
      "older",
      "undated",
    ]);
  });

  it("identifies postings before the two-calendar-month cutoff", () => {
    const base = Date.parse("2026-08-20T12:00:00.000Z");

    expect(isDashboardPostingTooOld("2026-06-19", base)).toBe(true);
    expect(isDashboardPostingTooOld("2026-06-20", base)).toBe(false);
    expect(isDashboardPostingTooOld("2 months ago", base)).toBe(false);
    expect(isDashboardPostingTooOld("3 months ago", base)).toBe(true);
    expect(isDashboardPostingTooOld(null, base)).toBe(false);
  });

  it("normalizes autumn and orders known seasons before unknown seasons", () => {
    const roles = [
      role("unknown", null, 100),
      role("fall-2027", null, 20, "Autumn", "2027"),
      role("summer-2027", null, 30, "Summer", "2027"),
      role("winter-2027", null, 40, "Winter", "2027"),
      role("spring-2027", null, 50, "Spring", "2027"),
      role("summer-2028", null, 60, "Summer", "2028"),
    ];

    expect(roles.toSorted(compareBySeason).map(({ company }) => company)).toEqual([
      "winter-2027",
      "spring-2027",
      "summer-2027",
      "summer-2028",
      "fall-2027",
      "unknown",
    ]);
    expect(roleSeason(roles[0]!)).toBe("unknown");
    expect(roleSeason(roles[1]!)).toBe("fall");
  });
});
