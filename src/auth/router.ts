import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { sha256 } from "../utils/hash.js";
import { AuthConfigurationError, readAuthConfig } from "./config.js";
import { isNeutralAccountStateError, providerErrorToHttp } from "./errors.js";
import {
  AuthHttpError,
  assertCsrfToken,
  assertSameOrigin,
  clearRecoveryGrant,
  createAuthResponseState,
  ensureCsrfToken,
  hasRecoveryGrant,
  readAuthJson,
  redirectAuthResponse,
  requestIp,
  safeReturnPath,
  setRecoveryGrant,
  writeAuthJson,
  writeAuthResponse,
} from "./http.js";
import { createSupabaseAuthGateway } from "./provider.js";
import { consumeAuthRateLimit } from "./rateLimit.js";
import type {
  AuthConfig,
  AuthGatewayFactory,
  AuthRequestContext,
  AuthResponseState,
  AuthUser,
} from "./types.js";
import { confirmedStrongPassword, loginPassword, normalizedEmail } from "./validation.js";

const PROJECT_ROOT = resolve(process.env.INTERNSHIPMATIC_ROOT ?? process.cwd());
const AUTH_PUBLIC_ROOT = join(PROJECT_ROOT, "public", "auth");
const AUTH_PAGE_PATH = join(AUTH_PUBLIC_ROOT, "auth.html");
const AUTH_PAGE_ROUTES = new Set(["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/account"]);
const POST_LOGIN_DENYLIST = new Set(["/login", "/signup", "/verify-email", "/forgot-password", "/auth/callback"]);
const ALLOWED_EMAIL_TOKEN_TYPES = new Set(["signup", "email", "recovery", "invite", "magiclink"]);

interface AuthPageMetadata {
  title: string;
  description: string;
  label: string;
}

const AUTH_PAGE_METADATA: Record<string, AuthPageMetadata> = {
  "/login": {
    title: "Log In — Scout",
    description: "Log in to keep your Scout opportunity workspace in sync.",
    label: "Login",
  },
  "/signup": {
    title: "Create Account — Scout",
    description: "Create a Scout account for saved roles, watchlists, and application progress.",
    label: "Create Account",
  },
  "/verify-email": {
    title: "Verify Email — Scout",
    description: "Verify the email address connected to your Scout account.",
    label: "Email Verification",
  },
  "/forgot-password": {
    title: "Recover Access — Scout",
    description: "Request secure password reset instructions for Scout.",
    label: "Account Recovery",
  },
  "/reset-password": {
    title: "Set New Password — Scout",
    description: "Set a new password for your Scout account.",
    label: "Password Reset",
  },
  "/account": {
    title: "Your Account — Scout",
    description: "Review your Scout account and authentication status.",
    label: "Account",
  },
};

let authGatewayFactoryForTests: AuthGatewayFactory | null = null;

export function setAuthGatewayFactoryForTests(factory: AuthGatewayFactory | null): void {
  authGatewayFactoryForTests = factory;
}

function fallbackResponseConfig(request: IncomingMessage): AuthConfig {
  void request;
  return {
    supabaseUrl: "http://127.0.0.1",
    publishableKey: "unconfigured",
    siteUrl: new URL("http://127.0.0.1:4173"),
    secureCookies: false,
    trustProxy: false,
  };
}

export function createAuthRequestContext(request: IncomingMessage): AuthRequestContext {
  const config = readAuthConfig();
  const responseState = createAuthResponseState();
  const factory = authGatewayFactoryForTests ?? createSupabaseAuthGateway;
  return {
    request,
    config,
    responseState,
    gateway: factory(request, config, responseState),
  };
}

/**
 * Return the server-verified, email-confirmed user for protected routes.
 *
 * Route handlers must use this instead of trusting a client-provided user,
 * decoded session payload, or a Supabase `getSession()` result. `getUser()` is
 * called by the gateway and Supabase refresh cookies are accumulated on the
 * request context so the caller can write them on its response.
 */
export async function getTrustedUser(context: AuthRequestContext): Promise<AuthUser | null> {
  const user = await currentUser(context);
  return user?.emailVerified ? user : null;
}

/**
 * Return the server-verified current account, including an account that still
 * needs email confirmation.  Callers must not use an unconfirmed account for
 * protected application data; the distinction is useful when routing that
 * account to the existing verification experience.
 */
export async function getSessionUser(context: AuthRequestContext): Promise<AuthUser | null> {
  return currentUser(context);
}

export async function requireTrustedUser(context: AuthRequestContext): Promise<AuthUser> {
  const user = await getTrustedUser(context);
  if (!user) throw new AuthHttpError(401, "AUTH_REQUIRED", "Log in with a verified email address to continue.");
  return user;
}

