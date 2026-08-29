import { describe, expect, it } from "vitest";

import { buildRoleTabKeys, roleMatchesTab } from "../src/dashboardTabs.js";
import { makeInternship } from "./helpers.js";

describe("dashboard role tabs", () => {
  it("indexes persisted crawl results into their matching dashboard tabs", () => {
    const summerFromTitle = makeInternship({
      id: "summer-title",
      title: "Software Engineering Intern - Summer 2027",
      internshipTerm: null,
      internshipYear: null,
    });
    const summerFromDetails = makeInternship({
      id: "summer-details",
      title: "Software Engineer Intern",
      internshipTerm: "Summer",
      categories: ["swe"],
    });
    const roles = [summerFromTitle, summerFromDetails];

    const tabs = buildRoleTabKeys(roles, (role) => `internship:${role.id}`);

    expect(tabs.main).toEqual(["internship:summer-title", "internship:summer-details"]);
    expect(tabs.summer).toEqual(["internship:summer-title", "internship:summer-details"]);
    expect(tabs.canada).toEqual(["internship:summer-title", "internship:summer-details"]);
  });

  it("matches Canadian locations without treating unspecified remote work as Canadian", () => {
    const canadian = makeInternship();
    const remoteCanada = makeInternship({
      id: "remote-canada",
      location: ["Remote Canada"],
      normalizedLocations: [{
        raw: "Remote Canada",
        country: null,
        provinceState: null,
        city: null,
        remote: true,
        remoteScope: "canada",
      }],
      remoteStatus: "remote",
    });
    const unitedStates = makeInternship({
      id: "united-states",
      location: ["San Jose, CA, United States"],
      normalizedLocations: [{
        raw: "San Jose, CA, United States",
        country: "United States",
        provinceState: "California",
        city: "San Jose",
        remote: false,
        remoteScope: null,
      }],
    });
    const unspecifiedRemote = makeInternship({
      id: "unspecified-remote",
      location: ["Remote"],
      normalizedLocations: [{
        raw: "Remote",
        country: null,
        provinceState: null,
        city: null,
        remote: true,
        remoteScope: "unspecified",
      }],
      remoteStatus: "remote",
    });

    expect(roleMatchesTab(canadian, "canada")).toBe(true);
    expect(roleMatchesTab(remoteCanada, "canada")).toBe(true);
    expect(roleMatchesTab(unitedStates, "canada")).toBe(false);
    expect(roleMatchesTab(unspecifiedRemote, "canada")).toBe(false);
  });

  it("does not classify a U.S. facility label as Canadian", () => {
    const role = makeInternship({
      id: "southstate-houston",
      location: ["Houston, TX", "Richmond James Center"],
      normalizedLocations: [{
        raw: "Houston, TX",
        country: "United States",
        provinceState: "Texas",
        city: "Houston",
        remote: false,
        remoteScope: null,
      }],
    });

    expect(roleMatchesTab(role, "canada")).toBe(false);
  });

  it("does not trust stale Canadian normalization when raw locations are foreign", () => {
    const australianLocation = "Sydney, New South Wales, Australia · Melbourne, Victoria, Australia · Brisbane, Queensland, Australia";
    const stalePayload = makeInternship({
      id: "australian-clipchamp",
      title: "Software Engineering Intern - Clipchamp",
      location: [australianLocation],
      normalizedLocations: [{
        raw: australianLocation,
        country: "Canada",
        provinceState: null,
        city: "Victoria",
        remote: false,
        remoteScope: null,
      }],
    });

    expect(roleMatchesTab(stalePayload, "canada")).toBe(false);
  });

  it("ignores legacy Useno country and region metadata appended to a foreign location", () => {
    const stalePayload = makeInternship({
      id: "australian-useno-role",
      sourceUrl: "https://www.useno.app/internship-masterlist",
      location: ["Australia - Victoria - Mulgrave", "British Columbia", "CA"],
      normalizedLocations: [{
        raw: "Australia - Victoria - Mulgrave",
        country: "Canada",
        provinceState: null,
        city: "Victoria",
        remote: false,
        remoteScope: null,
      }],
    });

    expect(roleMatchesTab(stalePayload, "canada")).toBe(false);
  });

  it("does not promote an ambiguous Canadian region on an explicitly foreign role", () => {
    const stalePayload = makeInternship({
      id: "mexico-role-with-ambiguous-region",
      sourceUrl: "https://www.useno.app/internship-masterlist",
      location: ["Remote - Mexico; Mexico City, CDMX; Puebla; Tijuana, BC"],
      normalizedLocations: [{
        raw: "Tijuana, BC",
        country: "Canada",
        provinceState: "British Columbia",
        city: "Tijuana",
        remote: false,
        remoteScope: null,
      }],
      remoteStatus: "remote",
    });

    expect(roleMatchesTab(stalePayload, "canada")).toBe(false);
  });

  it("requires an internship role and summer placement for the summer tab", () => {
    const fall = makeInternship({ internshipTerm: "Fall", internshipYear: "2027" });
    const noInternship = makeInternship({
      title: "Software Engineer",
      internshipTerm: null,
      internshipYear: null,
      description: "Develop and test TypeScript software services for a production platform.",
    });

    expect(roleMatchesTab(makeInternship(), "summer")).toBe(true);
    expect(roleMatchesTab(fall, "summer")).toBe(false);
    expect(roleMatchesTab(noInternship, "summer")).toBe(false);
  });
});
