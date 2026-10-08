import { describe, expect, it } from "vitest";
import { interleaveJobrightBatches, selectJobrightResolverSources } from "../src/jobrightResolver.js";

describe("scheduled Jobright coverage", () => {
  it("deduplicates old category aliases into one full public inventory refresh", () => {
    expect(selectJobrightResolverSources([
      "https://example.com/jobs",
      "https://www.intern-list.com/",
      "https://www.intern-list.com/?k=swe",
      "https://www.intern-list.com/?k=aiml",
      "https://www.intern-list.com/?k=eng",
    ])).toEqual(["https://www.intern-list.com/"]);
    expect(selectJobrightResolverSources(["https://swan-api.jobright.ai/swan/mini-sites/list?count=50"])).toEqual([]);
  });

  it("attempts each category before a large backlog can consume the run deadline", () => {
    expect(interleaveJobrightBatches([["swe1", "swe2", "swe3"], ["ai1", "ai2"], ["eng1"]]))
      .toEqual(["swe1", "ai1", "eng1", "swe2", "ai2", "swe3"]);
    expect(interleaveJobrightBatches([])).toEqual([]);
  });
});