/**
 * The only post-login return target that needs to survive the onboarding gate
 * today is the account page.  Keep this allowlist narrow so a query parameter
 * cannot become an open redirect or a post-login loop.
 */
export function safePostLoginReturnPath(value: unknown): string | null {
  const path = safeReturnPath(value, "");
  if (!path) return null;
  const pathname = new URL(path, "https://roleradar.invalid").pathname;
  return pathname === "/account" ? path : null;
}

function safePostLoginPath(value: unknown): string {
  const path = safeReturnPath(value, "/post-login");
  const parsed = new URL(path, "https://roleradar.invalid");
  const pathname = parsed.pathname;
  if (pathname === "/account") {
    return `/post-login?returnTo=${encodeURIComponent(path)}`;
  }
  if (pathname === "/post-login") {
    const returnTo = safePostLoginReturnPath(parsed.searchParams.get("returnTo"));
    return returnTo ? `/post-login?returnTo=${encodeURIComponent(returnTo)}` : "/post-login";
  }
  return POST_LOGIN_DENYLIST.has(pathname) ? "/post-login" : path;
}

function callbackUrl(config: AuthConfig, next: string): string {
  const callback = new URL("/auth/callback", config.siteUrl);
  callback.searchParams.set("next", safePostLoginPath(next));
  return callback.toString();
}

function rateLimit(
  context: AuthRequestContext,
  action: string,
  identifier: string,
  perIpLimit: number,
  perIdentifierLimit: number,
  windowMs: number,
): void {
  const ip = requestIp(context.request, context.config);
  const ipResult = consumeAuthRateLimit(action, ip, "*", perIpLimit, windowMs);
  const identifierResult = consumeAuthRateLimit(action, ip, identifier, perIdentifierLimit, windowMs);
  const retryAfter = Math.max(ipResult.retryAfter, identifierResult.retryAfter);
  if (!ipResult.allowed || !identifierResult.allowed) {
    throw new AuthHttpError(429, "RATE_LIMITED", `Too many attempts. Try again in ${retryAfter} seconds.`, { retryAfter });
  }
}

function errorPayload(error: AuthHttpError): Record<string, unknown> {
  return {
    contract: "auth.v1",
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    },
  };
}

function sendError(response: ServerResponse, error: AuthHttpError, config: AuthConfig, state: AuthResponseState): void {
  writeAuthJson(
    response,
    error.status,
    errorPayload(error),
    config,
    state,
    error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
  );
}

async function configuredContextOrResponse(
  request: IncomingMessage,
  response: ServerResponse,
  allowPage: boolean,
): Promise<AuthRequestContext | null> {
  try {
    return createAuthRequestContext(request);
  } catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    const config = fallbackResponseConfig(request);
    const state = createAuthResponseState();
    if (allowPage) return null;
    writeAuthJson(response, 503, {
      contract: "auth.v1",
      ok: false,
      configured: false,
      error: {
        code: "AUTH_NOT_CONFIGURED",
        message: "Authentication is not configured on this Scout server.",
      },
    }, config, state);
    return null;
  }
}

async function serveAuthPage(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  config: AuthConfig,
  state: AuthResponseState,
): Promise<void> {
  const metadata = AUTH_PAGE_METADATA[pathname];
  if (!metadata) throw new AuthHttpError(404, "NOT_FOUND", "Page not found.");
  const [template, css, pageScript, clientScript] = await Promise.all([
    readFile(AUTH_PAGE_PATH, "utf8"),
    readFile(join(AUTH_PUBLIC_ROOT, "auth.css"), "utf8"),
    readFile(join(AUTH_PUBLIC_ROOT, "auth-page.js"), "utf8"),
    readFile(join(AUTH_PUBLIC_ROOT, "auth-client.js"), "utf8"),
  ]);
  const body = template
    .replaceAll("__AUTH_ROUTE__", pathname)
    .replaceAll("__AUTH_TITLE__", metadata.title)
    .replaceAll("__AUTH_DESCRIPTION__", metadata.description)
    .replaceAll("__AUTH_LABEL__", metadata.label)
    .replaceAll("__AUTH_CSS_VERSION__", sha256(css).slice(0, 12))
    .replaceAll("__AUTH_PAGE_VERSION__", sha256(pageScript).slice(0, 12))
    .replaceAll("__AUTH_CLIENT_VERSION__", sha256(clientScript).slice(0, 12));
  writeAuthResponse(
    response,
    200,
    body,
    "text/html; charset=utf-8",
    config,
    state,
    {},
    request.method === "HEAD",
  );
}

