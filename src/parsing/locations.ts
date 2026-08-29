import type { NormalizedLocation, RemoteStatus } from "../domain/schemas.js";
import { oneLine, stripDiacritics, uniqueStrings } from "../utils/text.js";

const CANADIAN_PROVINCES: Record<string, string> = {
  ab: "Alberta", alberta: "Alberta", bc: "British Columbia", "british columbia": "British Columbia",
  mb: "Manitoba", manitoba: "Manitoba", nb: "New Brunswick", "new brunswick": "New Brunswick",
  nl: "Newfoundland and Labrador", "newfoundland and labrador": "Newfoundland and Labrador",
  ns: "Nova Scotia", "nova scotia": "Nova Scotia", nt: "Northwest Territories", "northwest territories": "Northwest Territories",
  nu: "Nunavut", nunavut: "Nunavut", on: "Ontario", ontario: "Ontario", pe: "Prince Edward Island",
  "prince edward island": "Prince Edward Island", qc: "Quebec", quebec: "Quebec", québec: "Quebec",
  sk: "Saskatchewan", saskatchewan: "Saskatchewan", yt: "Yukon", yukon: "Yukon",
};

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado", ct: "Connecticut",
  de: "Delaware", fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois", in: "Indiana", ia: "Iowa",
  ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland", ma: "Massachusetts", mi: "Michigan",
  mn: "Minnesota", ms: "Mississippi", mo: "Missouri", mt: "Montana", ne: "Nebraska", nv: "Nevada", nh: "New Hampshire",
  nj: "New Jersey", nm: "New Mexico", ny: "New York", nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma",
  or: "Oregon", pa: "Pennsylvania", ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee",
  tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia", wi: "Wisconsin",
  wy: "Wyoming", dc: "District of Columbia",
};

for (const state of Object.values(US_STATES)) US_STATES[state.toLocaleLowerCase()] = state;

const CANADIAN_CITIES = new Set([
  "toronto", "waterloo", "ottawa", "montreal", "montréal", "vancouver", "calgary", "edmonton", "winnipeg",
  "halifax", "quebec city", "markham", "mississauga", "surrey", "burnaby", "richmond", "kanata", "victoria",
  "kelowna", "saskatoon",
]);
// These names are also common outside Canada. They require an explicit
// country or province before they can provide the country inference; a
// facility label such as "Richmond James Center" is not enough evidence.
const AMBIGUOUS_CANADIAN_CITIES = new Set(["richmond", "victoria"]);
const US_CITIES = new Set([
  "new york", "new york city", "san francisco", "san jose", "san diego", "seattle", "boston", "austin", "chicago",
  "los angeles", "washington", "washington dc", "palo alto", "mountain view", "santa clara", "denver", "dallas",
  "houston", "raleigh", "durham", "atlanta", "pittsburgh", "philadelphia", "minneapolis", "detroit", "portland",
  "salt lake city", "baltimore", "charlotte", "st. louis", "st louis", "irvine", "redmond", "menlo park",
  "redwood city", "cambridge", "bellevue", "arlington", "reston", "cary", "mclean", "lowell", "tewksbury", "falls church",
]);

/**
 * Preserve explicit non-target countries so a shared city or region name
 * cannot make a foreign posting look Canadian or American. For example,
 * Victoria is both a Canadian city and a region in Melbourne, Victoria,
 * Australia.
 */
const LOCATION_COUNTRY_ALIASES: readonly [string, string][] = [
  ["canada", "Canada"],
  ["canadian", "Canada"],
  ["united states", "United States"],
  ["usa", "United States"],
  ["australia", "Australia"],
  ["australian", "Australia"],
  ["austria", "Austria"],
  ["belgium", "Belgium"],
  ["brazil", "Brazil"],
  ["china", "China"],
  ["colombia", "Colombia"],
  ["czechia", "Czechia"],
  ["czech republic", "Czech Republic"],
  ["denmark", "Denmark"],
  ["egypt", "Egypt"],
  ["finland", "Finland"],
  ["france", "France"],
  ["germany", "Germany"],
  ["hong kong", "Hong Kong"],
  ["india", "India"],
  ["indonesia", "Indonesia"],
  ["ireland", "Ireland"],
  ["israel", "Israel"],
  ["italy", "Italy"],
  ["japan", "Japan"],
  ["malaysia", "Malaysia"],
  ["mexico", "Mexico"],
  ["netherlands", "Netherlands"],
  ["new zealand", "New Zealand"],
  ["norway", "Norway"],
  ["pakistan", "Pakistan"],
  ["philippines", "Philippines"],
  ["poland", "Poland"],
  ["portugal", "Portugal"],
  ["romania", "Romania"],
  ["singapore", "Singapore"],
  ["south africa", "South Africa"],
  ["south korea", "South Korea"],
  ["spain", "Spain"],
  ["sweden", "Sweden"],
  ["switzerland", "Switzerland"],
  ["taiwan", "Taiwan"],
  ["thailand", "Thailand"],
  ["turkey", "Turkey"],
  ["united kingdom", "United Kingdom"],
  ["uk", "United Kingdom"],
  ["vietnam", "Vietnam"],
  ["argentina", "Argentina"],
  ["greece", "Greece"],
  ["new south wales", "Australia"],
  ["queensland", "Australia"],
  ["south australia", "Australia"],
  ["western australia", "Australia"],
  ["australian capital territory", "Australia"],
];

