---
name: Scout
description: Opportunity intelligence for a current, filterable internship shortlist.
colors:
  field-canvas: "#f2f0e9"
  paper: "#fbfaf6"
  paper-strong: "#ffffff"
  forest: "#15201a"
  forest-ink: "#17201b"
  signal-lime: "#d9ef70"
  signal-lime-strong: "#bcd63f"
  signal-ink: "#18200f"
  ink: "#17201b"
  ink-2: "#3d4741"
  muted: "#606a64"
  muted-2: "#636d67"
  line: "#d8dbd3"
  line-2: "#e8e9e3"
  app-blue: "#2c5f50"
  app-blue-soft: "#e4eee9"
  app-green: "#276a4f"
  app-red: "#a83d30"
  app-orange: "#a75b22"
typography:
  display:
    fontFamily: "Geist, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(3.6rem, 7.2vw, 6rem)"
    fontWeight: 600
    lineHeight: 0.9
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(3rem, 6vw, 6rem)"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Geist, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Geist, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.006em"
  marketing-body:
    fontFamily: "Geist, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.006em"
  label:
    fontFamily: "Geist Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "9px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.08em"
  metadata:
    fontFamily: "Geist, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  square: "0px"
  control: "4px"
  app-surface: "8px"
  status: "999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "48px"
components:
  brand-mark:
    backgroundColor: "{colors.signal-lime}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.control}"
    size: "32px"
  button-signal:
    backgroundColor: "{colors.signal-lime}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-app:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  filter-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
    height: "43px"
  role-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.square}"
    padding: "12px 10px"
---

# Design System: Scout

## Overview

**Creative North Star: "The Signal Triage Desk"**

Scout is a focused research desk for sorting live opportunity signals: editorial in hierarchy, operational in density, and deliberately restrained. Warm stone and paper fields keep long searches calm; dark forest panels create decisive anchors; rare signal lime marks what is live, new, or actionable. The system earns character through alignment, information rhythm, hairlines, and compact typography rather than decorative chrome.

There are two related but intentionally distinct expressions of the system. `/` is the **Persuade** marketing surface: the Source Ledger explains how fragmented public postings become one current shortlist. `/jobs` is the **Operate** listings application: it is the incumbent workspace for real roles, source provenance, filters, watchlists, and application progress. They share the Scout name, supplied brand lockup, palette, and type family, but the landing page is structurally separate and its product examples are explicitly illustrative. The marketing CTA hands off to `/jobs`; it does not replace or reshape the crawler, APIs, data layer, or listings workflow.

**Key Characteristics:**
- Warm, low-glare working canvas with high-contrast forest anchors.
- One rare signal color reserved for status, change, and decisive actions.
- Source Ledger marketing display scale paired with compact operational metadata.
- Flat surfaces, thin separators, small corners, and dense but legible rows.
- Scroll choreography communicates incoming or reorganized information, never decoration.

## Colors

The palette treats color as a signal system: warm fields carry sustained reading, forest creates an intake or operating anchor, and lime is scarce enough to mean something.

### Primary

- **Signal Lime:** the rare live, new, selected, or decisive-action signal.
- **Signal Lime Strong:** the darker signal edge and focus treatment; use it with the same restraint as the primary signal.
- **Signal Ink:** the legible ink paired with lime controls and the Scout lockup.

### Secondary

- **Dark Forest:** the intake seam, operating rail, and high-contrast scanning field.
- **Forest Ink:** readable light text on dark forest panels.

### Tertiary

- **App Blue:** the incumbent app's semantic link, focus, and running-state accent.
- **App Green:** completed or healthy source/application state.
- **App Red:** failed, cancelled, or error state.
- **App Orange:** recency or attention state when the listing workspace needs a second status voice.

### Neutral

- **Field Canvas:** the warm stone page ground for both surfaces.
- **Paper:** quiet content fields and the landing preview surface.
- **Paper Strong:** high-contrast white utility surface where the incumbent app needs it.
- **Forest Ink / Ink / Ink-2:** the primary, secondary, and dark-panel text hierarchy.
- **Muted / Muted-2:** supporting copy, timestamps, labels, and low-priority metadata.
- **Line / Line-2:** one-pixel structural dividers and their quiet secondary variant.

**The One Signal Rule.** Lime marks change, state, or action; it is not ambient decoration. A lime mark must tell the visitor what is live, selected, new, or actionable.

## Typography

**Display Font:** Geist (with Helvetica Neue, Arial, sans-serif)
**Body Font:** Geist (with Helvetica Neue, Arial, sans-serif)
**Label/Mono Font:** Geist Mono (with SFMono-Regular, Consolas, monospace)

**Character:** The pairing keeps the landing page editorial without losing the incumbent app's scanability. Geist's 600 display weight carries propositions; regular and medium body weights keep role information compact; Geist Mono labels counts, sources, timestamps, and system state.

