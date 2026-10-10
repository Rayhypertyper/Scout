/* global AbortController, document, Element, fetch, URL, setTimeout, clearTimeout */

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function postingUrl(role) {
  try {
    const url = new URL(role.postingUrl || role.applicationUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function createTodayController({ authClient, getSavedRoles, saveRole }) {
  const content = document.querySelector("#today-content");
  let summary = null;
  let error = null;
  let request = null;
  let requestController = null;
  let baseline = null;
  let firstVisit = false;
  let owner = null;
  let visitRecorded = false;
  let visitError = null;
  let revision = 0;
  let renderedMarkup = "";

  function replaceContent(markup) {
    if (!content || renderedMarkup === markup) return;
    const focused = content.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.dataset?.todayFocus;
    content.innerHTML = markup;
    renderedMarkup = markup;
    if (focusId) {
      [...content.querySelectorAll("[data-today-focus]")]
        .find((control) => control.dataset.todayFocus === focusId)?.focus({ preventScroll: true });
    }
  }

  const when = (value) => new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));

  function rowHtml(role, index, savedKeys) {
    const url = postingUrl(role);
    const key = `${role.listingType}:${role.listingId}`;
    const saved = savedKeys.has(key);
    const location = (role.location || []).join(" · ");
    const details = [role.internshipTerm && [role.internshipTerm, role.internshipYear].filter(Boolean).join(" "), role.salary].filter(Boolean).join(" · ");
    return `<article class="today-row">
      <span class="today-company-mark" aria-hidden="true">${escapeHtml(role.company.slice(0, 1).toUpperCase())}</span>
      <div><h3>${escapeHtml(role.title)}</h3><p>${escapeHtml(role.company)}${location ? ` · ${escapeHtml(location)}` : ""}</p>
        ${details ? `<p>${escapeHtml(details)}</p>` : ""}
        <p class="today-reason">Added <time datetime="${escapeHtml(role.firstSeenAt)}">${escapeHtml(when(role.firstSeenAt))}</time></p>
        <div class="today-row-actions">
          ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-today-focus="${escapeHtml(`${key}:posting`)}">View posting <span aria-hidden="true">↗</span></a>` : '<span class="muted">Posting link unavailable</span>'}
          <button type="button" data-today-save="${index}" data-today-focus="${escapeHtml(`${key}:save`)}" aria-pressed="${saved}" aria-label="${escapeHtml(`${saved ? "Remove saved" : "Save"} ${role.title} at ${role.company}`)}">${saved ? "Saved" : "Save role"}</button>
        </div>
      </div>
    </article>`;
  }

  function render() {
    if (!content) return;
    content.setAttribute("aria-busy", String(Boolean(request)));
    const refresh = document.querySelector("#today-refresh");
    if (refresh) refresh.disabled = Boolean(request);
    if (error && !summary) {
      replaceContent(`<div class="today-error" role="alert"><h2>New listings couldn’t load.</h2><p>${escapeHtml(error)}</p><button class="button button-subtle" type="button" data-today-retry data-today-focus="retry">Try again</button></div>`);
      return;
    }
    if (!summary) return;
    document.querySelector("#today-subtitle").textContent = firstVisit
      ? "Added in the past 7 days, newest first."
      : `Added since ${when(baseline)}, newest first.`;
    const listings = Array.isArray(summary.newListings) ? summary.newListings : [];
    const reportedCount = summary.counts?.newListings;
    const count = Number.isSafeInteger(reportedCount) && reportedCount >= 0
      ? reportedCount
      : listings.length;
    const savedKeys = new Set(getSavedRoles().map((role) => `${role.listingType || "internship"}:${role.listingId || role.id}`));
    replaceContent(`<section class="today-queue" id="today-queue" aria-labelledby="today-queue-title">
      <div class="today-queue-head"><h2 id="today-queue-title">New listings</h2><span>${count} ${count === 1 ? "listing" : "listings"}</span></div>
      ${count ? listings.map((role, index) => rowHtml(role, index, savedKeys)).join("")
        : '<div class="today-empty"><h3>You’re up to date.</h3><p>No new open listings in this time period. Check back later or browse all roles.</p><a class="button button-subtle" href="/jobs?view=all&tab=main&season=all&sort=posted" data-today-focus="empty:roles">Browse roles</a></div>'}
    </section>`);
    const badge = document.querySelector("#today-nav-count");
    if (badge) { badge.textContent = String(count); badge.hidden = count === 0; }
    document.querySelector("#today-status").textContent = error
      ? `${error} Your previous listings are still shown.`
      : visitError || `Updated ${when(summary.generatedAt)}`;
  }

  async function load({ force = false } = {}) {
    if (request) return request;
    if (summary && !force) { render(); return summary; }
    const currentRevision = revision;
    const controller = new AbortController();
    requestController = controller;
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    request = (async () => {
      try {
        const headers = { Accept: "application/json", "Content-Type": "application/json", ...await authClient.csrfHeaders() };
        const response = await fetch("/api/today", { method: "POST", cache: "no-store", headers, signal,
          body: JSON.stringify(baseline ? { since: baseline } : {}),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message || "Please sign in again or retry in a moment.");
        if (currentRevision !== revision) return null;
        if (!baseline) {
          firstVisit = payload.since === null;
          baseline = payload.since || new Date(Date.parse(payload.generatedAt) - 7 * 24 * 60 * 60 * 1000).toISOString();
        }
        summary = payload;
        error = null;
        render();
        // Record only a successful visible load. Keep this session's cutoff
        // fixed so refreshes don't clear the listings the user is reading.
        if (!visitRecorded && document.querySelector("#today-view")?.hidden === false) {
          try {
            const visit = await fetch("/api/today/visit", { method: "POST", cache: "no-store", headers, signal,
              body: JSON.stringify({ visitedAt: payload.generatedAt }),
            });
            if (currentRevision !== revision) return null;
            if (!visit.ok) throw new Error("Visit checkpoint unavailable");
            visitRecorded = true;
            visitError = null;
          } catch {
            if (currentRevision !== revision) return null;
            visitError = "Your listings loaded, but this visit couldn’t be saved. Refresh to retry.";
          }
        }
        return summary;
      } catch (cause) {
        if (currentRevision !== revision) return null;
        error = cause.name === "AbortError" ? "Scout took too long to respond. Try again." : cause.message || "Check your connection and try again.";
        return null;
      } finally {
        clearTimeout(timeout);
        if (currentRevision === revision) { request = null; requestController = null; render(); }
      }
    })();
    render();
    return request;
  }

  function reset(userId) {
    if (owner === userId) return;
    owner = userId;
    revision += 1;
    requestController?.abort();
    request = null; summary = null; error = null; baseline = null; firstVisit = false;
    visitRecorded = false; visitError = null;
    renderedMarkup = "";
    if (content) content.innerHTML = '<p class="today-loading" role="status">Loading new listings…</p>';
    const badge = document.querySelector("#today-nav-count");
    if (badge) badge.hidden = true;
  }

  content?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-today-retry]")) void load({ force: true });
    const save = event.target.closest("[data-today-save]");
    if (save) {
      const role = summary?.newListings[Number(save.dataset.todaySave)];
      if (role) { saveRole(role); render(); }
    }
  });
  document.querySelector("#today-refresh")?.addEventListener("click", () => void load({ force: true }));
  const date = document.querySelector("#today-date");
  if (date) { date.dateTime = new Date().toISOString(); date.textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date()); }
  return { load, render, reset };
}
