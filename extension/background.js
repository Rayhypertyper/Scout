/* global TextEncoder, chrome, crypto, fetch, importScripts, location, setTimeout, URL */
importScripts("workday-session-store.js", "application-context.js", "answer-contract.js");
const HELPER_STATE_KEY = "scoutApplicationHelper";
const WATCH_CONTEXTS_KEY = "scoutSubmissionWatchContexts";
const WORKDAY_SESSIONS_KEY = "scoutWorkdaySessions";
const WRITTEN_DRAFT_REQUESTS_KEY = "scoutWrittenDraftRequests";
const WATCH_WINDOW_MS = 30 * 60 * 1_000;
let stateMutationQueue = Promise.resolve();
let writtenDraftRequestsQueue = Promise.resolve();
const workdayDescriptionCapturePromises = new Map();
const workdaySessionStore = globalThis.ScoutWorkdaySessionStore.create(chrome.storage.session, WORKDAY_SESSIONS_KEY);
const CONFIRMATION_PATTERNS = [
  /\bapplication (?:has been |was |is )?received\b/i,
  /\bapplication (?:was )?submitted(?: successfully)?\b/i,
  /\bthank you for applying\b/i,
  /\bthanks for applying\b/i,
  /\bwe (?:have )?received your application\b/i,
  /\bapplication complete\b/i,
  /\bsuccessfully applied\b/i,
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "scout.armApplicationWatch") {
    handleArmRequest(message, sender).then(sendResponse).catch((error) => sendResponse({ armed: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.applicationConfirmation") {
    handleConfirmation(message, sender).then(sendResponse).catch((error) => sendResponse({ queued: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.trustedSubmission") {
    handleTrustedSubmission(message, sender).then(sendResponse).catch((error) => sendResponse({ trusted: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.applicationRouteChanged") {
    handleApplicationRouteChanged(message, sender).then(sendResponse).catch(() => sendResponse({ keep: true }));
    return true;
  }
  if (message?.type === "scout.startWorkdaySession") {
    handleStartWorkdaySession(message, sender).then(sendResponse).catch((error) => sendResponse({ started: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.generateWrittenDraft") {
    handleGenerateWrittenDraft(message, sender).then(sendResponse).catch((error) => sendResponse({ generated: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.applyWrittenDraft") {
    handleApplyWrittenDraft(message, sender).then(sendResponse).catch((error) => sendResponse({ applied: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.stopWorkdaySession") {
    handleStopWorkdaySession(message, sender).then(sendResponse).catch((error) => sendResponse({ stopped: false, message: error.message }));
    return true;
  }
  if (message?.type === "scout.getWorkdaySession") {
    handleGetWorkdaySession(message, sender).then(sendResponse).catch(() => sendResponse({ active: false }));
    return true;
  }
  if (message?.type === "scout.workdayUserEdit") {
    recordWorkdayUserEdit(message, sender).then(sendResponse).catch(() => sendResponse({ saved: false }));
    return true;
  }
  if (message?.type === "scout.workdayUserEditCleared") {
    clearWorkdayUserEdit(message, sender).then(sendResponse).catch(() => sendResponse({ saved: false }));
    return true;
  }
  if (message?.type === "scout.workdaySessionEnded") {
    handleWorkdaySessionEnded(message, sender).then(sendResponse).catch(() => sendResponse({ stopped: false }));
    return true;
  }
  if (message?.type === "scout.workdayStepResult") {
    handleWorkdayStepResult(message, sender).then(sendResponse).catch(() => sendResponse({ accepted: false }));
    return true;
  }
  if (message?.type === "scout.saveHelperState") {
    handlePopupStateSave(message, sender).then(sendResponse).catch((error) => sendResponse({ saved: false, message: error.message }));
    return true;
  }
  return undefined;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") markWorkdayDocumentLoading(tabId).catch(() => undefined);
  const changedUrl = typeof changeInfo.url === "string" ? changeInfo.url : tab.url;
  if (typeof changedUrl === "string" && (changeInfo.url || changeInfo.status === "complete")) {
    clearPreparedApplicationIfNavigationLeaves(tabId, changedUrl).catch(() => undefined);
  }
  if (changeInfo.status === "complete") {
    rearmForTab(tabId, tab).catch(() => undefined);
    rearmWorkdayForTab(tabId, tab).catch(() => undefined);
    retryPendingForScoutTab(tab).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeWatchContext(tabId).catch(() => undefined);
  removeWorkdaySession(tabId, true).catch(() => undefined);
  removeWrittenDraftsForTab(tabId).catch(() => undefined);
  clearPreparedApplication(tabId).catch(() => undefined);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[HELPER_STATE_KEY]) return;
  const previous = changes[HELPER_STATE_KEY].oldValue ?? {};
  const next = changes[HELPER_STATE_KEY].newValue ?? {};
  if (previous.accountId && previous.accountId !== next.accountId) clearWatchContextsForAccount(previous.accountId).catch(() => undefined);
  if (previous.accountId !== next.accountId) clearWorkdaySessionsForAccount(previous.accountId).catch(() => undefined);
  if (previous.accountId !== next.accountId) clearWrittenDraftCache().catch(() => undefined);
});

async function handleArmRequest(message, sender) {
  if (!isPopupSender(sender)) {
    return { armed: false, message: "Only the Scout helper popup can arm a confirmation watch." };
  }
  const tabId = Number(message.tabId);
  const context = message.context;
  if (!Number.isInteger(tabId) || !isValidContext(context)) return { armed: false, message: "The application details are incomplete." };
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = new URL(tab.url ?? "");
  const preparedUrl = new URL(context.applicationUrl);
  if (pageUrl.href !== preparedUrl.href || !isSupportedHost(pageUrl.hostname)) return { armed: false, message: "The application tab changed before the watch started." };
  const state = await getHelperState();
  if (state.accountId && state.accountId !== context.accountId) return { armed: false, message: "The Scout account changed before the watch started." };
  const watchContext = {
    ...context,
    tabId,
    origin: pageUrl.origin,
    lastUrl: pageUrl.href,
    accountId: context.accountId ?? null,
    triggered: false,
  };
  await setWatchContext(tabId, watchContext);
  try {
    await injectWatcher(tabId, watchContext, false);
    const preparedApplication = {
      tabId,
      accountId: watchContext.accountId,
      company: watchContext.company,
      title: watchContext.title,
      location: watchContext.location ?? "",
      applicationUrl: watchContext.applicationUrl,
      preparedAt: watchContext.preparedAt,
      ats: watchContext.ats ?? "",
    };
    const saved = await mutateHelperState((current) => {
      if (current.accountId !== watchContext.accountId) return { result: { accountChanged: true } };
      current.preparedApplication = preparedApplication;
      return {};
    });
    if (saved.result?.accountChanged) {
      await removeWatchContext(tabId);
      return { armed: false, message: "The Scout account changed before tracking was set up." };
    }
    return { armed: true, preparedApplication };
  } catch {
    await removeWatchContext(tabId);
    return { armed: false, message: "Scout could not watch this application page. Use the manual submission log after you submit." };
  }
}

async function handleApplicationRouteChanged(message, sender) {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || typeof sender.url !== "string"
    || typeof message.url !== "string") return { keep: true };
  let reportedUrl;
  try {
    reportedUrl = new URL(message.url);
    if (reportedUrl.origin !== new URL(sender.url).origin) return { keep: true };
  } catch {
    return { keep: true };
  }
  return clearPreparedApplicationIfNavigationLeaves(tabId, reportedUrl.href);
}

async function clearPreparedApplicationIfNavigationLeaves(tabId, url) {
  const before = (await getHelperState()).preparedApplication;
  if (!before || before.tabId !== tabId) return { keep: false };
  if (globalThis.ScoutApplicationContext.shouldKeepPreparedApplicationAt(before, tabId, url)) return { keep: true };
  let cleared = false;
  await mutateHelperState((current) => {
    const prepared = current.preparedApplication;
    if (prepared?.tabId === tabId && prepared.applicationUrl === before.applicationUrl && prepared.preparedAt === before.preparedAt) {
      current.preparedApplication = null;
      cleared = true;
    }
    return {};
  });
  return { keep: false, cleared };
}

async function clearPreparedApplication(tabId, expected) {
  await mutateHelperState((current) => {
    const prepared = current.preparedApplication;
    if (!prepared || prepared.tabId !== tabId) return {};
    if (expected && (prepared.applicationUrl !== expected.applicationUrl || prepared.preparedAt !== expected.preparedAt)) return {};
    current.preparedApplication = null;
    return {};
  });
}

function isValidContext(context) {
  if (!context || typeof context !== "object") return false;
  if (typeof context.applicationUrl !== "string" || typeof context.company !== "string" || typeof context.title !== "string") return false;
  if (!context.company.trim() || !context.title.trim() || context.company.length > 200 || context.title.length > 300) return false;
  if (!Number.isFinite(context.preparedAt) || Date.now() - context.preparedAt < -5_000 || Date.now() - context.preparedAt > WATCH_WINDOW_MS) return false;
  try {
    const url = new URL(context.applicationUrl);
    return ["http:", "https:"].includes(url.protocol) && isSupportedHost(url.hostname);
  } catch { return false; }
}

function isSupportedHost(host) {
  const normalized = String(host ?? "").toLowerCase();
  return ["greenhouse.io", "greenhouse.com", "lever.co", "ashbyhq.com"].some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function normalizedConfirmation(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function hasStrongConfirmation(value) {
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(String(value ?? "")));
}

async function injectWatcher(tabId, context, allowInitialConfirmation) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (watchContext, allowInitial) => globalThis.ScoutFormHelper?.watchForConfirmation({ ...watchContext, allowInitialConfirmation: allowInitial }) ?? { armed: false },
    args: [context, allowInitialConfirmation],
  });
  if (!results[0]?.result?.armed) throw new Error("Confirmation watch could not be armed.");
}

async function rearmForTab(tabId, tab) {
  const contexts = await getWatchContexts();
  const context = contexts[String(tabId)];
  if (!context || context.triggered || Date.now() - context.preparedAt > WATCH_WINDOW_MS) {
    if (context) await removeWatchContext(tabId);
    return;
  }
  let currentUrl;
  try { currentUrl = new URL(tab.url ?? ""); } catch { return; }
  if (currentUrl.origin !== context.origin) {
    await removeWatchContext(tabId);
    return;
  }
  const preparedUrl = new URL(context.applicationUrl);
  const sameApplicationRoute = currentUrl.pathname === preparedUrl.pathname && currentUrl.hash === preparedUrl.hash;
  const confirmationRoute = /(?:thank|success|confirm|complete|received)/i.test(currentUrl.pathname);
  if (!sameApplicationRoute && !(context.trustedSubmitted && confirmationRoute)) {
    await removeWatchContext(tabId);
    return;
  }
  context.lastUrl = currentUrl.href;
  await setWatchContext(tabId, context);
  try { await injectWatcher(tabId, context, Boolean(context.trustedSubmitted)); } catch { await removeWatchContext(tabId); }
}

async function handleTrustedSubmission(message, sender) {
  const tabId = sender.tab?.id;
  const application = message.application;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || typeof sender.url !== "string" || !application) return { trusted: false };
  let senderUrl;
  try { senderUrl = new URL(sender.url); } catch { return { trusted: false }; }
  const contexts = await getWatchContexts();
  const context = contexts[String(tabId)];
  if (!context || context.triggered || Date.now() - context.preparedAt > WATCH_WINDOW_MS
    || senderUrl.origin !== context.origin
    || senderUrl.pathname !== new URL(context.applicationUrl).pathname
    || senderUrl.hash !== new URL(context.applicationUrl).hash
    || application.applicationUrl !== context.applicationUrl
    || application.preparedAt !== context.preparedAt
    || application.company !== context.company
    || application.title !== context.title) return { trusted: false };
  context.trustedSubmitted = true;
  context.trustedSubmitUrl = senderUrl.href;
  context.trustedSubmittedAt = Date.now();
  context.confirmationBaseline = normalizedConfirmation(application.confirmationBaseline);
  await setWatchContext(tabId, context);
  return { trusted: true };
}

async function handlePopupStateSave(message, sender) {
  if (!isPopupSender(sender)) return { saved: false, message: "Only the helper popup can update its local profile." };
  const next = message.state;
  if (!next || typeof next !== "object" || next.version !== 1) return { saved: false, message: "The local helper state was invalid." };
  const operation = message.operation ?? {};
  const result = await mutateHelperState((current) => {
    if (operation.clearLocal === true) {
      return { replacement: defaultHelperState(), accountChangedFrom: current.accountId };
    }
    if (operation.clearAccountBoundData === true) {
      if (current.accountId !== operation.expectedAccountId) return { ignored: true };
      const cleared = defaultHelperState();
      cleared.scoutOrigin = current.scoutOrigin;
      return { replacement: cleared, accountChangedFrom: current.accountId };
    }
    if (operation.accountTransition === true) {
      return { replacement: next, accountChangedFrom: current.accountId };
    }
    if (current.accountId !== next.accountId) return { ignored: true };
    const pendingApplications = current.pendingApplications ?? [];
    const lastLoggedApplication = current.lastLoggedApplication ?? null;
    const lastConfirmation = current.lastConfirmation ?? null;
    const preparedApplication = current.preparedApplication ?? null;
    Object.assign(current, next, { pendingApplications, lastLoggedApplication, lastConfirmation, preparedApplication });
    if (operation.enqueueApplication && isValidPendingApplication(operation.enqueueApplication)
      && operation.enqueueApplication.accountId === current.accountId
      && !pendingApplications.some((item) => item.localId === operation.enqueueApplication.localId)) {
      current.pendingApplications = [...pendingApplications, operation.enqueueApplication].slice(-100);
    }
    if (operation.ackApplication && typeof operation.ackApplication.localId === "string"
      && operation.ackApplication.accountId === current.accountId) {
      current.pendingApplications = (current.pendingApplications ?? []).filter((item) => item.localId !== operation.ackApplication.localId);
      current.lastLoggedApplication = operation.ackApplication.application ?? current.lastLoggedApplication;
      if (current.preparedApplication?.applicationUrl === operation.ackApplication.application?.applicationUrl) current.preparedApplication = null;
    }
    return {};
  });
  const state = result.state;
  if (result.result?.accountChangedFrom) await clearWatchContextsForAccount(result.result.accountChangedFrom);
  if (operation.clearLocal === true || operation.accountTransition === true) await clearAllWorkdaySessions();
  else if (result.result?.accountChangedFrom) await clearWorkdaySessionsForAccount(result.result.accountChangedFrom);
  if (result.result?.ignored) return { saved: false, state, message: "The Scout account changed. Reload this popup before saving more data." };
  if (operation.clearLocal !== true && operation.clearAccountBoundData !== true && operation.accountTransition !== true) {
    await updateActiveWorkdayPayload(state);
  }
  return { saved: true, state };
}

function isWorkdayHost(host) {
  const normalized = String(host ?? "").toLowerCase();
  return normalized === "myworkdayjobs.com" || normalized.endsWith(".myworkdayjobs.com");
}

function workdayApplicationPrefix(pathname) {
  return String(pathname).match(/^(.*\/apply)(?:\/|$)/i)?.[1] ?? "";
}

function isWorkdayApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isWorkdayHost(url.hostname) && Boolean(workdayApplicationPrefix(url.pathname));
  } catch { return false; }
}

function isWithinWorkdayApplication(url, context) {
  if (!context || url.origin !== context.origin) return false;
  const pathname = url.pathname.toLowerCase();
  const prefix = String(context.pathPrefix ?? "").toLowerCase();
  return Boolean(prefix) && (pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function getWorkdaySessions() {
  return workdaySessionStore.read();
}

async function removeWorkdaySession(tabId, revokePermission, expectedStartedAt = null) {
  const { session, sameOriginSession } = await workdaySessionStore.update((sessions) => {
    const current = sessions[String(tabId)];
    if (!current || (expectedStartedAt != null && current.startedAt !== expectedStartedAt)) return { session: null, sameOriginSession: false };
    delete sessions[String(tabId)];
    return {
      session: current,
      sameOriginSession: Object.values(sessions).some((item) => item.origin === current.origin),
    };
  });
  if (!session) {
    await removeWrittenDraftsForTab(tabId).catch(() => undefined);
    return;
  }
  await stopWorkdayInTab(tabId, session);
  await removeWrittenDraftsForTab(tabId).catch(() => undefined);
  if (revokePermission && !sameOriginSession) {
    await workdaySessionStore.update(async (sessions) => {
      if (!Object.values(sessions).some((item) => item.origin === session.origin)) {
        await chrome.permissions.remove({ origins: [`${session.origin}/*`] }).catch(() => undefined);
      }
    });
  }
}

async function clearWorkdaySessionsForAccount(accountId) {
  const { removed, removedOrigins, remainingOrigins } = await workdaySessionStore.update((sessions) => {
    const removedItems = [];
    const origins = new Set();
    for (const [tabId, session] of Object.entries(sessions)) {
      if ((session.accountId ?? null) !== (accountId ?? null)) continue;
      origins.add(session.origin);
      removedItems.push({ tabId: Number(tabId), session });
      delete sessions[tabId];
    }
    return {
      removed: removedItems,
      removedOrigins: [...origins],
      remainingOrigins: [...new Set(Object.values(sessions).map((session) => session.origin))],
    };
  });
  for (const item of removed) await stopWorkdayInTab(item.tabId, item.session);
  for (const origin of removedOrigins) {
    if (remainingOrigins.includes(origin)) continue;
    await workdaySessionStore.update(async (sessions) => {
      if (!Object.values(sessions).some((session) => session.origin === origin)) {
        await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => undefined);
      }
    });
  }
}

async function clearAllWorkdaySessions() {
  const removed = await workdaySessionStore.update((sessions) => {
    const items = Object.entries(sessions).map(([tabId, session]) => ({ tabId: Number(tabId), session }));
    for (const key of Object.keys(sessions)) delete sessions[key];
    return items;
  });
  const origins = new Set(removed.map((item) => item.session.origin));
  for (const item of removed) await stopWorkdayInTab(item.tabId, item.session);
  for (const origin of origins) {
    await workdaySessionStore.update(async (sessions) => {
      if (!Object.values(sessions).some((session) => session.origin === origin)) {
        await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => undefined);
      }
    });
  }
}

async function updateActiveWorkdayPayload(state) {
  if (!state || !Array.isArray(state.answers) || !state.profile || typeof state.profile !== "object") return 0;
  const updates = await workdaySessionStore.update((sessions) => {
    const active = [];
    for (const [tabId, session] of Object.entries(sessions)) {
      if ((session.accountId ?? null) !== (state.accountId ?? null) || Date.now() >= session.expiresAt) continue;
      session.payload = {
        ...session.payload,
        profile: state.profile,
        answers: state.answers,
        documents: state.documents ?? session.payload.documents ?? {},
        applicationCountry: globalThis.ScoutAnswerContract.applicationCountryForJob(state, session.payload?.jobKey),
        applicationCountryReviewed: state.applicationCountryReviewed === true,
        jobCountryEvidence: globalThis.ScoutAnswerContract.workdayJobKey(state.applicationCountryApplicationUrl) === session.payload?.jobKey
          && Array.isArray(state.applicationCountryEvidence)
          ? state.applicationCountryEvidence : (session.payload?.jobCountryEvidence ?? []),
        autoDraftWrittenAnswers: state.writtenAnswerDraftingEnabled !== false,
        workdayUserEditedKeys: [...(session.userEditedKeys ?? [])],
      };
      active.push({ tabId: Number(tabId), session });
    }
    return active;
  });
  let refreshed = 0;
  for (const { tabId, session } of updates) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const pageUrl = new URL(tab.url ?? "");
      if (!isWithinWorkdayApplication(pageUrl, session)) continue;
      const latestState = await getHelperState();
      if ((latestState.accountId ?? null) !== session.accountId) continue;
      await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (payload) => globalThis.ScoutFormHelper?.updateWorkdaySessionPayload?.(payload) ?? { updated: false },
        args: [session.payload],
      });
      if (result[0]?.result?.updated) refreshed += 1;
    } catch {
      // The next application mutation or reload can apply the cached update.
    }
  }
  return refreshed;
}

async function stopWorkdayInTab(tabId, session) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (new URL(tab.url ?? "").origin !== session.origin) return;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (startedAt) => globalThis.ScoutFormHelper?.stopWorkdaySession?.(false, startedAt) ?? { stopped: true },
      args: [session.startedAt],
    });
  } catch {
    // A closed or cross-origin page cannot keep a session alive after its cache is cleared.
  }
}

async function handleStartWorkdaySession(message, sender) {
  if (!isPopupSender(sender)) return { started: false, message: "Only the Scout helper popup can start a Workday session." };
  const tabId = Number(message.tabId);
  const payload = message.payload;
  if (!Number.isInteger(tabId) || !payload || typeof payload !== "object" || !payload.profile || !Array.isArray(payload.answers)) {
    return { started: false, message: "Check the Workday application page before starting its fill session." };
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 9 * 1024 * 1024 || payload.answers.length > 200) {
    return { started: false, message: "The Workday session data exceeds the local size limit." };
  }
  const tab = await chrome.tabs.get(tabId);
  let pageUrl;
  try { pageUrl = new URL(tab.url ?? ""); } catch { return { started: false, message: "The Workday page could not be verified." }; }
  if (!isWorkdayApplicationUrl(pageUrl.href) || pageUrl.href !== message.applicationUrl) {
    return { started: false, message: "The active tab changed. Check the Workday application again before starting." };
  }
  const permission = `${pageUrl.origin}/*`;
  if (!await chrome.permissions.contains({ origins: [permission] })) {
    return { started: false, permissionRequired: true, origin: pageUrl.origin, message: "Grant access to this exact employer site to keep the session through Workday steps." };
  }
  const accountId = typeof message.accountId === "string" ? message.accountId : null;
  const tracking = message.tracking && typeof message.tracking === "object" ? message.tracking : {};
  const jobKey = globalThis.ScoutAnswerContract.workdayJobKey(pageUrl.href);
  const providedJobKey = typeof payload.jobKey === "string" ? payload.jobKey : "";
  const applicationCountryReviewed = payload.applicationCountryReviewed === true;
  const jobCountryEvidence = providedJobKey === jobKey && Array.isArray(payload.jobCountryEvidence)
    ? payload.jobCountryEvidence.filter((item) => typeof item === "string").map((item) => item.slice(0, 500)).slice(0, 8) : [];
  const inferredApplicationCountry = globalThis.ScoutAnswerContract.inferWorkdayJobCountry(pageUrl.href, jobCountryEvidence);
  const applicationCountry = applicationCountryReviewed
    ? (payload.applicationCountry === "Canada" || payload.applicationCountry === "United States" ? payload.applicationCountry : "")
    : inferredApplicationCountry || (payload.applicationCountryReviewed == null
      && ["Canada", "United States"].includes(payload.applicationCountry) ? payload.applicationCountry : "");
  const jobDescription = typeof payload.jobDescription === "string" ? payload.jobDescription.trim().replace(/\s+/g, " ").slice(0, 20_000) : "";
  const scopedPayload = {
    ...payload,
    applicationCountry,
    applicationCountryReviewed,
    jobCountryEvidence,
    jobKey,
    jobDescription: providedJobKey === jobKey && jobDescription.length >= 40 ? jobDescription : "",
    autoDraftWrittenAnswers: payload.autoDraftWrittenAnswers !== false,
    writtenDraftContext: {
      company: typeof tracking.company === "string" ? tracking.company.trim().slice(0, 200) : "",
      title: typeof tracking.title === "string" ? tracking.title.trim().slice(0, 300) : "",
    },
  };
  const pathPrefix = workdayApplicationPrefix(pageUrl.pathname);
  const session = await workdaySessionStore.update(async (sessions) => {
    const latestState = await getHelperState();
    if ((latestState.accountId ?? null) !== accountId) return { error: "The Scout account changed. Reopen the helper before starting this session." };
    if (!await chrome.permissions.contains({ origins: [permission] })) {
      return { error: "Access to this exact Workday employer site expired. Grant it again before starting." };
    }
    const previous = sessions[String(tabId)];
    const sameApplication = previous && previous.origin === pageUrl.origin && previous.pathPrefix === pathPrefix
      && previous.accountId === accountId && Date.now() < previous.expiresAt;
    const next = {
      tabId,
      origin: pageUrl.origin,
      pathPrefix,
      applicationUrl: pageUrl.href,
      accountId,
      startedAt: sameApplication ? previous.startedAt : Date.now(),
      expiresAt: sameApplication ? previous.expiresAt : Date.now() + 30 * 60 * 1_000,
      userEditedKeys: sameApplication ? previous.userEditedKeys ?? [] : [],
      writtenDrafts: sameApplication ? previous.writtenDrafts ?? {} : {},
      payload: { ...scopedPayload, workdayUserEditedKeys: sameApplication ? previous.userEditedKeys ?? [] : [] },
      needsReinject: false,
    };
    sessions[String(tabId)] = next;
    return { session: next };
  });
  if (session?.error) return { started: false, message: session.error };
  const trackingCompany = typeof tracking.company === "string" ? tracking.company.trim().slice(0, 200) : "";
  const trackingTitle = typeof tracking.title === "string" ? tracking.title.trim().slice(0, 300) : "";
  const trackingReady = Boolean(trackingCompany && trackingTitle);
  const preparedApplication = {
    tabId,
    accountId,
    company: trackingCompany,
    title: trackingTitle,
    location: typeof tracking.location === "string" ? tracking.location.trim().slice(0, 200) : "",
    applicationUrl: pageUrl.href,
    ...(applicationCountry ? { applicationCountry } : {}),
    preparedAt: Date.now(),
    ats: "Workday",
  };
  const persistedTracking = await mutateHelperState((current) => {
    if ((current.accountId ?? null) !== accountId) return { result: { accountChanged: true } };
    current.preparedApplication = preparedApplication;
    return {};
  });
  if (persistedTracking.result?.accountChanged) {
    await removeWorkdaySession(tabId, true, session.session.startedAt);
    return { started: false, message: "The Scout account changed. Reopen the helper before starting this session." };
  }
  try {
    const report = await injectWorkdaySession(tabId, session.session, true);
    if (!report?.supported || !report?.sessionActive) throw new Error(report?.manualReason || "Workday could not start the fill session.");
    await processEligibleWorkdayDrafts(tabId, session.session.startedAt, report).catch(() => undefined);
    return { started: true, report, expiresAt: session.session.expiresAt, origin: session.session.origin, trackingReady };
  } catch (error) {
    await removeWorkdaySession(tabId, true, session.session.startedAt);
    await clearPreparedApplication(tabId, preparedApplication);
    return { started: false, message: error.message || "Workday could not start the fill session." };
  }
}

async function handleStopWorkdaySession(message, sender) {
  if (!isPopupSender(sender)) return { stopped: false, message: "Only the Scout helper popup can stop a Workday session." };
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return { stopped: false, message: "The Workday tab could not be identified." };
  const session = (await getWorkdaySessions())[String(tabId)];
  if (!session) return { stopped: true };
  try {
    const tab = await chrome.tabs.get(tabId);
    const pageUrl = new URL(tab.url ?? "");
    if (pageUrl.origin === session.origin) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (startedAt) => globalThis.ScoutFormHelper?.stopWorkdaySession?.(false, startedAt) ?? { stopped: true },
        args: [session.startedAt],
      });
    }
  } catch {
    // Session storage is still cleared when the application tab has navigated or closed.
  }
  await removeWorkdaySession(tabId, true, session.startedAt);
  return { stopped: true };
}

