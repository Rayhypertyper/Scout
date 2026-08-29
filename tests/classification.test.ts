import { describe, expect, it } from "vitest";

import {
  classifyRole,
  detectInternship,
  INTERNSHIP_TITLE_BONUS,
  MISSING_INTERNSHIP_PENALTY,
  SCORING_FACTOR_MULTIPLIER,
  SUMMER_2027_BONUS,
} from "../src/classification/roleClassifier.js";
import { analyzeRawJob } from "../src/classification/analyzeJob.js";
import { extractTechnologies } from "../src/classification/technologyExtractor.js";
import { scoreListingRelevance } from "../src/classification/listingRelevance.js";

describe("role classification", () => {
  it.each(["IT Intern", "Product Engineering Intern", "Research Intern"])("keeps ambiguous technical listing %s on the slow path", (title) => {
    const result = scoreListingRelevance({ title });
    expect(result.shouldFetchDetail).toBe(true);
    expect(result.decision).toBe("slow-path");
  });

  it.each(["Marketing Intern", "Legal Intern", "Accounting Intern"])("rejects clearly irrelevant listing %s before detail fetching", (title) => {
    const result = scoreListingRelevance({ title });
    expect(result.clearlyIrrelevant).toBe(true);
    expect(result.decision).toBe("fast-reject");
    expect(result.shouldFetchDetail).toBe(false);
  });

  it("retains mixed interdisciplinary technical listings", () => {
    const result = scoreListingRelevance({ title: "Marketing Technology Intern", department: "Software Platform" });
    expect(result.mixedSignal).toBe(true);
    expect(result.shouldFetchDetail).toBe(true);
  });

  it("accepts an ambiguous technical title after reading coding responsibilities", () => {
    const result = classifyRole(
      "Technology Intern",
      "Develop Python services, write APIs, debug distributed systems, and build automated tests in Docker on AWS.",
      "Currently pursuing Computer Science; experience with data structures and programming.",
    );
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.categories).toContain("backend");
    expect(result.technologies).toEqual(expect.arrayContaining(["Python", "Docker", "AWS"]));
  });

  it("tags software engineering titles as SWE", () => {
    const result = classifyRole("Software Engineering Intern", "Develop and test TypeScript software services.");
    expect(result.categories).toContain("swe");
  });

  it("heavily penalizes a software role with no internship or student-placement signal", () => {
    const result = classifyRole("Software Engineer", "Develop production software using Python and TypeScript.");
    expect(result.score).toBeLessThan(60);
    expect(result.reason).toContain(`missing internship/co-op/student-placement signal penalty (-${MISSING_INTERNSHIP_PENALTY})`);
  });

  it.each(["Intern", "Internship", "Co-op"])("strongly rewards an explicit %s title signal", (term) => {
    const description = "This internship program includes team projects and mentoring.";
    const titled = classifyRole(`Technology ${term}`, description);
    const untitled = classifyRole("Technology", description);
    expect(titled.score - untitled.score).toBe(INTERNSHIP_TITLE_BONUS);
    expect(titled.reason).toContain(`internship/co-op title bonus (+${INTERNSHIP_TITLE_BONUS})`);
  });

  it("heavily rewards a reliable Summer 2027 signal", () => {
    const ordinary = classifyRole("Intern", "Participate in team projects and mentoring.");
    const summer2027 = classifyRole("Intern", "Participate in team projects and mentoring during Summer 2027.");
    const dateEvidence = classifyRole("Intern", "Participate in team projects and mentoring.", "", "Internship term: Summer 2027");
    expect(summer2027.score - ordinary.score).toBe(SUMMER_2027_BONUS);
    expect(dateEvidence.score - ordinary.score).toBe(SUMMER_2027_BONUS);
    expect(summer2027.reason).toContain(`Summer 2027 target bonus (+${SUMMER_2027_BONUS})`);
  });

  it("applies the reduced multiplier to each explainable score component", () => {
    const result = classifyRole("Intern", "Develop software using Python.", "Computer Science.");
    expect(SCORING_FACTOR_MULTIPLIER).toBe(0.75);
    expect(result.score).toBe(58);
    expect(result.reason).toContain("internship/co-op title bonus (+34)");
    expect(result.reason).toContain("1 programming-responsibility signal (+13)");
    expect(result.reason).toContain("1 named software technology (+3)");
    expect(result.reason).toContain("software-related qualification (+8)");
  });

  it("does not let a Summer 2027 date override the missing-placement penalty", () => {
    const result = classifyRole("Software Engineer", "Develop production software using Python for Summer 2027.");
    expect(result.score).toBeLessThan(60);
    expect(result.reason).toContain("Summer 2027 signal ignored");
    expect(result.reason).not.toContain(`Summer 2027 target bonus (+${SUMMER_2027_BONUS})`);
  });

  it("rejects a non-coding marketing internship despite the internship word", () => {
    const result = classifyRole(
      "Marketing Intern",
      "Create social media campaigns, perform lead generation, and coordinate brand events.",
    );
    expect(result.score).toBeLessThan(60);
    expect(result.categories).toHaveLength(0);
  });
});

