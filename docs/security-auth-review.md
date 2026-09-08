# Scout authentication and account boundary review

Review date: 2026-08-31

This review covers the server authentication routes, Supabase client boundary,
recovery callbacks, cookies, proxy address handling, rate limits, preference
storage, and the repository's Supabase configuration and RLS source. It does
not claim to verify the state of a hosted Supabase project. No live migration
or hosted configuration change was performed.

## Findings

### High — recovery cookie could be forged or fixed, and callback destination could manufacture recovery

Before this pass, `rr-recovery=1` was accepted as proof of a password recovery
flow. A client or cookie-tossing sibling host could provide that value, and a
PKCE callback with `next=/reset-password` could be treated as recovery even
though the provider had not identified it as such. The reset route then used
the current session plus the cookie to update the password.

The route now accepts only a short-lived HMAC token containing a base64url user
identifier and expiry (`src/auth/http.ts:326-368`), and checks the token against
the server-verified current user (`src/auth/router.ts:425-438,548-565`). For
token-hash links, Supabase `verifyOtp` receives and authenticates the explicit
`recovery` type. For PKCE links, the gateway returns Supabase's
`redirectType`, which is derived from the stored PKCE verifier; the router
ignores a callback URL's `type` for this decision (`src/auth/provider.ts:115-129`,
`src/auth/router.ts:349-400`). A normal code plus `type=recovery` therefore
does not receive a grant. The production secret is required through
`AUTH_RECOVERY_SECRET` (`src/auth/config.ts:65-88`).

Residual risk: a deployment must use one stable secret across its instances,
and a recovery code must be redeemed in the same browser context that holds
the provider session cookies. The provider redirect template must preserve the
callback path and PKCE flow state.

### High — rotating client addresses could bypass account login limits

The old account key included the client IP, so an attacker could rotate proxy
addresses and obtain a fresh account bucket for each attempt. The limiter now
uses separate privacy-safe account and aggregate IP keys
(`src/auth/rateLimit.ts:355-385`) and every auth mutation consumes both
dimensions (`src/auth/router.ts:171-187`). Keys are normalized and SHA-256
digested before leaving the process; raw email and address values are not sent
to a shared service.

`UpstashAuthRateLimiterBackend` sends one Redis REST `EVAL` containing atomic
`INCR`, first-write `PEXPIRE`, and `PTTL`; it also restores `PEXPIRE` if a
pre-existing key has no TTL, preventing a permanent lockout
(`src/auth/rateLimit.ts:215-307`). A
generic HTTPS backend remains available for an atomic service implementing the
documented `{ allowed, retryAfter }` response contract. Production rejects an
unset, memory, or unknown backend and reports backend failures as a generic
temporary auth error rather than failing open (`src/auth/rateLimit.ts:391-429`,
`src/auth/router.ts:606-618,646-655`).

Residual risk: production must set `AUTH_RATE_LIMIT_BACKEND=upstash` with the
server-only Upstash URL and token, or deploy an equivalent atomic shared
service. The generic adapter checks HTTPS, credentials, redirects, timeouts,
and response size, but the service operator remains responsible for its atomic
implementation and Redis availability.

### High — forwarded address headers were trusted without an authenticated proxy boundary

If proxy trust was enabled, a public client could previously choose the first
`X-Forwarded-For` value. The parser now requires an exact configured hop count,
validates the complete chain, canonicalizes IPv4/IPv6 spellings, and falls back
to the socket address for malformed or short chains (`src/auth/http.ts:233-277`).
In production, enabling proxy trust requires an exact IP allowlist in
`AUTH_TRUST_PROXY_ADDRESSES` (`src/auth/config.ts:104-130`).

Residual risk: the network perimeter must ensure only the listed reverse proxy
addresses can connect to the application and that the proxy overwrites, rather
than appends to, `X-Forwarded-For`. A direct public listener should leave
`AUTH_TRUST_PROXY=0`.

### High — production could opt into insecure HTTP

`AUTH_ALLOW_INSECURE_HTTP=1` was previously sufficient to permit remote HTTP,
including a production deployment. The value is now rejected in production,
and production `AUTH_SITE_URL` must use HTTPS (`src/auth/config.ts:89-102`).
Secure cookies and HSTS continue to follow the HTTPS site URL.

Residual risk: TLS termination and host routing still belong to the deployment;
the application cannot verify an upstream proxy's certificate policy.

### Medium — a privileged Supabase key could be accepted as the public key

The config path accepted either the publishable or legacy anon variable without
rejecting known `sb_secret_`, service-role-labelled, or JWT role values. The
server now rejects those forms before constructing a browser-facing Supabase
client (`src/auth/config.ts:50-59,81-85`). Error responses expose only the
configuration field name and never the supplied value.

Residual risk: hosted secret rotation and provider project ownership remain
operational responsibilities. The service-role/secret key must be kept only in
server-side owner tooling and must never be put in `SUPABASE_PUBLISHABLE_KEY`
or browser assets.

### Medium — local auth defaults did not state the account security contract

