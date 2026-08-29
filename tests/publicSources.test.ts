import { describe, expect, it } from "vitest";

import type { PageSnapshot } from "../src/domain/types.js";
import { SOURCES } from "../src/config/sources.js";
import { discoverPublicBoardLinks, extractPublicBoardJobs } from "../src/extractors/publicBoards.js";
import { earlyCareerRadarSameSite, isEarlyCareerRadarSource, largeListingSourcePageFloor, publicSourceFallback } from "../src/crawler/publicSources.js";

function snapshot(url: string, text: string, html = ""): PageSnapshot {
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "text/plain",
    title: "Fixture",
    html: html || `<pre>${text}</pre>`,
    text,
    links: [],
    fetchedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("public source fallbacks", () => {
  it("includes the Intern List root and selected software source", () => {
    expect(SOURCES).toContain("https://www.intern-list.com/");
    expect(SOURCES).toContain("https://www.intern-list.com/?k=swe");
  });

  it("includes the Dreamwork 2027 technology internships repository", () => {
    expect(SOURCES).toContain("https://github.com/dreamworkhq/Tech-Internships-2027");
  });

  it("restores the Aug 26 Canadian internship source set", () => {
    expect(SOURCES).toContain("https://github.com/michelleokolie/canada-tech-internships-summer-2027");
    expect(SOURCES).toContain("https://github.com/negarprh/Canadian-Tech-Internships-2027/blob/main/README.md");
    expect(SOURCES).not.toContain("https://github.com/negarprh/Canadian-Tech-Internships-2027/blob/main/README-2027.md");
  });

  it("includes the SuryaHarikrishnan software engineering tracker", () => {
    expect(SOURCES).toContain("https://github.com/SuryaHarikrishnan/2027-internship-tracker/blob/master/listings/software-engineering.md");
  });

  it("does not schedule the temporarily disabled Useno source", () => {
    expect(SOURCES).not.toContain("https://www.useno.app/summer-2027-internships");
  });

  it("schedules the Useno internship masterlist", () => {
    expect(SOURCES).toContain("https://www.useno.app/internship-masterlist");
  });

  it("schedules the canonical Early Career Radar superset only once", () => {
    expect(SOURCES).toContain("https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus&years=1st+year%2C2nd+year%2C3rd+year%2C4th+year%2CAny+undergraduate+year%2CUndergraduate+%E2%80%94+year+not+stated%2CNot+stated");
    expect(SOURCES).not.toContain("https://earlycareerradar.com/summer-internships?locations=all");
    expect(SOURCES).not.toContain("https://internship-radar-2027.yuxhuang.com/?locations=country%3ACanada%7Cus");
    expect(SOURCES).not.toContain("https://internship-radar-2027.yuxhuang.com/?locations=country%3ACanada%7Cus&years=1st+year%2C2nd+year%2CAny+undergraduate+year%2CUndergraduate+%E2%80%94+year+not+stated%2CNot+stated");
  });

  it("maps the blocked GitHub boards to their public raw Markdown files", () => {
    expect(publicSourceFallback("https://github.com/hanzili/canada_sde_intern_position")?.url)
      .toBe("https://raw.githubusercontent.com/hanzili/canada_sde_intern_position/main/README.md");
    expect(publicSourceFallback("https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/INTERN_INTL.md")?.url)
      .toBe("https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/INTERN_INTL.md");
    expect(publicSourceFallback("https://github.com/vanshb03/Summer2027-Internships")?.url)
      .toBe("https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md");
  });

  it("maps the two blocked board routes to public equivalents", () => {
    expect(publicSourceFallback("https://csjobs.ca/internships/toronto")?.url).toBe("https://csjobs.ca/jobs");
    expect(publicSourceFallback("https://www.applybolt.app/jobs/2027-all-internships")?.url)
      .toBe("https://www.applybolt.app/jobs/2027-internships");
    expect(publicSourceFallback("https://hiringcafe.com/")?.url).toBe("https://hiringcafe.com/jobs/canada");
  });

  it("allocates enough pages for the large public listing boards", () => {
    const earlyCareerRadarUrl = "https://earlycareerradar.com/summer-internships?locations=all";
    expect(isEarlyCareerRadarSource(earlyCareerRadarUrl)).toBe(true);
    expect(isEarlyCareerRadarSource("https://internship-radar-2027.yuxhuang.com/?locations=country%3ACanada%7Cus")).toBe(true);
    expect(isEarlyCareerRadarSource("https://earlycareerradar.com/jobs/job_123")).toBe(false);
    expect(earlyCareerRadarSameSite(
      "https://internship-radar-2027.yuxhuang.com/",
      "https://earlycareerradar.com/jobs/job_123",
    )).toBe(true);
    expect(largeListingSourcePageFloor(earlyCareerRadarUrl)).toBe(2_000);
    expect(largeListingSourcePageFloor("https://internship-radar-2027.yuxhuang.com/")).toBe(2_000);
    expect(largeListingSourcePageFloor("https://wellfound.com/location/canada-startups")).toBe(2_000);
    expect(largeListingSourcePageFloor("https://csjobs.ca/internships/toronto")).toBe(450);
    expect(largeListingSourcePageFloor("https://www.applybolt.app/jobs/2027-all-internships")).toBe(5_000);
  });
});

describe("public board extractors", () => {
  it("uses row-specific company links from GitHub digest tables", () => {
    const sourceUrl =
      "https://raw.githubusercontent.com/SuryaHarikrishnan/2027-internship-tracker/master/digests/2026-08-07.md";
    const markdown = [
      "# Digest — 2026-08-07",
      "",
      "| Company | Role | Location | Terms |",
      "| --- | --- | --- | --- |",
      "| [Alayacare](https://alayacare.com/open-positions?gh_jid=8687981002) | Full-Stack Developer Intern - Python | Montreal, QC, Canada | Fall 2026 |",
    ].join("\n");

    const [job] = extractPublicBoardJobs(snapshot(sourceUrl, markdown));

    expect(job).toMatchObject({
      company: "Alayacare",
      title: "Full-Stack Developer Intern - Python",
      locations: ["Montreal, QC, Canada"],
      applicationUrl: "https://alayacare.com/open-positions?gh_jid=8687981002",
      postingUrl: "https://alayacare.com/open-positions?gh_jid=8687981002",
    });
  });

  it("extracts a GitHub Markdown row and its direct application URL", () => {
    const markdown = [
      "# Summer 2027",
      "| Title | Company | Role | Company Info | Details | Location | Apply |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| Software Engineering Intern | Maple Systems | Build backend services | Canadian software company building developer tools for data teams. | Work with Python, TypeScript, APIs, tests, and cloud infrastructure on a student engineering team. | Toronto, Ontario, Canada | [Apply](https://boards.greenhouse.io/maple/jobs/123) <!--id:maple-123--> |",
    ].join("\n");
    const jobs = extractPublicBoardJobs(snapshot("https://raw.githubusercontent.com/example/jobs/main/README.md", markdown));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      company: "Maple Systems",
      title: "Software Engineering Intern",
      locations: ["Toronto, Ontario, Canada"],
      applicationUrl: "https://boards.greenhouse.io/maple/jobs/123",
      postingUrl: "https://boards.greenhouse.io/maple/jobs/123",
      jobId: "maple-123",
      sourceProvider: "github-markdown",
    });
    expect(jobs[0]?.description).toContain("Work with Python");
  });

  it("uses the row's job link instead of a shared company link", () => {
    const markdown = [
      "| Company | Title | Location | Age |",
      "| --- | --- | --- | --- |",
      "| [Southstatebank](https://www.dreamworkhq.com/c/southstatebank.com) | [Summer 2027 Commercial Banking Intern Houston, TX](https://www.dreamworkhq.com/job/houston) | Houston, TX | 23d |",
      "| [Southstatebank](https://www.dreamworkhq.com/c/southstatebank.com) | [Summer 2027 Commercial Banking Intern Richmond, VA](https://www.dreamworkhq.com/job/richmond) | Richmond James Center | 23d |",
    ].join("\n");
    const jobs = extractPublicBoardJobs(snapshot("https://raw.githubusercontent.com/dreamworkhq/Tech-Internships-2027/main/README.md", markdown));

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.postingUrl)).toEqual([
      "https://www.dreamworkhq.com/job/houston",
      "https://www.dreamworkhq.com/job/richmond",
    ]);
    expect(jobs.map((job) => job.applicationUrl)).toEqual([
      "https://www.dreamworkhq.com/job/houston",
      "https://www.dreamworkhq.com/job/richmond",
    ]);
    expect(jobs.every((job) => job.applicationUrl !== "https://www.dreamworkhq.com/c/southstatebank.com")).toBe(true);
  });

  it("prefers the destination around an image Apply badge", () => {
    const markdown = [
      "| Company | Role | Location | Apply |",
      "| --- | --- | --- | --- |",
      "| Acme | Software Engineering Intern | Toronto, ON | [![Apply](https://img.shields.io/badge/-Apply-blue)](https://jobs.example/acme/1) |",
    ].join("\n");
    const jobs = extractPublicBoardJobs(snapshot("https://raw.githubusercontent.com/example/jobs/main/README.md", markdown));
    expect(jobs[0]?.applicationUrl).toBe("https://jobs.example/acme/1");
  });

  it("supports position/application columns used by international lists", () => {
    const markdown = [
      "| Company | Position | Location | Posting | Age |",
      "| --- | --- | --- | --- | --- |",
      "| <a href=\"https://northstar.example\"><strong>Northstar</strong></a> | Software Engineer Intern | Remote Canada | <a href=\"https://northstar.example/apply\"><img alt=\"Apply\"></a> | today |",
    ].join("\n");
    const jobs = extractPublicBoardJobs(snapshot("https://raw.githubusercontent.com/example/jobs/main/INTERN_INTL.md", markdown));
    expect(jobs[0]).toMatchObject({
      company: "Northstar",
      title: "Software Engineer Intern",
      applicationUrl: "https://northstar.example/apply",
      postingDate: "today",
    });
  });

  it("does not surface explicitly closed rows as open jobs", () => {
    const markdown = [
      "| Company | Role | Location | Apply |",
      "| --- | --- | --- | --- |",
      "| Teledyne | AI & Automation Engineer Co-op | Waterloo, ON | Closed🔒 |",
      "| Acme | Software Engineering Intern | Toronto, ON | [Apply](https://jobs.example/acme/1) |",
    ].join("\n");
    const jobs = extractPublicBoardJobs(snapshot("https://raw.githubusercontent.com/example/jobs/main/README.md", markdown));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      company: "Acme",
      title: "Software Engineering Intern",
      applicationUrl: "https://jobs.example/acme/1",
    });
  });

  it("carries forward companies represented by the repository's continuation marker", () => {
    const markdown = [
      "| Company | Role | Location | Application/Link | Date Posted |",
      "| --- | --- | --- | --- | --- |",
      "| ByteDance | Software Engineer Intern | San Jose, CA | <a href=\"https://jobs.example/1\">Apply</a> | Aug 06 |",
      "| ↳ | Frontend Engineer Intern | San Jose, CA | <a href=\"https://jobs.example/2\">Apply</a> | Aug 06 |",
    ].join("\n");
    const jobs = extractPublicBoardJobs(snapshot("https://raw.githubusercontent.com/example/jobs/main/README.md", markdown));
    expect(jobs.map((job) => job.company)).toEqual(["ByteDance", "ByteDance"]);
    expect(jobs[1]?.applicationUrl).toBe("https://jobs.example/2");
  });

  it("derives CSJobs detail URLs when cards only expose data-job-id", () => {
    const url = "https://csjobs.ca/jobs";
    const links = discoverPublicBoardLinks({
      ...snapshot(url, "", `<main><article data-job-id="131646"></article><article data-job-id="132027"></article></main>`),
      contentType: "text/html",
    });
    expect(links.map((link) => link.url)).toEqual([
      "https://csjobs.ca/jobs/131646",
      "https://csjobs.ca/jobs/132027",
    ]);
  });

  it("extracts HiringCafe's public Next data on a detail page", () => {
    const nextData = {
      props: {
        pageProps: {
          job: {
            id: "job-42",
            apply_url: "https://jobs.example/apply/42",
            job_information: {
              title: "Software Engineering Intern",
              description: "<p>Build reliable software with Python and TypeScript while working with product and infrastructure teams.</p><h3>Requirements</h3><ul><li>Computer Science student</li><li>Experience with Git</li></ul>",
              location: "Toronto, Ontario, Canada",
            },
            v5_processed_job_data: {
              workplace_locations: ["Toronto, Ontario, Canada"],
              technical_tools: ["Python", "TypeScript"],
              estimated_publish_date: "2026-08-12",
            },
            enriched_company_data: { name: "Example Robotics" },
          },
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;
    const jobs = extractPublicBoardJobs(snapshot("https://hiringcafe.com/job/example", "", html));
    expect(jobs[0]).toMatchObject({
      company: "Example Robotics",
      title: "Software Engineering Intern",
      locations: ["Toronto, Ontario, Canada"],
      applicationUrl: "https://jobs.example/apply/42",
      postingUrl: "https://hiringcafe.com/job/example",
      jobId: "job-42",
      postingDate: "2026-08-12",
      sourceProvider: "hiringcafe",
    });
  });

  it("extracts Wellfound detail metadata while leaving internal Apply forms on the listing URL", () => {
    const url = "https://wellfound.com/jobs/4570000-software-engineering-intern";
    const html = `<main><a href="/company/example">Example Robotics</a><h1>Software Engineering Intern</h1><a href="/location/toronto">Toronto</a><p>About the role</p><p>Build reliable services in Python and TypeScript, write tests, review code, and collaborate with product and infrastructure teams.</p><h2>What you'll do</h2><ul><li>Ship backend features</li><li>Improve deployment automation</li></ul><p>Posted: today</p></main>`;
    const jobs = extractPublicBoardJobs(snapshot(url, "Software Engineering Intern Toronto Posted: today", html));
    expect(jobs[0]).toMatchObject({
      company: "Example Robotics",
      title: "Software Engineering Intern",
      locations: ["Toronto"],
      applicationUrl: url,
      postingUrl: url,
      sourceProvider: "wellfound",
    });
  });
});
