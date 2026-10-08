import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthConfigurationError } from "../auth/config.js";
import { providerErrorToHttp } from "../auth/errors.js";
import { AuthHttpError, assertCsrfToken, assertSameOrigin, createAuthResponseState, writeAuthJson } from "../auth/http.js";
import { createAuthRequestContext, getSessionUser } from "../auth/router.js";
import type { AuthRequestContext } from "../auth/types.js";

export async function dashboardAccountAccess(
  request: IncomingMessage,
  response: ServerResponse,
  required: boolean,
): Promise<{ userId: string | null; context?: AuthRequestContext } | null> {
  let context: AuthRequestContext | undefined;
  try {
    if (!request.headers.cookie) {
      if (!required) return { userId: null };
      throw new AuthHttpError(401, "AUTH_REQUIRED", "Log in to manage applications.");
    }
    context = createAuthRequestContext(request);
    const user = await getSessionUser(context);
    if (!user || !user.emailVerified) {
      if (!required) return { userId: null, context };
      throw new AuthHttpError(user ? 403 : 401, user ? "EMAIL_NOT_VERIFIED" : "AUTH_REQUIRED",
        user ? "Verify your email before managing applications." : "Log in to manage applications.");
    }
    if (required && request.method !== "GET" && request.method !== "HEAD") {
      assertSameOrigin(request, context.config);
      assertCsrfToken(request);
    }
    return { userId: user.id, context };
  } catch (error) {
    // An all-roles request can remain public when auth is not configured. It
    // still uses an empty account scope, never the offline decision store.
    if (!required && error instanceof AuthConfigurationError) return { userId: null };
    const mapped = error instanceof AuthHttpError ? error
      : error instanceof AuthConfigurationError
        ? new AuthHttpError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured on this Scout server.")
        : providerErrorToHttp(error, "session");
    writeAuthJson(response, mapped.status, { error: { code: mapped.code, message: mapped.message } },
      context?.config ?? {
        supabaseUrl: "http://127.0.0.1", publishableKey: "unconfigured",
        siteUrl: new URL("http://127.0.0.1:4173"), secureCookies: false, trustProxy: false,
      }, context?.responseState ?? createAuthResponseState(), {}, request.method === "HEAD");
    return null;
  }
}
