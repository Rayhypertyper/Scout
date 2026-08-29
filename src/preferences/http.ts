import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { AuthConfigurationError } from "../auth/config.js";
import { providerErrorToHttp } from "../auth/errors.js";
import {
  AuthHttpError,
  assertCsrfToken,
  assertSameOrigin,
  createAuthResponseState,
  ensureCsrfToken,
  readAuthJson,
  redirectAuthResponse,
  writeAuthJson,
  writeAuthResponse,
} from "../auth/http.js";
import { createAuthRequestContext, getSessionUser, safePostLoginReturnPath } from "../auth/router.js";
import type { AuthConfig, AuthRequestContext, AuthUser } from "../auth/types.js";
import { sha256 } from "../utils/hash.js";
import {
  PreferenceValidationError,
  preferenceOptions,
  type InternshipPreferences,
} from "./schema.js";
import {
  PreferenceStorageError,
  readInternshipPreferences,
  saveInternshipPreferenceStep,
} from "./store.js";

const PROJECT_ROOT = resolve(process.env.INTERNSHIPMATIC_ROOT ?? process.cwd());
const ONBOARDING_PUBLIC_ROOT = join(PROJECT_ROOT, "public", "onboarding");
const ONBOARDING_PAGE_PATH = join(ONBOARDING_PUBLIC_ROOT, "onboarding.html");
const PREFERENCE_PAGE_ROUTES = new Set(["/onboarding", "/preferences"]);
const ALL_INTERNSHIPS_PATH = "/jobs?view=all&tab=main&sort=posted";

export interface AuthenticatedPreferences {
  context: AuthRequestContext;
  user: AuthUser;
  preferences: InternshipPreferences;
}

function fallbackResponseConfig(request: IncomingMessage): AuthConfig {
  const host = request.headers.host?.trim() || "127.0.0.1:4173";
  let siteUrl: URL;
  try {
    siteUrl = new URL(`http://${host}`);
  } catch {
    siteUrl = new URL("http://127.0.0.1:4173");
  }
  return {
    supabaseUrl: "http://127.0.0.1",
    publishableKey: "unconfigured",
    siteUrl,
    secureCookies: false,
    trustProxy: false,
  };
}

function preferenceErrorPayload(error: AuthHttpError, issues: PreferenceValidationError["issues"] = []): Record<string, unknown> {
  return {
    contract: "preferences.v1",
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
      ...(issues.length > 0 ? { issues } : {}),
    },
  };
}

function writePreferenceError(
  response: ServerResponse,
  error: AuthHttpError,
  context: Pick<AuthRequestContext, "config" | "responseState">,
  issues: PreferenceValidationError["issues"] = [],
): void {
  writeAuthJson(
    response,
    error.status,
    preferenceErrorPayload(error, issues),
    context.config,
    context.responseState,
    error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
  );
}

function preferenceStorageError(): AuthHttpError {
  return new AuthHttpError(
    503,
    "PREFERENCES_UNAVAILABLE",
    "Internship preferences are temporarily unavailable. Try again in a moment.",
  );
}

function preferenceOperationError(error: unknown): AuthHttpError {
  if (error instanceof AuthHttpError) return error;
  // Preference persistence is local application state.  It must not be
  // reported as an auth-provider outage (or leak SQLite details).
  if (error instanceof PreferenceStorageError) return preferenceStorageError();
  return preferenceStorageError();
}

function unconfiguredApiResponse(request: IncomingMessage, response: ServerResponse): void {
  const config = fallbackResponseConfig(request);
  writeAuthJson(response, 503, {
    contract: "preferences.v1",
    ok: false,
    error: {
      code: "AUTH_NOT_CONFIGURED",
      message: "Authentication is not configured on this Scout server.",
    },
  }, config, createAuthResponseState());
}

async function authenticatedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
  options: { api: boolean; intendedPath: string },
): Promise<AuthenticatedPreferences | null> {
  let context: AuthRequestContext;
  try {
    context = createAuthRequestContext(request);
  } catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    if (options.api) unconfiguredApiResponse(request, response);
    else redirectAuthResponse(
      response,
      `/login?next=${encodeURIComponent(options.intendedPath)}`,
      fallbackResponseConfig(request),
      createAuthResponseState(),
    );
    return null;
  }

  let user: AuthUser | null;
  try {
    // Read the server-verified current account.  Keep an unconfirmed account
    // distinct so it can be sent to verification without treating it as
    // trusted for preference data.
    user = await getSessionUser(context);
  } catch (error) {
    const mapped = providerErrorToHttp(error, "session");
    if (options.api) writePreferenceError(response, mapped, context);
    else writeAuthResponse(
      response,
      mapped.status,
      mapped.message,
      "text/plain; charset=utf-8",
      context.config,
      context.responseState,
    );
    return null;
  }

  if (!user || !user.emailVerified) {
    if (options.api) {
      writePreferenceError(
        response,
        user
          ? new AuthHttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email before managing internship preferences.", { field: "email" })
          : new AuthHttpError(401, "AUTH_REQUIRED", "Log in to manage internship preferences."),
        context,
      );
    } else {
      redirectAuthResponse(response, user
        ? "/verify-email"
        : `/login?next=${encodeURIComponent(options.intendedPath)}`, context.config, context.responseState);
    }
    return null;
  }

  let preferences: InternshipPreferences;
  try {
    preferences = readInternshipPreferences(databasePath, user.id);
  } catch (error) {
    const mapped = preferenceOperationError(error);
    if (options.api) writePreferenceError(response, mapped, context);
    else writeAuthResponse(response, mapped.status, mapped.message, "text/plain; charset=utf-8", context.config, context.responseState);
    return null;
  }

  return {
    context,
    user,
    preferences,
  };
}

