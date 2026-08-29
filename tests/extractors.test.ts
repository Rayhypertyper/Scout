import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PageSnapshot } from "../src/domain/types.js";
import { extractAshbyJob } from "../src/extractors/ashby.js";
import { extractByteDanceJob } from "../src/extractors/bytedance.js";
import { extractGenericJobs } from "../src/extractors/generic.js";
import { extractGreenhouseJob } from "../src/extractors/greenhouse.js";
import { extractLeverJob } from "../src/extractors/lever.js";
import { extractOracleHcmJob } from "../src/extractors/oracleHcm.js";
import { extractWorkdayJob } from "../src/extractors/workday.js";
import { isKnownNonProductionJobBoard } from "../src/extractors/index.js";
import { extractPublicBoardJobs } from "../src/extractors/publicBoards.js";
import { companyFromEvidence, companyFromPostingUrl } from "../src/extractors/helpers.js";
import { snapshotFromHttp } from "../src/crawler/staticAdapters.js";

function fixture(name: string, url: string): PageSnapshot {
  const html = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "text/html",
    title: "Fixture",
    html,
    text: html.replace(/<[^>]+>/g, " "),
    links: [],
    fetchedAt: "2027-01-01T00:00:00.000Z",
  };
}

describe("saved ATS fixtures", () => {
  it("ignores Next.js hydration scripts when extracting static page text", () => {
    const url = "https://www.applybolt.app/job/software-engineering-intern-at-wd-m-123abc";
    const body = `<main>
      <div class="job-company-name">WD</div>
      <h1 class="job-title">Software Engineering Intern</h1>
      <div class="job-company-location">San Jose, CA</div>
      <div class="job-facts-row"><dt>Posted</dt><dd class="job-facts-value">yesterday</dd></div>
      <div class="job-description"><p>Build and test software systems with experienced engineers while learning modern development practices.</p></div>
      <a class="job-seo-applylink" href="https://jobs.example.com/apply/123">Apply</a>
    </main>
    <script>self.__next_f.push([1,'Posted yesterday raw payload'])</script>`;
    const snapshot = snapshotFromHttp({
      requestedUrl: url,
      url,
      status: 200,
      contentType: "text/html; charset=utf-8",
      body,
      headers: {},
      attempts: 1,
      fromCache: false,
    });

    expect(snapshot.text).toContain("Posted\nyesterday");
    expect(snapshot.text).not.toContain("self.__next_f");
    expect(extractPublicBoardJobs(snapshot)[0]).toMatchObject({ postingDate: "yesterday" });
  });

  it("extracts Greenhouse details and direct apply link", () => {
    const job = extractGreenhouseJob(fixture("greenhouse-job.html", "https://boards.greenhouse.io/northstar/jobs/12345"));
    expect(job).toMatchObject({ company: "Northstar Robotics", title: "Software Engineering Intern, Robotics", jobId: "12345" });
    expect(job?.applicationUrl).toBe("https://boards.greenhouse.io/northstar/jobs/12345/apply");
    expect(job?.requiredQualifications).not.toHaveLength(0);
    expect(job?.preferredQualifications).not.toHaveLength(0);
  });

  it("extracts Lever details", () => {
    const job = extractLeverJob(fixture("lever-job.html", "https://jobs.lever.co/aurora/222"));
    expect(job?.title).toBe("Frontend Developer Intern");
    expect(job?.locations).toContain("Remote Canada");
    expect(job?.applicationUrl).toBe("https://jobs.lever.co/aurora/222/apply");
  });

  it("extracts Workday details", () => {
    const job = extractWorkdayJob(fixture("workday-job.html", "https://maple.wd5.myworkdayjobs.com/jobs/job/Waterloo/Data-Coop_R9001"));
    expect(job).toMatchObject({ company: "Maple Data Systems", title: "Data Engineering Co-op" });
    expect(job?.locations).toContain("Waterloo, Ontario, Canada");
  });

  it("infers a Workday employer explicitly named in content instead of a shared tenant", () => {
    const snapshot = fixture("workday-job.html", "https://globalhr.wd5.myworkdayjobs.com/jobs/job/Waterloo/Data-Coop_R9001");
    snapshot.html = snapshot.html
      .replace('<div data-automation-id="jobPostingCompany">Maple Data Systems</div>', "")
      .replace("Join our Fall", "At RTX, our teams innovate. Join our Fall");
    expect(extractWorkdayJob(snapshot)?.company).toBe("RTX");
    expect(companyFromEvidence("GlobalHR", "At RTX, our engineers build software.", "Globalhr")).toBe("RTX");
    expect(companyFromEvidence("100 Intel Corporation", "This position is an internship.", "Intel")).toBe("Intel Corporation");
    expect(companyFromEvidence("CTC Campus - Website", "Chicago Trading Company (CTC) is a trading firm.", "CTC"))
      .toBe("Chicago Trading Company");
    expect(companyFromPostingUrl("https://www.applybolt.app/job/software-engineer-at-sentry-m-123abc"))
      .toBe("Sentry");
    expect(companyFromEvidence("ApplyBolt", "Sentry helps developers write software.", "Sentry")).toBe("Sentry");
    expect(companyFromEvidence("Today, NVIDIA", "Today, NVIDIA is defining the next era of computing.", "NVIDIA"))
      .toBe("NVIDIA");
    expect(companyFromEvidence("Lighting", "About Signify Through bold discovery, we build software.", "Lighting"))
      .toBe("Signify");
    expect(companyFromEvidence("Our formula for success", "Our formula for success is simple. DRW enables developers to grow.", "Drweng"))
      .toBe("DRW");
    expect(companyFromEvidence("Burnsville Minnesota", "At RTX, our interns develop software.", "Globalhr")).toBe("RTX");
    expect(companyFromEvidence("Talentmanagementsolution", "Perseus Group builds vertical software.", "Talentmanagementsolution"))
      .toBe("Perseus Group");
    expect(companyFromEvidence("Axontalentcommunity", "Axon’s engineers build public-safety software.", "Axontalentcommunity"))
      .toBe("Axon");
    expect(companyFromEvidence("Us", "DV Trading builds market technology.", "Simplify")).toBe("DV Trading");
    expect(companyFromEvidence(
      "1D19 Su(-)zhou",
      "The role develops Python tools. About Philips We are a health technology company.",
      "Philips",
    )).toBe("Philips");
  });

  it("extracts generic JSON-LD without hallucinating absent authorization", () => {
    const jobs = extractGenericJobs(fixture("generic-job.html", "https://careers.harbor.example/jobs/HC-77"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Harbor Cloud", title: "QA Automation Intern", jobId: "HC-77" });
    expect(jobs[0]?.requiredQualifications).not.toHaveLength(0);
  });

  it("prefers IBM's visible job banner over its visually hidden brand heading", () => {
    const url = "https://careers.ibm.com/en_US/careers/JobDetail?jobId=128513";
    const html = `<main><h1 class="visibility--hidden--visually">IBM</h1><h2 class="banner__text__title">Site Reliability Engineer Intern 2027</h2><div class="card-item-location">Durham, NC, United States</div><article><h3>Your role and responsibilities</h3><p>Build, deploy, configure, and maintain production systems using Python and Kubernetes.</p><h3>Required qualifications</h3><p>Pursuing a Computer Science degree with Linux experience.</p><a href="${url}">Apply now</a></article></main>`;
    const snapshot: PageSnapshot = { ...fixture("generic-job.html", url), html, text: html.replace(/<[^>]+>/g, " "), title: "Site Reliability Engineer Intern 2027 - 128513 - IBM" };
    expect(extractGenericJobs(snapshot)[0]).toMatchObject({
      company: "IBM",
      title: "Site Reliability Engineer Intern 2027",
      locations: ["Durham, NC, United States"],
    });
  });

  it("returns no Ashby job for another provider", () => {
    expect(extractAshbyJob(fixture("generic-job.html", "https://careers.harbor.example/jobs/HC-77"))).toBeNull();
  });

  it("rejects known public ATS integration-sandbox boards", () => {
    expect(isKnownNonProductionJobBoard("https://job-boards.greenhouse.io/cssmerge/jobs/8693034002")).toBe(true);
    expect(isKnownNonProductionJobBoard("https://job-boards.greenhouse.io/realcompany/jobs/8693034002")).toBe(false);
  });

  it("extracts rendered ByteDance career detail pages", () => {
    const text = "Life at ByteDance\nMachine Learning Engineer Intern - 2027 Start\nLocation:\nSan Jose\nTeam:\nTechnology\nEmployment Type:\nIntern\nJob Code:\nA221977\nResponsibilities\nResponsibilities:\n- Build Kubernetes systems.\nQualifications\nMinimum Qualifications:\n- Pursuing Computer Science.\nPreferred Qualifications:\n- Experience with Go.\nJob Information\nThe hourly rate range for this position is $45- $45.\nAbout Us\nByteDance.";
    const snapshot: PageSnapshot = { ...fixture("generic-job.html", "https://joinbytedance.com/search/7671291260529821957"), text, title: "Machine Learning Engineer Intern - 2027 Start" };
    expect(extractByteDanceJob(snapshot)).toMatchObject({
      company: "ByteDance",
      title: "Machine Learning Engineer Intern - 2027 Start",
      locations: ["San Jose"],
      jobId: "A221977",
      requiredQualifications: ["Pursuing Computer Science."],
      preferredQualifications: ["Experience with Go."],
    });
  });

  it("extracts rendered TikTok USDS detail pages without a Location label", () => {
    const text = "Company\nJobs\nSoftware Engineer Intern (E-commerce) - 2027 Summer\nSan JoseInternR&DFuture Talent 2027 - Internship ProgramJob ID: A134948A\nResponsibilities\nBuild distributed systems using Go.\nQualifications\nMinimum Qualifications\nPursuing Computer Science.\nExperience with C++.\nPreferred Qualifications\nExperience in AI coding.\nJob Information\nAbout USDS\nTikTok USDS.\nThe hourly rate range for this position is $45- $45.";
    const snapshot: PageSnapshot = { ...fixture("generic-job.html", "https://careers.tiktokusds.com/usds/position/7671509975932324149/detail"), text, title: "Software Engineer Intern (E-commerce) - 2027 Summer - TikTok" };
    expect(extractByteDanceJob(snapshot)).toMatchObject({
      company: "TikTok USDS Joint Venture",
      title: "Software Engineer Intern (E-commerce) - 2027 Summer",
      locations: ["San Jose"],
      jobId: "A134948A",
      salary: "$45- $45",
      requiredQualifications: ["Pursuing Computer Science.", "Experience with C++."],
      preferredQualifications: ["Experience in AI coding."],
    });
  });

  it("extracts rendered Oracle HCM job detail pages", () => {
    const text = "View More Jobs\nResearch Engineering Internship - AI\nSan Jose, CA, United States\nTRENDING\nJOB DESCRIPTION\nAbout Outward, Inc. Williams-Sonoma builds software visualization tools.\nSome areas of interest are:\nBuild computer vision models.\nWe are looking for the following:\nPursuing a graduate CS degree.\nDesired Skills (Nice-to-have):\nExperience with Python.\nInternship duration (start & end date):\nFall 2025.\nABOUT US\nWilliams-Sonoma.\nAPPLY NOW\nJOB INFO\nJob Identification\n15762\nPosting Date\n08/01/2025, 07:23 PM";
    const snapshot: PageSnapshot = { ...fixture("generic-job.html", "https://ehac.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/15762"), text, title: "Research Engineering Internship - AI - Williams-Sonoma Careers" };
    expect(extractOracleHcmJob(snapshot)).toMatchObject({
      company: "Williams-Sonoma",
      title: "Research Engineering Internship - AI",
      locations: ["San Jose, CA, United States"],
      jobId: "15762",
      requiredQualifications: ["Pursuing a graduate CS degree."],
      preferredQualifications: ["Experience with Python."],
    });
  });

  it("extracts Oracle HCM job information, all locations, and employer metadata", () => {
    const text = "View More Jobs\n2027 Data & AI Program - Summer Internship - Analyst - United States\nChicago, IL, United States and 1 more\nAPPLY NOW\nJOB INFORMATION\nJob Identification\n210773869\nPosting Date\n08/11/2026, 12:19 PM\nLocations\nChicago, IL, United States\nNew York, NY, United States\nApply Before\n11/06/2026, 12:00 AM\nJob Schedule\nFull time\nBase Pay/Salary\nChicago, IL $45.67-$45.67\nJOB DESCRIPTION\nJPMorganChase interns build end-to-end data, analytics, artificial intelligence and machine learning solutions.\nRequired qualifications\nPursuing a Computer Science degree.\nExperience with Python and SQL.\nABOUT US\nJPMorganChase.";
    const snapshot: PageSnapshot = { ...fixture("generic-job.html", "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210773869"), text, title: "2027 Data & AI Program - Summer Internship - Analyst - United States - JPMC Candidate Experience page Careers" };
    expect(extractOracleHcmJob(snapshot)).toMatchObject({
      company: "JPMorganChase",
      jobId: "210773869",
      locations: ["Chicago, IL, United States", "New York, NY, United States"],
      postingDate: "08/11/2026, 12:19 PM",
      deadline: "11/06/2026, 12:00 AM",
      salary: "Chicago, IL $45.67-$45.67",
    });
  });
});
