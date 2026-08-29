import type { DatabaseSync } from "node:sqlite";

import { providerJobIdentityKeys } from "../deduplication/deduplicate.js";
import { APPLICATION_STAGES } from "../domain/applicationStages.js";
import { InternshipSchema, type Internship } from "../domain/schemas.js";
import { parseLocation } from "../parsing/locations.js";
import { normalizeCompanyIdentity, normalizeIdentity, normalizeRoleIdentity, uniqueStrings } from "../utils/text.js";
import { extractJobId, normalizedJobUrl, organizationTokenFromUrl } from "../utils/url.js";
import { sha256 } from "../utils/hash.js";

export type ListingAction = "applied" | "cant_fit";
export type ListingType = "internship" | "grind";

export interface ListingActionRecord {
  listingKey: string;
  listingType: ListingType;
  listingId: string;
  action: ListingAction;
  company: string;
  title: string;
  createdAt: string;
}

export function listingActionKey(listingType: ListingType, listingId: string): string {
  return `${listingType}:${listingId}`;
}

export interface ListingActionIdentity {
  identityKey: string;
  directJobIds: string[];
}

export interface StoredListingActionIdentity {
  listingKey: string;
  identityKey: string;
  directJobIds: string[];
}

export interface ListingActionContext {
  applicationUrl?: string | null;
  postingUrl?: string | null;
  jobId?: string | null;
  location?: string | null;
}

/**
 * Fill action context from the server-owned listing payload when the browser
 * sends an incomplete request. This keeps the decision durable even when an
 * older dashboard bundle omitted the action button data attributes.
 */
export function mergeListingActionContext(
  context: ListingActionContext,
  internship?: Internship | null,
): ListingActionContext {
  return {
    applicationUrl: context.applicationUrl ?? internship?.applicationUrl ?? null,
    postingUrl: context.postingUrl ?? internship?.postingUrl ?? null,
    jobId: context.jobId ?? internship?.jobId ?? null,
    location: context.location ?? (internship && internship.location.length > 0 ? internship.location.join(" · ") : null),
  };
}

interface ListingActionContextRow {
  application_url: string | null;
  posting_url: string | null;
  job_id: string | null;
  location: string | null;
}

interface ListingActionIdentityRow {
  listing_key: string;
  identity_key: string;
  direct_job_ids_json: string;
}

function effectiveLocations(internship: Internship): Internship["normalizedLocations"] {
  return internship.normalizedLocations.map((location) => {
    const reparsed = parseLocation(location.raw);
    return {
      ...location,
      country: location.country ?? reparsed.country,
      provinceState: location.provinceState ?? reparsed.provinceState,
      city: location.city ?? reparsed.city,
      remote: location.remote || reparsed.remote,
      remoteScope: location.remoteScope ?? reparsed.remoteScope,
    };
  });
}

function internshipLocationKeys(internship: Internship): string[] {
  const normalized = effectiveLocations(internship)
    .filter(({ country, provinceState, city }) => Boolean(country || provinceState || city))
    .map(({ country, provinceState, city }) => [country, provinceState, city]
      .map((value) => normalizeIdentity(value ?? ""))
      .join("|"));
  return uniqueStrings(normalized);
}

function internshipLocationIdentity(internship: Internship): string {
  const normalized = effectiveLocations(internship).map((location) => [
    location.country,
    location.provinceState,
    location.city,
    location.remote ? location.remoteScope ?? "remote" : "onsite",
  ].map((value) => normalizeIdentity(value ?? "")).join("|")).filter(Boolean).sort();
  return normalized.length > 0 ? normalized.join(";") : internship.location.map(normalizeIdentity).sort().join("|");
}

function internshipCityLocationKeys(internship: Internship): string[] {
  return uniqueStrings(effectiveLocations(internship)
    .filter(({ country, city }) => Boolean(country && city))
    .map(({ country, city, remote, remoteScope }) => [
      country,
      city,
      remote ? remoteScope ?? "remote" : "onsite",
    ].map((value) => normalizeIdentity(value ?? "")).join("|")));
}

