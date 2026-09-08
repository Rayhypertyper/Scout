import { analyzeRawJob } from "../../src/classification/analyzeJob.js";
import { InternshipSchema, type Internship, type QualificationDetails } from "../../src/domain/schemas.js";
import type { RawJob } from "../../src/domain/types.js";
import { sha256 } from "../../src/utils/hash.js";
import type { InternshipPreferences } from "../../src/preferences/schema.js";

/**
 * Every role is analyzed with this same timestamp.  The matcher itself is
 * synchronous and does not currently inspect the clock, but a fixed timestamp
 * keeps the normalized role inputs and any freshness metadata reproducible.
 */
export const MATCHING_AS_OF = "2026-08-31T12:00:00.000Z" as const;
export const MATCHING_SOURCE_URL = "https://fixtures.internshipmatic.test/careers" as const;

export type MatchingExpectation =
  | "strong_fit"
  | "eligible_unknown_posting"
  | "eligible_low_relevance"
  | "unclear"
  | "hard_excluded";

export interface CandidateProfile {
  id: string;
  label: string;
  /** Human-readable facts used by the baseline table. */
  summary: string;
  preferences: InternshipPreferences;
}

export interface MatchingRoleDefinition {
  id: string;
  label: string;
  /** Raw evidence is kept beside normalized role output for extraction audits. */
  raw: RawJob;
  postingEvidence: string;
  patch?: MatchingRolePatch;
}

export interface MatchingRolePatch {
  lifecycleStatus?: Internship["lifecycleStatus"];
  qualificationDetails?: Partial<QualificationDetails>;
}

export interface MatchingRole {
  id: string;
  label: string;
  postingEvidence: string;
  internship: Internship;
}

export interface MatchingFixtureCase {
  id: string;
  profileId: string;
  roleId: string;
  expected: MatchingExpectation;
  expectedNote: string;
}

export interface MatchingFixtureSuite {
  asOf: typeof MATCHING_AS_OF;
  profiles: readonly CandidateProfile[];
  roles: readonly MatchingRole[];
  cases: readonly MatchingFixtureCase[];
}

const BASE_PREFERENCES: Omit<InternshipPreferences, "onboardingCompleted" | "currentStep" | "createdAt" | "updatedAt" | "completedAt"> = {
  terms: [{ term: "summer", year: 2027 }],
  countries: ["canada"],
  cities: [{ name: "Toronto", country: "canada" }],
  remote: false,
  roleCategories: ["swe", "backend"],
  technologies: ["Python", "SQL", "Docker"],
  degree: "bachelors",
  graduationYear: 2028,
  graduationYearOrLater: false,
  currentYearOfStudy: "second-year",
  currentEnrollmentStatus: "enrolled",
  returningToSchool: "yes",
  graduationMonth: null,
  workAuthorization: { canada: "authorized", unitedStates: null },
  sponsorship: { canada: "none", unitedStates: null },
};

function profile(
  id: string,
  label: string,
  summary: string,
  overrides: Partial<InternshipPreferences> = {},
): CandidateProfile {
  return {
    id,
    label,
    summary,
    preferences: {
      ...BASE_PREFERENCES,
      onboardingCompleted: true,
      currentStep: 3,
      createdAt: MATCHING_AS_OF,
      updatedAt: MATCHING_AS_OF,
      completedAt: MATCHING_AS_OF,
      ...overrides,
    },
  };
}