const CITY_ALIASES = new Map<string, { city: string; country: "Canada" | "United States" }>();

function cityLabel(value: string): string {
  return value.split(/\s+/).map((part) => part ? `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}` : part).join(" ");
}

export interface SupportedCityOption {
  name: string;
  country: "Canada" | "United States";
  /** Province/state abbreviation used by preference option clients. */
  region: string;
}

const CITY_REGIONS: Record<string, string> = {
  toronto: "ON", waterloo: "ON", ottawa: "ON", montreal: "QC", vancouver: "BC", calgary: "AB",
  edmonton: "AB", winnipeg: "MB", halifax: "NS", "quebec city": "QC", markham: "ON", mississauga: "ON",
  surrey: "BC", burnaby: "BC", richmond: "BC", kanata: "ON", victoria: "BC", kelowna: "BC", saskatoon: "SK",
  "new york": "NY", "new york city": "NY", "san francisco": "CA", "san jose": "CA", "san diego": "CA",
  seattle: "WA", boston: "MA", austin: "TX", chicago: "IL", "los angeles": "CA", washington: "DC",
  "washington dc": "DC", "palo alto": "CA", "mountain view": "CA", "santa clara": "CA", denver: "CO",
  dallas: "TX", houston: "TX", raleigh: "NC", durham: "NC", atlanta: "GA", pittsburgh: "PA",
  philadelphia: "PA", minneapolis: "MN", detroit: "MI", portland: "OR", "salt lake city": "UT", baltimore: "MD",
  charlotte: "NC", "st louis": "MO", irvine: "CA", redmond: "WA", "menlo park": "CA", "redwood city": "CA",
  cambridge: "MA", bellevue: "WA", arlington: "VA", reston: "VA", cary: "NC", mclean: "VA", lowell: "MA",
  tewksbury: "MA", "falls church": "VA",
};

function cityTaxonomyKey(value: string): string {
  return stripDiacritics(value).toLocaleLowerCase().replace(/\./g, "");
}

/**
 * Single source of truth for cities recognized by `parseLocation`.  Keep the
 * aliases in the parser sets; consumers such as onboarding options derive
 * from this export so the two taxonomies cannot silently drift.
 */
