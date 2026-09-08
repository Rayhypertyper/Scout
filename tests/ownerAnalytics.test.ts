import type { IncomingMessage, ServerResponse } from "node:http";

import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";

import { parseCookies } from "../src/auth/http.js";
import type { AuthGateway, AuthGatewayFactory, AuthUser } from "../src/auth/types.js";
import {
  buildOwnerAnalyticsSnapshot,
  setOwnerAnalyticsDataSourceFactoryForTests,
  type OwnerAnalyticsDataSourceFactory,
  type OwnerAnalyticsSubscriptionRead,
  type OwnerAnalyticsUserRecord,
} from "../src/analytics/owner.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string | string[]>): void;
  end(body?: Buffer | string): void;
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

function request(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

function testUser(id: string, email: string, verified: boolean, createdAt: string): AuthUser {
  return { id, email, emailVerified: verified, createdAt };
}

function authGatewayFactory(users: Record<string, AuthUser | null>): AuthGatewayFactory {
  return (incoming): AuthGateway => {
    const session = parseCookies(incoming).get("rr-analytics-session") ?? "anonymous";
    const currentUser = users[session] ?? null;
    return {
      getCurrentUser: async () => currentUser,
      signUp: async () => ({ user: null, sessionCreated: false, duplicatePossible: false }),
      signIn: async () => currentUser ?? testUser("owner", "owner@example.com", true, "2026-08-01T00:00:00.000Z"),
      resendVerification: async () => {},
      requestPasswordReset: async () => {},
      verifyToken: async () => currentUser ?? testUser("owner", "owner@example.com", true, "2026-08-01T00:00:00.000Z"),
      exchangeCode: async () => currentUser ?? testUser("owner", "owner@example.com", true, "2026-08-01T00:00:00.000Z"),
      updatePassword: async () => currentUser ?? testUser("owner", "owner@example.com", true, "2026-08-01T00:00:00.000Z"),
      signOut: async () => {},
    };
  };
}

const now = new Date("2026-08-30T12:00:00.000Z");
const userRecords: OwnerAnalyticsUserRecord[] = [
  { id: "owner", email: "owner@example.com", emailVerified: true, createdAt: "2026-08-01T00:00:00.000Z", lastSignInAt: "2026-08-30T11:00:00.000Z" },
  { id: "paid", email: "paid@example.com", emailVerified: true, createdAt: "2026-08-29T00:00:00.000Z", lastSignInAt: "2026-08-29T11:00:00.000Z" },
  { id: "trial", email: "trial@example.com", emailVerified: true, createdAt: "2026-08-28T00:00:00.000Z", lastSignInAt: null },
  { id: "unverified", email: "new@example.com", emailVerified: false, createdAt: "2026-08-30T08:00:00.000Z", lastSignInAt: null },
];
const subscriptionRead: OwnerAnalyticsSubscriptionRead = {
  available: true,
  reason: null,
  rows: [
    { userId: "paid", status: "active", plan: "monthly" },
    { userId: "trial", status: "trialing", plan: "monthly" },
    { userId: "owner", status: "canceled", plan: "monthly" },
  ],
};

describe("owner analytics", () => {
  let handleOwnerAnalyticsRequest: typeof import("../src/analytics/router.js").handleOwnerAnalyticsRequest;
  let setAuthGatewayFactoryForTests: typeof import("../src/auth/router.js").setAuthGatewayFactoryForTests;
  const previousEnvironment = {
    supabaseUrl: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    siteUrl: process.env.AUTH_SITE_URL,
    ownerEmail: process.env.SCOUT_ANALYTICS_OWNER_EMAIL,
    ownerUserId: process.env.SCOUT_ANALYTICS_OWNER_USER_ID,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  beforeAll(async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    process.env.AUTH_SITE_URL = "http://127.0.0.1:4173";
    process.env.SCOUT_ANALYTICS_OWNER_EMAIL = "owner@example.com";
    delete process.env.SCOUT_ANALYTICS_OWNER_USER_ID;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    ({ handleOwnerAnalyticsRequest } = await import("../src/analytics/router.js"));
    ({ setAuthGatewayFactoryForTests } = await import("../src/auth/router.js"));
    setAuthGatewayFactoryForTests(authGatewayFactory({
      owner: testUser("owner", "owner@example.com", true, "2026-08-01T00:00:00.000Z"),
      stranger: testUser("stranger", "stranger@example.com", true, "2026-08-01T00:00:00.000Z"),
      unverified: testUser("unverified", "owner@example.com", false, "2026-08-01T00:00:00.000Z"),
      anonymous: null,
    }));
  });

  afterEach(() => {
    setOwnerAnalyticsDataSourceFactoryForTests(null);
  });

  afterAll(() => {
    setAuthGatewayFactoryForTests(null);
    if (previousEnvironment.supabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousEnvironment.supabaseUrl;
    if (previousEnvironment.publishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = previousEnvironment.publishableKey;
    if (previousEnvironment.siteUrl === undefined) delete process.env.AUTH_SITE_URL;
    else process.env.AUTH_SITE_URL = previousEnvironment.siteUrl;
    if (previousEnvironment.ownerEmail === undefined) delete process.env.SCOUT_ANALYTICS_OWNER_EMAIL;
    else process.env.SCOUT_ANALYTICS_OWNER_EMAIL = previousEnvironment.ownerEmail;
    if (previousEnvironment.ownerUserId === undefined) delete process.env.SCOUT_ANALYTICS_OWNER_USER_ID;
    else process.env.SCOUT_ANALYTICS_OWNER_USER_ID = previousEnvironment.ownerUserId;
    if (previousEnvironment.serviceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnvironment.serviceRoleKey;
  });

  function dataSourceFactory(): OwnerAnalyticsDataSourceFactory {
    return () => ({
      listUsers: async () => userRecords,
      listSubscriptions: async () => subscriptionRead,
    });
  }

  it("builds signup, verification, activity, paid, trial, and plan metrics from the two sources", () => {
    const snapshot = buildOwnerAnalyticsSnapshot(userRecords, subscriptionRead, 7, now);
    expect(snapshot.metrics).toMatchObject({
      totalUsers: 4,
      verifiedUsers: 3,
      unverifiedUsers: 1,
      newUsers: 3,
      activeUsers: 2,
      verifiedRate: 75,
    });
    expect(snapshot.billing).toMatchObject({
      available: true,
      paidUsers: 1,
      trialUsers: 1,
      conversionRate: 25,
      plans: [{ name: "monthly", users: 1 }],
    });
    expect(snapshot.signups).toHaveLength(7);
    expect(snapshot.recentUsers[0]).toMatchObject({ id: "unverified", status: "unverified" });
    expect(snapshot.recentUsers.find((user) => user.id === "paid")).toMatchObject({ email: "p•••d@example.com", status: "paid" });
  });

  it("returns data only to the configured owner", async () => {
    setOwnerAnalyticsDataSourceFactoryForTests(dataSourceFactory());

    const owner = response();
    await handleOwnerAnalyticsRequest(
      request("GET", "/api/owner/analytics?range=7", { cookie: "rr-analytics-session=owner" }),
      owner as unknown as ServerResponse,
      new URL("/api/owner/analytics?range=7", "http://127.0.0.1:4173"),
    );
    const ownerPayload = JSON.parse(owner.body.toString("utf8")) as Record<string, unknown>;
    expect(owner.statusCode).toBe(200);
    expect(ownerPayload.contract).toBe("owner-analytics.v1");
    expect((ownerPayload.billing as Record<string, unknown>).paidUsers).toBe(1);

    const stranger = response();
    await handleOwnerAnalyticsRequest(
      request("GET", "/api/owner/analytics", { cookie: "rr-analytics-session=stranger" }),
      stranger as unknown as ServerResponse,
      new URL("/api/owner/analytics", "http://127.0.0.1:4173"),
    );
    expect(stranger.statusCode).toBe(404);
    expect(JSON.parse(stranger.body.toString("utf8"))).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("redirects anonymous page requests and renders the private page for the owner", async () => {
    const anonymous = response();
    await handleOwnerAnalyticsRequest(
      request("GET", "/owner/analytics"),
      anonymous as unknown as ServerResponse,
      new URL("/owner/analytics", "http://127.0.0.1:4173"),
    );
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.Location).toBe("/login?next=%2Fowner%2Fanalytics");

    const owner = response();
    await handleOwnerAnalyticsRequest(
      request("GET", "/owner/analytics", { cookie: "rr-analytics-session=owner" }),
      owner as unknown as ServerResponse,
      new URL("/owner/analytics", "http://127.0.0.1:4173"),
    );
    const page = owner.body.toString("utf8");
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["Cache-Control"]).toBe("private, no-store, max-age=0");
    expect(page).toContain("owner@example.com");
    expect(page).toContain("Product signal.");
    expect(page).not.toContain("__OWNER_ANALYTICS_CSS_VERSION__");
  });

  it("keeps the owner page available while clearly reporting an unconfigured server data key", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const owner = response();
    await handleOwnerAnalyticsRequest(
      request("GET", "/api/owner/analytics", { cookie: "rr-analytics-session=owner" }),
      owner as unknown as ServerResponse,
      new URL("/api/owner/analytics", "http://127.0.0.1:4173"),
    );
    expect(owner.statusCode).toBe(200);
    expect(JSON.parse(owner.body.toString("utf8"))).toMatchObject({
      status: "not_configured",
      configured: false,
    });
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  });
});
