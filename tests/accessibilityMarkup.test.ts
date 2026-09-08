import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("accessibility contracts", () => {
  it("keeps the public surfaces keyboard-ready and zoom-friendly", () => {
    for (const path of [
      "public/landing.html",
      "public/auth/auth.html",
      "public/onboarding/onboarding.html",
      "public/index.html",
    ]) {
      const html = source(path);
      expect(html).toMatch(/<html\s+lang="[^"]+"/);
      expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
      expect(html).toContain('class="skip-link"');
    }
  });

  it("announces the dynamic landing demonstrations without making their decoration interactive", () => {
    const html = source("public/landing.html");
    const script = source("public/landing.js");
    expect(html).toContain('data-scan-status role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('data-recency-status role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('data-fragment-status-announcer role="status" aria-live="polite"');
    expect(script).toContain('fragmentStatusAnnouncer.textContent = fragmentStatusLabels[safePhase]');
  });

  it("keeps authentication errors and requests perceivable", () => {
    const html = source("public/auth/auth.html");
    const script = source("public/auth/auth-page.js");
    expect(html).toContain('role="alert"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(script).toContain('field.removeAttribute("aria-invalid")');
    expect(script).toContain('form?.setAttribute("aria-busy", "true")');
  });

  it("keeps the onboarding combobox on one documented active-descendant model", () => {
    const script = source("public/onboarding/multi-select.js");
    expect(script).toContain('input.setAttribute("role", "combobox")');
    expect(script).toContain('input.setAttribute("aria-haspopup", "listbox")');
    expect(script).toContain('input.setAttribute("aria-activedescendant"');
    expect(script).toContain('optionNode.setAttribute("role", "option")');
    expect(script).toContain('optionNode.setAttribute("aria-selected"');
    expect(script).not.toContain('list.addEventListener("keydown"');
  });

  it("keeps custom dashboard selects keyboard-operable on touch layouts", () => {
    const script = source("public/themed-select.js");
    const css = source("public/themed-select.css");
    expect(script).toContain('const optionButton = document.createElement("div")');
    expect(script).toContain('optionButton.setAttribute("role", "option")');
    expect(script).toContain('optionButton.tabIndex = 0');
    expect(script).toContain('trigger.setAttribute("aria-label", `${selectLabel(select)}:');
    expect(css).toContain("min-height: 44px;");
    expect(css).toContain(".filter-select > .themed-select .themed-select-trigger,");
  });

  it("keeps visible focus and reduced-motion safeguards on every shipped surface", () => {
    for (const path of [
      "public/landing.css",
      "public/auth/auth.css",
      "public/onboarding/onboarding.css",
      "public/styles.css",
      "public/redesign.css",
      "public/themed-select.css",
    ]) {
      const css = source(path);
      expect(css).toMatch(/focus-visible/);
      expect(css).toContain("prefers-reduced-motion");
    }
  });

  it("covers rerender, loading, focus, and mobile contracts in the jobs app", () => {
    const html = source("public/index.html");
    const script = source("public/app.js");
    const css = source("public/redesign.css");
    expect(html).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(html).toContain('role="tabpanel" aria-labelledby="canada-tab"');
    expect(html).toContain('id="role-detail-panel" class="role-detail-panel" hidden role="dialog" aria-modal="false"');
    expect(html).toContain('id="results-heading" class="sr-only" tabindex="-1"');
    expect(script).toContain('role="alert"');
    expect(script).toContain("restoreRoleFocus(focusTarget)");
    expect(script).toContain('element.closest("#role-detail-panel[data-listing-key]")');
    expect(script).toContain("syncRoleDetailWatchlist(key);");
    expect(script).toContain("restoreApplicationFocus(focusTarget)");
    expect(script).toContain('button.setAttribute("aria-busy", String(active))');
    expect(script).toContain("focusActiveViewHeading();");
    expect(css).toContain(".role-view-link,");
    expect(css).toContain(".dashboard-crawl-actions .quick-crawl-button,");
    expect(css).toContain(".global-search input:focus-visible");
  });
});