async function currentUser(context: AuthRequestContext, operation: "session" | "reset" = "session"): Promise<AuthUser | null> {
  try {
    return await context.gateway.getCurrentUser();
  } catch (error) {
    throw providerErrorToHttp(error, operation);
  }
}

async function handleAuthPageRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const config = (() => {
      try { return readAuthConfig(); } catch { return fallbackResponseConfig(request); }
    })();
    sendError(response, new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Only GET is supported for authentication pages."), config, createAuthResponseState());
    return;
  }

  const context = await configuredContextOrResponse(request, response, true);
  if (!context && requestUrl.pathname === "/account") {
    writeAuthJson(response, 503, {
      contract: "auth.v1",
      ok: false,
      configured: false,
      error: {
        code: "AUTH_NOT_CONFIGURED",
        message: "Authentication is not configured on this Scout server.",
      },
    }, fallbackResponseConfig(request), createAuthResponseState());
    return;
  }
  if (!context) {
    await serveAuthPage(request, response, requestUrl.pathname, fallbackResponseConfig(request), createAuthResponseState());
    return;
  }

  let user: AuthUser | null;
  try {
    user = await currentUser(context);
  } catch (error) {
    if (requestUrl.pathname === "/account") {
      sendError(response, providerErrorToHttp(error, "session"), context.config, context.responseState);
      return;
    }
    await serveAuthPage(request, response, requestUrl.pathname, context.config, context.responseState);
    return;
  }
  const publicEntry = requestUrl.pathname === "/login" || requestUrl.pathname === "/signup" || requestUrl.pathname === "/forgot-password" || requestUrl.pathname === "/verify-email";
  if (user?.emailVerified && publicEntry) {
    redirectAuthResponse(response, safePostLoginPath(requestUrl.searchParams.get("next")), context.config, context.responseState);
    return;
  }
  if (!user && requestUrl.pathname === "/account") {
    const intended = `${requestUrl.pathname}${requestUrl.search}`;
    redirectAuthResponse(response, `/login?next=${encodeURIComponent(intended)}`, context.config, context.responseState);
    return;
  }
  if (user && !user.emailVerified && requestUrl.pathname === "/account") {
    redirectAuthResponse(response, "/verify-email", context.config, context.responseState);
    return;
  }
  await serveAuthPage(request, response, requestUrl.pathname, context.config, context.responseState);
}

function callbackFailureLocation(reason: string, recovery: boolean): string {
  const route = recovery ? "/forgot-password" : "/verify-email";
  return `${route}?status=error&reason=${encodeURIComponent(reason)}`;
}

