import { describe, expect, it } from "vitest";

import { isAllowedPostingLocation, parseLocation, parseLocations } from "../src/parsing/locations.js";
import { containsExplicitDate, extractTemporalDetails, sanitizePostingDate } from "../src/parsing/dates.js";
import { extractJobSections, extractQualificationDetails, extractRequirementDetails } from "../src/parsing/qualifications.js";
import { extractWorkAuthorization } from "../src/parsing/workAuthorization.js";

describe("qualification parsing", () => {
  it("extracts explicit structured eligibility and leaves absent facts unknown", () => {
    const details = extractQualificationDetails("Class of 2027 or 2028. Expected graduation May 2028. Open to first-year students. Bachelor’s degree in Computer Science. Must be legally authorized to work in Canada. Visa sponsorship is not available. Hybrid role. Apply by September 1, 2026.");
    expect(details.graduationYears).toEqual([2027, 2028]);
    expect(details.graduationYearRange).toEqual({ min: 2027, max: 2028 });
    expect(details.expectedGraduation).toContain("Expected graduation");
    expect(details.firstYearEligible).toBe("yes");
    expect(details.workAuthorization).toBe("required");
    expect(details.sponsorship).toBe("unavailable");
    expect(details.locationModality).toBe("hybrid");
    expect(details.deadline).toContain("Apply by");

    const unknown = extractQualificationDetails("Build useful tools with the team. Competitive pay and mentoring.");
    expect(unknown.graduationYears).toEqual([]);
    expect(unknown.firstYearEligible).toBe("unknown");
    expect(unknown.upperYearRequired).toBe("unknown");
    expect(unknown.workAuthorization).toBe("unknown");
    expect(unknown.sponsorship).toBe("unknown");
  });

  it("recognizes upper-year requirements and explicit first-year exclusion", () => {
    const details = extractQualificationDetails("Applicants must be at least a sophomore or junior. Freshmen are not eligible. Rising seniors preferred.");
    expect(details.yearOfStudy).toEqual(expect.arrayContaining(["second-year", "third-year", "first-year", "fourth-year"]));
    expect(details.firstYearEligible).toBe("no");
    expect(details.upperYearRequired).toBe("yes");
    expect(details.upperYearRequirement).toContain("sophomore");
  });

  const posting = `
Responsibilities
- Build Python APIs.
Minimum Qualifications
- Currently pursuing a Bachelor's degree in Computer Science.
- Experience with data structures and algorithms.
Preferred Qualifications
- Familiarity with AWS.
This is a 12-week Summer internship.
Benefits
- Health coverage.
`;

  it("keeps required and preferred qualifications separate", () => {
    const sections = extractJobSections(posting);
    expect(sections.requiredQualifications).toContain("Currently pursuing a Bachelor's degree in Computer Science.");
    expect(sections.preferredQualifications).toContain("Familiarity with AWS.");
    expect(sections.preferredQualifications).not.toContain("This is a 12-week Summer internship.");
    expect(sections.requiredQualifications).not.toContain("Familiarity with AWS.");
  });

  it("recovers flattened Workday-style inline headings", () => {
    const flattened = "What You Will Do Develop and test C++ systems. Debug production code. Qualifications You Must Have Must be pursuing a Bachelor's degree. Experience with C++. Qualifications We Prefer Knowledge of Linux. Strong communication skills. What We Offer Competitive benefits.";
    const sections = extractJobSections(flattened);
    expect(sections.responsibilities).toEqual([
      "Develop and test C++ systems.",
      "Debug production code.",
    ]);
    expect(sections.requiredQualifications).toEqual([
      "Must be pursuing a Bachelor's degree.",
      "Experience with C++.",
    ]);
    expect(sections.preferredQualifications).toEqual([
      "Knowledge of Linux.",
      "Strong communication skills.",
    ]);
  });

  it("recognizes a flattened Preferences heading and stops at role-type boilerplate", () => {
    const sections = extractJobSections("Requirements: Pursuing Computer Science. Preferences: Experience with React. Please ensure the role type is appropriate. Hybrid: Employees split time.");
    expect(sections.requiredQualifications).toEqual(["Pursuing Computer Science."]);
    expect(sections.preferredQualifications).toEqual(["Experience with React."]);
  });

  it("separates unpunctuated headings from flattened structured job data", () => {
    const flattened = "What you'll do Build Python services. Test production code. What you'll need Currently pursuing Computer Science. Experience with APIs. Preferred Qualifications Familiarity with AWS. Knowledge of Kubernetes. Benefits Medical coverage.";
    const sections = extractJobSections(flattened);
    expect(sections.responsibilities).toEqual(["Build Python services.", "Test production code."]);
    expect(sections.requiredQualifications).toEqual(["Currently pursuing Computer Science.", "Experience with APIs."]);
    expect(sections.preferredQualifications).toEqual(["Familiarity with AWS.", "Knowledge of Kubernetes."]);
  });

  it("stops flattened qualification sections at recruiting and benefit content", () => {
    const sections = extractJobSections("Required: Strong Python skills. Preferred: Experience with Kubernetes. Why work with us? Medical benefits. Our Hiring Process Interviews follow.");
    expect(sections.requiredQualifications).toEqual(["Strong Python skills."]);
    expect(sections.preferredQualifications).toEqual(["Experience with Kubernetes."]);
  });

  it("does not treat prose containing what you need as a qualifications heading", () => {
    const text = "We will give you what you need to succeed. Responsibilities include: Build APIs. We are looking for someone who: has Python experience. Nice to have: AWS. About the Internship: paid placement.";
    const sections = extractJobSections(text);
    expect(sections.responsibilities).toEqual(["Build APIs."]);
    expect(sections.requiredQualifications).toEqual(["has Python experience."]);
    expect(sections.preferredQualifications).toEqual(["AWS."]);
  });

  it("splits flattened comma-separated qualification lists", () => {
    const sections = extractJobSections("We are looking for someone who: is interested in testing, has basic knowledge of TypeScript, works well on a team. Nice to have: familiarity with Playwright, basic knowledge of Git. About the Internship: paid placement.");
    expect(sections.requiredQualifications).toEqual([
      "is interested in testing",
      "has basic knowledge of TypeScript",
      "works well on a team.",
    ]);
    expect(sections.preferredQualifications).toEqual([
      "familiarity with Playwright",
      "basic knowledge of Git.",
    ]);
  });

  it("routes bonus items and omits authorization boilerplate from preferred qualifications", () => {
    const sections = extractJobSections("Minimum Qualifications: Experience with Python. Don't meet them all? Apply anyway. Bonus: Experience with AWS. We will not sponsor employment authorization. Base Hourly Pay: $30.");
    expect(sections.requiredQualifications).toEqual(["Experience with Python."]);
    expect(sections.preferredQualifications).toEqual(["Experience with AWS."]);
  });

  it("ends preferred qualifications at flattened Workday basic and travel sections", () => {
    const sections = extractJobSections("Preferred Qualifications Generative AI exposure. Rising Junior preferred Basic Requirements Currently pursuing Computer Science. Office hours are weekdays. Travel Requirements Under 10% Relocation Provided None Position Type Intern EEO Statement Equal opportunity employer.");
    expect(sections.preferredQualifications).toEqual(["Generative AI exposure.", "Rising Junior preferred"]);
    expect(sections.requiredQualifications).toEqual(["Currently pursuing Computer Science."]);
  });

  it("handles Copart-style nice-to-have sections without absorbing EEO boilerplate", () => {
    const sections = extractJobSections("Required Skills: Experience with Java. Additional Skills (nice to haves): Experience with Linux. Experience with Git #LI-MS1 At Copart, we value diversity. E-Verify Program Participant: Learn more.");
    expect(sections.requiredQualifications).toEqual(["Experience with Java."]);
    expect(sections.preferredQualifications).toEqual(["Experience with Linux.", "Experience with Git"]);
  });

  it("routes eligibility to requirements and stops at company values", () => {
    const sections = extractJobSections("QUALIFICATIONS & EXPERIENCE YOU WILL NEED: Minimum: Experience with Python. Preferred: Experience with AWS. ELIGIBILITY: Graduating in 2027. OUR VALUES: We hire the brightest talent and develop leaders.");
    expect(sections.requiredQualifications).toEqual(["Experience with Python.", "Graduating in 2027."]);
    expect(sections.preferredQualifications).toEqual(["Experience with AWS."]);
  });

  it("stops Milliman-style qualifications at team and benefit headings", () => {
    const sections = extractJobSections("Professional Qualifications: Pursuing Computer Science. Personal Qualifications: Strong organization. Preferred Qualifications: Experience with Python. The Team Collaborates globally. Compensation $30 per hour. Benefits Employee Assistance Program.");
    expect(sections.requiredQualifications).toEqual(["Pursuing Computer Science.", "Strong organization."]);
    expect(sections.preferredQualifications).toEqual(["Experience with Python."]);
  });

  it("stops SmartRecruiters qualifications at additional company information", () => {
    const sections = extractJobSections("Minimum Qualifications Experience with Python. Preferred Qualifications Experience with C++. Additional Information Western Digital creates data storage technology. Equal Employment Opportunity We welcome all applicants.");
    expect(sections.requiredQualifications).toEqual(["Experience with Python."]);
    expect(sections.preferredQualifications).toEqual(["Experience with C++."]);
  });

  it("routes generic skills to requirements and location details out of qualifications", () => {
    const sections = extractJobSections("Responsibilities\nBuild Python services.\nSkills\nExperience with Python.\nFamiliarity with AWS is preferred.\nYou are committed to the 5-month internship.\nExperience with GitHub.\nLocation & details\nRemote in the United States.\nPaid internship.");
    expect(sections.responsibilities).toEqual(["Build Python services."]);
    expect(sections.requiredQualifications).toEqual([
      "Experience with Python.",
      "You are committed to the 5-month internship.",
      "Experience with GitHub.",
    ]);
    expect(sections.preferredQualifications).toEqual(["Familiarity with AWS is preferred."]);
  });

  it("stops flattened qualifications at ordinary location and company headings", () => {
    const sections = extractJobSections("Required Skills: Python. Preferred Skills: React. Location: Madison, WI About Philips We are a health technology company.");
    expect(sections.requiredQualifications).toEqual(["Python."]);
    expect(sections.preferredQualifications).toEqual(["React."]);
  });

  it("does not confuse pay-factor prose with a responsibilities heading", () => {
    const sections = extractJobSections("Pay is based on school year, role responsibilities, etc. Company overview text. Key Responsibilities: Build AI prototypes. Requirements: Experience with Python. If you are passionate about AI, join our team. Interview Policy & Privacy Notice: Video interviews are transcribed.");
    expect(sections.responsibilities).toEqual(["Build AI prototypes."]);
    expect(sections.requiredQualifications).toEqual(["Experience with Python."]);
  });

  it("does not treat your background in ordinary prose as an inline heading", () => {
    const sections = extractJobSections("Responsibilities: Depending on your background and interests, you may build systems. Qualifications: Experience with Go. Preferred Qualifications: Kubernetes. By submitting an application, you accept the privacy policy. Job Information Compensation follows.");
    expect(sections.responsibilities).toEqual(["Depending on your background and interests, you may build systems."]);
    expect(sections.requiredQualifications).toEqual(["Experience with Go."]);
    expect(sections.preferredQualifications).toEqual(["Kubernetes."]);
  });

  it("handles JPMorganChase capability headings without leaking legal or location text", () => {
    const sections = extractJobSections("REQUIRED QUALIFICATIONS, CAPABILITIES AND SKILLS Pursuing Computer Science. Authorized to work permanently in the United States. PREFERRED QUALIFICATIONS, CAPABILITIES, AND SKILLS Experience with Python. This position is subject to Section 19 of the Federal Deposit Insurance Act. Locations you may join: Chicago, IL.");
    expect(sections.requiredQualifications).toEqual(["Pursuing Computer Science."]);
    expect(sections.preferredQualifications).toEqual(["Experience with Python."]);
  });

  it("separates IBM education and technical expertise sections", () => {
    const sections = extractJobSections("Required education High School Diploma/GED Preferred education Bachelor's Degree Required technical and professional expertise Linux experience. Python scripting. Preferred technical and professional experience Kubernetes. Terraform. ABOUT BUSINESS UNIT IBM Software builds products.");
    expect(sections.requiredQualifications).toEqual(["High School Diploma/GED", "Linux experience.", "Python scripting."]);
    expect(sections.preferredQualifications).toEqual(["Bachelor's Degree", "Kubernetes.", "Terraform."]);
  });

  it("drops qualification subheading fragments and cleans requirement prefixes", () => {
    const sections = extractJobSections("Required Qualifications Criteria: Pursuing Computer Science. Minimum: Python. Operation and Support Experience: Linux. Job Description Company overview.");
    expect(sections.requiredQualifications).toEqual([
      "Pursuing Computer Science.",
      "Python.",
      "Experience: Linux.",
    ]);
    const details = extractRequirementDetails("Currently pursuing Computer Science. Minimum Qualifications Currently pursuing Computer Science. Required Skills: Education: Bachelor's degree.");
    expect(details.education).toEqual(["Currently pursuing Computer Science.", "Bachelor's degree."]);
  });

  it("extracts education, graduation, experience, and authorization only when stated", () => {
    const details = extractRequirementDetails(`${posting}\nMust graduate in 2028 and return to school. Previous experience with Python is preferred.`);
    expect(details.education.length).toBeGreaterThan(0);
    expect(details.graduation.length).toBeGreaterThan(0);
    expect(details.experience.length).toBeGreaterThan(0);
    const unrelated = extractRequirementDetails("Senior executive interactions are available. Your manager decides the degree of onsite presence.");
    expect(unrelated.education).toHaveLength(0);
    expect(unrelated.graduation).toHaveLength(0);
    const authorization = extractWorkAuthorization("Must be authorized to work in Canada. We cannot provide visa sponsorship.");
    expect(authorization.requirements).toHaveLength(2);
    expect(authorization.sponsorshipInformation).toContain("sponsorship");
    expect(extractQualificationDetails("We don't sponsor visas.").sponsorship).toBe("unavailable");
    expect(extractWorkAuthorization("The agency handles the security clearance process.").requirements).toHaveLength(0);
  });

  it("does not confuse sponsorship language with a work-authorization exemption", () => {
    const details = extractQualificationDetails("No visa sponsorship is available.");

    expect(details.sponsorship).toBe("unavailable");
    expect(details.workAuthorization).toBe("unknown");
  });

  it("keeps sparse graduation years discrete while honoring explicit ranges", () => {
    const sparse = extractQualificationDetails("Class of 2027 or class of 2029.");
    const range = extractQualificationDetails("Candidates graduating between 2027 and 2029 are eligible.");

    expect(sparse.graduationYears).toEqual([2027, 2029]);
    expect(sparse.graduationYearRange).toBeNull();
    expect(range.graduationYearRange).toEqual({ min: 2027, max: 2029 });
  });
});

