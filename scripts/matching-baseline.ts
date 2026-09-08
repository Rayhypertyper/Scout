import { readFileSync } from "node:fs";

import { InternshipSchema, type Internship } from "../src/domain/schemas.js";
import { ELIGIBILITY_ENGINE_VERSION } from "../src/eligibility/types.js";
import {
  evaluateInternshipMatch,
  type MatchExplanation,
  type MatchScoreBreakdown,
} from "../src/preferences/matching.js";
import type { RawJob } from "../src/domain/types.js";
import { sha256 } from "../src/utils/hash.js";
import {
  buildMatchingFixtureSuite,
  MATCHING_AS_OF,
  MATCHING_ROLE_DEFINITIONS,
  matchingInputDigest,
  type CandidateProfile,
  type MatchingFixtureCase,
  type MatchingFixtureSuite,
  type MatchingRole,
} from "../tests/fixtures/matchingFixtures.js";

const SOURCE_FILES = [
  "src/preferences/matching.ts",
  "src/eligibility/engine.ts",
  "src/classification/analyzeJob.ts",
  "src/classification/roleClassifier.ts",
  "src/classification/technologyExtractor.ts",
  "src/parsing/qualifications.ts",
  "tests/fixtures/matchingFixtures.ts",
] as const;

interface BaselineRoleCatalogEntry {
  id: string;
  label: string;
  postingEvidence: string;
}

interface BaselineRawEvidence {
  id: string;
  label: string;
  raw: RawJob;
}

interface BaselineCaseOutput {
  id: string;
  profileId: string;
  roleId: string;
  expected: MatchingFixtureCase["expected"];
  expectedNote: string;
  actual: {
    eligible: boolean;
    matched?: boolean;
    status: string;
    version?: string;
    score: number;
    scoreBucket: string;
    hardExclusions: string[];
    preferenceMismatches?: string[];
    uncertainty?: string[];
    insufficientFit?: string[];
    unknown: string[];
    reasons: string[];
    scoreBreakdown?: MatchScoreBreakdown;
    explanation?: MatchExplanation;
    criterionStates: Record<string, string>;
  };
  roleSignals: {
    title: string;
    locations: string[];
    term: string | null;
    year: string | null;
    categories: string[];
    technologies: string[];
    relevanceScore: number;
    relevanceReason: string;
    lifecycleStatus: string;
  };
}

interface BaselineInputs {
  profiles: CandidateProfile[];
  roles: Array<{ id: string; internship: Internship }>;
}

interface BaselineArtifact {
  schemaVersion: number;
  fixtureVersion: "matching-fixtures-v1";
  asOf: typeof MATCHING_AS_OF;
  generatedFrom: "current-working-tree";
  inputDigest: string;
  sourceHashes: Record<string, string>;
  roleCatalog: BaselineRoleCatalogEntry[];
  rawEvidence: BaselineRawEvidence[];
  inputs: BaselineInputs;
  cases: BaselineCaseOutput[];
  matchingModelVersion?: string;
  comparison?: BaselineComparison;
}

interface ComparisonActual {
  eligible: boolean;
  matched: boolean;
  status: string;
  score: number;
  scoreBucket: string;
  hardExclusions: string[];
  preferenceMismatches: string[];
  uncertainty: string[];
  insufficientFit: string[];
  reasons: string[];
  unknown: string[];
}

interface BaselineComparisonRow {
  id: string;
  profileId: string;
  roleId: string;
  before: ComparisonActual;
  after: ComparisonActual;
  scoreDelta: number;
  matchedChanged: boolean;
  eligibilityChanged: boolean;
}

interface BaselineComparison {
  beforeInputDigest: string;
  afterInputDigest: string;
  rows: BaselineComparisonRow[];
}

function scoreBucket(score: number, eligible: boolean): string {
  if (!eligible) return "excluded";
  if (score >= 90) return "90-100";
  if (score >= 75) return "75-89";
  if (score >= 50) return "50-74";
  if (score > 0) return "1-49";
  return "0 (eligible)";
}

function sourceHashes(): Record<string, string> {
  return Object.fromEntries(SOURCE_FILES.map((path) => [path, sha256(readFileSync(path, "utf8"))]));
}

function profileMap(profiles: readonly CandidateProfile[]): Map<string, CandidateProfile> {
  return new Map(profiles.map((profile) => [profile.id, profile]));
}

function roleMap(roles: readonly MatchingRole[]): Map<string, MatchingRole> {
  return new Map(roles.map((role) => [role.id, role]));
}

