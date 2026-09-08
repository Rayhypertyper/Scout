import type { ScoutEditionConfig, AcquisitionProfile } from "../config/edition.js";
import { DEFAULT_SCOUT_EDITION_CONFIG } from "../config/edition.js";
import {
  scoreListingRelevance,
  type ListingRelevanceInput,
  type ListingRelevanceResult,
} from "../classification/listingRelevance.js";

export type AcquisitionDisposition = "early-reject" | "detail";

export interface AcquisitionDecision {
  edition: ScoutEditionConfig["edition"];
  disposition: AcquisitionDisposition;
  shouldFetchDetail: boolean;
  relevance: ListingRelevanceResult;
  /** Stable human-readable diagnostic suitable for run/source logs. */
  reason: string;
}

/**
 * Apply the edition-specific acquisition policy to cheap listing evidence.
 * The scorer itself is intentionally edition-independent; this function is
 * the only place where personal-vs-public acquisition behavior is selected.
 */
export function decideListingAcquisition(
  input: ListingRelevanceInput,
  config: ScoutEditionConfig = DEFAULT_SCOUT_EDITION_CONFIG,
  minimumScore = 18,
): AcquisitionDecision {
  const relevance = scoreListingRelevance(input, { minimumScore });
  const profile: AcquisitionProfile = config.acquisitionProfile;
  const canReject = profile.allowHighConfidenceEarlyReject
    && relevance.clearlyIrrelevant
    // A negative title family is required. Negative words in a department or
    // snippet alone are not reliable enough for a recall-sensitive reject.
    && relevance.matchedNegativeTitle.length > 0
    && relevance.matchedPositiveTitle.length === 0
    && relevance.matchedAmbiguousTitle.length === 0
    && relevance.matchedPositiveDepartment.length === 0
    && relevance.matchedPositiveSnippet.length === 0;
  if (canReject) {
    return {
      edition: config.edition,
      disposition: "early-reject",
      shouldFetchDetail: false,
      relevance,
      reason: `acquisition early-reject (${config.edition}): strong non-technical listing evidence with no technical or ambiguous signal; ${relevance.reason}`,
    };
  }
  const broadReason = config.edition === "public" && relevance.clearlyIrrelevant
    ? "public acquisition keeps broad canonical coverage"
    : relevance.clearlyIrrelevant
      ? "personal acquisition retained because the evidence is not sufficiently isolated"
      : "detail fetch retained for canonical classification";
  return {
    edition: config.edition,
    disposition: "detail",
    shouldFetchDetail: true,
    relevance,
    reason: `acquisition detail (${config.edition}): ${broadReason}; ${relevance.reason}`,
  };
}

export const evaluateAcquisition = decideListingAcquisition;
