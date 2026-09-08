import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { AuthConfigurationError } from "../auth/config.js";
import { providerErrorToHttp } from "../auth/errors.js";
import {
  AuthHttpError,
  createAuthResponseState,
  redirectAuthResponse,
  writeAuthJson,
  writeAuthResponse,
} from "../auth/http.js";
import { createAuthRequestContext, getSessionUser } from "../auth/router.js";
import type { AuthConfig, AuthRequestContext, AuthUser } from "../auth/types.js";
import { sha256 } from "../utils/hash.js";
import {
  OWNER_ANALYTICS_CONTRACT,
  isOwnerAnalyticsUser,
  parseOwnerAnalyticsRange,
  readOwnerAnalyticsConfig,
  readOwnerAnalyticsSnapshot,
  type OwnerAnalyticsConfig,
} from "./owner.js";

const PROJECT_ROOT = resolve(process.env.INTERNSHIPMATIC_ROOT ?? process.cwd());
const OWNER_ANALYTICS_PAGE_PATH = join(PROJECT_ROOT, "public", "owner-analytics.html");
const OWNER_ANALYTICS_CSS_PATH = join(PROJECT_ROOT, "public", "owner-analytics.css");
const OWNER_ANALYTICS_SCRIPT_PATH = join(PROJECT_ROOT, "public", "owner-analytics.js");
const OWNER_ANALYTICS_PAGE_ROUTES = new Set(["/owner/analytics", "/owner/analytics/"]);
const OWNER_ANALYTICS_API_PATH = "/api/owner/analytics";

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

function analyticsErrorPayload(error: AuthHttpError): Record<string, unknown> {
  return {
    contract: OWNER_ANALYTICS_CONTRACT,
    ok: false,
    error: { code: error.code, message: error.message },
  };
}

