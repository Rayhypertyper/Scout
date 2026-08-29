import { describe, expect, it } from "vitest";

import { evaluateInternshipEligibility } from "../src/eligibility/index.js";
import type { InternshipPreferences } from "../src/preferences/schema.js";
import { extractQualificationDetails } from "../src/parsing/qualifications.js";
import { evaluateInternshipMatch } from "../src/preferences/matching.js";
import { makeInternship } from "./helpers.js";

function preferences(overrides: Partial<InternshipPreferences> = {}): InternshipPreferences {
  return {
    terms: [{ term: "summer", year: 2027 }],
    countries: ["canada"],
    cities: [{ name: "Toronto", country: "canada" }],
    remote: false,
    roleCategories: ["swe"],
    technologies: [],
    degree: "bachelors",
    graduationYear: 2028,
    graduationYearOrLater: false,
    currentYearOfStudy: "second-year",
    currentEnrollmentStatus: "enrolled",
    returningToSchool: "yes",
    graduationMonth: null,
    workAuthorization: { canada: "authorized", unitedStates: null },
    sponsorship: { canada: "none", unitedStates: null },
    onboardingCompleted: true,
    currentStep: 3,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function fullySpecifiedRole() {
  const base = makeInternship();
  return makeInternship({
    qualificationDetails: {
      ...base.qualificationDetails,
      graduationYears: [2028],
      graduationYearRange: { min: 2028, max: 2028 },
      workAuthorization: "not_required",
      sponsorship: "available",
      firstYearEligible: "no",
      upperYearRequired: "yes",
      yearOfStudy: ["second-year"],
      studentStatusRequirement: "required",
      enrollmentRequirement: "required",
      returningToSchoolRequirement: "required",
    },
  });
}

describe("versioned deterministic eligibility", () => {
  it("returns eligible only when every hard criterion is resolved and passes", () => {
    const evaluation = evaluateInternshipEligibility(preferences(), fullySpecifiedRole());

    expect(evaluation.version).toBe("eligibility-v1");
    expect(evaluation.status).toBe("eligible");
    expect(evaluation.criterionResults.map(({ key }) => key)).toEqual([
      "term",
      "country_location",
      "work_authorization",
      "sponsorship",
      "degree",
      "graduation",
      "year_of_study",
      "current_enrollment",
      "returning_to_school",
    ]);
    expect(evaluation.criteria.degree).toMatchObject({ key: "degree", state: "pass", hard: true });
  });

  it("recognizes punctuation-safe bachelor and master degree abbreviations", () => {
    const base = makeInternship();
    for (const token of ["B.S. required", "BSc required"]) {
      const role = makeInternship({
        qualificationDetails: { ...base.qualificationDetails, degreeRequirements: [token] },
      });
      const evaluation = evaluateInternshipEligibility(preferences({ degree: "bachelors" }), role);
      expect(evaluation.criteria.degree.state).toBe("pass");
      expect(evaluation.status).not.toBe("not_eligible");
      expect(evaluateInternshipMatch(preferences({ degree: "bachelors" }), role).eligible).toBe(true);
    }
    for (const token of ["M.S. required", "MSc required"]) {
      const role = makeInternship({
        qualificationDetails: { ...base.qualificationDetails, degreeRequirements: [token] },
      });
      const evaluation = evaluateInternshipEligibility(preferences({ degree: "masters" }), role);
      expect(evaluation.criteria.degree.state).toBe("pass");
      expect(evaluation.status).not.toBe("not_eligible");
      expect(evaluateInternshipMatch(preferences({ degree: "bachelors" }), role).eligibility.criteria.degree.state).toBe("fail");
    }
  });

  it("distinguishes missing posting facts from uncertain profile answers", () => {
    const likely = evaluateInternshipEligibility(preferences(), makeInternship());
    expect(likely.status).toBe("likely_eligible");
    expect(likely.criteria.graduation.state).toBe("unknown");
    expect(likely.criteria.graduation.unknownSource).toBe("posting");

    const uncertainProfile = evaluateInternshipEligibility(preferences({
      workAuthorization: { canada: "unsure", unitedStates: null },
      sponsorship: { canada: "unsure", unitedStates: null },
    }), makeInternship());
    expect(uncertainProfile.status).toBe("unclear");
    expect(uncertainProfile.criteria.work_authorization.unknownSource).toBe("both");

    const unclear = evaluateInternshipEligibility(preferences({ currentEnrollmentStatus: "unsure" }), fullySpecifiedRole());
    expect(unclear.status).toBe("unclear");
    expect(unclear.criteria.current_enrollment).toMatchObject({ state: "unknown", unknownSource: "profile" });
  });

  it("reports explicit contradictions as not eligible", () => {
    const role = fullySpecifiedRole();
    const evaluation = evaluateInternshipEligibility(
      preferences({ graduationYear: 2029 }),
      role,
    );

    expect(evaluation.status).toBe("not_eligible");
    expect(evaluation.criteria.graduation.state).toBe("fail");
  });

  it("keeps contradictory normalized evidence in the unclear state", () => {
    const role = makeInternship({
      qualificationDetails: {
        ...makeInternship().qualificationDetails,
        conflicts: [{ key: "returning_to_school", evidence: ["Must return to school.", "Returning to school is not required."] }],
        returningToSchoolRequirement: "conflict",
      },
    });
    const evaluation = evaluateInternshipEligibility(preferences(), role);

    expect(evaluation.status).toBe("unclear");
    expect(evaluation.criteria.returning_to_school.state).toBe("conflict");
  });

  it("requires an exact selected term pair instead of mixing season and year answers", () => {
    const role = fullySpecifiedRole();
    role.internshipTerm = "Summer";
    role.internshipYear = "2028";
    const evaluation = evaluateInternshipEligibility(preferences({
      terms: [{ term: "summer", year: 2027 }, { term: "fall", year: 2028 }],
    }), role);

    expect(evaluation.status).toBe("not_eligible");
    expect(evaluation.criteria.term.state).toBe("fail");
  });

  it("does not treat sparse graduation years as an inclusive range", () => {
    const role = fullySpecifiedRole();
    role.qualificationDetails = {
      ...role.qualificationDetails,
      graduationYears: [2027, 2029],
      graduationYearRange: null,
    };
    const evaluation = evaluateInternshipEligibility(preferences({ graduationYear: 2028 }), role);

    expect(evaluation.status).toBe("not_eligible");
    expect(evaluation.criteria.graduation.state).toBe("fail");
  });

  it("surfaces conflicting term evidence instead of selecting one source", () => {
    const role = fullySpecifiedRole();
    role.title = "Fall 2027 Software Engineering Intern";
    role.internshipTerm = "Summer";
    const evaluation = evaluateInternshipEligibility(preferences(), role);

    expect(evaluation.status).toBe("unclear");
    expect(evaluation.criteria.term.state).toBe("conflict");
  });

  it("evaluates explicit study-year, enrollment, and return-to-school failures", () => {
    const base = fullySpecifiedRole();
    const role = makeInternship({
      qualificationDetails: {
        ...base.qualificationDetails,
        upperYearRequired: "unknown",
        firstYearEligible: "unknown",
        yearOfStudy: ["second-year"],
        studentStatusRequirement: "required",
        enrollmentRequirement: "required",
        returningToSchoolRequirement: "required",
      },
    });
    const evaluation = evaluateInternshipEligibility(preferences({
      currentYearOfStudy: "third-year",
      currentEnrollmentStatus: "not_enrolled",
      returningToSchool: "no",
    }), role);

    expect(evaluation.status).toBe("not_eligible");
    expect(evaluation.criteria.year_of_study.state).toBe("fail");
    expect(evaluation.criteria.current_enrollment.state).toBe("fail");
    expect(evaluation.criteria.returning_to_school.state).toBe("fail");
  });

  it("uses the versioned status as the sole hard match authority", () => {
    const role = fullySpecifiedRole();
    const match = evaluateInternshipMatch(preferences({ returningToSchool: "no" }), role);

    expect(match.eligibility.status).toBe("not_eligible");
    expect(match.eligible).toBe(match.eligibility.status !== "not_eligible");
    expect(match.score).toBe(0);
    expect(match.incompatibilities.join(" ")).toMatch(/returning to school/i);

    const unclear = evaluateInternshipMatch(preferences(), makeInternship());
    expect(unclear.eligible).toBe(unclear.eligibility.status !== "not_eligible");
    expect(unclear.eligibility.status).not.toBe("not_eligible");
    expect(unclear.unknown.length).toBe(
      unclear.eligibility.criterionResults.filter(({ state }) => state === "unknown" || state === "conflict").length,
    );
  });

  it("does not turn a valid remote-only profile into a location failure", () => {
    const role = makeInternship({
      normalizedLocations: [{
        raw: "Remote - Canada",
        country: null,
        provinceState: null,
        city: null,
        remote: true,
        remoteScope: "canada",
      }],
      location: ["Remote - Canada"],
      remoteStatus: "remote",
    });
    const evaluation = evaluateInternshipEligibility(preferences({
      countries: [],
      cities: [],
      remote: true,
      workAuthorization: { canada: null, unitedStates: null },
      sponsorship: { canada: null, unitedStates: null },
    }), role);

    expect(evaluation.criteria.country_location.state).toBe("pass");
    expect(evaluation.status).not.toBe("not_eligible");
  });
});

describe("qualification requirement normalization", () => {
  it("extracts enrollment, student, and returning-to-school requirements", () => {
    const details = extractQualificationDetails(
      "Must be currently enrolled in a degree program. Must return to school after the internship.",
    );

    expect(details.studentStatusRequirement).toBe("required");
    expect(details.enrollmentRequirement).toBe("required");
    expect(details.returningToSchoolRequirement).toBe("required");
  });

  it("does not turn negative or preferred wording into a hard requirement", () => {
    const details = extractQualificationDetails(
      "Currently enrolled students preferred. You do not need to return to school after the internship.",
    );

    expect(details.studentStatusRequirement).toBe("preferred");
    expect(details.enrollmentRequirement).toBe("preferred");
    expect(details.returningToSchoolRequirement).toBe("not_required");
  });
});
