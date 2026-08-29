import { load, type CheerioAPI } from "cheerio";
import { isTag, type Element } from "domhandler";

import { parseLocations } from "../parsing/locations.js";
import { sha256 } from "../utils/hash.js";
import { safeCanonicalizeUrl } from "../utils/url.js";

export const USENO_SUMMER_2027_URL = "https://www.useno.app/summer-2027-internships";
export const USENO_INTERNSHIP_MASTERLIST_URL = "https://www.useno.app/internship-masterlist";
export const USENO_MASTERLIST_PARSER_VERSION = "useno-internship-masterlist-v1";

const USENO_MASTERLIST_CATEGORY_IDS = ["software", "data"] as const;
type UsenoMasterlistCategoryId = typeof USENO_MASTERLIST_CATEGORY_IDS[number];

const USENO_MASTERLIST_CATEGORY_NAMES: Record<UsenoMasterlistCategoryId, string> = {
  software: "Software Engineering & Technology",
  data: "Data, AI & Analytics",
};

export interface UsenoLocationOption {
  value: string;
  label: string;
}

export interface UsenoInternshipListing {
  id: string;
  categoryOrder: number;
  rowOrder: number;
  categoryId: string;
  category: string;
  company: string;
  title: string;
  location: string;
  added: string;
  addedLabel: string;
  applicationUrl: string;
  region: string;
  searchText: string;
}

export interface UsenoInternshipCategory {
  id: string;
  order: number;
  name: string;
  declaredCount: number | null;
  count: number;
  internships: UsenoInternshipListing[];
}

export interface UsenoSummer2027Page {
  pageTitle: string;
  sourceUrl: string;
  heading: string;
  description: string;
  trackedCount: number;
  lastUpdated: string | null;
  locationOptions: UsenoLocationOption[];
  categories: UsenoInternshipCategory[];
  totalRecords: number;
  retrievedAt: string;
  parserVersion: string;
  bodySha256: string;
}

export interface UsenoMasterlistListing {
  id: string;
  rowOrder: number;
  categoryId: UsenoMasterlistCategoryId;
  category: string;
  company: string;
  title: string;
  location: string;
  workModel: string;
  applicationUrl: string;
  postedAt: string;
  type: string;
  country: string;
  region: string;
  isSummer2027: boolean;
  earlyCareer: boolean;
}

export interface UsenoMasterlistCategorySummary {
  id: UsenoMasterlistCategoryId;
  name: string;
  /** Retained for artifact compatibility; every complete row is counted. */
  defaultVisibleCount: number;
  eligibleCount: number;
}

export interface UsenoInternshipMasterlistPage {
  pageTitle: string;
  sourceUrl: string;
  heading: string;
  selectedCategories: UsenoMasterlistCategorySummary[];
  defaultVisibleCount: number;
  skippedLocationCount: number;
  skippedIncompleteCount: number;
  listings: UsenoMasterlistListing[];
  totalRecords: number;
  retrievedAt: string;
  parserVersion: string;
  bodySha256: string;
}

export const USENO_PARSER_VERSION = "useno-summer-2027-v1";

function text($: CheerioAPI, element: Element | undefined): string {
  return element ? $(element).text().replace(/\s+/gu, " ").trim() : "";
}

function parseCount(value: string): number | null {
  const match = value.match(/\d[\d,]*/u);
  if (!match) return null;
  const count = Number(match[0].replaceAll(",", ""));
  return Number.isSafeInteger(count) ? count : null;
}

function elementTexts($: CheerioAPI, selector: string): string[] {
  return $(selector).toArray().filter(isTag).map((element) => text($, element)).filter(Boolean);
}

function lastUpdatedFromPage($: CheerioAPI): string | null {
  const value = elementTexts($, "main *").find((candidate) => /^Last updated\b/iu.test(candidate));
  if (!value) return null;
  return value.replace(/^Last updated\s*/iu, "").trim() || null;
}

function applicationUrl($: CheerioAPI, row: Element, sourceUrl: string): string {
  const href = $(row).find("a.row-apply").first().attr("href")?.trim() ?? "";
  return href ? (safeCanonicalizeUrl(href, sourceUrl) ?? href) : "";
}