/** Profiles intentionally contrast legal fit, soft preferences, and missing answers. */
export const MATCHING_PROFILES: readonly CandidateProfile[] = [
  profile(
    "canadian-backend",
    "Canadian authorized undergraduate",
    "Canada authorized; second-year bachelor's student graduating 2028; prefers Toronto backend/SWE and Python/SQL/Docker for Summer 2027.",
  ),
  profile(
    "sponsor-needed",
    "U.S. sponsor-needed candidate",
    "New York option; second-year bachelor's student graduating 2028; needs work authorization assistance and sponsorship now; prefers backend/ML and Python/Java.",
    {
      countries: ["united_states"],
      cities: [{ name: "New York", country: "united_states" }],
      roleCategories: ["swe", "backend", "ml"],
      technologies: ["Python", "Java", "SQL"],
      workAuthorization: { canada: null, unitedStates: "needs_assistance" },
      sponsorship: { canada: null, unitedStates: "now" },
    },
  ),
  profile(
    "frontend-data-hardware",
    "Frontend/data/hardware generalist",
    "Authorized in Canada and assistance needed in the U.S.; third-year bachelor's student graduating 2027; accepts Toronto/New York or remote; prefers frontend, data, embedded, TypeScript/React/Python/C++/SQL.",
    {
      terms: [{ term: "summer", year: 2027 }, { term: "fall", year: 2027 }],
      countries: ["canada", "united_states"],
      cities: [
        { name: "Toronto", country: "canada" },
        { name: "New York", country: "united_states" },
      ],
      remote: true,
      roleCategories: ["frontend", "data", "embedded"],
      technologies: ["TypeScript", "React", "Python", "C++", "SQL"],
      graduationYear: 2027,
      currentYearOfStudy: "third-year",
      workAuthorization: { canada: "authorized", unitedStates: "needs_assistance" },
      sponsorship: { canada: "none", unitedStates: "now" },
    },
  ),
  profile(
    "graduate-student",
    "Canadian graduate student",
    "Waterloo graduate student; master's degree, graduating 2027; enrolled and returning to school; prefers data/ML/research and Python/PyTorch/SQL.",
    {
      terms: [{ term: "summer", year: 2027 }, { term: "fall", year: 2027 }],
      cities: [{ name: "Waterloo", country: "canada" }],
      roleCategories: ["data", "ml", "research"],
      technologies: ["Python", "PyTorch", "SQL"],
      degree: "masters",
      graduationYear: 2027,
      currentYearOfStudy: "graduate",
    },
  ),
  {
    id: "missing-preferences",
    label: "Incomplete profile",
    summary: "No selected term, location, category, technology, degree, graduation year, authorization, or sponsorship answers; onboarding is incomplete.",
    preferences: {
      terms: [],
      countries: [],
      cities: [],
      remote: false,
      roleCategories: [],
      technologies: [],
      degree: null,
      graduationYear: null,
      graduationYearOrLater: false,
      currentYearOfStudy: "unsure",
      currentEnrollmentStatus: "unsure",
      returningToSchool: "unsure",
      graduationMonth: null,
      workAuthorization: { canada: null, unitedStates: null },
      sponsorship: { canada: null, unitedStates: null },
      onboardingCompleted: false,
      currentStep: 1,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
    },
  },
];

interface RawRoleInput {
  id: string;
  title: string;
  locations: string[];
  company?: string;
  description: string;
  requiredQualifications?: string[];
  preferredQualifications?: string[];
  responsibilities?: string[];
  postingDate?: string;
}

function rawRole(input: RawRoleInput): RawJob {
  const company = input.company ?? "Fixture Labs";
  const responsibilities = input.responsibilities ?? [
    "Collaborate with the team on documented internship work and communicate progress.",
  ];
  const requiredQualifications = input.requiredQualifications ?? [];
  const preferredQualifications = input.preferredQualifications ?? [];
  const raw: RawJob = {
    company,
    title: input.title,
    locations: input.locations,
    description: `${input.description} Responsibilities: ${responsibilities.join(" ")}`,
    responsibilities,
    requiredQualifications,
    preferredQualifications,
    postingUrl: `https://fixtures.internshipmatic.test/jobs/${input.id}`,
    applicationUrl: `https://fixtures.internshipmatic.test/jobs/${input.id}/apply`,
    jobId: `FIX-${input.id}`,
    sourceProvider: "matching-fixture",
  };
  if (input.postingDate !== undefined) raw.postingDate = input.postingDate;
  return raw;
}

function role(
  id: string,
  label: string,
  title: string,
  locations: string[],
  description: string,
  postingEvidence: string,
  options: Omit<RawRoleInput, "id" | "title" | "locations" | "description"> = {},
  patch?: MatchingRolePatch,
): MatchingRoleDefinition {
  return {
    id,
    label,
    raw: rawRole({ id, title, locations, description, ...options }),
    postingEvidence,
    ...(patch === undefined ? {} : { patch }),
  };
}

/**
 * Raw postings deliberately include both ordinary and adversarial language.
 * They are passed through `analyzeRawJob`; no normalized role is hand-written
 * here.  This keeps the extraction and classifier behavior visible in the
 * baseline while allowing snapshot replay after those parsers change.
 */
