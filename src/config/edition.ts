import type { ScoutEdition } from "../domain/schemas.js";

/**
 * Acquisition is deliberately narrower than classification or matching. It
 * controls only whether an expensive detail request is worth making for a
 * listing whose title/snippet is already visible.
 */
export interface AcquisitionProfile {
  /** Personal Scout may reject only high-confidence non-technical listings. */
  readonly allowHighConfidenceEarlyReject: boolean;
  /** Public Scout keeps the canonical corpus broad for every future user. */
  readonly preserveAmbiguousListings: boolean;
}

export interface ScoutFeatureFlags {
  readonly canonicalClassification: boolean;
  readonly userMatching: boolean;
  readonly acquisitionDiagnostics: boolean;
  /** Owner/admin crawler controls and source internals may reach the client. */
  readonly crawlerAdministration: boolean;
}

export interface ScoutEditionConfig {
  readonly edition: ScoutEdition;
  readonly acquisitionProfile: AcquisitionProfile;
  /** Admission knobs for canonical storage; never user-specific. */
  readonly canonicalAdmission: {
    readonly minimumRelevanceScore: number;
    readonly allowUnclassifiedInternships: boolean;
    /** Keep legacy title exclusions out of user-independent public facts. */
    readonly applyTitleExclusions: boolean;
  };
  readonly features: ScoutFeatureFlags;
}

export const PERSONAL_EDITION_CONFIG: ScoutEditionConfig = Object.freeze({
  edition: "personal",
  acquisitionProfile: Object.freeze({
    allowHighConfidenceEarlyReject: true,
    preserveAmbiguousListings: true,
  }),
  canonicalAdmission: Object.freeze({
    // Canonical admission is deliberately edition-independent. Personal
    // visibility belongs after classification; acquisition is the only
    // edition-specific network optimization.
    minimumRelevanceScore: 0,
    allowUnclassifiedInternships: true,
    applyTitleExclusions: false,
  }),
  features: Object.freeze({
    canonicalClassification: true,
    userMatching: true,
    acquisitionDiagnostics: true,
    crawlerAdministration: true,
  }),
});

export const PUBLIC_EDITION_CONFIG: ScoutEditionConfig = Object.freeze({
  edition: "public",
  acquisitionProfile: Object.freeze({
    allowHighConfidenceEarlyReject: false,
    preserveAmbiguousListings: true,
  }),
  canonicalAdmission: Object.freeze({
    // Public storage keeps lower-confidence internships so future users can
    // match against the same canonical crawl without a recrawl.
    minimumRelevanceScore: 0,
    allowUnclassifiedInternships: true,
    applyTitleExclusions: false,
  }),
  features: Object.freeze({
    canonicalClassification: true,
    userMatching: true,
    acquisitionDiagnostics: true,
    crawlerAdministration: false,
  }),
});

export function parseScoutEdition(value: unknown): ScoutEdition {
  if (value === "personal" || value === "public") return value;
  throw new Error(`SCOUT_EDITION must be "personal" or "public"; received ${String(value)}.`);
}

export function scoutEditionFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ScoutEdition {
  const value = environment.SCOUT_EDITION?.trim().toLocaleLowerCase();
  // A missing or mistyped deployment variable must never accidentally enable
  // the owner's narrow personal crawl policy. Public is the safe fallback;
  // callers that need a strict configuration check can still use
  // parseScoutEdition directly at their own boundary.
  if (!value) return "public";
  return value === "personal" || value === "public" ? value : "public";
}

export function configForEdition(edition: ScoutEdition): ScoutEditionConfig {
  // Keep the public profile as the defensive runtime fallback even when a
  // JavaScript caller bypasses the TypeScript union with an invalid value.
  return edition === "personal" ? PERSONAL_EDITION_CONFIG : PUBLIC_EDITION_CONFIG;
}

/** Resolve the profile once at the application boundary. */
export function resolveScoutEditionConfig(edition?: ScoutEdition | null): ScoutEditionConfig {
  const candidate: unknown = edition ?? scoutEditionFromEnvironment();
  return configForEdition(candidate === "personal" || candidate === "public" ? candidate : "public");
}

// Descriptive aliases make the boundary easy to find without duplicating the
// two edition implementations.
export const getScoutEditionConfig = resolveScoutEditionConfig;
export const DEFAULT_SCOUT_EDITION_CONFIG = PUBLIC_EDITION_CONFIG;
