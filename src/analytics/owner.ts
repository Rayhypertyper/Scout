import { createClient, type User } from "@supabase/supabase-js";

export const OWNER_ANALYTICS_CONTRACT = "owner-analytics.v1";
export const OWNER_ANALYTICS_RANGE_DAYS = [7, 30, 90] as const;
export type OwnerAnalyticsRangeDays = (typeof OWNER_ANALYTICS_RANGE_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1_000;
const PAID_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);

export interface OwnerAnalyticsConfig {
  ownerEmail: string | null;
  ownerUserId: string | null;
  serviceRoleKey: string | null;
}

export interface OwnerAnalyticsDataSourceConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface OwnerAnalyticsUserRecord {
  id: string;
  email: string | null;
  createdAt: string;
  emailVerified: boolean;
  lastSignInAt: string | null;
}

export interface OwnerAnalyticsSubscriptionRecord {
  userId: string;
  status: string;
  plan: string | null;
}

export interface OwnerAnalyticsSubscriptionRead {
  available: boolean;
  reason: "table_missing" | "query_failed" | null;
  rows: OwnerAnalyticsSubscriptionRecord[];
}

export interface OwnerAnalyticsDataSource {
  listUsers(): Promise<OwnerAnalyticsUserRecord[]>;
  listSubscriptions(): Promise<OwnerAnalyticsSubscriptionRead>;
}

export type OwnerAnalyticsDataSourceFactory = (
  config: OwnerAnalyticsDataSourceConfig,
) => OwnerAnalyticsDataSource;

export type OwnerAnalyticsMembershipStatus = "paid" | "trialing" | "free" | "unverified" | "unknown";

export interface OwnerAnalyticsSnapshot {
  status: "ready";
  generatedAt: string;
  rangeDays: OwnerAnalyticsRangeDays;
  metrics: {
    totalUsers: number;
    verifiedUsers: number;
    unverifiedUsers: number;
    newUsers: number;
    activeUsers: number;
    verifiedRate: number | null;
  };
  billing: {
    available: boolean;
    reason: OwnerAnalyticsSubscriptionRead["reason"];
    paidUsers: number | null;
    trialUsers: number | null;
    conversionRate: number | null;
    plans: Array<{ name: string; users: number }>;
  };
  signups: Array<{ date: string; count: number }>;
  recentUsers: Array<{
    id: string;
    email: string;
    createdAt: string;
    lastSignInAt: string | null;
    status: OwnerAnalyticsMembershipStatus;
  }>;
}

export function readOwnerAnalyticsConfig(environment: NodeJS.ProcessEnv = process.env): OwnerAnalyticsConfig {
  const ownerEmail = environment.SCOUT_ANALYTICS_OWNER_EMAIL?.trim().toLocaleLowerCase() || null;
  const ownerUserId = environment.SCOUT_ANALYTICS_OWNER_USER_ID?.trim() || null;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim()
    || environment.SUPABASE_SECRET_KEY?.trim()
    || null;
  return { ownerEmail, ownerUserId, serviceRoleKey };
}

export function ownerAnalyticsAccessConfigured(config: OwnerAnalyticsConfig): boolean {
  return Boolean(config.ownerEmail || config.ownerUserId);
}

export function isOwnerAnalyticsUser(
  user: { id: string; email: string },
  config: OwnerAnalyticsConfig,
): boolean {
  // A configured immutable user id is the strongest owner binding. Do not
  // fall back to a mutable/recycled email when both values are present.
  if (config.ownerUserId) return user.id === config.ownerUserId;
  return Boolean(config.ownerEmail && user.email.trim().toLocaleLowerCase() === config.ownerEmail);
}

export function parseOwnerAnalyticsRange(value: string | null | undefined): OwnerAnalyticsRangeDays {
  const candidate = Number(value);
  return OWNER_ANALYTICS_RANGE_DAYS.includes(candidate as OwnerAnalyticsRangeDays)
    ? candidate as OwnerAnalyticsRangeDays
    : 30;
}