export const MATCHING_ROLE_DEFINITIONS: readonly MatchingRoleDefinition[] = [
  role(
    "backend-canada-exact",
    "Exact Canadian backend role",
    "Summer 2027 Backend Software Engineering Intern",
    ["Toronto, ON, Canada"],
    "Build Python services and REST APIs for a Canadian payments platform. The twelve-week internship gives students production code review and testing experience.",
    "Toronto, Canada; Summer 2027; bachelor's required; graduation 2028; second-year or later; enrollment and return-to-school required; Canadian work authorization required; sponsorship unavailable.",
    {
      company: "Northstar Payments",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Applicants must be second-year or later.",
        "Must be currently enrolled in a degree program.",
        "Must return to school after the internship.",
        "Candidates must be legally authorized to work in Canada.",
        "This role will not provide sponsorship.",
      ],
      preferredQualifications: ["Experience with Python, SQL, Docker, or REST APIs is preferred."],
      responsibilities: [
        "Develop Python services and REST APIs.",
        "Debug production code and write automated tests.",
      ],
      postingDate: "2026-08-29",
    },
  ),
  role(
    "backend-canada-stale",
    "Same Canadian backend role, unchanged",
    "Summer 2027 Backend Software Engineering Intern",
    ["Toronto, ON, Canada"],
    "Build Python services and REST APIs for a Canadian payments platform. The twelve-week internship gives students production code review and testing experience.",
    "Same normalized eligibility evidence as backend-canada-exact; lifecycle is UNCHANGED and posting date is older.",
    {
      company: "Northstar Payments",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Applicants must be second-year or later.",
        "Must be currently enrolled in a degree program.",
        "Must return to school after the internship.",
        "Candidates must be legally authorized to work in Canada.",
        "This role will not provide sponsorship.",
      ],
      preferredQualifications: ["Experience with Python, SQL, Docker, or REST APIs is preferred."],
      responsibilities: [
        "Develop Python services and REST APIs.",
        "Debug production code and write automated tests.",
      ],
      postingDate: "2026-07-15",
    },
    { lifecycleStatus: "UNCHANGED" },
  ),
  role(
    "frontend-toronto-preferred",
    "Toronto frontend role with preferred master's",
    "Summer 2027 Frontend React Intern",
    ["Toronto, ON, Canada"],
    "Implement accessible user interfaces with React and TypeScript for a web product. Work with designers and engineers to test browser behavior during the internship.",
    "Toronto, Canada; Summer 2027; bachelor's required; master's is preferred; no explicit authorization or sponsorship statement.",
    {
      company: "Northstar Web",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science or Software Engineering.",
        "Expected graduation between 2027 and 2028.",
        "Must be currently enrolled in a degree program.",
      ],
      preferredQualifications: ["A Master's degree is preferred. Experience with React is a plus."],
      responsibilities: [
        "Develop React and TypeScript components.",
        "Write browser tests and improve accessible interfaces.",
      ],
    },
  ),
  role(
    "data-vancouver",
    "Vancouver data role",
    "Summer 2027 Data Engineering Intern",
    ["Vancouver, BC, Canada"],
    "Build Python and SQL data pipelines and validate datasets for an analytics platform. The student placement includes code reviews and operational documentation.",
    "Vancouver, Canada; Summer 2027; bachelor's required; graduation 2027-2028; no authorization or sponsorship statement; city is outside the Canadian profile's preferred Toronto city.",
    {
      company: "Pacific Analytics",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Engineering.",
        "Expected graduation between 2027 and 2028.",
      ],
      responsibilities: [
        "Develop Python and SQL data pipelines.",
        "Test data quality checks and document results.",
      ],
      postingDate: "2026-08-27",
    },
  ),
  role(
    "embedded-waterloo",
    "Waterloo embedded role",
    "Summer 2027 Embedded Firmware Intern",
    ["Waterloo, ON, Canada"],
    "Write C++ firmware for sensor devices and debug hardware interfaces in a lab environment. This placement pairs embedded software work with test automation.",
    "Waterloo, Canada; Summer 2027; B.S. required; graduation 2027-2028; no authorization or sponsorship statement; embedded hardware category.",
    {
      company: "Maple Devices",
      requiredQualifications: [
        "Currently pursuing a B.S. in Computer Engineering.",
        "Expected graduation between 2027 and 2028.",
      ],
      responsibilities: [
        "Develop C++ firmware for microcontrollers.",
        "Debug hardware interfaces and write automated tests.",
      ],
    },
  ),
  role(
    "ml-new-york-sponsor",
    "New York ML role with sponsorship",
    "Summer 2027 Machine Learning Intern",
    ["New York, NY, United States"],
    "Train Python models and evaluate data quality for a machine learning research team. The summer internship includes experiments, code review, written analysis, and employer sponsorship is available.",
    "New York, United States; Summer 2027; bachelor's required; graduation 2028; sponsorship available; authorization requirement not stated.",
    {
      company: "Hudson Models",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Employer sponsorship is available.",
      ],
      preferredQualifications: ["PyTorch experience is preferred."],
      responsibilities: [
        "Develop Python machine learning models.",
        "Test experiments and analyze model results.",
      ],
    },
  ),
  role(
    "ml-new-york-denial",
    "New York ML role denying sponsorship",
    "Summer 2027 Machine Learning Engineer Intern",
    ["New York, NY, United States"],
    "Develop Python machine learning features and evaluate experiments for a production platform. This is a student internship with a structured engineering mentor program.",
    "New York, United States; Summer 2027; bachelor's required; graduation 2028; U.S. authorization required; sponsorship explicitly unavailable.",
    {
      company: "Hudson Secure Models",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Candidates must be legally authorized to work in the United States.",
        "This position does not offer sponsorship.",
      ],
      responsibilities: [
        "Develop Python machine learning features.",
        "Debug experiments and test model behavior.",
      ],
    },
  ),
  role(
    "multi-location-ca-us",
    "Multi-location Canada/U.S. role",
    "Summer 2027 Full Stack Software Intern",
    ["Toronto, ON, Canada", "New York, NY, United States"],
    "Build TypeScript services and user interfaces with a distributed engineering team. The internship can be based in either listed office and includes API testing.",
    "Toronto and New York; Summer 2027; bachelor's required; graduation 2028; authorization required; sponsorship unavailable; two legal country lanes.",
    {
      company: "Continental Systems",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Software Engineering.",
        "Expected graduation in 2028.",
        "Candidates must be legally authorized to work in Canada or the United States.",
        "This position does not offer sponsorship.",
      ],
      responsibilities: [
        "Develop TypeScript APIs and interfaces.",
        "Test full stack features and debug integration failures.",
      ],
    },
  ),
  role(
    "remote-canada",
    "Remote Canada role",
    "Summer 2027 Backend Software Engineering Intern (Remote)",
    ["Remote - Canada"],
    "Develop Python APIs with a fully distributed Canadian team. The remote internship includes pair programming, automated tests, and weekly engineering reviews.",
    "Remote Canada; Summer 2027; bachelor's required; graduation 2028; sponsorship available; remote jurisdiction is explicit.",
    {
      company: "Remote Maple",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Must be currently enrolled in a degree program.",
        "Employer sponsorship is available.",
      ],
      responsibilities: [
        "Develop Python APIs remotely.",
        "Write automated tests and debug service failures.",
      ],
    },
  ),
  role(
    "remote-usa",
    "Remote U.S. role",
    "Summer 2027 Data Engineering Intern (Remote)",
    ["Remote - United States"],
    "Build SQL and Python pipelines for a distributed U.S. data team. This student internship includes data tests and operational debugging.",
    "Remote United States; Summer 2027; bachelor's required; graduation 2028; U.S. authorization required; sponsorship unavailable.",
    {
      company: "Remote Hudson",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Candidates must be legally authorized to work in the United States.",
        "This position does not offer sponsorship.",
      ],
      responsibilities: [
        "Develop SQL and Python data pipelines.",
        "Test data quality and debug scheduled jobs.",
      ],
    },
  ),
  role(
    "remote-worldwide",
    "Worldwide remote role with unknown jurisdiction",
    "Summer 2027 Backend Software Engineering Intern (Worldwide Remote)",
    ["Remote"],
    "Develop Python services for a globally distributed team. The internship includes code review, API testing, and technical documentation.",
    "Worldwide remote; Summer 2027; strong software evidence; degree, graduation, authorization, sponsorship, and legal country scope are omitted.",
    {
      company: "Global Tools",
      responsibilities: [
        "Develop Python services and APIs.",
        "Write automated tests and debug production issues.",
      ],
    },
  ),
  role(
    "strong-metadata-sparse",
    "Strong role with nonessential eligibility fields missing",
    "Summer 2027 Software Engineering Intern",
    ["Toronto, ON, Canada"],
    "Design, implement, and debug TypeScript services for a high-scale platform. The student internship has clear engineering responsibilities and tests.",
    "Toronto, Canada; Summer 2027; strong title/responsibilities/technology evidence; nonessential eligibility metadata is absent.",
    {
      company: "Sparse Platform",
      responsibilities: [
        "Design and implement TypeScript services.",
        "Debug APIs and write integration tests.",
      ],
    },
  ),
  role(
    "unknown-term",
    "Role with unknown term",
    "Backend Software Engineering Intern",
    ["Toronto, ON, Canada"],
    "Build Python APIs and debug services for a student engineering placement while retaining a clear backend description.",
    "Toronto, Canada; no season/year; bachelor's requirement present; graduation, authorization, sponsorship, enrollment, and return-to-school facts are omitted.",
    {
      company: "No Term Systems",
      requiredQualifications: ["Currently pursuing a Bachelor's degree in Computer Science."],
      responsibilities: [
        "Develop Python APIs.",
        "Debug services and write automated tests.",
      ],
    },
  ),
  role(
    "unknown-location",
    "Role with unknown location",
    "Summer 2027 Software Engineering Intern",
    [],
    "Build TypeScript APIs for a student engineering team. The posting states a summer term and software responsibilities.",
    "Summer 2027; location metadata is absent; bachelor's and graduation 2028 are stated; authorization and sponsorship are omitted.",
    {
      company: "Unlocated Systems",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
      ],
      responsibilities: [
        "Develop TypeScript APIs.",
        "Debug services and write unit tests.",
      ],
    },
  ),
  role(
    "strict-masters",
    "Strict master's degree role",
    "Summer 2027 Data Science Intern",
    ["Toronto, ON, Canada"],
    "Train statistical models and validate datasets for a research engineering team. This student internship requires graduate-level preparation.",
    "Toronto, Canada; Summer 2027; master's degree required; graduation 2027-2028; other eligibility facts omitted.",
    {
      company: "Northstar Research",
      requiredQualifications: [
        "Master's degree required in Data Science or a related field.",
        "Expected graduation between 2027 and 2028.",
      ],
      responsibilities: [
        "Develop Python statistical models.",
        "Analyze datasets and test model quality.",
      ],
    },
  ),
  role(
    "strict-phd",
    "Strict PhD degree role",
    "Summer 2027 Research Engineering Intern",
    ["Toronto, ON, Canada"],
    "Develop research software and evaluate experiments for a student research engineering team. This placement requires doctoral preparation.",
    "Toronto, Canada; Summer 2027; Ph.D. degree required; other eligibility facts omitted.",
    {
      company: "Northstar Doctoral Research",
      requiredQualifications: [
        "Ph.D. degree required in Computer Science or a related field.",
      ],
      responsibilities: [
        "Develop research software in Python.",
        "Analyze experiments and test research prototypes.",
      ],
    },
  ),
  role(
    "preferred-phd-only",
    "Preferred PhD degree only",
    "Summer 2027 Research Software Intern",
    ["Toronto, ON, Canada"],
    "Develop research software and evaluate experiments for a student engineering team.",
    "Toronto, Canada; Summer 2027; Ph.D. preferred only; no structured hard degree-level requirement; other eligibility facts omitted.",
    {
      company: "Northstar Research Preference",
      requiredQualifications: ["Currently pursuing a degree in Computer Science."],
      preferredQualifications: ["Ph.D. study is preferred."],
      responsibilities: [
        "Develop research software in Python.",
        "Analyze experiments and test research prototypes.",
      ],
    },
  ),
  role(
    "preferred-degree-only",
    "Preferred master's degree only",
    "Summer 2027 Frontend Engineering Intern",
    ["Toronto, ON, Canada"],
    "Implement TypeScript and React interfaces for a student product team.",
    "Toronto, Canada; Summer 2027; master's preferred only; no structured hard degree-level requirement; other eligibility facts omitted.",
    {
      company: "Preference Web",
      requiredQualifications: ["Currently pursuing a degree in Computer Science."],
      preferredQualifications: ["A Master's degree is preferred."],
      responsibilities: [
        "Develop React and TypeScript interfaces.",
        "Test browser behavior and debug UI issues.",
      ],
    },
  ),
  role(
    "graduation-window",
    "Inclusive graduation window",
    "Summer 2027 Backend Software Intern",
    ["Toronto, ON, Canada"],
    "Develop Python services and test APIs in a structured student placement.",
    "Toronto, Canada; Summer 2027; bachelor's required; expected graduation 2027-2028; other eligibility facts omitted.",
    {
      company: "Windowed Services",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation between 2027 and 2028.",
      ],
      responsibilities: [
        "Develop Python services.",
        "Write API tests and debug failures.",
      ],
    },
  ),
  role(
    "graduation-outside",
    "Graduation window outside profile",
    "Summer 2027 Backend Software Intern",
    ["Toronto, ON, Canada"],
    "Develop Python services and test APIs in a structured student placement. The posting requires a later graduating class.",
    "Toronto, Canada; Summer 2027; bachelor's required; expected graduation 2029-2030, outside the Canadian undergraduate profile's 2028 year.",
    {
      company: "Later Class Services",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation between 2029 and 2030.",
      ],
      responsibilities: [
        "Develop Python services.",
        "Write API tests and debug failures.",
      ],
    },
  ),
  role(
    "contradictory-evidence",
    "Posting with contradictory eligibility evidence",
    "Summer 2027 Backend Software Intern",
    ["Toronto, ON, Canada"],
    "Develop Python services and test APIs for a student engineering team.",
    "Toronto, Canada; Summer 2027; contradictory structured evidence should remain unclear rather than being resolved by guessing.",
    {
      company: "Contradiction Labs",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Must be currently enrolled in a degree program.",
        "You do not need to be currently enrolled.",
        "Must return to school after the internship.",
        "You do not need to return to school after the internship.",
        "Candidates must be legally authorized to work in Canada.",
        "No work authorization is required.",
        "Employer sponsorship is available.",
        "Sponsorship is not available.",
      ],
      responsibilities: [
        "Develop Python services.",
        "Test APIs and debug integration failures.",
      ],
    },
  ),
  role(
    "tech-aliases",
    "Technology aliases and false-positive guard",
    "Summer 2027 Embedded Software Intern",
    ["Toronto, ON, Canada"],
    "Build device tooling with C++ (also called cpp), C#, JavaScript (JS), React.js, Node.js, and Go (Golang). It is a student software placement with automated tests.",
    "Toronto, Canada; Summer 2027; technology aliases C++/cpp, C#, JavaScript/JS, React.js, Node.js, Go/Golang; JavaScript must not become standalone Java.",
    {
      company: "Alias Hardware",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Engineering.",
        "Expected graduation in 2028.",
      ],
      responsibilities: [
        "Develop C++ and C# device tooling.",
        "Test JavaScript, React.js, Node.js, and Go integrations.",
      ],
    },
  ),
  role(
    "classifier-low-confidence",
    "Low-confidence classifier role",
    "Summer 2027 Technology Operations Student Intern",
    ["Toronto, ON, Canada"],
    "Support a student operations team by documenting workflows, coordinating meetings, and monitoring dashboards.",
    "Toronto, Canada; Summer 2027; generic technology/student title; no programming responsibilities; low classifier confidence signal.",
    {
      company: "Operations Desk",
      requiredQualifications: ["Currently enrolled in a university program."],
      responsibilities: [
        "Document operational workflows.",
        "Monitor dashboards and coordinate team meetings.",
      ],
    },
  ),
  role(
    "unrelated-marketing",
    "Known-term unrelated role",
    "Summer 2027 Marketing Intern",
    ["Toronto, ON, Canada"],
    "Plan social media campaigns, prepare customer interview notes, and coordinate marketing events for a student summer program.",
    "Toronto, Canada; Summer 2027; known location and term but marketing category, no preferred technologies, and no structured eligibility facts.",
    {
      company: "Campaign House",
      requiredQualifications: ["Currently enrolled university student."],
      responsibilities: [
        "Plan social media campaigns.",
        "Coordinate marketing events and customer interviews.",
      ],
    },
  ),
  role(
    "explicit-auth-us",
    "Explicit U.S. authorization role",
    "Summer 2027 Backend Software Engineering Intern",
    ["New York, NY, United States"],
    "Build Java services and REST APIs for a U.S. engineering team. This student internship requires existing legal authorization and has no stated sponsorship path.",
    "New York, United States; Summer 2027; U.S. work authorization explicitly required; sponsorship unavailable; useful contrast for sponsor-needed profile.",
    {
      company: "Hudson Backend",
      requiredQualifications: [
        "Currently pursuing a Bachelor's degree in Computer Science.",
        "Expected graduation in 2028.",
        "Candidates must be legally authorized to work in the United States.",
        "This position does not offer sponsorship.",
      ],
      responsibilities: [
        "Develop Java services and REST APIs.",
        "Debug backend code and write integration tests.",
      ],
    },
  ),
];