function actionJobIdAliases(jobIds: string[]): string[] {
  return uniqueStrings(jobIds.flatMap((id) => {
    const aliases = [id, id.replace(/(\d{3,})[-_]\d+$/, "$1")];
    // Workday can expose the same requisition as RQ225401, as
    // RQ225401-1, or embedded in a longer title slug. Keep the complete
    // value for safety, but also retain the stable requisition token so an
    // action taken from one source hides its Workday copy from another.
    for (const match of id.matchAll(/(?:^|[_-])((?:(?:jr|req|rq)[-_]?[a-z0-9]+|r[-_]?\d[a-z0-9]*)(?:_[a-z0-9]+)?)(?:[-_]\d+)?/gi)) {
      const token = match[1];
      if (token) aliases.push(token);
    }
    return aliases;
  }));
}

function isGenericListingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "").toLocaleLowerCase() || "/";
    if (path === "/" || /\/(?:career|careers|jobs?|job-search|search)$/.test(path)) {
      return extractJobId(value) === null;
    }
    // Greenhouse's embedded application endpoint is a reusable form shell;
    // its token is the listing identity, not the URL path itself.
    return /\/embed\/job_app$/.test(path);
  } catch {
    return false;
  }
}

function embeddedListingJobId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "").toLocaleLowerCase();
    const token = parsed.searchParams.get("token");
    return /\/embed\/job_app$/.test(path) && token ? `embedded:${sha256(token).slice(0, 24)}` : null;
  } catch {
    return null;
  }
}

function embeddedListingJobIds(urls: string[]): string[] {
  return uniqueStrings(urls.map(embeddedListingJobId).filter((value): value is string => Boolean(value)));
}

function embeddedListingIdentities(url: string, directJobIds: string[]): ListingActionIdentity[] {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "").toLocaleLowerCase();
    if (!/\/embed\/job_app$/.test(path)) return [];
    const token = parsed.searchParams.get("token");
    if (!token) return [];
    const organization = normalizeIdentity(parsed.searchParams.get("for") ?? organizationTokenFromUrl(url));
    if (!organization) return [];
    // Do not persist the form token itself. A digest keeps the identity
    // stable across source copies without retaining a credential-like value.
    return [{
      identityKey: `embedded-job:${organization}|${sha256(token).slice(0, 24)}`,
      directJobIds,
    }];
  } catch {
    return [];
  }
}

function actionUrlIdentities(urls: string[], directJobIds: string[]): ListingActionIdentity[] {
  return urls.flatMap((url) => [
    ...(isGenericListingUrl(url)
      ? []
      : (() => {
        try {
          return uniqueStrings([normalizedJobUrl(url), url]).map((identityUrl) => ({
            identityKey: `url:${identityUrl}`,
            directJobIds,
          }));
        } catch {
          return [];
        }
      })()),
    ...embeddedListingIdentities(url, directJobIds),
  ]);
}

function actionDirectJobIds(internship: Internship): string[] {
  const urls = [internship.applicationUrl, internship.postingUrl];
  const specificUrls = urls.filter((url) => !isGenericListingUrl(url));
  // A generic careers page or embedded form shell is not a requisition ID.
  // Treating an aggregator slug as a direct ID makes an otherwise identical
  // employer ATS copy look like a different job.
  return actionJobIdAliases(uniqueStrings([
    ...specificUrls.map((url) => extractJobId(url) ?? ""),
    ...(specificUrls.length > 0 ? [internship.jobId ?? ""] : []),
    ...embeddedListingJobIds(urls),
  ].filter((id) => id.startsWith("embedded:") || /\d/.test(id)).map((id) => id.toLocaleLowerCase())));
}