export class OwnerAnalyticsDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerAnalyticsDataError";
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function subscriptionFromRecord(value: unknown): OwnerAnalyticsSubscriptionRecord | null {
  if (!isRecord(value)) return null;
  const userId = optionalString(value.user_id);
  if (!userId) return null;
  return {
    userId,
    status: optionalString(value.status)?.toLocaleLowerCase() ?? "unknown",
    plan: optionalString(value.plan),
  };
}

function userFromSupabase(user: User): OwnerAnalyticsUserRecord {
  return {
    id: user.id,
    email: user.email ?? null,
    createdAt: user.created_at,
    // `confirmed_at` can represent a confirmed phone identity. Analytics
    // counts must reflect verified email accounts only.
    emailVerified: Boolean(user.email_confirmed_at),
    lastSignInAt: user.last_sign_in_at ?? null,
  };
}

function createSupabaseOwnerAnalyticsDataSource(
  config: OwnerAnalyticsDataSourceConfig,
): OwnerAnalyticsDataSource {
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return {
    async listUsers() {
      const users: OwnerAnalyticsUserRecord[] = [];
      const perPage = 1_000;
      for (let page = 1; page <= 1_000; page += 1) {
        const result = await client.auth.admin.listUsers({ page, perPage });
        if (result.error) throw new OwnerAnalyticsDataError("Supabase Auth users could not be read.");
        const pageUsers = result.data.users;
        users.push(...pageUsers.map(userFromSupabase));
        if (pageUsers.length < perPage) break;
      }
      return users;
    },

    async listSubscriptions() {
      const result = await client
        .from("scout_subscriptions")
        .select("user_id,status,plan");
      if (!result.error) {
        const rows = Array.isArray(result.data)
          ? result.data.map(subscriptionFromRecord).filter((row): row is OwnerAnalyticsSubscriptionRecord => row !== null)
          : [];
        return { available: true, reason: null, rows };
      }
      const errorCode = typeof result.error.code === "string" ? result.error.code : "";
      return {
        available: false,
      reason: errorCode === "42P01" || errorCode === "PGRST205" ? "table_missing" : "query_failed",
        rows: [],
      };
    },
  };
}

let dataSourceFactoryForTests: OwnerAnalyticsDataSourceFactory | null = null;