/** Cases cover both intended product behavior and current scoring pathologies. */
export const MATCHING_CASES: readonly MatchingFixtureCase[] = [
  { id: "ca-exact", profileId: "canadian-backend", roleId: "backend-canada-exact", expected: "strong_fit", expectedNote: "All selected hard facts pass; city, category, and technologies align." },
  { id: "ca-fresh-new", profileId: "canadian-backend", roleId: "backend-canada-exact", expected: "strong_fit", expectedNote: "Freshness is NEW in the current pipeline output." },
  { id: "ca-fresh-unchanged", profileId: "canadian-backend", roleId: "backend-canada-stale", expected: "strong_fit", expectedNote: "Same role facts with unchanged lifecycle; freshness should remain a small ranking signal." },
  { id: "ca-frontend-preferred-degree", profileId: "canadian-backend", roleId: "frontend-toronto-preferred", expected: "eligible_unknown_posting", expectedNote: "Master's preference must not fail a bachelor's profile; missing authorization/sponsorship remains unknown." },
  { id: "ca-vancouver", profileId: "canadian-backend", roleId: "data-vancouver", expected: "eligible_unknown_posting", expectedNote: "Known Canada location passes hard country eligibility, while Vancouver/data is a soft mismatch for Toronto/backend." },
  { id: "ca-embedded", profileId: "canadian-backend", roleId: "embedded-waterloo", expected: "eligible_unknown_posting", expectedNote: "Waterloo/embedded/C++ is a nonpreferred soft fit; B.S. is a compatible bachelor's requirement." },
  { id: "ca-multi-location", profileId: "canadian-backend", roleId: "multi-location-ca-us", expected: "eligible_unknown_posting", expectedNote: "A selected Canadian lane passes even though the role also lists a U.S. lane." },
  { id: "ca-remote-canada", profileId: "canadian-backend", roleId: "remote-canada", expected: "eligible_unknown_posting", expectedNote: "Explicit Canadian remote jurisdiction passes country and sponsorship availability." },
  { id: "ca-remote-worldwide", profileId: "canadian-backend", roleId: "remote-worldwide", expected: "eligible_unknown_posting", expectedNote: "Worldwide remote legal scope remains unknown; strong role evidence should not create a hard exclusion." },
  { id: "ca-sparse", profileId: "canadian-backend", roleId: "strong-metadata-sparse", expected: "eligible_unknown_posting", expectedNote: "Strong role with nonessential eligibility metadata omitted remains visible with unknown criteria." },
  { id: "ca-unknown-term", profileId: "canadian-backend", roleId: "unknown-term", expected: "eligible_unknown_posting", expectedNote: "Missing term is unknown, not an incompatible term." },
  { id: "ca-unknown-location", profileId: "canadian-backend", roleId: "unknown-location", expected: "eligible_unknown_posting", expectedNote: "Missing location is unknown, not an out-of-country exclusion." },
  { id: "ca-strict-masters", profileId: "canadian-backend", roleId: "strict-masters", expected: "hard_excluded", expectedNote: "A stated master's degree requirement conflicts with a bachelor's profile." },
  { id: "ca-preferred-degree-only", profileId: "canadian-backend", roleId: "preferred-degree-only", expected: "eligible_unknown_posting", expectedNote: "Preferred master's wording alone must not become a hard bachelor's mismatch." },
  { id: "ca-graduation-window", profileId: "canadian-backend", roleId: "graduation-window", expected: "eligible_unknown_posting", expectedNote: "Expected graduation 2028 falls inside the stated 2027-2028 window." },
  { id: "ca-graduation-outside", profileId: "canadian-backend", roleId: "graduation-outside", expected: "hard_excluded", expectedNote: "Expected graduation 2028 falls outside the stated 2029-2030 window." },
  { id: "ca-contradictory", profileId: "canadian-backend", roleId: "contradictory-evidence", expected: "unclear", expectedNote: "Contradictory normalized evidence is visible as conflict and must not be silently resolved." },
  { id: "ca-tech-aliases", profileId: "canadian-backend", roleId: "tech-aliases", expected: "eligible_unknown_posting", expectedNote: "Alias extraction is deterministic; JavaScript must not imply standalone Java." },
  { id: "ca-low-confidence", profileId: "canadian-backend", roleId: "classifier-low-confidence", expected: "eligible_unknown_posting", expectedNote: "Low classifier confidence is a ranking concern, not a hard eligibility failure." },
  { id: "ca-unrelated", profileId: "canadian-backend", roleId: "unrelated-marketing", expected: "eligible_low_relevance", expectedNote: "Known term/city but unrelated category exposes overmatching when eligibility metadata is unknown." },
  { id: "sponsor-available", profileId: "sponsor-needed", roleId: "ml-new-york-sponsor", expected: "eligible_unknown_posting", expectedNote: "Sponsorship available resolves the sponsor path; authorization itself is intentionally unstated." },
  { id: "sponsor-denied", profileId: "sponsor-needed", roleId: "ml-new-york-denial", expected: "hard_excluded", expectedNote: "Confirmed U.S. authorization denial and sponsorship denial are hard exclusions." },
  { id: "sponsor-explicit-auth", profileId: "sponsor-needed", roleId: "explicit-auth-us", expected: "hard_excluded", expectedNote: "Existing U.S. authorization is required while the profile says assistance is needed." },
  { id: "sponsor-multi-location", profileId: "sponsor-needed", roleId: "multi-location-ca-us", expected: "unclear", expectedNote: "The U.S. lane is selected but the Canadian lane is also present; unresolved regional values remain visible." },
  { id: "sponsor-remote-usa", profileId: "sponsor-needed", roleId: "remote-usa", expected: "hard_excluded", expectedNote: "Remote jurisdiction is U.S.; both authorization and sponsorship deny this profile's path." },
  { id: "generalist-frontend", profileId: "frontend-data-hardware", roleId: "frontend-toronto-preferred", expected: "eligible_unknown_posting", expectedNote: "Frontend and React align; graduation window includes 2027; missing legal facts remain unknown." },
  { id: "generalist-embedded", profileId: "frontend-data-hardware", roleId: "embedded-waterloo", expected: "eligible_unknown_posting", expectedNote: "Embedded category and C++ align; Waterloo is a Canadian country fit." },
  { id: "generalist-data", profileId: "frontend-data-hardware", roleId: "data-vancouver", expected: "eligible_unknown_posting", expectedNote: "Data/Python/SQL align; Vancouver is a nonpreferred city but selected Canada passes." },
  { id: "generalist-worldwide", profileId: "frontend-data-hardware", roleId: "remote-worldwide", expected: "eligible_unknown_posting", expectedNote: "Remote is a soft fit while worldwide legal scope remains unknown." },
  { id: "graduate-masters", profileId: "graduate-student", roleId: "strict-masters", expected: "eligible_unknown_posting", expectedNote: "Master's profile satisfies the strict degree requirement; omitted posting facts remain unknown." },
  { id: "graduate-bachelors-role", profileId: "graduate-student", roleId: "backend-canada-exact", expected: "hard_excluded", expectedNote: "A master's profile does not satisfy the role's strict bachelor's degree requirement." },
  { id: "graduate-preferred-degree", profileId: "graduate-student", roleId: "preferred-degree-only", expected: "eligible_unknown_posting", expectedNote: "Preferred master's wording yields no hard degree failure and should remain eligible/unknown." },
  { id: "ca-strict-phd", profileId: "canadian-backend", roleId: "strict-phd", expected: "hard_excluded", expectedNote: "A bachelor's profile conflicts with a strict Ph.D. requirement." },
  { id: "ca-preferred-phd", profileId: "canadian-backend", roleId: "preferred-phd-only", expected: "eligible_unknown_posting", expectedNote: "Preferred Ph.D. wording alone must not exclude a bachelor's profile." },
  { id: "graduate-strict-phd", profileId: "graduate-student", roleId: "strict-phd", expected: "hard_excluded", expectedNote: "A master's profile still does not satisfy a strict Ph.D. requirement." },
  { id: "graduate-preferred-phd", profileId: "graduate-student", roleId: "preferred-phd-only", expected: "eligible_unknown_posting", expectedNote: "A master's profile remains eligible when Ph.D. is only preferred." },
  { id: "missing-exact", profileId: "missing-preferences", roleId: "backend-canada-exact", expected: "unclear", expectedNote: "Incomplete profile answers are profile unknowns; the role is retained only as unclear, never treated as a confident match." },
  { id: "missing-sparse", profileId: "missing-preferences", roleId: "strong-metadata-sparse", expected: "unclear", expectedNote: "Both profile and posting eligibility facts are missing; strong classifier evidence does not resolve them." },
  { id: "missing-unrelated", profileId: "missing-preferences", roleId: "unrelated-marketing", expected: "unclear", expectedNote: "Incomplete profile and unrelated role should remain unclear rather than gaining a confident score." },
];

