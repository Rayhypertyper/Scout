import { parseSortDate } from "./roleSorting.js";

export const RECENT_LISTING_WINDOW_MS = 24 * 60 * 60 * 1000;

function listingKey(role) {
  const listingType = role?.listingType || "internship";
  const listingId = role?.listingId || role?.id;
  return `${listingType}:${listingId}`;
}

export function isNewSinceLastScan(role, data) {
  // Compact /api/roles cards carry the server-authoritative lifecycle flag.
  // The server keeps that flag true for 16 hours after a listing is first found.
  // Keep the older timestamp/run fallback for callers rendering legacy-shaped
  // records (and for compatibility with existing unit tests).
  if (typeof role?.isNew === "boolean") return role.isNew;
  const key = listingKey(role);
  if (Array.isArray(data?.newListingKeys)) {
    if (data.newListingKeys.includes(key)) return true;
    // Live board listings are not persisted in run_internships. Keep their
    // existing timestamp-based fallback until they are represented there.
    if ((role?.listingType || "internship") !== "grind") return false;
  }

  const latestCompletedRunId = data?.latestCompletedRun?.id;
  // statusRunId makes sure only NEW roles from the latest completed scan lead
  // when reading older dashboard payloads that predate newListingKeys.
  return role?.lifecycleStatus === "NEW"
    && latestCompletedRunId !== undefined
    && role?.statusRunId === latestCompletedRunId;
}

export function isWithinRecentListingWindow(value, now = Date.now()) {
  const timestamp = parseSortDate(value, now)
    ?? parseSortDate(
      String(value ?? "").replace(/^(?:posting\s+date|date\s+posted|posted(?:\s+on)?)\s*:?\s*/i, ""),
      now,
    );
  return timestamp !== null
    && timestamp <= now
    && now - timestamp < RECENT_LISTING_WINDOW_MS;
}

/**
 * A listing is recent when it was posted or first found within the last day.
 * Keep the server's NEW flag as a compatibility fallback because it is already
 * bounded to a shorter window and covers live-board records without dates.
 */
export function isRecentListing(role, data, now = Date.now()) {
  if (isNewSinceLastScan(role, data)) return true;
  return [role?.postingDate, role?.firstSeenAt, role?.discoveredAt]
    .some((value) => isWithinRecentListingWindow(value, now));
}
