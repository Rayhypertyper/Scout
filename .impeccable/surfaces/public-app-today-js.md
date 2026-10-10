---
version: 1
slug: "public-app-today-js"
primary_target: "public/app/today.js"
related_targets: ["public/app/today.css","src/dashboard/today.ts"]
---

# Scout Today

## Scope and mode

**Operate.** `/today` is Scout’s logged-in home. The user requested a direct new-listing feed without any LLM calls. Keep the incumbent warm canvas, forest shell, typography, and flat listing rows.

## Audience, job, and actions

Returning students need to see new open listings quickly. Show every listing discovered since the account’s last successful visit, newest first. A first visit covers the past seven days. Show the title, company, location, known term and compensation, and discovery timestamp. **View posting**, **Save role**, **Refresh listings**, and **Browse roles** provide the actions.

## Built direction

A single full-width list replaces the five briefing signals, category controls, and next-moves queue. The user asked to show just new listings, so this surface no longer reports saved-role changes, deadlines, follow-ups, or interviews. Application reminders remain accessible in Applications. Today reads stored listings directly without preference filtering, generated text, or model requests.

The Today title remains 32px, section heading 22px, role title 14px, and metadata 11px. Hairlines separate rows; company initials provide scanning anchors. Mobile preserves content order, wrapping, and 44px action targets.

## Data constraints

- Only open listings with a valid discovery timestamp inside the visit window appear. Rescanning an old posting does not make it new.
- The entire new-listing set appears, including postings outside selected preferences. There is no three-row preview or 50-row truncation.
- The account checkpoint advances only after a successful visible load. Failed loads preserve the previous feed and never advance the checkpoint. Refresh keeps the original session cutoff.
- Saved state comes from this browser’s watchlist. Posting URLs permit only HTTP and HTTPS.
- Loading, retry, empty, retained-feed error, and visit-save error states remain explicit. Refresh and save actions preserve focus by listing identity.

## Verification

API tests cover discovery-window filtering, ordering, full-list counts, account checkpoints, authentication, and the absence of external requests. Desktop and mobile browser coverage checks more than 50 rendered listings, working saves, refresh focus, empty/error states, and the absence of model requests. Review images use `today-listings-desktop.png` and `today-listings-mobile.png` in `.impeccable/review`.
