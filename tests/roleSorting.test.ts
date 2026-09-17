import { describe, expect, it } from "vitest";

import { compareByPostedDate, compareBySeason, isDashboardPostingTooOld, parseSortDate, roleHasSeason, roleSeason, roleSeasons } from "../public/roleSorting.js";

type SortableRole = {
  company: string;
  postingDate: string | null;
  firstSeenAt?: string | null;
  discoveredAt?: string | null;
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
  firstSeenAt: string | null = null,
  discoveredAt: string | null = null,
): SortableRole {
  return {
    company: id,
    postingDate,
    firstSeenAt,
    discoveredAt,
    relevanceScore,
    title: id,
    internshipTerm,
    internshipYear,
  };
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

  it("uses first-seen or discovery dates when an explicit posting date is missing", () => {
    const roles = [
      role("discovered-latest", null, 20, null, null, "2026-08-14T12:00:00.000Z"),
      role("posted-middle", "2026-08-12", 100),
      role("first-seen-oldest", null, 100, null, null, "2026-08-10T12:00:00.000Z"),
    ];

    expect(roles.toSorted(compareByPostedDate).map(({ company }) => company)).toEqual([
      "discovered-latest",
      "posted-middle",
      "first-seen-oldest",
    ]);

    const sameDay = [
      role("high-score-old-arrival", "2026-08-14", 100, null, null, "2026-08-14T08:00:00.000Z"),
      role("low-score-new-arrival", "2026-08-14", 20, null, null, "2026-08-14T12:00:00.000Z"),
    ];
    expect(sameDay.toSorted(compareByPostedDate).map(({ company }) => company)).toEqual([
      "low-score-new-arrival",
      "high-score-old-arrival",
    ]);

    const missingFallback = [
      role("no-effective-date", null, 100),
      role("known-fallback-date", null, 20, null, null, null, "2026-08-11T12:00:00.000Z"),
    ];
    expect(missingFallback.toSorted(compareByPostedDate).map(({ company }) => company)).toEqual([
      "known-fallback-date",
      "no-effective-date",
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

  it("keeps a role in every matching season for client-side filters", () => {
    const roleWithMultipleSeasons = {
      title: "Software Engineering Intern",
      description: "This role is available for Summer and Fall placements.",
      internshipTerm: null,
      internshipYear: null,
    };

    expect(roleSeasons(roleWithMultipleSeasons)).toEqual(["summer", "fall"]);
    expect(roleHasSeason(roleWithMultipleSeasons, "summer")).toBe(true);
    expect(roleHasSeason(roleWithMultipleSeasons, "fall")).toBe(true);
    expect(roleSeason(roleWithMultipleSeasons)).toBe("summer");
  });
});
