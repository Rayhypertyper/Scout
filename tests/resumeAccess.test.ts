import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeResume } from "../src/resume/access.js";
import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";
import type { AuthGateway, AuthUser } from "../src/auth/types.js";
const owner = "owner@example.com";
const response = { setHeader: vi.fn() } as unknown as ServerResponse;
const request = (host = "localhost", remoteAddress = "127.0.0.1", headers = {}) => ({ headers: { host, ...headers }, socket: { remoteAddress } }) as unknown as IncomingMessage;
function auth(user: AuthUser | null) {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test");
  vi.stubEnv("AUTH_SITE_URL", "http://localhost");
  setAuthGatewayFactoryForTests(() => ({ getCurrentUser: async () => user }) as AuthGateway);
}
const user = { id: "owner-id", email: owner, emailVerified: true, createdAt: "2026-01-01" };
afterEach(() => { vi.unstubAllEnvs(); setAuthGatewayFactoryForTests(null); });
describe("resume privacy", () => {
  it("permits direct localhost only when auth is absent", async () => {
    vi.stubEnv("SUPABASE_URL", ""); vi.stubEnv("AUTH_SITE_URL", ""); vi.stubEnv("NODE_ENV", "test");
    await expect(authorizeResume(request(), response, owner)).resolves.toBeUndefined();
    await expect(authorizeResume(request("example.com"), response, owner)).rejects.toThrow();
    await expect(authorizeResume(request("localhost", "192.0.2.1"), response, owner)).rejects.toThrow();
    await expect(authorizeResume(request("localhost", "127.0.0.1", { "x-forwarded-for": "192.0.2.1" }), response, owner)).rejects.toThrow();
  });
  it("does not allow localhost bypass in production", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SUPABASE_URL", ""); vi.stubEnv("AUTH_SITE_URL", "");
    await expect(authorizeResume(request(), response, owner)).rejects.toThrow();
  });
  it("permits direct localhost even when auth is configured", async () => {
    auth(null);
    await expect(authorizeResume(request(), response, owner)).resolves.toBeUndefined();
  });
  it("permits verified owner and rejects another user or anonymous remote access", async () => {
    const remote = request("example.com", "192.0.2.1");
    auth(user); await expect(authorizeResume(remote, response, owner)).resolves.toBeUndefined();
    auth({ ...user, email: "other@example.com" }); await expect(authorizeResume(remote, response, owner)).rejects.toMatchObject({ status: 403 });
    auth(null); await expect(authorizeResume(remote, response, owner)).rejects.toMatchObject({ status: 401 });
    auth({ ...user, emailVerified: false }); await expect(authorizeResume(remote, response, owner)).rejects.toMatchObject({ status: 401 });
  });
  it("prefers immutable owner ID when configured", async () => {
    vi.stubEnv("RESUME_OWNER_USER_ID", "another-id"); auth(user);
    await expect(authorizeResume(request("example.com", "192.0.2.1"), response, owner)).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("RESUME_OWNER_USER_ID", user.id);
    await expect(authorizeResume(request("example.com", "192.0.2.1"), response, "different@example.com")).resolves.toBeUndefined();
  });
});
