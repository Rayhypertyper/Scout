/* global document, Element, HTMLButtonElement, CustomEvent, window, setTimeout */

/**
 * Small, provider-neutral conversion seam. Scout can wire a real analytics
 * adapter to `window.scoutAnalytics.track` later without changing UI code.
 * Context is deliberately allowlisted so search text, emails, and profile
 * answers never become analytics payloads by accident.
 */
export const CONVERSION_EVENTS = Object.freeze({
  pricingPageViewed: "pricing_page_viewed",
  upgradePromptViewed: "upgrade_prompt_viewed",
  upgradePromptDismissed: "upgrade_prompt_dismissed",
  upgradeCtaClicked: "upgrade_cta_clicked",
  checkoutStarted: "checkout_started",
  checkoutCompleted: "checkout_completed",
  proFeatureAttempted: "pro_feature_attempted",
});

const EVENT_NAMES = new Set(Object.values(CONVERSION_EVENTS));
const PROMPT_SESSION_KEY = "scout.conversion.prompts.v1";
const DISMISSED_PROMPT_SESSION_KEY = "scout.conversion.dismissed-prompts.v1";
const PRO_INTEREST_KEY = "scout.pro-interest.v1";
const ALLOWED_CONTEXT_KEYS = new Set([
  "sourcePage",
  "feature",
  "promptId",
  "presentation",
  "variant",
  "plan",
  "authenticated",
  "matchCount",
  "visibleCount",
  "savedCount",
]);
const promptIds = new Set();
const dismissedPromptIds = new Set();
let conversionSurfaceInitialized = false;
let pricingPageTracked = false;
let dialogReturnFocus = null;
let dialogContext = {};

function safeToken(value, maxLength = 80) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .slice(0, maxLength);
}

function safeSourcePage(value) {
  const surface = typeof document !== "undefined" ? document.body?.dataset?.conversionSurface : "";
  const candidate = safeToken(value || surface || "unknown");
  return candidate || "unknown";
}

function readPromptIds(storageKey, memoryIds) {
  const stored = new Set(memoryIds);
  if (typeof window === "undefined") return stored;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) parsed.filter((value) => typeof value === "string").forEach((value) => stored.add(value));
  } catch {
    // Session storage is optional; the in-memory set still prevents repeats.
  }
  return stored;
}

function writePromptIds(storageKey, memoryIds, ids) {
  memoryIds.clear();
  ids.forEach((value) => memoryIds.add(value));
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify([...ids].slice(-40)));
  } catch {
    // The prompt remains frequency-controlled for the lifetime of this page.
  }
}

function sanitizedContext(context = {}) {
  const result = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (!ALLOWED_CONTEXT_KEYS.has(key) || value === undefined || value === null) continue;
    if (["authenticated"].includes(key) && typeof value === "boolean") {
      result[key] = value;
      continue;
    }
    if (["matchCount", "visibleCount", "savedCount"].includes(key)) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) result[key] = Math.round(number);
      continue;
    }
    const token = safeToken(value);
    if (token) result[key] = token;
  }
  return result;
}

export function trackConversionEvent(eventName, context = {}) {
  if (!EVENT_NAMES.has(eventName)) return null;
  const detail = {
    event: eventName,
    context: sanitizedContext(context),
    occurredAt: new Date().toISOString(),
  };
  try {
    if (typeof window !== "undefined") window.scoutAnalytics?.track?.(eventName, detail.context);
  } catch {
    // An optional adapter must never break the product flow.
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("scout:conversion", { detail }));
  }
  return detail;
}

export function markUpgradePromptViewed(promptId, context = {}) {
  const id = safeToken(promptId);
  if (!id) return false;
  const seen = readPromptIds(PROMPT_SESSION_KEY, promptIds);
  if (seen.has(id)) return false;
  seen.add(id);
  writePromptIds(PROMPT_SESSION_KEY, promptIds, seen);
  trackConversionEvent(CONVERSION_EVENTS.upgradePromptViewed, { ...context, promptId: id });
  return true;
}

export function markUpgradePromptDismissed(promptId, context = {}) {
  const id = safeToken(promptId);
  if (!id) return false;
  const viewed = readPromptIds(PROMPT_SESSION_KEY, promptIds);
  viewed.add(id);
  writePromptIds(PROMPT_SESSION_KEY, promptIds, viewed);
  const dismissed = readPromptIds(DISMISSED_PROMPT_SESSION_KEY, dismissedPromptIds);
  dismissed.add(id);
  writePromptIds(DISMISSED_PROMPT_SESSION_KEY, dismissedPromptIds, dismissed);
  trackConversionEvent(CONVERSION_EVENTS.upgradePromptDismissed, { ...context, promptId: id });
  return true;
}

export function isUpgradePromptDismissed(promptId) {
  const id = safeToken(promptId);
  return Boolean(id && readPromptIds(DISMISSED_PROMPT_SESSION_KEY, dismissedPromptIds).has(id));
}

export function markProFeatureAttempted(feature, context = {}) {
  trackConversionEvent(CONVERSION_EVENTS.proFeatureAttempted, { ...context, feature });
}

