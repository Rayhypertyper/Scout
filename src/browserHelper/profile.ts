import { z } from "zod";

import type { Resume } from "../resume/tailor.js";

const shortText = z.string().trim().max(500);
const educationSchema = z.object({
  school: shortText,
  degree: shortText,
  fieldOfStudy: shortText,
  startDate: shortText,
  endDate: shortText,
  gradeAverage: shortText.default(""),
}).strict();
const experienceSchema = z.object({
  company: shortText,
  title: shortText,
  startDate: shortText,
  endDate: shortText,
  description: z.string().trim().max(4_000),
  location: shortText.default(""),
  currentlyWorkHere: z.boolean().nullable().default(null),
}).strict();
const languageRating = z.string().trim().max(100);
const languageSchema = z.object({
  language: z.string().trim().min(1).max(100),
  fluent: z.boolean().nullable().default(null),
  comprehension: languageRating.default(""),
  overall: languageRating.default(""),
  reading: languageRating.default(""),
  speaking: languageRating.default(""),
  writing: languageRating.default(""),
}).strict();
const websiteSchema = z.object({
  url: z.string().trim().max(2_048).refine((value) => value === "" || (() => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  })(), "website URL must be blank or http(s) without credentials"),
}).strict();

const browserHelperAnswerScopeSchema = z.object({
  origin: z.string().trim().min(1).max(2_048).url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "origin must be an http(s) URL without credentials")
    .transform((value) => new URL(value).origin).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  locale: z.string().trim().min(1).max(32).optional(),
}).strict().refine((scope) => Object.values(scope).some((value) => value !== undefined), "scope must include an origin, country, or locale");

const normalizeChoiceLabel = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
const choiceLabelSchema = z.string().trim().min(1).max(500)
  .transform(normalizeChoiceLabel)
  .pipe(z.string().min(1).max(500));
const choiceListSchema = z.array(choiceLabelSchema).max(30).superRefine((choices, context) => {
  if (new Set(choices.map(normalizeQuestion)).size !== choices.length) {
    context.addIssue({ code: "custom", message: "Choice labels must be unique." });
  }
});
const optionalTypedAnswerText = z.literal("").optional();

export const browserHelperAnswerValueSchema = z.discriminatedUnion("answerType", [
  z.object({
    answerType: z.literal("text"),
    answer: z.string().trim().min(1).max(2_000),
    scope: browserHelperAnswerScopeSchema.optional(),
  }).strict(),
  z.object({
    answerType: z.literal("single-choice"),
    answer: optionalTypedAnswerText,
    selectedChoices: choiceListSchema.length(1),
    scope: browserHelperAnswerScopeSchema.optional(),
  }).strict(),
  z.object({
    answerType: z.literal("multi-choice"),
    answer: optionalTypedAnswerText,
    selectedChoices: choiceListSchema,
    scope: browserHelperAnswerScopeSchema.optional(),
  }).strict(),
  z.object({
    answerType: z.literal("boolean"),
    answer: optionalTypedAnswerText,
    booleanValue: z.boolean(),
    scope: browserHelperAnswerScopeSchema.optional(),
  }).strict(),
]);

export type BrowserHelperAnswerValue = z.infer<typeof browserHelperAnswerValueSchema>;
export interface BrowserHelperAnswerScope {
  origin?: string | undefined;
  country?: string | undefined;
  locale?: string | undefined;
}

export interface BrowserHelperStoredAnswerValue {
  answerType: "text" | "single-choice" | "multi-choice" | "boolean";
  answer: string;
  selectedChoices?: string[];
  booleanValue?: boolean;
  scope?: BrowserHelperAnswerScope;
}

/** Stable identity for scoped answers; scope value casing/spacing doesn't create duplicates. */
export function browserHelperAnswerScopeKey(scope?: BrowserHelperAnswerScope): string {
  if (!scope) return "{}";
  const normalize = (value: string | undefined) => value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  const normalized = {
    ...(scope.origin ? { origin: new URL(scope.origin).origin } : {}),
    ...(scope.country ? { country: normalize(scope.country) } : {}),
    ...(scope.locale ? { locale: normalize(scope.locale) } : {}),
  };
  return JSON.stringify(normalized);
}