### Hierarchy

- **Display** (600, `clamp(3.6rem, 7.2vw, 6rem)`, `0.9` line-height, `-0.04em` tracking): the Source Ledger marketing proposition and the first-view two-line statement.
- **Headline** (600, `clamp(3rem, 6vw, 6rem)`, `0.92` line-height, `-0.04em` tracking): major marketing narrative turns below the first view.
- **Title** (700, `22px`, `1.15` line-height, `-0.03em` tracking): incumbent `/jobs` page and workspace headings.
- **Body** (400, `13px`, `1.45` line-height, `-0.006em` tracking): the incumbent listings application default and dense working copy.
- **Marketing body** (400, `14px`, `1.5` line-height): landing support copy; keep paragraphs around 35–55ch.
- **Metadata** (500, `11px`, `1.4` line-height): role, company, location, and recency context in the incumbent feed.
- **Label** (500–600, `8–10px`, `0.08–0.12em` tracking, often uppercase): source lanes, counts, filters, timestamps, and system status.

**The Scale Before Ornament Rule.** Establish hierarchy with type size, weight, position, and wrapping before adding color or containers. The Source Ledger marketing display ramp and the incumbent app's compact operational ramp are related roles, not one interchangeable page template.

## Layout

The Source Ledger marketing surface uses a left-weighted proposition over a full-width ledger. Its core row is a four-column relationship—source, raw posting signal, one dark live-intake seam, and normalized shortlist—with one-pixel hairlines doing the table work. Scroll sections use a full-height stage on wide screens so source fragments can align, scan, filter, and resolve into the `/jobs` handoff. On small screens those stages return to normal document flow, raw columns collapse, and the semantic order remains source → intake → role.

