import { describe, expect, it } from "vitest";

import { detectClosedPage, primaryJobrightListingIsHidden } from "../src/crawler/crawler.js";

describe("closed-page detection", () => {
  it("closes persisted jobs pointing at a known ATS integration sandbox", () => {
    expect(detectClosedPage("Job description", 200, "https://job-boards.greenhouse.io/cssmerge/jobs/8687896002", true))
      .toContain("integration sandbox");
  });

  it("does not treat a list legend as a closed individual job", () => {
    expect(detectClosedPage(
      "Legend: application is closed. Software Engineering Intern — Apply",
      200,
      "https://github.com/example/internships",
    )).toBeNull();
  });

  it("recognizes closure language on a job-detail URL", () => {
    expect(detectClosedPage(
      "This job is no longer available.",
      200,
      "https://company.example/careers/jobs/1234",
    )).toBe("Job no longer available");
  });

  it("does not treat the CSJobs report modal as a closed listing", () => {
    expect(detectClosedPage(
      "Software Engineer Co-op Apply Now Report Job Listing Job is no longer available Submit Report",
      200,
      "https://csjobs.ca/jobs/129354/software-engineer-co-op-at-cmic",
    )).toBeNull();
  });

  it("recognizes 404 on any previously requested page", () => {
    expect(detectClosedPage("Not found", 404, "https://company.example/opaque/1234")).toBe("HTTP 404");
  });

  it("recognizes HTTP 200 page-not-found messages", () => {
    expect(detectClosedPage(
      "The page you are looking for doesn't exist.",
      200,
      "https://company.example/careers/jobs/1234",
    )).toBe("Page not found");
    expect(detectClosedPage(
      "The page you're looking for could not be found.",
      200,
      "https://company.example/opaque/1234",
    )).toBe("Page not found");
  });

  it("does not close a valid posting that describes its closing date", () => {
    expect(detectClosedPage(
      "This job posting will remain open until the position is filled.",
      200,
      "https://company.example/careers/jobs/1234",
    )).toBeNull();
  });

  it("recognizes Jobright's hidden-job metadata unless an official override is known", () => {
    expect(detectClosedPage(
      "Apply on Employer Site",
      200,
      "https://jobright.ai/jobs/info/6a38d5bba0f3e56e86d6e69a",
      true,
      '<script id="jobright-helper-job-detail-info">{"jobResult":{"hiddenJob":true}}</script>',
    )).toBe("Aggregator marks job expired");
    expect(detectClosedPage(
      "Apply on Employer Site",
      200,
      "https://jobright.ai/jobs/info/6a55f03a392ae330b30e7f54",
      true,
      '<script id="jobright-helper-job-detail-info">{"jobResult":{"hiddenJob":true}}</script>',
    )).toBeNull();
  });

  it("ignores hidden flags belonging to recommended jobs", () => {
    const html = [
      '<script id="jobright-helper-job-detail-info">{"jobResult":{"hiddenJob":false}}</script>',
      '<script id="recommendations">{"jobResult":{"hiddenJob":true}}</script>',
    ].join("");
    expect(primaryJobrightListingIsHidden(html)).toBe(false);
    expect(detectClosedPage(
      "Apply on Employer Site",
      200,
      "https://jobright.ai/jobs/info/current-job",
      true,
      html,
    )).toBeNull();
  });
});