export const browserHelperProfileSchema = z.object({
  firstName: shortText,
  lastName: shortText,
  email: z.email().or(z.literal("")),
  phone: shortText,
  phoneType: z.string().trim().max(50).default(""),
  phoneCountryCode: z.string().trim().max(100).default(""),
  phoneExtension: z.string().trim().max(100).default(""),
  address: shortText,
  city: shortText,
  region: shortText,
  postalCode: shortText,
  country: shortText,
  linkedin: shortText,
  github: shortText,
  portfolio: shortText,
  education: z.array(educationSchema).max(12),
  experience: z.array(experienceSchema).max(20),
  experienceCount: z.number().int().min(0).max(20).nullable().default(null),
  workAuthorization: shortText,
  requiresSponsorship: shortText,
  previousWorker: z.boolean().nullable().default(null),
  hasPreferredName: z.boolean().nullable().default(null),
  preferredFirstName: shortText.default(""),
  preferredLastName: shortText.default(""),
  referralSources: z.array(z.string().trim().min(1).max(500)).max(30)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: "Referral source labels must be unique." });
      }
    }).default([]),
  websites: z.array(websiteSchema).default([]),
  languages: z.array(languageSchema).max(20).superRefine((values, context) => {
    const keys = values.map((value) => normalizeQuestion(value.language));
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "Language names must be unique." });
    }
  }).default([]),
}).strict();

export type BrowserHelperProfile = z.infer<typeof browserHelperProfileSchema>;

export const emptyBrowserHelperProfile: BrowserHelperProfile = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  phoneType: "",
  phoneCountryCode: "",
  phoneExtension: "",
  address: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  linkedin: "",
  github: "",
  portfolio: "",
  education: [],
  experience: [],
  experienceCount: null,
  workAuthorization: "",
  requiresSponsorship: "",
  previousWorker: null,
  hasPreferredName: null,
  preferredFirstName: "",
  preferredLastName: "",
  referralSources: [],
  websites: [],
  languages: [],
};

function firstPhone(contacts: string[]): string {
  return contacts.find((value) => {
    if (/[a-z]/i.test(value.replace(/(?:ext\.?|x)\s*\d+$/i, ""))) return false;
    const digits = value.match(/\d/g)?.length ?? 0;
    return digits >= 7 && digits <= 18;
  }) ?? "";
}

function profileUrl(contacts: string[], host?: string): string {
  return contacts.find((value) => {
    if (value.length > 500) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      if (!host) return !["linkedin.com", "github.com"].some((socialHost) =>
        url.hostname === socialHost || url.hostname.endsWith(`.${socialHost}`));
      return url.hostname === host || url.hostname.endsWith(`.${host}`);
    } catch {
      return false;
    }
  }) ?? "";
}

function bounded(value: string, maximum: number): string {
  let boundedValue = value.slice(0, maximum);
  const lastCodeUnit = boundedValue.charCodeAt(boundedValue.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) boundedValue = boundedValue.slice(0, -1);
  return boundedValue.trim();
}

/** Map only directly represented resume facts; no work authorization or location is inferred. */
export function seedBrowserHelperProfile(resume: Resume | null, verifiedEmail: string): BrowserHelperProfile {
  if (!resume) return { ...emptyBrowserHelperProfile, email: verifiedEmail };
  const nameParts = resume.name.trim().split(/\s+/).filter(Boolean);
  const seed: BrowserHelperProfile = {
    ...emptyBrowserHelperProfile,
    firstName: bounded(nameParts[0] ?? "", 500),
    lastName: bounded(nameParts.length > 1 ? nameParts.slice(1).join(" ") : "", 500),
    email: verifiedEmail,
    phone: bounded(firstPhone(resume.contact), 500),
    linkedin: profileUrl(resume.contact, "linkedin.com"),
    github: profileUrl(resume.contact, "github.com"),
    portfolio: profileUrl(resume.contact),
    education: resume.education.slice(0, 12).map((entry) => ({
      school: bounded(entry.title, 500),
      degree: "",
      fieldOfStudy: "",
      startDate: "",
      endDate: "",
      gradeAverage: "",
    })),
    experience: resume.experience.slice(0, 20).map((entry) => ({
      company: bounded(entry.subtitle, 500),
      title: bounded(entry.title, 500),
      startDate: "",
      endDate: "",
      description: bounded(entry.bullets.join("\n"), 4_000),
      location: "",
      currentlyWorkHere: null,
    })),
  };
  return browserHelperProfileSchema.parse(seed);
}

/** Normalize repeated ATS prompts without conflating different punctuation or wording. */
export function normalizeQuestion(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}