function outputForCase(
  fixtureCase: MatchingFixtureCase,
  profiles: Map<string, CandidateProfile>,
  roles: Map<string, MatchingRole>,
): BaselineCaseOutput {
  const profile = profiles.get(fixtureCase.profileId);
  const role = roles.get(fixtureCase.roleId);
  if (!profile || !role) throw new Error(`Unknown fixture reference in ${fixtureCase.id}`);
  const match = evaluateInternshipMatch(profile.preferences, role.internship);
  return {
    id: fixtureCase.id,
    profileId: fixtureCase.profileId,
    roleId: fixtureCase.roleId,
    expected: fixtureCase.expected,
    expectedNote: fixtureCase.expectedNote,
    actual: {
      eligible: match.eligible,
      matched: match.matched,
      status: match.status,
      version: match.version,
      score: match.score,
      scoreBucket: scoreBucket(match.score, match.eligible),
      hardExclusions: match.explanation.hardExclusions,
      preferenceMismatches: match.explanation.preferenceMismatches,
      uncertainty: match.explanation.uncertainty,
      insufficientFit: match.explanation.insufficientFit,
      unknown: match.unknown,
      reasons: match.reasons,
      scoreBreakdown: match.scoreBreakdown,
      explanation: match.explanation,
      criterionStates: Object.fromEntries(
        match.eligibility.criterionResults.map(({ key, state }) => [key, state]),
      ),
    },
    roleSignals: {
      title: role.internship.title,
      locations: role.internship.location,
      term: role.internship.internshipTerm,
      year: role.internship.internshipYear,
      categories: role.internship.categories,
      technologies: role.internship.technologies,
      relevanceScore: role.internship.relevanceScore,
      relevanceReason: role.internship.relevanceReason,
      lifecycleStatus: role.internship.lifecycleStatus,
    },
  };
}

function rawEvidenceFromDefinitions(): BaselineRawEvidence[] {
  return MATCHING_ROLE_DEFINITIONS.map(({ id, label, raw }) => ({
    id,
    label,
    raw,
  }));
}

function artifactFromSuite(suite: MatchingFixtureSuite, rawEvidence = rawEvidenceFromDefinitions()): BaselineArtifact {
  const profiles = [...suite.profiles];
  const roles = [...suite.roles];
  const profileLookup = profileMap(profiles);
  const roleLookup = roleMap(roles);
  return {
    schemaVersion: 2,
    fixtureVersion: "matching-fixtures-v1",
    asOf: suite.asOf,
    generatedFrom: "current-working-tree",
    inputDigest: matchingInputDigest(suite),
    sourceHashes: sourceHashes(),
    roleCatalog: roles.map(({ id, label, postingEvidence }) => ({ id, label, postingEvidence })),
    rawEvidence,
    inputs: {
      profiles: profiles.map(({ id, label, summary, preferences }) => ({ id, label, summary, preferences })),
      roles: roles.map(({ id, internship }) => ({ id, internship })),
    },
    cases: suite.cases.map((fixtureCase) => outputForCase(fixtureCase, profileLookup, roleLookup)),
    matchingModelVersion: "matching-v2",
  };
}

function suiteFromSnapshot(snapshot: BaselineArtifact): MatchingFixtureSuite {
  const labels = new Map(snapshot.roleCatalog.map(({ id, label, postingEvidence }) => [id, { label, postingEvidence }]));
  const roles = snapshot.inputs.roles.map(({ id, internship }): MatchingRole => {
    const metadata = labels.get(id);
    if (!metadata) throw new Error(`Snapshot is missing role catalog metadata for ${id}`);
    return {
      id,
      label: metadata.label,
      postingEvidence: metadata.postingEvidence,
      internship: InternshipSchema.parse(internship),
    };
  });
  return {
    asOf: snapshot.asOf,
    profiles: snapshot.inputs.profiles,
    roles,
    cases: snapshot.cases.map(({ id, profileId, roleId, expected, expectedNote }) => ({
      id,
      profileId,
      roleId,
      expected,
      expectedNote,
    })),
  };
}

