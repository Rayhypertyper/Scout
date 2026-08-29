import { internshipContentHash } from "../src/classification/analyzeJob.js";
import { InternshipSchema, type Internship } from "../src/domain/schemas.js";
import type { AnalyzedJob } from "../src/domain/types.js";

export function makeInternship(overrides: Partial<Internship> = {}): Internship {
  return InternshipSchema.parse({
    id: "job-1",
    jobId: "REQ-100",
    company: "Northstar Labs",
    title: "Software Engineering Intern",
    location: ["Toronto, ON, Canada"],
    normalizedLocations: [{
      raw: "Toronto, ON, Canada",
      country: "Canada",
      provinceState: "Ontario",
      city: "Toronto",
      remote: false,
      remoteScope: null,
    }],
    remoteStatus: "onsite",
    applicationUrl: "https://boards.greenhouse.io/northstar/jobs/100/apply",
    postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
    sourceUrl: "https://example.com/careers",
    sources: ["https://example.com/careers"],
    description: "Develop and test TypeScript software services and debug APIs for a production platform.",
    responsibilities: ["Develop TypeScript software services."],
    requiredQualifications: ["Currently pursuing a Bachelor's degree in Computer Science."],
    preferredQualifications: ["Experience with AWS."],
    technologies: ["TypeScript", "AWS"],
    educationRequirements: ["Currently pursuing a Bachelor's degree in Computer Science."],
    graduationRequirements: [],
    experienceRequirements: [],
    workAuthorizationRequirements: [],
    sponsorshipInformation: null,
    internshipTerm: "Summer",
    internshipYear: "2027",
    duration: "12 weeks",
    salary: null,
    postingDate: null,
    deadline: null,
    categories: ["swe", "backend"],
    relevanceScore: 92,
    relevanceReason: "92/100: software-focused title and programming responsibilities.",
    lifecycleStatus: "NEW",
    availabilityStatus: "open",
    discoveredAt: "2027-01-01T00:00:00.000Z",
    lastVerifiedAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  });
}

export function analyzed(internship: Internship): AnalyzedJob {
  return { internship, contentHash: internshipContentHash(internship) };
}