function rowListing($: CheerioAPI, row: Element, categoryId: string, category: string, categoryOrder: number, index: number, sourceUrl: string): UsenoInternshipListing {
  const meta = $(row).find(".row-meta > span").toArray().map((element) => text($, element));
  const addedLabel = meta.find((value) => /^Added\b/iu.test(value)) ?? "";
  return {
    id: `${categoryId}-${index + 1}`,
    categoryOrder,
    rowOrder: index + 1,
    categoryId,
    category,
    company: text($, $(row).find(".row-company").get(0)),
    title: text($, $(row).find(".row-title").get(0)),
    location: meta[0] ?? "",
    added: addedLabel.replace(/^Added\s+/iu, ""),
    addedLabel,
    applicationUrl: applicationUrl($, row, sourceUrl),
    region: $(row).attr("data-region")?.trim() ?? "",
    searchText: $(row).attr("data-search")?.trim() ?? "",
  };
}

export function isUsenoSummer2027Url(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.replace(/^www\./iu, "");
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return host === "useno.app" && path === "/summer-2027-internships";
  } catch {
    return false;
  }
}

export function isUsenoInternshipMasterlistUrl(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.replace(/^www\./iu, "");
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return host === "useno.app" && path === "/internship-masterlist";
  } catch {
    return false;
  }
}

/**
 * Parse the public Useno Summer 2027 listing page without following any
 * application links. The page is server-rendered, so one HTML response is
 * sufficient for a complete 402-row crawl as of the current page revision.
 */
export function extractUsenoSummer2027(
  html: string,
  sourceUrl = USENO_SUMMER_2027_URL,
  retrievedAt = new Date().toISOString(),
): UsenoSummer2027Page {
  const $ = load(html);
  const main = $("main").first();
  const liveCountText = text($, $("#live-count").get(0));
  const categories = $(".jsec").toArray().map((section, categoryIndex) => {
    const id = $(section).attr("id")?.trim() || `category-${categoryIndex + 1}`;
    const name = text($, $(section).find("h2").get(0));
    const declaredCount = parseCount(text($, $(section).find(".jsec-count").get(0)));
    const internships = $(section).find(".row").toArray().map((row, index) => rowListing($, row, id, name, categoryIndex + 1, index, sourceUrl));
    return { id, order: categoryIndex + 1, name, declaredCount, count: internships.length, internships };
  });
  const totalRecords = categories.reduce((total, category) => total + category.internships.length, 0);
  const trackedCount = parseCount(liveCountText) ?? totalRecords;
  const heading = text($, main.find("h1").get(0));
  const description = text($, main.find("h1").next("p").get(0));

  return {
    pageTitle: $("title").first().text().trim(),
    sourceUrl,
    heading,
    description,
    trackedCount,
    lastUpdated: lastUpdatedFromPage($),
    locationOptions: $("#location-filter option").toArray().map((option) => ({
      value: $(option).attr("value")?.trim() ?? "",
      label: text($, option),
    })),
    categories,
    totalRecords,
    retrievedAt,
    parserVersion: USENO_PARSER_VERSION,
    bodySha256: sha256(html),
  };
}

export function validateUsenoSummer2027(page: UsenoSummer2027Page): void {
  if (!isUsenoSummer2027Url(page.sourceUrl)) throw new Error(`Unexpected Useno source URL: ${page.sourceUrl}`);
  if (!page.heading) throw new Error("Useno page heading was not found.");
  if (page.totalRecords === 0) throw new Error("Useno page contained no internship rows.");
  if (page.trackedCount !== page.totalRecords) {
    throw new Error(`Useno count mismatch: page says ${page.trackedCount}, parser found ${page.totalRecords}.`);
  }
  const categoryTotal = page.categories.reduce((total, category) => total + category.count, 0);
  if (categoryTotal !== page.totalRecords) {
    throw new Error(`Useno category mismatch: categories total ${categoryTotal}, parser found ${page.totalRecords}.`);
  }
  const declaredCountMismatch = page.categories.find((category) => category.declaredCount !== null && category.declaredCount !== category.count);
  if (declaredCountMismatch) {
    throw new Error(`Useno category count mismatch for ${declaredCountMismatch.name}: page says ${declaredCountMismatch.declaredCount}, parser found ${declaredCountMismatch.count}.`);
  }
  const missingFields = page.categories.flatMap((category) => category.internships.filter((internship) => (
    !internship.company || !internship.title || !internship.location || !internship.applicationUrl
  )));
  if (missingFields.length > 0) throw new Error(`Useno page contained ${missingFields.length} incomplete internship row(s).`);
}