function readSnapshot(path: string): BaselineArtifact {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid matching baseline snapshot: ${path}`);
  return parsed as BaselineArtifact;
}

function cell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "—";
}

function joinValues(values: readonly string[]): string {
  return values.length > 0 ? values.join("; ") : "—";
}

function markdown(artifact: BaselineArtifact): string {
  const profiles = profileMap(artifact.inputs.profiles);
  const roles = new Map(artifact.roleCatalog.map((role) => [role.id, role]));
  const rows = artifact.cases.map((entry) => {
    const profile = profiles.get(entry.profileId);
    const role = roles.get(entry.roleId);
    if (!profile || !role) throw new Error(`Cannot render unknown row reference ${entry.id}`);
    const hard = entry.actual.hardExclusions.length > 0 ? joinValues(entry.actual.hardExclusions) : "none";
    const positive = entry.actual.reasons.length > 0 ? `positive: ${joinValues(entry.actual.reasons)}` : "positive: none";
    const unknown = entry.actual.unknown.length > 0 ? `unknown: ${joinValues(entry.actual.unknown)}` : "unknown: none";
    return `| ${cell(entry.id)} | ${cell(profile.summary)} | ${cell(role.postingEvidence)} | ${cell(entry.expected)}<br>${cell(entry.expectedNote)} | ${cell(`${entry.actual.status}; eligible=${entry.actual.eligible}`)} | ${entry.actual.score} | ${cell(entry.actual.scoreBucket)} | ${cell(hard)} | ${cell(`${positive}; ${unknown}`)} |`;
  }).join("\n");
  const hashLines = Object.entries(artifact.sourceHashes).map(([path, hash]) => `- \`${path}\`: \`${hash}\``).join("\n");
  return `# Deterministic matching BEFORE baseline\n\nThis table records the current working tree before any matching weight changes. It uses fixed \`asOf=${artifact.asOf}\` input generation and the deterministic \`analyzeRawJob → evaluateInternshipMatch\` pipeline. Scores and reasons below are observations, not the future scoring contract; explicit hard failures and unknown states are the contract under review.\n\n- Fixture cases: ${artifact.cases.length}; profiles: ${artifact.inputs.profiles.length}; roles: ${artifact.inputs.roles.length}.\n- Normalized input digest: \`${artifact.inputDigest}\`.\n- Fresh pipeline rerun: \`npm exec -- tsx scripts/matching-baseline.ts > docs/benchmarks/matching-before-2026-08-31.json\`.\n- Exact normalized input replay after parser changes or weight changes: \`npm exec -- tsx scripts/matching-baseline.ts --snapshot docs/benchmarks/matching-before-2026-08-31.json > docs/benchmarks/matching-after-2026-08-31.json\`.\n- Render this stored BEFORE artifact without recomputing it: \`npm exec -- tsx scripts/matching-baseline.ts --render-stored docs/benchmarks/matching-before-2026-08-31.json --markdown > docs/matching-before-2026-08-31.md\`.\n\nSource hashes at capture:\n\n${hashLines}\n\nCurrent BEFORE scoring mechanics:\n\n- The versioned \`eligibility-v1\` engine is the hard authority: any criterion failure yields \`not_eligible\`, while posting/profile unknowns yield \`likely_eligible\` or \`unclear\`; the legacy \`eligible\` field is true for both non-failing statuses.\n- The additive score uses exact term 30 (partial term 14), preferred city 30/country 20/remote 24 (broad remote 16), degree/graduation/authorization/sponsorship passes at 5 each, category overlap at 12 per tag up to 36 (plus a broad software 6), technology overlap at 5 each up to 25, relevance at 0-10, and lifecycle freshness at NEW 4 or UPDATED 2. Ineligible rows are forced to score 0 and the total is clamped to 100.\n- Reasons combine soft signals with resolved eligibility reasons and are truncated to five entries; hard exclusions and unknown criteria come from the eligibility engine.\n\nObserved calibration risks for the next matcher pass: exact and multi-tag roles frequently clamp at 100; the unrelated marketing row still scores 66 because term/location signals dominate despite no role/technology overlap; strong sparse rows score highly while all nonessential eligibility facts are unknown; and NEW versus UNCHANGED freshness is hidden when both totals clamp.\n\n| Case | Candidate facts/preferences | Posting evidence | Expected qualitative result | Current status | Score | Bucket | Hard exclusions | Positive reasons / unknowns |\n| --- | --- | --- | --- | --- | ---: | --- | --- | --- |\n${rows}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const renderStoredPath = args.find((arg) => arg.startsWith("--render-stored="))?.slice("--render-stored=".length)
    ?? (args.includes("--render-stored") ? args[args.indexOf("--render-stored") + 1] : undefined);
  const snapshotPath = args.find((arg) => arg.startsWith("--snapshot="))?.slice("--snapshot=".length)
    ?? (args.includes("--snapshot") ? args[args.indexOf("--snapshot") + 1] : undefined);
  if (args.includes("--render-stored") && !renderStoredPath) throw new Error("--render-stored requires a JSON path");
  if (args.includes("--snapshot") && !snapshotPath) throw new Error("--snapshot requires a JSON path");
  if (renderStoredPath && snapshotPath) throw new Error("Use only one of --render-stored and --snapshot");

  if (renderStoredPath) {
    const stored = readSnapshot(renderStoredPath);
    if (args.includes("--markdown")) {
      process.stdout.write(markdown(stored));
      return;
    }
    process.stdout.write(`${JSON.stringify({ ...stored, replay: "stored-baseline" }, null, 2)}\n`);
    return;
  }

  const snapshot = snapshotPath ? readSnapshot(snapshotPath) : null;
  const suite = snapshot ? suiteFromSnapshot(snapshot) : await buildMatchingFixtureSuite();
  const artifact = artifactFromSuite(suite, snapshot?.rawEvidence ?? rawEvidenceFromDefinitions());
  if (String(artifact.asOf) !== MATCHING_AS_OF) throw new Error(`Unexpected fixture asOf: ${String(artifact.asOf)}`);
  if (args.includes("--markdown")) {
    process.stdout.write(markdown(artifact));
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ...artifact,
    engineVersion: ELIGIBILITY_ENGINE_VERSION,
    replay: snapshotPath ? "snapshot" : "fresh-classification-pipeline",
  }, null, 2)}\n`);
}

await main();
