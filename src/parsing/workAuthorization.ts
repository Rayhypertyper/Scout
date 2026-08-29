import { sentences, uniqueStrings } from "../utils/text.js";

const AUTHORIZATION_PATTERN = /\b(?:authori[sz](?:ed|ation) to work|work authori[sz]ation|visa|sponsorship|sponsor|cpt|opt|h-?1b|\btn\b|canadian citizen|u\.?s\.? citizen|permanent resident|green card)\b/i;
const CLEARANCE_PATTERN = /\bsecurity clearance\b/i;
const CLEARANCE_REQUIREMENT_PATTERN = /\b(?:required|requirement|must|ability to|obtain|maintain|active|eligible|status|type|none|not required)\b/i;

export interface AuthorizationDetails {
  requirements: string[];
  sponsorshipInformation: string | null;
}

export function extractWorkAuthorization(text: string): AuthorizationDetails {
  const prepared = text
    .replace(/\s+(?=(?:Date Posted|Country|Location|Position Role Type|Security Clearance Type|Security Clearance Status|What You Will Do|Qualifications (?:You|We)|Responsibilities|Requirements)\s*:)/g, "\n")
    .replace(/\s+(?=At [A-Z][A-Za-z0-9&.' -]{1,50}, (?:we|our|the)\b)/g, "\n")
    .replace(/\s+(?=(?:Are you ready|This requisition|Discover opportunities|Please consider)\b)/g, "\n");
  const requirements = uniqueStrings(sentences(prepared)
    .filter((unit) => AUTHORIZATION_PATTERN.test(unit) || (CLEARANCE_PATTERN.test(unit) && CLEARANCE_REQUIREMENT_PATTERN.test(unit)))
    .map((unit) => unit.replace(/^Requirements:\s*/i, "")));
  const sponsorship = requirements.filter((unit) => /\b(?:sponsor|sponsorship|visa|cpt|opt|h-?1b|\btn\b)\b/i.test(unit));
  return {
    requirements,
    sponsorshipInformation: sponsorship.length > 0 ? sponsorship.join(" ") : null,
  };
}