async function handleGetWorkdaySession(message, sender) {
  if (!isPopupSender(sender)) return { active: false };
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return { active: false };
  const session = (await getWorkdaySessions())[String(tabId)];
  if (!session || Date.now() >= session.expiresAt) return { active: false };
  const tab = await chrome.tabs.get(tabId);
  let pageUrl;
  try { pageUrl = new URL(tab.url ?? ""); } catch { return { active: false }; }
  if (!isWithinWorkdayApplication(pageUrl, session)) return { active: false };
  const state = await getHelperState();
  return (state.accountId ?? null) === session.accountId
    ? {
      active: true,
      tabId,
      origin: session.origin,
      applicationUrl: session.applicationUrl,
      applicationCountry: session.payload?.applicationCountry ?? "",
      applicationCountryReviewed: session.payload?.applicationCountryReviewed === true,
      jobKey: session.payload?.jobKey ?? globalThis.ScoutAnswerContract.workdayJobKey(session.applicationUrl),
      writtenDrafts: Object.values(session.writtenDrafts ?? {}).map((draft) => ({
        ...draft,
        requestId: draft.requestId ?? "",
        jobKey: draft.jobKey ?? session.payload?.jobKey ?? "",
        maxLength: draft.maxLength ?? 2_000,
      })),
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
    }
    : { active: false };
}

