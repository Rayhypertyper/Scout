/* global localStorage */

// Persist only public card facts, never account actions, matching results,
// resume data, auth tokens, or crawl diagnostics. A snapshot is a preview;
// the live head request always replaces it before pagination can resume.
export const LISTING_SNAPSHOT_KEY = "scout.listingSnapshots.v1";
export const LISTING_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 6;
const MAX_ITEMS = 40;
const MAX_BYTES = 750_000;
const CARD_FIELDS = [
  "id", "listingId", "listingType", "jobId", "company", "title", "location",
  "canadianLocation", "remoteStatus", "applicationUrl", "postingUrl", "sourceUrl",
  "sources", "technologies", "categories", "relevanceScore", "relevanceReason",
  "internshipTerm", "internshipYear", "seasons", "duration", "postingDate",
  "discoveredAt", "firstSeenAt", "lastSeenAt", "availabilityStatus",
  "lifecycleStatus", "sponsorshipOfferStatus",
];

function snapshotStorage(storage) {
  return storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
}

function publicCard(role) {
  if (!role || typeof role !== "object" || !(role.listingId || role.id)
    || typeof role.company !== "string" || typeof role.title !== "string") return null;
  return Object.fromEntries(CARD_FIELDS
    .filter((field) => role[field] !== undefined)
    .map((field) => [field, role[field]]));
}

function readEntries(storage, now) {
  const raw = storage?.getItem(LISTING_SNAPSHOT_KEY);
  if (!raw || raw.length > MAX_BYTES) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (parsed?.schema !== 1 || !Array.isArray(parsed.entries)) return [];
  return parsed.entries.slice(-MAX_ENTRIES).filter((entry) =>
    typeof entry?.key === "string" && Number.isFinite(entry.savedAt)
    && entry.savedAt <= now && now - entry.savedAt <= LISTING_SNAPSHOT_MAX_AGE_MS
    && Array.isArray(entry.items));
}

export function readListingSnapshot(key, { storage, now = Date.now() } = {}) {
  try {
    const entry = readEntries(snapshotStorage(storage), now).find((candidate) => candidate.key === key);
    if (!entry) return null;
    const items = entry.items.slice(0, MAX_ITEMS).map(publicCard).filter(Boolean);
    if (!items.length) return null;
    return {
      items,
      savedAt: entry.savedAt,
      // Old offsets must never be appended to a newer catalog.
      pagination: { limit: items.length, offset: 0, total: items.length, hasMore: false, nextOffset: null },
    };
  } catch {
    return null;
  }
}

export function rememberListingSnapshot(key, payload, { storage, now = Date.now() } = {}) {
  // Personalized matches cannot be safely restored before the session check.
  if (payload?.filters?.view !== "all") return false;
  try {
    const target = snapshotStorage(storage);
    if (!target) return false;
    const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, MAX_ITEMS)
      .map(publicCard).filter(Boolean);
    const entries = readEntries(target, now).filter((entry) => entry.key !== key);
    if (items.length) entries.push({ key, savedAt: now, items });
    while (entries.length > MAX_ENTRIES) entries.shift();
    let serialized = JSON.stringify({ schema: 1, entries });
    while (serialized.length > MAX_BYTES && entries.length) {
      entries.shift();
      serialized = JSON.stringify({ schema: 1, entries });
    }
    target.setItem(LISTING_SNAPSHOT_KEY, serialized);
    return items.length > 0 && entries.some((entry) => entry.key === key);
  } catch {
    // Storage denial/quota/corruption must never prevent live listings loading.
    return false;
  }
}

export function clearListingSnapshots({ storage } = {}) {
  try {
    snapshotStorage(storage)?.removeItem(LISTING_SNAPSHOT_KEY);
  } catch { /* Live reads still work when browser storage is unavailable. */ }
}
