import { parseCookies } from "../src/auth/http.js";
import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";

export const DASHBOARD_TEST_USER = "dashboard-test-user";
const csrf = "d".repeat(43);

export function dashboardAccountHeaders(): Record<string, string> {
  return { host: "localhost", origin: "http://localhost", "content-type": "application/json",
    cookie: `rr-dashboard-user=${DASHBOARD_TEST_USER}; rr-csrf=${csrf}`, "x-csrf-token": csrf };
}

export function installDashboardAccountFixture(): () => void {
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    AUTH_SITE_URL: process.env.AUTH_SITE_URL };
  process.env.SUPABASE_URL = "https://dashboard.supabase.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.AUTH_SITE_URL = "http://localhost";
  const unsupported = async (): Promise<never> => { throw new Error("Unsupported auth operation in dashboard fixture"); };
  setAuthGatewayFactoryForTests((request) => ({
    async getCurrentUser() {
      return parseCookies(request).get("rr-dashboard-user") === DASHBOARD_TEST_USER
        ? { id: DASHBOARD_TEST_USER, email: "dashboard@example.test", emailVerified: true, createdAt: "2026-01-01" } : null;
    },
    signUp: unsupported, signIn: unsupported, resendVerification: unsupported, requestPasswordReset: unsupported,
    verifyToken: unsupported, exchangeCode: unsupported, updatePassword: unsupported, signOut: unsupported,
  }));
  return () => {
    setAuthGatewayFactoryForTests(null);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