function normalizedRoleWithPatch(definition: MatchingRoleDefinition, internship: Internship): Internship {
  const patch = definition.patch;
  if (!patch) return InternshipSchema.parse({ ...internship, id: definition.id });
  const qualificationDetails = patch.qualificationDetails === undefined
    ? internship.qualificationDetails
    : { ...internship.qualificationDetails, ...patch.qualificationDetails };
  return InternshipSchema.parse({
    ...internship,
    ...patch,
    id: definition.id,
    qualificationDetails,
  });
}

/** Run every raw posting through the production classifier/extractor pipeline. */
export async function buildMatchingFixtureSuite(): Promise<MatchingFixtureSuite> {
  const roles = await Promise.all(MATCHING_ROLE_DEFINITIONS.map(async (definition): Promise<MatchingRole> => {
    const analyzed = await analyzeRawJob(
      definition.raw,
      MATCHING_SOURCE_URL,
      0,
      async (url) => url,
      MATCHING_AS_OF,
      {
        minimumRelevanceScore: 0,
        allowUnclassifiedInternships: true,
        applyTitleExclusions: false,
      },
    );
    if (!analyzed.accepted) {
      throw new Error(`Matching fixture ${definition.id} was rejected: ${analyzed.reason}`);
    }
    return {
      id: definition.id,
      label: definition.label,
      postingEvidence: definition.postingEvidence,
      internship: normalizedRoleWithPatch(definition, analyzed.value.internship),
    };
  }));
  return {
    asOf: MATCHING_AS_OF,
    profiles: MATCHING_PROFILES,
    roles,
    cases: MATCHING_CASES,
  };
}

/**
 * Digest normalized inputs, not matcher output.  Snapshot replay in the
 * baseline harness preserves these exact inputs when parsing/classification
 * work is being changed separately from matcher weights.
 */
export function matchingInputDigest(suite: Pick<MatchingFixtureSuite, "profiles" | "roles">): string {
  return sha256(JSON.stringify({
    profiles: suite.profiles.map(({ id, preferences }) => ({ id, preferences })),
    roles: suite.roles.map(({ id, internship }) => ({ id, internship })),
  }));
}