describe("internship detection", () => {
  it("uses the actual position title", () => {
    expect(detectInternship("Software Engineer Intern", "Build software.").isInternship).toBe(true);
  });

  it.each([
    ["Software Developer", "This co-op position develops production software."],
    ["Software Developer", "This cooperative education placement develops production software."],
    ["Software Developer", "This is a full-time internship program for students."],
    ["Software Developer", "Our internship program develops production software."],
    ["Software Developer", "Our coop program develops production software."],
    ["Software Developer", "This student position develops production software."],
    ["Student Software Developer", "Develop production software."],
  ])("recognizes related student-placement terminology", (title, description) => {
    expect(detectInternship(title, description).isInternship).toBe(true);
  });

  it("does not use unrelated footer text", () => {
    expect(detectInternship("Senior Software Engineer", "Build software. Explore our internship program in the site footer.").isInternship).toBe(false);
  });
});

describe("technology extraction", () => {
  it("recognizes aliases without confusing Java and JavaScript", () => {
    const technologies = extractTechnologies("Use JavaScript, Node.js, PostgreSQL, k8s, PyTorch, and C++.");
    expect(technologies).toEqual(expect.arrayContaining(["JavaScript", "Node.js", "SQL", "Kubernetes", "PyTorch", "C++"]));
    expect(technologies).not.toContain("Java");
  });
});

