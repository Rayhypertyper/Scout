---
version: 1
slug: "auth"
primary_target: "route:/login"
related_targets: ["route:/signup", "route:/verify-email", "route:/forgot-password", "route:/reset-password", "route:/account"]
---

## Scope & Mode

- Primary target: `/login`
- Related targets: the complete email account, verification, recovery, reset, and account flow.
- Visitor mode: **Operate**
- Scope: An isolated authentication surface that joins the public site to the authenticated search workspace without changing landing, listings, or shared navigation design.

## Audience, Task & States

- Audience: Students returning to an ongoing internship search or creating the account that will preserve it.
- Task: Enter or recover the workspace with clear proof of what happened and what to do next.
- Critical states: initial session check, validation, submitting, provider unavailable, unverified email, already-verified redirect, resend cooldown, neutral recovery success, invalid/expired link, reset-link check, reset success, and authenticated account/logout.

## Information Architecture

- The auth surface is one server-served shell with route-specific views: `/login` (primary), `/signup`, `/verify-email`, `/forgot-password`, `/reset-password`, and the protected `/account` page. `/auth/callback` is the provider callback; `/post-login` is the internal handoff that sends first-time users to `/onboarding` and returning users to the match workspace.
- The shell owns the masthead, task plane, context field, form primitives, state messaging, session bootstrap, and the logout primitive. It does not own the landing page, listings composition, shared navigation, or the preference/onboarding UI.
- The source order is skip link → masthead → task workspace → context field. Desktop CSS presents the context field on the left and the broader task plane on the right, while keeping the actionable form first for keyboard and assistive-technology users.

## Responsive & Source Order

- Wide layout: asymmetric two-column composition (`context` then `workspace` visually) with the task plane capped at a 460px form measure; fields and actions stay directly on the canvas rather than inside a floating container.
- At `980px` and below, the task workspace becomes the first normal-flow section and the forest context field follows it. At `620px` and below, the masthead drops the route label and descriptor, password requirements become one column, and account actions stack.
- The semantic order, labels, status messages, and primary action remain available without sticky positioning, hover, or scroll choreography. Links and controls keep their comfortable touch heights at compact widths.

## Accessibility & Interaction

- Every view keeps the skip link, one meaningful heading, persistent labels, semantic form controls, and `autocomplete`/input-mode hints. Errors use `aria-invalid` and `aria-describedby`; status, alert, cooldown, and state transitions use live regions with focus moved to the newly relevant message or heading.
- Focus is always visible through the dark 2px outline plus lime offset treatment. Password visibility is an explicit button with an updated label and `aria-pressed`; it returns focus to the field. Decorative radar marks and signal dots remain hidden from assistive technology.
- Submit controls expose pending state, disable duplicate requests, and keep reserved error space so validation does not shift the form. Reduced motion removes radar, loading, and spinner animation while preserving every state and action.

## Copy & Security Boundaries

- Copy is concise, concrete, and task-led: say what happened and the next safe action without marketing promises. Sign-up duplicate responses, password recovery, and verification resend remain neutral about whether an account exists; provider details and stack traces never reach the user.
- The server owns the Supabase boundary and is the only place that handles auth tokens. Passwords never enter SQLite or client storage. Protected decisions use server-verified `getUser()` data and require confirmed email; the client may consume only the safe session projection.
- Login/signup/recovery/resend/reset/logout mutations require same-origin checks plus the server-issued CSRF token echoed in `X-CSRF-Token`; auth actions are rate-limited, responses are private/non-cacheable, and production cookies are secure, HTTP-only, and SameSite. `next` is restricted to same-origin internal paths and callback recovery grants are scoped to the reset flow.

## Reusable Patterns

- **Auth shell:** masthead + asymmetric context/workspace frame, shared by every auth route.
- **Task primitives:** labelled field group, password control with visibility toggle, inline field error, system/form message, pending submit, and state mark/loading rule.
- **Continuity primitives:** hairline account ledger, verified indicator, and the account logout action. `authClient`, `wireLogoutButton`, `protectClientRoute`, and the server `getTrustedUser`/`requireTrustedUser` helpers are the integration seam for future app navigation and protected views.
- Keep these patterns auth-owned and merge-friendly; shared navigation may consume the logout primitive later without importing the auth page shell.

## Constraints

- Extend Scout's warm-paper, forest-ink, signal-lime system; lime remains reserved for decisive action and verified state.
- Keep forms direct on the composition: no floating card, nested containers, glass, gradients, glow, or large-radius SaaS chrome.
- Preserve account-enumeration resistance, server-owned cookie sessions, keyboard flow, visible focus, screen-reader announcements, and reduced motion.
- Keep the integration merge-friendly with parallel landing and listings work; auth owns its routes, assets, provider boundary, and only a minimal server-router seam.

## Typography Assets & CSP

- Auth now uses the official Vercel Geist package `geist@1.7.2`, vendored as the static Geist and Geist Mono WOFF2 weights referenced by the surface under `public/fonts/geist/`. Its SIL Open Font License 1.1 notice is retained in `public/fonts/geist/LICENSE.txt`; package provenance and file hashes are recorded in `public/fonts/geist/README.md`.
- `auth.css` declares same-origin `@font-face` sources and `auth.html` preloads the critical regular, semibold, and mono weights. The normal-login finish evidence at `.impeccable/review/auth-normal-login-desktop.png` (1440×1000) and `auth-normal-login-mobile.png` (390×844) confirms the loaded-font rendering and self-only CSP. System fallbacks remain only as resilience.
- Keep remote font imports out of the auth shell. Auth responses enforce a self-only CSP (`script-src`, `style-src`, `font-src`, and `connect-src` self; same-origin images plus data; no framing), now verified against the shipped local font assets.

## Chosen Direction

**Signal Handoff.** A thin Scout masthead spans an asymmetric dark context field and a broad paper task plane. Hairline ledger rows connect account access to saved roles, application progress, and source watchlists without marketing excess.

**Memorable moment:** the single lime radar rule settles into place as the task surface arrives; verification and recovery states reuse the same authored signal geometry rather than generic success icons.

## Unresolved Decisions

- Supabase project credentials, redirect allow-list entries, email confirmation policy, SMTP provider, and final production origin must be configured outside the repository.
