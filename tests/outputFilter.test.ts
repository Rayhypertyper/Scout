import { describe, expect, it } from "vitest";

import { filterInternships } from "../src/output/filter.js";
import { hasRequiredListingKeywords } from "../src/output/eligibility.js";
import { makeInternship } from "./helpers.js";

describe("internship output filtering", () => {
  it("uses an explicit CLI minimum score as a separate output filter", () => {
    const low = makeInternship({ id: "low-score", relevanceScore: 49 });
    const boundary = makeInternship({ id: "boundary-score", relevanceScore: 50 });

    expect(filterInternships([low, boundary], { categories: [], newOnly: false, minScore: 0 }))
      .toEqual([low, boundary]);
    expect(filterInternships([low, boundary], { categories: [], newOnly: false, minScore: 50 }))
      .toEqual([boundary]);
  });

  it("does not turn neutral authorization or positive sponsorship wording into an output exclusion", () => {
    const allowed = makeInternship({
      description: "U.S. Citizen, U.S. Person, or Immigration Status Requirements: None. Must be legally authorized to work in Canada. Visa sponsorship may be available.",
    });

    expect(filterInternships([allowed], { categories: [], newOnly: false, minScore: 0 })).toEqual([allowed]);
  });

  it("requires one technical and one placement keyword, regardless of capitalization", () => {
    const accepted = makeInternship({ title: "FULL-STACK DEVELOPER INTERNSHIP" });
    const missingPlacement = makeInternship({ title: "FULL-STACK DEVELOPER" });
    const missingTechnical = makeInternship({
      title: "MARKETING INTERN",
      description: "Coordinate customer events and prepare reports.",
      responsibilities: ["Coordinate customer events."],
      requiredQualifications: ["Student"],
      preferredQualifications: [],
      educationRequirements: ["Student"],
      technologies: [],
      categories: ["other-code"],
    });

    expect(hasRequiredListingKeywords(accepted)).toBe(true);
    expect(hasRequiredListingKeywords(missingPlacement)).toBe(false);
    expect(hasRequiredListingKeywords(missingTechnical)).toBe(false);
    expect(filterInternships([missingPlacement, missingTechnical, accepted], { categories: [], newOnly: false, minScore: 0 }))
      .toEqual([accepted]);
  });
});
