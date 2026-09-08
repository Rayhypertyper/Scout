import type { User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { publicUser } from "../src/auth/provider.js";

function providerUser(fields: { confirmed_at?: string | null; email_confirmed_at?: string | null } = {}): User {
  return {
    id: "user-1",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-08-31T00:00:00.000Z",
    email: "student@example.com",
    email_confirmed_at: null,
    phone: "",
    confirmed_at: null,
    last_sign_in_at: null,
    role: "authenticated",
    updated_at: "2026-08-31T00:00:00.000Z",
    identities: [],
    is_anonymous: false,
    ...fields,
  } as unknown as User;
}

describe("Supabase user trust boundary", () => {
  it("requires explicit email confirmation even when another factor is confirmed", () => {
    const phoneOnly = publicUser(providerUser({
      confirmed_at: "2026-08-31T00:00:00.000Z",
      email_confirmed_at: null,
    }));
    expect(phoneOnly.emailVerified).toBe(false);

    const emailConfirmed = publicUser(providerUser({
      confirmed_at: "2026-08-31T00:00:00.000Z",
      email_confirmed_at: "2026-08-31T00:00:00.000Z",
    }));
    expect(emailConfirmed.emailVerified).toBe(true);
  });
});