export function setOwnerAnalyticsDataSourceFactoryForTests(
  factory: OwnerAnalyticsDataSourceFactory | null,
): void {
  dataSourceFactoryForTests = factory;
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function maskEmail(email: string | null): string {
  if (!email) return "Unknown account";
  const separator = email.indexOf("@");
  if (separator <= 0 || separator === email.length - 1) return "Hidden account";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const suffix = local.length > 1 ? local.slice(-1) : "";
  return `${local[0] ?? "•"}•••${suffix}@${domain}`;
}

export function buildOwnerAnalyticsSnapshot(
  users: OwnerAnalyticsUserRecord[],
  subscriptions: OwnerAnalyticsSubscriptionRead,
  rangeDays: OwnerAnalyticsRangeDays,
  now = new Date(),
): OwnerAnalyticsSnapshot {
  const clock = Number.isFinite(now.getTime()) ? now : new Date();
  const rangeStart = startOfUtcDay(new Date(clock.getTime() - (rangeDays - 1) * DAY_MS));
  const rangeStartTimestamp = rangeStart.getTime();
  const activeStartTimestamp = clock.getTime() - 30 * DAY_MS;
  const signupCounts = new Map<string, number>();
  for (let offset = 0; offset < rangeDays; offset += 1) {
    signupCounts.set(dateKey(new Date(rangeStartTimestamp + offset * DAY_MS)), 0);
  }

  let verifiedUsers = 0;
  let newUsers = 0;
  let activeUsers = 0;
  for (const user of users) {
    if (user.emailVerified) verifiedUsers += 1;
    const createdAt = dateTimestamp(user.createdAt);
    if (createdAt !== null && createdAt >= rangeStartTimestamp && createdAt <= clock.getTime()) {
      newUsers += 1;
      const key = dateKey(new Date(createdAt));
      if (signupCounts.has(key)) signupCounts.set(key, (signupCounts.get(key) ?? 0) + 1);
    }
    const lastSignInAt = dateTimestamp(user.lastSignInAt);
    if (lastSignInAt !== null && lastSignInAt >= activeStartTimestamp && lastSignInAt <= clock.getTime()) activeUsers += 1;
  }

  const userIds = new Set(users.map((user) => user.id));
  const subscriptionState = new Map<string, "paid" | "trialing">();
  const planUsers = new Map<string, Set<string>>();
  if (subscriptions.available) {
    for (const subscription of subscriptions.rows) {
      if (!userIds.has(subscription.userId)) continue;
      const status = subscription.status.toLocaleLowerCase();
      if (PAID_SUBSCRIPTION_STATUSES.has(status)) {
        subscriptionState.set(subscription.userId, "paid");
        const planName = subscription.plan || "Unspecified plan";
        const planUsersForName = planUsers.get(planName) ?? new Set<string>();
        planUsersForName.add(subscription.userId);
        planUsers.set(planName, planUsersForName);
      } else if (status === "trialing" && !subscriptionState.has(subscription.userId)) {
        subscriptionState.set(subscription.userId, "trialing");
      }
    }
  }

  const paidUsers = subscriptions.available
    ? [...subscriptionState.values()].filter((status) => status === "paid").length
    : null;
  const trialUsers = subscriptions.available
    ? [...subscriptionState.values()].filter((status) => status === "trialing").length
    : null;
  const totalUsers = users.length;

  const recentUsers = [...users]
    .toSorted((left, right) => (dateTimestamp(right.createdAt) ?? Number.NEGATIVE_INFINITY) - (dateTimestamp(left.createdAt) ?? Number.NEGATIVE_INFINITY))
    .slice(0, 10)
    .map((user) => ({
      id: user.id,
      email: maskEmail(user.email),
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
      status: !user.emailVerified
        ? "unverified" as const
        : !subscriptions.available
          ? "unknown" as const
          : subscriptionState.get(user.id) === "paid"
            ? "paid" as const
            : subscriptionState.get(user.id) === "trialing"
              ? "trialing" as const
              : "free" as const,
    }));

  return {
    status: "ready",
    generatedAt: clock.toISOString(),
    rangeDays,
    metrics: {
      totalUsers,
      verifiedUsers,
      unverifiedUsers: totalUsers - verifiedUsers,
      newUsers,
      activeUsers,
      verifiedRate: totalUsers > 0 ? (verifiedUsers / totalUsers) * 100 : null,
    },
    billing: {
      available: subscriptions.available,
      reason: subscriptions.reason,
      paidUsers,
      trialUsers,
      conversionRate: subscriptions.available && totalUsers > 0 && paidUsers !== null
        ? (paidUsers / totalUsers) * 100
        : null,
      plans: [...planUsers.entries()]
        .map(([name, planUsersForName]) => ({ name, users: planUsersForName.size }))
        .toSorted((left, right) => right.users - left.users || left.name.localeCompare(right.name)),
    },
    signups: [...signupCounts.entries()].map(([date, count]) => ({ date, count })),
    recentUsers,
  };
}

export async function readOwnerAnalyticsSnapshot(
  config: OwnerAnalyticsDataSourceConfig,
  rangeDays: OwnerAnalyticsRangeDays,
  now = new Date(),
): Promise<OwnerAnalyticsSnapshot> {
  const factory = dataSourceFactoryForTests ?? createSupabaseOwnerAnalyticsDataSource;
  const dataSource = factory(config);
  const [users, subscriptions] = await Promise.all([
    dataSource.listUsers(),
    dataSource.listSubscriptions(),
  ]);
  return buildOwnerAnalyticsSnapshot(users, subscriptions, rangeDays, now);
}
