import { describe, expect, it } from "vitest";

import { hasVerifiedLinkedInDestinations } from "../src/output/linkEligibility.js";

describe("LinkedIn output eligibility", () => {
  it("does not emit an unverified LinkedIn destination", () => {
    expect(hasVerifiedLinkedInDestinations({
      applicationUrl: "https://www.linkedin.com/jobs/view/123456789",
      postingUrl: "https://www.linkedin.com/jobs/view/123456789",
    }, null)).toBe(false);
  });

  it("accepts a LinkedIn destination only when its canonical URL was verified", () => {
    const url = "https://www.linkedin.com/jobs/view/123456789";
    expect(hasVerifiedLinkedInDestinations({ applicationUrl: url, postingUrl: url }, new Set([url]))).toBe(true);
    expect(hasVerifiedLinkedInDestinations({ applicationUrl: url, postingUrl: url }, new Set())).toBe(false);
  });

  it("does not require a LinkedIn verification for employer-hosted destinations", () => {
    expect(hasVerifiedLinkedInDestinations({
      applicationUrl: "https://careers.example.com/jobs/123",
      postingUrl: "https://careers.example.com/jobs/123",
    }, null)).toBe(true);
  });
});