async function handleWorkdaySessionEnded(message, sender) {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId)) return { stopped: false };
  const session = (await getWorkdaySessions())[String(tabId)];
  if (!session) return { stopped: true };
  await removeWorkdaySession(tabId, true, Number.isFinite(message.startedAt) ? message.startedAt : session.startedAt);
  return { stopped: true };
}

async function handleWorkdayStepResult(message, sender) {
  const tabId = sender.tab?.id;
  const session = Number.isInteger(tabId) ? (await getWorkdaySessions())[String(tabId)] : null;
  if (sender.id !== chrome.runtime.id || !session || typeof sender.url !== "string") return { accepted: false };
  let pageUrl;
  try { pageUrl = new URL(sender.url); } catch { return { accepted: false }; }
  if (!isWithinWorkdayApplication(pageUrl, session)) return { accepted: false };
  await chrome.runtime.sendMessage({ type: "scout.workdayStepResult", tabId, report: message.report }).catch(() => undefined);
  await processEligibleWorkdayDrafts(tabId, session.startedAt, message.report).catch(() => undefined);
  return { accepted: true };
}

async function handleGenerateWrittenDraft(message, sender) {
  if (!isPopupSender(sender)) return { generated: false, message: "Only the Scout helper popup can request a written draft." };
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return { generated: false, message: "The Workday application tab could not be identified." };
  const request = validateWrittenDraftRequest(message);
  if (!request) return { generated: false, message: "This question or request is outside the supported professional-answer flow." };
  return generateWrittenDraftForSession(tabId, request, { automatic: false });
}

