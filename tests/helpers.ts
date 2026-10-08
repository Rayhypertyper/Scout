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

export function makeCmpaInternship(overrides: Partial<Internship> = {}): Internship {
  const jobId = overrides.jobId ?? "25c4865e-7ceb-47dd-9997-de9b5b5f179d";
  return makeInternship({
    id: "cmpa-careers",
    jobId,
    company: "**Carrières CMPA/ACPM**",
    title: "Co-Op Student - Data Engineer, AI Readiness (Medical-Legal Data)",
    location: ["Remote (Ottawa, Ontario)"],
    normalizedLocations: [{ raw: "Remote (Ottawa, Ontario)", country: "Canada", provinceState: "Ontario", city: "Ottawa", remote: true, remoteScope: "canada" }],
    remoteStatus: "remote",
    applicationUrl: `https://www.dreamworkhq.com/job/${jobId}`,
    postingUrl: `https://www.dreamworkhq.com/job/${jobId}`,
    sourceUrl: "https://github.com/dreamworkhq/Tech-Internships-2027",
    sources: ["https://github.com/dreamworkhq/Tech-Internships-2027"],
    ...overrides,
  });
}
