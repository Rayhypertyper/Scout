import type { DatabaseSync } from "node:sqlite";

import { listingActionKey } from "./database/actions.js";

interface NewListingRow {
  internship_id: string;
}

/** Keep the dashboard NEW ROLE banner for this long after a listing is first found. */
export const NEW_ROLE_BANNER_MS = 16 * 60 * 60 * 1000;
/** Rebuild cached NEW labels on this interval so banners can expire between scans. */
export const NEW_ROLE_BANNER_CACHE_MS = 15 * 60 * 1000;

export function newRoleBannerCutoffIso(now: Date | number = Date.now()): string {
  const timestamp = typeof now === "number" ? now : now.getTime();
  return new Date(timestamp - NEW_ROLE_BANNER_MS).toISOString();
}

export function newRoleBannerCacheKey(now: Date | number = Date.now()): number {
  const timestamp = typeof now === "number" ? now : now.getTime();
  return Math.floor(timestamp / NEW_ROLE_BANNER_CACHE_MS);
}

export function isWithinNewRoleBannerWindow(
  seenAt: string | undefined | null,
  now: Date | number = Date.now(),
): boolean {
  if (!seenAt) return false;
  const seen = Date.parse(seenAt);
  if (!Number.isFinite(seen)) return false;
  const timestamp = typeof now === "number" ? now : now.getTime();
  return seen <= timestamp && timestamp - seen < NEW_ROLE_BANNER_MS;
}

/**
 * Return listings that should keep the dashboard's NEW banner.
 *
 * The banner belongs to a 16-hour window after a posting is first recorded as
 * NEW, not to the mutable lifecycle value on the internship row. Later scans
 * can mark the row UNCHANGED; the original NEW observation still keeps the
 * banner until `first_seen_at` ages out.
 */
export function readNewListingKeys(database: DatabaseSync, now: Date | number = Date.now()): string[] {
  const cutoff = newRoleBannerCutoffIso(now);
  const rows = database.prepare(`
    SELECT DISTINCT i.id AS internship_id
    FROM internships i
    WHERE i.first_seen_at >= @cutoff
      AND EXISTS (
        SELECT 1
        FROM run_internships ri
        WHERE ri.internship_id = i.id AND ri.lifecycle_status = 'NEW'
      )
    ORDER BY i.id
  `).all({ cutoff }) as unknown as NewListingRow[];
  return rows.map((row) => listingActionKey("internship", row.internship_id));
}