async function handleCallback(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> {
  const context = await configuredContextOrResponse(request, response, false);
  if (!context) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendError(response, new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Only GET is supported for authentication callbacks."), context.config, context.responseState);
    return;
  }

  const next = safePostLoginPath(requestUrl.searchParams.get("next"));
  const type = requestUrl.searchParams.get("type") ?? "";
  const resetDestination = new URL(next, "https://roleradar.invalid").pathname === "/reset-password";
  // Token-hash links carry their flow type explicitly. Never let a signup,
  // invite, or email-confirmation token become a password-recovery grant just
  // because an attacker supplied `next=/reset-password`.
  const recovery = type === "recovery" || (!requestUrl.searchParams.has("token_hash") && resetDestination);
  const providerError = requestUrl.searchParams.get("error_code") ?? requestUrl.searchParams.get("error");
  if (providerError) {
    redirectAuthResponse(response, callbackFailureLocation(providerError === "otp_expired" ? "expired" : "invalid", recovery), context.config, context.responseState);
    return;
  }

  try {
    const tokenHash = requestUrl.searchParams.get("token_hash");
    const code = requestUrl.searchParams.get("code");
    let callbackUser: AuthUser;
    if (tokenHash && ALLOWED_EMAIL_TOKEN_TYPES.has(type)) {
      callbackUser = await context.gateway.verifyToken({ tokenHash, type });
    } else if (code) {
      const flowId = requestUrl.searchParams.get("sb_flow_id") ?? undefined;
      callbackUser = await context.gateway.exchangeCode({ code, ...(flowId ? { flowId } : {}) });
    } else {
      throw new AuthHttpError(400, "LINK_INVALID", "The authentication link is missing required information.");
    }
    if (recovery) {
      if (!callbackUser.emailVerified) throw new AuthHttpError(400, "LINK_INVALID", "The password reset link is invalid or has expired.");
      setRecoveryGrant(context.config, context.responseState);
    }
    const destination = recovery ? "/reset-password?ready=1" : next;
    redirectAuthResponse(response, destination, context.config, context.responseState);
  } catch (error) {
    const mapped = providerErrorToHttp(error, "callback");
    redirectAuthResponse(
      response,
      callbackFailureLocation(mapped.code === "LINK_INVALID" ? "expired" : "invalid", recovery),
      context.config,
      context.responseState,
    );
  }
}

function assertMutationRequest(request: IncomingMessage, config: AuthConfig): void {
  if (request.method !== "POST") throw new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Use POST for this authentication action.");
  assertSameOrigin(request, config);
  assertCsrfToken(request);
}

async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const config = (() => {
      try { return readAuthConfig(); } catch { return fallbackResponseConfig(request); }
    })();
    sendError(response, new AuthHttpError(405, "METHOD_NOT_ALLOWED", "Only GET is supported for authentication state."), config, createAuthResponseState());
    return;
  }
  let context: AuthRequestContext;
  try {
    context = createAuthRequestContext(request);
  } catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    const config = fallbackResponseConfig(request);
    const state = createAuthResponseState();
    const csrfToken = ensureCsrfToken(request, config, state);
    writeAuthJson(response, 200, {
      contract: "auth.v1",
      ok: true,
      configured: false,
      authenticated: false,
      user: null,
      recoveryReady: false,
      csrfToken,
    }, config, state, {}, request.method === "HEAD");
    return;
  }

  const csrfToken = ensureCsrfToken(request, context.config, context.responseState);
  try {
    const user = await currentUser(context);
    writeAuthJson(response, 200, {
      contract: "auth.v1",
      ok: true,
      configured: true,
      authenticated: Boolean(user?.emailVerified),
      user: user?.emailVerified ? user : null,
      recoveryReady: Boolean(user?.emailVerified) && hasRecoveryGrant(request),
      csrfToken,
    }, context.config, context.responseState, {}, request.method === "HEAD");
  } catch (error) {
    const mapped = error instanceof AuthHttpError ? error : providerErrorToHttp(error, "session");
    writeAuthJson(response, mapped.status, {
      ...errorPayload(mapped),
      configured: true,
      authenticated: false,
      user: null,
      recoveryReady: false,
      csrfToken,
    }, context.config, context.responseState);
  }
}

async function handleSignup(context: AuthRequestContext, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
  const email = normalizedEmail(body);
  const password = confirmedStrongPassword(body);
  rateLimit(context, "signup", email, 20, 5, 60 * 60_000);
  const next = safePostLoginPath(body.next);
  try {
    const result = await context.gateway.signUp({ email, password, redirectTo: callbackUrl(context.config, next) });
    const verified = Boolean(result.user?.emailVerified && result.sessionCreated);
    if (!verified && result.sessionCreated) {
      // Some Supabase projects allow a session before email confirmation. Do
      // not leave that session usable while the UI is waiting for verification.
      await context.gateway.signOut("local");
    }
    writeAuthJson(response, 200, {
      contract: "auth.v1",
      ok: true,
      requiresVerification: !verified,
      authenticated: verified,
      redirect: verified ? next : "/verify-email",
      message: verified
        ? "Your account is ready."
        : "Check your email to verify the account. If the address is already registered, the existing account has not been changed.",
    }, context.config, context.responseState);
  } catch (error) {
    if (isNeutralAccountStateError(error)) {
      writeAuthJson(response, 200, {
        contract: "auth.v1",
        ok: true,
        requiresVerification: true,
        authenticated: false,
        redirect: "/verify-email",
        message: "Check your email for the next step. If the address is already registered, the existing account has not been changed.",
      }, context.config, context.responseState);
      return;
    }
    throw providerErrorToHttp(error, "signup");
  }
}

async function handleLogin(context: AuthRequestContext, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
  const email = normalizedEmail(body);
  const password = loginPassword(body);
  rateLimit(context, "login", email, 50, 10, 10 * 60_000);
  try {
    const user = await context.gateway.signIn({ email, password });
    if (!user.emailVerified) {
      await context.gateway.signOut("local");
      throw new AuthHttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email before logging in. You can resend the message below.", { field: "email" });
    }
    writeAuthJson(response, 200, {
      contract: "auth.v1",
      ok: true,
      authenticated: true,
      user,
      redirect: safePostLoginPath(body.next),
    }, context.config, context.responseState);
  } catch (error) {
    throw providerErrorToHttp(error, "login");
  }
}

