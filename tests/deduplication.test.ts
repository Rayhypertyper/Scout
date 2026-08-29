import { describe, expect, it } from "vitest";

import {
  compileListingActionMatcher,
  internshipListingActionIdentities,
  listingActionIdentityMatches,
} from "../src/database/actions.js";
import { deduplicateJobs, deduplicateListings, listingIdentityKey, listingIdentityMatches } from "../src/deduplication/deduplicate.js";
import { analyzed, makeInternship } from "./helpers.js";

describe("deduplication", () => {
  it("exposes cheap pre-detail identities and preserves distinct requisitions", () => {
    const first = {
      title: "Software Engineering Intern",
      company: "Acme",
      location: "Toronto, ON, Canada",
      postingUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1001",
    };
    const same = { ...first, postingUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1001?utm_source=feed" };
    const different = { ...first, postingUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1002" };
    expect(listingIdentityKey(first)).toContain("url:");
    expect(listingIdentityMatches(first, same)).toBe(true);
    expect(listingIdentityMatches(first, different)).toBe(false);
    expect(deduplicateListings([first, same, different])).toHaveLength(2);
  });

  it("does not merge distinct roles that share a company landing page", () => {
    const companyPage = "https://www.dreamworkhq.com/c/southstatebank.com";
    const first = {
      company: "Southstatebank",
      title: "Summer 2027 Commercial Banking Intern Houston, TX",
      location: "Houston, TX",
      postingUrl: companyPage,
      applicationUrl: companyPage,
    };
    const second = {
      company: "Southstatebank",
      title: "Summer 2027 Commercial Banking Intern Richmond, VA",
      location: "Richmond James Center",
      postingUrl: companyPage,
      applicationUrl: companyPage,
    };

    expect(listingIdentityMatches(first, second)).toBe(false);
    expect(deduplicateListings([first, second])).toHaveLength(2);
  });

  it("merges the same job across sources and prefers the ATS application", () => {
    const companyCopy = makeInternship({
      applicationUrl: "https://northstar.example/careers/jobs/100",
      postingUrl: "https://northstar.example/careers/jobs/100",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const atsCopy = makeInternship({
      applicationUrl: "https://boards.greenhouse.io/northstar/jobs/100/apply",
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
      sourceUrl: "https://github.com/example/internships",
      sources: ["https://github.com/example/internships"],
    });
    const result = deduplicateJobs([analyzed(companyCopy), analyzed(atsCopy)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.internship.applicationUrl).toContain("greenhouse.io");
    expect(result[0]?.internship.sources).toEqual(expect.arrayContaining([
      "https://tracker.example/internships",
      "https://github.com/example/internships",
    ]));
  });

  it("matches an application-form URL to the corresponding posting URL", () => {
    const aggregatorCopy = makeInternship({
      applicationUrl: "https://jobs.ashbyhq.com/northstar/role-100/application",
      postingUrl: "https://aggregator.example/jobs/role-100",
      sourceUrl: "https://aggregator.example",
      sources: ["https://aggregator.example"],
    });
    const directCopy = makeInternship({
      applicationUrl: "https://jobs.ashbyhq.com/northstar/role-100",
      postingUrl: "https://jobs.ashbyhq.com/northstar/role-100",
      sourceUrl: "https://github.com/example/internships",
      sources: ["https://github.com/example/internships"],
    });
    const result = deduplicateJobs([analyzed(aggregatorCopy), analyzed(directCopy)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.internship.sources).toHaveLength(2);
  });

  it("matches provider URL job IDs even when extractor job IDs are slugs", () => {
    const queryVariant = makeInternship({
      jobId: "software-developer-intern-2027",
      title: "Software Developer Intern 2027",
      applicationUrl: "https://careers.ibm.com/job/123?jobId=128497",
      postingUrl: "https://careers.ibm.com/job/123?jobId=128497",
    });
    const pathVariant = makeInternship({
      jobId: "different-provider-slug",
      title: "Software Development Internship",
      location: ["Markham, Ontario, Canada"],
      normalizedLocations: [{
        raw: "Markham, Ontario, Canada",
        country: "Canada",
        provinceState: "Ontario",
        city: "Markham",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://careers.ibm.com/job/toronto/software-developer-intern-2027/128497",
      postingUrl: "https://careers.ibm.com/job/toronto/software-developer-intern-2027/128497",
    });
    expect(deduplicateJobs([analyzed(queryVariant), analyzed(pathVariant)])).toHaveLength(1);
  });

  it("does not merge distinct direct requisitions with the same company, title, and location", () => {
    const first = makeInternship({
      jobId: "JR1001",
      applicationUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1001",
      postingUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1001",
    });
    const second = makeInternship({
      jobId: "JR1002",
      applicationUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1002",
      postingUrl: "https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Software-Intern_JR1002",
    });
    expect(deduplicateJobs([analyzed(first), analyzed(second)])).toHaveLength(2);
  });

  it("matches a decision across source URL variants without hiding a different requisition", () => {
    const actioned = makeInternship({
      jobId: "REQ-100",
      applicationUrl: "https://boards.greenhouse.io/northstar/jobs/100/apply",
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
    });
    const sameJobFromAnotherSource = makeInternship({
      jobId: "source-specific-slug",
      applicationUrl: "https://careers.northstar.example/jobs/100",
      postingUrl: "https://careers.northstar.example/jobs/100",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const differentRequisition = makeInternship({
      jobId: "REQ-101",
      applicationUrl: "https://boards.greenhouse.io/northstar/jobs/101/apply",
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/101",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));
    const compiledMatcher = compileListingActionMatcher(storedIdentities);

    expect(listingActionIdentityMatches(sameJobFromAnotherSource, storedIdentities)).toBe(true);
    expect(listingActionIdentityMatches(differentRequisition, storedIdentities)).toBe(false);
    expect(compiledMatcher.matches(sameJobFromAnotherSource)).toBe(true);
    expect(compiledMatcher.matches(differentRequisition)).toBe(false);
  });

  it("treats the same normalized listing URL as permanent even when extractor IDs differ", () => {
    const actioned = makeInternship({
      jobId: "source-a-role-2027",
      applicationUrl: "https://jobs.northstar.example/roles/100",
      postingUrl: "https://jobs.northstar.example/roles/100",
    });
    const refreshedCopy = makeInternship({
      jobId: "source-b-role-2027",
      applicationUrl: "https://jobs.northstar.example/roles/100?utm_source=tracker",
      postingUrl: "https://jobs.northstar.example/roles/100?utm_source=tracker",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(refreshedCopy, storedIdentities)).toBe(true);
  });

  it("does not use a generic careers or embedded-form URL as a different role's ID", () => {
    const actioned = makeInternship({
      company: "Quantbot Technologies",
      title: "Quantitative Researcher Internship - 2027 [New York]",
      jobId: null,
      applicationUrl: "https://www.quantbot.com/careers",
      postingUrl: "https://job-boards.greenhouse.io/embed/job_app?for=quantbot-technologies&token=4299496009",
    });
    const differentRole = makeInternship({
      company: "Quantbot Technologies",
      title: "Data Trading Analyst Summer Internship - 2027 [New York]",
      jobId: null,
      applicationUrl: "https://www.quantbot.com/careers",
      postingUrl: "https://job-boards.greenhouse.io/embed/job_app?for=quantbot-technologies&token=4299767009",
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(differentRole, storedIdentities)).toBe(false);
  });

  it("matches an employer ATS copy when the action came from a generic embedded form", () => {
    const actioned = makeInternship({
      company: "Freeform",
      title: "Software Engineering Intern (Summer 2027)",
      jobId: "software-engineering-intern-summer-2027-at-freeform-2027",
      location: ["Los Angeles, CA (On-site)"],
      normalizedLocations: [{
        raw: "Los Angeles, CA (On-site)",
        country: "United States",
        provinceState: "California",
        city: "Los Angeles",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://boards.greenhouse.io/embed/job_app",
      postingUrl: "https://boards.greenhouse.io/embed/job_app",
    });
    const employerCopy = makeInternship({
      ...actioned,
      id: "freeform-employer-copy",
      jobId: "7872198003",
      applicationUrl: "https://job-boards.greenhouse.io/freeformfuturecorp/jobs/7872198003",
      postingUrl: "https://job-boards.greenhouse.io/freeformfuturecorp/jobs/7872198003",
      sourceUrl: "https://freeform.example/careers",
      sources: ["https://freeform.example/careers"],
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(employerCopy, storedIdentities)).toBe(true);
  });

  it("does not turn a company name inside a source slug into a requisition ID", () => {
    const actioned = makeInternship({
      company: "RTX",
      title: "Software Engineering Intern (Summer 2027)",
      jobId: "software-engineer-intern-summer-2027-at-rtx-m-6a726a677c0fb196b50b5f5d",
      applicationUrl: "https://globalhr.wd5.myworkdayjobs.com/jobs/job/Cedar-Rapids/Software-Engineering-Intern_01863980",
      postingUrl: "https://globalhr.wd5.myworkdayjobs.com/jobs/job/Cedar-Rapids/Software-Engineering-Intern_01863980",
    });
    const differentRequisition = makeInternship({
      ...actioned,
      id: "rtx-different-requisition",
      jobId: "software-engineer-intern-summer-2027-at-rtx-m-6a7cfe64ba6b5b077ea840c8",
      applicationUrl: "https://globalhr.wd5.myworkdayjobs.com/jobs/job/Cedar-Rapids/Software-Engineering-Intern_01865875",
      postingUrl: "https://globalhr.wd5.myworkdayjobs.com/jobs/job/Cedar-Rapids/Software-Engineering-Intern_01865875",
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(differentRequisition, storedIdentities)).toBe(false);
  });

  it("matches source copies when location accents or long Workday locations differ", () => {
    const actioned = makeInternship({
      company: "DRW",
      title: "AI/ML Research Intern",
      location: ["Montreal, QC, Canada"],
      normalizedLocations: [{
        raw: "Montreal, QC, Canada",
        country: "Canada",
        provinceState: "Quebec",
        city: "Montreal",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://job-boards.greenhouse.io/drweng/jobs/7991171",
      postingUrl: "https://job-boards.greenhouse.io/drweng/jobs/7991171",
    });
    const accentedCopy = makeInternship({
      company: "DRW",
      title: "AI/ML Research Intern",
      location: ["Montréal"],
      normalizedLocations: [{
        raw: "Montréal",
        country: "Canada",
        provinceState: null,
        city: "Montréal",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://www.drw.com/work-at-drw/listings/aiml-research-intern-3466679",
      postingUrl: "https://www.drw.com/work-at-drw/listings/aiml-research-intern-3466679",
    });
    const workdayCopy = makeInternship({
      company: "General Dynamics Information Technology",
      title: "GDIT 2027 Summer AI / ML Internship",
      location: ["USA VA Falls Church - 3150 Fairview Park Dr, États-Unis d'Amérique"],
      normalizedLocations: [{
        raw: "USA VA Falls Church - 3150 Fairview Park Dr, États-Unis d'Amérique",
        country: "United States",
        provinceState: null,
        city: null,
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://gdit.wd5.myworkdayjobs.com/external_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401",
      postingUrl: "https://gdit.wd5.myworkdayjobs.com/external_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401",
    });
    const workdayAction = makeInternship({
      ...workdayCopy,
      location: ["Falls Church, VA"],
      normalizedLocations: [{
        raw: "Falls Church, VA",
        country: "United States",
        provinceState: "Virginia",
        city: "Falls Church",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://gdit.wd5.myworkdayjobs.com/incumbent_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401-1",
      postingUrl: "https://gdit.wd5.myworkdayjobs.com/incumbent_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401-1",
    });

    const accentedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({ listingKey: "internship:drw", ...identity }));
    const workdayIdentities = internshipListingActionIdentities(workdayAction).map((identity) => ({ listingKey: "internship:gdit", ...identity }));
    expect(listingActionIdentityMatches(accentedCopy, accentedIdentities)).toBe(true);
    expect(listingActionIdentityMatches(workdayCopy, workdayIdentities)).toBe(true);
  });

  it("matches a Workday action when another source drops the locale suffix", () => {
    const actioned = makeInternship({
      jobId: "gdit-2027-summer-ai-ml-internship-at-general-dynamics-information-technology-m-6a7d33d4ba6b5b077eab54cb",
      applicationUrl: "https://gdit.wd5.myworkdayjobs.com/incumbent_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401-1",
      postingUrl: "https://gdit.wd5.myworkdayjobs.com/incumbent_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401-1",
    });
    const sourceCopy = makeInternship({
      jobId: "RQ225401",
      applicationUrl: "https://gdit.wd5.myworkdayjobs.com/external_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401",
      postingUrl: "https://gdit.wd5.myworkdayjobs.com/external_career_site/job/USA-VA-Falls-Church/GDIT-2027-Summer-AI---ML-Internship_RQ225401",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(sourceCopy, storedIdentities)).toBe(true);
  });

  it("matches Workday copies when the source changes the locale URL and location text", () => {
    const actioned = makeInternship({
      location: ["Spring, TX"],
      normalizedLocations: [{
        raw: "Spring, TX",
        country: "United States",
        provinceState: "Texas",
        city: "Spring",
        remote: false,
        remoteScope: null,
      }],
      jobId: "Enterprise-Operations-Software-Internship_3167271-2",
      applicationUrl: "https://hp.wd5.myworkdayjobs.com/externalcareersite/job/Spring-Texas/Enterprise-Operations-Software-Internship_3167271-2",
      postingUrl: "https://hp.wd5.myworkdayjobs.com/externalcareersite/job/Spring-Texas/Enterprise-Operations-Software-Internship_3167271-2",
    });
    const sourceCopy = makeInternship({
      location: ["Houston, TX"],
      normalizedLocations: [{
        raw: "Houston, TX",
        country: "United States",
        provinceState: "Texas",
        city: "Houston",
        remote: false,
        remoteScope: null,
      }],
      jobId: "Enterprise-Operations-Software-Internship_3167271-1",
      applicationUrl: "https://hp.wd5.myworkdayjobs.com/en-US/exteu-ac-careersite/job/Spring-Texas/Enterprise-Operations-Software-Internship_3167271-1",
      postingUrl: "https://hp.wd5.myworkdayjobs.com/en-US/exteu-ac-careersite/job/Spring-Texas/Enterprise-Operations-Software-Internship_3167271-1",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(sourceCopy, storedIdentities)).toBe(true);
  });

  it("matches a discovery copy to the employer ATS when their IDs differ", () => {
    const actioned = makeInternship({
      jobId: "4441146523",
      applicationUrl: "https://ca.linkedin.com/jobs/view/software-developer-test-intern-12mos-at-genesys-4441146523",
      postingUrl: "https://ca.linkedin.com/jobs/view/software-developer-test-intern-12mos-at-genesys-4441146523",
    });
    const sourceCopy = makeInternship({
      jobId: "JR109267",
      applicationUrl: "https://genesys.wd1.myworkdayjobs.com/Genesys/job/Toronto-Flexible/Software-Developer--Test-Intern--12mos-_JR109267-1",
      postingUrl: "https://genesys.wd1.myworkdayjobs.com/Genesys/job/Toronto-Flexible/Software-Developer--Test-Intern--12mos-_JR109267-1",
      sourceUrl: "https://tracker.example/internships",
      sources: ["https://tracker.example/internships"],
    });
    const storedIdentities = internshipListingActionIdentities(actioned).map((identity) => ({
      listingKey: "internship:actioned",
      ...identity,
    }));

    expect(listingActionIdentityMatches(sourceCopy, storedIdentities)).toBe(true);
  });

  it("merges aggregator aliases for the same employer and role", () => {
    const chase = makeInternship({
      company: "Chase",
      title: "2027 Data & AI Program - Summer Internship - Analyst",
      applicationUrl: "https://jobright.ai/jobs/info/one",
      postingUrl: "https://jobright.ai/jobs/info/one",
    });
    const jpmorgan = makeInternship({
      company: "JPMorganChase",
      title: "2027 Data & AI Program - Summer Internship - Analyst",
      applicationUrl: "https://jobright.ai/jobs/info/two",
      postingUrl: "https://jobright.ai/jobs/info/two",
    });
    expect(deduplicateJobs([analyzed(chase), analyzed(jpmorgan)])).toHaveLength(1);
  });

  it("merges legal-name and brand variants across an aggregator and ATS", () => {
    const aggregator = makeInternship({
      company: "Altamira Technologies Corporation",
      title: "Software Development Intern - 2027",
      applicationUrl: "https://jobright.ai/jobs/info/altamira",
      postingUrl: "https://jobright.ai/jobs/info/altamira",
    });
    const official = makeInternship({
      company: "Altamira Technologies Corp.",
      title: "Software Development Intern - 2027",
      applicationUrl: "https://jobs.jobvite.com/altamiracorps/job/oMqCAfw8/apply",
      postingUrl: "https://jobs.jobvite.com/altamiracorps/job/oMqCAfw8",
    });
    expect(deduplicateJobs([analyzed(aggregator), analyzed(official)])).toHaveLength(1);
  });

  it("merges HTML-encoded title and Inc. company variants", () => {
    const aggregator = makeInternship({
      company: "CCC Intelligent Solutions",
      title: "R&D & Data Science Internship Fall 2026",
      applicationUrl: "https://jobright.ai/jobs/info/ccc",
      postingUrl: "https://jobright.ai/jobs/info/ccc",
    });
    const official = makeInternship({
      company: "CCC Intelligent Solutions Inc.",
      title: "R&amp;D &amp; Data Science Internship Fall 2026",
      applicationUrl: "https://cccis.wd1.myworkdayjobs.com/jobs/job/Chicago/R-D-Data-Science_0014841",
      postingUrl: "https://cccis.wd1.myworkdayjobs.com/jobs/job/Chicago/R-D-Data-Science_0014841",
    });
    expect(deduplicateJobs([analyzed(aggregator), analyzed(official)])).toHaveLength(1);
  });
});