async function handleApplyWrittenDraft(message, sender) {
  if (!isPopupSender(sender)) return { applied: false, reason: "UNTRUSTED_SENDER", message: "Only the Scout helper popup can apply a written draft." };
  const tabId = Number(message.tabId);
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  const pending = await getWrittenDraftEntry(requestId);
  if (!Number.isInteger(tabId) || !pending || pending.tabId !== tabId) {
    return { applied: false, reason: "EXPIRED", message: "This draft request expired. Check the Workday page again." };
  }
  const state = await getHelperState();
  if (!state.accountId || state.accountId !== pending.accountId || message.accountId !== pending.accountId) {
    await removeWrittenDraftEntry(requestId);
    return { applied: false, reason: "ACCOUNT_MISMATCH", message: "The signed-in Scout account changed. Reconnect before using this draft." };
  }
  const session = (await getWorkdaySessions())[String(tabId)];
  if (!isCurrentWrittenDraftSession(session, pending)) {
    await removeWrittenDraftEntry(requestId);
    return { applied: false, reason: "STALE_SESSION", message: "The Workday session or job changed. Generate a new draft for the current page." };
  }
  const draft = typeof message.draft === "string" ? message.draft.trim() : "";
  if (!draft || draft.length > pending.maxLength) return { applied: false, reason: "INVALID_DRAFT", message: "The edited draft is empty or exceeds the field limit." };
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== pending.applicationUrl || !await isActiveTab(tabId)) {
    await removeWrittenDraftEntry(requestId);
    return { applied: false, reason: "STALE_PAGE", message: "The active Workday page changed. Review the current question before applying." };
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (value) => globalThis.ScoutFormHelper?.applyWrittenDraft?.(value) ?? { applied: false, reason: "HELPER_MISSING", message: "Scout could not inspect this Workday field." },
    args: [{ question: pending.question, draft, previousDraft: pending.draft, applicationUrl: pending.applicationUrl, userEditedKeys: session.userEditedKeys ?? [] }],
  });
  const applied = results[0]?.result;
  if (!applied?.applied) {
    await removeWrittenDraftEntry(requestId);
    return { applied: false, reason: applied?.reason || "FIELD_CHANGED", message: applied?.message || "That answer is no longer blank." };
  }
  await updateWorkdayDraftStatus(tabId, session.startedAt, pending.question, {
    requestId,
    jobKey: pending.jobKey,
    applicationUrl: pending.applicationUrl,
    maxLength: pending.maxLength,
    status: "applied",
    draft,
    sources: pending.sources,
    model: pending.model,
    updatedAt: Date.now(),
  });
  await removeWrittenDraftEntry(requestId);
  return { applied: true, requestId, question: pending.question, applicationUrl: pending.applicationUrl };
}

function validateWrittenDraftRequest(message) {
  const question = typeof message.question === "string" ? message.question.trim() : "";
  const applicationUrl = typeof message.applicationUrl === "string" ? message.applicationUrl : "";
  const jobDescription = typeof message.jobDescription === "string" ? message.jobDescription.trim().slice(0, 20_000) : "";
  const jobKey = typeof message.jobKey === "string" ? message.jobKey : "";
  const maxLength = Number.isInteger(message.maxLength) && message.maxLength > 0 ? Math.min(message.maxLength, 2_000) : 2_000;
  const requestId = typeof message.requestId === "string" && /^[\w-]{16,100}$/.test(message.requestId) ? message.requestId : "";
  let parsed;
  try { parsed = new URL(applicationUrl); } catch { return null; }
  if (!requestId || !question || question.length > 1_000 || !jobDescription || jobDescription.length < 40
    || !jobKey || jobKey !== globalThis.ScoutAnswerContract.workdayJobKey(applicationUrl)
    || !isWorkdayApplicationUrl(applicationUrl) || !isWorkdayApplicationRoute(parsed.pathname)
    || !globalThis.ScoutAnswerContract.isWrittenNarrativePrompt(question)) return null;
  return {
    requestId,
    question,
    applicationUrl,
    jobKey,
    jobDescription,
    company: typeof message.company === "string" ? message.company.trim().slice(0, 200) : "",
    title: typeof message.title === "string" ? message.title.trim().slice(0, 300) : "",
    applicationCountry: ["Canada", "United States"].includes(message.applicationCountry) ? message.applicationCountry : "",
    locale: typeof message.locale === "string" ? message.locale.trim().slice(0, 32) : "",
    maxLength,
  };
}

async function generateWrittenDraftForSession(tabId, request, { automatic }) {
  const tab = await chrome.tabs.get(tabId);
  if ((!automatic && !await isActiveTab(tabId)) || tab.url !== request.applicationUrl) {
    return { generated: false, reason: "STALE_PAGE", message: "The active Workday page changed before the draft request." };
  }
  const state = await getHelperState();
  const session = (await getWorkdaySessions())[String(tabId)];
  if (!state.accountId || !state.scoutOrigin || !session || !isCurrentWrittenDraftSession(session, {
    tabId, accountId: state.accountId, applicationUrl: request.applicationUrl, jobKey: request.jobKey,
  })) {
    return { generated: false, reason: "NO_SESSION", message: "Connect Scout and start a Workday session for this job first." };
  }
  if (request.applicationCountry !== (session.payload?.applicationCountry ?? "")) {
    return { generated: false, reason: "COUNTRY_CHANGED", message: "The application-country selection changed. Check the Workday job again." };
  }
  const boundCountry = globalThis.ScoutAnswerContract.applicationCountryForJob(state, request.jobKey);
  if (boundCountry !== (session.payload?.applicationCountry ?? "")
    || (automatic && (state.writtenAnswerDraftingEnabled === false || session.payload?.autoDraftWrittenAnswers === false))) {
    return { generated: false, reason: "SESSION_SETTINGS_CHANGED", message: "The drafting setting or job-country selection changed. Review the current application settings." };
  }
  if (request.jobDescription !== session.payload?.jobDescription || request.jobKey !== session.payload?.jobKey) {
    return { generated: false, reason: "JOB_CONTEXT_MISMATCH", message: "The saved job description no longer matches this Workday application." };
  }
  if (!session.payload?.autoDraftWrittenAnswers && automatic) {
    return { generated: false, reason: "DRAFTS_DISABLED", message: "Automatic written drafts are disabled for this session." };
  }
  const validation = await inspectWrittenDraftInTab(tabId, request.question, request.applicationUrl);
  if (!validation?.eligible || validation.maxLength !== request.maxLength) {
    return { generated: false, reason: "FIELD_NOT_ELIGIBLE", message: validation?.reason || "That field is no longer a blank professional response." };
  }
  const professionalProfile = professionalProfileProjection(session.payload?.profile ?? {});
  const inputSnapshot = {
    accountId: state.accountId,
    startedAt: session.startedAt,
    applicationUrl: request.applicationUrl,
    jobKey: request.jobKey,
    applicationCountry: session.payload?.applicationCountry ?? "",
    autoDraftWrittenAnswers: session.payload?.autoDraftWrittenAnswers !== false,
    jobDescription: session.payload?.jobDescription ?? "",
    professionalProfile,
    answers: session.payload?.answers ?? [],
  };
  const generated = await callScoutWrittenDraftBridge(state.scoutOrigin, state.accountId, {
    ...request,
    company: session.payload?.writtenDraftContext?.company ?? "",
    title: session.payload?.writtenDraftContext?.title ?? "",
    applicationCountry: session.payload?.applicationCountry ?? "",
    candidateProfile: professionalProfile,
  });
  const expectedCanonicalUrl = globalThis.ScoutAnswerContract.canonicalApplicationUrl(request.applicationUrl);
  const returnedCanonicalUrl = globalThis.ScoutAnswerContract.canonicalApplicationUrl(generated.applicationUrl);
  if (generated.requestId !== request.requestId || !expectedCanonicalUrl || returnedCanonicalUrl !== expectedCanonicalUrl
    || typeof generated.draft !== "string" || !generated.draft.trim() || generated.draft.length > request.maxLength) {
    return { generated: false, reason: "INVALID_RESPONSE", message: "Scout returned a draft for a different request or outside this field’s length limit." };
  }
  const latestState = await getHelperState();
  const latestSession = (await getWorkdaySessions())[String(tabId)];
  const latestTab = await chrome.tabs.get(tabId);
  const latestInputs = {
    accountId: latestState.accountId,
    startedAt: latestSession?.startedAt,
    applicationUrl: latestTab.url,
    jobKey: latestSession?.payload?.jobKey,
    applicationCountry: globalThis.ScoutAnswerContract.applicationCountryForJob(latestState, request.jobKey),
    autoDraftWrittenAnswers: latestState.writtenAnswerDraftingEnabled !== false,
    jobDescription: latestSession?.payload?.jobDescription ?? "",
    professionalProfile: professionalProfileProjection(latestState.profile ?? {}),
    answers: latestState.answers ?? [],
  };
  if (latestState.accountId !== state.accountId || latestTab.url !== request.applicationUrl
    || !isCurrentWrittenDraftSession(latestSession, { tabId, accountId: state.accountId, applicationUrl: request.applicationUrl, jobKey: request.jobKey })
    || (automatic && latestState.writtenAnswerDraftingEnabled === false)
    || !globalThis.ScoutAnswerContract.sameWrittenDraftInputs(inputSnapshot, latestInputs)) {
    return { generated: false, reason: "STALE_RESPONSE", message: "The Scout account, Workday page, or application changed while the draft was generating." };
  }
  const pending = {
    requestId: request.requestId,
    tabId,
    accountId: state.accountId,
    applicationUrl: request.applicationUrl,
    jobKey: request.jobKey,
    question: request.question,
    maxLength: request.maxLength,
    draft: generated.draft,
    sources: generated.sources,
    model: generated.model,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1_000,
  };
  await storeWrittenDraftEntry(pending);
  if (!automatic) return { generated: true, ...publicWrittenDraft(pending) };

  await applyGeneratedWorkdayDraft(pending, latestSession);
  const appliedState = (await getWorkdaySessions())[String(tabId)];
  const applied = appliedState?.writtenDrafts?.[globalThis.ScoutAnswerContract.normalizeQuestion(request.question)];
  if (applied?.status !== "applied") {
    return { generated: false, reason: "APPLY_FAILED", message: applied?.message || "The page changed before the draft could be inserted." };
  }
  return { generated: true, applied: true, ...publicWrittenDraft(applied) };
}