async function handleResend(context: AuthRequestContext, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
  const email = normalizedEmail(body);
  rateLimit(context, "resend", email, 12, 3, 15 * 60_000);
  try {
    await context.gateway.resendVerification({ email, redirectTo: callbackUrl(context.config, "/post-login") });
  } catch (error) {
    if (!isNeutralAccountStateError(error)) throw providerErrorToHttp(error, "resend");
  }
  writeAuthJson(response, 200, {
    contract: "auth.v1",
    ok: true,
    cooldownSeconds: 60,
    message: "If verification is still needed, a new email is on its way.",
  }, context.config, context.responseState);
}

async function handleForgotPassword(context: AuthRequestContext, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
  const email = normalizedEmail(body);
  rateLimit(context, "forgot", email, 20, 5, 60 * 60_000);
  try {
    await context.gateway.requestPasswordReset({
      email,
      redirectTo: callbackUrl(context.config, "/reset-password"),
    });
  } catch (error) {
    if (!isNeutralAccountStateError(error)) throw providerErrorToHttp(error, "forgot");
  }
  writeAuthJson(response, 200, {
    contract: "auth.v1",
    ok: true,
    message: "If an account exists for that email, password reset instructions are on the way.",
  }, context.config, context.responseState);
}

async function handleResetPassword(context: AuthRequestContext, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
  if (!hasRecoveryGrant(context.request)) {
    throw new AuthHttpError(403, "RESET_LINK_INVALID", "This reset link is invalid or has expired. Request a new one to continue.");
  }
  const user = await currentUser(context, "reset");
  if (!user?.emailVerified) throw new AuthHttpError(401, "RESET_LINK_INVALID", "This reset link is invalid or has expired. Request a new one to continue.");
  const password = confirmedStrongPassword(body);
  rateLimit(context, "reset", user.id, 10, 5, 15 * 60_000);
  try {
    await context.gateway.updatePassword(password);
    await context.gateway.signOut("global");
  } catch (error) {
    throw providerErrorToHttp(error, "reset");
  }
  clearRecoveryGrant(context.config, context.responseState);
  writeAuthJson(response, 200, {
    contract: "auth.v1",
    ok: true,
    redirect: "/login?reset=success",
    message: "Your password has been updated. Log in with the new password.",
  }, context.config, context.responseState);
}

async function handleLogout(context: AuthRequestContext, response: ServerResponse): Promise<void> {
  rateLimit(context, "logout", "session", 30, 30, 10 * 60_000);
  try {
    await context.gateway.signOut("local");
  } catch (error) {
    throw providerErrorToHttp(error, "logout");
  }
  clearRecoveryGrant(context.config, context.responseState);
  writeAuthJson(response, 200, {
    contract: "auth.v1",
    ok: true,
    authenticated: false,
    redirect: "/",
  }, context.config, context.responseState);
}

async function handleMutation(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const context = await configuredContextOrResponse(request, response, false);
  if (!context) return;
  try {
    assertMutationRequest(request, context.config);
    const body = await readAuthJson(request);
    if (pathname === "/api/auth/signup") await handleSignup(context, body, response);
    else if (pathname === "/api/auth/login") await handleLogin(context, body, response);
    else if (pathname === "/api/auth/resend-verification") await handleResend(context, body, response);
    else if (pathname === "/api/auth/forgot-password") await handleForgotPassword(context, body, response);
    else if (pathname === "/api/auth/reset-password") await handleResetPassword(context, body, response);
    else if (pathname === "/api/auth/logout") await handleLogout(context, response);
    else throw new AuthHttpError(404, "NOT_FOUND", "Authentication action not found.");
  } catch (error) {
    const mapped = error instanceof AuthHttpError ? error : providerErrorToHttp(error, "session");
    sendError(response, mapped, context.config, context.responseState);
  }
}

export async function handleAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<boolean> {
  try {
    const pathname = requestUrl.pathname;
    if (AUTH_PAGE_ROUTES.has(pathname)) {
      await handleAuthPageRequest(request, response, requestUrl);
      return true;
    }
    if (pathname === "/auth/callback") {
      await handleCallback(request, response, requestUrl);
      return true;
    }
    if (pathname === "/api/auth/session") {
      await handleSession(request, response);
      return true;
    }
    if (pathname.startsWith("/api/auth/")) {
      await handleMutation(request, response, pathname);
      return true;
    }
    return false;
  } catch (error) {
    // Auth routes must never let a malformed provider/configuration response
    // escape into the dashboard's unhandled-request path.
    const config = (() => {
      try { return readAuthConfig(); } catch { return fallbackResponseConfig(request); }
    })();
    if (!response.headersSent && !response.writableEnded) {
      sendError(response, providerErrorToHttp(error, "session"), config, createAuthResponseState());
    }
    return true;
  }
}
