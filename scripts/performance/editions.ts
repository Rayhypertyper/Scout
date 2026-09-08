import { performance } from "node:perf_hooks";

import { scoreListingRelevance, type ListingRelevanceInput } from "../../src/classification/listingRelevance.js";
import { DEFAULT_RELEVANCE_RULES } from "../../src/config/relevanceRules.js";
import { compileMatcher, evaluateInternshipMatch } from "../../src/preferences/matching.js";
import type { InternshipPreferences } from "../../src/preferences/schema.js";
import { makeInternship } from "../../tests/helpers.js";

interface TimingSample {
  milliseconds: number;
  checksum: number;
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(iterations: number, operation: (index: number) => number): TimingSample {
  let checksum = 0;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) checksum += operation(index);
  return { milliseconds: performance.now() - startedAt, checksum };
}

function preferences(): InternshipPreferences {
  return {
    terms: [{ term: "summer", year: 2027 }],
    countries: ["canada"],
    cities: [{ name: "Toronto", country: "canada" }],
    remote: false,
    roleCategories: ["swe"],
    technologies: ["TypeScript"],
    degree: "bachelors",
    graduationYear: 2028,
    graduationYearOrLater: false,
    workAuthorization: { canada: "authorized", unitedStates: null },
    sponsorship: { canada: "none", unitedStates: null },
    onboardingCompleted: true,
    currentStep: 3,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    completedAt: "2026-08-23T12:00:00.000Z",
  };
}

const LISTINGS: readonly ListingRelevanceInput[] = [
  { title: "Software Engineering Intern", department: "Platform", snippet: "Build TypeScript services and APIs" },
  { title: "Marketing Intern", department: "Growth", snippet: "Run social media campaigns" },
  { title: "Technology Intern", department: "Research", snippet: "Prototype automation systems" },
  { title: "Accounting Intern", department: "Finance", snippet: "Prepare audit reports" },
  { title: "Machine Learning Research Intern", department: "AI Lab", snippet: "Train Python models" },
  { title: "Product Intern", department: "Engineering", snippet: "Work with developers on cloud systems" },
];

function compareSamples(before: readonly number[], after: readonly number[]) {
  const beforeMedianMs = median(before);
  const afterMedianMs = median(after);
  const savingsMs = beforeMedianMs - afterMedianMs;
  return {
    beforeMedianMs,
    afterMedianMs,
    savingsMs,
    savingsPercent: beforeMedianMs === 0 ? null : (savingsMs / beforeMedianMs) * 100,
    beforeSamplesMs: before,
    afterSamplesMs: after,
  };
}

export function runEditionPerformanceBenchmark(argv = process.argv.slice(2)): void {
  const iterations = Number.parseInt(argument(argv, "--iterations") ?? "10000", 10);
  const samples = Number.parseInt(argument(argv, "--samples") ?? "15", 10);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("--iterations must be a positive integer");
  if (!Number.isInteger(samples) || samples < 3) throw new Error("--samples must be an integer of at least 3");

  const profile = preferences();
  const role = makeInternship();
  const listingBefore: number[] = [];
  const listingAfter: number[] = [];
  const matchingBefore: number[] = [];
  const matchingAfter: number[] = [];

  const listingBaseline = () => measure(iterations, (index) => scoreListingRelevance(
    LISTINGS[index % LISTINGS.length]!,
    // Supplying the same rules exercises the historical per-call compilation
    // path; omitting them exercises the module-level compiled default.
    { rules: DEFAULT_RELEVANCE_RULES },
  ).score);
  const listingCompiled = () => measure(iterations, (index) => scoreListingRelevance(
    LISTINGS[index % LISTINGS.length]!,
  ).score);
  const matchingBaseline = () => measure(iterations, () => evaluateInternshipMatch(profile, role).score);
  const matchingCompiled = () => {
    const matcher = compileMatcher(profile);
    return measure(iterations, () => matcher.evaluate(role).score);
  };

  for (let warmup = 0; warmup < 3; warmup += 1) {
    listingBaseline();
    listingCompiled();
    matchingBaseline();
    matchingCompiled();
  }
  for (let sample = 0; sample < samples; sample += 1) {
    const listingBeforeSample = listingBaseline();
    const listingAfterSample = listingCompiled();
    const matchingBeforeSample = matchingBaseline();
    const matchingAfterSample = matchingCompiled();
    if (listingBeforeSample.checksum !== listingAfterSample.checksum) throw new Error("Listing benchmark paths returned different results");
    if (matchingBeforeSample.checksum !== matchingAfterSample.checksum) throw new Error("Matching benchmark paths returned different results");
    listingBefore.push(listingBeforeSample.milliseconds);
    listingAfter.push(listingAfterSample.milliseconds);
    matchingBefore.push(matchingBeforeSample.milliseconds);
    matchingAfter.push(matchingAfterSample.milliseconds);
  }

  process.stdout.write(`${JSON.stringify({
    capturedAt: new Date().toISOString(),
    iterations,
    samples,
    listingRuleCompilation: compareSamples(listingBefore, listingAfter),
    requestScopedMatching: compareSamples(matchingBefore, matchingAfter),
  }, null, 2)}\n`);
}

runEditionPerformanceBenchmark();