interface UsenoMasterlistPayload {
  roles?: unknown;
  sections?: unknown;
}

function payloadString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}

function payloadBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function allowedCountryCode(value: string): boolean {
  return /^(?:ca|can|canada|us|usa|u\.?s\.?|united states)$/iu.test(value.trim());
}

function hasAllowedMasterlistLocation(location: string, region: string, country: string): boolean {
  if (country && allowedCountryCode(country)) return true;
  const parsed = parseLocations([location, region].filter(Boolean));
  return parsed.normalized.some(({ country: normalizedCountry }) => (
    normalizedCountry === "Canada" || normalizedCountry === "United States"
  ));
}

function masterlistRoleListing(
  row: unknown[],
  rowOrder: number,
  category: UsenoMasterlistCategoryId,
  categoryName: string,
  sourceUrl: string,
): UsenoMasterlistListing | null {
  const title = payloadString(row[0]);
  const company = payloadString(row[1]);
  const location = payloadString(row[2]);
  const workModel = payloadString(row[3]);
  const applicationValue = payloadString(row[4]);
  const applicationUrl = safeCanonicalizeUrl(applicationValue, sourceUrl);
  const country = payloadString(row[7]);
  const region = payloadString(row[8]);
  if (!title || !company || !location || !applicationUrl) return null;
  if (!hasAllowedMasterlistLocation(location, region, country)) return null;
  const isSummer2027 = payloadBoolean(row[10]);
  const earlyCareer = payloadBoolean(row[11]);
  return {
    id: `useno-${sha256(`${company}|${title}|${location}|${applicationUrl}`).slice(0, 24)}`,
    rowOrder,
    categoryId: category,
    category: categoryName,
    company,
    title,
    location,
    workModel,
    applicationUrl,
    postedAt: payloadString(row[5]),
    type: payloadString(row[6]),
    country,
    region,
    isSummer2027,
    earlyCareer,
  };
}

/**
 * Parse the public masterlist payload behind the Software Engineering &
 * Technology and Data, AI & Analytics tabs. The page ships all rows in one
 * JSON script; the default UI hides early-career rows, so the same default is
 * applied here before the requested category and location filters.
 */
