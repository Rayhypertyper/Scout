/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error The browser client is JavaScript and has no emitted declaration file.
import { adaptiveListLimit, applyListingActionCounts, BACKGROUND_PAGE_SIZE, buildNotifications, buildRolesQuery, canLoadMoreRoles, companyLogoDomains, companyLogoSources, companyLogoUrl, compactSourceUrl, createWatchlistEntry, crawlProgressMessage, DEFAULT_ROLE_VIEW, eligibilityPresentation, FALLBACK_ROLE_TAB, filterWatchlistRoles, formatRunDuration, getCachedDetail, getTabSnapshot, hasVersionChanged, inProgressSources, INITIAL_PAGE_SIZE, INITIAL_ROLE_TAB, insertRoleForUndo, invalidateRoleListingCaches, isCurrentIntent, isDetailCacheValid, isDetailResponseCurrent, isRoleFeedView, isScanActive, MAX_PAGE_SIZE, mergeDashboardStats, mergeNotificationHistory, mergeRolePage, NOTIFICATION_LIMIT, normalizeRolePagination, normalizeRoleView, notificationIdForRun, PREFETCH_PAGE_SIZE, prefetchBackgroundReady, prefetchLookaheadReady, provenanceSourceRows, readRoleUrlState, recentRuns, RECENT_RUN_LIMIT, rememberDetailCache, rememberSourceResults, rememberTabSnapshot, removeWatchlistRole, remainingRolePageSize, ROLE_SEASONS, ROLE_VIEWS, ROLE_WORK_MODES, roleDisplayLocation, roleFiltersKey, roleQueueHead, scanUiState, settleListRequest, shouldFallbackToCanada, shouldPrefetchRoleTab, shouldPrefetchTabLookahead, shouldReplaceTabSnapshot, sourceCheckStatus, sourceHealthCounts, sourceRunKey, upsertWatchlistRole, watchlistRoleKey } from "../public/app.js";

function role(listingId: string) {
  return { listingType: "internship", listingId, id: listingId };
}