async function processEligibleWorkdayDrafts(tabId, startedAt, report) {
  let session = (await getWorkdaySessions())[String(tabId)];
  if (!session || session.startedAt !== startedAt) return;
  const draftingEnabled = session.payload?.autoDraftWrittenAnswers !== false;
  const questions = draftingEnabled && Array.isArray(report?.unknownQuestions)
    ? report.unknownQuestions.filter((item) => item?.writtenDraftEligible === true
      && typeof item.question === "string"
      && !session.writtenDrafts?.[globalThis.ScoutAnswerContract.normalizeQuestion(item.question)])
      .slice(0, 20)
    : [];
  const needsDescription = questions.length > 0 && String(session.payload?.jobDescription ?? "").trim().length < 40;
  const needsCountry = !["Canada", "United States"].includes(session.payload?.applicationCountry)
    && session.payload?.applicationCountryReviewed !== true
    && !session.payload?.countryContextCaptureAttemptedAt;
  if (needsDescription || needsCountry) {
    const captured = await captureWorkdayDescriptionForSession(tabId, session, report, needsDescription, needsCountry);
    if (captured?.session) session = captured.session;
    else if (needsCountry) {
      session = await workdaySessionStore.update((sessions) => {
        const current = sessions[String(tabId)];
        if (!current || current.startedAt !== startedAt) return null;
        current.payload.countryContextCaptureAttemptedAt = Date.now();
        return current;
      }) ?? session;
    }
    const latestState = await getHelperState();
    if (!session || session.startedAt !== startedAt || latestState.accountId !== session.accountId) return;
    if (needsDescription && (!draftingEnabled || latestState.writtenAnswerDraftingEnabled === false)) return;
    if (needsDescription && !captured?.available) {
      for (const item of questions.slice(0, 20)) {
        await updateWorkdayDraftStatus(tabId, startedAt, item.question, {
          question: item.question,
          applicationUrl: report.applicationUrl,
          jobKey: session.payload?.jobKey ?? "",
          maxLength: item.maxLength,
          status: "manual",
          message: captured?.message || "A same-job public description is unavailable. Enter this professional answer yourself.",
          updatedAt: Date.now(),
        });
      }
      return;
    }
  }
  for (const item of questions) {
    const key = globalThis.ScoutAnswerContract.normalizeQuestion(item.question);
    const claim = await workdaySessionStore.update((sessions) => {
      const current = sessions[String(tabId)];
      if (!current || current.startedAt !== startedAt || current.writtenDrafts?.[key]) return null;
      current.writtenDrafts = current.writtenDrafts ?? {};
      current.writtenDrafts[key] = {
        question: item.question,
        applicationUrl: report.applicationUrl,
        jobKey: current.payload?.jobKey ?? globalThis.ScoutAnswerContract.workdayJobKey(report.applicationUrl),
        maxLength: item.maxLength,
        status: "generating",
        updatedAt: Date.now(),
      };
      return { ...current };
    });
    if (!claim) continue;
    const request = validateWrittenDraftRequest({
      requestId: crypto.randomUUID(),
      question: item.question,
      applicationUrl: report.applicationUrl,
      jobKey: claim.payload?.jobKey,
      jobDescription: claim.payload?.jobDescription,
      company: claim.payload?.writtenDraftContext?.company,
      title: claim.payload?.writtenDraftContext?.title,
      applicationCountry: claim.payload?.applicationCountry,
      locale: report.locale,
      maxLength: item.maxLength,
    });
    if (!request) {
      await updateWorkdayDraftStatus(tabId, startedAt, item.question, {
        question: item.question,
        applicationUrl: report.applicationUrl,
        jobKey: claim.payload?.jobKey ?? "",
        maxLength: item.maxLength,
        status: "manual",
        message: "A same-job description is unavailable or this narrative cannot be verified. Enter the answer yourself.",
        updatedAt: Date.now(),
      });
      continue;
    }
    let result;
    try { result = await generateWrittenDraftForSession(tabId, request, { automatic: true }); }
    catch (error) { result = { generated: false, message: error.message || "Scout could not generate this answer. Enter it yourself." }; }
    if (!result.generated) {
      await updateWorkdayDraftStatus(tabId, startedAt, item.question, {
        question: item.question,
        applicationUrl: report.applicationUrl,
        jobKey: request.jobKey,
        maxLength: request.maxLength,
        status: "manual",
        message: result.message || "A written draft is unavailable. Enter the answer yourself.",
        updatedAt: Date.now(),
      });
    }
  }
}

function workdayPublicListingUrl(applicationUrl, expectedJobKey) {
  if (!isWorkdayApplicationUrl(applicationUrl)) return "";
  return globalThis.ScoutAnswerContract.workdayPublicListingUrl(applicationUrl, expectedJobKey);
}

async function captureWorkdayDescriptionForSession(tabId, session, report, requireDescription = true, requireCountry = false) {
  const key = `${tabId}:${session.startedAt}`;
  if (workdayDescriptionCapturePromises.has(key)) return workdayDescriptionCapturePromises.get(key);
  const operation = captureWorkdayDescriptionForSessionUnqueued(tabId, session, report, requireDescription, requireCountry)
    .finally(() => workdayDescriptionCapturePromises.delete(key));
  workdayDescriptionCapturePromises.set(key, operation);
  return operation;
}

async function captureWorkdayDescriptionForSessionUnqueued(tabId, session, report, requireDescription = true, requireCountry = false) {
  const expectedJobKey = session.payload?.jobKey ?? "";
  const applicationUrl = typeof report?.applicationUrl === "string" ? report.applicationUrl : session.applicationUrl;
  const listingUrl = workdayPublicListingUrl(applicationUrl, expectedJobKey);
  if (!listingUrl || new URL(listingUrl).origin !== session.origin) {
    return { available: false, message: "The public Workday posting could not be derived from this application URL." };
  }
  const permission = `${session.origin}/*`;
  if (!await chrome.permissions.contains({ origins: [permission] })) {
    return { available: false, message: "Temporary access to this exact employer site is unavailable; enter the professional answer yourself." };
  }
  const applicationTab = await chrome.tabs.get(tabId);
  if (applicationTab.url !== applicationUrl || !isWithinWorkdayApplication(new URL(applicationUrl), session)) {
    return { available: false, message: "The Workday application changed before its public posting could be checked." };
  }
  let temporaryTab = null;
  try {
    temporaryTab = await chrome.tabs.create({ url: listingUrl, active: false });
    const loadDeadline = Date.now() + 12_000;
    let loaded = null;
    while (Date.now() < loadDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      loaded = await chrome.tabs.get(temporaryTab.id);
      let loadedUrl;
      try { loadedUrl = new URL(loaded.url ?? ""); } catch { continue; }
      if (loadedUrl.origin !== session.origin || globalThis.ScoutAnswerContract.workdayJobKey(loadedUrl.href) !== expectedJobKey) {
        return { available: false, message: "The public posting redirected away from this exact Workday job." };
      }
      if (loaded.status === "complete") break;
    }
    if (!loaded || loaded.status !== "complete") {
      return { available: false, message: "The public Workday posting did not finish loading in time." };
    }
    await chrome.scripting.executeScript({ target: { tabId: temporaryTab.id }, files: ["answer-contract.js", "ats.js"] });
    const renderDeadline = Date.now() + 5_000;
    let result = null;
    while (Date.now() < renderDeadline) {
      const currentTemporary = await chrome.tabs.get(temporaryTab.id);
      const currentUrl = new URL(currentTemporary.url ?? "");
      if (currentUrl.origin !== session.origin || globalThis.ScoutAnswerContract.workdayJobKey(currentUrl.href) !== expectedJobKey) {
        return { available: false, message: "The public posting changed while its description was loading." };
      }
      const applicationTabNow = await chrome.tabs.get(tabId);
      const latestSession = (await getWorkdaySessions())[String(tabId)];
      const latestState = await getHelperState();
      if (applicationTabNow.url !== applicationUrl || latestState.accountId !== session.accountId
        || latestSession?.startedAt !== session.startedAt || latestSession.payload?.jobKey !== expectedJobKey) {
        return { available: false, message: "The Scout account or active Workday application changed before description capture finished." };
      }
      const responses = await chrome.scripting.executeScript({
        target: { tabId: temporaryTab.id },
        func: (jobKey) => globalThis.ScoutFormHelper?.readWorkdayJobDescription?.(jobKey)
          ?? { available: false, reason: "The read-only Workday description helper is unavailable." },
        args: [expectedJobKey],
      });
      result = responses[0]?.result ?? null;
      const hasDescription = result?.available === true && typeof result.jobDescription === "string"
        && result.jobDescription.trim().length >= 40;
      const hasCountryEvidence = Array.isArray(result?.jobCountryEvidence) && result.jobCountryEvidence.length > 0;
      const hasResolvedCountry = ["Canada", "United States"].includes(result?.applicationCountry);
      if (result?.listingRead === true && result.jobKey === expectedJobKey
        && (!requireDescription || hasDescription)
        && (!requireCountry || hasCountryEvidence || hasResolvedCountry)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (result?.listingRead !== true || result.jobKey !== expectedJobKey) {
      return { available: false, message: result?.reason || "The exact same-job public posting could not be read." };
    }
    const hasDescription = result.available === true && typeof result.jobDescription === "string"
      && result.jobDescription.trim().length >= 40;
    if (requireDescription && !hasDescription) {
      // Country evidence is still useful even when the posting has no usable narrative description.
      // The session and popup country state are updated below before reporting this limitation.
    }
    const jobDescription = hasDescription ? result.jobDescription.trim().replace(/\s+/g, " ").slice(0, 20_000) : "";
    const jobCountryEvidence = Array.isArray(result.jobCountryEvidence)
      ? result.jobCountryEvidence.filter((item) => typeof item === "string").map((item) => item.slice(0, 500)).slice(0, 8) : [];
    const applicationCountry = session.payload?.applicationCountryReviewed === true
      ? session.payload.applicationCountry ?? ""
      : globalThis.ScoutAnswerContract.inferWorkdayJobCountry(listingUrl, jobCountryEvidence);
    const updated = await workdaySessionStore.update((sessions) => {
      const current = sessions[String(tabId)];
      if (!current || current.startedAt !== session.startedAt || current.accountId !== session.accountId
        || current.payload?.jobKey !== expectedJobKey || current.applicationUrl !== session.applicationUrl) return null;
      if (jobDescription) current.payload.jobDescription = jobDescription;
      current.payload.jobDescriptionPostingUrl = listingUrl;
      current.payload.jobCountryEvidence = jobCountryEvidence;
      if (current.payload.applicationCountryReviewed !== true) current.payload.applicationCountry = applicationCountry;
      current.payload.countryContextCaptureAttemptedAt = Date.now();
      if (jobDescription) current.payload.jobDescriptionCapturedAt = Date.now();
      return current;
    });
    if (!updated) return { available: false, message: "The Workday session changed before its posting context could be saved." };

    await mutateHelperState((current) => {
      if ((current.accountId ?? null) !== session.accountId || current.applicationCountryReviewed === true) return {};
      const boundKey = globalThis.ScoutAnswerContract.workdayJobKey(current.applicationCountryApplicationUrl);
      if (boundKey && boundKey !== expectedJobKey) return {};
      current.applicationCountry = applicationCountry;
      current.applicationCountryApplicationUrl = session.applicationUrl;
      current.applicationCountryEvidence = jobCountryEvidence;
      current.applicationCountryReviewed = false;
      return {};
    });

    try {
      const latestSession = (await getWorkdaySessions())[String(tabId)];
      await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (payload) => globalThis.ScoutFormHelper?.updateWorkdaySessionPayload?.(payload) ?? { updated: false },
        args: [{
          ...latestSession.payload,
          workdayUserEditedKeys: latestSession.userEditedKeys ?? [],
          workdayStartedAt: latestSession.startedAt,
          workdayExpiresAt: latestSession.expiresAt,
        }],
      });
    } catch {
      // The updated payload is retained for the next Workday route reinjection.
    }
    return {
      available: hasDescription,
      locationAvailable: Boolean(applicationCountry),
      session: updated,
      ...(!hasDescription ? { message: result?.reason || "The same-job public posting did not expose enough description text." } : {}),
    };
  } catch (error) {
    return { available: false, message: error?.message || "The same-job public description could not be read." };
  } finally {
    if (temporaryTab?.id) await chrome.tabs.remove(temporaryTab.id).catch(() => undefined);
  }
}