function writeAnalyticsError(
  response: ServerResponse,
  error: AuthHttpError,
  context: Pick<AuthRequestContext, "config" | "responseState">,
): void {
  writeAuthJson(response, error.status, analyticsErrorPayload(error), context.config, context.responseState);
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

function notFound(
  response: ServerResponse,
  context: Pick<AuthRequestContext, "config" | "responseState">,
  api: boolean,
): void {
  const error = new AuthHttpError(404, "NOT_FOUND", "Not found.");
  if (api) {
    writeAnalyticsError(response, error, context);
  } else {
    writeAuthResponse(response, 404, "Not found.", "text/plain; charset=utf-8", context.config, context.responseState);
  }
}

async function createOwnerContext(
  request: IncomingMessage,
  response: ServerResponse,
  api: boolean,
): Promise<{ context: AuthRequestContext; user: AuthUser } | null> {
  let context: AuthRequestContext;
  try {
    context = createAuthRequestContext(request);
  } catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    const fallback = fallbackResponseConfig(request);
    const mapped = new AuthHttpError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured on this Scout server.");
    if (api) writeAuthJson(response, mapped.status, analyticsErrorPayload(mapped), fallback, createAuthResponseState());
    else writeAuthResponse(response, mapped.status, mapped.message, "text/plain; charset=utf-8", fallback, createAuthResponseState());
    return null;
  }

  let user: AuthUser | null;
  try {
    user = await getSessionUser(context);
  } catch (error) {
    const mapped = providerErrorToHttp(error, "session");
    if (api) writeAnalyticsError(response, mapped, context);
    else writeAuthResponse(response, mapped.status, mapped.message, "text/plain; charset=utf-8", context.config, context.responseState);
    return null;
  }

  if (!user) {
    if (api) writeAnalyticsError(response, new AuthHttpError(401, "AUTH_REQUIRED", "Log in to view owner analytics."), context);
    else redirectAuthResponse(response, "/login?next=%2Fowner%2Fanalytics", context.config, context.responseState);
    return null;
  }
  if (!user.emailVerified) {
    if (api) writeAnalyticsError(response, new AuthHttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email before viewing owner analytics."), context);
    else redirectAuthResponse(response, "/verify-email", context.config, context.responseState);
    return null;
  }

  const ownerConfig = readOwnerAnalyticsConfig();
  // Owner analytics is an administrative surface. Bind it to the immutable
  // Supabase user id; an email-only setting can be reclaimed after deletion.
  if (!ownerConfig.ownerUserId || !isOwnerAnalyticsUser(user, ownerConfig)) {
    notFound(response, context, api);
    return null;
  }
  return { context, user };
}

async function handleOwnerAnalyticsApi(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const config = fallbackResponseConfig(request);
    writeAuthJson(response, 405, analyticsErrorPayload(new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Only GET is supported for owner analytics.")), config, createAuthResponseState());
    return;
  }
  const access = await createOwnerContext(request, response, true);
  if (!access) return;

  const ownerConfig: OwnerAnalyticsConfig = readOwnerAnalyticsConfig();
  const rangeDays = parseOwnerAnalyticsRange(requestUrl.searchParams.get("range"));
  if (!ownerConfig.serviceRoleKey) {
    writeAuthJson(response, 200, {
      contract: OWNER_ANALYTICS_CONTRACT,
      ok: true,
      status: "not_configured",
      configured: false,
      rangeDays,
      message: "Add SUPABASE_SERVICE_ROLE_KEY on the server to read account analytics.",
    }, access.context.config, access.context.responseState, {}, request.method === "HEAD");
    return;
  }

  try {
    const snapshot = await readOwnerAnalyticsSnapshot({
      supabaseUrl: access.context.config.supabaseUrl,
      serviceRoleKey: ownerConfig.serviceRoleKey,
    }, rangeDays);
    writeAuthJson(response, 200, {
      contract: OWNER_ANALYTICS_CONTRACT,
      ok: true,
      configured: true,
      viewer: { email: access.user.email },
      ...snapshot,
    }, access.context.config, access.context.responseState, {}, request.method === "HEAD");
  } catch {
    writeAnalyticsError(response, new AuthHttpError(503, "ANALYTICS_UNAVAILABLE", "Analytics data is temporarily unavailable. Try again in a moment."), access.context);
  }
}

async function serveOwnerAnalyticsPage(
  request: IncomingMessage,
  response: ServerResponse,
  access: { context: AuthRequestContext; user: AuthUser },
): Promise<void> {
  const [template, css, script] = await Promise.all([
    readFile(OWNER_ANALYTICS_PAGE_PATH, "utf8"),
    readFile(OWNER_ANALYTICS_CSS_PATH, "utf8"),
    readFile(OWNER_ANALYTICS_SCRIPT_PATH, "utf8"),
  ]);
  const body = template
    .replaceAll("__OWNER_EMAIL__", htmlEscape(access.user.email))
    .replaceAll("__OWNER_ANALYTICS_CSS_VERSION__", sha256(css).slice(0, 12))
    .replaceAll("__OWNER_ANALYTICS_SCRIPT_VERSION__", sha256(script).slice(0, 12));
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

export async function handleOwnerAnalyticsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<boolean> {
  const isApi = requestUrl.pathname === OWNER_ANALYTICS_API_PATH;
  const isPage = OWNER_ANALYTICS_PAGE_ROUTES.has(requestUrl.pathname);
  if (!isApi && !isPage) return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const config = fallbackResponseConfig(request);
    const message = isApi ? "Only GET is supported for owner analytics." : "Only GET is supported for the owner analytics page.";
    if (isApi) writeAuthJson(response, 405, analyticsErrorPayload(new AuthHttpError(405, "METHOD_NOT_ALLOWED", message)), config, createAuthResponseState());
    else writeAuthResponse(response, 405, message, "text/plain; charset=utf-8", config, createAuthResponseState());
    return true;
  }

  try {
    if (isApi) await handleOwnerAnalyticsApi(request, response, requestUrl);
    else {
      const access = await createOwnerContext(request, response, false);
      if (access) await serveOwnerAnalyticsPage(request, response, access);
    }
  } catch (error) {
    if (response.headersSent || response.writableEnded) return true;
    const context = (() => {
      try { return createAuthRequestContext(request); } catch { return null; }
    })();
    if (context) {
      writeAnalyticsError(response, new AuthHttpError(503, "ANALYTICS_UNAVAILABLE", "Owner analytics is temporarily unavailable."), context);
    } else {
      const config = fallbackResponseConfig(request);
      writeAuthResponse(response, 503, "Owner analytics is temporarily unavailable.", "text/plain; charset=utf-8", config, createAuthResponseState());
    }
    void error;
  }
  return true;
}