describe("job analysis normalization", () => {
  it("rejects jobs routed to a known ATS integration sandbox", async () => {
    const result = await analyzeRawJob({
      company: "Atoms",
      title: "Software Engineer Intern",
      description: "Develop and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship program.",
      postingUrl: "https://simplify.jobs/p/example/software-engineer-intern",
      applicationUrl: "https://job-boards.greenhouse.io/cssmerge/jobs/8687896002",
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async (url) => url);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("integration sandbox");
  });

  it("normalizes ByteDance's careers hostname and rejects a shallow careers root as the apply URL", async () => {
    const result = await analyzeRawJob({
      company: "Joinbytedance",
      title: "[Remote] Software Engineer Intern",
      description: "Software Engineer Intern. Develop and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship program.",
      postingUrl: "https://joinbytedance.com/search/123456789",
      applicationUrl: "https://joinbytedance.com/",
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async (url) => url);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.internship.company).toBe("ByteDance");
    expect(result.value.internship.title).toBe("Software Engineer Intern");
    expect(result.value.internship.applicationUrl).toBe("https://joinbytedance.com/search/123456789");
  });

  it("does not split the plural Locations heading into a fake location", async () => {
    const result = await analyzeRawJob({
      company: "Example",
      title: "Software Engineer Intern",
      locations: ["Chicago, IL, United States"],
      description: "Software Engineer Intern. Develop production software using Python. Required Qualifications: Pursuing Computer Science. Locations you may join:\nChicago, IL.",
      postingUrl: "https://example.com/jobs/123",
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async (url) => url);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.internship.location).not.toContain("s you may join:");
  });

  it("promotes a verified aggregator destination to the original posting URL", async () => {
    const original = "https://careers.tiktokusds.com/usds/position/7671509975932324149/detail";
    const result = await analyzeRawJob({
      company: "TikTok USDS Joint Venture",
      title: "Software Engineer Intern (E-commerce) - 2027 Summer",
      locations: ["Seattle, WA, United States"],
      description: "Software Engineer Intern. Build and test distributed production software using Go. Required Qualifications: Pursuing Computer Science in Summer 2027.",
      postingUrl: "https://jobright.ai/jobs/info/6a7ad6a0ab1385611f900364",
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async () => original);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.internship.postingUrl).toBe(original);
  });

  it("never emits a Jobright URL when its Original job post cannot be resolved", async () => {
    const result = await analyzeRawJob({
      company: "Example Robotics",
      title: "Software Engineer Intern",
      locations: ["Toronto, ON, Canada"],
      description: "Build and test production software using Python. Currently pursuing Computer Science. This is a full-time internship for Summer 2027.",
      postingUrl: "https://jobright.ai/jobs/info/unresolved-job",
      applicationUrl: "https://jobright.ai/jobs/info/unresolved-job",
      sourceProvider: "jobright-intern-list",
    }, "https://www.intern-list.com/?k=swe", 60, async () => null);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("Original job post");
  });

  it("retains the proposed application destination when a redirect is not found", async () => {
    const postingUrl = "https://example.com/jobs/software-intern-2027";
    const result = await analyzeRawJob({
      company: "Example",
      title: "Software Engineer Intern",
      locations: ["Toronto, ON, Canada"],
      description: "Build and test production software using Python. Currently pursuing Computer Science. This is a full-time internship for Summer 2027.",
      postingUrl,
      applicationUrl: "https://example.com/apply/software-intern-2027",
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async () => null);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.internship.applicationUrl).toBe("https://example.com/apply/software-intern-2027");
  });

  it("rejects an unverified LinkedIn posting", async () => {
    const linkedinUrl = "https://www.linkedin.com/jobs/view/123456789";
    const result = await analyzeRawJob({
      company: "Example",
      title: "Software Engineer Intern",
      locations: ["Toronto, ON, Canada"],
      description: "Build and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship program.",
      postingUrl: linkedinUrl,
      applicationUrl: linkedinUrl,
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async () => null);
    expect(result.accepted).toBe(false);
  });

  it("rejects otherwise qualified postings outside Canada, the United States, and remote", async () => {
    const result = await analyzeRawJob({
      company: "Example Europe",
      title: "Software Engineer Intern",
      locations: ["London, United Kingdom"],
      description: "Build and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship program.",
      postingUrl: "https://example.com/jobs/london-intern",
      sourceProvider: "generic",
    }, "https://example.com/list", 60, async (url) => url);
    expect(result.accepted).toBe(false);
  });

  it("rejects excluded title-year signals while accepting the target summer year", async () => {
    const common = {
      company: "Example",
      locations: ["Toronto, ON, Canada"],
      description: "Build and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship for Summer 2027. The posting date is 2026-08-01.",
      postingUrl: "https://example.com/jobs/2026-software-intern",
      applicationUrl: "https://example.com/apply/2026-software-intern",
      sourceProvider: "generic",
    };
    const title2026 = await analyzeRawJob({ ...common, title: "Software Engineer Intern - Fall 2026" }, "https://example.com/list", 60, async (url) => url);
    expect(title2026.accepted).toBe(false);

    const allowed = await analyzeRawJob({ ...common, title: "Software Engineer Intern - Summer 2027" }, "https://example.com/list", 60, async (url) => url);
    expect(allowed.accepted).toBe(true);

    const mixedYears = await analyzeRawJob({ ...common, title: "Software Engineer Intern - Fall 2026 / Summer 2027" }, "https://example.com/list", 60, async (url) => url);
    expect(mixedYears.accepted).toBe(true);
  });

  it.each(["Software Engineer, New Grad", "New-Graduate Software Engineer", "Software Engineer (NEW GRADS)"])(
    "rejects new-grad titles regardless of formatting: %s",
    async (title) => {
      const result = await analyzeRawJob({
        company: "Example",
        title,
        locations: ["Toronto, ON, Canada"],
        description: "Build and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship for Summer 2027.",
        postingUrl: "https://example.com/jobs/new-grad-software-intern",
        applicationUrl: "https://example.com/apply/new-grad-software-intern",
        sourceProvider: "generic",
      }, "https://example.com/list", 60, async (url) => url);

      expect(result.accepted).toBe(false);
    },
  );

  it.each(["PhD Software Engineering Intern", "Software Engineering Intern (Ph.D.)"])(
    "rejects PhD titles regardless of formatting: %s",
    async (title) => {
      const result = await analyzeRawJob({
        company: "Example",
        title,
        locations: ["Toronto, ON, Canada"],
        description: "Build and test production software using Python and TypeScript. Currently pursuing a Computer Science degree. This is a full-time internship for Summer 2027.",
        postingUrl: "https://example.com/jobs/phd-intern",
        applicationUrl: "https://example.com/apply/phd-intern",
        sourceProvider: "generic",
      }, "https://example.com/list", 60, async (url) => url);

      expect(result.accepted).toBe(false);
    },
  );
});