describe("location parsing", () => {
  it("normalizes Canadian cities and provinces", () => {
    expect(parseLocation("Toronto, ON, Canada")).toMatchObject({
      country: "Canada",
      provinceState: "Ontario",
      city: "Toronto",
      remote: false,
    });
  });

  it("does not confuse Canadian CA country codes with California", () => {
    expect(parseLocation("Montreal, QC, CA")).toMatchObject({
      country: "Canada",
      provinceState: "Quebec",
      city: "Montreal",
    });
    expect(parseLocation("San Jose, CA")).toMatchObject({
      country: "United States",
      provinceState: "California",
    });
    expect(parseLocation("Richmond, VA")).toMatchObject({
      country: "United States",
      provinceState: "Virginia",
    });
    expect(parseLocation("New Brunswick, NJ")).toMatchObject({
      country: "United States",
      provinceState: "New Jersey",
    });
    expect(parseLocation("CA").country).toBe("Canada");
  });

  it("does not infer Canada from an ambiguous city embedded in a facility name", () => {
    expect(parseLocation("Richmond James Center")).toMatchObject({
      country: null,
      city: "Richmond",
    });
    expect(parseLocation("Richmond, VA")).toMatchObject({ country: "United States" });
    expect(parseLocation("Richmond, BC")).toMatchObject({ country: "Canada" });
    expect(parseLocation("Victoria Center")).toMatchObject({ country: null });
    expect(parseLocation("Victoria, BC")).toMatchObject({ country: "Canada" });
  });

  it("keeps foreign multi-city locations out of the Canadian taxonomy", () => {
    const raw = "Sydney, New South Wales, Australia · Melbourne, Victoria, Australia · Brisbane, Queensland, Australia";
    const parsed = parseLocations([raw]);

    expect(parsed.raw).toEqual([
      "Sydney, New South Wales, Australia",
      "Melbourne, Victoria, Australia",
      "Brisbane, Queensland, Australia",
    ]);
    expect(parsed.normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ country: "Australia", city: "Sydney" }),
      expect.objectContaining({ country: "Australia", city: "Melbourne" }),
      expect.objectContaining({ country: "Australia", city: "Brisbane" }),
    ]));
    expect(parsed.normalized.some(({ country }) => country === "Canada")).toBe(false);
    expect(isAllowedPostingLocation(parsed.normalized, parsed.remoteStatus)).toBe(false);
  });

  it("allows only Canada, the United States, or remote postings", () => {
    const canada = parseLocations(["Toronto, ON, Canada"]);
    const usa = parseLocations(["San Jose, CA, United States"]);
    const remote = parseLocations(["Remote"]);
    const foreign = parseLocations(["Shanghai, China"]);
    const unknown = parseLocations([]);

    expect(isAllowedPostingLocation(canada.normalized, canada.remoteStatus)).toBe(true);
    expect(isAllowedPostingLocation(usa.normalized, usa.remoteStatus)).toBe(true);
    expect(isAllowedPostingLocation(remote.normalized, remote.remoteStatus)).toBe(true);
    expect(isAllowedPostingLocation(foreign.normalized, foreign.remoteStatus)).toBe(false);
    expect(isAllowedPostingLocation(unknown.normalized, unknown.remoteStatus)).toBe(false);
  });

  it("does not assume an unspecified remote role is worldwide", () => {
    const result = parseLocations(["Remote"]);
    expect(result.remoteStatus).toBe("remote");
    expect(result.normalized[0]?.remoteScope).toBe("unspecified");
    expect(result.normalized[0]?.country).toBeNull();
  });

  it("distinguishes Remote US and Remote North America", () => {
    expect(parseLocation("Remote US").remoteScope).toBe("usa");
    expect(parseLocation("Remote North America").remoteScope).toBe("north-america");
  });

  it("normalizes localized Workday US locations", () => {
    expect(parseLocation("US-MA-TEWKSBURY-TB3 ~ 50 Apple Hill Dr, Tewksbury, États-Unis d'Amérique")).toMatchObject({
      country: "United States",
      provinceState: "Massachusetts",
      city: "Tewksbury",
    });
  });

  it("finds known cities inside long localized location strings", () => {
    expect(parseLocation("USA-VA-Falls Church - 3150 Fairview Park Dr, États-Unis d'Amérique")).toMatchObject({
      country: "United States",
      provinceState: "Virginia",
      city: "Falls Church",
    });
  });

  it("recognizes standalone state and province names in compact location strings", () => {
    expect(parseLocation("Boulder CO")).toMatchObject({
      country: "United States",
      provinceState: "Colorado",
    });
    expect(parseLocation("Remote Ontario")).toMatchObject({
      country: "Canada",
      provinceState: "Ontario",
    });
  });

  it("prioritizes the posting's explicit work model over boilerplate definitions", () => {
    const parsed = parseLocations(
      ["Boston, MA, United States"],
      "Position Role Type: Onsite. Hybrid: Employees split time. Remote: Employees work offsite.",
    );
    expect(parsed.remoteStatus).toBe("onsite");
  });
});