async function applyGeneratedWorkdayDraft(pending, session) {
  const tab = await chrome.tabs.get(pending.tabId);
  if (tab.url !== pending.applicationUrl) throw new Error("The Workday page changed before the draft could be inserted.");
  const result = await injectApplyWrittenDraft(pending.tabId, {
    question: pending.question,
    draft: pending.draft,
    previousDraft: pending.draft,
    applicationUrl: pending.applicationUrl,
    userEditedKeys: session.userEditedKeys ?? [],
  });
  if (!result?.applied) {
    await updateWorkdayDraftStatus(pending.tabId, session.startedAt, pending.question, {
      ...publicWrittenDraft(pending),
      status: "manual",
      message: result?.message || "The answer changed while the draft was generating; review it manually.",
      updatedAt: Date.now(),
    });
    return { applied: false };
  }
  const status = {
    ...publicWrittenDraft(pending),
    status: "applied",
    updatedAt: Date.now(),
  };
  await updateWorkdayDraftStatus(pending.tabId, session.startedAt, pending.question, status);
  await chrome.runtime.sendMessage({ type: "scout.workdayWrittenDraftStatus", tabId: pending.tabId, ...status }).catch(() => undefined);
  return { applied: true, result };
}

function isWorkdayApplicationRoute(pathname) {
  return /\/job\/[^/]+\/[^/]+\/apply(?:\/|$)/i.test(String(pathname ?? ""));
}

function isCurrentWrittenDraftSession(session, request) {
  if (!session || !request || session.accountId !== request.accountId || Number(session.tabId) !== Number(request.tabId)
    || Date.now() >= session.expiresAt) return false;
  let url;
  try { url = new URL(request.applicationUrl); } catch { return false; }
  if (!isWithinWorkdayApplication(url, session) || !isWorkdayApplicationRoute(url.pathname)) return false;
  const expectedJobKey = request.jobKey || globalThis.ScoutAnswerContract.workdayJobKey(url.href);
  const sessionJobKey = session.payload?.jobKey || globalThis.ScoutAnswerContract.workdayJobKey(session.applicationUrl);
  return Boolean(expectedJobKey && sessionJobKey === expectedJobKey);
}

async function isActiveTab(tabId) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active?.id === tabId;
}

async function inspectWrittenDraftInTab(tabId, question, applicationUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== applicationUrl) return { eligible: false, reason: "The Workday page changed." };
  await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (value, url) => globalThis.ScoutFormHelper?.inspectWrittenDraft?.(value, url) ?? { eligible: false, reason: "Scout could not inspect this question." },
    args: [question, applicationUrl],
  });
  return results[0]?.result ?? { eligible: false, reason: "Scout could not inspect this question." };
}

async function injectApplyWrittenDraft(tabId, request) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (value) => globalThis.ScoutFormHelper?.applyWrittenDraft?.(value) ?? { applied: false, reason: "HELPER_MISSING", message: "Scout could not inspect this Workday field." },
    args: [request],
  });
  return results[0]?.result;
}

