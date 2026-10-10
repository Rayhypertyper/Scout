/* global FileReader, HTMLInputElement, chrome, crypto, document, fetch, location, navigator, setTimeout, structuredClone, TextEncoder, URL */
const STORAGE_KEY = "scoutApplicationHelper";
const ANSWER_CONTRACT = globalThis.ScoutAnswerContract;
const PROFILE_CONTRACT = globalThis.ScoutProfileContract;
const APPLICATION_CONTEXT = globalThis.ScoutApplicationContext;
const PERSONAL_PROFILE_PRESET = globalThis.ScoutPersonalProfilePreset;
const MERCER_ANSWER_DRAFTS = globalThis.ScoutMercerAnswerDrafts;
const WORKDAY_ANSWER_DRAFTS = globalThis.ScoutWorkdayAnswerDrafts;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_STATE_BYTES = 8.5 * 1024 * 1024;
const MAX_PROFILE_STORAGE_BYTES = 64 * 1024;
const MAX_ANSWER_QUESTION = 1_000;
const MAX_ANSWER_TEXT = 2_000;
const EMPTY_PROFILE = PROFILE_CONTRACT.EMPTY_PROFILE;
const normalizeProfile = PROFILE_CONTRACT.normalizeProfile;

const elements = {
  profileForm: document.querySelector("#profile-form"),
  profileSaveState: document.querySelector("#profile-save-state"),
  educationList: document.querySelector("#education-list"),
  experienceList: document.querySelector("#experience-list"),
  languagesList: document.querySelector("#languages-list"),
  websitesList: document.querySelector("#websites-list"),
  educationCount: document.querySelector("#education-count"),
  experienceCount: document.querySelector("#experience-count"),
  languagesCount: document.querySelector("#languages-count"),
  websitesCount: document.querySelector("#websites-count"),
  addEducation: document.querySelector("#add-education"),
  addExperience: document.querySelector("#add-experience"),
  addLanguage: document.querySelector("#add-language"),
  addWebsite: document.querySelector("#add-website"),
  connectionToggle: document.querySelector("#connection-toggle"),
  connectionPanel: document.querySelector("#connection-panel"),
  connectionStatus: document.querySelector("#connection-status"),
  scoutOrigin: document.querySelector("#scout-origin"),
  connectScout: document.querySelector("#connect-scout"),
  openScout: document.querySelector("#open-scout"),
  disconnectScout: document.querySelector("#disconnect-scout"),
  syncNow: document.querySelector("#sync-now"),
  resumeFile: document.querySelector("#resume-file"),
  coverLetterFile: document.querySelector("#cover-letter-file"),
  removeResume: document.querySelector("#remove-resume"),
  removeCoverLetter: document.querySelector("#remove-cover-letter"),
  documentStatus: document.querySelector("#document-status"),
  checkPage: document.querySelector("#check-page"),
  pageStatus: document.querySelector("#page-status"),
  fillReport: document.querySelector("#fill-report"),
  unknownAnswers: document.querySelector("#unknown-answers"),
  unknownList: document.querySelector("#unknown-list"),
  savedAnswersSection: document.querySelector("#saved-answers-section"),
  savedAnswerList: document.querySelector("#saved-answer-list"),
  answerDraftsSection: document.querySelector("#answer-drafts-section"),
  answerDraftList: document.querySelector("#answer-draft-list"),
  saveAnswerDrafts: document.querySelector("#save-answer-drafts"),
  autofill: document.querySelector("#autofill"),
  workdaySessionInfo: document.querySelector("#workday-session-info"),
  workdaySessionNote: document.querySelector("#workday-session-note"),
  workdayWrittenDrafts: document.querySelector("#workday-written-drafts"),
  stopWorkdaySession: document.querySelector("#stop-workday-session"),
  copyProfile: document.querySelector("#copy-profile"),
  applicationCountry: document.querySelector("#application-country"),
  writtenAnswerDrafting: document.querySelector("#written-answer-drafting"),
  applicationCompany: document.querySelector("#application-company"),
  applicationTitle: document.querySelector("#application-title"),
  applicationLocation: document.querySelector("#application-location"),
  submissionDetection: document.querySelector("#submission-detection"),
  confirmSubmitted: document.querySelector("#confirm-submitted"),
  pendingStatus: document.querySelector("#pending-status"),
  feedback: document.querySelector("#feedback"),
};

let state = defaultState();
let currentScan = null;
let busy = false;

function defaultState() {
  return {
    version: 1,
    scoutOrigin: "",
    accountId: null,
    profile: structuredClone(EMPTY_PROFILE),
    profileDirty: false,
    personalPresetApplied: false,
    personalPresetVersion: 2,
    personalPresetBaseline: null,
    personalPresetRemoteApplied: false,
    answerDraftsApplied: false,
    workdayAnswerDraftsVersion: 1,
    answerDrafts: [],
    writtenAnswerDraftingEnabled: true,
    applicationCountry: "",
    applicationCountryApplicationUrl: "",
    applicationCountryReviewed: false,
    applicationCountryEvidence: [],
    jobDescriptionContext: null,
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

async function initialize() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chromium builds may not expose setAccessLevel. The extension still
    // keeps its profile inside the trusted popup and never reads it in ATS code.
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = normalizeState(stored[STORAGE_KEY]);
  let initialStateChanged = false;
  if (!state.personalPresetApplied) {
    // Apply starter values only on a truly fresh install. A saved/remote profile
    // may intentionally contain empty arrays or cleared fields.
    const freshInstall = !stored[STORAGE_KEY];
    if (freshInstall) {
      state.profile = applyPersonalProfilePreset(state.profile);
      if (state.profile.experienceCount == null) state.profile.experienceCount = 1;
      state.personalPresetBaseline = structuredClone(state.profile);
    }
    state.personalPresetApplied = true;
    state.personalPresetVersion = 2;
    initialStateChanged = true;
  }
  if (state.personalPresetVersion < 2) {
    const untouchedLegacyBaseline = !state.profileDirty && !state.personalPresetRemoteApplied
      && state.personalPresetBaseline && profilesEqual(state.profile, state.personalPresetBaseline);
    if (untouchedLegacyBaseline) {
      state.profile = applyPersonalProfilePreset(state.profile);
      state.personalPresetBaseline = structuredClone(state.profile);
    }
    if (state.profile.experienceCount == null && untouchedLegacyBaseline) {
      state.profile.experienceCount = 1;
      if (state.personalPresetBaseline) {
        state.personalPresetBaseline = { ...state.personalPresetBaseline, experienceCount: 1 };
      }
    }
    state.personalPresetVersion = 2;
    initialStateChanged = true;
  }
  if (!state.answerDraftsApplied) {
    state.answerDrafts = initialAnswerDrafts();
    state.answerDraftsApplied = true;
    state.workdayAnswerDraftsVersion = 1;
    initialStateChanged = true;
  } else if (state.workdayAnswerDraftsVersion < 1) {
    state.answerDrafts = mergeWorkdayAnswerDrafts(state.answerDrafts);
    state.workdayAnswerDraftsVersion = 1;
    initialStateChanged = true;
  }
  if (initialStateChanged) await saveState();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    const incoming = normalizeState(changes[STORAGE_KEY].newValue);
    if (incoming.accountId !== state.accountId || incoming.scoutOrigin !== state.scoutOrigin) {
      const accountChanged = incoming.accountId !== state.accountId;
      state = incoming;
      if (accountChanged) {
        state.applicationCountry = "";
        state.applicationCountryApplicationUrl = "";
        state.applicationCountryReviewed = false;
        state.applicationCountryEvidence = [];
        state.jobDescriptionContext = null;
        void saveState();
      }
      renderAll();
      if (accountChanged) showFeedback("The connected Scout account changed. Local profile data was refreshed before it can be used.", "error");
      return;
    }
    const previousPrepared = state.preparedApplication;
    const preparedChanged = previousPrepared && (incoming.preparedApplication?.tabId !== previousPrepared.tabId
      || incoming.preparedApplication?.applicationUrl !== previousPrepared.applicationUrl
      || incoming.preparedApplication?.preparedAt !== previousPrepared.preparedAt);
    state.pendingApplications = incoming.pendingApplications;
    state.lastConfirmation = incoming.lastConfirmation;
    state.lastLoggedApplication = incoming.lastLoggedApplication;
    state.preparedApplication = incoming.preparedApplication;
    renderPendingApplications();
    if (preparedChanged) {
      elements.applicationCompany.value = "";
      elements.applicationTitle.value = "";
      elements.applicationLocation.value = "";
      const logged = incoming.lastLoggedApplication?.applicationUrl === previousPrepared.applicationUrl;
      const confirmed = incoming.lastConfirmation?.applicationUrl === previousPrepared.applicationUrl;
      if (incoming.preparedApplication) {
        void restorePreparedApplication();
      } else if (logged) {
        elements.submissionDetection.textContent = `Submission logged for ${incoming.lastLoggedApplication.company} — ${incoming.lastLoggedApplication.title}. Original URL: ${incoming.lastLoggedApplication.applicationUrl}`;
      } else if (confirmed) {
        elements.submissionDetection.textContent = `Submission confirmation recorded for ${incoming.lastConfirmation.company} — ${incoming.lastConfirmation.title}. Original URL: ${incoming.lastConfirmation.applicationUrl}`;
      } else {
        elements.submissionDetection.textContent = "Prepared application context cleared after this tab changed pages. Review the current company and role before logging.";
      }
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "scout.workdayStepResult" && Number.isInteger(message.tabId)) {
      if (currentScan?.tabId === message.tabId && message.report?.ats === "Workday") {
        const sameWorkdayJob = typeof currentScan.jobKey === "string"
          && currentScan.jobKey === message.report.jobKey;
        const writtenDrafts = sameWorkdayJob || currentScan.applicationUrl === message.report.applicationUrl
          ? currentScan.writtenDrafts ?? [] : [];
        currentScan = { ...message.report, tabId: message.tabId, writtenDrafts };
        renderPageReport(currentScan);
      }
    }
    if (message?.type === "scout.workdaySessionState" && currentScan?.tabId === message.tabId) {
      if (!message.active) {
        if (currentScan) currentScan.sessionActive = false;
        renderPageReport(currentScan ?? {});
      }
    }
    if (message?.type === "scout.workdayWrittenDraftStatus" && currentScan?.tabId === message.tabId
      && message.applicationUrl === currentScan.applicationUrl && typeof message.question === "string") {
      const drafts = Array.isArray(currentScan.writtenDrafts) ? [...currentScan.writtenDrafts] : [];
      const index = drafts.findIndex((item) => item?.question === message.question && item?.applicationUrl === message.applicationUrl);
      const next = { ...message };
      if (index >= 0) drafts[index] = { ...drafts[index], ...next };
      else drafts.push(next);
      currentScan.writtenDrafts = drafts;
      renderWrittenDraftPreviews(drafts);
      if (message.status === "manual" && message.message) showFeedback(message.message, "error");
    }
  });
  bindEvents();
  renderAll();
  await restorePreparedApplication();
  await restoreWorkdaySession();
}

function normalizeState(value) {
  if (!value || value.version !== 1) return defaultState();
  const applicationCountryApplicationUrl = typeof value.applicationCountryApplicationUrl === "string"
    ? value.applicationCountryApplicationUrl.slice(0, 4_096) : "";
  const applicationCountry = ["Canada", "United States"].includes(value.applicationCountry) ? value.applicationCountry : "";
  const legacyReviewedCountry = applicationCountryBindingKey(applicationCountryApplicationUrl)
    && ["Canada", "United States"].includes(applicationCountry);
  return {
    ...defaultState(),
    ...value,
    personalPresetVersion: Number.isInteger(value.personalPresetVersion) ? value.personalPresetVersion : 0,
    workdayAnswerDraftsVersion: Number.isInteger(value.workdayAnswerDraftsVersion) ? value.workdayAnswerDraftsVersion : 0,
    applicationCountry,
    applicationCountryApplicationUrl,
    applicationCountryReviewed: typeof value.applicationCountryReviewed === "boolean"
      ? value.applicationCountryReviewed : Boolean(legacyReviewedCountry),
    applicationCountryEvidence: normalizeJobCountryEvidence(value.applicationCountryEvidence),
    writtenAnswerDraftingEnabled: value.writtenAnswerDraftingEnabled !== false,
    jobDescriptionContext: normalizeJobDescriptionContext(value.jobDescriptionContext),
    profile: normalizeProfile(value.profile),
    personalPresetApplied: value.personalPresetApplied === true,
    personalPresetRemoteApplied: value.personalPresetRemoteApplied === true || Boolean(value.lastSyncedRemote),
    answerDraftsApplied: value.answerDraftsApplied === true,
    answerDrafts: Array.isArray(value.answerDrafts)
      ? value.answerDrafts.map(normalizeAnswerDraft).filter(Boolean).slice(0, 100)
      : [],
    personalPresetBaseline: value.personalPresetBaseline && typeof value.personalPresetBaseline === "object"
      ? normalizeProfile(value.personalPresetBaseline) : null,
    documents: {
      resume: validStoredDocument(value.documents?.resume) ? value.documents.resume : null,
      coverLetter: validStoredDocument(value.documents?.coverLetter) ? value.documents.coverLetter : null,
    },
    answers: Array.isArray(value.answers) ? value.answers.map(ANSWER_CONTRACT.normalizeAnswer).filter(Boolean).slice(-200) : [],
    pendingAnswerUpserts: Array.isArray(value.pendingAnswerUpserts) ? value.pendingAnswerUpserts.map(ANSWER_CONTRACT.normalizeAnswer).filter(Boolean).slice(-200) : [],
    deletedAnswers: Array.isArray(value.deletedAnswers) ? value.deletedAnswers.filter((id) => typeof id === "string").slice(-200) : [],
    pendingApplications: Array.isArray(value.pendingApplications) ? value.pendingApplications.filter(isValidPendingApplication).slice(-100) : [],
    lastSyncedRemote: normalizeRemoteSnapshot(value.lastSyncedRemote),
    syncConflict: value.syncConflict === true,
    syncConflictBaseline: normalizeRemoteSnapshot(value.syncConflictBaseline),
    preparedApplication: isValidPreparedApplication(value.preparedApplication) ? value.preparedApplication : null,
  };
}

function normalizeAnswerDraft(value) {
  if (typeof value?.draftId === "string" && value.draftId.startsWith("semtech-")) {
    return WORKDAY_ANSWER_DRAFTS?.normalize(value) ?? null;
  }
  return MERCER_ANSWER_DRAFTS.normalize(value);
}

function normalizeJobDescriptionContext(value) {
  if (!value || typeof value !== "object" || typeof value.jobKey !== "string"
    || typeof value.description !== "string" || !value.description.trim()) return null;
  return {
    jobKey: value.jobKey.slice(0, 2_000),
    description: value.description.trim().slice(0, 20_000),
    postingUrl: typeof value.postingUrl === "string" ? value.postingUrl.slice(0, 4_096) : "",
  };
}

