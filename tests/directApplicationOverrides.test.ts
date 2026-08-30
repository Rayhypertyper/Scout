import { describe, expect, it } from "vitest";

import { directApplicationOverride, knownClosedAggregatorPosting } from "../src/config/directApplicationOverrides.js";

describe("direct application overrides", () => {
  it("maps the requested Intuit Jobright listing to its Original Job Post href", () => {
    expect(directApplicationOverride(
      "https://jobright.ai/jobs/info/6a91d9989864261ccd29f558",
    )).toBe("https://jobs.intuit.com/job/mountain-view/summer-2027-software-engineering-intern-full-stack/27595/99856180864?jr_id=6a91d9989864261ccd29f558");
  });

  it("maps an exact aggregator job ID to its verified public posting", () => {
    expect(directApplicationOverride(
      "https://jobright.ai/jobs/info/6a10f1de9fdbf21f36cb1a04?visit=machine-learning-intern",
    )).toBe("https://jobs.lever.co/plus-2/b4f750e7-0148-41f0-b2b1-ff054450a320");
  });

  it("does not map unknown jobs or other hosts", () => {
    expect(directApplicationOverride("https://jobright.ai/jobs/info/unknown")).toBeNull();
    expect(directApplicationOverride("https://example.com/jobs/info/6a10f1de9fdbf21f36cb1a04")).toBeNull();
  });

  it("maps exact non-Jobright aggregators and records verified closures", () => {
    expect(directApplicationOverride(
      "https://simplify.jobs/p/28053adc-4960-4b2a-8386-71e1aba8148e/Quantitative-Developer-Intern",
    )).toBe("https://job-boards.greenhouse.io/walleyecapital-external-students/jobs/4679168006");
    expect(directApplicationOverride(
      "https://interninsider.me/internships/ancestry/machine-learning-engineer-co-op-3fa190f6-aa31-4d31-932a-b03099136fdb/apply",
    )).toContain("careers.ancestry.com/jobs/machine-learning-engineer-co-op");
    expect(knownClosedAggregatorPosting("https://jobright.ai/jobs/info/69da8f9e9f97a42dc9c296ed?visit=ml"))
      .toBe(true);
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a62dda199515267a6f00561"))
      .toContain("jobs.ashbyhq.com/quadrillion-labs/");
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a70bcdbe2b7476e7b20a819"))
      .toContain("samsara.com/company/careers/roles/8082091");
    expect(knownClosedAggregatorPosting("https://jobright.ai/jobs/info/6a7b8a2aecfd297707539ca3"))
      .toBe(true);
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a7b4dbeb933773d16be665f"))
      .toContain("jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210773869");
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a6beef9c00ae03109f86a52"))
      .toBe("https://careers.newyorklife.com/careers/job/43612543");
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a6db0b3ad0fe2053db9c954"))
      .toBe("https://careers.newyorklife.com/careers/job/43624352");
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a7bda3db933773d16be966a"))
      .toBe("https://careers.ibm.com/careers/JobDetail?jobId=128513");
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a7ad6a0ab1385611f900364"))
      .toBe("https://careers.tiktokusds.com/usds/position/7671509975932324149/detail");
    expect(directApplicationOverride("https://jobright.ai/jobs/info/6a7ba2faecfd29770753a513"))
      .toBe("https://www.linkedin.com/jobs/view/software-engineer-intern-at-timbersync-4452696205");
  });
});
