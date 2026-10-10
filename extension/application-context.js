/* global URL */
(() => {
  if (globalThis.ScoutApplicationContext) return;

  const CONFIRMATION_PATH = /(?:^|\/)(?:thank(?:-you)?|success(?:ful)?|confirmation|confirm(?:ation)?|application-received|complete(?:d)?)(?:\/|$)/i;

  function workdayJobPrefix(pathname) {
    return String(pathname).match(/^(.*\/job\/[^/]+\/[^/]+\/apply)(?:\/|$)/i)?.[1] ?? "";
  }

  function isConfirmationPath(pathname) {
    return CONFIRMATION_PATH.test(String(pathname ?? ""));
  }

  function shouldKeepPreparedApplicationAt(prepared, tabId, urlValue) {
    if (!prepared || prepared.tabId !== tabId || typeof urlValue !== "string") return false;
    try {
      const current = new URL(urlValue);
      const original = new URL(prepared.applicationUrl);
      if (current.origin !== original.origin) return false;
      if (current.pathname === original.pathname && current.search === original.search && current.hash === original.hash) return true;
      if (prepared.ats === "Workday") {
        const originalJob = workdayJobPrefix(original.pathname);
        const currentJob = workdayJobPrefix(current.pathname);
        if (originalJob && currentJob) return originalJob.toLocaleLowerCase("en-US") === currentJob.toLocaleLowerCase("en-US");
        return !currentJob && isConfirmationPath(current.pathname);
      }
      return isConfirmationPath(current.pathname);
    } catch {
      return false;
    }
  }

  function preparedApplicationForManualLog(tab, prepared, accountId, now = Date.now()) {
    if (!prepared || prepared.tabId !== tab?.id || prepared.accountId !== (accountId ?? null)
      || !Number.isFinite(prepared.preparedAt) || now - prepared.preparedAt > 30 * 60 * 1_000
      || !shouldKeepPreparedApplicationAt(prepared, tab?.id, tab?.url)) return null;
    try {
      const original = new URL(prepared.applicationUrl);
      return {
        company: String(prepared.company ?? ""),
        title: String(prepared.title ?? ""),
        location: String(prepared.location ?? ""),
        applicationUrl: original.href,
        ats: prepared.ats,
      };
    } catch {
      return null;
    }
  }

  function manualLogDetails(prepared, inputs = {}) {
    return {
      company: String(inputs.company || prepared?.company || "").trim().slice(0, 200),
      title: String(inputs.title || prepared?.title || "").trim().slice(0, 300),
      location: String(inputs.location || prepared?.location || "").trim().slice(0, 200),
      applicationUrl: prepared?.applicationUrl ?? "",
    };
  }

  globalThis.ScoutApplicationContext = Object.freeze({
    workdayJobPrefix,
    isConfirmationPath,
    shouldKeepPreparedApplicationAt,
    preparedApplicationForManualLog,
    manualLogDetails,
  });
})();