async function servePreferencePage(
  request: IncomingMessage,
  response: ServerResponse,
  access: AuthenticatedPreferences,
  mode: "onboarding" | "edit",
): Promise<void> {
  const [template, css, script, selectorScript] = await Promise.all([
    readFile(ONBOARDING_PAGE_PATH, "utf8"),
    readFile(join(ONBOARDING_PUBLIC_ROOT, "onboarding.css"), "utf8"),
    readFile(join(ONBOARDING_PUBLIC_ROOT, "onboarding.js"), "utf8"),
    readFile(join(ONBOARDING_PUBLIC_ROOT, "multi-select.js"), "utf8"),
  ]);
  const body = template
    .replaceAll("__PREFERENCE_MODE__", mode)
    .replaceAll("__PREFERENCE_TITLE__", mode === "edit" ? "Edit Preferences — Scout" : "Set Preferences — Scout")
    .replaceAll("__PREFERENCE_CSS_VERSION__", sha256(css).slice(0, 12))
    .replaceAll("__PREFERENCE_SCRIPT_VERSION__", sha256(script).slice(0, 12))
    .replaceAll("__MULTI_SELECT_VERSION__", sha256(selectorScript).slice(0, 12));
  writeAuthResponse(
    response,
    200,
    body,
    "text/html; charset=utf-8",
    access.context.config,
    access.context.responseState,
    {},
    request.method === "HEAD",
  );
}

