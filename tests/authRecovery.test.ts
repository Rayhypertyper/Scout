import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthResponseState,
  hasRecoveryGrant,
  setRecoveryGrant,
} from "../src/auth/http.js";
import type { AuthConfig } from "../src/auth/types.js";

const config: AuthConfig = {
  supabaseUrl: "https://example.supabase.co",
  publishableKey: "sb_publishable_test",
  siteUrl: new URL("https://example.test"),
  secureCookies: true,
  trustProxy: false,
  recoverySecret: "test-recovery-secret-that-is-long-enough",
};

function request(cookie: string): IncomingMessage {
  return { headers: { cookie }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

function cookieFromState(state: ReturnType<typeof createAuthResponseState>): string {
  return state.cookies[0]?.split(";", 1)[0] ?? "";
}

describe("signed recovery grants", () => {
  afterEach(() => vi.useRealTimers());

  it("binds the grant to the verified user and rejects tampering", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const state = createAuthResponseState();
    setRecoveryGrant(config, state, "user.with.dots");
    const cookie = cookieFromState(state);
    expect(cookie).toContain("rr-recovery=");
    expect(cookie).not.toContain("rr-recovery=1");
    expect(hasRecoveryGrant(request(cookie), config, "user.with.dots")).toBe(true);
    expect(hasRecoveryGrant(request(cookie), config, "another-user")).toBe(false);

    const tampered = cookie.replace(/.$/, cookie.endsWith("A") ? "B" : "A");
    expect(hasRecoveryGrant(request(tampered), config, "user.with.dots")).toBe(false);
  });

  it("expires the grant after its short recovery window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const state = createAuthResponseState();
    setRecoveryGrant(config, state, "user-1");
    const cookie = cookieFromState(state);
    expect(hasRecoveryGrant(request(cookie), config, "user-1")).toBe(true);
    vi.advanceTimersByTime(15 * 60 * 1_000 + 1);
    expect(hasRecoveryGrant(request(cookie), config, "user-1")).toBe(false);
  });
});
