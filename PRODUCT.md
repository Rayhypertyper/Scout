# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are students searching for software internships and co-op roles. They need to keep up with a fast-changing market without repeatedly checking company career pages, public job boards, GitHub internship repositories, university resources, and other trackers one by one.

## Product Purpose

Scout discovers, consolidates, and organizes internship opportunities so students can see newly posted roles quickly, filter the market to relevant opportunities, and move from discovery to the original application destination. Success means replacing a fragmented search routine with one current, useful feed while preserving enough role context to make faster decisions.

## Positioning

Scout combines deterministic multi-source discovery with a continuously updated listings workspace: it searches public sources, retains provenance and lifecycle state, and lets students filter, inspect, save, and track opportunities from one place.

## Operating Context

Students use Scout as an ongoing search workspace while internship postings appear, change, and close. The product scans public career pages, ATS listings, public job boards, GitHub internship lists, and structured feeds; the dashboard then presents roles, recency, source activity, filters, watchlists, and application progress.

## Capabilities and Constraints

- The existing listings application is a functional TypeScript/Node.js dashboard backed by the current crawler, APIs, SQLite data, filters, saved decisions, and application tracking.
- The crawler is deterministic and HTTP-first, with bounded browser fallback; it does not use an LLM to extract roles and never fills or submits applications.
- Missing posting facts are not invented. Role and source data must remain believable, traceable, and honest about uncertainty.
- The new marketing landing page is a separate route from the listings application. It may demonstrate the product with clearly illustrative interface data, but it must not alter the crawler, backend behavior, data layer, listings structure, or filters.
- The primary landing-page action leads into the existing listings experience.

## Brand Commitments

- The incumbent product name is Scout, with the descriptor “Opportunity intelligence.”
- Voice is concise, concrete, useful, and free of inflated startup claims.
- The landing page and listings application should feel like the same product while serving clearly different purposes.

## Evidence on Hand

- The working listings UI and product interactions are in `public/index.html`, `public/app.js`, `public/styles.css`, and `public/redesign.css`.
- The repository contains real crawler, source, role, recency, lifecycle, filter, watchlist, and application-tracking behavior that the landing page can demonstrate.
- No customer logos, testimonials, commercial benchmarks, press quotes, or usage claims were provided; future surfaces must not fabricate them.

## Product Principles

1. Replace fragmented searching with one continuously useful view.
2. Make freshness and source provenance visible.
3. Help students narrow the market without hiding important context.
4. Preserve honest data and direct application paths.
5. Keep discovery fast, legible, and respectful of the existing product workflow.

## Accessibility & Inclusion

The web experience must remain understandable and operable without animation, hover, or a precise pointer. It must support keyboard navigation, visible focus, semantic structure, strong contrast, responsive text, comfortable touch targets, and `prefers-reduced-motion`.