function proInterestSaved() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PRO_INTEREST_KEY) === "saved";
  } catch {
    return false;
  }
}

function reflectProInterest() {
  if (typeof document === "undefined") return;
  const saved = proInterestSaved();
  document.querySelectorAll("[data-pro-interest]").forEach((control) => {
    if (!(control instanceof Element)) return;
    if (!control.dataset.defaultLabel) control.dataset.defaultLabel = control.textContent?.trim() || "Save Pro interest";
    control.textContent = saved ? "Interest saved" : control.dataset.defaultLabel;
    if (control instanceof HTMLButtonElement) control.setAttribute("aria-pressed", String(saved));
  });
  document.querySelectorAll("[data-pro-interest-status]").forEach((status) => {
    status.hidden = !saved;
    if (saved) status.textContent = "Saved on this device. No email is sent.";
  });
}

function saveProInterest() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRO_INTEREST_KEY, "saved");
  } catch {
    // The UI can still acknowledge interest for this page lifetime.
  }
  reflectProInterest();
}

function closePreviewDialog(reason = "dismissed") {
  const dialog = document.querySelector("#pro-preview-dialog");
  if (!dialog) return;
  if (reason === "dismissed") {
    markUpgradePromptDismissed(dialog.dataset.promptId || "pro-preview-dialog", dialogContext);
  }
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  const returnFocus = dialogReturnFocus;
  dialogReturnFocus = null;
  dialogContext = {};
  if (returnFocus?.isConnected && typeof returnFocus.focus === "function") setTimeout(() => returnFocus.focus(), 0);
}

function openPreviewDialog(trigger) {
  const dialog = document.querySelector("#pro-preview-dialog");
  if (!dialog) return;
  dialogReturnFocus = trigger instanceof Element ? trigger : document.activeElement;
  dialogContext = {
    sourcePage: trigger?.dataset?.sourcePage || safeSourcePage(),
    feature: trigger?.dataset?.feature || "pro_preview",
    presentation: "dialog",
    authenticated: document.documentElement.dataset.authenticated === "true",
  };
  dialog.dataset.promptId = trigger?.dataset?.promptId || "pro-preview-dialog";
  markUpgradePromptViewed(dialog.dataset.promptId, dialogContext);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  setTimeout(() => dialog.querySelector("[data-pro-preview-close]")?.focus(), 0);
}

function sourcePageFromElement(element) {
  return element?.dataset?.sourcePage || safeSourcePage();
}

function conversionContextFromElement(element) {
  return {
    sourcePage: sourcePageFromElement(element),
    feature: element?.dataset?.feature || "pro_preview",
    presentation: element?.dataset?.presentation || "inline",
    variant: element?.dataset?.variant,
    plan: element?.dataset?.plan,
    authenticated: document.documentElement.dataset.authenticated === "true",
  };
}

function handleConversionClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const cta = target.closest("[data-conversion-cta]");
  if (cta) trackConversionEvent(CONVERSION_EVENTS.upgradeCtaClicked, conversionContextFromElement(cta));

  const trigger = target.closest("[data-pro-preview-trigger]");
  if (trigger?.dataset?.proPreviewTrigger === "dialog") {
    event.preventDefault();
    openPreviewDialog(trigger);
    return;
  }

  const interest = target.closest("[data-pro-interest]");
  if (interest) {
    event.preventDefault();
    saveProInterest();
    return;
  }

  const dismiss = target.closest("[data-pro-preview-dismiss]");
  if (dismiss) {
    event.preventDefault();
    const prompt = dismiss.closest("[data-pro-preview]");
    if (prompt instanceof Element) {
      prompt.hidden = true;
      markUpgradePromptDismissed(prompt.dataset.promptId || "pro-preview", {
        sourcePage: sourcePageFromElement(prompt),
        feature: prompt.dataset.feature || "pro_preview",
        presentation: "inline",
      });
    }
  }
}

function setupPreviewDialog() {
  const dialog = document.querySelector("#pro-preview-dialog");
  if (!dialog || dialog.dataset.conversionReady === "true") return;
  dialog.dataset.conversionReady = "true";
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePreviewDialog();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closePreviewDialog();
  });
  dialog.querySelectorAll("[data-pro-preview-close]").forEach((button) => {
    button.addEventListener("click", () => closePreviewDialog());
  });
}

export function initConversionSurface({ sourcePage } = {}) {
  if (typeof document === "undefined") return false;
  if (sourcePage && !document.body.dataset.conversionSurface) document.body.dataset.conversionSurface = sourcePage;
  if (!conversionSurfaceInitialized) {
    document.addEventListener("click", handleConversionClick);
    conversionSurfaceInitialized = true;
  }
  setupPreviewDialog();
  reflectProInterest();
  const pricingSurface = safeSourcePage();
  if (!pricingPageTracked && (pricingSurface === "pricing" || pricingSurface === "pro")) {
    pricingPageTracked = true;
    trackConversionEvent(CONVERSION_EVENTS.pricingPageViewed, {
      sourcePage: pricingSurface,
      feature: "pricing",
      presentation: "page",
    });
  }
  return true;
}

if (typeof document !== "undefined") initConversionSurface();