function professionalProfileProjection(source) {
  const text = (value, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const present = (row, keys) => keys.some((key) => typeof row[key] === "string" && row[key].trim());
  const experience = Array.isArray(source?.experience) ? source.experience.slice(0, 20).filter((row) => row && present(row, ["company", "title", "location", "description"])).map((row) => ({
    company: text(row.company, 200), title: text(row.title, 200), location: text(row.location, 200), description: text(row.description, 2_000),
    startDate: text(row.startDate, 32), endDate: text(row.endDate, 32), currentlyWorkHere: row.currentlyWorkHere === true || row.currentlyWorkHere === false ? row.currentlyWorkHere : null,
  })) : [];
  const education = Array.isArray(source?.education) ? source.education.slice(0, 12).filter((row) => row && present(row, ["school", "degree", "fieldOfStudy", "gradeAverage"])).map((row) => ({
    school: text(row.school, 300), degree: text(row.degree, 200), fieldOfStudy: text(row.fieldOfStudy, 300), gradeAverage: text(row.gradeAverage, 100),
    startDate: text(row.startDate, 32), endDate: text(row.endDate, 32),
  })) : [];
  const languages = Array.isArray(source?.languages) ? source.languages.slice(0, 20).filter((row) => row && text(row.language, 100)).map((row) => ({
    language: text(row.language, 100), fluent: row.fluent === true || row.fluent === false ? row.fluent : null,
    comprehension: text(row.comprehension, 100), overall: text(row.overall, 100), reading: text(row.reading, 100),
    speaking: text(row.speaking, 100), writing: text(row.writing, 100),
  })) : [];
  const projects = Array.isArray(source?.projects) ? source.projects.slice(0, 20).filter((row) => row && present(row, ["company", "title", "description"])).map((row) => ({
    company: text(row.company, 200), title: text(row.title, 200), startDate: text(row.startDate, 32), endDate: text(row.endDate, 32), description: text(row.description, 2_000),
  })) : [];
  const skills = Array.isArray(source?.skills) ? source.skills.slice(0, 30).filter((row) => row && text(row.label, 100) && Array.isArray(row.items)).map((row) => ({
    label: text(row.label, 100), items: row.items.filter((item) => typeof item === "string" && item.trim()).slice(0, 50).map((item) => text(item, 100)),
  })) : [];
  return { experience, education, projects, languages, skills };
}

async function mutateWrittenDraftStorage(mutator) {
  const operation = writtenDraftRequestsQueue.then(async () => {
    const stored = await chrome.storage.session.get(WRITTEN_DRAFT_REQUESTS_KEY);
    const current = stored[WRITTEN_DRAFT_REQUESTS_KEY] && typeof stored[WRITTEN_DRAFT_REQUESTS_KEY] === "object"
      ? stored[WRITTEN_DRAFT_REQUESTS_KEY] : { pending: {} };
    current.pending = current.pending && typeof current.pending === "object" ? current.pending : {};
    const result = await mutator(current);
    await chrome.storage.session.set({ [WRITTEN_DRAFT_REQUESTS_KEY]: current });
    return result;
  });
  writtenDraftRequestsQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function storeWrittenDraftEntry(entry) {
  return mutateWrittenDraftStorage((storage) => {
    storage.pending[entry.requestId] = entry;
    for (const [requestId, value] of Object.entries(storage.pending)) {
      if (!value || value.expiresAt <= Date.now()) delete storage.pending[requestId];
    }
  });
}

async function getWrittenDraftEntry(requestId) {
  return mutateWrittenDraftStorage((storage) => {
    const entry = storage.pending[requestId];
    if (!entry || entry.expiresAt <= Date.now()) {
      delete storage.pending[requestId];
      return null;
    }
    return entry;
  });
}

async function removeWrittenDraftEntry(requestId) {
  return mutateWrittenDraftStorage((storage) => { delete storage.pending[requestId]; });
}

async function clearWrittenDraftCache() {
  return mutateWrittenDraftStorage((storage) => { storage.pending = {}; });
}

async function removeWrittenDraftsForTab(tabId) {
  return mutateWrittenDraftStorage((storage) => {
    for (const [requestId, value] of Object.entries(storage.pending)) if (value?.tabId === tabId) delete storage.pending[requestId];
  });
}

async function updateWorkdayDraftStatus(tabId, startedAt, question, status) {
  const key = globalThis.ScoutAnswerContract.normalizeQuestion(question);
  const updated = await workdaySessionStore.update((sessions) => {
    const session = sessions[String(tabId)];
    if (!session || session.startedAt !== startedAt) return null;
    session.writtenDrafts = session.writtenDrafts ?? {};
    session.writtenDrafts[key] = { ...(session.writtenDrafts[key] ?? {}), ...status };
    return session.writtenDrafts[key];
  });
  if (updated) await chrome.runtime.sendMessage({ type: "scout.workdayWrittenDraftStatus", tabId, ...updated }).catch(() => undefined);
  return updated;
}

function publicWrittenDraft(value) {
  return {
    requestId: value.requestId,
    jobKey: value.jobKey,
    applicationUrl: value.applicationUrl,
    question: value.question,
    maxLength: value.maxLength,
    draft: value.draft,
    ...(typeof value.draftId === "string" ? { draftId: value.draftId } : {}),
    sources: Array.isArray(value.sources) ? value.sources.slice(0, 20).map((source) => ({ sourceRef: source.sourceRef, label: source.label })) : [],
    model: value.model || "gpt-6-luna",
  };
}

async function callScoutWrittenDraftBridge(origin, accountId, request) {
  const normalizedOrigin = new URL(origin).origin;
  const pattern = `${normalizedOrigin}/*`;
  if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error("Scout account permission is unavailable. Reconnect Scout and try again.");
  let tab = (await chrome.tabs.query({})).find((candidate) => {
    try { return new URL(candidate.url ?? "").origin === normalizedOrigin; } catch { return false; }
  });
  let temporary = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: `${normalizedOrigin}/jobs`, active: false });
    temporary = true;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const latest = await chrome.tabs.get(tab.id);
      if (latest.status === "complete" && latest.url && new URL(latest.url).origin === normalizedOrigin) {
        tab = latest;
        break;
      }
      if (latest.status === "complete" && latest.url && new URL(latest.url).origin !== normalizedOrigin) {
        if (temporary) await chrome.tabs.remove(tab.id).catch(() => undefined);
        throw new Error("Scout redirected to another site. Reopen Scout and reconnect.");
      }
    }
    if (tab.status !== "complete" || !tab.url || new URL(tab.url).origin !== normalizedOrigin) {
      if (temporary) await chrome.tabs.remove(tab.id).catch(() => undefined);
      throw new Error("Scout did not finish loading. Open Scout and try again.");
    }
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (expectedOrigin, expectedAccountId, body) => {
        const fail = (message, status = 0) => ({ ok: false, message, status });
        if (location.origin !== expectedOrigin) return fail("The Scout page origin changed.");
        let sessionResponse;
        let session;
        try {
          sessionResponse = await fetch(`${expectedOrigin}/api/auth/session`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
          session = await sessionResponse.json();
        } catch { return fail("Scout could not be reached."); }
        const userId = typeof session?.user?.id === "string" ? session.user.id : "";
        if (!sessionResponse.ok || session?.authenticated !== true || session?.user?.emailVerified !== true || userId !== expectedAccountId) {
          return fail("The signed-in Scout account changed or needs verification.", 409);
        }
        let profileResponse;
        let profile;
        try {
          profileResponse = await fetch(`${expectedOrigin}/api/browser-helper/profile`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
          profile = await profileResponse.json();
        } catch { return fail("Scout could not load the saved application profile."); }
        const accountId = typeof profile?.accountId === "string" ? profile.accountId : userId;
        if (!profileResponse.ok || profile?.contract !== "scout.browser-helper.v1" || accountId !== expectedAccountId) {
          return fail("The signed-in Scout account changed. Reconnect before requesting a draft.", 409);
        }
        const csrfToken = typeof profile.csrfToken === "string" ? profile.csrfToken : typeof session.csrfToken === "string" ? session.csrfToken : "";
        if (!csrfToken) return fail("Scout did not provide a security token. Reload Scout and try again.", 403);
        let response;
        let result;
        try {
          response = await fetch(`${expectedOrigin}/api/browser-helper/written-draft`, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "X-Scout-Account-Id": expectedAccountId },
            body: JSON.stringify(body),
          });
          result = await response.json();
        } catch { return fail("Scout could not reach the written-draft service."); }
        if (!response.ok) return fail(typeof result?.error === "string" ? result.error : "Scout could not generate a written draft.", response.status);
        return { ok: true, accountId, result };
      },
      args: [normalizedOrigin, accountId, {
        requestId: request.requestId,
        question: request.question,
        applicationUrl: request.applicationUrl,
        jobDescription: request.jobDescription,
        ...(request.company ? { company: request.company } : {}),
        ...(request.title ? { title: request.title } : {}),
        ...(request.applicationCountry ? { applicationCountry: request.applicationCountry } : {}),
        ...(request.locale ? { locale: request.locale } : {}),
        maxLength: request.maxLength,
        candidateProfile: request.candidateProfile,
      }],
    });
    const bridge = results[0]?.result;
    if (!bridge?.ok) {
      const error = new Error(bridge?.message || "Scout could not generate a written draft.");
      error.code = bridge?.status === 409 ? "ACCOUNT_MISMATCH" : `HTTP_${bridge?.status ?? 0}`;
      throw error;
    }
    const response = bridge.result;
    if (bridge.accountId !== accountId || response?.requestId !== request.requestId
      || globalThis.ScoutAnswerContract.canonicalApplicationUrl(response?.applicationUrl)
        !== globalThis.ScoutAnswerContract.canonicalApplicationUrl(request.applicationUrl)
      || typeof response?.draft !== "string" || response.draft.length > request.maxLength) {
      throw new Error("Scout returned a response that did not match the active question and application.");
    }
    return response;
  } finally {
    if (temporary && tab?.id) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function recordWorkdayUserEdit(message, sender) {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || typeof sender.url !== "string"
    || typeof message.fieldKey !== "string" || message.fieldKey.length > 200) return { saved: false };
  let pageUrl;
  try { pageUrl = new URL(sender.url); } catch { return { saved: false }; }
  return workdaySessionStore.update((sessions) => {
    const session = sessions[String(tabId)];
    if (!isWithinWorkdayApplication(pageUrl, session)) return { saved: false };
    session.userEditedKeys = [...new Set([...(session.userEditedKeys ?? []), message.fieldKey])].slice(-200);
    session.payload.workdayUserEditedKeys = session.userEditedKeys;
    return { saved: true };
  });
}

async function clearWorkdayUserEdit(message, sender) {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || typeof sender.url !== "string"
    || message.fieldKey !== "repeatable:experience:structure") return { saved: false };
  let pageUrl;
  try { pageUrl = new URL(sender.url); } catch { return { saved: false }; }
  return workdaySessionStore.update((sessions) => {
    const session = sessions[String(tabId)];
    if (!isWithinWorkdayApplication(pageUrl, session)) return { saved: false };
    session.userEditedKeys = (session.userEditedKeys ?? []).filter((key) => key !== message.fieldKey);
    session.payload.workdayUserEditedKeys = session.userEditedKeys;
    return { saved: true };
  });
}

async function injectWorkdaySession(tabId, session, forceDefaults) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-contract.js", "ats.js"] });
  const payload = {
    ...session.payload,
    workdayUserEditedKeys: session.userEditedKeys ?? [],
    workdayStartedAt: session.startedAt,
    workdayExpiresAt: session.expiresAt,
  };
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (value, force) => await globalThis.ScoutFormHelper?.startWorkdaySession?.({ ...value, forceDefaults: force }) ?? { supported: false },
    args: [payload, forceDefaults],
  });
  return results[0]?.result;
}

async function markWorkdayDocumentLoading(tabId) {
  await workdaySessionStore.update((sessions) => {
    const session = sessions[String(tabId)];
    if (session) session.needsReinject = true;
  });
}

async function rearmWorkdayForTab(tabId, tab) {
  const session = (await getWorkdaySessions())[String(tabId)];
  if (!session) return;
  if (Date.now() >= session.expiresAt) return removeWorkdaySession(tabId, true, session.startedAt);
  let pageUrl;
  try { pageUrl = new URL(tab?.url ?? ""); } catch { return; }
  if (!isWithinWorkdayApplication(pageUrl, session)) return removeWorkdaySession(tabId, true, session.startedAt);
  if (!session.needsReinject) return;
  const state = await getHelperState();
  if ((state.accountId ?? null) !== session.accountId) return removeWorkdaySession(tabId, true, session.startedAt);
  const current = await workdaySessionStore.update((sessions) => {
    const stored = sessions[String(tabId)];
    if (!stored || stored.startedAt !== session.startedAt) return null;
    stored.needsReinject = false;
    return stored;
  });
  if (!current) return;
  try {
    const report = await injectWorkdaySession(tabId, current, true);
    if (report?.supported) await chrome.runtime.sendMessage({ type: "scout.workdayStepResult", tabId, report }).catch(() => undefined);
  } catch {
    await removeWorkdaySession(tabId, true, session.startedAt);
  }
}

function isPopupSender(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  try {
    const senderUrl = new URL(sender.url);
    return senderUrl.protocol === "chrome-extension:"
      && senderUrl.hostname === chrome.runtime.id
      && senderUrl.pathname === "/popup.html";
  } catch {
    return false;
  }
}

function isValidPendingApplication(value) {
  return value && typeof value.localId === "string" && typeof value.accountId === "string"
    && typeof value.company === "string" && typeof value.title === "string"
    && typeof value.applicationUrl === "string" && value.confirmedSubmitted === true;
}