function contextJobIds(context: ListingActionContext): string[] {
  return actionJobIdAliases(uniqueStrings([
    context.jobId ?? "",
    ...[context.applicationUrl, context.postingUrl].filter((value): value is string => Boolean(value)).map((url) => extractJobId(url) ?? ""),
  ].filter((id) => /\d/.test(id)).map((id) => id.toLocaleLowerCase())));
}

function contextUrlIdentities(context: ListingActionContext, directJobIds: string[]): ListingActionIdentity[] {
  const urls = [context.applicationUrl, context.postingUrl].filter((value): value is string => Boolean(value));
  return [
    ...actionUrlIdentities(urls, directJobIds),
    ...urls.flatMap((url) => {
      const token = organizationTokenFromUrl(url);
      return directJobIds.map((id) => ({ identityKey: `provider-job:${token}|${id}`, directJobIds }));
    }),
  ];
}

function contextFromRow(row: ListingActionContextRow): ListingActionContext {
  return {
    applicationUrl: row.application_url,
    postingUrl: row.posting_url,
    jobId: row.job_id,
    location: row.location,
  };
}

function hasActionContext(context: ListingActionContext): boolean {
  return Boolean(context.applicationUrl || context.postingUrl || context.jobId || context.location);
}

function actionProviderJobIdentityKeys(internship: Internship): string[] {
  const directJobIds = actionDirectJobIds(internship);
  return uniqueStrings([internship.applicationUrl, internship.postingUrl].flatMap((url) => {
    const token = organizationTokenFromUrl(url);
    return directJobIds.map((id) => `provider-job:${token}|${id}`);
  }).filter((value) => !value.endsWith("|")));
}

function uniqueActionIdentities(identities: ListingActionIdentity[]): ListingActionIdentity[] {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    if (!identity.identityKey || seen.has(identity.identityKey)) return false;
    seen.add(identity.identityKey);
    return true;
  });
}

function providerTokens(identities: StoredListingActionIdentity[] | ListingActionIdentity[]): Set<string> {
  return new Set(identities.flatMap(({ identityKey }) => {
    const token = /^provider-job:([^|]+)\|/.exec(identityKey)?.[1];
    if (token) return [token];
    return identityKey.startsWith("embedded-job:") ? ["embedded"] : [];
  }));
}

function isDiscoveryProviderToken(token: string): boolean {
  return new Set([
    "applybolt",
    "hiringcafe",
    "interninsider",
    "jobright",
    "linkedin",
    "simplify",
    "wellfound",
  ]).has(token);
}

function isCrossSurfaceRoleAlias(
  identityKey: string,
  storedIds: Set<string>,
  candidateIds: Set<string>,
  storedTokens: Set<string>,
  candidateTokens: Set<string>,
): boolean {
  if (!(identityKey.startsWith("role:") || identityKey.startsWith("role-city:"))) return false;
  if (storedIds.size === 0 || candidateIds.size === 0) return false;
  if (storedTokens.size === 0 || candidateTokens.size === 0) return false;
  const storedIsDiscovery = [...storedTokens].some(isDiscoveryProviderToken);
  const candidateIsDiscovery = [...candidateTokens].some(isDiscoveryProviderToken);
  const storedIsEmbedded = storedTokens.has("embedded");
  const candidateIsEmbedded = candidateTokens.has("embedded");
  return storedIsDiscovery !== candidateIsDiscovery || storedIsEmbedded !== candidateIsEmbedded;
}

function isAuthoritativeActionIdentity(identityKey: string): boolean {
  if (identityKey.startsWith("url:")) return !isGenericListingUrl(identityKey.slice("url:".length));
  return identityKey.startsWith("provider-job:")
    || identityKey.startsWith("embedded-job:")
    || identityKey.startsWith("job:");
}

/**
 * Identity aliases used for user decisions. These deliberately span source
 * URLs: a role found on a company page, an ATS, or an aggregator should share
 * a decision when the job identity is otherwise the same.
 */
