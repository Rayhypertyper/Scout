import { load, type CheerioAPI } from "cheerio";

import type { PageSnapshot } from "../domain/types.js";
import { extractJobSections } from "../parsing/qualifications.js";
import { oneLine, uniqueStrings } from "../utils/text.js";
import { safeCanonicalizeUrl } from "../utils/url.js";

export function page$(snapshot: PageSnapshot): CheerioAPI {
  return load(snapshot.html);
}

export function firstText($: CheerioAPI, selectors: string[]): string {
  for (const selector of selectors) {
    const value = oneLine($(selector).first().text());
    if (value) return value;
  }
  return "";
}

export function texts($: CheerioAPI, selectors: string[]): string[] {
  const values: string[] = [];
  for (const selector of selectors) {
    $(selector).each((_index, element) => {
      const value = oneLine($(element).text());
      if (value) values.push(value);
    });
  }
  return uniqueStrings(values);
}

export function cleanContentText($: CheerioAPI, selectors: string[]): string {
  for (const selector of selectors) {
    const element = $(selector).first().clone();
    if (element.length === 0) continue;
    element.find("script,style,noscript,nav,footer,header,form,[aria-hidden='true'],.cookie,.cookies,.navigation").remove();
    element.find("br").replaceWith("\n");
    element.find("li").each((_index, listItem) => {
      $(listItem).prepend("\n• ").append("\n");
    });
    element.find("p,h1,h2,h3,h4,h5,[role='heading']").each((_index, block) => {
      $(block).prepend("\n").append("\n");
    });
    const value = element.text().replace(/\s*\n\s*/g, "\n").replace(/[ \t]+/g, " ").trim();
    if (value.length >= 80) return value;
  }
  return "";
}

export function findApplyUrl($: CheerioAPI, baseUrl: string): string | undefined {
  const selectors = [
    "a:contains('Apply Now')",
    "a:contains('Apply now')",
    "a:contains('Apply for this job')",
    "a:contains('Apply for this position')",
    "a[data-automation-id*='apply']",
    "a[data-testid*='apply']",
    "a.apply-button",
    "a[href*='/apply']",
  ];
  for (const selector of selectors) {
    const href = $(selector).first().attr("href");
    if (!href) continue;
    const normalized = safeCanonicalizeUrl(href, baseUrl);
    if (normalized) return normalized;
  }
  let fallback: string | undefined;
  $("a[href]").each((_index, element) => {
    if (fallback) return;
    const parent = $(element).parent();
    const label = [
      $(element).text(),
      $(element).attr("aria-label") ?? "",
      $(element).attr("data-automation-id") ?? "",
      parent.children("a").length === 1 ? parent.text() : "",
    ].join(" ");
    if (!/\bapply(?: now| for this (?:job|position))?\b/i.test(label)) return;
    const href = $(element).attr("href");
    const normalized = href ? safeCanonicalizeUrl(href, baseUrl) : null;
    if (normalized) fallback = normalized;
  });
  if (fallback) return fallback;
  return undefined;
}

export function sectionsFromText(text: string): Pick<ReturnType<typeof extractJobSections>, "responsibilities" | "requiredQualifications" | "preferredQualifications"> {
  return extractJobSections(text);
}

export function companyFromUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, "");
  if (/greenhouse\.io$/i.test(host) || /lever\.co$/i.test(host) || /ashbyhq\.com$/i.test(host)) {
    const slug = url.pathname.split("/").filter(Boolean)[0];
    if (slug) return companyAlias(titleCase(slug));
  }
  if (/myworkdayjobs\.com$/i.test(host)) {
    const tenant = host.split(".")[0];
    if (tenant && !/^wd\d+$/i.test(tenant) && tenant !== "myworkdayjobs") return companyAlias(titleCase(tenant));
  }
  const pieces = host.split(".");
  const label = pieces.length >= 2 ? pieces[pieces.length - 2] : pieces[0];
  return companyAlias(titleCase(label ?? host));
}

