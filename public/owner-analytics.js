/* global document, window, fetch */

import { wireLogoutButton } from "/auth/auth-client.js";

const numberFormatter = new Intl.NumberFormat(undefined);
const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const validRanges = new Set([7, 30, 90]);
const state = { range: 30, loading: false };

function query(selector) {
  return document.querySelector(selector);
}

function setText(selector, value) {
  const element = query(selector);
  if (element) element.textContent = value;
}

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? numberFormatter.format(value) : "—";
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${percentFormatter.format(value)}%` : "—";
}

function formatDate(value, short = false) {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : (short ? shortDateFormatter : dateFormatter).format(parsed);
}

function formatTimestamp(value) {
  if (typeof value !== "string" || !value) return "Waiting for first read";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Waiting for first read";
  return `Updated ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)}`;
}

function setLoading(loading) {
  state.loading = loading;
  const refresh = query("#analytics-refresh");
  if (refresh) {
    refresh.disabled = loading;
    refresh.setAttribute("aria-busy", String(loading));
    const label = refresh.querySelector(".button-label");
    if (label) label.textContent = loading ? "Reading data…" : "Refresh data";
  }
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.disabled = loading;
  });
}

function showState(kind, title, copy, actionVisible = true) {
  const panel = query("#analytics-state-panel");
  const content = query("[data-analytics-content]");
  if (!panel || !content) return;
  panel.hidden = false;
  panel.dataset.stateKind = kind;
  content.hidden = true;
  setText("[data-state-title]", title);
  setText("[data-state-copy]", copy);
  const action = query("[data-state-action]");
  if (action) action.hidden = !actionVisible;
}

function showReady() {
  const panel = query("#analytics-state-panel");
  const content = query("[data-analytics-content]");
  if (panel) panel.hidden = true;
  if (content) content.hidden = false;
}

function syncRangeButtons() {
  document.querySelectorAll("[data-range]").forEach((button) => {
    const active = Number(button.dataset.range) === state.range;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderMetrics(snapshot) {
  setText('[data-metric="totalUsers"]', formatNumber(snapshot.metrics.totalUsers));
  setText('[data-metric="verifiedUsers"]', formatNumber(snapshot.metrics.verifiedUsers));
  setText('[data-metric="paidUsers"]', formatNumber(snapshot.billing.paidUsers));
  setText('[data-metric="conversionRate"]', formatPercent(snapshot.billing.conversionRate));
  setText('[data-metric-note="verifiedUsers"]', snapshot.metrics.totalUsers > 0
    ? `${formatPercent(snapshot.metrics.verifiedRate)} of all accounts`
    : "Email-confirmed accounts");
  setText('[data-metric-note="paidUsers"]', snapshot.billing.available
    ? `${formatNumber(snapshot.billing.trialUsers)} trialing`
    : "Billing source not connected");
  setText('[data-metric-note="conversionRate"]', snapshot.billing.available
    ? "Paid users / total users"
    : "Connect billing to calculate");
}

function renderChart(snapshot) {
  const bars = query("[data-chart-bars]");
  const axis = query("[data-chart-axis]");
  const empty = query("[data-chart-empty]");
  if (!bars || !axis || !empty) return;
  bars.replaceChildren();
  axis.replaceChildren();
  const series = Array.isArray(snapshot.signups) ? snapshot.signups : [];
  const total = series.reduce((sum, point) => sum + (Number(point.count) || 0), 0);
  const max = Math.max(1, ...series.map((point) => Number(point.count) || 0));
  for (const point of series) {
    const bar = document.createElement("div");
    const count = Number(point.count) || 0;
    bar.className = "chart-bar";
    bar.style.setProperty("--bar-height", `${Math.max(3, Math.round((count / max) * 100))}%`);
    bar.title = `${formatNumber(count)} signup${count === 1 ? "" : "s"} on ${formatDate(point.date)}`;
    bar.setAttribute("aria-label", `${formatNumber(count)} signup${count === 1 ? "" : "s"} on ${formatDate(point.date)}`);
    bars.append(bar);
  }
  const axisIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), Math.max(0, series.length - 1)])];
  for (const index of axisIndexes) {
    const label = document.createElement("span");
    label.textContent = formatDate(series[index]?.date, true);
    axis.append(label);
  }
  empty.hidden = total !== 0;
  setText("[data-growth-summary]", `${formatNumber(total)} new account${total === 1 ? "" : "s"} in the last ${snapshot.rangeDays} days.`);
}

function renderBilling(snapshot) {
  const billing = snapshot.billing;
  const connected = billing.available;
  const billingState = query("[data-billing-state]");
  if (billingState) billingState.textContent = connected ? "Connected" : "Not connected";
  setText("[data-billing-paid]", formatNumber(billing.paidUsers));
  setText("[data-billing-trial]", formatNumber(billing.trialUsers));
  setText("[data-billing-plan-count]", connected ? formatNumber(billing.plans.length) : "—");
  setText("[data-billing-summary]", connected
    ? billing.paidUsers === 0
      ? "No paid accounts are recorded yet."
      : `${formatNumber(billing.paidUsers)} paid account${billing.paidUsers === 1 ? "" : "s"} across the connected source.`
    : billing.reason === "table_missing"
      ? "Apply the billing migration, then connect the payment webhook."
      : "Paid status needs a server-owned billing source.");

  const list = query("[data-plan-list]");
  if (!list) return;
  list.replaceChildren();
  if (!connected) {
    const empty = document.createElement("p");
    empty.className = "plan-empty";
    empty.textContent = "Waiting for subscription records.";
    list.append(empty);
    return;
  }
  if (!billing.plans.length) {
    const empty = document.createElement("p");
    empty.className = "plan-empty";
    empty.textContent = "No active plans recorded yet.";
    list.append(empty);
    return;
  }
  for (const plan of billing.plans) {
    const row = document.createElement("div");
    row.className = "plan-row";
    const name = document.createElement("span");
    name.className = "plan-name";
    name.textContent = plan.name;
    const count = document.createElement("span");
    count.className = "plan-count";
    count.textContent = formatNumber(plan.users);
    row.append(name, count);
    list.append(row);
  }
}

function statusLabel(status) {
  return {
    paid: "Paid",
    trialing: "Trialing",
    free: "Free",
    unverified: "Unverified",
    unknown: "Billing unknown",
  }[status] || "Unknown";
}

function renderRecentUsers(snapshot) {
  const body = query("[data-recent-users]");
  if (!body) return;
  body.replaceChildren();
  const users = Array.isArray(snapshot.recentUsers) ? snapshot.recentUsers : [];
  if (!users.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "table-empty";
    cell.textContent = "No accounts to show.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const user of users) {
    const row = document.createElement("tr");
    const account = document.createElement("td");
    const email = document.createElement("strong");
    email.className = "user-email";
    email.textContent = user.email || "Unknown account";
    const id = document.createElement("span");
    id.className = "user-id";
    id.textContent = user.id || "No id";
    account.append(email, id);
    const created = document.createElement("td");
    created.textContent = formatDate(user.createdAt);
    const lastSeen = document.createElement("td");
    lastSeen.textContent = formatDate(user.lastSignInAt);
    const status = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = "status-tag";
    tag.dataset.status = user.status || "unknown";
    tag.textContent = statusLabel(user.status);
    status.append(tag);
    row.append(account, created, lastSeen, status);
    body.append(row);
  }
}

function renderSnapshot(snapshot) {
  renderMetrics(snapshot);
  renderChart(snapshot);
  renderBilling(snapshot);
  renderRecentUsers(snapshot);
  const refreshed = query("#analytics-last-refresh");
  if (refreshed) {
    refreshed.textContent = formatTimestamp(snapshot.generatedAt);
    refreshed.dateTime = snapshot.generatedAt;
  }
  document.documentElement.dataset.analyticsReady = "true";
}

async function loadAnalytics() {
  if (state.loading) return;
  setLoading(true);
  syncRangeButtons();
  try {
    const response = await fetch(`/api/owner/analytics?range=${encodeURIComponent(state.range)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // The generic error below explains the recovery path without echoing a response body.
    }
    if (response.status === 401) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (!response.ok) throw new Error(payload?.error?.message || "Analytics data could not be read.");
    if (payload?.status === "not_configured") {
      showState("config", "Analytics is not connected yet.", payload.message || "Add the server analytics configuration, then retry.", false);
      return;
    }
    if (payload?.status !== "ready" || !payload.metrics || !payload.billing) {
      throw new Error("Scout returned an incomplete analytics read.");
    }
    renderSnapshot(payload);
    showReady();
  } catch (error) {
    showState("error", "Analytics could not be read.", error?.message || "Try again in a moment.");
  } finally {
    setLoading(false);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const candidate = Number(button.dataset.range);
      if (!validRanges.has(candidate) || candidate === state.range) return;
      state.range = candidate;
      syncRangeButtons();
      void loadAnalytics();
    });
  });
  query("#analytics-refresh")?.addEventListener("click", () => { void loadAnalytics(); });
  query("[data-state-action]")?.addEventListener("click", () => { void loadAnalytics(); });
  wireLogoutButton(query("#owner-logout"), { redirectTo: "/" });
}

if (typeof document !== "undefined") {
  bindEvents();
  syncRangeButtons();
  void loadAnalytics();
}