export const SUPPORTED_CITY_OPTIONS: readonly SupportedCityOption[] = (() => {
  const seen = new Set<string>();
  const options: SupportedCityOption[] = [];
  for (const [cities, country] of [[CANADIAN_CITIES, "Canada"], [US_CITIES, "United States"]] as const) {
    for (const city of cities) {
      const canonicalName = city === "montréal" ? "Montreal" : cityLabel(city);
      const key = `${country}:${cityTaxonomyKey(canonicalName)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        name: canonicalName,
        country,
        region: CITY_REGIONS[cityTaxonomyKey(canonicalName)] ?? "",
      });
    }
  }
  return options.toSorted((left, right) => left.country.localeCompare(right.country) || left.name.localeCompare(right.name));
})();

for (const city of CANADIAN_CITIES) {
  CITY_ALIASES.set(stripDiacritics(city).toLocaleLowerCase().replace(/\./g, ""), { city: cityLabel(city === "montréal" ? "Montreal" : city), country: "Canada" });
}
for (const city of US_CITIES) {
  CITY_ALIASES.set(stripDiacritics(city).toLocaleLowerCase().replace(/\./g, ""), { city: cityLabel(city), country: "United States" });
}

function normalizedLocationText(value: string): string {
  return stripDiacritics(value).toLocaleLowerCase().replace(/\./g, "");
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitCountry(raw: string): string | null {
  const normalized = normalizedLocationText(raw);
  for (const [alias, country] of LOCATION_COUNTRY_ALIASES) {
    if (new RegExp(`(?:^|[^a-z])${escapedPattern(alias)}(?:$|[^a-z])`).test(normalized)) return country;
  }
  return null;
}

interface EmbeddedRegion {
  country: "Canada" | "United States";
  provinceState: string;
}

/**
 * Location feeds do not consistently put a state or province in its own
 * comma-delimited field. Recognize full names anywhere in the value and
 * uppercase two-letter abbreviations when they appear as standalone tokens.
 * The uppercase check avoids treating ordinary words such as "in" or "or"
 * as Indiana or Oregon.
 */
function embeddedRegion(raw: string): EmbeddedRegion | null {
  const normalized = normalizedLocationText(raw);
  const fullNameEntries = [
    ...Object.entries(CANADIAN_PROVINCES),
    ...Object.entries(US_STATES),
  ]
    .filter(([key]) => key.length > 2)
    .sort(([left], [right]) => right.length - left.length);
  for (const [key, provinceState] of fullNameEntries) {
    if (!new RegExp(`(?:^|[^a-z])${escapedPattern(key)}(?:$|[^a-z])`).test(normalized)) continue;
    const isCanadian = Object.prototype.hasOwnProperty.call(CANADIAN_PROVINCES, key);
    return { country: isCanadian ? "Canada" : "United States", provinceState };
  }

  const uppercaseAbbreviation = /(?:^|[^A-Za-z])([A-Z]{2})(?=$|[^A-Za-z])/g;
  for (const match of raw.matchAll(uppercaseAbbreviation)) {
    const key = (match[1] ?? "").toLocaleLowerCase();
    if (CANADIAN_PROVINCES[key]) return { country: "Canada", provinceState: CANADIAN_PROVINCES[key] };
    if (US_STATES[key]) return { country: "United States", provinceState: US_STATES[key] };
  }
  return null;
}

function embeddedCity(raw: string): { city: string; country: "Canada" | "United States" } | null {
  const lower = normalizedLocationText(raw);
  const aliases = [...CITY_ALIASES.entries()].toSorted(([left], [right]) => right.length - left.length);
  for (const [alias, value] of aliases) {
    if (new RegExp(`(?:^|[^a-z])${escapedPattern(alias)}(?:$|[^a-z])`).test(lower)) return value;
  }
  return null;
}

function detectRemoteScope(lower: string): NormalizedLocation["remoteScope"] {
  if (/\b(?:worldwide|global)\b/.test(lower)) return "worldwide";
  if (/\bnorth america\b/.test(lower)) return "north-america";
  if (/\b(?:canada|canadian)\b/.test(lower)) return "canada";
  if (/\b(?:united states|u\.?s\.?a?\.?|us only)\b/.test(lower)) return "usa";
  return "unspecified";
}

export function parseLocation(rawValue: string): NormalizedLocation {
  const raw = oneLine(rawValue);
  const lower = normalizedLocationText(raw);
  const remote = /\bremote\b/i.test(raw);
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const keys = parts.map(normalizedLocationText);
  const lastKey = keys.at(-1) ?? "";
  const namedCountry = explicitCountry(raw);
  const regionInText = embeddedRegion(raw);
  // The first comma-delimited component is the city in the feeds this parser
  // consumes. Looking through every component makes a foreign region such as
  // Victoria, Australia look like the Canadian city of Victoria.
  const cityPart = parts[0] ?? "";
  const exactCityMatch = CITY_ALIASES.get(normalizedLocationText(cityPart));
  const exactCity = exactCityMatch ? { ...exactCityMatch, city: cityPart } : null;
  const possibleCity = exactCity ?? embeddedCity(parts.length > 1 ? cityPart : raw);
  const canadianProvincePart = keys.find((key) => Boolean(CANADIAN_PROVINCES[key]));
  const explicitCanadianEvidence = namedCountry === "Canada"
    || Boolean(canadianProvincePart)
    || lastKey === "can"
    || /\b(?:canada|canadian)\b/.test(lower);
  const cityProvidesCountry = !possibleCity
    || possibleCity.country !== "Canada"
    || !AMBIGUOUS_CANADIAN_CITIES.has(cityTaxonomyKey(possibleCity.city))
    || explicitCanadianEvidence;
  // `CA` is both California and Canada's country code. When it is the final
  // component of an otherwise Canadian location, treat it as the country
  // code; a real U.S. state (for example, VA in Richmond, VA) wins over an
  // ambiguous city/region name such as Richmond or New Brunswick.
  const usStatePart = keys.find((key) => Boolean(US_STATES[key]) && !(
    key === "ca"
    && lastKey === "ca"
    && (parts.length === 1 || Boolean(canadianProvincePart) || exactCity?.country === "Canada")
  ));
  let country: string | null = namedCountry;
  let provinceState: string | null = null;
  let city: string | null = null;

  if (!country && usStatePart) country = "United States";
  else if (!country && (canadianProvincePart || (possibleCity?.country === "Canada" && cityProvidesCountry))) country = "Canada";
  else if (!country && possibleCity?.country === "United States") country = "United States";
  else if (!country && lastKey === "can") country = "Canada";
  else if (!country && (lastKey === "us" || lastKey === "usa")) country = "United States";
  else if (!country && lastKey === "ca" && parts.length === 1) country = "Canada";

  if (!country && regionInText) country = regionInText.country;

  const workdayState = /\bUSA?-([A-Z]{2})-/i.exec(raw)?.[1]?.toLocaleLowerCase();
  if (workdayState && US_STATES[workdayState]) {
    provinceState = US_STATES[workdayState];
    country = "United States";
  }

  for (const part of parts) {
    const key = normalizedLocationText(part);
    if (CANADIAN_PROVINCES[key] && (country === null || country === "Canada")) {
      provinceState = CANADIAN_PROVINCES[key];
      country = "Canada";
    } else if (US_STATES[key] && (country === null || country === "United States")) {
      provinceState = US_STATES[key];
      country = "United States";
    }
  }

  if (!provinceState && regionInText && country === regionInText.country) {
    provinceState = regionInText.provinceState;
  }

  if (possibleCity) {
    city = possibleCity.city;
    if (!country && cityProvidesCountry) country = possibleCity.country;
  } else if (parts.length >= 2 && !/remote|hybrid|canada|united states|u\.?s\.?a?\.?|^US-[A-Z]{2}-/i.test(parts[0] ?? "")) {
    city = parts[0] ?? null;
  }

  if (!country && lower === "canada") country = "Canada";
  if (!country && /^(?:usa?|united states)$/i.test(raw)) country = "United States";

  return { raw, country, provinceState, city, remote, remoteScope: remote ? detectRemoteScope(lower) : null };
}

/**
 * The scout only publishes roles that have an eligible work location. A
 * posting is eligible when at least one location is in Canada or the United
 * States, or when the posting is explicitly remote. Unknown and other-country
 * locations are intentionally rejected rather than guessed.
 */
export function isAllowedPostingLocation(normalizedLocations: NormalizedLocation[], remoteStatus: RemoteStatus): boolean {
  if (remoteStatus === "remote") return true;
  return normalizedLocations.some((location) => {
    if (location.remote) return true;
    const country = location.country?.toLocaleLowerCase();
    return country === "canada" || country === "united states" || country === "usa" || country === "us";
  });
}

export function parseLocations(values: string[], contextText = ""): { raw: string[]; normalized: NormalizedLocation[]; remoteStatus: RemoteStatus } {
  const raw = uniqueStrings(
    values.flatMap((value) => value.split(/\s*(?:\||;|\n|[•·])\s*/)).filter((value) => value.length > 0),
  );
  const normalized = raw.map(parseLocation);
  const joined = raw.join(" ");
  const explicitContext = /\bPosition Role Type\s*:\s*(Remote|Hybrid|Onsite)\b/i.exec(contextText)?.[1]
    ?? /\bThis position is classified as\s*:\s*(Remote|Hybrid|Onsite)\b/i.exec(contextText)?.[1]
    ?? /\b(?:position|role|internship|co-op|and) is (?:a |an )?(Remote|Hybrid|Onsite)\b/i.exec(contextText)?.[1];
  let remoteStatus: RemoteStatus = "unknown";
  if (explicitContext) remoteStatus = explicitContext.toLocaleLowerCase() as RemoteStatus;
  else if (/\bhybrid\b/i.test(joined)) remoteStatus = "hybrid";
  else if (/\bremote\b/i.test(joined)) remoteStatus = "remote";
  else if (raw.length > 0) remoteStatus = "onsite";
  return { raw, normalized, remoteStatus };
}
