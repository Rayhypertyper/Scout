import { beforeAll, describe, expect, it } from "vitest";

import { evaluateInternshipMatch } from "../src/preferences/matching.js";
import {
  buildMatchingFixtureSuite,
  matchingInputDigest,
  type MatchingFixtureSuite,
} from "./fixtures/matchingFixtures.js";

describe("deterministic matching fixture suite", () => {
  let suite: MatchingFixtureSuite;

  beforeAll(async () => {
    suite = await buildMatchingFixtureSuite();
  });

  it("has stable references and exercises every contrasting profile", () => {
    expect(suite.asOf).toBe("2026-08-31T12:00:00.000Z");
    expect(suite.profiles.map(({ id }) => id)).toEqual([
      "canadian-backend",
      "sponsor-needed",
      "frontend-data-hardware",
      "graduate-student",
      "missing-preferences",
    ]);
    expect(suite.roles.length).toBeGreaterThanOrEqual(25);
    expect(suite.cases.length).toBeGreaterThanOrEqual(39);

    const profileIds = new Set(suite.profiles.map(({ id }) => id));
    const roleIds = new Set(suite.roles.map(({ id }) => id));
    for (const fixtureCase of suite.cases) {
      expect(profileIds.has(fixtureCase.profileId), fixtureCase.id).toBe(true);
      expect(roleIds.has(fixtureCase.roleId), fixtureCase.id).toBe(true);
    }
  });

  it("keeps hard exclusions separate from posting/profile unknowns", () => {
    const profiles = new Map(suite.profiles.map((profile) => [profile.id, profile]));
    const roles = new Map(suite.roles.map((role) => [role.id, role]));
    for (const fixtureCase of suite.cases) {
      const profile = profiles.get(fixtureCase.profileId)!;
      const role = roles.get(fixtureCase.roleId)!;
      const match = evaluateInternshipMatch(profile.preferences, role.internship);
      if (fixtureCase.expected === "hard_excluded") {
        expect(match.eligibility.status, fixtureCase.id).toBe("not_eligible");
        expect(match.eligible, fixtureCase.id).toBe(false);
        expect(match.incompatibilities.length, fixtureCase.id).toBeGreaterThan(0);
      } else if (fixtureCase.expected === "unclear") {
        expect(match.eligibility.status, fixtureCase.id).toBe("unclear");
        expect(match.eligible, fixtureCase.id).toBe(true);
        expect(match.unknown.length, fixtureCase.id).toBeGreaterThan(0);
      } else {
        expect(match.eligibility.status, fixtureCase.id).not.toBe("not_eligible");
        expect(match.eligible, fixtureCase.id).toBe(true);
      }
    }
  });

  it("keeps strict and preferred degree wording distinct", () => {
    const canadian = suite.profiles.find(({ id }) => id === "canadian-backend")!;
    const roles = new Map(suite.roles.map((role) => [role.id, role]));

    const strictMasters = evaluateInternshipMatch(canadian.preferences, roles.get("strict-masters")!.internship);
    expect(strictMasters.eligibility.criteria.degree.state).toBe("fail");
    expect(strictMasters.eligible).toBe(false);

    const preferredMasters = evaluateInternshipMatch(canadian.preferences, roles.get("preferred-degree-only")!.internship);
    expect(preferredMasters.eligibility.criteria.degree.state).toBe("unknown");
    expect(preferredMasters.eligible).toBe(true);

    const strictPhd = evaluateInternshipMatch(canadian.preferences, roles.get("strict-phd")!.internship);
    expect(strictPhd.eligibility.criteria.degree.state).toBe("fail");
    expect(strictPhd.eligible).toBe(false);

    const preferredPhd = evaluateInternshipMatch(canadian.preferences, roles.get("preferred-phd-only")!.internship);
    expect(preferredPhd.eligibility.criteria.degree.state).toBe("unknown");
    expect(preferredPhd.eligible).toBe(true);
  });

  it("retains explicit unknown, conflict, and sponsorship-denial signals", () => {
    const canadian = suite.profiles.find(({ id }) => id === "canadian-backend")!;
    const sponsor = suite.profiles.find(({ id }) => id === "sponsor-needed")!;
    const roles = new Map(suite.roles.map((role) => [role.id, role]));

    const unknownTerm = evaluateInternshipMatch(canadian.preferences, roles.get("unknown-term")!.internship);
    expect(unknownTerm.eligibility.criteria.term.state).toBe("unknown");
    expect(unknownTerm.eligible).toBe(true);

    const unknownLocation = evaluateInternshipMatch(canadian.preferences, roles.get("unknown-location")!.internship);
    expect(unknownLocation.eligibility.criteria.country_location.state).toBe("unknown");
    expect(unknownLocation.eligible).toBe(true);

    const contradictory = evaluateInternshipMatch(canadian.preferences, roles.get("contradictory-evidence")!.internship);
    expect(contradictory.eligibility.status).toBe("unclear");
    expect(contradictory.eligibility.criterionResults.some(({ state }) => state === "conflict")).toBe(true);

    const denied = evaluateInternshipMatch(sponsor.preferences, roles.get("ml-new-york-denial")!.internship);
    expect(denied.eligibility.criteria.work_authorization.state).toBe("fail");
    expect(denied.eligibility.criteria.sponsorship.state).toBe("fail");
    expect(denied.eligible).toBe(false);
  });

  it("preserves technology aliases without a JavaScript-to-Java false positive", () => {
    const aliases = suite.roles.find(({ id }) => id === "tech-aliases")!.internship;
    expect(aliases.technologies).toEqual(expect.arrayContaining(["C++", "C#", "JavaScript", "React", "Node.js", "Go"]));
    expect(aliases.technologies).not.toContain("Java");
    expect(new Set(aliases.technologies).size).toBe(aliases.technologies.length);
  });

  it("rebuilds byte-equivalent normalized profile and role inputs at the fixed asOf", async () => {
    const second = await buildMatchingFixtureSuite();
    expect(matchingInputDigest(suite)).toBe(matchingInputDigest(second));
    expect(second.roles.map(({ id, internship }) => ({ id, internship }))).toEqual(
      suite.roles.map(({ id, internship }) => ({ id, internship })),
    );
    expect(second.profiles).toEqual(suite.profiles);
  });
});