function companyAlias(value: string): string {
  const token = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliases: Record<string, string> = {
    axontalentcommunity: "Axon",
    caicambiumassessmentinc: "Cambium Assessment",
    cambiumassessment: "Cambium Assessment",
    geocomply2: "GeoComply",
    globalhr: "RTX",
    joinbytedance: "ByteDance",
    ibmsoftware: "IBM",
    object: "Object Tech, Inc.",
    objecttechinc: "Object Tech, Inc.",
    wd: "Western Digital",
  };
  // These tokens come from third-party page content. Never read an inherited
  // property from the alias table: a legitimate company such as
  // "Constructor" would otherwise resolve to Object.prototype.constructor and
  // leak a function into the string-only normalization pipeline.
  return Object.prototype.hasOwnProperty.call(aliases, token) ? aliases[token] ?? value : value;
}

export function companyFromPostingUrl(value: string): string | undefined {
  const url = new URL(value);
  if (!/(?:^|\.)applybolt\.app$/i.test(url.hostname)) return undefined;
  const slug = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const marker = slug.lastIndexOf("-m-");
  const companyMarker = marker > 0 ? slug.lastIndexOf("-at-", marker) : -1;
  if (companyMarker < 0 || marker <= companyMarker + 4) return undefined;
  return titleCase(slug.slice(companyMarker + 4, marker));
}