describe("temporal parsing", () => {
  it("uses internship context instead of company-history years", () => {
    const result = extractTemporalDetails(
      "Recognized in the Q3 2023 Report. Starting Date: January 2027. The engineering internship program develops software.",
      "Software Engineer Co-op",
    );
    expect(result.internshipYear).toBe("2027");
    expect(result.internshipTerm).toBeNull();
  });

  it("prioritizes a term and year stated in the title", () => {
    const result = extractTemporalDetails("The company was founded in 2008.", "Software Engineer Intern - Summer 2027");
    expect(result.internshipTerm).toBe("Summer");
    expect(result.internshipYear).toBe("2027");
  });

  it("does not confuse ordinary posted prose or benefit periods with temporal fields", () => {
    const result = extractTemporalDetails(
      "The salary may vary from the range posted. We provide 12 weeks of parental leave. Candidates who apply by this date receive priority.",
      "Software Engineering Intern",
    );
    expect(result.postingDate).toBeNull();
    expect(result.deadline).toBeNull();
    expect(result.duration).toBeNull();
  });

  it("recognizes explicit posting dates, deadlines, and internship durations", () => {
    const result = extractTemporalDetails(
      "Date Posted: 2026-08-11. Application Deadline: September 1, 2026. This is a 12-week internship.",
      "Software Engineering Intern",
    );
    expect(result.postingDate).toContain("2026-08-11");
    expect(result.deadline).toContain("September 1, 2026");
    expect(result.duration).toContain("12-week internship");
    expect(containsExplicitDate("Thu Jul 23 18:40:08 UTC 2026")).toBe(true);
  });

  it("removes serialized page payloads from stored posting dates", () => {
    expect(sanitizePostingDate("yesterday self.__next_f payload")).toBe("yesterday");
    expect(sanitizePostingDate("self.__next_f serialized payload", "2026-08-12")).toBe("2026-08-12");
    expect(sanitizePostingDate("24d")).toBe("24d");
  });
});
