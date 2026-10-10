import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthHttpError, ensureCsrfToken } from "../auth/http.js";
import {
  deleteBrowserHelperAnswer,
  readBrowserHelperState,
  readResumeProfile,
  resolveResumeProfileIdentity,
  ResumeProfileError,
  ResumeProfileStorageError,
  saveBrowserHelperAnswer,
  saveBrowserHelperProfile,
} from "../resume/profile.js";
import { generateBrowserHelperWrittenDraft } from "./writtenDraft.js";
import {
  browserHelperAnswerValueSchema,
  normalizeQuestion,
  seedBrowserHelperProfile,
  browserHelperProfileSchema,
} from "./profile.js";

const ROOT = "/api/browser-helper";
const PROFILE_PATH = `${ROOT}/profile`;
const ANSWERS_PATH = `${ROOT}/answers`;
const APPLICATIONS_PATH = `${ROOT}/applications`;
const WRITTEN_DRAFT_PATH = `${ROOT}/written-draft`;
const MAX_JSON_BODY_BYTES = 256 * 1024;

export interface BrowserHelperApplicationSubmission {
  company: string;
  title: string;
  applicationUrl: string;
  location?: string;
  listingType?: "internship" | "grind";
  listingId?: string;
  confirmedSubmitted: true;
}

export interface BrowserHelperApplicationResult {
  listingKey: string;
  alreadyLogged: boolean;
}

export type BrowserHelperApplicationLogger = (
  userId: string,
  submission: BrowserHelperApplicationSubmission,
) => Promise<BrowserHelperApplicationResult> | BrowserHelperApplicationResult;

interface HandlerOptions {
  logApplication?: BrowserHelperApplicationLogger;
}

function writeJson(response: ServerResponse, status: number, payload: unknown, head = false): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "same-origin",
    Vary: "Cookie",
  });
  if (head) response.end();
  else response.end(body);
}

function applyAuthCookies(
  identity: Awaited<ReturnType<typeof resolveResumeProfileIdentity>>,
  response: ServerResponse,
): void {
  if (identity.context?.responseState.cookies.length && typeof response.setHeader === "function") {
    response.setHeader("Set-Cookie", identity.context.responseState.cookies);
  }
}