async function handlePreferencePage(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  databasePath: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const config = fallbackResponseConfig(request);
    writeAuthJson(response, 405, preferenceErrorPayload(new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Only GET is supported for preference pages.")), config, createAuthResponseState());
    return;
  }
  const intendedPath = `${requestUrl.pathname}${requestUrl.search}`;
  const access = await authenticatedRequest(request, response, databasePath, { api: false, intendedPath });
  if (!access) return;
  if (requestUrl.pathname === "/onboarding" && access.preferences.onboardingCompleted) {
    redirectAuthResponse(response, ALL_INTERNSHIPS_PATH, access.context.config, access.context.responseState);
    return;
  }
  if (requestUrl.pathname === "/preferences" && !access.preferences.onboardingCompleted) {
    redirectAuthResponse(response, "/onboarding", access.context.config, access.context.responseState);
    return;
  }
  await servePreferencePage(request, response, access, requestUrl.pathname === "/preferences" ? "edit" : "onboarding");
}

async function handlePostLogin(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  databasePath: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const config = fallbackResponseConfig(request);
    writeAuthJson(response, 405, preferenceErrorPayload(new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Only GET is supported after login.")), config, createAuthResponseState());
    return;
  }
  const access = await authenticatedRequest(request, response, databasePath, {
    api: false,
    intendedPath: `${requestUrl.pathname}${requestUrl.search}`,
  });
  if (!access) return;
  const returnTo = safePostLoginReturnPath(requestUrl.searchParams.get("returnTo"));
  redirectAuthResponse(
    response,
    access.preferences.onboardingCompleted ? (returnTo ?? ALL_INTERNSHIPS_PATH) : "/onboarding",
    access.context.config,
    access.context.responseState,
  );
}

async function handleJobsEntry(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  databasePath: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const requestedView = requestUrl.searchParams.get("view");
  let context: AuthRequestContext;
  try {
    context = createAuthRequestContext(request);
  } catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    if (requestedView !== "matches") return false;
    redirectAuthResponse(
      response,
      `/login?next=${encodeURIComponent(`${requestUrl.pathname}${requestUrl.search}`)}`,
      fallbackResponseConfig(request),
      createAuthResponseState(),
    );
    return true;
  }

  let user: AuthUser | null;
  try {
    // Match-view entry is protected just like preference APIs; do not let an
    // unverified pre-confirmation session reach account-specific data.
    user = await getSessionUser(context);
  } catch (error) {
    if (requestedView !== "matches") return false;
    const mapped = providerErrorToHttp(error, "session");
    writeAuthResponse(response, mapped.status, mapped.message, "text/plain; charset=utf-8", context.config, context.responseState);
    return true;
  }
  if (!user || !user.emailVerified) {
    if (requestedView !== "matches") return false;
    redirectAuthResponse(response, user
      ? "/verify-email"
      : `/login?next=${encodeURIComponent(`${requestUrl.pathname}${requestUrl.search}`)}`, context.config, context.responseState);
    return true;
  }

  // An explicitly requested all-internships view remains public.  Only the
  // implicit jobs entry and the matches view participate in onboarding gates.
  if (requestedView === "all") return false;

  let preferences: InternshipPreferences;
  try {
    preferences = readInternshipPreferences(databasePath, user.id);
  } catch {
    writeAuthResponse(
      response,
      503,
      "Internship preferences are temporarily unavailable. Try again in a moment.",
      "text/plain; charset=utf-8",
      context.config,
      context.responseState,
    );
    return true;
  }
  if (!preferences.onboardingCompleted) {
    redirectAuthResponse(response, "/onboarding", context.config, context.responseState);
    return true;
  }
  if (requestedView === null) {
    const destination = new URL(requestUrl.toString());
    destination.searchParams.set("view", "all");
    destination.searchParams.set("tab", "main");
    destination.searchParams.set("sort", "posted");
    redirectAuthResponse(response, `${destination.pathname}${destination.search}`, context.config, context.responseState);
    return true;
  }
  return false;
}

async function handlePreferenceApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  databasePath: string,
): Promise<void> {
  const access = await authenticatedRequest(request, response, databasePath, {
    api: true,
    intendedPath: `${requestUrl.pathname}${requestUrl.search}`,
  });
  if (!access) return;

  if (requestUrl.pathname === "/api/preferences") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      writePreferenceError(response, new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Use GET to read internship preferences."), access.context);
      return;
    }
    const csrfToken = ensureCsrfToken(request, access.context.config, access.context.responseState);
    writeAuthJson(response, 200, {
      contract: "preferences.v1",
      ok: true,
      preferences: access.preferences,
      options: preferenceOptions(),
      csrfToken,
    }, access.context.config, access.context.responseState, {}, request.method === "HEAD");
    return;
  }

  const stepMatch = /^\/api\/preferences\/steps\/([123])$/.exec(requestUrl.pathname);
  if (!stepMatch?.[1]) {
    writePreferenceError(response, new AuthHttpError(404, "NOT_FOUND", "Preference action not found."), access.context);
    return;
  }
  if (request.method !== "PUT") {
    writePreferenceError(response, new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Use PUT to save this preference step."), access.context);
    return;
  }

  try {
    assertSameOrigin(request, access.context.config);
    assertCsrfToken(request);
    const body = await readAuthJson(request);
    const step = Number(stepMatch[1]) as 1 | 2 | 3;
    const preferences = saveInternshipPreferenceStep(databasePath, access.user.id, step, body);
    writeAuthJson(response, 200, {
      contract: "preferences.v1",
      ok: true,
      savedStep: step,
      preferences,
      ...(step === 3 ? { redirect: ALL_INTERNSHIPS_PATH } : {}),
    }, access.context.config, access.context.responseState);
  } catch (error) {
    if (error instanceof PreferenceValidationError) {
      writePreferenceError(
        response,
        new AuthHttpError(422, "PREFERENCES_INVALID", error.message, error.issues[0]?.field
          ? { field: error.issues[0].field }
          : {}),
        access.context,
        error.issues,
      );
      return;
    }
    const mapped = preferenceOperationError(error);
    writePreferenceError(response, mapped, access.context);
  }
}

export async function loadAuthenticatedMatchPreferences(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<AuthenticatedPreferences | null> {
  const access = await authenticatedRequest(request, response, databasePath, {
    api: true,
    intendedPath: "/jobs?view=matches",
  });
  if (!access) return null;
  if (!access.preferences.onboardingCompleted) {
    writePreferenceError(
      response,
      new AuthHttpError(409, "ONBOARDING_REQUIRED", "Complete your preferences before loading matches."),
      access.context,
    );
    return null;
  }
  return access;
}

export async function handlePreferenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  databasePath: string,
): Promise<boolean> {
  const pathname = requestUrl.pathname;
  if (PREFERENCE_PAGE_ROUTES.has(pathname)) {
    await handlePreferencePage(request, response, requestUrl, databasePath);
    return true;
  }
  if (pathname === "/post-login") {
    await handlePostLogin(request, response, requestUrl, databasePath);
    return true;
  }
  if (pathname === "/jobs" || pathname === "/jobs/") {
    return handleJobsEntry(request, response, requestUrl, databasePath);
  }
  if (pathname === "/api/preferences" || pathname.startsWith("/api/preferences/")) {
    await handlePreferenceApi(request, response, requestUrl, databasePath);
    return true;
  }
  return false;
}