function normalizeJobCountryEvidence(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(items.filter((item) => typeof item === "string")
    .map((item) => item.trim().slice(0, 500)).filter(Boolean))].slice(0, 8);
}

function mergeWorkdayAnswerDrafts(existingDrafts = []) {
  const normalized = existingDrafts.map(normalizeAnswerDraft).filter(Boolean);
  const ids = new Set(normalized.map((draft) => draft.draftId));
  const additions = (WORKDAY_ANSWER_DRAFTS?.create?.() ?? [])
    .map((draft) => WORKDAY_ANSWER_DRAFTS.normalize(draft))
    .filter((draft) => draft && !ids.has(draft.draftId));
  return [...normalized, ...additions].slice(0, 100);
}

function initialAnswerDrafts() {
  return [...MERCER_ANSWER_DRAFTS.create(), ...(WORKDAY_ANSWER_DRAFTS?.create?.() ?? [])]
    .map(normalizeAnswerDraft).filter(Boolean).slice(0, 100);
}

function isValidPreparedApplication(value) {
  return value && Number.isInteger(value.tabId) && typeof value.applicationUrl === "string"
    && typeof value.company === "string" && typeof value.title === "string"
    && Number.isFinite(value.preparedAt);
}

function normalizeRemoteSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  return {
    profile: normalizeProfile(value.profile),
    answers: Array.isArray(value.answers) ? value.answers.map(ANSWER_CONTRACT.normalizeAnswer).filter(Boolean).slice(-200) : [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    profileSaved: typeof value.profileSaved === "boolean" ? value.profileSaved : null,
  };
}

function applyPersonalProfilePreset(profileValue) {
  return normalizeProfile(PERSONAL_PROFILE_PRESET.merge(normalizeProfile(profileValue)));
}

function profilesEqual(leftValue, rightValue) {
  return PERSONAL_PROFILE_PRESET.equal(normalizeProfile(leftValue), normalizeProfile(rightValue));
}

function hasProfileData(value) {
  return Object.values(normalizeProfile(value)).some((item) => Array.isArray(item)
    ? item.some((entry) => typeof entry === "string"
      ? Boolean(entry.trim())
      : Object.values(entry ?? {}).some((field) => String(field ?? "").trim() !== ""))
    : typeof item === "boolean" ? true : Boolean(String(item ?? "").trim()));
}

function isValidAnswer(value) {
  return ANSWER_CONTRACT.isValidAnswer(value);
}

function validStoredDocument(value) {
  return value && typeof value.name === "string" && typeof value.type === "string" && typeof value.base64 === "string"
    && Number.isFinite(value.size) && value.size > 0 && value.size <= MAX_DOCUMENT_BYTES;
}

function isValidPendingApplication(value) {
  return value && typeof value.applicationUrl === "string" && value.applicationUrl.length <= 4_096
    && value.confirmedSubmitted === true && typeof value.localId === "string";
}

function bindEvents() {
  elements.profileForm.addEventListener("submit", onSaveProfile);
  elements.addEducation.addEventListener("click", () => addProfileRow("education"));
  elements.addExperience.addEventListener("click", () => addProfileRow("experience"));
  elements.addLanguage.addEventListener("click", () => addProfileRow("languages"));
  elements.addWebsite.addEventListener("click", () => addProfileRow("websites"));
  for (const [kind, input] of [
    ["education", elements.educationCount],
    ["languages", elements.languagesCount],
    ["websites", elements.websitesCount],
  ]) {
    input.addEventListener("input", () => onProfileRowCountInput(kind, input));
    input.addEventListener("change", () => setProfileRowCount(kind, input.value));
  }
  elements.experienceCount.addEventListener("input", () => {
    if (isWholeNumberInput(elements.experienceCount.value)) onExperienceCountChange({ quiet: true });
  });
  elements.experienceCount.addEventListener("change", onExperienceCountChange);
  elements.educationList.addEventListener("click", onRemoveProfileRow);
  elements.experienceList.addEventListener("click", onRemoveProfileRow);
  elements.languagesList.addEventListener("click", onRemoveProfileRow);
  elements.websitesList.addEventListener("click", onRemoveProfileRow);
  elements.languagesList.addEventListener("click", onClearTriState);
  elements.experienceList.addEventListener("click", onClearTriState);
  elements.connectionToggle.addEventListener("click", () => {
    elements.connectionPanel.hidden = !elements.connectionPanel.hidden;
    if (!elements.connectionPanel.hidden) elements.scoutOrigin.focus();
  });
  elements.connectScout.addEventListener("click", onConnectScout);
  elements.openScout.addEventListener("click", onOpenScout);
  elements.disconnectScout.addEventListener("click", onDisconnectScout);
  elements.syncNow.addEventListener("click", () => syncWithScout({ requestPermission: true }));
  elements.resumeFile.addEventListener("change", (event) => onChooseDocument(event, "resume"));
  elements.coverLetterFile.addEventListener("change", (event) => onChooseDocument(event, "coverLetter"));
  elements.removeResume.addEventListener("click", () => removeDocument("resume"));
  elements.removeCoverLetter.addEventListener("click", () => removeDocument("coverLetter"));
  elements.saveAnswerDrafts.addEventListener("click", saveReviewedAnswerDrafts);
  elements.checkPage.addEventListener("click", onCheckPage);
  elements.autofill.addEventListener("click", onAutofill);
  elements.stopWorkdaySession.addEventListener("click", onStopWorkdaySession);
  elements.copyProfile.addEventListener("click", onCopyProfile);
  elements.applicationCountry.addEventListener("change", onApplicationCountryChange);
  elements.writtenAnswerDrafting.addEventListener("change", () => {
    state.writtenAnswerDraftingEnabled = elements.writtenAnswerDrafting.checked;
    void saveState().then((saved) => {
      if (saved) {
        if (currentScan) renderUnknownQuestions(currentScan.unknownQuestions ?? []);
        showFeedback(state.writtenAnswerDraftingEnabled
          ? "Luna will draft eligible blank professional responses when you start autofill."
          : "Luna written-answer drafts are off. You can still enter a reviewed answer yourself.", "success");
      }
    });
  });
  elements.confirmSubmitted.addEventListener("click", onConfirmSubmitted);
}

