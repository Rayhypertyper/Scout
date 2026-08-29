---
version: 1
slug: "route"
primary_target: "route:/"
related_targets: ["route:/jobs"]
---

## Scope & Mode

- Primary target: `/`
- Related target: `/jobs`
- Visitor mode: **Persuade**
- Scope: A new marketing landing page that remains structurally and stylistically separate from the existing listings application.

## Audience, Job, Action & Proof

- Audience: Students keeping up with software internship and co-op postings across many public sources.
- Job: Understand within seconds that RoleRadar consolidates a fragmented search and keeps newly discovered roles visible.
- Primary action: Follow **Browse Internships** to `/jobs`.
- Proof: Demonstrate source normalization, live discovery, filtering, recency, and the real listings vocabulary. Do not add testimonials, customer logos, usage metrics, pricing, or commercial claims.

## Constraints

- Preserve the existing dashboard, filters, crawler, APIs, and data layer.
- Extend the incumbent warm-stone / dark-forest / signal-lime identity.
- Treat product data in the landing choreography as illustrative and keep it believable.
- Preserve semantic order and comprehension without animation; respect reduced motion and simplify sticky choreography on mobile.
- Avoid template SaaS patterns, repeated cards, glass, glow, bento grids, device mockups, and ornamental motion.

## Chosen Direction

**Source Ledger.** Raw source lanes cross one sharp dark-forest intake seam and emerge as an aligned RoleRadar shortlist. The page progresses from fragmentation, through continuous discovery and filtering, into a realistic product feed.

**Memorable moment:** during the opening scroll, scattered source text and posting fragments physically align across a lime intake rule; later, filtering removes and reorders the same row vocabulary until it becomes the final `/jobs` handoff.

**Approved comp:** `.impeccable/mocks/landing-source-ledger.png`

**Must not be literalized:** third-party company logos, exact claims about source count, and any generated text errors are not implementation authority. The topology, density contrast, palette, sharpness, and intake-seam mechanism are authoritative.

## Comp System Record

- Component grammar: direct-on-canvas rows, one inverted seam/panel, compact stacked metadata, rectangular link buttons, and hairline table structure.
- Corner language: structural fields are square; interactive controls use 4px corners; no large pill containers.
- Line weights: 1px gray-green hairlines; 2px lime only for active motion/state.
- Elevation: flat and tonal; no ambient cards or floating shadows.
- Type ramp: compressed 600-weight display with tight tracking; 12–14px role titles; 8–10px uppercase or mono system labels; 12–16px supporting copy.
- Sampled palette authority: field canvas `#f2f0e9`, paper `#fbfaf6`, forest `#17201b`, forest panel `#15201a`, signal lime `#d9ef70`, hairline `#d8dbd3`.

## Implementation Inventory

| Ingredient | Commitment | Medium |
| --- | --- | --- |
| Navigation | Thin fixed bar, real links, compact solid-on-scroll state | Semantic HTML/CSS |
| First-view proposition | Large asymmetric two-line statement with one visible CTA | Semantic HTML/CSS |
| Raw source lanes | 6 named source rows with believable fragments | Semantic HTML/CSS |
| Live intake seam | One sharp forest column with lime scanning rule | HTML/CSS + GSAP transforms |
| Normalized shortlist | 6 aligned role rows with location and recency | Semantic HTML/CSS |
| Fragmentation passage | Source windows and text strips that spread, collide, and resolve | HTML/CSS + ScrollTrigger |
| Discovery passage | Scanning field and incoming role rows | HTML/CSS + ScrollTrigger |
| Filter passage | Count sequence, active filters, and rows that reorder/disappear | Semantic controls + GSAP transforms |
| Recency passage | Time bands and new-listing signals without infinite autoplay | HTML/CSS + scroll-driven motion |
| Product handoff | Realistic RoleRadar feed that resolves into `/jobs` CTA | Semantic HTML/CSS |
| Raster imagery | None ships; product UI and motion remain code-native | Accepted omission |

## Unresolved Decisions

- None that block implementation. Copy may be tightened to avoid absolute claims while preserving the approved composition.
