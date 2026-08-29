import type { IncomingMessage } from "node:http";
import { createServerClient } from "@supabase/ssr";
import type { AuthError, User } from "@supabase/supabase-js";

import { createSupabaseCookieMethods } from "./http.js";
import {
  AuthProviderError,
  type AuthConfig,
  type AuthGateway,
  type AuthResponseState,
  type AuthSignUpResult,
  type AuthUser,
} from "./types.js";

function metadataDisplayName(user: User): string | undefined {
  const metadata = user.user_metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  for (const key of ["full_name", "name", "display_name", "user_name", "preferred_username"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().replace(/\s+/g, " ");
    if (normalized) return normalized.slice(0, 120);
  }
  return undefined;
}

function publicUser(user: User): AuthUser {
  const displayName = metadataDisplayName(user);
  return {
    id: user.id,
    email: user.email ?? "",
    ...(displayName ? { displayName } : {}),
    emailVerified: Boolean(user.email_confirmed_at ?? user.confirmed_at),
    createdAt: user.created_at,
  };
}

function providerError(error: AuthError): AuthProviderError {
  return new AuthProviderError(error.code ?? "provider_error", error.message, error.status ?? 500);
}

function sessionMissing(error: AuthError): boolean {
  return error.name === "AuthSessionMissingError"
    || error.code === "session_not_found"
    || /auth session missing/i.test(error.message);
}

export function createSupabaseAuthGateway(
  request: IncomingMessage,
  config: AuthConfig,
  responseState: AuthResponseState,
): AuthGateway {
  const client = createServerClient(config.supabaseUrl, config.publishableKey, {
    cookieOptions: {
      path: "/",
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "lax",
      maxAge: 400 * 24 * 60 * 60,
    },
    cookies: createSupabaseCookieMethods(request, config, responseState),
    cookieEncoding: "base64url",
  });

  return {
    async getCurrentUser() {
      const { data, error } = await client.auth.getUser();
      if (error) {
        if (sessionMissing(error)) return null;
        throw providerError(error);
      }
      return data.user ? publicUser(data.user) : null;
    },
    async signUp({ email, password, redirectTo }): Promise<AuthSignUpResult> {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) throw providerError(error);
      return {
        user: data.user ? publicUser(data.user) : null,
        sessionCreated: data.session !== null,
        duplicatePossible: Boolean(data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0),
      };
    },
    async signIn({ email, password }) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw providerError(error);
      if (!data.user) throw new AuthProviderError("user_missing", "The provider did not return a user.", 500);
      return publicUser(data.user);
    },
    async resendVerification({ email, redirectTo }) {
      const { error } = await client.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) throw providerError(error);
    },
    async requestPasswordReset({ email, redirectTo }) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw providerError(error);
    },
    async verifyToken({ tokenHash, type }) {
      const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) throw providerError(error);
      if (!data.user) throw new AuthProviderError("user_missing", "The verification link did not return a user.", 400);
      return publicUser(data.user);
    },
    async exchangeCode({ code, flowId }) {
      const options = flowId ? { flowId } : undefined;
      const { data, error } = await client.auth.exchangeCodeForSession(code, options);
      if (error) throw providerError(error);
      if (!data.user) throw new AuthProviderError("user_missing", "The authentication link did not return a user.", 400);
      return publicUser(data.user);
    },
    async updatePassword(password) {
      const { data, error } = await client.auth.updateUser({ password });
      if (error) throw providerError(error);
      if (!data.user) throw new AuthProviderError("user_missing", "The provider did not return a user.", 500);
      return publicUser(data.user);
    },
    async signOut(scope) {
      const { error } = await client.auth.signOut({ scope });
      if (error && !sessionMissing(error)) throw providerError(error);
    },
  };
}