The `/jobs` application keeps its incumbent operating shell: a dark forest sidebar, a compact top bar, tabbed role views, filter fields, and a scrollable role list. The desktop sidebar is a 232px rail; at the 1180px rail breakpoint it narrows to 188px while keeping every destination label visible. The landing page may demonstrate that vocabulary, but it must not be treated as the dashboard or as a second data source. The only cross-surface navigation promise is the explicit CTA from `/` to `/jobs` (and the app's brand link back to `/`).

Use the shipped breakpoint families as responsive contracts: the app rail/tablet/mobile/compact changes at `1180px`, `980px`, `760px`, and `520px`; below 760px the sidebar becomes a 54px horizontal, text-labeled scroller with 44px destination targets and a restrained, pointer-transparent edge affordance; the marketing ledger tunes its rail/tablet/mobile/compact layout at `1120px`, `900px`, `780px`, and `430px`. At mobile widths, interactive links and buttons remain at least 44px tall, dense metadata may hide or wrap, and no information may depend on a sticky stage or hover.

**The Surface Boundary Rule.** `/` persuades with illustrative Source Ledger evidence and hands off; `/jobs` operates on live listings and owns filters, provenance, watchlists, and application state. Keep their composition and data authority separate.

## Elevation & Depth

This is a flat, tonal system. Paper and forest changes, hairlines, inset rules, and selected background shifts establish depth before shadows. Structural rows should remain directly on the canvas, and ambient cards, glass, glow, and floating bento surfaces are outside the system.

### Shadow Vocabulary

- **Rare ambient-low separation** (`box-shadow: 0 1px 1px rgba(23, 32, 27, .05)`): temporary or selected layers only; never a default card treatment.

**The Structural Depth Rule.** Prefer a divider, inset line, or changed field color before adding a shadow.

Motion is part of information hierarchy, not elevation. Scroll-driven narrative and row reordering use transform and opacity only (`x`, `y`, `scale`, and `opacity`); do not animate layout, dimensions, clipping, filters, or decorative properties. Small control-state color changes may be immediate or use the short state transition, but they are not the narrative motion grammar.

## Shapes

Structural fields and ledger rows are square (`0px`) or unboxed. Interactive controls use gently softened 4px corners. Incumbent app surfaces that need a larger grouping use 8px corners; 999px pills are reserved for existing status tags, never for primary layout containers. Keep borders to one-pixel hairlines, with a 2px lime rule only when it denotes an active state. The Scout lockup uses the supplied transparent compass asset; preserve its ratio and clean edges when scaling it.

## Components

### Scout brand lockup

The canonical Scout lockup is the shipped brand asset at `public/assets/brand/scout-logo.png`. Preserve its supplied transparent compass mark and wordmark; use the asset rather than substituting text, an icon font, or a generated logo. Decorative instances are `aria-hidden`; the linked brand gets a concise accessible label.

### Buttons

- **Character:** compact, decisive, and rare enough that the action is obvious.
- **Marketing primary:** signal-lime field, signal-ink text, 4px corner, 40px minimum height, and 16px horizontal padding for **Browse Internships**.
- **Incumbent app action:** dark ink or semantic app-blue treatment, 4px control corner, and the same compact Geist body voice.
- **Hover / focus:** a one-step signal shift or one-pixel transform is enough; every actionable control has a visible 2px focus outline with a 2–4px offset.
- **Touch:** at mobile and coarse pointers, links and buttons are at least 44px tall.

### Inputs / filter fields

- **Style:** paper field, one-pixel line, 4px corner, stacked 8px-ish uppercase label, and compact selected value.
- **Focus:** change the line and add the signal/app focus treatment; never rely on color alone to communicate focus.
- **Marketing filter demo:** buttons are semantic controls with `aria-pressed`; the shown rows and counts are labeled illustrative.
- **Incumbent `/jobs` filters:** preserve the real search, category, work-mode, location, status, saved-view, and sort vocabulary. These controls belong to the app, not the landing demonstration.

### Navigation

- **Marketing:** thin fixed bar, solid-on-scroll field state, real in-page links, and one visible `/jobs` CTA.
- **Incumbent app:** dark forest text-first sidebar with no destination or help icons, a compact top bar, a 232px wide rail at desktop, and a labeled 188px tablet rail.
- **Responsive rail:** below 760px, the rail becomes a horizontally scrollable labeled strip with 44px destination targets; preserve the labels and focus order.
- **Active state:** direct-on-surface row with a restrained 1px lime hairline; do not replace the rule with a destination icon.
- **Boundary:** the marketing CTA goes to `/jobs`; the app's Scout brand goes to `/`. Do not merge the landing navigation and dashboard navigation into one hybrid shell.

### Source Ledger

The signature marketing component is a direct-on-canvas six-row ledger of believable source names and role fragments. Each row enters through one sharp dark forest intake seam and emerges as an aligned role with location and recency. Use one-pixel gray-green hairlines, compact metadata, and a 2px-or-less lime state line; never add third-party company logos or source-count claims. The rows are illustrative evidence, not live application data.

### Role rows / listing feed

Use transparent or paper role rows with a hairline, compact title, location/company metadata, and a clear recency or state signal. The incumbent app owns the real list, lifecycle state, source provenance, filters, watchlist, and application actions. A selected or hovered row may use a lime inset rule or tonal shift instead of a floating card shadow.

### Scroll-driven filter sequence

The marketing filter passage is an illustrative, scroll-driven sequence on wide screens. ScrollTrigger progressively presses the semantic filter buttons and narrows the shown count through `842 → 284 → 96 → 42 → 18`; a visitor click takes manual control. Rows reorder and disappear through transform/opacity changes, while the semantic `aria-pressed`, `aria-hidden`, and summary text remain the source of meaning. On mobile the sequence is not forced by scroll; the controls remain directly operable.

### Live signal panel

Use a high-contrast forest field for current crawler/source activity, with a single lime dot or rule and a Geist Mono status label. Keep status language concrete—scanning, updated, new, completed, or failed—and do not turn an illustrative landing status into a product guarantee.

## Do's and Don'ts

### Do:

- **Do** use the Source Ledger display ramp for the marketing proposition and the incumbent compact ramp for `/jobs` instead of flattening both into one generic heading scale.
- **Do** keep the Scout lockup canonical and asset-based with its accessible name and decorative-image treatment.
- **Do** use composition, rows, dividers, provenance, and metadata as primary visual material.
- **Do** reserve signal lime for a visible state change, live signal, selected control, or decisive action.
- **Do** keep scroll choreography transform/opacity-only and make the information readable in the resting state.
- **Do** preserve semantic order, visible focus, skip navigation, strong contrast, descriptive labels, and 44px touch targets.
- **Do** honor `prefers-reduced-motion: reduce`: disable GSAP/ScrollTrigger choreography, return sticky stages to normal flow, clear transforms and opacity staging, and keep all controls and content available.
- **Do** keep landing examples believable and explicitly illustrative; send visitors to the real `/jobs` application for live data.

### Don't:

- **Don't** turn every content group into a rounded card, pill, glass panel, glow, or floating shadow.
- **Don't** introduce blue-purple gradients, generic SaaS hero patterns, device mockups, or ornamental motion.
- **Don't** animate layout, dimensions, clipping, filters, or other paint properties in the scroll narrative.
- **Don't** rely on hover, animation, a precise pointer, or color alone for comprehension or operation.
- **Don't** fabricate testimonials, customer logos, usage metrics, source counts, or generated posting errors.
- **Don't** treat `/` as the listings application or copy live `/jobs` state into the marketing route.
- **Don't** let reduced motion remove the filter controls, role rows, provenance, or direct `/jobs` handoff.