export function companyFromEvidence(candidate: string | undefined, description: string, fallback: string): string {
  const decoded = load(candidate ?? "").root().text();
  const cleaned = decoded
    .replace(/^(?:(?:\d+[A-Z]*|[A-Z]{1,5}\d{1,6}|MED|MCD|PLREC|SOTICAN)\s+|Company\s+\d+\s*[-–—]\s*)/, "")
    .replace(/\s*[|–—-]\s*(?:external )?(?:careers?|jobs?).*$/i, "")
    .replace(/\s+(?:external )?(?:careers?|jobs?|company logo)$/i, "")
    .replace(/\s+(?:talent community|external students)$/i, "")
    .replace(/\s+internships?$/i, "")
    .replace(/\s+logo$/i, "")
    .replace(/\s+\d+$/, "")
    .trim();
  const atCompany = /\bAt ([A-Z][A-Za-z0-9&.'-]*(?: [A-Z][A-Za-z0-9&.'-]*){0,3}), (?:we|our|the)\b/.exec(description)?.[1];
  const seekingCompany = /\b([A-Z][A-Za-z0-9&.'-]*(?: [A-Z][A-Za-z0-9&.'-]*){0,4}) is seeking\b/.exec(description)?.[1];
  const overviewCompany = /\b(?:Firm|Company) Overview:\s*([A-Z][^\n:]{1,70}?)\s+(?:is|are)\b/.exec(description)?.[1];
  const aboutCompany = /(?:^|\b)About ([A-Z][A-Za-z0-9&.'’-]*(?: [A-Z][A-Za-z0-9&.'’-]*){0,3}?)(?=\s+(?:We|Through|is|are|builds?|provides?|creates?)\b)/.exec(description)?.[1];
  const careerCompany = /^A Career at ([A-Z][A-Z0-9&.'-]{1,30})\b/.exec(description)?.[1];
  const todayCompany = /^Today, ([A-Z][A-Za-z0-9&.'-]{1,30})\s+is\b/.exec(description)?.[1];
  const leadingAtCompany = /^At ([A-Z][A-Z0-9&.'-]{1,20}),/.exec(description)?.[1];
  const labCompany = /\bwith the ([A-Z]{2,12}) Security Lab\b/.exec(description)?.[1];
  const enablesCompany = /\b([A-Z]{2,12}) enables\b/.exec(description)?.[1];
  const missionCompany = /\b([A-Z][A-Za-z0-9&.'-]{1,30})[’']s mission\b/.exec(description)?.[1];
  const engineerAtCompany = /\b(?:Engineer|Developer|internship) at ([A-Z]{2,12})\b/.exec(description)?.[1];
  const openingCompany = /^([A-Z][^\n:]{1,75}?)\s+(?:is|are|[–—-]\s+(?:a|an|the))\b/.exec(description)?.[1];
  const plausibleOpening = openingCompany
    && !/^(?:about|at|a career|join|our|today|this|the (?:role|position|job)|position|job|we|who|what|location|software)\b/i.test(openingCompany)
    && !/\b(?:intern(?:ship)?|description|responsibilities|qualifications|opportunit(?:y|ies))\b/i.test(openingCompany)
    ? openingCompany
    : undefined;
  const inferred = [
    atCompany,
    seekingCompany,
    overviewCompany,
    aboutCompany,
    careerCompany,
    todayCompany,
    leadingAtCompany,
    labCompany,
    enablesCompany,
    missionCompany,
    engineerAtCompany,
    plausibleOpening,
  ]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)[0];
  const evidenceAlias = /^burnsville minnesota$/i.test(cleaned) && /\bRTX\b/.test(description)
    ? "RTX"
    : /^us$/i.test(cleaned) && /\bDV Trading\b/i.test(description)
      ? "DV Trading"
    : /^talentmanagementsolution$/i.test(cleaned) && /\bPerseus(?: Group)?\b/i.test(description)
      ? "Perseus Group"
      : /^(?:axon)?talentcommunity$/i.test(cleaned) && /\bAxon(?:’s|'s| Company)?\b/i.test(description)
        ? "Axon"
        : /^dice$/i.test(cleaned) && /\bMicrosoft\b/i.test(description)
          ? "Microsoft"
          : /^dice$/i.test(cleaned) && /\bTikTok\b/i.test(description)
            ? "TikTok"
            : /^raymarine$/i.test(cleaned) && /\bTeledyne Brown Engineering\b/i.test(description)
              ? "Teledyne Brown Engineering"
        : undefined;
  const generic = /^(?:us|workday|careers?|jobs?|global\s*hr|company logo|applybolt|jobright|hiringcafe|simplify|interninsider|dice|talentmanagementsolution|lighting|burnsville minnesota|(?:axon)?talentcommunity|our formula for success|our \d+[ -]week internship|join our(?: team)?|about .+|a career at .+|today, .+|at [A-Z]{2,12},.+|[A-Z0-9]{2,16}\s+.*\([+-]\).*|.*\b(?:intern|description)\b.*)$/i.test(cleaned);
  const boardBrand = /\b(?:campus|talent community|external students|job board)\b/i.test(cleaned);
  const acronymBrand = /^[A-Z0-9&.]{2,8}$/.test(cleaned) && Boolean(inferred && inferred.length > cleaned.length);
  const result = evidenceAlias ?? (!cleaned || generic
    ? inferred ?? companyAlias(fallback)
    : boardBrand || acronymBrand
      ? inferred ?? cleaned
      : cleaned);
  return companyAlias(result
    .replace(/^At\s+/i, "")
    .replace(/\s+\([A-Z0-9&. -]{2,12}\)$/i, "")
    .replace(/^Netapp$/i, "NetApp")
    .replace(/^Geocomply$/i, "GeoComply")
    .trim());
}

export function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase())
    .replace(/\b(?:Ibm|Imc|Ctc|Pdt|Rtx|Nvidia|Cae|Iko|Hpe|Hp|Dv|Ai|Ml)\b/g, (word) => word.toLocaleUpperCase())
    .trim();
}

export function htmlFragmentToText(html: string): string {
  const $ = load(html);
  $("br").replaceWith("\n");
  $("li").each((_index, element) => {
    $(element).prepend("\n• ").append("\n");
  });
  $("p,h1,h2,h3,h4").each((_index, element) => {
    $(element).append("\n");
  });
  return $.root().text().replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