export function internshipListingActionIdentities(internship: Internship): ListingActionIdentity[] {
  const company = normalizeCompanyIdentity(internship.company);
  const title = normalizeRoleIdentity(internship.title);
  const location = internshipLocationIdentity(internship);
  const directJobIds = actionDirectJobIds(internship);
  const identities: ListingActionIdentity[] = [
    { identityKey: `role:${company}|${title}|${location}`, directJobIds },
    ...actionUrlIdentities([internship.applicationUrl, internship.postingUrl], directJobIds),
    ...internshipLocationKeys(internship).map((key) => ({
      identityKey: `role-location:${company}|${title}|${key}`,
      directJobIds,
    })),
    ...internshipCityLocationKeys(internship).map((key) => ({
      identityKey: `role-city:${company}|${title}|${key}`,
      directJobIds,
    })),
    ...uniqueStrings(internship.location.map(normalizeIdentity)).map((key) => ({
      identityKey: `role-location-raw:${company}|${title}|${key}`,
      directJobIds,
    })),
    ...uniqueStrings([
      ...providerJobIdentityKeys(internship),
      ...actionProviderJobIdentityKeys(internship),
    ]).map((key) => ({ identityKey: key, directJobIds })),
  ];
  if (!location) identities.push({ identityKey: `role-title:${company}|${title}|`, directJobIds });
  if (internship.jobId && /\d/.test(internship.jobId)) {
    for (const jobId of actionJobIdAliases([internship.jobId.toLocaleLowerCase()])) {
      identities.push({ identityKey: `job:${company}|${jobId}`, directJobIds });
    }
  }
  return uniqueActionIdentities(identities);
}

/** Best-effort aliases for a listing that is not stored as a full internship. */
export function basicListingActionIdentities(
  listingType: ListingType,
  listingId: string,
  company: string,
  title: string,
  context: ListingActionContext = {},
): ListingActionIdentity[] {
  const normalizedCompany = normalizeCompanyIdentity(company);
  const normalizedTitle = normalizeRoleIdentity(title);
  const directJobIds = contextJobIds(context);
  const contextLocation = normalizeIdentity(context.location ?? "");
  const parsedLocation = context.location ? parseLocation(context.location) : null;
  const contextCity = parsedLocation?.country && parsedLocation.city
    ? [parsedLocation.country, parsedLocation.city, parsedLocation.remote ? parsedLocation.remoteScope ?? "remote" : "onsite"]
      .map((value) => normalizeIdentity(value))
      .join("|")
    : null;
  const contextRoleLocation = parsedLocation && (parsedLocation.country || parsedLocation.provinceState || parsedLocation.city)
    ? [parsedLocation.country, parsedLocation.provinceState, parsedLocation.city, parsedLocation.remote ? parsedLocation.remoteScope ?? "remote" : "onsite"]
      .map((value) => normalizeIdentity(value ?? ""))
      .join("|")
    : contextLocation;
  return uniqueActionIdentities([
    ...(contextRoleLocation
      ? [{ identityKey: `role:${normalizedCompany}|${normalizedTitle}|${contextRoleLocation}`, directJobIds }]
      : []),
    ...(contextLocation
      ? [{ identityKey: `role-location-raw:${normalizedCompany}|${normalizedTitle}|${contextLocation}`, directJobIds }]
      : [{ identityKey: `role-title:${normalizedCompany}|${normalizedTitle}|`, directJobIds }]),
    ...(contextCity ? [{ identityKey: `role-city:${normalizedCompany}|${normalizedTitle}|${contextCity}`, directJobIds }] : []),
    ...contextUrlIdentities(context, directJobIds),
    { identityKey: `listing:${listingType}:${listingId}`, directJobIds: [] },
  ]);
}

export function actionIdentitiesForListing(
  listingType: ListingType,
  listingId: string,
  company: string,
  title: string,
  internship?: Internship | null,
  context: ListingActionContext = {},
): ListingActionIdentity[] {
  const fullIdentities = listingType === "internship" && internship
    ? internshipListingActionIdentities(internship)
    : [];
  const contextIdentities = listingType !== "internship" || !internship || hasActionContext(context)
    ? basicListingActionIdentities(listingType, listingId, company, title, context)
    : [];
  return uniqueActionIdentities([...fullIdentities, ...contextIdentities]);
}