async function handleConfirmation(message, sender) {
  const tabId = sender.tab?.id;
  const application = message.application;
  if (!Number.isInteger(tabId) || !application || typeof sender.url !== "string") return { queued: false };
  const context = (await getWatchContexts())[String(tabId)];
  if (!context || context.triggered || Date.now() - context.preparedAt > WATCH_WINDOW_MS) return { queued: false };
  let senderUrl;
  try { senderUrl = new URL(sender.url); } catch { return { queued: false };
  }
  let preparedUrl;
  let submittedUrl;
  try {
    preparedUrl = new URL(context.applicationUrl);
    submittedUrl = new URL(context.trustedSubmitUrl ?? context.applicationUrl);
  } catch { return { queued: false }; }
  const confirmationRoute = /(?:thank|success|confirm|complete|received)/i.test(senderUrl.pathname);
  const sameApplicationRoute = senderUrl.origin === context.origin && senderUrl.pathname === preparedUrl.pathname && senderUrl.hash === preparedUrl.hash;
  const newConfirmationRoute = confirmationRoute && senderUrl.origin === submittedUrl.origin
    && (senderUrl.pathname !== submittedUrl.pathname || senderUrl.hash !== submittedUrl.hash);
  const confirmationMatch = normalizedConfirmation(application.confirmationMatch);
  const freshConfirmation = hasStrongConfirmation(confirmationMatch) && confirmationMatch !== context.confirmationBaseline;
  if (senderUrl.origin !== context.origin
    || (!sameApplicationRoute && !confirmationRoute)
    || (!freshConfirmation && !newConfirmationRoute)
    || application.applicationUrl !== context.applicationUrl
    || application.preparedAt !== context.preparedAt
    || application.company !== context.company
    || application.title !== context.title
    || application.trustedSubmitted !== true
    || context.trustedSubmitted !== true
    || !hasStrongConfirmation(application.confirmationText)
    || !hasStrongConfirmation(confirmationMatch)) {
    return { queued: false };
  }
  context.triggered = true;
  await setWatchContext(tabId, context);
  await removeWatchContext(tabId);
  const pending = {
    localId: crypto.randomUUID(),
    accountId: context.accountId,
    company: context.company,
    title: context.title,
    applicationUrl: context.applicationUrl,
    location: context.location || undefined,
    confirmedSubmitted: true,
  };
  const updated = await mutateHelperState((state) => {
    if (!state.accountId || !state.scoutOrigin || state.accountId !== context.accountId) {
      state.lastConfirmation = {
        company: context.company,
        title: context.title,
        applicationUrl: context.applicationUrl,
        detectedAt: Date.now(),
        requiresManualLog: true,
      };
      if (state.preparedApplication?.applicationUrl === context.applicationUrl) state.preparedApplication = null;
      return { result: { pending: false, manual: true } };
    }
    state.pendingApplications = state.pendingApplications ?? [];
    if (!state.pendingApplications.some((item) => item.applicationUrl === pending.applicationUrl && item.accountId === pending.accountId)) {
      state.pendingApplications = [...state.pendingApplications, pending].slice(-100);
    }
    state.lastConfirmation = {
      company: pending.company,
      title: pending.title,
      applicationUrl: pending.applicationUrl,
      detectedAt: Date.now(),
      requiresManualLog: false,
    };
    if (state.preparedApplication?.applicationUrl === context.applicationUrl) state.preparedApplication = null;
    return { result: { pending: true } };
  });
  if (updated.result?.manual) {
    setBadge("");
    return { queued: false, requiresManualLog: true };
  }
  const savedState = updated.state;
  const queued = savedState.pendingApplications.find((item) => item.applicationUrl === pending.applicationUrl && item.accountId === pending.accountId);
  if (queued) await attemptLogPending(queued, savedState);
  return { queued: true };
}

async function retryPendingForScoutTab(tab) {
  if (!tab?.url) return;
  let origin;
  try { origin = new URL(tab.url).origin; } catch { return; }
  const state = await getHelperState();
  if (!state.scoutOrigin || origin !== state.scoutOrigin || !state.pendingApplications?.length) return;
  for (const pending of [...state.pendingApplications]) {
    if (pending.accountId !== state.accountId) continue;
    await attemptLogPending(pending, state);
  }
}

async function attemptLogPending(pending, state) {
  const origin = state.scoutOrigin;
  if (!origin || !state.accountId || pending.accountId !== state.accountId) return false;
  const pattern = `${origin}/*`;
  if (!await chrome.permissions.contains({ origins: [pattern] })) return false;
  const tabs = await chrome.tabs.query({});
  const scoutTab = tabs.find((tab) => {
    try { return new URL(tab.url ?? "").origin === origin; } catch { return false; }
  });
  if (!scoutTab?.id) {
    await setBadge(String(state.pendingApplications?.length ?? 1));
    return false;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: scoutTab.id },
      world: "MAIN",
      func: async (expectedOrigin, expectedAccountId, application) => {
        const fail = (code) => ({ ok: false, code });
        if (location.origin !== expectedOrigin) return fail("WRONG_ORIGIN");
        try {
          const sessionResponse = await fetch(`${expectedOrigin}/api/auth/session`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
          const session = await sessionResponse.json();
          if (!sessionResponse.ok || session?.authenticated !== true || session?.user?.emailVerified !== true || typeof session.user.id !== "string") return fail("NO_VERIFIED_SESSION");
          const profileResponse = await fetch(`${expectedOrigin}/api/browser-helper/profile`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
          const profile = await profileResponse.json();
          if (!profileResponse.ok || profile?.contract !== "scout.browser-helper.v1") return fail("PROFILE_API_ERROR");
          const accountId = typeof profile.accountId === "string" ? profile.accountId : session.user.id;
          if (accountId !== expectedAccountId || accountId !== session.user.id) return { ok: false, code: "ACCOUNT_MISMATCH", accountId };
          const csrfToken = typeof profile.csrfToken === "string" ? profile.csrfToken : session.csrfToken;
          if (!csrfToken) return fail("CSRF_MISSING");
          const response = await fetch(`${expectedOrigin}/api/browser-helper/applications`, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "X-Scout-Account-Id": expectedAccountId },
            body: JSON.stringify({
              company: application.company,
              title: application.title,
              applicationUrl: application.applicationUrl,
              location: application.location,
              confirmedSubmitted: true,
            }),
          });
          let result = {};
          try { result = await response.json(); } catch { result = {}; }
          if (!response.ok) return { ok: false, code: response.status === 409 ? "ACCOUNT_MISMATCH" : "LOG_ERROR", message: result.error || result.message };
          return { ok: true, accountId, listingKey: result.listingKey ?? null };
        } catch {
          return fail("NETWORK_ERROR");
        }
      },
      args: [origin, state.accountId, pending],
    });
    const result = results[0]?.result;
    if (result?.ok) {
      const latest = await mutateHelperState((current) => {
        if (current.accountId !== pending.accountId) return { result: { accountChanged: true } };
        current.pendingApplications = (current.pendingApplications ?? []).filter((item) => item.localId !== pending.localId);
        current.lastLoggedApplication = {
          company: pending.company,
          title: pending.title,
          applicationUrl: pending.applicationUrl,
          loggedAt: Date.now(),
        };
        return {};
      });
      if (latest.result?.accountChanged) return false;
      await setBadge(latest.state.pendingApplications.length ? String(latest.state.pendingApplications.length) : "");
      return true;
    }
    if (result?.code === "NO_VERIFIED_SESSION" || result?.code === "ACCOUNT_MISMATCH") {
      const latest = await mutateHelperState((current) => {
        if (current.accountId !== pending.accountId) return { result: { accountChanged: true } };
        const origin = current.scoutOrigin;
        Object.assign(current, defaultHelperState(), { scoutOrigin: origin });
        return { result: { accountChangedFrom: pending.accountId } };
      });
      if (latest.result?.accountChangedFrom) await clearWatchContextsForAccount(latest.result.accountChangedFrom);
      await setBadge("");
      return false;
    }
  } catch {
    // The confirmation stays queued. A later Scout tab load or explicit Sync retries it.
  }
  await setBadge(String((await getHelperState()).pendingApplications?.length ?? 1));
  return false;
}

function emptyProfile() {
  return { firstName: "", lastName: "", preferredFirstName: "", preferredLastName: "", email: "", phone: "", phoneType: "", phoneCountryCode: "", phoneExtension: "", address: "", city: "", region: "", postalCode: "", country: "", linkedin: "", github: "", portfolio: "", workAuthorization: "", requiresSponsorship: "", previousWorker: null, hasPreferredName: null, education: [], experience: [], referralSources: [] };
}

async function getHelperState() {
  const stored = await chrome.storage.local.get(HELPER_STATE_KEY);
  return stored[HELPER_STATE_KEY] ?? {};
}

async function mutateHelperState(mutator) {
  const operation = stateMutationQueue.then(async () => {
    const current = await getHelperState();
    const result = await mutator(current) ?? {};
    if (result.replacement) Object.assign(current, result.replacement);
    await chrome.storage.local.set({ [HELPER_STATE_KEY]: current });
    return { state: current, result };
  });
  stateMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function defaultHelperState() {
  return {
    version: 1,
    scoutOrigin: "",
    accountId: null,
    profile: emptyProfile(),
    profileDirty: false,
    documents: { resume: null, coverLetter: null },
    answers: [],
    pendingAnswerUpserts: [],
    deletedAnswers: [],
    pendingApplications: [],
    lastSyncedRemote: null,
    syncConflict: false,
    syncConflictBaseline: null,
    preparedApplication: null,
    lastConfirmation: null,
    lastLoggedApplication: null,
  };
}

async function setBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: text ? "#a83d30" : "#15201a" });
  await chrome.action.setBadgeText({ text: text.length > 3 ? "99+" : text });
}

async function getWatchContexts() {
  const stored = await chrome.storage.session.get(WATCH_CONTEXTS_KEY);
  return stored[WATCH_CONTEXTS_KEY] ?? {};
}

async function setWatchContext(tabId, context) {
  const contexts = await getWatchContexts();
  contexts[String(tabId)] = context;
  await chrome.storage.session.set({ [WATCH_CONTEXTS_KEY]: contexts });
}

async function removeWatchContext(tabId) {
  const contexts = await getWatchContexts();
  if (!(String(tabId) in contexts)) return;
  delete contexts[String(tabId)];
  await chrome.storage.session.set({ [WATCH_CONTEXTS_KEY]: contexts });
}

async function clearWatchContextsForAccount(accountId) {
  const contexts = await getWatchContexts();
  for (const [tabId, context] of Object.entries(contexts)) {
    if (context.accountId === accountId) delete contexts[tabId];
  }
  await chrome.storage.session.set({ [WATCH_CONTEXTS_KEY]: contexts });
}
