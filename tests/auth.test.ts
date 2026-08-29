import type { IncomingMessage, ServerResponse } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseCookies } from "../src/auth/http.js";
import { resetAuthRateLimitsForTests } from "../src/auth/rateLimit.js";
import { AuthProviderError, type AuthGateway, type AuthGatewayFactory, type AuthUser } from "../src/auth/types.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string | string[]>): void;
  end(body?: Buffer | string): void;
}

interface FakeAccount {
  user: AuthUser;
  password: string;
}

interface FakeProviderState {
  accounts: Map<string, FakeAccount>;
  sessions: Map<string, string>;
  verificationRedirects: string[];
  resetRedirects: string[];
  resendCount: number;
  lastSignOutScope: "local" | "global" | null;
}

function response(): CapturedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    },
  };
}

function request(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    ...(body === undefined ? {} : {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield JSON.stringify(body);
      },
    }),
  } as unknown as IncomingMessage;
}

function responsePayload(captured: CapturedResponse): Record<string, unknown> {
  return JSON.parse(captured.body.toString("utf8")) as Record<string, unknown>;
}

function setCookies(captured: CapturedResponse): string[] {
  const value = captured.headers["Set-Cookie"];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function mergeCookieHeader(...values: Array<string | string[]>): string {
  const cookies = new Map<string, string>();
  for (const entry of values) {
    const pairs = Array.isArray(entry)
      ? entry.map((value) => value.split(";", 1)[0]?.trim() ?? "")
      : entry.split(";").map((value) => value.trim());
    for (const pair of pairs) {
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function testUser(email: string, verified: boolean): AuthUser {
  return {
    id: `user-${email}`,
    email,
    emailVerified: verified,
    createdAt: "2026-08-23T12:00:00.000Z",
  };
}

function fakeProviderFactory(state: FakeProviderState): AuthGatewayFactory {
  return (incoming, _config, responseState): AuthGateway => {
    const cookies = parseCookies(incoming);
    const currentEmail = (() => {
      const token = cookies.get("rr-test-session");
      return token ? state.sessions.get(token) ?? null : null;
    })();
    const establishSession = (email: string): void => {
      const token = `session-${email}`;
      state.sessions.set(token, email);
      responseState.cookies.push(`rr-test-session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
    };
    return {
      async getCurrentUser() {
        return currentEmail ? state.accounts.get(currentEmail)?.user ?? null : null;
      },
      async signUp({ email, password, redirectTo }) {
        state.verificationRedirects.push(redirectTo);
        if (state.accounts.has(email)) throw new AuthProviderError("user_already_exists", "User exists", 422);
        const account = { user: testUser(email, false), password };
        state.accounts.set(email, account);
        return { user: account.user, sessionCreated: false, duplicatePossible: false };
      },
      async signIn({ email, password }) {
        const account = state.accounts.get(email);
        if (!account || account.password !== password) throw new AuthProviderError("invalid_credentials", "Invalid credentials", 400);
        if (!account.user.emailVerified) throw new AuthProviderError("email_not_confirmed", "Email not confirmed", 400);
        establishSession(email);
        return account.user;
      },
      async resendVerification({ email, redirectTo }) {
        state.resendCount += 1;
        state.verificationRedirects.push(redirectTo);
        if (!state.accounts.has(email)) throw new AuthProviderError("user_not_found", "Not found", 404);
      },
      async requestPasswordReset({ email, redirectTo }) {
        state.resetRedirects.push(redirectTo);
        if (!state.accounts.has(email)) throw new AuthProviderError("user_not_found", "Not found", 404);
      },
      async verifyToken({ tokenHash, type }) {
        const email = tokenHash === "recovery-token" ? "verified@example.com" : "student@example.com";
        if ((tokenHash !== "verify-token" && tokenHash !== "recovery-token") || (type !== "signup" && type !== "recovery")) {
          throw new AuthProviderError("otp_expired", "Expired", 403);
        }
        const account = state.accounts.get(email);
        if (!account) throw new AuthProviderError("user_not_found", "Not found", 404);
        account.user = { ...account.user, emailVerified: true };
        establishSession(email);
        return account.user;
      },
      async exchangeCode({ code }) {
        if (code !== "valid-code") throw new AuthProviderError("flow_state_expired", "Expired", 400);
        const account = state.accounts.get("verified@example.com");
        if (!account) throw new AuthProviderError("user_not_found", "Not found", 404);
        establishSession(account.user.email);
        return account.user;
      },
      async updatePassword(password) {
        if (!currentEmail) throw new AuthProviderError("session_not_found", "Missing session", 401);
        const account = state.accounts.get(currentEmail);
        if (!account) throw new AuthProviderError("user_not_found", "Not found", 404);
        account.password = password;
        return account.user;
      },
      async signOut(scope) {
        state.lastSignOutScope = scope;
        if (currentEmail) {
          for (const [token, email] of state.sessions) {
            if (email === currentEmail && (scope === "global" || token === cookies.get("rr-test-session"))) state.sessions.delete(token);
          }
        }
        responseState.cookies.push("rr-test-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      },
    };
  };
}

describe("authentication", () => {
  let handleAuthRequest: typeof import("../src/auth/router.js").handleAuthRequest;
  let setAuthGatewayFactoryForTests: typeof import("../src/auth/router.js").setAuthGatewayFactoryForTests;
  let state: FakeProviderState;
  const previousEnvironment = {
    supabaseUrl: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    siteUrl: process.env.AUTH_SITE_URL,
  };

  beforeAll(async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    process.env.AUTH_SITE_URL = "http://127.0.0.1:4173";
    ({ handleAuthRequest, setAuthGatewayFactoryForTests } = await import("../src/auth/router.js"));
  });

  beforeEach(() => {
    resetAuthRateLimitsForTests();
    state = {
      accounts: new Map([
        ["student@example.com", { user: testUser("student@example.com", false), password: "Internship2026" }],
        ["verified@example.com", { user: testUser("verified@example.com", true), password: "Internship2026" }],
      ]),
      sessions: new Map(),
      verificationRedirects: [],
      resetRedirects: [],
      resendCount: 0,
      lastSignOutScope: null,
    };
    setAuthGatewayFactoryForTests(fakeProviderFactory(state));
  });

  afterAll(() => {
    setAuthGatewayFactoryForTests(null);
    if (previousEnvironment.supabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousEnvironment.supabaseUrl;
    if (previousEnvironment.publishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = previousEnvironment.publishableKey;
    if (previousEnvironment.siteUrl === undefined) delete process.env.AUTH_SITE_URL;
    else process.env.AUTH_SITE_URL = previousEnvironment.siteUrl;
  });

  async function dispatch(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<CapturedResponse> {
    const captured = response();
    const handled = await handleAuthRequest(
      request(method, url, headers, body),
      captured as unknown as ServerResponse,
      new URL(url, "http://127.0.0.1:4173"),
    );
    expect(handled).toBe(true);
    return captured;
  }

  async function csrfSession(cookie = ""): Promise<{ token: string; cookies: string }> {
    const captured = await dispatch("GET", "/api/auth/session", cookie ? { cookie } : {});
    const payload = responsePayload(captured);
    expect(captured.statusCode).toBe(200);
    return {
      token: payload.csrfToken as string,
      cookies: mergeCookieHeader(cookie, setCookies(captured)),
    };
  }

  function mutationHeaders(csrf: { token: string; cookies: string }, extra: Record<string, string> = {}): Record<string, string> {
    return {
      origin: "http://127.0.0.1:4173",
      "content-type": "application/json",
      "x-csrf-token": csrf.token,
      cookie: csrf.cookies,
      ...extra,
    };
  }

  it("reports missing configuration without exposing a server error", async () => {
    delete process.env.SUPABASE_URL;
    const captured = await dispatch("GET", "/api/auth/session");
    const payload = responsePayload(captured);
    expect(captured.statusCode).toBe(200);
    expect(payload.configured).toBe(false);
    expect(payload.authenticated).toBe(false);
    expect(payload.csrfToken).toEqual(expect.any(String));
    process.env.SUPABASE_URL = "https://example.supabase.co";
  });

  it("creates an unverified account and sends it into the verification flow", async () => {
    const csrf = await csrfSession();
    const captured = await dispatch("POST", "/api/auth/signup", mutationHeaders(csrf), {
      email: "new.student@example.com",
      password: "Internship2027",
      confirmPassword: "Internship2027",
      next: "/account",
    });
    const payload = responsePayload(captured);
    expect(captured.statusCode).toBe(200);
    expect(payload.requiresVerification).toBe(true);
    expect(payload.redirect).toBe("/verify-email");
    expect(state.accounts.get("new.student@example.com")?.user.emailVerified).toBe(false);
    expect(state.verificationRedirects[0]).toContain("/auth/callback?next=%2Fpost-login%3FreturnTo%3D%252Faccount");
  });

  it("clears a provider-created pre-confirmation session before showing verification", async () => {
    const baseFactory = fakeProviderFactory(state);
    setAuthGatewayFactoryForTests((incoming, config, responseState) => {
      const gateway = baseFactory(incoming, config, responseState);
      return {
        ...gateway,
        async signUp(input) {
          const result = await gateway.signUp(input);
          return { ...result, sessionCreated: true };
        },
      };
    });
    const csrf = await csrfSession();
    const captured = await dispatch("POST", "/api/auth/signup", mutationHeaders(csrf), {
      email: "preconfirm@example.com",
      password: "Internship2027",
      confirmPassword: "Internship2027",
    });
    expect(captured.statusCode).toBe(200);
    expect(responsePayload(captured).requiresVerification).toBe(true);
    expect(state.lastSignOutScope).toBe("local");
    setAuthGatewayFactoryForTests(fakeProviderFactory(state));
  });

  it("handles duplicate registration without revealing whether the account exists", async () => {
    const csrf = await csrfSession();
    const captured = await dispatch("POST", "/api/auth/signup", mutationHeaders(csrf), {
      email: "student@example.com",
      password: "Internship2027",
      confirmPassword: "Internship2027",
    });
    const payload = responsePayload(captured);
    expect(captured.statusCode).toBe(200);
    expect(payload.requiresVerification).toBe(true);
    expect(payload.message).toContain("existing account has not been changed");
  });

  it("returns useful unverified-login feedback and supports a neutral resend", async () => {
    const csrf = await csrfSession();
    const login = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "student@example.com",
      password: "Internship2026",
    });
    const loginPayload = responsePayload(login);
    expect(login.statusCode).toBe(403);
    expect((loginPayload.error as Record<string, unknown>).code).toBe("EMAIL_NOT_VERIFIED");

    const resend = await dispatch("POST", "/api/auth/resend-verification", mutationHeaders(csrf), {
      email: "unknown@example.com",
    });
    expect(resend.statusCode).toBe(200);
    expect(responsePayload(resend).message).toContain("If verification is still needed");
  });

  it("verifies an email callback and establishes a persistent session cookie", async () => {
    const callback = await dispatch("GET", "/auth/callback?token_hash=verify-token&type=signup&next=%2Faccount");
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.Location).toBe("/post-login?returnTo=%2Faccount");
    const cookie = mergeCookieHeader(setCookies(callback));
    expect(cookie).toContain("rr-test-session=");
    expect(state.accounts.get("student@example.com")?.user.emailVerified).toBe(true);

    const session = await dispatch("GET", "/api/auth/session", { cookie });
    const payload = responsePayload(session);
    expect(payload.authenticated).toBe(true);
    expect((payload.user as Record<string, unknown>).email).toBe("student@example.com");
  });

  it("does not turn a non-recovery token into a password-reset grant", async () => {
    const callback = await dispatch("GET", "/auth/callback?token_hash=verify-token&type=signup&next=%2Freset-password");
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.Location).toBe("/reset-password");
    const sessionCookie = mergeCookieHeader(setCookies(callback));
    expect(sessionCookie).not.toContain("rr-recovery=");

    const csrf = await csrfSession(sessionCookie);
    const reset = await dispatch("POST", "/api/auth/reset-password", mutationHeaders(csrf), {
      password: "NewInternship2027",
      confirmPassword: "NewInternship2027",
    });
    expect(reset.statusCode).toBe(403);
    expect((responsePayload(reset).error as Record<string, unknown>).code).toBe("RESET_LINK_INVALID");
    expect(state.accounts.get("student@example.com")?.password).toBe("Internship2026");
  });

  it("fails closed for an unverified session on the protected account route", async () => {
    state.sessions.set("session-student@example.com", "student@example.com");
    const account = await dispatch("GET", "/account", { cookie: "rr-test-session=session-student%40example.com" });
    expect(account.statusCode).toBe(303);
    expect(account.headers.Location).toBe("/verify-email");
  });

  it("logs in a verified account, preserves safe destinations, and blocks open redirects", async () => {
    const csrf = await csrfSession();
    const safeLogin = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "verified@example.com",
      password: "Internship2026",
      next: "/account?from=saved",
    });
    expect(responsePayload(safeLogin).redirect).toBe("/post-login?returnTo=%2Faccount%3Ffrom%3Dsaved");
    expect(mergeCookieHeader(setCookies(safeLogin))).toContain("rr-test-session=");

    const unsafeLogin = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "verified@example.com",
      password: "Internship2026",
      next: "//evil.example/phish",
    });
    expect(responsePayload(unsafeLogin).redirect).toBe("/post-login");

    const allInternships = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "verified@example.com",
      password: "Internship2026",
      next: "/jobs?view=all",
    });
    expect(responsePayload(allInternships).redirect).toBe("/jobs?view=all");

    const loopTarget = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "verified@example.com",
      password: "Internship2026",
      next: "/post-login?returnTo=%2Fpost-login",
    });
    expect(responsePayload(loopTarget).redirect).toBe("/post-login");
  });

  it("protects the account route while keeping auth pages server-rendered", async () => {
    const anonymous = await dispatch("GET", "/account");
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.Location).toBe("/login?next=%2Faccount");

    const csrf = await csrfSession();
    const login = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "verified@example.com",
      password: "Internship2026",
    });
    const cookie = mergeCookieHeader(setCookies(login));
    const account = await dispatch("GET", "/account", { cookie });
    expect(account.statusCode).toBe(200);
    expect(account.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(account.body.toString("utf8")).toContain("Your Search Workspace.");
  });

  it("fails closed instead of rendering a protected page during provider outage", async () => {
    const baseFactory = fakeProviderFactory(state);
    setAuthGatewayFactoryForTests((incoming, config, responseState) => {
      const gateway = baseFactory(incoming, config, responseState);
      return {
        ...gateway,
        async getCurrentUser() {
          throw new AuthProviderError("request_timeout", "provider unavailable", 503);
        },
      };
    });
    const account = await dispatch("GET", "/account");
    expect(account.statusCode).toBe(503);
    expect((responsePayload(account).error as Record<string, unknown>).code).toBe("AUTH_UNAVAILABLE");
    expect(account.body.toString("utf8")).not.toContain("Your Search Workspace.");
    setAuthGatewayFactoryForTests(fakeProviderFactory(state));
  });

  it("keeps password recovery neutral for unknown accounts", async () => {
    const csrf = await csrfSession();
    const known = await dispatch("POST", "/api/auth/forgot-password", mutationHeaders(csrf), { email: "verified@example.com" });
    const unknown = await dispatch("POST", "/api/auth/forgot-password", mutationHeaders(csrf), { email: "unknown@example.com" });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(responsePayload(known).message).toBe(responsePayload(unknown).message);
    expect(state.resetRedirects[0]).toContain("next=%2Freset-password");
  });

  it("requires a valid recovery callback before updating the password", async () => {
    const initialCsrf = await csrfSession();
    const invalid = await dispatch("POST", "/api/auth/reset-password", mutationHeaders(initialCsrf), {
      password: "NewInternship2027",
      confirmPassword: "NewInternship2027",
    });
    expect(invalid.statusCode).toBe(403);
    expect((responsePayload(invalid).error as Record<string, unknown>).code).toBe("RESET_LINK_INVALID");

    const callback = await dispatch("GET", "/auth/callback?token_hash=recovery-token&type=recovery&next=%2Freset-password");
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.Location).toBe("/reset-password?ready=1");
    const recoveryCookies = mergeCookieHeader(initialCsrf.cookies, setCookies(callback));
    const csrf = await csrfSession(recoveryCookies);
    const reset = await dispatch("POST", "/api/auth/reset-password", mutationHeaders(csrf), {
      password: "NewInternship2027",
      confirmPassword: "NewInternship2027",
    });
    expect(reset.statusCode).toBe(200);
    expect(responsePayload(reset).redirect).toBe("/login?reset=success");
    expect(state.accounts.get("verified@example.com")?.password).toBe("NewInternship2027");
    expect(state.lastSignOutScope).toBe("global");
  });

  it("rejects invalid forms, missing CSRF tokens, and cross-origin mutations", async () => {
    const csrf = await csrfSession();
    const mismatch = await dispatch("POST", "/api/auth/signup", mutationHeaders(csrf), {
      email: "student2@example.com",
      password: "Internship2027",
      confirmPassword: "Different2027",
    });
    expect(mismatch.statusCode).toBe(422);
    expect((responsePayload(mismatch).error as Record<string, unknown>).code).toBe("PASSWORD_MISMATCH");

    const missingCsrf = await dispatch("POST", "/api/auth/login", {
      origin: "http://127.0.0.1:4173",
      "content-type": "application/json",
    }, { email: "verified@example.com", password: "Internship2026" });
    expect(missingCsrf.statusCode).toBe(403);
    expect((responsePayload(missingCsrf).error as Record<string, unknown>).code).toBe("CSRF_INVALID");

    const crossOrigin = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf, { origin: "https://evil.example" }), {
      email: "verified@example.com",
      password: "Internship2026",
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect((responsePayload(crossOrigin).error as Record<string, unknown>).code).toBe("ORIGIN_MISMATCH");
  });

  it("enforces resend cooldown limits server-side", async () => {
    const csrf = await csrfSession();
    for (let index = 0; index < 3; index += 1) {
      const captured = await dispatch("POST", "/api/auth/resend-verification", mutationHeaders(csrf), { email: "student@example.com" });
      expect(captured.statusCode).toBe(200);
    }
    const limited = await dispatch("POST", "/api/auth/resend-verification", mutationHeaders(csrf), { email: "student@example.com" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["Retry-After"]).toEqual(expect.any(String));
  });

  it("logs out the active session locally and returns to a public route", async () => {
    const csrf = await csrfSession();
    const login = await dispatch("POST", "/api/auth/login", mutationHeaders(csrf), {
      email: "verified@example.com",
      password: "Internship2026",
    });
    const sessionCookie = mergeCookieHeader(csrf.cookies, setCookies(login));
    const authenticatedCsrf = await csrfSession(sessionCookie);
    const logout = await dispatch("POST", "/api/auth/logout", mutationHeaders(authenticatedCsrf), {});
    expect(logout.statusCode).toBe(200);
    expect(responsePayload(logout).redirect).toBe("/");
    expect(state.lastSignOutScope).toBe("local");
    expect(setCookies(logout).join("\n")).toContain("Max-Age=0");
  });
});