export function listingActionIdentityMatches(
  internship: Internship,
  storedIdentities: StoredListingActionIdentity[],
): boolean {
  const candidateIdentities = internshipListingActionIdentities(internship);
  const candidateByKey = new Map(candidateIdentities.map((identity) => [identity.identityKey, identity]));
  const candidateTokens = providerTokens(candidateIdentities);
  const storedByListingKey = new Map<string, StoredListingActionIdentity[]>();
  for (const stored of storedIdentities) {
    const group = storedByListingKey.get(stored.listingKey) ?? [];
    group.push(stored);
    storedByListingKey.set(stored.listingKey, group);
  }
  for (const identities of storedByListingKey.values()) {
    const storedTokens = providerTokens(identities);
    for (const stored of identities) {
      const candidate = candidateByKey.get(stored.identityKey);
      if (!candidate) continue;
      // An exact listing URL, provider requisition ID, or explicit job ID is
      // stronger evidence than a parser's inferred direct-ID aliases. A
      // source can label the same posting with a different extractor ID while
      // still pointing at the same URL/ID identity.
      if (isAuthoritativeActionIdentity(stored.identityKey)) return true;
      const storedIds = new Set(stored.directJobIds);
      const candidateIds = new Set(candidate.directJobIds);
      if (storedIds.size > 0 && candidateIds.size > 0 && ![...storedIds].some((id) => candidateIds.has(id))) {
        if (!isCrossSurfaceRoleAlias(stored.identityKey, storedIds, candidateIds, storedTokens, candidateTokens)) continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Compile persisted decision identities into a lookup matcher.
 *
 * The legacy dashboard called `listingActionIdentityMatches` once for every
 * role while rebuilding a snapshot. That function intentionally accepts a
 * flat list and is useful for one-off checks, but it also rebuilds maps over
 * every action on every role. The server read path uses this compiled form so
 * each candidate identity only probes the matching identity bucket.
 */
export interface ListingActionMatcher {
  matches(internship: Internship): boolean;
}

export function compileListingActionMatcher(
  storedIdentities: readonly StoredListingActionIdentity[],
): ListingActionMatcher {
  const identitiesByKey = new Map<string, StoredListingActionIdentity[]>();
  const identitiesByListing = new Map<string, StoredListingActionIdentity[]>();
  for (const stored of storedIdentities) {
    const byKey = identitiesByKey.get(stored.identityKey) ?? [];
    byKey.push(stored);
    identitiesByKey.set(stored.identityKey, byKey);

    const byListing = identitiesByListing.get(stored.listingKey) ?? [];
    byListing.push(stored);
    identitiesByListing.set(stored.listingKey, byListing);
  }
  const tokensByListing = new Map<string, Set<string>>();
  for (const [listingKey, identities] of identitiesByListing) {
    tokensByListing.set(listingKey, providerTokens(identities));
  }

  return {
    matches(internship: Internship): boolean {
      const candidateIdentities = internshipListingActionIdentities(internship);
      const candidateByKey = new Map(candidateIdentities.map((identity) => [identity.identityKey, identity]));
      const candidateTokens = providerTokens(candidateIdentities);
      for (const candidate of candidateIdentities) {
        const matches = identitiesByKey.get(candidate.identityKey);
        if (!matches) continue;
        for (const stored of matches) {
          if (isAuthoritativeActionIdentity(stored.identityKey)) return true;
          const storedIds = new Set(stored.directJobIds);
          const candidateMatch = candidateByKey.get(stored.identityKey);
          if (!candidateMatch) continue;
          const candidateIds = new Set(candidateMatch.directJobIds);
          if (storedIds.size > 0 && candidateIds.size > 0 && ![...storedIds].some((id) => candidateIds.has(id))) {
            const storedTokens = tokensByListing.get(stored.listingKey) ?? new Set<string>();
            if (!isCrossSurfaceRoleAlias(stored.identityKey, storedIds, candidateIds, storedTokens, candidateTokens)) continue;
          }
          return true;
        }
      }
      return false;
    },
  };
}

/** Read the durable identity projection without reparsing every action's
 * internship payload. The dashboard detail path uses this narrow projection;
 * the full matcher path below still rebuilds legacy aliases when necessary. */
export function readPersistedListingActionIdentities(database: DatabaseSync): StoredListingActionIdentity[] {
  const rows = database.prepare(`
    SELECT listing_key, identity_key, direct_job_ids_json
    FROM listing_action_identities
  `).all() as unknown as ListingActionIdentityRow[];
  const storedIdentities = rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.direct_job_ids_json) as unknown;
      const directJobIds = Array.isArray(parsed)
        ? actionJobIdAliases(parsed.filter((value): value is string => typeof value === "string"))
        : [];
      return [{ listingKey: row.listing_key, identityKey: row.identity_key, directJobIds }];
    } catch {
      return [];
    }
  });
  return storedIdentities;
}