function workdayApplicationKey(urlValue) {
  try {
    const url = new URL(urlValue);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const prefix = APPLICATION_CONTEXT.workdayJobPrefix(url.pathname);
    if (prefix) return `${url.origin}${prefix}`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function applicationCountryBindingKey(urlValue) {
  return ANSWER_CONTRACT.workdayJobKey(urlValue) || workdayApplicationKey(urlValue);
}

function applicationCountryBindingForUrl(urlValue, reportEvidence) {
  const currentKey = applicationCountryBindingKey(urlValue);
  const boundKey = applicationCountryBindingKey(state.applicationCountryApplicationUrl);
  const workdayJobKey = ANSWER_CONTRACT.workdayJobKey(urlValue);
  const sameJob = Boolean(currentKey && boundKey === currentKey);
  const newEvidence = normalizeJobCountryEvidence(reportEvidence);
  const evidence = newEvidence.length
    ? newEvidence
    : sameJob && workdayJobKey ? normalizeJobCountryEvidence(state.applicationCountryEvidence) : [];
  const validCountry = ["Canada", "United States"].includes(state.applicationCountry);
  const reviewedBeforeBinding = !state.applicationCountryApplicationUrl
    && state.applicationCountryReviewed === true && validCountry;
  if ((sameJob && state.applicationCountryReviewed === true) || reviewedBeforeBinding) {
    return {
      applicationCountry: validCountry ? state.applicationCountry : "",
      applicationCountryReviewed: true,
      jobCountryEvidence: evidence,
    };
  }
  return {
    applicationCountry: workdayJobKey ? ANSWER_CONTRACT.inferWorkdayJobCountry(urlValue, evidence) : "",
    applicationCountryReviewed: false,
    jobCountryEvidence: evidence,
  };
}

function applicationCountryForUrl(urlValue, reportEvidence) {
  return applicationCountryBindingForUrl(urlValue, reportEvidence).applicationCountry;
}

function workdayLocaleForReport(report) {
  const observed = typeof report?.locale === "string" ? report.locale.trim() : "";
  if (observed) return observed.slice(0, 32);
  try {
    const firstPathSegment = new URL(report?.applicationUrl).pathname.split("/").filter(Boolean)[0] ?? "";
    return /^[a-z]{2,3}-[A-Z]{2}$/.test(firstPathSegment) ? firstPathSegment : "";
  } catch {
    return "";
  }
}

function bindApplicationCountry(urlValue, reportEvidence = []) {
  const nextKey = applicationCountryBindingKey(urlValue);
  if (!nextKey) return;
  const previousKey = applicationCountryBindingKey(state.applicationCountryApplicationUrl);
  const sameJob = previousKey === nextKey;
  const workdayJobKey = ANSWER_CONTRACT.workdayJobKey(urlValue);
  const suppliedEvidence = normalizeJobCountryEvidence(reportEvidence);
  const evidence = suppliedEvidence.length
    ? suppliedEvidence
    : sameJob && workdayJobKey ? normalizeJobCountryEvidence(state.applicationCountryEvidence) : [];
  const reviewedBeforeBinding = !state.applicationCountryApplicationUrl
    && state.applicationCountryReviewed === true
    && ["Canada", "United States"].includes(state.applicationCountry);
  const keepReviewedValue = sameJob && state.applicationCountryReviewed === true || reviewedBeforeBinding;
  const country = keepReviewedValue
    ? state.applicationCountry
    : workdayJobKey ? ANSWER_CONTRACT.inferWorkdayJobCountry(urlValue, evidence) : "";
  const reviewed = Boolean(keepReviewedValue);
  const changed = state.applicationCountry !== country
    || state.applicationCountryApplicationUrl !== urlValue
    || state.applicationCountryReviewed !== reviewed
    || JSON.stringify(state.applicationCountryEvidence) !== JSON.stringify(evidence);
  state.applicationCountry = country;
  state.applicationCountryApplicationUrl = String(urlValue).slice(0, 4_096);
  state.applicationCountryReviewed = reviewed;
  state.applicationCountryEvidence = evidence;
  elements.applicationCountry.value = country;
  if (currentScan?.applicationUrl && applicationCountryBindingKey(currentScan.applicationUrl) === nextKey) {
    currentScan.applicationCountry = country;
    currentScan.applicationCountryReviewed = reviewed;
    currentScan.jobCountryEvidence = evidence;
  }
  return changed;
}

async function onApplicationCountryChange() {
  const country = ["Canada", "United States"].includes(elements.applicationCountry.value)
    ? elements.applicationCountry.value : "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeJobKey = applicationCountryBindingKey(tab?.url ?? "");
  const scanJobKey = applicationCountryBindingKey(currentScan?.applicationUrl ?? "");
  const jobUrl = activeJobKey ? tab.url : !tab?.url && currentScan?.applicationUrl ? currentScan.applicationUrl : "";
  state.applicationCountry = country;
  state.applicationCountryReviewed = true;
  if (jobUrl) {
    const jobKey = applicationCountryBindingKey(jobUrl);
    const workdayJobKey = ANSWER_CONTRACT.workdayJobKey(jobUrl);
    const sameJob = applicationCountryBindingKey(state.applicationCountryApplicationUrl) === jobKey;
    const scanEvidence = workdayJobKey && ANSWER_CONTRACT.workdayJobKey(currentScan?.applicationUrl ?? "") === workdayJobKey
      ? currentScan?.jobCountryEvidence : [];
    const priorEvidence = sameJob ? state.applicationCountryEvidence : [];
    state.applicationCountryEvidence = normalizeJobCountryEvidence(
      Array.isArray(scanEvidence) && scanEvidence.length ? scanEvidence : priorEvidence,
    );
    state.applicationCountryApplicationUrl = String(jobUrl).slice(0, 4_096);
    if (currentScan?.applicationUrl && scanJobKey === jobKey) {
      currentScan.applicationCountry = country;
      currentScan.applicationCountryReviewed = true;
    }
  } else {
    state.applicationCountryApplicationUrl = "";
    state.applicationCountryEvidence = [];
  }
  if (!await saveState()) return;
  showFeedback(state.applicationCountry
      ? `Job country set to ${state.applicationCountry}. Your profile address stays separate.`
      : "Job country cleared for this application. Country-scoped answers will stay blank.", "success");
}

function renderAll() {
  renderProfile();
  elements.applicationCountry.value = state.applicationCountry;
  elements.writtenAnswerDrafting.checked = state.writtenAnswerDraftingEnabled;
  elements.scoutOrigin.value = state.scoutOrigin;
  elements.disconnectScout.hidden = !state.accountId;
  elements.connectionToggle.textContent = elements.connectionPanel.hidden ? (state.scoutOrigin ? "Settings" : "Set up") : "Hide";
  elements.connectionStatus.textContent = state.syncConflict
    ? "Scout has newer data. Sync again to confirm replacing it with your saved local edits."
    : state.accountId
    ? `Connected to Scout account ${state.accountId.slice(0, 8)}…`
    : state.scoutOrigin ? "Scout address saved. Connect to sync this profile." : "Profile stays in this browser until you connect.";
  elements.syncNow.textContent = state.syncConflict ? "Confirm local sync" : "Sync with Scout";
  renderDocuments();
  renderAnswerDrafts();
  renderSavedAnswers();
  renderPendingApplications();
}

function renderProfile() {
  const profile = normalizeProfile(state.profile);
  for (const [key, value] of Object.entries(profile)) {
    if (["education", "experience", "languages", "websites", "referralSources"].includes(key)) continue;
    const input = elements.profileForm.elements.namedItem(key);
    if (input) input.value = ["previousWorker", "hasPreferredName"].includes(key)
      ? value === null ? "" : String(value)
      : key === "experienceCount" ? String(value ?? 1)
      : value;
  }
  const referralInput = elements.profileForm.elements.namedItem("referralSources");
  if (referralInput) referralInput.value = profile.referralSources.join("\n");
  renderRepeatable("education", profile.education);
  renderRepeatable("experience", experienceRowsForEditor(profile));
  renderRepeatable("languages", profile.languages);
  renderRepeatable("websites", profile.websites);
}

function experienceRowsForEditor(profile) {
  const count = Number.isInteger(profile.experienceCount) ? profile.experienceCount : 1;
  const rows = profile.experience.slice(0, count);
  while (rows.length < count) rows.push(emptyProfileRow("experience"));
  return rows;
}

function renderRepeatable(kind, entries) {
  const lists = {
    education: elements.educationList,
    experience: elements.experienceList,
    languages: elements.languagesList,
    websites: elements.websitesList,
  };
  const counts = {
    education: elements.educationCount,
    experience: elements.experienceCount,
    languages: elements.languagesCount,
    websites: elements.websitesCount,
  };
  const list = lists[kind];
  counts[kind].value = String(entries.length);
  list.replaceChildren();
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "repeatable-entry";
    row.dataset.kind = kind;
    const heading = document.createElement("div");
    heading.className = "entry-heading";
    const title = document.createElement("span");
    title.textContent = `${profileKindLabel(kind)} ${index + 1}`;
    heading.append(title);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-entry";
    remove.dataset.remove = String(index);
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${profileKindLabel(kind).toLowerCase()} ${index + 1}`);
    heading.append(remove);
    row.append(heading);
    const grid = document.createElement("div");
    grid.className = "field-grid two-columns";
    let detailField = null;
    if (kind === "education") {
      appendProfileTextField(grid, kind, index, entry, "school", "School", { required: false });
      appendProfileTextField(grid, kind, index, entry, "degree", "Degree");
      appendProfileTextField(grid, kind, index, entry, "fieldOfStudy", "Field of study");
      appendProfileTextField(grid, kind, index, entry, "startDate", "Start date", { month: true });
      appendProfileTextField(grid, kind, index, entry, "endDate", "End date", { month: true });
      appendProfileTextField(grid, kind, index, entry, "gradeAverage", "Grade average / GPA");
    } else if (kind === "experience") {
      appendProfileTextField(grid, kind, index, entry, "title", "Role title");
      appendProfileTextField(grid, kind, index, entry, "company", "Company");
      appendProfileTextField(grid, kind, index, entry, "location", "Location");
      appendProfileTextField(grid, kind, index, entry, "startDate", "Start date", { month: true });
      appendProfileTextField(grid, kind, index, entry, "endDate", "End date", { month: true });
      appendProfileSelectField(grid, kind, index, entry, "currentlyWorkHere", "Currently work here", [
        ["", "Not reviewed"], ["true", "Yes"], ["false", "No"],
      ]);
      detailField = makeProfileTextArea(kind, index, entry, "description", "Description");
    } else if (kind === "languages") {
      appendProfileTextField(grid, kind, index, entry, "language", "Language");
      appendFluencyField(grid, index, entry);
      for (const [field, labelText] of [
        ["comprehension", "Comprehension"], ["overall", "Overall"], ["reading", "Reading"], ["speaking", "Speaking"], ["writing", "Writing"],
      ]) appendProfileSelectField(grid, kind, index, entry, field, labelText, LANGUAGE_PROFICIENCY_OPTIONS);
    } else if (kind === "websites") {
      appendProfileTextField(grid, kind, index, entry, "url", "Website URL", { type: "url", maxLength: 2_048 });
    }
    row.append(grid);
    if (detailField) row.append(detailField);
    list.append(row);
  });
}

const LANGUAGE_PROFICIENCY_OPTIONS = Object.freeze([
  ["", "Not reviewed"],
  ["1 - Beginner", "1 - Beginner"],
  ["2 - Classroom Study", "2 - Classroom Study"],
  ["3 - Intermediate", "3 - Intermediate"],
  ["4 - Advanced", "4 - Advanced"],
  ["5 - Fluent", "5 - Fluent"],
]);

function profileKindLabel(kind) {
  return ({ education: "Education", experience: "Experience", languages: "Language", websites: "Website" })[kind] ?? "Profile entry";
}

function appendProfileTextField(parent, kind, index, entry, field, labelText, options = {}) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  const originalValue = String(entry[field] ?? "");
  const monthField = options.month ? PROFILE_CONTRACT.monthInputField(originalValue) : null;
  input.type = monthField?.type ?? options.type ?? "text";
  input.dataset.profileKind = kind;
  input.dataset.profileIndex = String(index);
  input.dataset.profileField = field;
  input.autocomplete = "off";
  input.value = monthField?.value ?? originalValue;
  if (options.month) {
    input.setAttribute("aria-label", `${labelText} month and year`);
    input.placeholder = "YYYY-MM";
  }
  if (options.maxLength) input.maxLength = options.maxLength;
  label.append(input);
  parent.append(label);
}

function appendProfileSelectField(parent, kind, index, entry, field, labelText, options) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const select = document.createElement("select");
  select.dataset.profileKind = kind;
  select.dataset.profileIndex = String(index);
  select.dataset.profileField = field;
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  const current = String(entry[field] ?? "");
  if (current && !options.some(([value]) => value === current)) {
    const preserved = document.createElement("option");
    preserved.value = current;
    preserved.textContent = current;
    select.append(preserved);
  }
  select.value = current;
  label.append(select);
  parent.append(label);
}

function makeProfileTextArea(kind, index, entry, field, labelText) {
  const label = document.createElement("label");
  label.className = "full-row";
  label.textContent = labelText;
  const input = document.createElement("textarea");
  input.rows = 2;
  input.dataset.profileKind = kind;
  input.dataset.profileIndex = String(index);
  input.dataset.profileField = field;
  input.value = String(entry[field] ?? "");
  label.append(input);
  return label;
}

function appendFluencyField(parent, index, entry) {
  const wrapper = document.createElement("div");
  wrapper.className = "fluent-field";
  const label = document.createElement("label");
  label.className = "checkbox-label";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.profileKind = "languages";
  input.dataset.profileIndex = String(index);
  input.dataset.profileField = "fluent";
  input.setAttribute("aria-label", `Fluent in language ${index + 1}`);
  input.checked = entry.fluent === true;
  input.indeterminate = entry.fluent == null;
  label.append(input, document.createTextNode("Fluent"));
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "clear-choice";
  clear.dataset.clearField = "fluent";
  clear.textContent = "Not reviewed";
  clear.setAttribute("aria-label", `Clear fluency choice for language ${index + 1}`);
  wrapper.append(label, clear);
  parent.append(wrapper);
}

function emptyProfileRow(kind) {
  if (kind === "websites") return { url: "" };
  if (kind === "languages") return { language: "", fluent: null, comprehension: "", overall: "", reading: "", speaking: "", writing: "" };
  if (kind === "experience") return { company: "", title: "", location: "", startDate: "", endDate: "", description: "", currentlyWorkHere: false };
  return { school: "", degree: "", fieldOfStudy: "", startDate: "", endDate: "", gradeAverage: "" };
}

function addProfileRow(kind) {
  const profile = collectProfileFromForm();
  if (kind === "experience") {
    const nextCount = (Number.isInteger(profile.experienceCount) ? profile.experienceCount : 1) + 1;
    if (nextCount > 20) {
      showFeedback("Scout supports up to 20 Workday experience rows.", "error");
      return;
    }
    if (profile.experience.length < nextCount) profile.experience.push(emptyProfileRow("experience"));
    profile.experienceCount = nextCount;
    state.profile = normalizeProfile(profile);
    renderProfile();
    elements.experienceList.lastElementChild?.querySelector("input, select, textarea")?.focus();
    return;
  }
  setProfileRowCount(kind, profile[kind].length + 1);
  const list = ({ education: elements.educationList, experience: elements.experienceList, languages: elements.languagesList, websites: elements.websitesList })[kind];
  list?.lastElementChild?.querySelector("input, select, textarea")?.focus();
}

function hasProfileRowData(entry) {
  return Object.values(entry ?? {}).some((value) => value === true || value === false
    || (typeof value === "string" && value.trim() !== ""));
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isWholeNumberInput(value) {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function onProfileRowCountInput(kind, input) {
  if (!isWholeNumberInput(input.value)) return;
  setProfileRowCount(kind, input.value, { quiet: true });
}

function setProfileRowCount(kind, requestedValue, { quiet = false } = {}) {
  const countInputs = { education: elements.educationCount, experience: elements.experienceCount, languages: elements.languagesCount, websites: elements.websitesCount };
  const countInput = countInputs[kind];
  const currentProfile = collectProfileFromForm();
  const existing = currentProfile[kind];
  const rawValue = String(requestedValue ?? "").trim();
  const requested = Number(rawValue);
  const maximum = ({ education: 12, experience: 20, languages: 20 })[kind];
  if (!rawValue || !Number.isInteger(requested) || requested < 0 || (maximum != null && requested > maximum)) {
    if (!quiet) {
      countInput.value = String(existing.length);
      showFeedback(maximum == null ? "Enter a whole number of website rows." : `Scout stores up to ${maximum} ${kind} entries.`, "error");
    }
    return false;
  }
  if (requested < existing.length) {
    const removed = existing.slice(requested);
    if (removed.some(hasProfileRowData)) {
      countInput.value = String(existing.length);
      showFeedback("Remove populated rows individually so their saved details are not discarded.", "error");
      return false;
    }
  }
  if (kind === "websites" && requested > existing.length) {
    const profileWithoutWebsiteRows = { ...currentProfile, websites: [] };
    const baselineBytes = byteLength(profileWithoutWebsiteRows);
    const maximumRowsByStorage = Math.max(0, Math.floor((MAX_PROFILE_STORAGE_BYTES - baselineBytes + 1) / 11));
    if (requested > maximumRowsByStorage) {
      countInput.value = String(existing.length);
      showFeedback(`The 64 KB profile storage limit allows up to ${maximumRowsByStorage} website slots with these saved values.`, "error");
      return false;
    }
  }
  const nextRows = existing.slice(0, requested);
  while (nextRows.length < requested) nextRows.push(emptyProfileRow(kind));
  const nextProfile = { ...currentProfile, [kind]: nextRows };
  if (byteLength(nextProfile) > MAX_PROFILE_STORAGE_BYTES) {
    countInput.value = String(existing.length);
    showFeedback("This profile exceeds Scout’s 64 KB storage limit. Reduce the row count or shorten the saved values.", "error");
    return false;
  }
  state.profile = normalizeProfile(nextProfile);
  renderRepeatable(kind, state.profile[kind]);
  return true;
}

function onExperienceCountChange({ quiet = false } = {}) {
  const rawValue = String(elements.experienceCount.value ?? "").trim();
  const requested = Number(rawValue);
  if (!rawValue || !Number.isInteger(requested) || requested < 0 || requested > 20) {
    if (!quiet) {
      elements.experienceCount.value = String(state.profile.experienceCount ?? 1);
      showFeedback("Choose a whole-number Work experience count from 0 to 20.", "error");
    }
    return false;
  }
  const profile = collectProfileFromForm();
  profile.experienceCount = requested;
  state.profile = normalizeProfile(profile);
  renderRepeatable("experience", experienceRowsForEditor(state.profile));
  return true;
}

function applyPendingProfileRowCounts() {
  const counters = [
    ["education", elements.educationCount],
    ["experience", elements.experienceCount],
    ["languages", elements.languagesCount],
    ["websites", elements.websitesCount],
  ];
  for (const [kind, input] of counters) {
    if (!isWholeNumberInput(input.value)) {
      input.focus();
      showFeedback(`Enter a whole-number ${kind === "experience" ? "Work experience" : kind} count before saving.`, "error");
      return false;
    }
    const applied = kind === "experience"
      ? onExperienceCountChange()
      : setProfileRowCount(kind, input.value);
    if (!applied) {
      input.focus();
      return false;
    }
  }
  return true;
}

function onRemoveProfileRow(event) {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  const kind = button.closest(".repeatable-entry")?.dataset.kind;
  const index = Number(button.dataset.remove);
  if (!kind || !["education", "experience", "languages", "websites"].includes(kind) || !Number.isInteger(index)) return;
  const profile = collectProfileFromForm();
  if (kind === "experience") {
    profile.experience.splice(index, 1);
    profile.experienceCount = Math.max(0, (Number.isInteger(profile.experienceCount) ? profile.experienceCount : 1) - 1);
  } else {
    profile[kind].splice(index, 1);
  }
  state.profile = normalizeProfile(profile);
  if (kind === "experience") renderProfile();
  else renderRepeatable(kind, state.profile[kind]);
}

function onClearTriState(event) {
  const button = event.target.closest("[data-clear-field]");
  if (!button) return;
  const row = button.closest(".repeatable-entry");
  const field = row?.querySelector(`[data-profile-field="${button.dataset.clearField}"]`);
  if (field instanceof HTMLInputElement && field.type === "checkbox") {
    field.checked = false;
    field.indeterminate = true;
    field.focus();
  }
}

function collectProfileFromForm() {
  const profile = normalizeProfile(state.profile);
  for (const key of Object.keys(EMPTY_PROFILE)) {
    if (["education", "experience", "languages", "websites"].includes(key)) continue;
    if (key === "referralSources") {
      profile.referralSources = String(elements.profileForm.elements.namedItem(key)?.value ?? "")
        .split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 30).map((item) => item.slice(0, 500));
      continue;
    }
    const inputValue = String(elements.profileForm.elements.namedItem(key)?.value ?? "").trim();
    profile[key] = key === "experienceCount"
      ? inputValue === "" ? null : Number(inputValue)
      : ["previousWorker", "hasPreferredName"].includes(key)
        ? inputValue === "true" ? true : inputValue === "false" ? false : null
        : inputValue;
  }
  const entries = { education: [], experience: [], languages: [], websites: [] };
  for (const input of elements.profileForm.querySelectorAll("[data-profile-kind]")) {
    const kind = input.dataset.profileKind;
    const index = Number(input.dataset.profileIndex);
    const field = input.dataset.profileField;
    if (!entries[kind] || !Number.isInteger(index) || !field) continue;
    entries[kind][index] ??= {};
    entries[kind][index][field] = field === "fluent"
      ? input.indeterminate ? null : input.checked
      : field === "currentlyWorkHere"
        ? input.value === "true" ? true : input.value === "false" ? false : null
        : input.value.trim();
  }
  for (const kind of Object.keys(entries)) {
    if (kind === "websites") {
      profile[kind] = entries[kind].map((entry) => ({ url: String(entry?.url ?? "").trim().slice(0, 2_048) }));
    } else if (kind === "experience") {
      const visibleCount = elements.experienceList.children.length;
      const visibleRows = Array.from({ length: visibleCount }, (_, index) => entries[kind][index] ?? emptyProfileRow(kind));
      profile[kind] = [...visibleRows, ...profile.experience.slice(visibleCount)];
    } else {
      profile[kind] = entries[kind].filter(hasProfileRowData);
    }
  }
  return profile;
}

function profileValidationIssue(profile) {
  if (!Number.isInteger(profile.experienceCount) || profile.experienceCount < 0 || profile.experienceCount > 20) {
    return "Choose a whole-number Work experience count from 0 to 20.";
  }
  if (byteLength(profile) > MAX_PROFILE_STORAGE_BYTES) {
    return "This profile exceeds Scout’s 64 KB storage limit. Shorten saved details or remove unused rows before saving.";
  }
  for (const [index, website] of profile.websites.entries()) {
    const value = website.url.trim();
    if (!value) continue;
    if (value.length > 2_048) return `Website ${index + 1} must be 2,048 characters or fewer.`;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return `Website ${index + 1} must be an HTTP or HTTPS address without embedded credentials.`;
      }
    } catch {
      return `Enter a complete HTTP or HTTPS address for website ${index + 1}.`;
    }
  }
  return "";
}

async function onSaveProfile(event) {
  event.preventDefault();
  if (!applyPendingProfileRowCounts()) return;
  state.profile = collectProfileFromForm();
  const issue = profileValidationIssue(state.profile);
  if (issue) {
    showFeedback(issue, "error");
    return;
  }
  state.profileDirty = true;
  if (await saveState()) {
    elements.profileSaveState.textContent = "Saved locally";
    showFeedback("Profile saved in this browser. Sync with Scout to back it up to your account.", "success");
  }
}

async function saveState(nextState = state, operation = {}) {
  const serialized = JSON.stringify(nextState);
  const size = new TextEncoder().encode(serialized).length;
  if (size > MAX_STATE_BYTES) {
    showFeedback("Storage is nearly full. Remove a document or saved answer, then try again.", "error");
    return false;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "scout.saveHelperState", state: nextState, operation });
    if (!response?.saved) {
      if (response?.state) {
        state = normalizeState(response.state);
        renderAll();
      }
      showFeedback(response?.message || "The browser could not save this data. Reload the helper and try again.", "error");
      return false;
    }
    state = normalizeState(response.state);
    return true;
  } catch {
    showFeedback("The helper could not update its shared local profile. Reload the extension and try again.", "error");
    return false;
  }
}

function apiProfile(profile) {
  return normalizeProfile(profile);
}

function normalizedQuestion(value) {
  return ANSWER_CONTRACT.normalizeQuestion(value);
}

function mergeAnswers(remoteAnswers, localAnswers, deletedIds = []) {
  const deleted = new Set(deletedIds);
  const merged = new Map();
  for (const answer of remoteAnswers ?? []) {
    const normalized = ANSWER_CONTRACT.normalizeAnswer(answer);
    if (!normalized || deleted.has(normalized.id)) continue;
    merged.set(ANSWER_CONTRACT.answerIdentityKey(normalized), normalized);
  }
  for (const answer of localAnswers ?? []) {
    const normalized = ANSWER_CONTRACT.normalizeAnswer(answer);
    if (!normalized) continue;
    const key = ANSWER_CONTRACT.answerIdentityKey(normalized);
    const existing = merged.get(key);
    merged.set(key, { ...normalized, id: existing?.id ?? normalized.id });
  }
  return [...merged.values()];
}

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid Scout address."); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Enter only the Scout site address, without a path, login, or query string.");
  }
  const localHttp = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHttp)) {
    throw new Error("Scout must use HTTPS. HTTP is allowed only for localhost during local setup.");
  }
  return url.origin;
}

async function ensureScoutPermission(origin, request = false) {
  const pattern = `${origin}/*`;
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (granted) return true;
  if (!request) return false;
  const allowed = await chrome.permissions.request({ origins: [pattern] });
  if (!allowed) throw new Error("Scout account access was not granted.");
  return true;
}

async function findScoutTab(origin) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => {
    if (!tab.url) return false;
    try { return new URL(tab.url).origin === origin; } catch { return false; }
  }) ?? null;
}

async function openTemporaryScoutTab(origin) {
  const tab = await chrome.tabs.create({ url: `${origin}/jobs`, active: false });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const latest = await chrome.tabs.get(tab.id);
      if (latest.status === "complete" && latest.url && new URL(latest.url).origin === origin) return latest;
      if (latest.status === "complete" && latest.url && new URL(latest.url).origin !== origin) {
        throw new Error("Scout redirected to another site. Open Scout and sign in, then try again.");
      }
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      throw error;
    }
  }
  await chrome.tabs.remove(tab.id).catch(() => undefined);
  throw new Error("Scout did not finish loading. Open Scout in a tab and try again.");
}

async function runScoutBridge(origin, operation, payload = {}) {
  const { tab, temporary } = await getScoutTabForOperation(origin);
  try {
    const tabUrl = new URL(tab.url ?? "");
    if (tabUrl.origin !== origin) throw new Error("Open Scout at the configured address before syncing.");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (expectedOrigin, action, data) => {
        const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
        if (location.origin !== expectedOrigin) return fail("WRONG_ORIGIN", "The Scout page did not match the configured address.");
        const headers = { Accept: "application/json" };
        let sessionResponse;
        let session;
        try {
          sessionResponse = await fetch(`${expectedOrigin}/api/auth/session`, { credentials: "same-origin", cache: "no-store", headers });
          session = await sessionResponse.json();
        } catch {
          return fail("NETWORK_ERROR", "Scout could not be reached.");
        }
        const userId = typeof session?.user?.id === "string" ? session.user.id : "";
        if (!sessionResponse.ok || session?.authenticated !== true || !userId || session?.user?.emailVerified !== true) {
          return fail("NO_VERIFIED_SESSION", "Sign in to a verified Scout account to sync this profile.", { accountId: userId || null });
        }
        let profileResponse;
        let remote;
        try {
          profileResponse = await fetch(`${expectedOrigin}/api/browser-helper/profile`, { credentials: "same-origin", cache: "no-store", headers });
          remote = await profileResponse.json();
        } catch {
          return fail("NETWORK_ERROR", "Scout could not load your application profile.");
        }
        if (!profileResponse.ok || remote?.contract !== "scout.browser-helper.v1") {
          return fail("PROFILE_API_ERROR", remote?.message || "Scout could not load the browser helper profile.", { status: profileResponse.status });
        }
        const accountId = typeof remote.accountId === "string" ? remote.accountId : userId;
        if (accountId !== userId) return fail("ACCOUNT_MISMATCH", "The signed-in Scout account changed. Reconnect before using cached data.", { accountId: userId });
        const normalizeRemoteProfile = (profile) => {
          const source = profile && typeof profile === "object" ? profile : {};
          const fields = ["firstName", "lastName", "preferredFirstName", "preferredLastName", "email", "phone", "phoneType", "phoneCountryCode", "phoneExtension", "address", "city", "region", "postalCode", "country", "linkedin", "github", "portfolio", "workAuthorization", "requiresSponsorship"];
          const result = Object.fromEntries(fields.map((key) => [key, typeof source[key] === "string" ? source[key] : ""]));
          result.previousWorker = source.previousWorker === true || source.previousWorker === false ? source.previousWorker : null;
          result.hasPreferredName = source.hasPreferredName === true || source.hasPreferredName === false ? source.hasPreferredName : null;
          result.experienceCount = Number.isInteger(source.experienceCount) && source.experienceCount >= 0 && source.experienceCount <= 20
            ? source.experienceCount : null;
          const text = (value) => typeof value === "string" ? value : "";
          result.education = Array.isArray(source.education) ? source.education.slice(0, 12).map((item) => ({
            school: text(item?.school), degree: text(item?.degree), fieldOfStudy: text(item?.fieldOfStudy), startDate: text(item?.startDate), endDate: text(item?.endDate), gradeAverage: text(item?.gradeAverage),
          })) : [];
          result.experience = Array.isArray(source.experience) ? source.experience.slice(0, 20).map((item) => ({
            company: text(item?.company), title: text(item?.title), location: text(item?.location), startDate: text(item?.startDate), endDate: text(item?.endDate), description: text(item?.description),
            currentlyWorkHere: item?.currentlyWorkHere === true || item?.currentlyWorkHere === false ? item.currentlyWorkHere : null,
          })) : [];
          result.languages = Array.isArray(source.languages) ? source.languages.slice(0, 20).map((item) => ({
            language: text(item?.language),
            fluent: item?.fluent === true || item?.fluent === false ? item.fluent : null,
            comprehension: text(item?.comprehension),
            overall: text(item?.overall),
            reading: text(item?.reading),
            speaking: text(item?.speaking),
            writing: text(item?.writing),
          })) : [];
          result.websites = Array.isArray(source.websites)
            ? source.websites.filter((item) => item && typeof item === "object").map((item) => ({ url: text(item.url).slice(0, 2_048) }))
            : Array.from({ length: 4 }, () => ({ url: "" }));
          result.referralSources = Array.isArray(source.referralSources) ? source.referralSources.slice(0, 30).filter((item) => typeof item === "string").map((item) => item.slice(0, 500)) : [];
          return result;
        };
        const normalizeRemoteAnswer = (item) => {
          if (!item || typeof item.question !== "string" || typeof item.answer !== "string") return null;
          const type = item.answerType ?? "text";
          const answer = { ...(typeof item.id === "string" ? { id: item.id } : {}), question: item.question, answer: item.answer, answerType: type };
          if ((type === "single-choice" || type === "multi-choice") && Array.isArray(item.selectedChoices)) answer.selectedChoices = item.selectedChoices.slice();
          if (type === "boolean" && typeof item.booleanValue === "boolean") answer.booleanValue = item.booleanValue;
          if (item.scope && typeof item.scope === "object" && !Array.isArray(item.scope)) answer.scope = { ...item.scope };
          return answer;
        };
        const normalizeRemoteAnswers = (items) => Array.isArray(items) ? items.map(normalizeRemoteAnswer).filter(Boolean) : [];
        const remoteSnapshot = {
          profile: normalizeRemoteProfile(remote.profile),
          answers: normalizeRemoteAnswers(remote.answers),
          updatedAt: typeof remote.updatedAt === "string" ? remote.updatedAt : "",
          profileSaved: typeof remote.profileSaved === "boolean" ? remote.profileSaved : null,
        };
        const csrfToken = typeof remote.csrfToken === "string" ? remote.csrfToken : typeof session.csrfToken === "string" ? session.csrfToken : "";
        if ((action === "sync" || action === "logApplication") && data.accountId && data.accountId !== accountId) {
          return { ok: true, accountMismatch: true, accountId, profile: remote.profile, answers: remote.answers ?? [], updatedAt: remote.updatedAt, profileSaved: remoteSnapshot.profileSaved, remoteSnapshot };
        }
        if (action === "read") return { ok: true, accountId, profile: remote.profile, answers: remote.answers ?? [], updatedAt: remote.updatedAt, profileSaved: remoteSnapshot.profileSaved, remoteSnapshot };
        if (!csrfToken) return fail("CSRF_MISSING", "Scout did not provide a security token. Reload Scout and try again.");

        const sendMutation = async (path, body, method = "PUT") => {
          const response = await fetch(`${expectedOrigin}${path}`, {
            method,
            credentials: "same-origin",
            cache: "no-store",
            headers: { ...headers, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "X-Scout-Account-Id": accountId },
            body: JSON.stringify(body),
          });
          let result = {};
          try { result = await response.json(); } catch { /* Keep the empty result for non-JSON responses. */ }
          return { response, result };
        };

        if (action === "logApplication") {
          const application = data.application ?? {};
          if (application.confirmedSubmitted !== true || !application.company || !application.title || !application.applicationUrl) {
            return fail("INVALID_APPLICATION", "Confirm the submitted application and add its company, role, and page address first.");
          }
          const logged = await sendMutation("/api/browser-helper/applications", application, "POST");
          if (!logged.response.ok) return fail(logged.response.status === 409 ? "ACCOUNT_MISMATCH" : "LOG_ERROR", logged.result?.error || logged.result?.message || "Scout could not log this submission.", { accountId });
          return { ok: true, accountId, logged: true, listingKey: logged.result?.listingKey ?? null };
        }
        if (action !== "sync") return fail("UNKNOWN_ACTION", "That Scout operation is not supported.");
        try {
          const norm = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
          const scopeKey = (value) => {
            const scope = value && typeof value === "object" ? value : {};
            const key = {};
            if (typeof scope.origin === "string" && scope.origin) {
              try { key.origin = new URL(scope.origin).origin; } catch { key.origin = scope.origin; }
            }
            if (typeof scope.country === "string" && scope.country.trim()) key.country = norm(scope.country);
            if (typeof scope.locale === "string" && scope.locale.trim()) key.locale = norm(scope.locale);
            return JSON.stringify(key);
          };
          const answerKey = (value) => `${norm(value?.question)}\u0000${scopeKey(value?.scope)}`;
          const answerValueKey = (value) => JSON.stringify({
            type: value?.answerType ?? "text",
            answer: value?.answer ?? "",
            selectedChoices: value?.selectedChoices ?? null,
            booleanValue: value?.booleanValue ?? null,
            scope: scopeKey(value?.scope),
          });
          const answerBody = (value) => ({
            question: value.question,
            answer: value.answer,
            ...(value.answerType ? { answerType: value.answerType } : {}),
            ...(Array.isArray(value.selectedChoices) ? { selectedChoices: value.selectedChoices } : {}),
            ...(typeof value.booleanValue === "boolean" ? { booleanValue: value.booleanValue } : {}),
            ...(value.scope && Object.keys(value.scope).length ? { scope: value.scope } : {}),
          });
          const stable = (value) => {
            if (Array.isArray(value)) return value.map(stable);
            if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
            return value;
          };
          const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
          const hasProfileData = (profile) => Object.values(profile ?? {}).some((value) => Array.isArray(value)
            ? value.some((item) => Object.values(item ?? {}).some((field) => String(field ?? "").trim() !== ""))
            : String(value ?? "").trim() !== "");
          const baseline = data.lastSyncedRemote;
          const conflictingChanges = [];
          const orphanedAnswerIds = [];
          const baselineById = new Map((baseline?.answers ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
          const remoteById = new Map((remote.answers ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
          const remoteByQuestion = new Map((remoteSnapshot.answers ?? []).filter((item) => item?.question).map((item) => [answerKey(item), item]));
          if (data.profileDirty === true) {
            if (baseline && !same(remoteSnapshot.profile, baseline.profile)) conflictingChanges.push("profile");
            else if (!baseline && hasProfileData(remoteSnapshot.profile)) conflictingChanges.push("profile");
          }
          for (const answer of data.pendingAnswerUpserts ?? []) {
            if (!answer || typeof answer.question !== "string" || typeof answer.answer !== "string") continue;
            const remoteAnswer = answer.id ? remoteById.get(answer.id) : remoteByQuestion.get(answerKey(answer));
            const baseAnswer = answer.id ? baselineById.get(answer.id) : null;
            if (answer.id && !remoteAnswer) {
              orphanedAnswerIds.push(answer.id);
              continue;
            }
            if (remoteAnswer && baseAnswer && answerValueKey(remoteAnswer) !== answerValueKey(baseAnswer)) conflictingChanges.push(`answer:${answer.id}`);
            else if (remoteAnswer && !baseAnswer && answerValueKey(remoteAnswer) !== answerValueKey(answer)) conflictingChanges.push(`answer:${answerKey(answer)}`);
          }
          for (const id of data.deletedAnswers ?? []) {
            const current = remoteById.get(id);
            if (!current) continue;
            const baseAnswer = baselineById.get(id);
            if (baseAnswer && answerValueKey(current) !== answerValueKey(baseAnswer)) conflictingChanges.push(`answer:${id}`);
            else if (!baseAnswer) conflictingChanges.push(`answer:${id}`);
          }
          const hasConflict = conflictingChanges.length > 0 || orphanedAnswerIds.length > 0;
          const confirmedCurrentSnapshot = data.allowOverwrite === true && same(remoteSnapshot, data.syncConflictBaseline);
          if (hasConflict && (!confirmedCurrentSnapshot || orphanedAnswerIds.length > 0)) {
            const detail = orphanedAnswerIds.length
              ? "A saved answer was deleted in Scout. Forget it or save it again before syncing."
              : "Scout has newer profile or answer changes. Review them, then click Sync again to confirm replacing the conflicting values with your saved local edits.";
            return fail("SYNC_CONFLICT", detail, { remoteSnapshot, orphanedAnswerIds, accountId });
          }

          const remoteAnswerIds = new Set(remoteById.keys());
          for (const id of data.deletedAnswers ?? []) {
            if (typeof id !== "string" || !id || !remoteAnswerIds.has(id)) continue;
            const removed = await sendMutation("/api/browser-helper/answers", { id }, "DELETE");
            if (!removed.response.ok && removed.response.status !== 404) return fail(removed.response.status === 409 ? "ACCOUNT_MISMATCH" : "SYNC_ERROR", removed.result?.error || removed.result?.message || "Scout could not remove a saved answer.", { accountId });
          }
          if (data.profileDirty === true) {
            const profileUpdate = await sendMutation("/api/browser-helper/profile", { profile: data.profile });
            if (!profileUpdate.response.ok) return fail(profileUpdate.response.status === 409 ? "ACCOUNT_MISMATCH" : "SYNC_ERROR", profileUpdate.result?.error || profileUpdate.result?.message || "Scout could not save your profile.", { accountId });
          }
          const answers = new Map();
          for (const answer of remoteSnapshot.answers) {
            if (answer && typeof answer.question === "string" && typeof answer.answer === "string") answers.set(answerKey(answer), answer);
          }
          for (const answer of data.pendingAnswerUpserts ?? []) {
            if (!answer || typeof answer.question !== "string" || typeof answer.answer !== "string") continue;
            const key = answerKey(answer);
            const previous = answers.get(key);
            if (previous && answerValueKey(previous) === answerValueKey(answer)) continue;
            const saved = await sendMutation("/api/browser-helper/answers", answerBody(answer));
            if (!saved.response.ok) return fail(saved.response.status === 409 ? "ACCOUNT_MISMATCH" : "SYNC_ERROR", saved.result?.error || saved.result?.message || "Scout could not save an exact question answer.", { accountId });
            const normalizedSaved = normalizeRemoteAnswer(saved.result?.answer ?? { ...answer, id: undefined });
            if (normalizedSaved) answers.set(key, normalizedSaved);
          }
          const refreshedResponse = await fetch(`${expectedOrigin}/api/browser-helper/profile`, { credentials: "same-origin", cache: "no-store", headers });
          const refreshed = await refreshedResponse.json();
          if (!refreshedResponse.ok || refreshed?.contract !== "scout.browser-helper.v1") return fail("SYNC_ERROR", "Scout saved the profile but could not confirm the final sync.");
          const refreshedAccountId = typeof refreshed.accountId === "string" ? refreshed.accountId : userId;
          if (refreshedAccountId !== accountId) return fail("ACCOUNT_MISMATCH", "The signed-in Scout account changed during sync. Reconnect before using cached data.", { accountId: refreshedAccountId });
          return {
            ok: true,
            accountId,
            profile: refreshed.profile,
            answers: refreshed.answers ?? [],
            updatedAt: refreshed.updatedAt,
            profileSaved: typeof refreshed.profileSaved === "boolean" ? refreshed.profileSaved : null,
            remoteSnapshot: { profile: normalizeRemoteProfile(refreshed.profile), answers: normalizeRemoteAnswers(refreshed.answers), updatedAt: typeof refreshed.updatedAt === "string" ? refreshed.updatedAt : "", profileSaved: typeof refreshed.profileSaved === "boolean" ? refreshed.profileSaved : null },
          };
        } catch {
          return fail("NETWORK_ERROR", "Scout could not finish syncing. Try again when Scout is online.");
        }
      },
      args: [origin, operation, payload],
    });
    const result = results[0]?.result;
    if (!result || typeof result !== "object") throw new Error("Scout returned an empty response.");
    if (!result.ok) {
      const error = new Error(result.message || "Scout request failed.");
      error.code = result.code || "SCOUT_ERROR";
      error.accountId = result.accountId ?? null;
      error.remoteSnapshot = result.remoteSnapshot ?? null;
      throw error;
    }
    return result;
  } finally {
    if (temporary) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function getScoutTabForOperation(origin) {
  let tab = await findScoutTab(origin);
  if (tab) return { tab, temporary: false };
  tab = await openTemporaryScoutTab(origin);
  return { tab, temporary: true };
}

async function onConnectScout() {
  try {
    if (!applyPendingProfileRowCounts()) return;
    const origin = normalizeOrigin(elements.scoutOrigin.value);
    if (!await ensureScoutPermission(origin, true)) return;
    const changingOrigin = Boolean(state.scoutOrigin && state.scoutOrigin !== origin);
    if (changingOrigin) {
      const profile = collectProfileFromForm();
      state = defaultState();
      state.profile = profile;
      state.personalPresetApplied = true;
      state.personalPresetRemoteApplied = true;
      state.personalPresetBaseline = structuredClone(profile);
      state.profileDirty = hasProfileData(profile);
      state.answerDraftsApplied = true;
      state.answerDrafts = [];
    }
    state.scoutOrigin = origin;
    state.profile = collectProfileFromForm();
    state.profileDirty = state.profileDirty
      || (state.personalPresetBaseline ? !profilesEqual(state.profile, state.personalPresetBaseline) : hasProfileData(state.profile));
    if (!await saveState(state, { accountTransition: changingOrigin })) return;
    elements.scoutOrigin.value = origin;
    elements.connectionPanel.hidden = true;
    await syncWithScout({ requestPermission: false });
  } catch (error) {
    showFeedback(error.message, "error");
  }
}

async function onOpenScout() {
  try {
    const origin = normalizeOrigin(elements.scoutOrigin.value || state.scoutOrigin);
    state.scoutOrigin = origin;
    await saveState();
    await chrome.tabs.create({ url: `${origin}/jobs`, active: true });
  } catch (error) {
    showFeedback(error.message, "error");
  }
}

async function onDisconnectScout() {
  const origin = state.scoutOrigin;
  const cleared = defaultState();
  cleared.personalPresetApplied = true;
  cleared.personalPresetRemoteApplied = true;
  cleared.personalPresetBaseline = structuredClone(EMPTY_PROFILE);
  cleared.answerDraftsApplied = true;
  cleared.answerDrafts = [];
  state = cleared;
  if (!await saveState(state, { clearLocal: true })) return;
  if (origin) {
    try { await chrome.permissions.remove({ origins: [`${origin}/*`] }); } catch { /* Permission may already be absent. */ }
  }
  renderAll();
  elements.connectionPanel.hidden = true;
  showFeedback("Disconnected. Local profile, documents, answers, and pending logs were cleared.", "success");
}

async function syncWithScout({ requestPermission = false } = {}) {
  if (busy) return;
  if (!applyPendingProfileRowCounts()) return;
  setBusy(true);
  try {
    const origin = normalizeOrigin(elements.scoutOrigin.value || state.scoutOrigin);
    if (!await ensureScoutPermission(origin, requestPermission)) throw new Error("Grant access to the configured Scout address to sync.");
    state.scoutOrigin = origin;
    const localProfile = collectProfileFromForm();
    const profileIssue = profileValidationIssue(localProfile);
    if (profileIssue) throw new Error(profileIssue);
    if (state.personalPresetBaseline && !profilesEqual(localProfile, state.personalPresetBaseline)) state.profileDirty = true;
    if (state.profileDirty) state.profile = localProfile;
    const result = await runScoutBridge(origin, "sync", {
      accountId: state.accountId,
      profile: apiProfile(state.profile),
      profileDirty: state.profileDirty,
      pendingAnswerUpserts: state.pendingAnswerUpserts,
      deletedAnswers: state.deletedAnswers,
      lastSyncedRemote: state.lastSyncedRemote,
      allowOverwrite: state.syncConflict,
      syncConflictBaseline: state.syncConflictBaseline,
    });
    if (result.accountMismatch) {
      const next = defaultState();
      next.scoutOrigin = origin;
      next.accountId = result.accountId;
      next.profile = normalizeProfile(result.profile);
      next.personalPresetApplied = true;
      next.personalPresetRemoteApplied = true;
      next.profileDirty = false;
      next.personalPresetBaseline = structuredClone(next.profile);
      next.answerDraftsApplied = true;
      next.answerDrafts = [];
      next.answers = (result.answers ?? []).filter(isValidAnswer).slice(-200);
      next.lastSyncedRemote = normalizeRemoteSnapshot(result.remoteSnapshot ?? { profile: result.profile, answers: result.answers, updatedAt: result.updatedAt });
      state = next;
      if (!await saveState(state, { accountTransition: true })) return;
      renderAll();
      showFeedback("A different Scout account is signed in. The old account’s cached profile, files, answers, and pending logs were cleared; this account’s profile was loaded.", "success");
      return;
    }
    const accountTransition = state.accountId !== result.accountId;
    state.accountId = result.accountId;
    const hadLocalProfileDraft = state.profileDirty;
    const remoteProfile = normalizeProfile(result.profile);
    const remoteProfileSaved = typeof result.profileSaved === "boolean"
      ? result.profileSaved
      : typeof result.remoteSnapshot?.profileSaved === "boolean" ? result.remoteSnapshot.profileSaved : null;
    const stageRemoteStarter = PROFILE_CONTRACT.shouldStageRemoteStarter(remoteProfileSaved)
      && PERSONAL_PROFILE_PRESET.shouldStageRemote(state.personalPresetRemoteApplied, hadLocalProfileDraft);
    state.profile = hadLocalProfileDraft || !stageRemoteStarter ? remoteProfile : applyPersonalProfilePreset(remoteProfile);
    state.answers = mergeAnswers(result.answers, [], []);
    state.profileDirty = stageRemoteStarter && !profilesEqual(state.profile, remoteProfile);
    state.personalPresetApplied = true;
    state.personalPresetRemoteApplied = true;
    state.personalPresetBaseline = structuredClone(state.profile);
    state.pendingAnswerUpserts = [];
    state.deletedAnswers = [];
    state.lastSyncedRemote = normalizeRemoteSnapshot(result.remoteSnapshot ?? { profile: result.profile, answers: result.answers, updatedAt: result.updatedAt });
    state.syncConflict = false;
    state.syncConflictBaseline = null;
    if (!await saveState(state, { accountTransition })) return;
    renderAll();
    elements.connectionPanel.hidden = true;
    showFeedback(state.profileDirty
      ? "Scout profile loaded. Your editable personal starter values are staged locally; choose Sync with Scout when ready."
      : "Profile and saved answers synced with Scout.", "success");
    await flushPendingApplications();
  } catch (error) {
    if (error?.code === "ACCOUNT_MISMATCH" && !state.accountId && typeof error.accountId === "string") state.accountId = error.accountId;
    await handleScoutError(error);
    if (error?.code === "SYNC_CONFLICT") {
      if (typeof error.accountId === "string" && error.accountId) state.accountId = error.accountId;
      state.syncConflict = true;
      state.syncConflictBaseline = normalizeRemoteSnapshot(error.remoteSnapshot);
      if (!await saveState()) return;
      renderAll();
      showFeedback(error.message, "error");
      return;
    }
    showFeedback(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function handleScoutError(error) {
  if (["NO_VERIFIED_SESSION", "ACCOUNT_MISMATCH"].includes(error?.code) && state.accountId) {
    const origin = state.scoutOrigin;
    const expectedAccountId = state.accountId;
    state = defaultState();
    state.scoutOrigin = origin;
    state.personalPresetApplied = true;
    state.personalPresetRemoteApplied = true;
    state.answerDraftsApplied = true;
    state.answerDrafts = [];
    await saveState(state, { clearAccountBoundData: true, expectedAccountId });
    renderAll();
  }
}

async function validateBoundAccount() {
  if (!state.accountId || !state.scoutOrigin) return true;
  const origin = state.scoutOrigin;
  if (!await ensureScoutPermission(origin, false)) {
    showFeedback("Reconnect Scout before using this account-bound profile.", "error");
    return false;
  }
  try {
    const result = await runScoutBridge(origin, "read");
    if (result.accountId !== state.accountId) {
      const next = defaultState();
      next.scoutOrigin = origin;
      next.accountId = result.accountId;
      next.profile = normalizeProfile(result.profile);
      next.answers = (result.answers ?? []).filter(isValidAnswer).slice(-200);
      next.personalPresetApplied = true;
      next.personalPresetRemoteApplied = true;
      next.personalPresetBaseline = structuredClone(next.profile);
      next.answerDraftsApplied = true;
      next.answerDrafts = [];
      state = next;
      if (!await saveState(state, { accountTransition: true })) return false;
      renderAll();
      showFeedback("A different Scout account is active. Local files and pending logs were cleared; sync the active account before filling.", "error");
      return false;
    }
    return true;
  } catch (error) {
    if (error?.code === "NO_VERIFIED_SESSION") {
      await handleScoutError(error);
      showFeedback("Scout signed out. The account-bound cache was cleared before filling.", "error");
      return false;
    }
    if (error?.code === "NETWORK_ERROR") {
      showFeedback("Scout is offline. Using the account-bound local cache.", "success");
      return true;
    }
    showFeedback(error.message, "error");
    return false;
  }
}

async function injectAndCallActiveTab(action, payload = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("Open a job application in the active tab first.");
  const url = new URL(tab.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("This browser page cannot be inspected. Open the employer application page in a tab.");
  const countryBinding = applicationCountryBindingForUrl(tab.url);
  const effectivePayload = {
    ...payload,
    applicationCountry: countryBinding.applicationCountry,
    applicationCountryReviewed: countryBinding.applicationCountryReviewed,
  };
  if (countryBinding.jobCountryEvidence.length) effectivePayload.jobCountryEvidence = countryBinding.jobCountryEvidence;
  else delete effectivePayload.jobCountryEvidence;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["answer-contract.js", "ats.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (method, data) => {
      const helper = globalThis.ScoutFormHelper;
      if (!helper || typeof helper[method] !== "function") return { error: "Helper could not read this page." };
      return await helper[method](data);
    },
    args: [action, effectivePayload],
  });
  const report = results[0]?.result;
  if (!report || report.error) throw new Error(report?.error || "Scout could not read this application page.");
  return { tab, report };
}

async function onCheckPage() {
  if (busy) return;
  if (!applyPendingProfileRowCounts()) return;
  setBusy(true);
  try {
    const profile = collectProfileFromForm();
    const { tab, report } = await injectAndCallActiveTab("scan", { profile, answers: state.answers });
    if (report.ats === "Workday") {
      const session = await chrome.runtime.sendMessage({ type: "scout.getWorkdaySession", tabId: tab.id });
      report.sessionActive = session?.active === true;
      report.sessionExpiresAt = session?.expiresAt ?? null;
    }
    rememberCurrentPage(tab, report);
    renderPageReport(report);
    const checkedMessage = report.ats === "Workday"
      ? "Page checked. Starting a Workday session may replace preselected Country or Phone Country Code with an exact saved preference and remove extra Work Experience panels to match your saved count; other retained answers stay as they are."
      : "Page checked. Scout will only fill fields you left blank.";
    showFeedback(report.supported ? checkedMessage : "Manual review is available for this page.", report.supported ? "success" : "error");
  } catch (error) {
    showFeedback(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function onAutofill() {
  if (busy) return;
  if (!applyPendingProfileRowCounts()) return;
  setBusy(true);
  try {
    if (currentScan?.ats === "Workday") {
      const origin = new URL(currentScan.applicationUrl).origin;
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) throw new Error("Access to this exact Workday employer site was not granted.");
      if (!await validateBoundAccount()) return;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) throw new Error("The active Workday tab could not be found.");
      const profile = collectProfileFromForm();
      const { tab, report: currentReport } = await injectAndCallActiveTab("scan", { profile, answers: state.answers });
      if (currentReport.ats !== "Workday" || !currentReport.supported) {
        rememberCurrentPage(tab, currentReport);
        renderPageReport(currentReport);
        throw new Error(currentReport.manualReason || "Check the Workday application page before starting a session.");
      }
      rememberCurrentPage(tab, currentReport);
      const countryBinding = applicationCountryBindingForUrl(currentReport.applicationUrl, currentReport.jobCountryEvidence);
      const tracking = {
        company: elements.applicationCompany.value.trim().slice(0, 200),
        title: elements.applicationTitle.value.trim().slice(0, 300),
        location: elements.applicationLocation.value.trim().slice(0, 200),
        applicationCountry: applicationCountryForUrl(currentReport.applicationUrl, currentReport.jobCountryEvidence),
      };
      const matchingJobDescription = state.jobDescriptionContext?.jobKey === currentReport.jobKey
        ? state.jobDescriptionContext : null;
      const reportDescription = typeof currentReport.jobDescription === "string" ? currentReport.jobDescription.trim() : "";
      const jobDescription = String(reportDescription || matchingJobDescription?.description || "").slice(0, 20_000);
      const started = await chrome.runtime.sendMessage({
        type: "scout.startWorkdaySession",
        tabId: tab.id,
        applicationUrl: currentReport.applicationUrl,
        accountId: state.accountId,
        tracking,
        payload: {
          profile: apiProfile(profile), answers: state.answers, documents: state.documents,
          applicationCountry: tracking.applicationCountry,
          applicationCountryReviewed: countryBinding.applicationCountryReviewed,
          jobCountryEvidence: countryBinding.jobCountryEvidence,
          locale: workdayLocaleForReport(currentReport),
          autoDraftWrittenAnswers: state.writtenAnswerDraftingEnabled,
          jobKey: typeof currentReport.jobKey === "string" ? currentReport.jobKey : "",
          jobDescription,
          postingUrl: String(matchingJobDescription?.postingUrl ?? currentReport.postingUrl ?? "").slice(0, 4_096),
        },
      });
      if (!started?.started) throw new Error(started?.message || "Workday could not start its autofill session.");
      const activeWorkdaySession = await chrome.runtime.sendMessage({ type: "scout.getWorkdaySession", tabId: tab.id });
      const writtenDrafts = Array.isArray(activeWorkdaySession?.writtenDrafts)
        ? activeWorkdaySession.writtenDrafts
        : started.writtenDrafts ?? started.report.writtenDrafts ?? [];
      rememberCurrentPage(tab, {
        ...started.report,
        sessionActive: true,
        sessionExpiresAt: started.expiresAt,
        writtenDrafts,
      });
      renderPageReport(currentScan);
      const count = started.report.filled?.length ?? 0;
      const attachments = started.report.attachments?.length ?? 0;
      const appliedDraftCount = Array.isArray(writtenDrafts)
        ? writtenDrafts.filter((item) => item?.status === "applied" || item?.applied === true).length : 0;
      const pendingDraftCount = Array.isArray(writtenDrafts)
        ? writtenDrafts.filter((item) => item?.status === "generating").length : 0;
      const manualDraftCount = Array.isArray(writtenDrafts)
        ? writtenDrafts.filter((item) => item?.status === "manual").length : 0;
      const hasEligibleWrittenQuestions = currentReport.unknownQuestions?.some((item) => item.writtenDraftEligible);
      const writtenDraftStatus = appliedDraftCount
        ? ` Luna filled ${appliedDraftCount} professional written response${appliedDraftCount === 1 ? "" : "s"}; review or edit it on the application page before submitting.`
        : pendingDraftCount
          ? " Luna is preparing eligible professional responses from this same job posting; review any inserted text before submitting."
          : manualDraftCount
            ? " Some professional written responses remain blank for manual review."
            : state.writtenAnswerDraftingEnabled && hasEligibleWrittenQuestions
              ? " Luna is checking this same job posting for enough detail; fields without a usable description or evidence stay blank."
              : "";
      const trackerState = started.trackingReady
        ? `Submission log prepared for ${tracking.company} — ${tracking.title}.`
        : "The original application URL is saved for manual logging; add Company and Role title before confirming submission.";
      showFeedback(`Workday session started. Filled ${count} fields${attachments ? ` and attached ${attachments} document${attachments === 1 ? "" : "s"}` : ""}.${writtenDraftStatus} An exact saved Country or Phone Country Code preference may replace the site's preselected value, and extra Work Experience panels may be removed to match your saved count. Other retained answers stay as they are. ${trackerState} No step was advanced or submitted.`, "success");
      return;
    }
    if (!await validateBoundAccount()) return;
    const profile = collectProfileFromForm();
    const payload = {
      profile: apiProfile(profile),
      answers: state.answers,
      documents: state.documents,
    };
    const { tab, report } = await injectAndCallActiveTab("fill", payload);
    rememberCurrentPage(tab, report);
    renderPageReport(report);
    const details = [];
    if (report.filled?.length) details.push(`filled ${report.filled.length}`);
    if (report.attachments?.length) details.push(`attached ${report.attachments.length} document${report.attachments.length === 1 ? "" : "s"}`);
    if (report.leftExisting) details.push(`left ${report.leftExisting} existing answer${report.leftExisting === 1 ? "" : "s"} unchanged`);
    if (report.protectedSkipped) details.push(`skipped ${report.protectedSkipped} protected field${report.protectedSkipped === 1 ? "" : "s"}`);
    if (report.supported && elements.applicationCompany.value.trim() && elements.applicationTitle.value.trim()) {
      const context = {
        applicationUrl: report.applicationUrl,
        company: elements.applicationCompany.value.trim(),
        title: elements.applicationTitle.value.trim(),
        location: elements.applicationLocation.value.trim(),
        accountId: state.accountId,
        preparedAt: Date.now(),
        ats: report.ats,
      };
      try {
        const armed = await chrome.runtime.sendMessage({ type: "scout.armApplicationWatch", tabId: tab.id, context });
        if (armed?.armed) details.push("confirmation watch armed for 30 minutes");
        else details.push(armed?.message || "manual submission log available after you submit");
      } catch {
        details.push("manual submission log available after you submit");
      }
    } else if (report.supported) {
      details.push("enter company and role before filling to enable submission tracking");
    }
    showFeedback(report.supported ? `Scout ${details.length ? details.join("; ") : "left this form unchanged"}.` : report.manualReason, report.supported ? "success" : "error");
  } catch (error) {
    showFeedback(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function onStopWorkdaySession() {
  if (!currentScan?.tabId) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: "scout.stopWorkdaySession", tabId: currentScan.tabId });
    if (!result?.stopped) throw new Error(result?.message || "Workday session could not be stopped.");
    currentScan.sessionActive = false;
    renderPageReport(currentScan);
    showFeedback("Workday session stopped. Its temporary site permission was removed when no session still uses it.", "success");
  } catch (error) {
    showFeedback(error.message, "error");
  }
}

async function restoreWorkdaySession() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;
    const session = await chrome.runtime.sendMessage({ type: "scout.getWorkdaySession", tabId: tab.id });
    if (!session?.active) return;
    const { report } = await injectAndCallActiveTab("scan", { profile: state.profile, answers: state.answers });
    if (report.ats !== "Workday") return;
    currentScan = { ...report, tabId: tab.id, sessionActive: true, sessionExpiresAt: session.expiresAt, writtenDrafts: session.writtenDrafts ?? [] };
    bindApplicationCountry(report.applicationUrl, report.jobCountryEvidence);
    void saveState();
    renderPageReport(currentScan);
    elements.submissionDetection.textContent = "Workday fill session is active on this application. Review each step; Scout will not advance or submit it.";
  } catch {
    // A missing active tab does not affect the stored profile or the application session.
  }
}

function fillApplicationMetadata(report) {
  if (report.ats === "Workday") return;
  if (!elements.applicationCompany.value && report.company) elements.applicationCompany.value = report.company;
  if (!elements.applicationTitle.value && report.title) elements.applicationTitle.value = report.title;
  if (!elements.applicationLocation.value && report.location) elements.applicationLocation.value = report.location;
}

function rememberCurrentPage(tab, report) {
  const sameWorkdayApplication = currentScan?.ats === "Workday" && report.ats === "Workday"
    && (typeof currentScan.jobKey === "string" && typeof report.jobKey === "string" && currentScan.jobKey === report.jobKey
      || APPLICATION_CONTEXT.workdayJobPrefix(new URL(currentScan.applicationUrl).pathname)
        && APPLICATION_CONTEXT.workdayJobPrefix(new URL(report.applicationUrl).pathname)
          === APPLICATION_CONTEXT.workdayJobPrefix(new URL(currentScan.applicationUrl).pathname));
  const changed = currentScan && (currentScan.tabId !== tab.id
    || (!sameWorkdayApplication && currentScan.applicationUrl !== report.applicationUrl));
  if (changed) {
    elements.applicationCompany.value = "";
    elements.applicationTitle.value = "";
    elements.applicationLocation.value = "";
    state.jobDescriptionContext = null;
  }
  currentScan = { ...report, tabId: tab.id };
  bindApplicationCountry(report.applicationUrl, report.jobCountryEvidence);
  const jobDescriptionContext = normalizeJobDescriptionContext({
    jobKey: report.jobKey,
    description: report.jobDescription,
    postingUrl: report.postingUrl ?? report.applicationUrl,
  });
  if (jobDescriptionContext) state.jobDescriptionContext = jobDescriptionContext;
  else if (report.jobKey && state.jobDescriptionContext?.jobKey !== report.jobKey) state.jobDescriptionContext = null;
  void saveState();
  fillApplicationMetadata(report);
}

async function restorePreparedApplication() {
  const prepared = state.preparedApplication;
  if (!prepared || Date.now() - prepared.preparedAt > 30 * 60 * 1_000
    || (state.accountId && prepared.accountId !== state.accountId)) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== prepared.tabId || !tab.url) return;
    const recovered = APPLICATION_CONTEXT.preparedApplicationForManualLog(tab, prepared, state.accountId);
    if (!recovered) return;
    currentScan = { ...recovered, tabId: tab.id, supported: true };
    if (!elements.applicationCompany.value) elements.applicationCompany.value = prepared.company;
    if (!elements.applicationTitle.value) elements.applicationTitle.value = prepared.title;
    if (!elements.applicationLocation.value && prepared.location) elements.applicationLocation.value = prepared.location;
    elements.submissionDetection.textContent = `Prepared application: ${prepared.company} — ${prepared.title}. Manual log will use the original application URL: ${recovered.applicationUrl}`;
  } catch {
    // The popup remains usable with manual details if the active tab is unavailable.
  }
}

function renderPageReport(report) {
  elements.fillReport.replaceChildren();
  const lines = [];
  if (report.supported) lines.push({ text: `${report.ats} pattern found · ${report.visibleFieldCount} visible fields`, kind: "normal" });
  else lines.push({ text: report.manualReason || "Manual review required.", kind: "warning" });
  if (report.filled?.length) lines.push({ text: `${report.filled.length} blank field${report.filled.length === 1 ? "" : "s"} filled`, kind: "normal" });
  if (report.attachments?.length) lines.push({ text: `${report.attachments.length} document${report.attachments.length === 1 ? "" : "s"} attached`, kind: "normal" });
  if (report.leftExisting) lines.push({ text: `${report.leftExisting} existing field${report.leftExisting === 1 ? "" : "s"} left as they were`, kind: "normal" });
  if (report.protectedSkipped) lines.push({ text: `${report.protectedSkipped} protected field${report.protectedSkipped === 1 ? "" : "s"} skipped`, kind: "warning" });
  if (report.unknownQuestions?.length) lines.push({ text: `${report.unknownQuestions.length} question${report.unknownQuestions.length === 1 ? "" : "s"} left blank for review`, kind: "warning" });
  const draftableQuestions = (report.unknownQuestions ?? []).some((item) => item?.writtenDraftEligible === true);
  const matchingJobDescription = state.jobDescriptionContext?.jobKey === report.jobKey
    || (typeof report.jobDescription === "string" && report.jobDescription.trim().length > 0);
  if (draftableQuestions && state.writtenAnswerDraftingEnabled && !matchingJobDescription) {
    lines.push({ text: "Luna will check this job’s public posting for a usable description. If none is available, professional written responses stay blank for manual review.", kind: "warning" });
  }
  for (const warning of report.sectionWarnings ?? []) {
    if (warning && typeof warning.message === "string" && warning.message.trim()) {
      const row = Number.isInteger(warning.rowIndex) ? ` ${warning.rowIndex + 1}` : "";
      lines.push({ text: `${warning.section || "Profile section"}${row}: ${warning.message}`, kind: "warning" });
    }
  }
  if (report.iframeWarning) lines.push({ text: report.iframeWarning, kind: "warning" });
  if (report.companyCandidate && report.company) lines.push({ text: `Company “${report.company}” came from the ATS URL. Review it before logging.`, kind: "warning" });
  for (const line of lines) {
    const item = document.createElement("li");
    item.dataset.kind = line.kind;
    item.textContent = line.text;
    elements.fillReport.append(item);
  }
  elements.pageStatus.textContent = report.supported ? "Supported page checked. Unknown answers remain blank." : "Manual copy is available; Scout did not change this page.";
  const workday = report.ats === "Workday";
  elements.workdaySessionInfo.hidden = !workday;
  renderWrittenDraftPreviews(workday ? report.writtenDrafts ?? [] : []);
  elements.stopWorkdaySession.hidden = !workday || !report.sessionActive;
  elements.autofill.textContent = workday ? (report.sessionActive ? "Update Workday session" : "Start Workday session") : "Fill blank fields";
  if (workday && report.sessionActive) {
    elements.workdaySessionNote.textContent = `Session active until ${new Date(report.sessionExpiresAt).toLocaleTimeString()}. It fills blank fields on this application only. At Start, an exact saved Country or Phone Country Code preference may replace the site's preselected value, and extra Work Experience panels may be removed to match your saved row count. Other existing answers and later edits are left alone.`;
  } else if (workday) {
    elements.workdaySessionNote.textContent = "Starting a Workday session asks for access to this exact employer site. It may replace the site's preselected Country or Phone Country Code with an exact saved preference, and may remove extra Work Experience panels to match your saved row count. Other existing answers stay as they are.";
  }
  elements.unknownAnswers.hidden = !(report.unknownQuestions?.length);
  renderUnknownQuestions(report.unknownQuestions ?? []);
  elements.submissionDetection.textContent = report.confirmationDetected
    ? "A possible submission confirmation is visible. Review the details below before logging."
    : "No clear confirmation text was found. You can still record it after you submit yourself.";
}

function renderWrittenDraftPreviews(drafts) {
  elements.workdayWrittenDrafts.replaceChildren();
  const validDrafts = Array.isArray(drafts) ? drafts.filter((item) => item && typeof item.question === "string") : [];
  elements.workdayWrittenDrafts.hidden = validDrafts.length === 0;
  for (const item of validDrafts) {
    const row = document.createElement("section");
    row.className = "written-draft-preview";
    const heading = document.createElement("h3");
    heading.textContent = item.question;
    const status = document.createElement("p");
    status.className = "field-help";
    status.textContent = item.status === "applied"
      ? "Luna draft inserted into this blank response. Review or edit it on the application page before continuing."
      : item.status === "generating"
        ? "Luna is preparing a response from your reviewed professional profile and this checked job description."
        : item.message || "This written response remains blank for manual review.";
    row.append(heading, status);
    if (typeof item.draft === "string" && item.draft) {
      const sourceLabels = Array.isArray(item.sources)
        ? item.sources.map((source) => typeof source?.label === "string" ? source.label : "").filter(Boolean)
        : [];
      if (item.model || sourceLabels.length) {
        const sourceNote = document.createElement("p");
        sourceNote.className = "field-help";
        sourceNote.textContent = [item.model ? `Model: ${item.model}` : "", sourceLabels.length ? `Sources: ${sourceLabels.join(", ")}` : ""]
          .filter(Boolean).join(" · ");
        row.append(sourceNote);
      }
      const label = document.createElement("label");
      label.textContent = "Editable written-response preview";
      const editor = document.createElement("textarea");
      editor.maxLength = Number.isInteger(item.maxLength) && item.maxLength > 0 ? Math.min(item.maxLength, MAX_ANSWER_TEXT) : MAX_ANSWER_TEXT;
      editor.value = item.draft;
      editor.addEventListener("input", () => { item.editedDraft = editor.value; });
      label.append(editor);
      row.append(label);
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "button button-quiet";
      apply.textContent = "Apply edited draft";
      const sameApplication = currentScan?.applicationUrl === item.applicationUrl;
      apply.disabled = !currentScan?.sessionActive || !sameApplication || typeof item.requestId !== "string";
      apply.addEventListener("click", () => applyEditedWrittenDraft(item, editor.value, apply));
      row.append(apply);
    }
    elements.workdayWrittenDrafts.append(row);
  }
}

async function applyEditedWrittenDraft(item, draft, button) {
  const applicationUrl = currentScan?.applicationUrl;
  if (!currentScan?.sessionActive || !currentScan.tabId || !applicationUrl || applicationUrl !== item.applicationUrl) {
    showFeedback("This draft belongs to a different or inactive application. Check the current page again.", "error");
    return;
  }
  const text = String(draft ?? "").trim();
  if (!text) {
    showFeedback("Enter a reviewed written response before applying it.", "error");
    return;
  }
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "scout.applyWrittenDraft",
      tabId: currentScan.tabId,
      accountId: state.accountId,
      requestId: item.requestId,
      question: item.question,
      applicationUrl,
      jobKey: item.jobKey,
      draft: text,
    });
    if (!result?.applied) throw new Error(result?.message || result?.reason || "The response was not applied to this application field.");
    item.draft = text;
    item.editedDraft = text;
    item.status = "applied";
    renderWrittenDraftPreviews(currentScan.writtenDrafts ?? []);
    showFeedback("Edited written response applied to the same blank question. Scout did not advance or submit the form.", "success");
  } catch (error) {
    showFeedback(error.message, "error");
    button.disabled = false;
  }
}

