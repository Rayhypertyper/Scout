import { describe, expect, it } from "vitest";

import { filterInternships } from "../src/output/filter.js";
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
});