The repository's Supabase CLI config previously contained only database
settings. Local GoTrue now enables email confirmations, disables anonymous
sign-ins, enables refresh-token rotation, requires ten-character
letter-and-number passwords, and bounds auth/email rate limits
(`supabase/config.toml:6-26`). The application also validates a ten-character
letter-and-number password before calling the provider
(`src/auth/validation.ts:6-10`).

Residual risk: these are repository defaults only. The hosted project's email
confirmation, password security, anonymous sign-in, refresh rotation, and
provider rate-limit settings must be checked in the Supabase dashboard or
management API before release. This review did not apply a live migration.
The relevant primary references are the [Supabase CLI config reference](https://supabase.com/docs/guides/local-development/cli/config),
[password security guide](https://supabase.com/docs/guides/auth/password-security),
and [user confirmation fields](https://supabase.com/docs/guides/auth/users).

### Medium — login feedback permits limited account enumeration (accepted UX tradeoff)

An unverified account receives `EMAIL_NOT_VERIFIED`, while a wrong account or
password receives `INVALID_CREDENTIALS` (`src/auth/errors.ts:26-35`). This lets
an attacker distinguish an existing but unverified email, although both signup
and resend responses remain neutral and the login and resend routes are rate
limited. The distinction is intentionally retained so a student can reach the
verification resend action without guessing what happened.

Residual risk: a deployment that prioritizes non-enumerating login behavior
should use one public failure response and offer resend only through a separate
neutral flow. The current code does not claim to eliminate this side channel.

### Low — local bucket eviction could reset active limits under identifier churn

The in-memory compatibility limiter used to evict old entries when its map was
full. An attacker could create many identifiers and reset active buckets. New
local buckets fail closed when capacity is exhausted (`src/auth/rateLimit.ts:62-113`),
while production requires the shared backend described above. Account and IP
identifiers sent to either backend are bounded, normalized, and hashed.

## Account isolation and controls verified

Preference page and API requests obtain the current user through Supabase
`getUser()` and require an explicitly email-confirmed account before reading or
writing local preference rows (`src/preferences/http.ts:125-196`). Writes use
the verified user ID in parameterized SQLite statements, and the browser draft
namespace is a digest rather than an email or user ID
(`src/preferences/http.ts:39-43`, `src/preferences/store.ts:90-238`). Preference
mutation routes enforce same-origin and CSRF checks before parsing and saving
(`src/preferences/http.ts:384-414`).

The Supabase RLS source keeps `anon` ungranted, grants account tables only to
`authenticated` and `service_role`, and uses `auth.uid() = user_id` in both
`using` and `with check` policies (`supabase/migrations/20260826000000_secure_account_data_rls.sql:73-241`).
The owner billing projection grants only `service_role`
(`supabase/migrations/20260830000000_owner_analytics_billing.sql:34-38`). The
repository includes pgTAP source tests for anonymous access and cross-account
reads/writes, but the local `supabase` CLI/pgTAP runner was unavailable during
this review, so those SQL tests were not executed.

## Validation

- `npx vitest run tests/authConfig.test.ts tests/authProvider.test.ts tests/authRateLimit.test.ts tests/authRecovery.test.ts tests/auth.test.ts` — 5 files, 33 tests passed.
- `npx vitest run tests/preferencesHttp.test.ts` — 1 file, 7 tests passed.
- `npx vitest run tests/preferences.test.ts` — 17 tests passed and 3 existing matching assertions failed because the concurrent eligibility/matching refactor currently leaves a fall-term, out-of-country, and ineligible role eligible; this is outside the auth boundary and is reported to the parent worker for integration.
- `npx eslint src/auth tests/auth.test.ts tests/authRateLimit.test.ts tests/authConfig.test.ts tests/authProvider.test.ts tests/authRecovery.test.ts` — passed.
- Scoped strict TypeScript compilation of `src/auth/*.ts`, `src/preferences/*.ts`, and their auth/preferences tests with the repository compiler flags — passed.
- `npm run typecheck` — blocked by a pre-existing/concurrent syntax error in `src/dashboard.ts:4339` (TS1005/TS1136); auth and preference focused tests still transformed and passed.
- `npm audit --omit=dev` — could not reach the npm registry (`ENOTFOUND registry.npmjs.org`); no dependency changes were made. The lockfile contains one `undici` entry, version 7.29.0, pulled by Cheerio.

## Release configuration

Production needs a random `AUTH_RECOVERY_SECRET` of at least 32 characters,
HTTPS `AUTH_SITE_URL` and `SUPABASE_URL`, a publishable/anon Supabase key,
`AUTH_RATE_LIMIT_BACKEND=upstash` plus the server-only Upstash URL/token (or a
deployed atomic shared adapter), and `AUTH_ALLOW_INSECURE_HTTP=0`. If a reverse
proxy is used, set `AUTH_TRUST_PROXY=1`, an accurate bounded hop count, and the
proxy IP allowlist; otherwise leave proxy trust disabled. Verify the hosted
Supabase auth settings and run the pgTAP RLS tests in a disposable local
Supabase instance before release.