async function readJson(request: IncomingMessage, maximumBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ResumeProfileError(415, "Send browser helper changes as JSON.");
  }
  const announcedLength = Number(request.headers["content-length"]);
  if (Number.isFinite(announcedLength) && announcedLength > maximumBytes) {
    throw new ResumeProfileError(413, "The browser helper request is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk)
      : Buffer.isBuffer(chunk) ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maximumBytes) throw new ResumeProfileError(413, "The browser helper request is too large.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ResumeProfileError(400, "The browser helper request must contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResumeProfileError(400, "The browser helper request must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ResumeProfileError(400, `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized) throw new ResumeProfileError(400, `${label} is required.`);
  if (normalized.length > max) throw new ResumeProfileError(400, `${label} is too long.`);
  return normalized;
}

function assertExpectedAccount(request: IncomingMessage, userId: string): void {
  const expectedAccountId = request.headers["x-scout-account-id"];
  if (expectedAccountId === undefined) return;
  if (typeof expectedAccountId !== "string" || !expectedAccountId) {
    throw new ResumeProfileError(400, "X-Scout-Account-Id must contain the connected Scout account id.");
  }
  if (expectedAccountId !== userId) {
    throw new ResumeProfileError(409, "The signed-in Scout account changed. Reload Scout and reconnect before saving.");
  }
}

function normalizeError(error: unknown): { status: number; message: string } {
  if (error instanceof ResumeProfileError || error instanceof AuthHttpError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof ResumeProfileStorageError) {
    return { status: 503, message: "The saved browser helper profile is temporarily unavailable. Try again in a moment." };
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    const message = (error as { message?: unknown }).message;
    if (typeof status === "number" && status >= 400 && status <= 599 && typeof message === "string") {
      return { status, message };
    }
  }
  return { status: 500, message: "Scout could not complete the browser helper request. Try again." };
}

function latestDate(...values: Array<string | null | undefined>): string | null {
  const dates = values.filter((value): value is string => Boolean(value));
  return dates.length ? dates.toSorted().at(-1)! : null;
}

function profileRowIdentityMatches(
  candidate: Record<string, unknown>,
  prior: Record<string, unknown>,
  identityFields: readonly string[],
): boolean {
  let hasIdentity = false;
  for (const field of identityFields) {
    const candidateValue = candidate[field];
    const priorValue = prior[field];
    if (typeof candidateValue !== "string" || typeof priorValue !== "string") return false;
    const normalizedCandidate = normalizeQuestion(candidateValue);
    const normalizedPrior = normalizeQuestion(priorValue);
    if (normalizedCandidate !== normalizedPrior) return false;
    if (normalizedCandidate) hasIdentity = true;
  }
  return hasIdentity;
}

function preserveOmittedRowFields(
  candidateRows: unknown,
  priorRows: readonly Record<string, unknown>[],
  identityFields: readonly string[],
  additiveFields: readonly string[],
): unknown {
  if (!Array.isArray(candidateRows)) return candidateRows;
  const rows = candidateRows as unknown[];
  return rows.map((candidateValue: unknown) => {
    if (!candidateValue || typeof candidateValue !== "object" || Array.isArray(candidateValue)) return candidateValue;
    const candidate = { ...candidateValue as Record<string, unknown> };
    const matches = priorRows.filter((prior) => profileRowIdentityMatches(candidate, prior, identityFields));
    if (matches.length !== 1) return candidate;
    const prior = matches[0]!;
    for (const field of additiveFields) {
      if (!Object.hasOwn(candidate, field)) candidate[field] = prior[field];
    }
    return candidate;
  });
}

/** Preserve additive profile fields for older clients without assigning values to a different record. */
function preserveOmittedProfileAdditions(
  candidateProfile: unknown,
  priorProfile: ReturnType<typeof browserHelperProfileSchema.parse> | undefined,
): unknown {
  if (!candidateProfile || typeof candidateProfile !== "object" || Array.isArray(candidateProfile) || !priorProfile) {
    return candidateProfile;
  }
  const candidate = { ...candidateProfile as Record<string, unknown> };
  for (const field of [
    "phoneType", "phoneCountryCode", "phoneExtension", "referralSources", "previousWorker",
    "hasPreferredName", "preferredFirstName", "preferredLastName", "websites", "languages", "experienceCount",
  ] as const) {
    if (!Object.hasOwn(candidate, field)) candidate[field] = priorProfile[field];
  }
  candidate.education = preserveOmittedRowFields(
    candidate.education,
    priorProfile.education,
    ["school", "degree", "fieldOfStudy", "startDate", "endDate"],
    ["gradeAverage"],
  );
  candidate.experience = preserveOmittedRowFields(
    candidate.experience,
    priorProfile.experience,
    ["company", "title", "startDate", "endDate", "description"],
    ["location", "currentlyWorkHere"],
  );
  candidate.languages = preserveOmittedRowFields(
    candidate.languages,
    priorProfile.languages,
    ["language"],
    ["fluent", "comprehension", "overall", "reading", "speaking", "writing"],
  );
  return candidate;
}

/** Handles private, account-scoped browser helper APIs. */
export async function handleBrowserHelperRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
  options: HandlerOptions = {},
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname !== PROFILE_PATH && pathname !== ANSWERS_PATH && pathname !== APPLICATIONS_PATH && pathname !== WRITTEN_DRAFT_PATH) return false;

  try {
    if (pathname === PROFILE_PATH && (request.method === "GET" || request.method === "HEAD")) {
      const identity = await resolveResumeProfileIdentity(request, response);
      const state = readBrowserHelperState(databasePath, identity.userId);
      const resumeProfile = state.profile ? null : readResumeProfile(databasePath, identity.userId);
      const profile = state.profile
        ? browserHelperProfileSchema.parse(state.profile.profile)
        : seedBrowserHelperProfile(resumeProfile?.resume ?? null, identity.email);
      const csrfToken = identity.context && !identity.local
        ? ensureCsrfToken(request, identity.context.config, identity.context.responseState)
        : undefined;
      applyAuthCookies(identity, response);
      writeJson(response, 200, {
        contract: "scout.browser-helper.v1",
        accountId: identity.userId,
        profileSaved: state.profile !== null,
        profile,
        answers: state.answers,
        updatedAt: latestDate(state.updatedAt, resumeProfile?.updatedAt),
        ...(csrfToken ? { csrfToken } : {}),
      }, request.method === "HEAD");
      return true;
    }

    if (pathname === PROFILE_PATH && request.method === "PUT") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      assertExpectedAccount(request, identity.userId);
      applyAuthCookies(identity, response);
      const body = await readJson(request);
      const priorState = readBrowserHelperState(databasePath, identity.userId);
      const priorProfile = priorState.profile ? browserHelperProfileSchema.parse(priorState.profile.profile) : undefined;
      const profileInput = preserveOmittedProfileAdditions(body.profile, priorProfile);
      const parsed = browserHelperProfileSchema.safeParse(profileInput);
      if (!parsed.success) throw new ResumeProfileError(400, "The browser helper profile contains invalid or unsupported fields.");
      const profile = saveBrowserHelperProfile(databasePath, identity.userId, parsed.data);
      const state = readBrowserHelperState(databasePath, identity.userId);
      applyAuthCookies(identity, response);
      writeJson(response, 200, {
        contract: "scout.browser-helper.v1",
        accountId: identity.userId,
        profileSaved: true,
        profile: profile.profile,
        answers: state.answers,
        updatedAt: state.updatedAt,
      });
      return true;
    }

    if (pathname === ANSWERS_PATH && request.method === "PUT") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      assertExpectedAccount(request, identity.userId);
      applyAuthCookies(identity, response);
      const body = await readJson(request);
      const question = requiredText(body.question, "question", 1_000);
      const normalizedQuestion = normalizeQuestion(question);
      if (!normalizedQuestion) throw new ResumeProfileError(400, "question is required.");
      const answerFields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "question"));
      const candidate = body.answerType === undefined ? { ...answerFields, answerType: "text" } : answerFields;
      const answerValue = browserHelperAnswerValueSchema.safeParse(candidate);
      if (!answerValue.success) {
        throw new ResumeProfileError(400, "Choose a valid answer type and enter the matching answer or exact selections.");
      }
      const saved = saveBrowserHelperAnswer(databasePath, identity.userId, randomUUID(), normalizedQuestion, question, answerValue.data);
      applyAuthCookies(identity, response);
      writeJson(response, 200, { answer: saved });
      return true;
    }

    if (pathname === ANSWERS_PATH && request.method === "DELETE") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      assertExpectedAccount(request, identity.userId);
      applyAuthCookies(identity, response);
      const body = await readJson(request);
      const id = requiredText(body.id, "id", 64);
      const deleted = deleteBrowserHelperAnswer(databasePath, identity.userId, id);
      applyAuthCookies(identity, response);
      writeJson(response, 200, { deleted, id });
      return true;
    }

    if (pathname === APPLICATIONS_PATH && request.method === "POST") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      assertExpectedAccount(request, identity.userId);
      applyAuthCookies(identity, response);
      if (identity.local) throw new ResumeProfileError(403, "Log in with a verified account before recording applications.");
      const body = await readJson(request);
      if (body.confirmedSubmitted !== true) {
        throw new ResumeProfileError(400, "Confirm that the application was submitted before recording it.");
      }
      const company = requiredText(body.company, "company", 500);
      const title = requiredText(body.title, "title", 500);
      const applicationUrl = requiredText(body.applicationUrl, "applicationUrl", 2_000);
      const location = body.location === undefined ? undefined : requiredText(body.location, "location", 500);
      let listingType: "internship" | "grind" | undefined;
      if (body.listingType !== undefined) {
        if (body.listingType !== "internship" && body.listingType !== "grind") {
          throw new ResumeProfileError(400, "listingType must be internship or grind.");
        }
        listingType = body.listingType;
      }
      const listingId = body.listingId === undefined ? undefined : requiredText(body.listingId, "listingId", 255);
      if (Boolean(listingId) !== Boolean(listingType)) {
        throw new ResumeProfileError(400, "listingType and listingId must be provided together.");
      }
      if (!options.logApplication) throw new ResumeProfileError(503, "Application tracking is temporarily unavailable.");
      const logged = await options.logApplication(identity.userId, {
        company,
        title,
        applicationUrl,
        ...(location ? { location } : {}),
        ...(listingType ? { listingType } : {}),
        ...(listingId ? { listingId } : {}),
        confirmedSubmitted: true,
      });
      applyAuthCookies(identity, response);
      writeJson(response, 200, { logged: true, listingKey: logged.listingKey, alreadyLogged: logged.alreadyLogged });
      return true;
    }

    if (pathname === WRITTEN_DRAFT_PATH && request.method === "POST") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      assertExpectedAccount(request, identity.userId);
      applyAuthCookies(identity, response);
      if (identity.local) throw new ResumeProfileError(403, "Sign in with a verified account before asking Luna to draft an application response.");
      const body = await readJson(request, 96 * 1024);
      const savedResume = readResumeProfile(databasePath, identity.userId);
      const generated = await generateBrowserHelperWrittenDraft(identity.userId, databasePath, savedResume?.resume ?? null, savedResume?.updatedAt ?? null, body);
      const latestIdentity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      assertExpectedAccount(request, latestIdentity.userId);
      if (latestIdentity.local || latestIdentity.userId !== identity.userId) {
        throw new ResumeProfileError(409, "The signed-in Scout account changed while Luna was drafting. Reconnect and try again.");
      }
      const latestResume = readResumeProfile(databasePath, identity.userId);
      if ((latestResume?.updatedAt ?? null) !== (savedResume?.updatedAt ?? null)) {
        throw new ResumeProfileError(409, "The saved resume changed while Luna was drafting. Refresh the profile and try again.");
      }
      applyAuthCookies(latestIdentity, response);
      writeJson(response, 200, {
        ...generated.value,
        requestId: generated.requestId,
        applicationUrl: generated.applicationUrl,
      });
      return true;
    }

    writeJson(response, 405, { error: "Use GET or PUT on the profile, PUT or DELETE on answers, and POST for submitted applications or written drafts." });
    return true;
  } catch (error) {
    const mapped = normalizeError(error);
    writeJson(response, mapped.status, { error: mapped.message });
    return true;
  }
}