export function extractUsenoInternshipMasterlist(
  html: string,
  sourceUrl = USENO_INTERNSHIP_MASTERLIST_URL,
  retrievedAt = new Date().toISOString(),
): UsenoInternshipMasterlistPage {
  const $ = load(html);
  const payloadText = $("script#ml-data").first().text().trim();
  if (!payloadText) throw new Error("Useno masterlist data payload was not found.");
  let payload: UsenoMasterlistPayload;
  try {
    payload = JSON.parse(payloadText) as UsenoMasterlistPayload;
  } catch (error) {
    throw new Error(`Useno masterlist data payload was invalid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`, { cause: error });
  }
  if (!Array.isArray(payload.roles)) throw new Error("Useno masterlist roles payload was not an array.");

  const sectionNames = new Map<UsenoMasterlistCategoryId, string>();
  if (Array.isArray(payload.sections)) {
    for (const section of payload.sections) {
      if (!section || typeof section !== "object") continue;
      const record = section as Record<string, unknown>;
      const id = payloadString(record.id);
      if (!id) continue;
      if (!USENO_MASTERLIST_CATEGORY_IDS.includes(id as UsenoMasterlistCategoryId)) continue;
      sectionNames.set(id as UsenoMasterlistCategoryId, payloadString(record.title) || USENO_MASTERLIST_CATEGORY_NAMES[id as UsenoMasterlistCategoryId]);
    }
  }

  const summaries = new Map<UsenoMasterlistCategoryId, UsenoMasterlistCategorySummary>();
  for (const categoryId of USENO_MASTERLIST_CATEGORY_IDS) {
    summaries.set(categoryId, {
      id: categoryId,
      name: sectionNames.get(categoryId) ?? USENO_MASTERLIST_CATEGORY_NAMES[categoryId],
      defaultVisibleCount: 0,
      eligibleCount: 0,
    });
  }

  let defaultVisibleCount = 0;
  let skippedLocationCount = 0;
  let skippedIncompleteCount = 0;
  const listings: UsenoMasterlistListing[] = [];
  for (const [index, candidate] of payload.roles.entries()) {
    if (!Array.isArray(candidate)) continue;
    const category = payloadString(candidate[9]) as UsenoMasterlistCategoryId;
    if (!USENO_MASTERLIST_CATEGORY_IDS.includes(category)) continue;
    if (payloadBoolean(candidate[11])) continue;
    defaultVisibleCount += 1;
    const summary = summaries.get(category);
    if (summary) summary.defaultVisibleCount += 1;

    const title = payloadString(candidate[0]);
    const company = payloadString(candidate[1]);
    const location = payloadString(candidate[2]);
    const applicationValue = payloadString(candidate[4]);
    const country = payloadString(candidate[7]);
    const region = payloadString(candidate[8]);
    if (!title || !company || !location || !safeCanonicalizeUrl(applicationValue, sourceUrl)) {
      skippedIncompleteCount += 1;
      continue;
    }
    if (!hasAllowedMasterlistLocation(location, region, country)) {
      skippedLocationCount += 1;
      continue;
    }
    const listing = masterlistRoleListing(
      candidate,
      index + 1,
      category,
      summary?.name ?? USENO_MASTERLIST_CATEGORY_NAMES[category],
      sourceUrl,
    );
    if (!listing) {
      skippedIncompleteCount += 1;
      continue;
    }
    listings.push(listing);
    if (summary) summary.eligibleCount += 1;
  }

  return {
    pageTitle: $("title").first().text().trim(),
    sourceUrl,
    heading: $("main h1").first().text().replace(/\s+/gu, " ").trim(),
    selectedCategories: USENO_MASTERLIST_CATEGORY_IDS.map((categoryId) => summaries.get(categoryId) as UsenoMasterlistCategorySummary),
    defaultVisibleCount,
    skippedLocationCount,
    skippedIncompleteCount,
    listings,
    totalRecords: listings.length,
    retrievedAt,
    parserVersion: USENO_MASTERLIST_PARSER_VERSION,
    bodySha256: sha256(html),
  };
}

export function validateUsenoInternshipMasterlist(page: UsenoInternshipMasterlistPage): void {
  if (!isUsenoInternshipMasterlistUrl(page.sourceUrl)) throw new Error(`Unexpected Useno masterlist source URL: ${page.sourceUrl}`);
  if (!page.heading) throw new Error("Useno masterlist page heading was not found.");
  if (page.selectedCategories.length !== USENO_MASTERLIST_CATEGORY_IDS.length) {
    throw new Error("Useno masterlist did not expose both requested category tabs.");
  }
  if (page.totalRecords === 0) throw new Error("Useno masterlist contained no eligible Canada/U.S. listings.");
  const missingFields = page.listings.filter((listing) => (
    !listing.company || !listing.title || !listing.location || !listing.applicationUrl
  ));
  if (missingFields.length > 0) throw new Error(`Useno masterlist contained ${missingFields.length} incomplete listing(s).`);
  const unexpectedCategory = page.listings.find((listing) => !USENO_MASTERLIST_CATEGORY_IDS.includes(listing.categoryId));
  if (unexpectedCategory) throw new Error(`Useno masterlist included an unrequested category: ${unexpectedCategory.categoryId}.`);
}