export function readListingActionIdentities(database: DatabaseSync): StoredListingActionIdentity[] {
  const storedIdentities = readPersistedListingActionIdentities(database);
  // Rebuild every action's identities in memory as well as reading the
  // persisted aliases. The context columns are the durable fallback when a
  // listing row was merged, removed, or an older write stopped before its
  // alias rows were created.
  const actionRows = database.prepare(`
    SELECT a.listing_key, a.listing_type, a.listing_id, a.company, a.title,
           a.application_url, a.posting_url, a.job_id, a.location, i.payload_json
    FROM listing_actions a
    LEFT JOIN internships i ON i.id = a.listing_id
  `).all() as unknown as Array<{
    listing_key: string;
    listing_type: ListingType;
    listing_id: string;
    company: string;
    title: string;
    payload_json: string | null;
  } & ListingActionContextRow>;
  const rebuiltIdentities = actionRows.flatMap((row) => {
    let internship: Internship | null = null;
    try {
      if (row.payload_json) internship = InternshipSchema.parse(JSON.parse(row.payload_json));
    } catch {
      internship = null;
    }
    return actionIdentitiesForListing(
      row.listing_type,
      row.listing_id,
      row.company,
      row.title,
      internship,
      contextFromRow(row),
    ).map((identity) => ({ listingKey: row.listing_key, ...identity }));
  });
  const seen = new Set<string>();
  return [...rebuiltIdentities, ...storedIdentities].filter((identity) => {
    const key = `${identity.listingKey}\u0000${identity.identityKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readListingActionKeys(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT listing_key FROM listing_actions").all() as unknown as Array<{ listing_key: string }>;
  return new Set(rows.map((row) => row.listing_key));
}

export function replaceListingActionIdentities(
  database: DatabaseSync,
  listingKey: string,
  listingType: ListingType,
  listingId: string,
  company: string,
  title: string,
  internship?: Internship | null,
  context: ListingActionContext = {},
): void {
  database.prepare("DELETE FROM listing_action_identities WHERE listing_key = @listingKey").run({ listingKey });
  const insert = database.prepare(`
    INSERT INTO listing_action_identities (listing_key, identity_key, direct_job_ids_json)
    VALUES (@listingKey, @identityKey, @directJobIds)
  `);
  for (const identity of actionIdentitiesForListing(listingType, listingId, company, title, internship, context)) {
    insert.run({
      listingKey,
      identityKey: identity.identityKey,
      directJobIds: JSON.stringify(identity.directJobIds),
    });
  }
}

/** Backfill aliases for decisions made before source-independent identities existed. */
export function backfillListingActionIdentities(database: DatabaseSync): void {
  const actions = database.prepare(`
    SELECT listing_key, listing_type, listing_id, company, title,
           application_url, posting_url, job_id, location
    FROM listing_actions
  `).all() as unknown as Array<{
    listing_key: string;
    listing_type: ListingType;
    listing_id: string;
    company: string;
    title: string;
  } & ListingActionContextRow>;
  const internshipRows = database.prepare("SELECT id, payload_json FROM internships").all() as unknown as Array<{ id: string; payload_json: string }>;
  const internships = new Map<string, Internship>();
  for (const row of internshipRows) {
    try {
      internships.set(row.id, InternshipSchema.parse(JSON.parse(row.payload_json)));
    } catch {
      // Keep the best-effort fallback based on the action's stored company/title.
    }
  }
  for (const action of actions) {
    const internship = internships.get(action.listing_id);
    const context = mergeListingActionContext(contextFromRow(action), internship);
    database.prepare(`
      UPDATE listing_actions
      SET application_url = COALESCE(application_url, @applicationUrl),
          posting_url = COALESCE(posting_url, @postingUrl),
          job_id = COALESCE(job_id, @jobId),
          location = COALESCE(location, @location)
      WHERE listing_key = @listingKey
    `).run({
      listingKey: action.listing_key,
      applicationUrl: context.applicationUrl ?? null,
      postingUrl: context.postingUrl ?? null,
      jobId: context.jobId ?? null,
      location: context.location ?? null,
    });
    replaceListingActionIdentities(
      database,
      action.listing_key,
      action.listing_type,
      action.listing_id,
      action.company,
      action.title,
      internship,
      context,
    );
  }
}

/** Create the action tables and add context columns to legacy databases. */
export function ensureListingActionSchema(database: DatabaseSync): void {
  database.exec(LISTING_ACTIONS_SCHEMA);
  const columns = database.prepare("PRAGMA table_info(listing_actions)").all() as unknown as Array<{ name: string }>;
  const migrations = [
    ["application_status", "TEXT NOT NULL DEFAULT 'pending' CHECK (application_status IN ('pending', 'accepted', 'rejected'))"],
    ["application_stage", `TEXT NOT NULL DEFAULT 'applied' CHECK (application_stage IN (${APPLICATION_STAGES.map((stage) => `'${stage}'`).join(", ")}))`],
    ["application_url", "TEXT"],
    ["posting_url", "TEXT"],
    ["job_id", "TEXT"],
    ["location", "TEXT"],
  ] as const;
  for (const [name, definition] of migrations) {
    if (!columns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE listing_actions ADD COLUMN ${name} ${definition}`);
    }
  }
  if (!columns.some((column) => column.name === "application_stage")) {
    database.exec(`
      UPDATE listing_actions
      SET application_stage = CASE application_status
        WHEN 'accepted' THEN 'offer'
        WHEN 'rejected' THEN 'rejected'
        ELSE 'applied'
      END
      WHERE application_stage = 'applied'
    `);
  }
}

export const LISTING_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS listing_actions (
  listing_key TEXT PRIMARY KEY,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('internship', 'grind')),
  listing_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('applied', 'cant_fit')),
  application_status TEXT NOT NULL DEFAULT 'pending' CHECK (application_status IN ('pending', 'accepted', 'rejected')),
  application_stage TEXT NOT NULL DEFAULT 'applied' CHECK (application_stage IN ('applied', 'oa', 'recruiter', 'interview', 'final', 'offer', 'rejected')),
  company TEXT NOT NULL,
  normalized_company TEXT NOT NULL,
  title TEXT NOT NULL,
  application_url TEXT,
  posting_url TEXT,
  job_id TEXT,
  location TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(listing_type, listing_id)
);

CREATE INDEX IF NOT EXISTS listing_actions_company_idx ON listing_actions(normalized_company, action);

CREATE TABLE IF NOT EXISTS listing_action_identities (
  listing_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  direct_job_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (listing_key, identity_key)
);

CREATE INDEX IF NOT EXISTS listing_action_identities_key_idx ON listing_action_identities(identity_key);
`;
