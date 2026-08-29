import { cleanListItem, normalizeWhitespace, sentences, uniqueStrings } from "../utils/text.js";
import type {
  QualificationConflict,
  QualificationConflictKey,
  QualificationDetails,
  QualificationRequirementState,
  RemoteStatus,
} from "../domain/schemas.js";
import { safeCanonicalizeUrl } from "../utils/url.js";

export interface JobSections {
  responsibilities: string[];
  requiredQualifications: string[];
  preferredQualifications: string[];
}

type SectionName = keyof JobSections | "other";

const HEADING_RULES: Array<{ section: SectionName; pattern: RegExp }> = [
  { section: "responsibilities", pattern: /^(?:key |your )?(?:responsibilities|what you(?:'|’)ll (?:do|work on)|what you will do|the role|your impact|duties|in this role|how you(?:'|’)ll make an? impact)(?::)?$/i },
  { section: "requiredQualifications", pattern: /^(?:(?:(?:required|minimum|basic|professional|personal) )?(?:qualifications?(?:, capabilities,? and skills)?|requirements?|skills and qualifications)|required (?:education|technical and professional expertise)|qualifications and skills|qualifications & experience you will need|eligibility|education|program availability|required|required skills?|skills?|skills and experience|what we(?:'|’)re looking for|what we need|what you(?:'|’)ll need|what you need|what you bring|what you(?:'|’)ll bring|we are looking for (?:someone who|the following)|must have|about you|who you are|your background)(?::)?$/i },
  { section: "preferredQualifications", pattern: /^(?:preferred|preferences?|preferred (?:education|technical and professional experience)|preferred qualifications?(?:, capabilities,? and skills)?|preferred technical experience|additional skills \((?:preferred|nice to haves?)\)|bonus|bonus qualifications?|bonus points?|nice to have|preferred skills?(?: and (?:previous )?experience)?|desired (?:qualifications?|skills?(?: \(nice-to-have\))?)|it would be great if|what sets you apart)(?::)?$/i },
  { section: "other", pattern: /^(?:other|job description|additional information|job information|benefits|our benefits|our values(?: in action)?|privacy policy|here, we have|compensation|salary|pay transparency|base hourly pay|about (?:us|usds|the company|the internship|.{2,60})|company(?: overview| h-?1b sponsorship)?|equal (?:employment )?opportunity|location(?: & details)?|work location|please note|don(?:'|’)t meet them all|base pay range|how to apply|application|why (?:work|join) (?:with )?us|why join bytedance|what we offer|what this role is(?: \(and isn(?:'|’)t\))?|what you(?:'|’)ll gain|the process|our hiring process|learning and development|reasonable accommodation|diversity & inclusion|ready to join our team)(?::|\?)?$/i },
];

function headingFor(line: string): SectionName | null {
  const compact = cleanListItem(line).replace(/\s+/g, " ");
  return HEADING_RULES.find(({ pattern }) => pattern.test(compact))?.section ?? null;
}

const INLINE_HEADING_BREAKS: Array<{ pattern: RegExp; heading: string }> = [
  { pattern: /\bU\.S\. Citizen, U\.S\. Person, or Immigration Status Requirements\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bQualifications You Must Have\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bQualifications We Require\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bRequired Qualifications,\s*Capabilities,? and Skills\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bRequired (?:Education|Technical and Professional Expertise)\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /\b(?:Minimum|Basic|Required) (?:Qualifications|Requirements)\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /\b(?:Required Skills|Skills and Experience)\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /(?:^|\n)Your Background\s*:?\s*/gim, heading: "Required Qualifications" },
  { pattern: /\b(?:Qualifications & Experience You Will Need|Professional Qualifications|Personal Qualifications|Eligibility)\s*:?\s*/gi, heading: "Required Qualifications" },
  { pattern: /\b(?:What You(?:'|’)ll Need|What You Need|What We(?:'|’)re Looking For)\s*(?::\s*|(?=(?:Currently|Must|Experience|Knowledge|Familiarity|Proficien(?:cy|t)|Ability|Pursuing|Enrolled)\b))/gi, heading: "Required Qualifications" },
  { pattern: /\bWe Are Looking For Someone Who\s*:\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bQUALIFICATIONS AND SKILLS\b\s*:?\s*/g, heading: "Required Qualifications" },
  { pattern: /\b(?:Education|Program Availability)\s*:\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bRequired\s*:\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bQualifications We Prefer\s*:?\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\bAdditional Skills \((?:Preferred|Nice to Haves?)\)\s*:\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\bPreferred Qualifications,\s*Capabilities,? and Skills\s*:?\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\bPreferred (?:Education|Technical and Professional Experience)\s*:?\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\b(?:Preferred Qualifications|Preferred Skills(?: and (?:Previous )?Experience)?|Nice to Have|Bonus (?:Qualifications|Points)|What Sets You Apart)\s*:?\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\bPreferred\s*:\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\b(?:Preferred Technical Experience|Bonus)\s*:\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\bWhat You Will Do\s*:?\s*/gi, heading: "Responsibilities" },
  { pattern: /\bWhat You(?:'|’)ll (?:Do|Work On)\s*:?\s*/gi, heading: "Responsibilities" },
  { pattern: /\b(?:Key|Your) Responsibilities(?: Include)?\s*:?\s*/gi, heading: "Responsibilities" },
  { pattern: /\bResponsibilities(?: Include)?\s*:\s*/gi, heading: "Responsibilities" },
  { pattern: /\bDuring the internship, you will support the team in\s*:\s*/gi, heading: "Responsibilities" },
  { pattern: /\bWhat You Will Learn\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bWhat We Offer\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bLearn More & Apply Now!?\s*/gi, heading: "Other" },
  { pattern: /\bQualifications\s*:\s*/gi, heading: "Required Qualifications" },
  { pattern: /\bPreferences\s*:\s*/gi, heading: "Preferred Qualifications" },
  { pattern: /\bRequirements\s*:\s*/gi, heading: "Required Qualifications" },
  { pattern: /\b(?:About the Internship|Work Location|Please Note|Base Pay Range|What This Role Is(?: \(And Isn(?:'|’)t\))?|What You(?:'|’)ll Gain)\s*:?\??\s*/gi, heading: "Other" },
  { pattern: /\b(?:This position is subject to Section 19|Locations? you may join|What(?:'|’)s Next)\s*:?\??\s*/gi, heading: "Other" },
  { pattern: /\b(?:Don(?:'|’)t Meet Them All|Base Hourly Pay|Thank You For Your Interest)\s*:?\??\s*/gi, heading: "Other" },
  { pattern: /\b(?:Travel Requirements|Relocation Provided|Position Type|Physical Job Requirements|EEO Statement|MOTOROLA SOLUTIONS OVERVIEW)\s*:?\s*/gi, heading: "Other" },
  { pattern: /(?:^|\s)#L[I1]-[A-Z0-9-]+\s*/gi, heading: "Other" },
  { pattern: /\b(?:E-Verify Program Participant|Equal Employment Opportunity|Additional Job Details|Our Values(?: in Action)?|Privacy Policy|The Team|Work Location|HERE, we have)\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bOur team is defined by our values\b[^.]*\.?\s*/gi, heading: "Other" },
  { pattern: /\bWhy [A-Z][A-Za-z0-9&.'-]*(?: [A-Z][A-Za-z0-9&.'-]*){0,3}\?\s*/g, heading: "Other" },
  { pattern: /\b(?:Benefits|Compensation|Pay Transparency|Equal Opportunity|Why (?:Work|Join) (?:With )?Us|What We Offer|The Process|Our Hiring Process|Learning and Development|Ready to Join Our Team)\s*:?\??\s*/gi, heading: "Other" },
  { pattern: /\b(?:About Business Unit|Your Life @ IBM)\s*:?\??\s*/gi, heading: "Other" },
  { pattern: /\b(?:Company Overview|Company H-?1B Sponsorship)\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bAdditional Information\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bLocation\s*&\s*Details\s*:?\s*/gi, heading: "Other" },
  { pattern: /\bLocation\s*:\s*/gi, heading: "Other" },
  { pattern: /\bSkills\s*:\s*/gi, heading: "Required Qualifications" },
  { pattern: /\b(?:Interview Policy\s*&\s*Privacy Notice|About [A-Z][A-Za-z0-9&.' -]{1,50}'s Commitment to Employees)\s*:?\s*/g, heading: "Other" },
  { pattern: /\bAbout [A-Z][A-Za-z0-9&.'’-]{1,40}(?=\s+(?:We|Through|is|are|builds?|provides?|creates?)\b)\s*/g, heading: "Other" },
];

function restoreInlineHeadings(text: string): string {
  let restored = normalizeWhitespace(text);
  for (const { pattern, heading } of INLINE_HEADING_BREAKS) restored = restored.replace(pattern, `\n${heading}\n`);
  return restored;
}

function sectionUnits(line: string, section: SectionName): string[] {
  const units = sentences(line);
  if (section === "responsibilities") {
    return units
      .flatMap((unit) => unit.split(
        /\s+(?=(?:Build|Create|Collaborate|Contribute|Debug|Design|Develop|Drive|Implement|Improve|Maintain|Optimize|Partner|Research|Test|Write)\b)/,
      ))
      .flatMap((unit) => unit.split(
        /,\s+(?=(?:analyzing|collaborating|creating|designing|developing|documenting|identifying|learning|maintaining|performing|preparing|testing|troubleshooting|updating|writing)\b)/i,
      ));
  }
  if (section !== "requiredQualifications" && section !== "preferredQualifications") return units;
  return units
    .flatMap((unit) => unit.split(
      /\s+(?=(?:Must|Currently|Experience|Knowledge|Familiarity|Proficien(?:cy|t)|Strong|Excellent|Good|Software life cycle|Candidates? (?:should|must)|Ability to|Previous|Prior|Working knowledge|Pursuing|Enrolled)\b)/,
    ))
    .flatMap((unit) => unit.split(
      /,\s+(?=(?:basic (?:knowledge|understanding)|has\b|is (?:fluent|interested|independent|comfortable|able)|works well|personal projects|familiarity with)\b)/i,
    ))
    .map((unit) => unit.replace(/^(?:criteria|minimum|required|preferred)\s*:\s*/i, "").trim())
    .filter(Boolean);
}

export function extractJobSections(text: string): JobSections {
  const result: JobSections = { responsibilities: [], requiredQualifications: [], preferredQualifications: [] };
  let section: SectionName = "other";
  for (const rawLine of restoreInlineHeadings(text).split(/\n+/)) {
    const line = cleanListItem(rawLine);
    if (!line) continue;
    if (section === "other" && /^(?:which include|include the following|medical coverage|interviews follow|we offer competitive)\b/i.test(line)) continue;
    const heading = headingFor(line);
    if (heading) {
      section = heading;
      continue;
    }
    for (const unit of sectionUnits(line, section)) {
      if (
        (section === "requiredQualifications" || section === "preferredQualifications")
        && /^(?:criteria|job description|minimum|required|preferred|operation and support)\s*:?$/i.test(unit)
      ) {
        continue;
      }
      if (
        (section === "requiredQualifications" || section === "preferredQualifications")
        && /\b(?:will not sponsor|cannot (?:provide|offer) (?:visa |employment )?sponsorship|require sponsorship|authorized to work)\b/i.test(unit)
      ) {
        continue;
      }
      if (
        (section === "requiredQualifications" || section === "preferredQualifications")
        && /^(?:Employee Assistance Program|401\(k\) Plan|Paid Time Off|Transportation)\b/i.test(unit)
      ) {
        continue;
      }
      if (
        (section === "requiredQualifications" || section === "preferredQualifications")
        && /^(?:,?\s*we(?:'|’)d still love|we(?:'|’)re committed to providing|if you are passionate|by submitting an application|to request an accommodation|office hours are|Please (?:ensure|consider|note)|This position is classified as|(?:Onsite|Hybrid|Remote): Employees|Candidates will learn more about role type|For onsite and hybrid roles|As part of our commitment|The salary (?:range|for)|Relocation(?: Eligible)?\b)/i.test(unit)
      ) {
        section = "other";
        break;
      }
      if (
        (section === "requiredQualifications" || section === "preferredQualifications")
        && /\b(?:\d{1,2}[ -]?(?:week|month)s?|spring|summer|fall|autumn|winter|salary|compensation|pay range|equal opportunity)\b/i.test(unit)
        && !/\b(?:experience|knowledge|skill|degree|enrolled|pursuing|required|must|familiar|proficien|ability|commit(?:ted|ment)?)\b/i.test(unit)
      ) {
        section = "other";
        break;
      }
      if (
        section === "requiredQualifications"
        && /\b(?:(?:is|are) (?:preferred|a plus)|nice to have|bonus)\b/i.test(unit)
      ) {
        result.preferredQualifications.push(unit);
        continue;
      }
      if (section !== "other" && unit.length >= 3 && unit.length <= 600) result[section].push(unit);
    }
  }
  return {
    responsibilities: uniqueStrings(result.responsibilities),
    requiredQualifications: uniqueStrings(result.requiredQualifications),
    preferredQualifications: uniqueStrings(result.preferredQualifications),
  };
}

export interface RequirementDetails {
  education: string[];
  graduation: string[];
  experience: string[];
}

const EDUCATION_PATTERN = /\b(?:pursuing|enrolled|bachelor(?:'s|s)?|master(?:'s|s)?|ph\.?d\.?|computer science|computer engineering|university|college|(?:undergraduate|graduate) degree|degree (?:in|program|from))\b/i;
const GRADUATION_PATTERN = /\b(?:graduat(?:e|es|ed|ing|ion)|class of|return(?:ing)? to (?:school|university)|penultimate year|(?:first|second|third|sophomore|junior|senior) (?:year|standing|student)|entering (?:their )?[^.]{0,80}\byear)\b/i;
const EXPERIENCE_PATTERN = /\b(?:(?:\d+|one|two|three|four|five)\+? years?|prior|previous|hands-on) (?:of )?(?:professional |industry |work )?experience\b|\bexperience (?:with|in|using)\b/i;

export function extractRequirementDetails(text: string): RequirementDetails {
  const units = sentences(text).map((unit) => unit.replace(
    /^(?:(?:(?:minimum|required|basic|preferred) qualifications?|required skills?|education)\s*:?\s*)+/i,
    "",
  ).trim()).filter(Boolean);
  return {
    education: uniqueStrings(units.filter((unit) => EDUCATION_PATTERN.test(unit))),
    graduation: uniqueStrings(units.filter((unit) => GRADUATION_PATTERN.test(unit))),
    experience: uniqueStrings(units.filter((unit) => EXPERIENCE_PATTERN.test(unit))),
  };
}

const MAX_STRUCTURED_QUALIFICATION_TEXT = 240_000;
const YEAR = "20\\d{2}";
const DEGREE_PATTERN = /\b(?:bachelor(?:['’]s|s)?|master(?:['’]s|s)?|ph\.?d\.?|doctor(?:al|ate)|associate(?:['’]s|s)?|b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|b\.?eng\.?|m\.?eng\.?|computer science|computer engineering|electrical engineering|degree\s+(?:in|program|from))\b/i;
const AUTHORIZATION_REQUIRED_PATTERN = /\b(?:must|need(?:s)?|required|required to be|eligible|legally)\b[^.\n]{0,100}\b(?:authori[sz](?:ed|ation)|work in|work authorization|right to work|employ(?:ment)? eligibility)\b|\b(?:authori[sz](?:ed|ation) to work|legally entitled to work|right to work)\b/i;
const AUTHORIZATION_NOT_REQUIRED_PATTERN = /\b(?:no|without|not required|does not require|doesn['’]?t require)\b[^.\n]{0,80}\b(?:work authorization|right to work|employment authorization|employment eligibility|legally authorized to work)\b/i;
const SPONSORSHIP_AVAILABLE_PATTERN = /\b(?:(?:visa|employment|immigration|employer)\s+)?sponsorship\s+(?:(?:is|may be|can be)\s+)?(?:available|provided|offered)|\bwill sponsor\b|\bsponsor(?:s|ed|ing)?\s+(?:eligible )?candidates?\b/i;
const SPONSORSHIP_UNAVAILABLE_PATTERN = /\b(?:will not|won['’]?t|cannot|can['’]?t|unable to|does not|doesn['’]?t|do not|don['’]?t)\s+(?:provide|offer|support)\b[^.!?;\n]{0,70}\b(?:visa|employment|immigration|work)?\s*sponsorship\b|\b(?:will not|won['’]?t|cannot|can['’]?t|unable to|does not|doesn['’]?t|do not|don['’]?t)\s+sponsor(?:s|ed|ing)?\b|\b(?:no|not\s+available|unavailable|not\s+provided|not\s+offered|not\s+supported)\s+(?:(?:visa|employment|immigration|work)\s+)?sponsorship\b|\b(?:(?:visa|employment|immigration|work)\s+)?sponsorship\s*(?::|is)?\s*(?:not available|unavailable|not provided|not offered|not supported)\b|\bnot eligible for\s+(?:(?:visa|employment|immigration|work)\s+)?sponsorship\b|\bwithout sponsorship\b|\bnot sponsor(?:ed|ing)?\b/i;
const SPONSORSHIP_REQUIRED_PATTERN = /\b(?:must|need(?:s)?|require(?:s|d)?)\b[^.\n]{0,70}\b(?:(?:visa|employment|immigration|employer)\s+)?sponsorship\b/i;

function isSoftOnlyQualification(sentence: string): boolean {
  const soft = /\b(?:preferred|nice to have|nice-to-have|desired|bonus|ideal|plus|asset)\b/i.test(sentence);
  const hard = /\b(?:must|required|need(?:s)?|only|ineligible|not eligible|minimum|at least)\b/i.test(sentence);
  return soft && !hard;
}

function structuredSentences(text: string): string[] {
  return sentences(text.slice(0, MAX_STRUCTURED_QUALIFICATION_TEXT));
}

export function hasUnavailableSponsorshipStatement(text: string): boolean {
  return SPONSORSHIP_UNAVAILABLE_PATTERN.test(text);
}

function contiguousYears(years: number[]): boolean {
  if (years.length < 2) return true;
  for (let index = 1; index < years.length; index += 1) {
    if (years[index]! !== years[index - 1]! + 1) return false;
  }
  return true;
}

function addYears(target: Set<number>, values: Iterable<string>): void {
  for (const value of values) {
    const year = Number(value);
    if (Number.isInteger(year) && year >= 1900 && year <= 2200) target.add(year);
  }
}

function extractGraduation(sentencesToInspect: string[]): {
  years: number[];
  range: QualificationDetails["graduationYearRange"];
  expected: string | null;
  evidence: string[];
} {
  const years = new Set<number>();
  const explicitRanges: Array<{ min: number; max: number }> = [];
  const evidence: string[] = [];
  let expected: string | null = null;
  for (const sentence of sentencesToInspect) {
    if (isSoftOnlyQualification(sentence)) continue;
    const graduationSignal = /\b(?:graduat(?:e|es|ed|ing|ion)|class\s+of|expected\s+graduation|graduate\s+by|degree\s+completion)\b/i.test(sentence);
    if (!graduationSignal) continue;
    const found: string[] = [];
    for (const match of sentence.matchAll(new RegExp(`\\b${YEAR}\\b`, "g"))) found.push(match[0]);
    // Restrict year extraction to sentences with an explicit graduation
    // signal; this avoids treating company-history dates as eligibility.
    addYears(years, found);
    const range = new RegExp(`\\b(?:(?:between\\s+)?(${YEAR})\\s*(?:-|–|—|to|through)\\s*(${YEAR})|between\\s+(${YEAR})\\s+and\\s+(${YEAR}))\\b`, "i").exec(sentence);
    if (range) {
      const rangeYears = [Number(range[1] ?? range[3]), Number(range[2] ?? range[4])]
        .filter((year) => Number.isInteger(year));
      addYears(years, rangeYears.map(String));
      if (rangeYears.length === 2) {
        explicitRanges.push({
          min: Math.min(rangeYears[0]!, rangeYears[1]!),
          max: Math.max(rangeYears[0]!, rangeYears[1]!),
        });
      }
    }
    if (/\b(?:expected\s+graduation|graduate\s+by|degree\s+completion)\b/i.test(sentence) && !expected) expected = sentence;
    if (found.length > 0 || /\bclass\s+of\b/i.test(sentence)) evidence.push(sentence);
  }
  const sortedYears = [...years].sort((left, right) => left - right);
  const range = explicitRanges.length > 0
    ? {
      min: Math.min(...explicitRanges.map(({ min }) => min)),
      max: Math.max(...explicitRanges.map(({ max }) => max)),
    }
    : contiguousYears(sortedYears) && sortedYears.length > 0
      ? { min: sortedYears[0]!, max: sortedYears.at(-1)! }
      : null;
  return { years: sortedYears, range, expected, evidence: uniqueStrings(evidence) };
}

function extractStudyYears(sentencesToInspect: string[]): { values: string[]; evidence: string[]; upperEvidence: string | null } {
  const values = new Set<string>();
  const evidence: string[] = [];
  let upperEvidence: string | null = null;
  const patterns: Array<[RegExp, string]> = [
    [/\b(?:first[- ]year|freshman|freshmen|1st[- ]year|year\s*1)\b/i, "first-year"],
    [/\b(?:second[- ]year|sophomore|sophomores|2nd[- ]year|year\s*2)\b/i, "second-year"],
    [/\b(?:third[- ]year|junior|juniors|3rd[- ]year|year\s*3)\b/i, "third-year"],
    [/\b(?:fourth[- ]year|senior|seniors|4th[- ]year|year\s*4)\b/i, "fourth-year"],
    [/\b(?:fifth[- ]year|5th[- ]year)\b/i, "fifth-year"],
    [/\b(?:penultimate|upper[- ]year|upperclass(?:man|men)?|rising\s+(?:sophomore|sophomores|junior|juniors|senior|seniors))\b/i, "upper-year"],
  ];
  for (const sentence of sentencesToInspect) {
    const found = patterns.filter(([pattern]) => pattern.test(sentence)).map(([, value]) => value);
    if (found.length === 0) continue;
    found.forEach((value) => values.add(value));
    evidence.push(sentence);
    if (
      found.includes("upper-year")
      || /\b(?:second|third|fourth|fifth)[- ]year\s+or\s+(?:above|later)\b/i.test(sentence)
      || /\b(?:at\s+least|minimum\s+(?:of|is)|must\s+be)\s+(?:a\s+)?(?:sophomore|junior|senior|second[- ]year|third[- ]year|fourth[- ]year)\b/i.test(sentence)
      || /\b(?:only|preferred|nice to have|nice-to-have|ideal|plus|asset)\b/i.test(sentence)
    ) upperEvidence ??= sentence;
  }
  return { values: [...values], evidence: uniqueStrings(evidence), upperEvidence };
}

function extractFirstYearState(sentencesToInspect: string[]): QualificationDetails["firstYearEligible"] {
  let positive = false;
  let negative = false;
  for (const sentence of sentencesToInspect) {
    if (!/\b(?:first[- ]year|freshman|freshmen|1st[- ]year|year\s*1)\b/i.test(sentence)) continue;
    if (/\b(?:not|no|ineligible|exclude|excluding|cannot|can['’]?t|must be at least|second[- ]year or above|upper[- ]year)\b/i.test(sentence)) negative = true;
    if (/\b(?:eligible|welcome|welcomed|open to|accept(?:s|ing)?|may apply|encouraged to apply)\b/i.test(sentence)) positive = true;
  }
  if (negative) return "no";
  if (positive) return "yes";
  return "unknown";
}

function firstYearConflict(sentencesToInspect: string[]): QualificationConflict | null {
  const relevant = sentencesToInspect.filter((sentence) => /\b(?:first[- ]year|freshman|freshmen|1st[- ]year|year\s*1)\b/i.test(sentence));
  const positive = relevant.some((sentence) => /\b(?:eligible|welcome|welcomed|open to|accept(?:s|ing)?|may apply|encouraged to apply)\b/i.test(sentence));
  const negative = relevant.some((sentence) => /\b(?:not|no|ineligible|exclude|excluding|cannot|can['’]?t|must be at least|second[- ]year or above|upper[- ]year)\b/i.test(sentence));
  return positive && negative
    ? { key: "year_of_study", evidence: uniqueStrings(relevant) }
    : null;
}

function extractUpperYearState(evidence: string | null): QualificationDetails["upperYearRequired"] {
  if (!evidence) return "unknown";
  if (/\b(?:preferred|welcome|encouraged|may be)\b/i.test(evidence) && !/\b(?:must|required|need(?:s)?|at least)\b/i.test(evidence)) return "no";
  return "yes";
}

interface RequirementExtraction {
  state: QualificationRequirementState;
  evidence: string[];
}

function requirementState(
  sentencesToInspect: string[],
  requiredPattern: RegExp,
  preferredPattern: RegExp,
  notRequiredPattern: RegExp,
): RequirementExtraction {
  const required = sentencesToInspect.filter((sentence) => requiredPattern.test(sentence)
    && !notRequiredPattern.test(sentence)
    && !preferredPattern.test(sentence));
  const preferred = sentencesToInspect.filter((sentence) => preferredPattern.test(sentence));
  const notRequired = sentencesToInspect.filter((sentence) => notRequiredPattern.test(sentence));
  const evidence = uniqueStrings([...required, ...preferred, ...notRequired]);
  if (required.length > 0 && notRequired.length > 0) return { state: "conflict", evidence };
  if (required.length > 0) return { state: "required", evidence };
  if (notRequired.length > 0) return { state: "not_required", evidence };
  if (preferred.length > 0) return { state: "preferred", evidence };
  return { state: "unknown", evidence: [] };
}

const STUDENT_REQUIRED_PATTERN = /\b(?:must|need(?:s)?|required to be|currently|active|pursuing|enrolled|registered|attending)\b[^.!?;\n]{0,100}\b(?:student|undergraduate|graduate student|degree|program)\b|\b(?:student|undergraduate|graduate student)s?\s+only\b/i;
const STUDENT_PREFERRED_PATTERN = /\b(?:student|undergraduate|graduate student|enrolled|pursuing)\b[^.!?;\n]{0,80}\b(?:preferred|nice to have|ideal|plus)\b|\b(?:preferred|nice to have|ideal|plus)\b[^.!?;\n]{0,80}\b(?:student|undergraduate|graduate student|enrolled|pursuing)\b/i;
const STUDENT_NOT_REQUIRED_PATTERN = /\b(?:no|not|without|does not|doesn['’]?t|do not|don['’]?t)\b[^.!?;\n]{0,80}\b(?:need to be|currently )?(?:a\s+)?(?:student|enrolled|registered|attending)\b|\b(?:students?|undergraduates?|graduates?)\s+and\s+(?:recent\s+)?graduates?\s+(?:are\s+)?(?:welcome|eligible|may apply)\b/i;
const ENROLLMENT_REQUIRED_PATTERN = /\b(?:must|need(?:s)?|required to be|currently|active)\b[^.!?;\n]{0,80}\b(?:enrolled|registered|attending|matriculated)\b|\b(?:enrolled|registered|attending|matriculated)\s+(?:in|at)\b/i;
const ENROLLMENT_PREFERRED_PATTERN = /\b(?:enrolled|registered|attending|matriculated)\b[^.!?;\n]{0,80}\b(?:preferred|nice to have|ideal|plus)\b|\b(?:preferred|nice to have|ideal|plus)\b[^.!?;\n]{0,80}\b(?:enrolled|registered|attending|matriculated)\b/i;
const ENROLLMENT_NOT_REQUIRED_PATTERN = /\b(?:no|not|without|does not|doesn['’]?t|do not|don['’]?t)\b[^.!?;\n]{0,80}\b(?:need to be|currently )?(?:enrolled|registered|attending|matriculated)\b|\b(?:recent\s+)?graduates?\s+(?:are\s+)?(?:welcome|eligible|may apply)\b/i;
const RETURNING_REQUIRED_PATTERN = /\b(?:must|need(?:s)?|required to|will be expected to)\b[^.!?;\n]{0,100}\b(?:return(?:ing)?|re[- ]?enroll|go back)\s+(?:to|in)\s+(?:school|college|university|their program)\b/i;
const RETURNING_PREFERRED_PATTERN = /\b(?:return(?:ing)?|re[- ]?enroll|go back)\s+(?:to|in)\s+(?:school|college|university|their program)\b[^.!?;\n]{0,80}\b(?:preferred|nice to have|ideal|plus)\b|\b(?:preferred|nice to have|ideal|plus)\b[^.!?;\n]{0,80}\b(?:return(?:ing)?|re[- ]?enroll)\b/i;
const RETURNING_NOT_REQUIRED_PATTERN = /\b(?:no|not|without|does not|doesn['’]?t|do not|don['’]?t)\b[^.!?;\n]{0,80}\b(?:need to|have to|be expected to)\s+(?:return(?:ing)?|re[- ]?enroll|go back)\s+(?:to|in)\s+(?:school|college|university|their program)\b/i;

function conflictForRequirement(
  key: QualificationConflictKey,
  extraction: RequirementExtraction,
): QualificationConflict | null {
  return extraction.state === "conflict"
    ? { key, evidence: extraction.evidence }
    : null;
}

function extractDegreeRequirements(sentencesToInspect: string[]): string[] {
  return uniqueStrings(sentencesToInspect.filter((sentence) => DEGREE_PATTERN.test(sentence) && !isSoftOnlyQualification(sentence)));
}

function extractModality(text: string): RemoteStatus {
  const lower = text.toLocaleLowerCase();
  const explicit = /\b(?:position|role|internship|co[- ]?op|job|work\s+(?:model|arrangement|location)|position\s+role\s+type)\b[^.\n]{0,100}\b(remote|hybrid|on[- ]?site|onsite|in\s+office)\b/i.exec(lower)?.[1]
    ?? /\b(?:remote|hybrid|on[- ]?site|onsite|in\s+office)\s+(?:role|position|internship|co[- ]?op|job)\b/i.exec(lower)?.[0]?.split(/\s+/)[0];
  if (explicit) {
    if (/hybrid/i.test(explicit)) return "hybrid";
    if (/remote/i.test(explicit)) return "remote";
    if (/on|office/i.test(explicit)) return "onsite";
  }
  return "unknown";
}

function extractExplicitApplicationUrl(text: string, provided?: string | null): string | null {
  if (provided) return safeCanonicalizeUrl(provided) ?? provided;
  const candidate = /\bhttps?:\/\/[^\s<>"')\]]+/i.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (!candidate) return null;
  return safeCanonicalizeUrl(candidate) ?? candidate;
}

function extractExplicitDeadline(sentencesToInspect: string[], provided?: string | null): string | null {
  if (provided) return provided;
  const deadlinePattern = /\b(?:application|apply|applications?)\s+(?:deadline|by|before|close|closing)|\bclosing\s+date\b|\bdeadline\b/i;
  return sentencesToInspect.find((sentence) => deadlinePattern.test(sentence)) ?? null;
}

/**
 * Extract explicit eligibility facts in one bounded pass. Every state has an
 * `unknown` value; absence of a phrase is never treated as eligibility.
 */
export function extractQualificationDetails(
  text: string,
  options: { applicationUrl?: string | null; deadline?: string | null } = {},
): QualificationDetails {
  const bounded = text.slice(0, MAX_STRUCTURED_QUALIFICATION_TEXT);
  const inspected = structuredSentences(bounded);
  const graduation = extractGraduation(inspected);
  const study = extractStudyYears(inspected);
  const firstYearEligible = extractFirstYearState(inspected);
  const upperYearRequired = extractUpperYearState(study.upperEvidence);
  const degreeRequirements = extractDegreeRequirements(inspected);
  const studentStatus = requirementState(
    inspected,
    STUDENT_REQUIRED_PATTERN,
    STUDENT_PREFERRED_PATTERN,
    STUDENT_NOT_REQUIRED_PATTERN,
  );
  const enrollment = requirementState(
    inspected,
    ENROLLMENT_REQUIRED_PATTERN,
    ENROLLMENT_PREFERRED_PATTERN,
    ENROLLMENT_NOT_REQUIRED_PATTERN,
  );
  const returningToSchool = requirementState(
    inspected,
    RETURNING_REQUIRED_PATTERN,
    RETURNING_PREFERRED_PATTERN,
    RETURNING_NOT_REQUIRED_PATTERN,
  );
  const evidence = uniqueStrings([
    ...graduation.evidence,
    ...study.evidence,
    ...degreeRequirements,
    ...studentStatus.evidence,
    ...enrollment.evidence,
    ...returningToSchool.evidence,
  ]);

  const conflicts: QualificationConflict[] = [];
  const firstYearContradiction = firstYearConflict(inspected);
  if (firstYearContradiction) conflicts.push(firstYearContradiction);
  const studentConflict = conflictForRequirement("student_status", studentStatus);
  if (studentConflict) conflicts.push(studentConflict);
  const enrollmentConflict = conflictForRequirement("enrollment", enrollment);
  if (enrollmentConflict) conflicts.push(enrollmentConflict);
  const returningConflict = conflictForRequirement("returning_to_school", returningToSchool);
  if (returningConflict) conflicts.push(returningConflict);

  let workAuthorization: QualificationDetails["workAuthorization"] = "unknown";
  const authorizationNotRequired = AUTHORIZATION_NOT_REQUIRED_PATTERN.test(bounded);
  const authorizationRequired = AUTHORIZATION_REQUIRED_PATTERN.test(bounded);
  if (authorizationNotRequired) workAuthorization = "not_required";
  else if (authorizationRequired) workAuthorization = "required";
  if (authorizationNotRequired && authorizationRequired) {
    const authorizationEvidence = inspected.filter((sentence) => AUTHORIZATION_NOT_REQUIRED_PATTERN.test(sentence) || AUTHORIZATION_REQUIRED_PATTERN.test(sentence));
    conflicts.push({ key: "work_authorization", evidence: uniqueStrings(authorizationEvidence) });
  }

  let sponsorship: QualificationDetails["sponsorship"] = "unknown";
  const sponsorshipUnavailable = hasUnavailableSponsorshipStatement(bounded);
  const sponsorshipRequired = SPONSORSHIP_REQUIRED_PATTERN.test(bounded);
  const sponsorshipAvailable = SPONSORSHIP_AVAILABLE_PATTERN.test(bounded);
  if (sponsorshipUnavailable) sponsorship = "unavailable";
  else if (sponsorshipRequired) sponsorship = "required";
  else if (sponsorshipAvailable) sponsorship = "available";
  if (sponsorshipUnavailable && (sponsorshipRequired || sponsorshipAvailable)) {
    const sponsorshipEvidence = inspected.filter((sentence) => hasUnavailableSponsorshipStatement(sentence) || SPONSORSHIP_REQUIRED_PATTERN.test(sentence) || SPONSORSHIP_AVAILABLE_PATTERN.test(sentence));
    conflicts.push({ key: "sponsorship", evidence: uniqueStrings(sponsorshipEvidence) });
  }

  return {
    graduationYears: graduation.years,
    graduationYearRange: graduation.range,
    expectedGraduation: graduation.expected,
    yearOfStudy: study.values,
    firstYearEligible,
    upperYearRequired,
    upperYearRequirement: study.upperEvidence,
    degreeRequirements,
    workAuthorization,
    sponsorship,
    studentStatusRequirement: studentStatus.state,
    enrollmentRequirement: enrollment.state,
    returningToSchoolRequirement: returningToSchool.state,
    conflicts,
    locationModality: extractModality(bounded),
    applicationUrl: extractExplicitApplicationUrl(bounded, options.applicationUrl),
    deadline: extractExplicitDeadline(inspected, options.deadline),
    evidence,
  };
}

export const extractStructuredQualifications = extractQualificationDetails;
export const extractEligibility = extractQualificationDetails;