function renderUnknownQuestions(questions) {
  elements.unknownList.replaceChildren();
  for (const item of questions) {
    const row = document.createElement("div");
    row.className = "unknown-item";
    const question = document.createElement("p");
    question.className = "unknown-question";
    question.textContent = item.question;
    let readAnswer;
    const options = Array.isArray(item.choices) ? item.choices : [];
    if (options.length) {
      const multi = item.kind === "checkbox" || item.kind === "multi-select";
      const choiceEditor = document.createElement("div");
      choiceEditor.className = "answer-choice-list";
      choiceEditor.setAttribute("role", "group");
      choiceEditor.setAttribute("aria-label", item.question);
      if (multi) {
        const inputs = [];
        for (const choice of options) {
          const label = document.createElement("label");
          label.className = "answer-choice";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = choice.label;
          inputs.push(input);
          input.addEventListener("change", () => { if (input.checked) noSelection.checked = false; });
          label.append(input, document.createTextNode(choice.label));
          choiceEditor.append(label);
        }
        const noneLabel = document.createElement("label");
        noneLabel.className = "answer-choice explicit-none";
        const noSelection = document.createElement("input");
        noSelection.type = "checkbox";
        noSelection.addEventListener("change", () => {
          if (noSelection.checked) for (const input of inputs) input.checked = false;
        });
        noneLabel.append(noSelection, document.createTextNode("Save with no options selected"));
        choiceEditor.append(noneLabel);
        readAnswer = () => {
          const selectedChoices = inputs.filter((input) => input.checked).map((input) => input.value);
          if (!selectedChoices.length && !noSelection.checked) return null;
          return { answer: "", answerType: "multi-choice", selectedChoices };
        };
      } else {
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Choose an exact option for ${item.question}`);
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose an exact option";
        select.append(placeholder);
        for (const choice of options) {
          const option = document.createElement("option");
          option.value = choice.label;
          option.textContent = choice.label;
          select.append(option);
        }
        choiceEditor.append(select);
        readAnswer = () => {
          if (!select.value) return null;
          const booleans = options.map((choice) => booleanChoiceValue(choice.label) ?? booleanChoiceValue(choice.value));
          if (booleans.includes(true) && booleans.includes(false) && booleans.every((value) => value !== null)) {
            return { answer: "", answerType: "boolean", booleanValue: booleanChoiceValue(select.value) };
          }
          return { answer: "", answerType: "single-choice", selectedChoices: [select.value] };
        };
      }
      row.append(question, choiceEditor);
    } else {
      const textarea = document.createElement("textarea");
      textarea.maxLength = MAX_ANSWER_TEXT;
      textarea.placeholder = "Leave blank unless you have reviewed this answer";
      textarea.setAttribute("aria-label", `Answer to ${item.question}`);
      row.append(question, textarea);
      readAnswer = () => textarea.value.trim() ? { answer: textarea.value.trim(), answerType: "text" } : null;
    }
    const scopeEditor = createAnswerScopeEditor(item);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "button button-quiet";
    save.textContent = item.kind === "checkbox" || item.kind === "multi-select" ? "Save reviewed choices" : "Save exact answer";
    save.addEventListener("click", () => {
      const answer = readAnswer();
      if (!answer) {
        showFeedback("Choose an exact option, explicitly save no selections, or enter a reviewed answer.", "error");
        return;
      }
      saveAnswerRecord({ question: item.question, ...answer, scope: scopeEditor.read() });
    });
    row.append(scopeEditor.details, save);
    elements.unknownList.append(row);
  }
}

function booleanChoiceValue(value) {
  const key = normalizedQuestion(value);
  if (["yes", "y", "true"].includes(key)) return true;
  if (["no", "n", "false"].includes(key)) return false;
  return null;
}

function createAnswerScopeEditor(item) {
  const details = document.createElement("details");
  details.className = "answer-scope-editor";
  const summary = document.createElement("summary");
  summary.textContent = "Limit where this answer is reused (optional)";
  const siteLabel = document.createElement("label");
  siteLabel.className = "answer-choice";
  const site = document.createElement("input");
  site.type = "checkbox";
  const origin = String(item.scopeContext?.origin ?? "");
  siteLabel.append(site, document.createTextNode(origin ? `Only on ${origin}` : "Only on this site"));
  const countryLabel = document.createElement("label");
  countryLabel.textContent = "Country scope (optional; type it explicitly)";
  const country = document.createElement("input");
  country.type = "text";
  country.maxLength = 100;
  country.autocomplete = "off";
  countryLabel.append(country);
  const localeLabel = document.createElement("label");
  localeLabel.textContent = "Locale scope (optional; type it explicitly)";
  const locale = document.createElement("input");
  locale.type = "text";
  locale.maxLength = 32;
  locale.autocomplete = "off";
  localeLabel.append(locale);
  details.append(summary, siteLabel, countryLabel, localeLabel);
  return {
    details,
    read() {
      return {
        ...(site.checked && origin ? { origin } : {}),
        ...(country.value.trim() ? { country: country.value.trim() } : {}),
        ...(locale.value.trim() ? { locale: locale.value.trim() } : {}),
      };
    },
  };
}

async function saveExactAnswer(question, answer, scope = {}) {
  const q = String(question ?? "").trim().slice(0, MAX_ANSWER_QUESTION);
  const a = String(answer ?? "").trim().slice(0, MAX_ANSWER_TEXT);
  if (!q || !a) {
    showFeedback("Enter a reviewed answer before saving it.", "error");
    return;
  }
  return saveAnswerRecord({ question: q, answer: a, answerType: "text", scope });
}

globalThis.saveExactAnswer = saveExactAnswer;

async function saveAnswerRecord(value) {
  const candidate = ANSWER_CONTRACT.normalizeAnswer({
    ...value,
    question: String(value?.question ?? "").trim().slice(0, MAX_ANSWER_QUESTION),
    answer: String(value?.answer ?? ""),
  });
  if (!candidate) {
    showFeedback("Review the answer and scope, then save a valid exact choice.", "error");
    return;
  }
  const identity = ANSWER_CONTRACT.answerIdentityKey(candidate);
  const existing = state.answers.find((item) => ANSWER_CONTRACT.answerIdentityKey(item) === identity);
  const answerRecord = { ...candidate, ...(existing?.id ? { id: existing.id } : {}) };
  const key = normalizedQuestion(candidate.question);
  const answerKey = ANSWER_CONTRACT.answerIdentityKey(answerRecord);
  state.answers = [...state.answers.filter((item) => ANSWER_CONTRACT.answerIdentityKey(item) !== answerKey), answerRecord];
  state.pendingAnswerUpserts = [...state.pendingAnswerUpserts.filter((item) => ANSWER_CONTRACT.answerIdentityKey(item) !== answerKey), answerRecord];
  state.deletedAnswers = state.deletedAnswers.filter((id) => id !== existing?.id);
  state.answerDrafts = state.answerDrafts.filter((item) => !draftIsCoveredByAnswer(item, answerRecord));
  if (!await saveState()) return false;
  if (currentScan) {
    currentScan.unknownQuestions = currentScan.unknownQuestions.filter((item) => normalizedQuestion(item.question) !== key);
    renderPageReport(currentScan);
  }
  renderAnswerDrafts();
  renderSavedAnswers();
  showFeedback("Exact answer saved locally. Sync with Scout to add it to your account.", "success");
  return true;
}

function renderAnswerDrafts() {
  const list = elements.answerDraftList;
  list.replaceChildren();
  const drafts = state.answerDrafts.filter((draft) => !state.answers.some((saved) => draftIsCoveredByAnswer(draft, saved)));
  elements.answerDraftsSection.hidden = drafts.length === 0;
  elements.saveAnswerDrafts.hidden = drafts.length === 0;

  for (const draft of drafts) {
    const row = document.createElement("div");
    row.className = "unknown-item answer-draft";
    row.dataset.draftId = draft.draftId;
    const group = document.createElement("p");
    group.className = "field-help draft-group";
    group.textContent = draft.group;
    const question = document.createElement("p");
    question.className = "unknown-question";
    question.textContent = draft.question;
    row.append(group, question);

    if (draft.answerType === "text") {
      const label = document.createElement("label");
      label.textContent = "Suggested answer (editable)";
      const input = document.createElement("textarea");
      input.maxLength = MAX_ANSWER_TEXT;
      input.dataset.answerDraftValue = "text";
      input.value = draft.answer;
      label.append(input);
      row.append(label);
    } else if (draft.answerType === "multi-choice") {
      const choices = document.createElement("div");
      choices.className = "answer-choice-list";
      choices.setAttribute("role", "group");
      choices.setAttribute("aria-label", `Reviewed choices for ${draft.question}`);
      for (const choice of draft.allowedChoices) {
        const label = document.createElement("label");
        label.className = "answer-choice";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.answerDraftChoice = choice;
        input.value = choice;
        input.checked = draft.selectedChoices.includes(choice);
        label.append(input, document.createTextNode(choice));
        choices.append(label);
      }
      row.append(choices);
    } else {
      const label = document.createElement("label");
      label.textContent = draft.answerType === "boolean" ? "Suggested yes/no answer (editable)" : "Suggested choice (editable)";
      const input = document.createElement("select");
      input.dataset.answerDraftValue = draft.answerType;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose an answer";
      input.append(placeholder);
      for (const choice of draft.allowedChoices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        input.append(option);
      }
      const initial = draft.answerType === "boolean"
        ? draft.booleanValue ? "Yes" : "No"
        : draft.selectedChoices[0] ?? "";
      input.value = initial;
      label.append(input);
      row.append(label);
    }

    const scope = document.createElement("p");
    scope.className = "field-help saved-answer-value";
    scope.textContent = formatAnswerScope(draft.scope);
    row.append(scope);
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "text-button danger-text";
    discard.textContent = "Discard suggestion";
    discard.addEventListener("click", () => discardAnswerDraft(draft.draftId));
    row.append(discard);
    list.append(row);
  }
}

function draftIsCoveredByAnswer(draft, answer) {
  return ANSWER_CONTRACT.answerIdentityKey(answer) === ANSWER_CONTRACT.answerIdentityKey(draft);
}

function readDraftAnswer(row, draft) {
  const input = row.querySelector("[data-answer-draft-value]");
  if (draft.answerType === "text") {
    const answer = input?.value.trim() ?? "";
    return answer ? { ...draft, answer } : null;
  }
  if (draft.answerType === "boolean") {
    if (!input || !["Yes", "No"].includes(input.value)) return null;
    return { ...draft, answer: "", booleanValue: input.value === "Yes" };
  }
  if (draft.answerType === "single-choice") {
    if (!input || !draft.allowedChoices.includes(input.value)) return null;
    return { ...draft, answer: "", selectedChoices: [input.value] };
  }
  if (draft.answerType === "multi-choice") {
    const selectedChoices = Array.from(row.querySelectorAll("[data-answer-draft-choice]:checked"), (choice) => choice.value);
    return selectedChoices.every((choice) => draft.allowedChoices.includes(choice))
      ? { ...draft, answer: "", selectedChoices }
      : null;
  }
  return null;
}

async function saveReviewedAnswerDrafts() {
  const rows = Array.from(elements.answerDraftList.querySelectorAll("[data-draft-id]"));
  const candidates = rows.map((row) => {
    const draft = state.answerDrafts.find((item) => item.draftId === row.dataset.draftId);
    return draft ? { row, draft, candidate: readDraftAnswer(row, draft) } : null;
  }).filter(Boolean);
  if (!candidates.length) return;
  if (candidates.some((item) => !item.candidate || !ANSWER_CONTRACT.normalizeAnswer(item.candidate))) {
    showFeedback("Complete or discard each draft before saving the reviewed answers.", "error");
    return;
  }

  const savedIds = new Set();
  for (const item of candidates) {
    const candidate = ANSWER_CONTRACT.normalizeAnswer(item.candidate);
    const alreadySaved = state.answers.some((answer) =>
      ANSWER_CONTRACT.answerIdentityKey(answer) === ANSWER_CONTRACT.answerIdentityKey(candidate));
    if (!alreadySaved) {
      const identity = ANSWER_CONTRACT.answerIdentityKey(candidate);
      const existing = state.answers.find((answer) => ANSWER_CONTRACT.answerIdentityKey(answer) === identity);
      const answer = { ...candidate, ...(existing?.id ? { id: existing.id } : {}) };
      state.answers = [...state.answers.filter((entry) => ANSWER_CONTRACT.answerIdentityKey(entry) !== identity), answer];
      state.pendingAnswerUpserts = [...state.pendingAnswerUpserts.filter((entry) => ANSWER_CONTRACT.answerIdentityKey(entry) !== identity), answer];
      state.deletedAnswers = state.deletedAnswers.filter((id) => id !== existing?.id);
    }
    savedIds.add(item.draft.draftId);
  }
  state.answerDrafts = state.answerDrafts.filter((draft) => !savedIds.has(draft.draftId));
  if (!await saveState()) return;
  renderAnswerDrafts();
  renderSavedAnswers();
  showFeedback("Reviewed application answers saved locally. Sync with Scout separately when you’re ready.", "success");
}

async function discardAnswerDraft(draftId) {
  state.answerDrafts = state.answerDrafts.filter((draft) => draft.draftId !== draftId);
  if (!await saveState()) return;
  renderAnswerDrafts();
  showFeedback("Suggestion discarded from this browser.", "success");
}

function renderSavedAnswers() {
  const list = elements.savedAnswerList;
  list.replaceChildren();
  elements.savedAnswersSection.hidden = !state.answers.length;
  for (const answer of state.answers) {
    const row = document.createElement("div");
    row.className = "unknown-item saved-answer";
    const question = document.createElement("p");
    question.className = "unknown-question";
    question.textContent = answer.question;
    const value = document.createElement("p");
    value.className = "field-help saved-answer-value";
    value.textContent = formatAnswerValue(answer);
    const scope = document.createElement("p");
    scope.className = "field-help saved-answer-value";
    scope.textContent = formatAnswerScope(answer.scope);
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "text-button danger-text";
    forget.textContent = "Forget this answer";
    forget.addEventListener("click", () => forgetAnswer(answer));
    row.append(question, value, scope, forget);
    list.append(row);
  }
}

async function forgetAnswer(answer) {
  const identity = ANSWER_CONTRACT.answerIdentityKey(answer);
  state.answers = state.answers.filter((item) => ANSWER_CONTRACT.answerIdentityKey(item) !== identity);
  state.answerDrafts = state.answerDrafts.filter((draft) => !draftIsCoveredByAnswer(draft, answer));
  state.pendingAnswerUpserts = state.pendingAnswerUpserts.filter((item) => ANSWER_CONTRACT.answerIdentityKey(item) !== identity);
  if (answer.id) state.deletedAnswers.push(answer.id);
  await saveState();
  renderAnswerDrafts();
  renderSavedAnswers();
  showFeedback("Answer removed locally. Sync with Scout to remove it from your account.", "success");
}

function formatAnswerValue(answer) {
  if (answer.answerType === "boolean") return answer.booleanValue ? "Yes" : "No";
  if (answer.answerType === "single-choice") return answer.selectedChoices?.[0] ?? "";
  if (answer.answerType === "multi-choice") return answer.selectedChoices?.length ? answer.selectedChoices.join(", ") : "No options selected";
  return answer.answer;
}

function formatAnswerScope(scope = {}) {
  const values = [scope.origin, scope.country, scope.locale].filter(Boolean);
  return values.length ? `Limited to ${values.join(" · ")}` : "Global exact-question answer";
}

async function onChooseDocument(event, kind) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const expectedType = ext === "pdf" ? "application/pdf" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "";
  if (!expectedType || (file.type && file.type !== expectedType && file.type !== "application/octet-stream")) {
    showFeedback("Choose a PDF or DOCX document.", "error");
    return;
  }
  const other = kind === "resume" ? state.documents.coverLetter : state.documents.resume;
  if (file.size > MAX_DOCUMENT_BYTES || file.size + (other?.size ?? 0) > MAX_DOCUMENT_BYTES) {
    showFeedback("Documents can use up to 5 MB of local storage in total.", "error");
    return;
  }
  const previousDocument = state.documents[kind];
  try {
    const dataUrl = await readFileAsDataUrl(file);
    state.documents[kind] = { name: file.name.slice(0, 180), type: expectedType, size: file.size, base64: dataUrl.split(",")[1] ?? "" };
    if (!await saveState()) {
      state.documents[kind] = previousDocument;
      return;
    }
    renderDocuments();
    showFeedback(`${kind === "resume" ? "Resume" : "Cover letter"} saved in this browser.`, "success");
  } catch {
    showFeedback("The document could not be read. Choose it again and retry.", "error");
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unreadable file"));
    reader.onerror = () => reject(reader.error ?? new Error("Unreadable file"));
    reader.readAsDataURL(file);
  });
}

function renderDocuments() {
  const resume = state.documents.resume;
  const cover = state.documents.coverLetter;
  elements.removeResume.hidden = !resume;
  elements.removeCoverLetter.hidden = !cover;
  const parts = [];
  if (resume) parts.push(`Resume: ${resume.name}`);
  if (cover) parts.push(`Cover letter: ${cover.name}`);
  elements.documentStatus.textContent = parts.length ? `${parts.join(" · ")} · stored only in this browser` : "PDF or DOCX, 5 MB combined maximum. Existing files on the form are preserved.";
}

async function removeDocument(kind) {
  if (!state.documents[kind]) return;
  state.documents[kind] = null;
  if (!await saveState()) return;
  renderDocuments();
  showFeedback(`${kind === "resume" ? "Resume" : "Cover letter"} removed from this browser.`, "success");
}

function preparedApplicationForManualLog(tab, helperState = state) {
  return APPLICATION_CONTEXT.preparedApplicationForManualLog(tab, helperState.preparedApplication, helperState.accountId);
}

async function onCopyProfile() {
  if (!applyPendingProfileRowCounts()) return;
  state.profile = collectProfileFromForm();
  const profile = state.profile;
  const educationLines = profile.education.map((entry, index) => [
    `Education ${index + 1}`,
    [entry.school, entry.degree, entry.fieldOfStudy, entry.gradeAverage, entry.startDate, entry.endDate].filter(Boolean).join(" · "),
  ]);
  const experienceLines = profile.experience.map((entry, index) => [
    `Experience ${index + 1}`,
    [entry.title, entry.company, entry.location, entry.startDate, entry.endDate, entry.description].filter(Boolean).join(" · "),
  ]);
  const languageLines = profile.languages.map((entry) => [
    `Language: ${entry.language || ""}`,
    [entry.fluent === true ? "Fluent" : entry.fluent === false ? "Not fluent" : "", entry.comprehension, entry.overall, entry.reading, entry.speaking, entry.writing].filter(Boolean).join(" · "),
  ]);
  const lines = [
    ["Name", [profile.firstName, profile.lastName].filter(Boolean).join(" ")],
    ["Email", profile.email], ["Phone", profile.phone], ["Address", [profile.address, profile.city, profile.region, profile.postalCode, profile.country].filter(Boolean).join(", ")],
    ["LinkedIn", profile.linkedin], ["GitHub", profile.github], ["Portfolio", profile.portfolio],
    ["Work authorization", profile.workAuthorization],
    ["Websites", profile.websites.map((entry) => entry.url).filter(Boolean).join(" · ")],
    ...educationLines,
    ...experienceLines,
    ...languageLines,
  ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    showFeedback("Profile copied. Paste values into this unsupported form manually.", "success");
  } catch {
    showFeedback("Clipboard access is unavailable. Select and copy the visible profile fields manually.", "error");
  }
}

async function onConfirmSubmitted() {
  if (busy) return;
  setBusy(true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error("Open the application page in the active tab first.");
    if (!state.accountId || !state.scoutOrigin) throw new Error("Connect a verified Scout account before logging applications.");
    if (!await validateBoundAccount()) return;
    const preparedLog = preparedApplicationForManualLog(tab);
    if (!preparedLog && state.preparedApplication?.tabId === tab.id) {
      throw new Error("This tab moved to a different application. Review its company and role before logging it.");
    }
    if (preparedLog) {
      currentScan = { ...preparedLog, tabId: tab.id, supported: true };
      if (!elements.applicationCompany.value) elements.applicationCompany.value = preparedLog.company;
      if (!elements.applicationTitle.value) elements.applicationTitle.value = preparedLog.title;
      if (!elements.applicationLocation.value) elements.applicationLocation.value = preparedLog.location;
    } else if (!currentScan || currentScan.tabId !== tab.id || currentScan.applicationUrl !== tab.url) {
      const { report } = await injectAndCallActiveTab("scan");
      rememberCurrentPage(tab, report);
      renderPageReport(report);
    }
    const activeUrl = new URL(tab.url);
    const logTarget = preparedLog ?? currentScan;
    const samePreparedApplication = preparedLog
      ? APPLICATION_CONTEXT.shouldKeepPreparedApplicationAt(state.preparedApplication, tab.id, activeUrl.href)
      : activeUrl.href === logTarget.applicationUrl;
    if (!samePreparedApplication) {
      const { report } = await injectAndCallActiveTab("scan");
      rememberCurrentPage(tab, report);
      renderPageReport(report);
      throw new Error("The active page changed. Review the application and click the submission confirmation again.");
    }
    const details = APPLICATION_CONTEXT.manualLogDetails(preparedLog, {
      company: elements.applicationCompany.value,
      title: elements.applicationTitle.value,
      location: elements.applicationLocation.value,
    });
    const company = details.company;
    const title = details.title;
    if (!company || !title) throw new Error("Add the company and role title before logging this submission.");
    const pending = {
      localId: crypto.randomUUID(),
      accountId: state.accountId,
      company,
      title,
      applicationUrl: preparedLog?.applicationUrl ?? logTarget.applicationUrl,
      location: details.location || undefined,
      confirmedSubmitted: true,
    };
    if (!await saveState(state, { enqueueApplication: pending })) return;
    renderPendingApplications();
    await flushPendingApplications();
  } catch (error) {
    showFeedback(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function flushPendingApplications() {
  if (!state.pendingApplications.length || !state.scoutOrigin || !state.accountId) return;
  for (const pending of [...state.pendingApplications]) {
    if (pending.accountId !== state.accountId) continue;
    try {
      const result = await runScoutBridge(state.scoutOrigin, "logApplication", {
        accountId: pending.accountId,
        application: {
          company: pending.company,
          title: pending.title,
          applicationUrl: pending.applicationUrl,
          location: pending.location,
          confirmedSubmitted: true,
        },
      });
      if (result.accountMismatch) {
        await handleAccountMismatch(result);
        return;
      }
      if (result.accountId !== state.accountId) {
        await handleAccountMismatch(result);
        return;
      }
      const application = { company: pending.company, title: pending.title, applicationUrl: pending.applicationUrl, loggedAt: Date.now() };
      if (!await saveState(state, { ackApplication: { localId: pending.localId, accountId: pending.accountId, application } })) return;
      showFeedback("Submission logged in Scout.", "success");
    } catch (error) {
      await handleScoutError(error);
      if (error.code === "NO_VERIFIED_SESSION" || error.code === "ACCOUNT_MISMATCH") return;
    }
  }
  if (state.pendingApplications.length) {
    renderPendingApplications();
    elements.pendingStatus.textContent = "Submission saved locally and waiting for Scout to reconnect. Retry with Sync with Scout.";
  } else {
    renderPendingApplications();
  }
}

async function handleAccountMismatch(result) {
  const origin = state.scoutOrigin;
  const next = defaultState();
  next.scoutOrigin = origin;
  next.accountId = result.accountId;
  next.profile = normalizeProfile(result.profile);
  next.answers = (result.answers ?? []).filter(isValidAnswer).slice(-200);
  next.personalPresetApplied = true;
  next.personalPresetRemoteApplied = true;
  next.personalPresetBaseline = structuredClone(next.profile);
  next.answerDraftsApplied = true;
  next.answerDrafts = [];
  state = next;
  if (!await saveState(state, { accountTransition: true })) return;
  renderAll();
  showFeedback("The signed-in Scout account changed. The previous account cache and pending logs were cleared.", "error");
}

function renderPendingApplications() {
  const count = state.pendingApplications.length;
  elements.pendingStatus.textContent = count
    ? `${count} submission log${count === 1 ? " is" : "s are"} waiting to sync.`
    : state.lastLoggedApplication ? `Last logged: ${state.lastLoggedApplication.company} — ${state.lastLoggedApplication.title}.`
      : state.lastConfirmation?.requiresManualLog ? `Confirmation detected for ${state.lastConfirmation.company} — ${state.lastConfirmation.title}. Use “I submitted this application” if you submitted it.` : "";
}

function setBusy(value) {
  busy = value;
  for (const button of [elements.connectScout, elements.syncNow, elements.checkPage, elements.autofill, elements.confirmSubmitted]) {
    button.disabled = value;
  }
}

function showFeedback(message, tone = "") {
  elements.feedback.textContent = message;
  if (tone) elements.feedback.dataset.tone = tone;
  else delete elements.feedback.dataset.tone;
}

initialize().catch((error) => showFeedback(error.message || "Scout helper could not start.", "error"));
