/*
 * Public freshness is intentionally a small projection. Keep this module
 * free of source identifiers, URLs, crawl strategy, and diagnostic text so it
 * can be shared by the ordinary dashboard renderer and its tests.
 */

const FRESHNESS_STATES = new Set(["fresh", "partial", "stale", "unknown"]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now() ? new Date(parsed).toISOString() : null;
}

function freshnessSource(data) {
  if (!data || typeof data !== "object") return null;
  const candidate = data.freshness ?? data.catalog?.freshness;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : null;
}

export function normalizePublicFreshness(data = {}) {
  const source = freshnessSource(data);
  const rawState = typeof source?.state === "string" ? source.state.toLowerCase() : "unknown";
  const state = FRESHNESS_STATES.has(rawState) ? rawState : "unknown";
  const lastSuccessfulCrawlAt = validTimestamp(source?.lastSuccessfulCrawlAt);
  const rawAge = finiteNumber(source?.ageMs);
  const ageMs = rawAge !== null && rawAge >= 0 ? rawAge : null;
  const expectedSources = finiteNumber(source?.expectedSources);
  const trustedSources = finiteNumber(source?.trustedSources);
  const staleSources = finiteNumber(source?.staleSources);
  const fullCoverage = source?.fullCoverage === true;
  return {
    state,
    lastSuccessfulCrawlAt,
    ageMs,
    expectedSources: expectedSources !== null && expectedSources >= 0 ? expectedSources : null,
    trustedSources: trustedSources !== null && trustedSources >= 0 ? trustedSources : null,
    staleSources: staleSources !== null && staleSources >= 0 ? staleSources : null,
    fullCoverage,
  };
}

function relativeTime(value, now = Date.now()) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Time unavailable";
  const delta = Math.max(0, Number(now) - parsed);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function exactTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Time unavailable";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(parsed));
}

export function publicFreshnessPresentation(data = {}, { now = Date.now(), exact = false } = {}) {
  const freshness = normalizePublicFreshness(data);
  const generatedAt = validTimestamp(data?.generatedAt);
  const lastUpdateAt = freshness.lastSuccessfulCrawlAt || generatedAt;
  const stateCopy = {
    fresh: {
      label: "Catalog is current",
      detail: "Scout has a recent trusted update for the catalog.",
    },
    partial: {
      label: "Catalog is partly updated",
      detail: "Some catalog coverage needs another check; available listings remain visible.",
    },
    stale: {
      label: "Catalog may be out of date",
      detail: "Scout has not received a recent trusted update. Available listings remain visible.",
    },
    unknown: {
      label: "Catalog freshness is unavailable",
      detail: "Scout has not reported enough information to confirm freshness yet.",
    },
  }[freshness.state];
  let coverageLabel = "Coverage status unavailable";
  let coverageDetail = "Scout has not reported an aggregate coverage result yet.";
  if (freshness.fullCoverage || freshness.state === "fresh") {
    coverageLabel = "Coverage complete";
    coverageDetail = "The latest trusted update covered the configured catalog.";
  }
  if (freshness.expectedSources !== null && freshness.trustedSources !== null && freshness.expectedSources > 0) {
    const coverageCount = `${freshness.trustedSources} of ${freshness.expectedSources} source updates trusted`;
    coverageDetail = `${coverageCount}.`;
  }
  if (freshness.state === "partial") {
    coverageLabel = "Coverage needs a follow-up";
    coverageDetail = "Some sources did not provide a complete trusted update.";
  } else if (freshness.state === "stale") {
    coverageLabel = "Coverage needs a fresh check";
    coverageDetail = "The last trusted update is outside Scout’s freshness window.";
  }
  const updateLabel = lastUpdateAt
    ? exact
      ? exactTime(lastUpdateAt)
      : relativeTime(lastUpdateAt, now)
    : "Not reported";
  return {
    ...freshness,
    stateLabel: stateCopy.label,
    stateDetail: stateCopy.detail,
    coverageLabel,
    coverageDetail,
    lastUpdateAt,
    updateLabel,
    updateAccessibleLabel: lastUpdateAt ? exactTime(lastUpdateAt) : "Last update time not reported",
  };
}
