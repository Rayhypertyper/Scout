import { describe, expect, it } from "vitest";

import {
  isRemovedSWEJobBoardSource,
  REMOVED_SWE_JOB_BOARD_SOURCES,
  visibleProvenanceSources,
} from "../src/config/removedSWEJobBoards.js";

describe("removed SWE job-board provenance", () => {
  it("tracks all 80 retired sources as unique URLs", () => {
    expect(REMOVED_SWE_JOB_BOARD_SOURCES).toHaveLength(80);
    expect(new Set(REMOVED_SWE_JOB_BOARD_SOURCES).size).toBe(80);
  });

  it("matches canonical historical variants and preserves other provenance", () => {
    expect(isRemovedSWEJobBoardSource("https://about.gitlab.com/jobs")).toBe(true);
    expect(isRemovedSWEJobBoardSource("https://jobs.dropbox.com")).toBe(true);
    expect(isRemovedSWEJobBoardSource("https://www.intern-list.com/")).toBe(false);
    expect(visibleProvenanceSources([
      "https://about.gitlab.com/jobs/",
      "https://www.intern-list.com/",
    ])).toEqual(["https://www.intern-list.com/"]);
  });
});