describe("fast dashboard client state helpers", () => {
  it("normalizes the preference-aware role view and keeps it in server queries and cache keys", () => {
    expect(ROLE_VIEWS).toEqual(["matches", "all"]);
    expect(ROLE_WORK_MODES).toEqual(["all", "onsite", "hybrid", "remote"]);
    expect(ROLE_SEASONS).toEqual(["all", "winter", "spring", "summer", "fall", "unknown"]);
    expect(DEFAULT_ROLE_VIEW).toBe("all");
    expect(normalizeRoleView("matches")).toBe("matches");
    expect(normalizeRoleView("unexpected")).toBe("all");
    expect(readRoleUrlState("/jobs?view=matches&workMode=remote&season=unknown&location=Toronto%2C%20Canada&q=TypeScript")).toMatchObject({
      view: "matches",
      workMode: "remote",
      season: "unknown",
      location: "Toronto, Canada",
      search: "TypeScript",
    });
    expect(readRoleUrlState("/jobs?view=all&workMode=invalid&location=all")).toMatchObject({ view: "all", workMode: "all", location: "all" });
    const matchesQuery = buildRolesQuery({ view: "matches", tab: "main", sort: "relevance" });
    expect(matchesQuery.get("view")).toBe("matches");
    const allQuery = buildRolesQuery({ view: "all", tab: "main", sort: "posted" });
    expect(allQuery.get("view")).toBe("all");
    const filteredQuery = buildRolesQuery({ view: "matches", tab: "main", workMode: "remote", location: " Toronto, Canada " });
    expect(filteredQuery.get("workMode")).toBe("remote");
    expect(filteredQuery.get("location")).toBe("Toronto, Canada");
    expect(buildRolesQuery({ tab: "main", season: "unknown", sort: "season" }).toString()).toContain("season=unknown");
    expect(buildRolesQuery({ tab: "main", season: "unknown", sort: "season" }).get("sort")).toBe("season");
    expect(roleFiltersKey({ view: "matches", tab: "main", workMode: "remote", location: "Toronto" }))
      .not.toBe(roleFiltersKey({ view: "matches", tab: "main", workMode: "onsite", location: "Toronto" }));
    expect(roleFiltersKey({ view: "matches", tab: "main", workMode: "remote", location: "Toronto" }))
      .not.toBe(roleFiltersKey({ view: "matches", tab: "main", workMode: "remote", location: "Vancouver" }));
    expect(roleFiltersKey({ tab: "main", season: "unknown" }))
      .not.toBe(roleFiltersKey({ tab: "main", season: "summer" }));
    expect(roleFiltersKey({ view: "matches", tab: "main" })).not.toBe(roleFiltersKey({ view: "all", tab: "main" }));
  });

  it("uses explicit eligibility status and reasons without inferring from legacy unknown counts", () => {
    const evaluation = eligibilityPresentation({
      matchScore: 92,
      matchUnknownCount: 3,
      matchReasons: ["Legacy match reason"],
      eligibility: {
        version: "eligibility-v1",
        status: "likely_eligible",
        criterionResults: [
          { key: "term", state: "pass", reason: "The posting term matches your preference.", unknownSource: null },
          { key: "degree", state: "unknown", reason: "The posting does not clearly state a degree requirement.", unknownSource: "posting" },
        ],
      },
    });
    expect(evaluation).toMatchObject({
      status: "likely_eligible",
      unknownSources: ["posting"],
      explicit: true,
    });
    expect(evaluation.reasons).toContain("The posting does not clearly state a degree requirement.");

    const legacyOnly = eligibilityPresentation({ matchScore: 92, matchUnknownCount: 3, matchReasons: ["Legacy match reason"] });
    expect(legacyOnly.status).toBe("unclear");
    expect(legacyOnly.unknownSources).toEqual([]);
    expect(legacyOnly.explicit).toBe(false);
  });

  it("builds run notifications from completed and failed crawl states", () => {
    const notifications = buildNotifications({
      runs: [
        { id: 12, status: "FAILED", started_at: "2026-08-23T10:00:00.000Z", finished_at: "2026-08-23T10:02:00.000Z", error_message: "Source timed out" },
        { id: 11, status: "COMPLETED", started_at: "2026-08-23T09:00:00.000Z", finished_at: "2026-08-23T09:04:00.000Z", internships_discovered: 8 },
      ],
      latestCompletedRun: { id: 11, status: "COMPLETED", started_at: "2026-08-23T09:00:00.000Z", finished_at: "2026-08-23T09:04:00.000Z", internships_discovered: 8, new_count: 3 },
    });

    expect(NOTIFICATION_LIMIT).toBe(20);
    expect(notificationIdForRun({ id: 11, status: "COMPLETED" })).toBe("run-completed-11");
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({ id: "run-failed-12", kind: "run-failed", title: "Crawl failed" });
    expect(notifications[1]).toMatchObject({ id: "run-completed-11", kind: "run-completed", title: "Crawl completed" });
    expect(notifications[1].message).toContain("3 new roles found");
  });

  it("deduplicates notification history while refreshing completed-run details", () => {
    const original = { id: "run-completed-4", runId: 4, timestamp: "2026-08-23T08:00:00.000Z", message: "#4 completed" };
    const refreshed = { ...original, message: "#4 completed · 2 new roles found" };
    expect(mergeNotificationHistory([original], [refreshed])).toEqual([refreshed]);
    expect(mergeNotificationHistory([original], [{ id: "run-completed-5", runId: 5, timestamp: "2026-08-23T09:00:00.000Z" }])).toHaveLength(2);
  });

  it("resolves company logo domains from employer links and ATS slugs", () => {
    expect(companyLogoDomains({
      company: "Sentry",
      applicationUrl: "https://jobs.ashbyhq.com/sentry/role-1/application",
    })[0]).toBe("sentry.io");
    expect(companyLogoDomains({
      company: "Acme Labs",
      applicationUrl: "https://jobs.lever.co/acme-labs/role-1",
    })).toContain("acme-labs.com");
    expect(companyLogoDomains({
      company: "Acme Labs",
      applicationUrl: "https://jobright.ai/jobs/info/role-1",
    })).toEqual(expect.arrayContaining(["acmelabs.com", "acme-labs.com"]));
    expect(companyLogoDomains({
      company: "Acme Labs",
      applicationUrl: "https://jobright.ai/jobs/info/role-1",
    })).not.toContain("jobright.ai");
    expect(companyLogoDomains({
      company: "AdaMarie",
      applicationUrl: "https://jobright.ai/jobs/info/role-1",
      sourceUrl: "https://www.intern-list.com/",
    })).toEqual(expect.arrayContaining(["adamarie.com", "ada-marie.com"]));
    expect(companyLogoDomains({
      company: "**AMD**",
      applicationUrl: "https://www.dreamworkhq.com/c/amd.com",
    })[0]).toBe("amd.com");
    expect(companyLogoDomains({
      company: "American Express",
      applicationUrl: "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011999",
    })).toContain("americanexpress.com");
    expect(companyLogoDomains({
      company: "American Express",
      applicationUrl: "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011999",
    })).not.toContain("oraclecloud.com");
    expect(companyLogoDomains({
      company: "BAE Systems",
      applicationUrl: "https://jobright.ai/jobs/info/role-1",
    })).toContain("baesystems.com");
    expect(companyLogoDomains({
      company: "Pony.ai",
      applicationUrl: "https://apply.workable.com/pony-dot-ai/j/BA5FFDBC71",
    })).toContain("pony.ai");
    expect(companyLogoDomains({
      company: "TikTok",
      applicationUrl: "https://lifeattiktok.com/search/7675847556668295429",
    })[0]).toBe("tiktok.com");
    expect(companyLogoDomains({
      company: "Amazon",
      applicationUrl: "https://www.amazon.jobs/en/jobs/3179209/software-development-engineer",
    })).toContain("amazon.com");
    expect(companyLogoDomains({
      company: "Tenstorrent",
      applicationUrl: "https://job-boards.greenhouse.io/tenstorrentuniversity/jobs/4968215007",
    })).toContain("tenstorrent.com");
    expect(companyLogoDomains({
      company: "Emory University",
      applicationUrl: "https://emory.jibeapply.com/jobs/172196",
    })).toContain("emory.edu");
    expect(companyLogoDomains({
      company: "LinkedIn",
      applicationUrl: "https://jobs.smartrecruiters.com/LinkedIn3/744000117754057",
    })).toContain("linkedin.com");
    expect(companyLogoDomains({
      company: "HNI Corporation",
      applicationUrl: "https://hnicareers.com/job/1",
    })).toContain("hni.com");
  });

  it("builds a logo image URL without falling back to company initials", () => {
    const role = { company: "Acme Labs", applicationUrl: "https://acme.example/jobs/role-1" };
    expect(companyLogoUrl(role)).toBe("https://logos.hunter.io/acme.example");
    expect(companyLogoSources(role)).toContain("https://www.google.com/s2/favicons?sz=128&domain=acme.example");
    expect(readFileSync(new URL("../public/app.js", import.meta.url), "utf8")).not.toContain("companyInitials");
  });

  it("defaults the initial role tab to Canada", () => {
    expect(INITIAL_ROLE_TAB).toBe("canada");
    expect(FALLBACK_ROLE_TAB).toBe("canada");
    const markup = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(markup).toContain('class="role-tab active" id="canada-tab"');
    expect(markup).toContain('class="role-tab" id="summer-tab"');
    expect(shouldFallbackToCanada({ pagination: { total: 0 }, items: [] })).toBe(true);
    expect(shouldFallbackToCanada({ pagination: { total: 1 }, items: [] })).toBe(false);
    expect(shouldFallbackToCanada({ items: [] })).toBe(true);
    expect(shouldFallbackToCanada({ pagination: { total: 0 }, items: [{ id: "summer-1" }] })).toBe(true);
  });

  it("shows the Canadian location when a mixed posting is viewed in Canada", () => {
    const mixed = {
      location: ["San Diego, CA", "Toronto, ON, Canada"],
      canadianLocation: "Toronto, ON, Canada",
    };

    expect(roleDisplayLocation(mixed, "canada")).toBe("Toronto, ON, Canada");
    expect(roleDisplayLocation(mixed, "main")).toBe("San Diego, CA");
  });

  it("constructs compact server queries without empty filters", () => {
    const query = buildRolesQuery({
      tab: "main",
      status: "updated",
      search: "  TypeScript / Beta  ",
      category: "swe",
      sort: "company",
      limit: 8,
      offset: 16,
    });

    expect(query.toString()).toBe("tab=main&status=updated&sort=company&limit=8&offset=16&q=TypeScript+%2F+Beta&category=swe");
    expect(buildRolesQuery({ search: "", category: "all" }).has("q")).toBe(false);
    expect(buildRolesQuery({ search: "", category: "all" }).has("category")).toBe(false);
    expect(buildRolesQuery().get("limit")).toBe("40");
  });

  it("keeps watchlist entries independent from discovery actions and applies local filters", () => {
    const acme = createWatchlistEntry({
      listingType: "internship", listingId: "acme-1", company: "Acme", title: "Software Intern",
      categories: ["swe"], technologies: ["TypeScript"], location: ["Toronto, Canada"],
      remoteStatus: "hybrid", postingDate: "2026-08-20", availabilityStatus: "open",
      internshipTerm: "Summer", internshipYear: "2027",
    }, "2026-08-21T12:00:00.000Z");
    const beta = createWatchlistEntry({
      listingType: "internship", listingId: "beta-1", company: "Beta", title: "Data Intern",
      categories: ["data"], technologies: ["Python"], location: ["New York, NY"],
      remoteStatus: "onsite", postingDate: "2026-08-19", availabilityStatus: "closed",
      internshipTerm: "Fall", internshipYear: "2027",
    }, "2026-08-22T12:00:00.000Z");
    const old = createWatchlistEntry({
      listingType: "internship", listingId: "old-1", company: "Old", title: "Software Intern",
      categories: ["swe"], technologies: ["JavaScript"], location: ["Toronto, Canada"],
      remoteStatus: "remote", postingDate: "2026-01-01", availabilityStatus: "open",
    }, "2026-08-22T12:00:00.000Z");
    expect(acme).not.toBeNull();
    expect(beta).not.toBeNull();
    expect(old).not.toBeNull();
    const entries = upsertWatchlistRole(upsertWatchlistRole(upsertWatchlistRole([], acme), beta), old);
    expect(entries).toHaveLength(3);
    const filteredAcme = filterWatchlistRoles(entries, { search: "typescript", category: "swe", workMode: "hybrid" }) as Array<{ listingId: string }>;
    const filteredClosed = filterWatchlistRoles(entries, { status: "closed" }) as Array<{ listingId: string }>;
    const filteredCurrent = filterWatchlistRoles(entries, { status: "all" }) as Array<{ listingId: string }>;
    const filteredUnknownSeason = filterWatchlistRoles(entries, { status: "all", season: "unknown" }) as Array<{ listingId: string }>;
    expect(filteredAcme.map((role: { listingId: string }) => role.listingId)).toEqual(["acme-1"]);
    expect(filteredClosed.map((role: { listingId: string }) => role.listingId)).toEqual(["beta-1"]);
    expect(filteredCurrent.map((role: { listingId: string }) => role.listingId)).toContain("old-1");
    expect(filteredUnknownSeason.map((role: { listingId: string }) => role.listingId)).toEqual(["old-1"]);
    expect(watchlistRoleKey(acme)).toBe("internship:acme-1");
    const remaining = removeWatchlistRole(entries, "internship:acme-1") as Array<{ listingId: string }>;
    expect(remaining.map((role: { listingId: string }) => role.listingId)).toEqual(["old-1", "beta-1"]);
  });

  it("pages past the initial forty-card page and caps the rendered list at five hundred", () => {
    expect(canLoadMoreRoles({ hasMore: true, nextOffset: 40, total: 80 }, 40)).toBe(true);
    expect(canLoadMoreRoles({ hasMore: true, nextOffset: 40, total: 40 }, 40)).toBe(false);
    expect(canLoadMoreRoles({ hasMore: true, nextOffset: 500, total: 500 }, 500)).toBe(false);
    expect(canLoadMoreRoles({ hasMore: false, nextOffset: null }, 8)).toBe(false);
  });

  it("treats the filtered total as a hard pagination boundary", () => {
    expect(normalizeRolePagination({ limit: 8, offset: 40, total: 44, hasMore: true, nextOffset: 44 }, 44, 4))
      .toMatchObject({ hasMore: false, nextOffset: null });
    expect(normalizeRolePagination({ limit: 8, offset: 40, total: 44, hasMore: true, nextOffset: 48 }, 44, 4))
      .toMatchObject({ hasMore: false, nextOffset: null });
    expect(normalizeRolePagination({ limit: 8, offset: 40, total: 100, hasMore: true, nextOffset: 40 }, 40, 8))
      .toMatchObject({ hasMore: false, nextOffset: null });
    expect(canLoadMoreRoles({ hasMore: true, nextOffset: 44, total: 44 }, 44)).toBe(false);
    expect(remainingRolePageSize({ total: 44 }, 40, 8)).toBe(4);
    expect(remainingRolePageSize({ total: 44 }, 44, 8)).toBe(0);
    expect(remainingRolePageSize({ total: 44 }, 40, 100)).toBe(4);
  });

  it("keeps the background loader that fills tabs beyond the first page", () => {
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(source).toMatch(/BACKGROUND_PAGE_SIZE/);
    expect(source).toMatch(/PREFETCH_PAGE_SIZE/);
    expect(source).toMatch(/MAX_PAGE_SIZE/);
    expect(source).toMatch(/normalizeRolePagination/);
    expect(source).toMatch(/remainingRolePageSize/);
    expect(source).toMatch(/drainRemainingRoles/);
    expect(source).toMatch(/maybeDrainRemainingRoles/);
    expect(source).toMatch(/prefetchRoleTabs/);
    expect(source).toMatch(/appendRoleCards/);
    expect(source).toMatch(/prefetchRoleTabSnapshot/);
    expect(source).toMatch(/shouldPrefetchTabLookahead/);
    expect(source).toMatch(/prefetchBackgroundReady/);
    expect(source).toMatch(/Promise\.all\(ROLE_TABS\.map/);
    expect(source).toMatch(/Loading more roles/);
    expect(source).not.toMatch(/data-load-more/);
    expect(source).not.toMatch(/Load more roles/);
    expect(source.match(/fetch\(rolesPath/g) || []).toHaveLength(1);
  });

  it("sizes refreshes to at least the initial page and never above the server cap", () => {
    expect(INITIAL_PAGE_SIZE).toBe(40);
    expect(PREFETCH_PAGE_SIZE).toBe(20);
    expect(BACKGROUND_PAGE_SIZE).toBe(8);
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(BACKGROUND_PAGE_SIZE).not.toBe(MAX_PAGE_SIZE);
    expect(PREFETCH_PAGE_SIZE).not.toBe(INITIAL_PAGE_SIZE);
    expect(adaptiveListLimit(0)).toBe(40);
    expect(adaptiveListLimit(40)).toBe(40);
    expect(adaptiveListLimit(250)).toBe(100);
  });

  it("starts other-tab prefetch after the first page, and yields drain after the first extra chunk", () => {
    expect(prefetchBackgroundReady(0, { hasMore: true, nextOffset: 0 })).toBe(false);
    expect(prefetchBackgroundReady(0, { hasMore: false, nextOffset: null })).toBe(false);
    expect(prefetchBackgroundReady(40, { hasMore: true, nextOffset: 40 })).toBe(true);
    expect(prefetchBackgroundReady(20, { hasMore: false, nextOffset: null })).toBe(true);
    expect(prefetchLookaheadReady(40, { hasMore: true, nextOffset: 40 })).toBe(false);
    expect(prefetchLookaheadReady(48, { hasMore: true, nextOffset: 48 })).toBe(true);
    expect(prefetchLookaheadReady(40, { hasMore: false, nextOffset: null })).toBe(true);
  });

  it("does not replace a richer tab snapshot with a first-page prefetch", () => {
    const rich = {
      items: Array.from({ length: 80 }, (_, index) => role(String(index))),
      pagination: { hasMore: true, nextOffset: 80 },
      version: "v1",
    };
    const firstPage = {
      items: Array.from({ length: 40 }, (_, index) => role(String(index))),
      pagination: { hasMore: true, nextOffset: 40 },
      version: "v1",
    };
    const warm = {
      items: Array.from({ length: 20 }, (_, index) => role(String(index))),
      pagination: { hasMore: true, nextOffset: 20 },
      version: "v1",
    };
    expect(shouldPrefetchRoleTab(rich, "v1")).toBe(false);
    expect(shouldReplaceTabSnapshot(rich, firstPage)).toBe(false);
    expect(shouldPrefetchRoleTab(undefined, "v1")).toBe(true);
    expect(shouldPrefetchRoleTab(warm, "v1")).toBe(false);
    expect(shouldPrefetchRoleTab({ ...warm, items: warm.items.slice(0, 19) }, "v1")).toBe(true);
    expect(shouldPrefetchRoleTab(firstPage, "v2")).toBe(true);
    expect(shouldReplaceTabSnapshot(firstPage, { ...firstPage, version: "v2" })).toBe(true);
    expect(shouldPrefetchTabLookahead(warm, "v1")).toBe(true);
    expect(shouldPrefetchTabLookahead(firstPage, "v1")).toBe(false);
    expect(shouldPrefetchTabLookahead(rich, "v1")).toBe(false);
    expect(shouldPrefetchTabLookahead(undefined, "v1")).toBe(false);
  });

  it("keys tab snapshots by the full filter set and evicts the stalest view", () => {
    const cache = new Map();
    const mainKey = roleFiltersKey({ tab: "main", status: "open", search: "", category: "all", sort: "relevance" });
    expect(mainKey).not.toBe(roleFiltersKey({ tab: "summer", status: "open", search: "", category: "all", sort: "relevance" }));
    expect(mainKey).not.toBe(roleFiltersKey({ tab: "main", status: "open", search: "", category: "all", sort: "posted" }));
    expect(roleFiltersKey({ tab: "main", search: "  TypeScript " })).toBe(roleFiltersKey({ tab: "main", search: "typescript" }));

    rememberTabSnapshot(cache, mainKey, { items: [role("1")], pagination: { hasMore: false }, version: "v1" }, 2);
    rememberTabSnapshot(cache, "canada|open|relevance||all", { items: [], version: "v1" }, 2);
    rememberTabSnapshot(cache, "summer|open|relevance||all", { items: [], version: "v1" }, 2);
    expect(cache.size).toBe(2);
    expect(getTabSnapshot(cache, mainKey)).toBeNull();
    expect(getTabSnapshot(cache, "summer|open|relevance||all")?.version).toBe("v1");
    // Reading a snapshot refreshes its recency so it survives the next eviction.
    rememberTabSnapshot(cache, mainKey, { items: [], version: "v1" }, 2);
    expect(getTabSnapshot(cache, "summer|open|relevance||all")).not.toBeNull();
    expect(getTabSnapshot(cache, "canada|open|relevance||all")).toBeNull();
  });

  it("clears every cached listing view when a decision changes visibility", () => {
    const tabSnapshots = new Map([["summer|open|relevance||all", { items: [role("hidden")], version: "v1" }]]);
    const detailCache = new Map([["internship:hidden", { listVersion: "v1", role: role("hidden") }]]);

    invalidateRoleListingCaches(tabSnapshots, detailCache);

    expect(tabSnapshots.size).toBe(0);
    expect(detailCache.size).toBe(0);
  });

  it("deduplicates pages and bounds rendered cards", () => {
    const firstPage = Array.from({ length: 8 }, (_, index) => role(String(index)));
    const secondPage = [role("7"), ...Array.from({ length: 8 }, (_, index) => role(String(index + 8)))];
    const merged: Array<{ listingId: string }> = mergeRolePage(firstPage, secondPage, 10);

    expect(merged).toHaveLength(10);
    expect(merged.map((item) => item.listingId)).toEqual(["6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
  });

  it("restores an undone role at its previous position without duplicating it", () => {
    const first = role("first");
    const second = role("second");
    const restored = role("restored");

    expect(insertRoleForUndo([first, second], restored, 1).map((item: { listingId: string }) => item.listingId))
      .toEqual(["first", "restored", "second"]);
    expect(insertRoleForUndo([first, restored, second], restored, 0).map((item: { listingId: string }) => item.listingId))
      .toEqual(["restored", "first", "second"]);
    expect(insertRoleForUndo([first], null, 0)).toEqual([first]);
  });

  it("recognizes both screens that render the live role feed", () => {
    expect(isRoleFeedView("roles")).toBe(true);
    expect(isRoleFeedView("dashboard")).toBe(true);
    expect(isRoleFeedView("applications")).toBe(false);
  });

  it("keeps the featured role at the head of the visible queue", () => {
    const queue = [role("first"), role("second"), role("third")];

    expect(roleQueueHead(queue)?.listingId).toBe("first");
    expect(roleQueueHead(queue.slice(1))?.listingId).toBe("second");
    expect(roleQueueHead([])).toBeNull();
  });

  it("keeps every loaded role when no render cap is provided", () => {
    const firstPage = Array.from({ length: 40 }, (_, index) => role(String(index)));
    const secondPage = Array.from({ length: 8 }, (_, index) => role(String(index + 40)));

    expect(mergeRolePage(firstPage, secondPage)).toHaveLength(48);
  });

  it("clears append loading after successive pages and leaves stale aborts alone", () => {
    const pageOne = Array.from({ length: 8 }, (_, index) => role(String(index)));
    const pageTwo = Array.from({ length: 8 }, (_, index) => role(String(index + 8)));
    const pageThree = Array.from({ length: 8 }, (_, index) => role(String(index + 16)));
    let loaded = mergeRolePage([], pageOne);
    let currentRevision = 1;

    let settled = settleListRequest(1, currentRevision);
    expect(settled).toEqual({ current: true, loading: false, loadingMore: false, render: true });
    loaded = mergeRolePage(loaded, pageTwo);
    expect(loaded).toHaveLength(16);

    currentRevision = 2;
    settled = settleListRequest(2, currentRevision, { append: true, failed: true });
    expect(settled.loadingMore).toBe(false);
    expect(settled.render).toBe(true);
    expect(settleListRequest(2, currentRevision, { failed: true }).render).toBe(false);
    loaded = mergeRolePage(loaded, pageThree);
    expect(loaded).toHaveLength(24);

    // A superseded request (including an abort or failure after intent change)
    // must not clear the newer request's loading state.
    settled = settleListRequest(2, currentRevision + 1);
    expect(settled).toEqual({ current: false });
  });

  it("rejects stale intent and only treats changed versions as reloads", () => {
    expect(isCurrentIntent(2, 2)).toBe(true);
    expect(isCurrentIntent(2, 3)).toBe(false);
    expect(hasVersionChanged("v1", "v2")).toBe(true);
    expect(hasVersionChanged("v1", "v1")).toBe(false);
    expect(hasVersionChanged(null, "v2")).toBe(false);
  });

  it("applies listing-action counts without waiting for a role reload", () => {
    const data = { appliedRoleCount: 2, stats: { closed: 4, hidden: 6, open: 20 } };
    const next = applyListingActionCounts(data, { appliedRoleCount: 3, closedCount: 4, hiddenCount: 7 });

    expect(next).toEqual({ appliedRoleCount: 3, stats: { closed: 4, hidden: 7, open: 20 } });
    expect(data).toEqual({ appliedRoleCount: 2, stats: { closed: 4, hidden: 6, open: 20 } });
  });

  it("keeps full crawl totals when a status poll sends partial stats", () => {
    expect(mergeDashboardStats(
      { open: 2_512, new: 242, updated: 598, closed: 1_581, hidden: 746 },
      { hidden: 746 },
    )).toEqual({ open: 2_512, new: 242, updated: 598, closed: 1_581, hidden: 746 });
  });

  it("reuses detail cache within one list snapshot despite differing detail validators", () => {
    const cache = new Map();
    const cached = { listVersion: "list-v4", detailVersion: "detail-v9", detailEtag: '"detail-v9"', role: { description: "cached" } };
    let requests = 0;

    const reopen = () => {
      const entry = getCachedDetail(cache, "internship:1", "list-v4");
      if (!entry) {
        requests += 1;
        rememberDetailCache(cache, "internship:1", cached);
      }
    };

    reopen();
    reopen();
    expect(requests).toBe(1);
    expect(isDetailCacheValid(cached, "list-v4")).toBe(true);
    expect(isDetailCacheValid({ ...cached, detailVersion: "detail-v10" }, "list-v4")).toBe(true);
    expect(isDetailCacheValid(cached, "list-v5")).toBe(false);
    expect(isDetailCacheValid(null, "list-v4")).toBe(false);
  });

  it("invalidates details on list-version changes and rejects stale responses", () => {
    const cache = new Map([["internship:1", { listVersion: "list-v4", detailVersion: "detail-v9", role: {} }]]);
    expect(getCachedDetail(cache, "internship:1", "list-v4")).not.toBeNull();
    expect(getCachedDetail(cache, "internship:1", "list-v5")).toBeNull();
    expect(isDetailResponseCurrent(3, 3, "list-v4", "list-v4")).toBe(true);
    expect(isDetailResponseCurrent(3, 4, "list-v4", "list-v4")).toBe(false);
    expect(isDetailResponseCurrent(3, 3, "list-v4", "list-v5")).toBe(false);
  });

  it("bounds detail cache entries while retaining the newest roles", () => {
    const cache = new Map();
    rememberDetailCache(cache, "one", { listVersion: "v1", role: {} }, 2);
    rememberDetailCache(cache, "two", { listVersion: "v1", role: {} }, 2);
    rememberDetailCache(cache, "three", { listVersion: "v1", role: {} }, 2);
    expect(cache.size).toBe(2);
    expect(cache.has("one")).toBe(false);
    expect(cache.has("three")).toBe(true);
  });

  it("does not let a stale RUNNING row trap the dashboard", () => {
    const now = Date.parse("2026-08-17T20:00:00.000Z");
    const stale = {
      scan: { active: false, status: "IDLE" },
      latestRun: { status: "RUNNING", heartbeat_at: "2026-08-17T08:00:00.000Z", started_at: "2026-08-17T08:00:00.000Z" },
    };
    const ui = scanUiState(stale);

    expect(isScanActive(stale, now)).toBe(false);
    expect(ui).toMatchObject({ active: false, refreshEnabled: true, terminateVisible: false, waitForCompletion: false });
    expect(isScanActive({ scan: { status: "RUNNING" }, latestRun: { status: "RUNNING", heartbeat_at: "2026-08-17T19:58:00.000Z" } }, now)).toBe(true);
    expect(isScanActive({ scan: { status: "RUNNING" }, latestRun: { status: "RUNNING", heartbeat_at: "2026-08-17T08:00:00.000Z" } }, now)).toBe(false);
  });

  it("prefers the live in-progress source URL over a generic crawl label", () => {
    expect(inProgressSources({
      scan: {
        currentSources: [{ url: "https://jobs.example.test/a", startedAt: "2026-08-19T00:00:00.000Z" }],
      },
    }).map((source: { url: string }) => source.url)).toEqual(["https://jobs.example.test/a"]);
    expect(inProgressSources({
      scan: { currentSource: { url: "https://jobs.example.test/b", startedAt: "2026-08-19T00:00:00.000Z" } },
    }).map((source: { url: string }) => source.url)).toEqual(["https://jobs.example.test/b"]);
    expect(inProgressSources({
      scan: { currentSources: [] },
      sourceResults: [{ url: "https://jobs.example.test/c", settled: 0, started_at: "2026-08-19T00:00:00.000Z" }],
    }).map((source: { url: string }) => source.url)).toEqual(["https://jobs.example.test/c"]);
    expect(inProgressSources({ scan: { currentSources: [] } })).toEqual([]);
  });

  it("shortens long current-source urls while keeping host and path ends", () => {
    expect(compactSourceUrl("https://jobs.example.test/careers")).toBe("jobs.example.test/careers");
    expect(compactSourceUrl("https://www.example.com/")).toBe("example.com");
    const longUrl = "https://jobs.ashbyhq.com/very-long-company-name/02136b22-35b1-4b3d-8bef-567c3380a849/application?utm_source=board";
    const compact = compactSourceUrl(longUrl);
    expect(compact.length).toBeLessThanOrEqual(44);
    expect(compact).toContain("…");
    expect(compact.startsWith("jobs.ashbyhq.com")).toBe(true);
  });

  it("lists every provenance source as success, partial, failed, or unchecked", () => {
    const now = Date.parse("2026-08-19T20:00:00.000Z");
    const payload = {
      scan: {
        active: true,
        status: "RUNNING",
        runId: 12,
        currentSources: [{ url: "https://jobs.example.test/checking", startedAt: "2026-08-19T19:59:00.000Z" }],
        configuredSourceCount: 5,
      },
      latestRun: { id: 12, status: "RUNNING", heartbeat_at: "2026-08-19T19:59:30.000Z", started_at: "2026-08-19T19:55:00.000Z", sources_settled: 3 },
      sources: [
        { url: "https://jobs.example.test/checking", isConfigured: true },
        { url: "https://jobs.example.test/queued", isConfigured: true },
        { url: "https://jobs.example.test/done", last_status: "COMPLETED", isConfigured: true },
        { url: "https://jobs.example.test/partial", isConfigured: true },
        { url: "https://jobs.example.test/failed", isConfigured: true },
      ],
      sourceResults: [
        { url: "https://jobs.example.test/done", settled: 1, completed: 1, status: "success", jobs_discovered: 4, failure_count: 0, duration_ms: 1200 },
        { url: "https://jobs.example.test/partial", settled: 1, completed: 1, status: "partial", jobs_discovered: 8, failure_count: 1, duration_ms: 900 },
        { url: "https://jobs.example.test/failed", settled: 1, completed: 0, status: "source_unavailable", jobs_discovered: 0, failure_count: 1, duration_ms: 800 },
      ],
    };
    const rows = provenanceSourceRows(payload);
    expect(isScanActive({ scan: { active: true }, latestRun: { status: "RUNNING", heartbeat_at: "2026-08-19T19:59:30.000Z" } }, now)).toBe(true);
    expect(sourceCheckStatus({ settled: 1, completed: 1, status: "partial", failure_count: 1 })).toBe("partial");
    expect(sourceCheckStatus({ settled: 1, completed: 1, status: "success", failure_count: 2 })).toBe("partial");
    expect(rows.map((row: { url: string; label: string }) => [row.url, row.label])).toEqual([
      ["https://jobs.example.test/failed", "failed"],
      ["https://jobs.example.test/partial", "partial"],
      ["https://jobs.example.test/done", "success"],
      ["https://jobs.example.test/checking", "unchecked"],
      ["https://jobs.example.test/queued", "unchecked"],
    ]);
    expect(sourceHealthCounts(payload)).toMatchObject({
      sourceCount: 5,
      settled: 3,
      success: 1,
      partial: 1,
      failed: 1,
      unchecked: 2,
    });
  });

  it("keeps failed-run health, settled counts, and provenance on the same crawl", () => {
    const payload = {
      scan: { active: false, status: "IDLE", configuredSourceCount: 19, runId: 154 },
      latestRun: {
        id: 155,
        status: "FAILED",
        sources_settled: 16,
        error_message: "Marked stale after exceeding the maximum crawl duration.",
      },
      latestCompletedRun: { id: 154, status: "COMPLETED" },
      sources: Array.from({ length: 19 }, (_, index) => ({ url: `https://jobs.example.test/source-${index}`, isConfigured: true })),
      sourceResults: Array.from({ length: 16 }, (_, index) => ({
        url: `https://jobs.example.test/source-${index}`,
        settled: 1,
        completed: 1,
        status: index === 0 ? "partial" : "success",
        jobs_discovered: 1,
        failure_count: index === 0 ? 1 : 0,
      })),
      failures: [{ source_url: "https://jobs.example.test/source-0", error_type: "http_error", status_code: 404, message: "Not found", count: 1 }],
    };
    expect(sourceRunKey(payload)).toBe(155);
    const health = sourceHealthCounts(payload);
    expect(health).toMatchObject({ sourceCount: 19, settled: 16, success: 15, partial: 1, failed: 0, unchecked: 3 });
    expect(crawlProgressMessage(payload)).toBe("Last run failed after 16/19 sources settled: Marked stale after exceeding the maximum crawl duration.");
  });

  it("keeps checked sources for the current run and resets when a new run starts", () => {
    const first = rememberSourceResults(12, { runKey: null, results: [] }, [
      { url: "https://jobs.example.test/done", settled: 1, completed: 1, status: "success" },
    ]);
    const sameRun = rememberSourceResults(12, first, [
      { url: "https://jobs.example.test/checking", settled: 0, completed: 0, status: "source_unavailable" },
    ]);
    expect(sameRun.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://jobs.example.test/done", settled: 1 }),
      expect.objectContaining({ url: "https://jobs.example.test/checking", settled: 0 }),
    ]));
    const nextRun = rememberSourceResults(13, sameRun, []);
    expect(nextRun).toEqual({ runKey: 13, results: [] });
  });

  it("keeps a fresh active scan blocking refresh and completion", () => {
    const now = Date.parse("2026-08-17T20:00:00.000Z");
    const active = {
      scan: { active: true, status: "RUNNING", startedAt: "2026-08-17T19:55:00.000Z" },
      latestRun: { status: "RUNNING", heartbeat_at: "2026-08-17T19:59:30.000Z", started_at: "2026-08-17T19:55:00.000Z" },
    };
    const ui = scanUiState(active);

    expect(isScanActive(active, now)).toBe(true);
    expect(ui).toMatchObject({ active: true, refreshEnabled: false, terminateVisible: true, waitForCompletion: true });
  });

  it("shows the latest five runs and falls back to latestRun", () => {
    expect(RECENT_RUN_LIMIT).toBe(5);
    expect(recentRuns({
      runs: [6, 5, 4, 3, 2, 1].map((id) => ({ id })),
    }).map((run: { id: number }) => run.id)).toEqual([6, 5, 4, 3, 2]);
    expect(recentRuns({ latestRun: { id: 9 } }).map((run: { id: number }) => run.id)).toEqual([9]);
    expect(recentRuns({ runs: [], latestRun: { id: 8 } }).map((run: { id: number }) => run.id)).toEqual([8]);
    expect(recentRuns({})).toEqual([]);
  });

  it("formats elapsed time for completed historical runs", () => {
    expect(formatRunDuration({
      started_at: "2026-08-19T17:21:13.584Z",
      finished_at: "2026-08-19T17:26:56.500Z",
    })).toBe("5m 43s elapsed");
    expect(formatRunDuration({
      started_at: "2026-08-19T18:13:51.059Z",
      finished_at: "2026-08-20T00:17:45.325Z",
    })).toBe("6h 03m 54s elapsed");
    expect(formatRunDuration({
      started_at: "2026-08-20T00:17:48.812Z",
      finished_at: null,
    })).toMatch(/elapsed$/);
  });
});
