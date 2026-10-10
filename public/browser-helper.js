/* global document, fetch, FormData, Headers, HTMLSelectElement, localStorage, TextEncoder, URL, window */

const PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "preferredFirstName",
  "preferredLastName",
  "email",
  "phone",
  "phoneType",
  "phoneCountryCode",
  "phoneExtension",
  "address",
  "city",
  "region",
  "postalCode",
  "country",
  "linkedin",
  "github",
  "portfolio",
  "workAuthorization",
  "requiresSponsorship",
];
const NULLABLE_BOOLEAN_PROFILE_FIELDS = ["previousWorker", "hasPreferredName"];
const NULLABLE_NUMBER_PROFILE_FIELDS = ["experienceCount"];

const EDUCATION_FIELDS = ["school", "degree", "fieldOfStudy", "startDate", "endDate", "gradeAverage"];
const EXPERIENCE_FIELDS = ["company", "title", "startDate", "endDate", "description", "location"];
const LANGUAGE_FIELDS = ["language", "comprehension", "overall", "reading", "speaking", "writing"];
const PROFILE_PATH = "/api/browser-helper/profile";
const ANSWERS_PATH = "/api/browser-helper/answers";

let accountId = "";
const elements = {
  loading: document.querySelector("#helper-loading"),
  signIn: document.querySelector("#helper-signin"),
  unconfigured: document.querySelector("#helper-unconfigured"),
  loadError: document.querySelector("#helper-load-error"),
  loadErrorMessage: document.querySelector("#helper-load-error-message"),
  retry: document.querySelector("#helper-retry-load"),
  content: document.querySelector("#helper-content"),
  pageStatus: document.querySelector("#helper-page-status"),
  profileForm: document.querySelector("#profile-form"),
  profileSave: document.querySelector("#save-profile"),
  clearProfile: document.querySelector("#clear-profile"),
  profileSaveStatus: document.querySelector("#profile-save-status"),
  profileEmpty: document.querySelector("#profile-empty-note"),
  educationList: document.querySelector("#education-list"),
  educationEmpty: document.querySelector("#education-empty"),
  experienceList: document.querySelector("#experience-list"),
  experienceEmpty: document.querySelector("#experience-empty"),
  websiteList: document.querySelector("#website-list"),
  websiteEmpty: document.querySelector("#website-empty"),
  languageList: document.querySelector("#language-list"),
  languageEmpty: document.querySelector("#language-empty"),
  answersEmpty: document.querySelector("#answers-empty"),
  answerList: document.querySelector("#answer-list"),
  answerForm: document.querySelector("#answer-form"),
  answerFormTitle: document.querySelector("#answer-form-title"),
  answerSave: document.querySelector("#save-answer"),
  answerSaveStatus: document.querySelector("#answer-save-status"),
  scoutOrigin: document.querySelector("#scout-origin"),
};

let csrfToken = "";
let profile = emptyProfile();
let answers = [];
let loading = false;
let profileSaving = false;
let answerSaving = false;

function applySavedTheme() {
  try {
    const settings = JSON.parse(localStorage.getItem("roleradar.settings") || "{}");
    const preference = settings && typeof settings === "object" ? settings.theme : "light";
    const dark = preference === "dark"
      || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111512" : "#f2f0e9");
  } catch {
    document.documentElement.dataset.theme = "light";
  }
}

function emptyProfile() {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    phoneType: "",
    phoneCountryCode: "",
    phoneExtension: "",
    address: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    linkedin: "",
    github: "",
    portfolio: "",
    workAuthorization: "",
    requiresSponsorship: "",
    previousWorker: null,
    hasPreferredName: null,
    referralSources: [],
    education: [],
    experience: [],
    experienceCount: null,
    websites: [],
    languages: [],
  };
}

function normalizeProfile(value) {
  const normalized = emptyProfile();
  if (!value || typeof value !== "object") return normalized;
  for (const field of PROFILE_FIELDS) {
    normalized[field] = typeof value[field] === "string" ? value[field] : "";
  }
  for (const field of NULLABLE_BOOLEAN_PROFILE_FIELDS) {
    normalized[field] = typeof value[field] === "boolean" ? value[field] : null;
  }
  for (const field of NULLABLE_NUMBER_PROFILE_FIELDS) {
    normalized[field] = Number.isInteger(value[field]) && value[field] >= 0 && value[field] <= 20 ? value[field] : null;
  }
  normalized.education = Array.isArray(value.education)
    ? value.education.map((entry) => normalizeRecord(entry, EDUCATION_FIELDS))
    : [];
  normalized.experience = Array.isArray(value.experience)
    ? value.experience.map((entry) => ({
      ...normalizeRecord(entry, EXPERIENCE_FIELDS),
      currentlyWorkHere: typeof entry?.currentlyWorkHere === "boolean" ? entry.currentlyWorkHere : null,
    }))
    : [];
  normalized.referralSources = Array.isArray(value.referralSources)
    ? value.referralSources.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).slice(0, 30)
    : [];
  normalized.websites = Array.isArray(value.websites)
    ? value.websites.map((entry) => normalizeRecord(entry, ["url"]))
    : [];
  normalized.languages = Array.isArray(value.languages)
    ? value.languages.slice(0, 20).map((entry) => ({
      ...normalizeRecord(entry, LANGUAGE_FIELDS),
      fluent: typeof entry?.fluent === "boolean" ? entry.fluent : null,
    }))
    : [];
  return normalized;
}

function normalizeRecord(value, fields) {
  const record = {};
  for (const field of fields) {
    record[field] = value && typeof value[field] === "string" ? value[field] : "";
  }
  return record;
}

function normalizeLanguageName(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.method && options.method !== "GET") {
    headers.set("Content-Type", "application/json");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
    if (accountId) headers.set("X-Scout-Account-Id", accountId);
  }
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new HelperRequestError("Scout could not reach the service. Check your connection and try again.", 0);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new HelperRequestError("Scout returned an invalid response. Reload the page and try again.", response.status);
  }
  if (!response.ok) {
    if (response.status === 409) {
      throw new HelperRequestError("The signed-in Scout account changed. Reload Scout and reconnect before saving.", response.status);
    }
    const message = payload?.error?.message ?? payload?.error ?? payload?.message;
    throw new HelperRequestError(typeof message === "string" ? message : "Scout could not complete that request. Try again.", response.status);
  }
  return payload;
}

class HelperRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HelperRequestError";
    this.status = status;
  }
}

function showGate(name) {
  elements.loading.hidden = name !== "loading";
  elements.signIn.hidden = name !== "signin";
  elements.unconfigured.hidden = name !== "unconfigured";
  elements.loadError.hidden = name !== "error";
  elements.content.hidden = name !== "content";
}

function setStatus(target, message, kind = "") {
  target.textContent = message;
  if (kind) target.dataset.kind = kind;
  else delete target.dataset.kind;
}

function showSignIn() {
  showGate("signin");
  setStatus(elements.pageStatus, "Sign in to load your profile.");
}

function showLoadError(message) {
  elements.loadErrorMessage.textContent = message;
  showGate("error");
  setStatus(elements.pageStatus, "Profile unavailable", "error");
}

function isProfileEmpty(value) {
  return PROFILE_FIELDS.every((field) => value[field] === "")
    && NULLABLE_BOOLEAN_PROFILE_FIELDS.every((field) => value[field] === null)
    && NULLABLE_NUMBER_PROFILE_FIELDS.every((field) => value[field] === null)
    && value.referralSources.length === 0
    && !value.education.some((entry) => EDUCATION_FIELDS.some((field) => entry[field]))
    && !value.experience.some((entry) => EXPERIENCE_FIELDS.some((field) => entry[field]) || entry.currentlyWorkHere !== null)
    && !value.websites.some((entry) => entry.url)
    && value.languages.length === 0;
}

function setProfileValue(name, value) {
  const control = elements.profileForm.elements.namedItem(name);
  if (!control) return;
  if (control instanceof HTMLSelectElement && value && ![...control.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    control.append(option);
  }
  control.value = value;
}

function renderRecords(type, records) {
  const isEducation = type === "education";
  const container = isEducation ? elements.educationList : elements.experienceList;
  const empty = isEducation ? elements.educationEmpty : elements.experienceEmpty;
  const template = document.querySelector(isEducation ? "#education-template" : "#experience-template");
  const fields = isEducation ? EDUCATION_FIELDS : EXPERIENCE_FIELDS;
  const label = isEducation ? "Education" : "Experience";
  container.replaceChildren();
  empty.hidden = records.length > 0;

  records.forEach((record, index) => {
    const fragment = template.content.cloneNode(true);
    const fieldset = fragment.querySelector("[data-record-type]");
    fieldset.dataset.recordIndex = String(index);
    fieldset.querySelector("[data-record-title]").textContent = `${label} ${index + 1}`;
    const remove = fieldset.querySelector("[data-remove-record]");
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", `Remove ${label.toLowerCase()} ${index + 1}`);
    for (const field of fields) {
      const control = fieldset.querySelector(`[data-field="${field}"]`);
      control.value = record[field] ?? "";
      control.name = `${type}[${index}][${field}]`;
    }
    if (!isEducation) {
      const current = fieldset.querySelector('[data-field="currentlyWorkHere"]');
      current.value = record.currentlyWorkHere === null ? "" : String(record.currentlyWorkHere);
      current.name = `${type}[${index}][currentlyWorkHere]`;
    }
    container.append(fragment);
  });
}

function renderWebsites(websites) {
  elements.websiteList.replaceChildren();
  elements.websiteEmpty.hidden = websites.length > 0;
  const template = document.querySelector("#website-template");
  websites.forEach((website, index) => {
    const fragment = template.content.cloneNode(true);
    const fieldset = fragment.querySelector('[data-record-type="website"]');
    fieldset.dataset.recordIndex = String(index);
    fieldset.querySelector("[data-record-title]").textContent = `Website ${index + 1}`;
    const remove = fieldset.querySelector("[data-remove-record]");
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", `Remove website ${index + 1}`);
    const input = fieldset.querySelector('[data-field="url"]');
    input.value = website.url;
    input.name = `websites[${index}][url]`;
    elements.websiteList.append(fragment);
  });
}

function renderLanguages(languages) {
  elements.languageList.replaceChildren();
  elements.languageEmpty.hidden = languages.length > 0;
  const template = document.querySelector("#language-template");
  languages.forEach((language, index) => {
    const fragment = template.content.cloneNode(true);
    const fieldset = fragment.querySelector('[data-record-type="language"]');
    fieldset.dataset.recordIndex = String(index);
    fieldset.querySelector("[data-record-title]").textContent = `Language ${index + 1}`;
    const remove = fieldset.querySelector("[data-remove-record]");
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", `Remove language ${index + 1}`);
    for (const field of LANGUAGE_FIELDS) {
      const control = fieldset.querySelector(`[data-field="${field}"]`);
      control.value = language[field] ?? "";
      control.name = `languages[${index}][${field}]`;
    }
    const fluent = fieldset.querySelector('[data-field="fluent"]');
    fluent.value = language.fluent === null ? "" : String(language.fluent);
    fluent.name = `languages[${index}][fluent]`;
    elements.languageList.append(fragment);
  });
}

function writeProfileForm(value) {
  for (const field of PROFILE_FIELDS) setProfileValue(field, value[field]);
  for (const field of NULLABLE_BOOLEAN_PROFILE_FIELDS) {
    setProfileValue(field, value[field] === null ? "" : String(value[field]));
  }
  for (const field of NULLABLE_NUMBER_PROFILE_FIELDS) {
    setProfileValue(field, value[field] === null ? "" : String(value[field]));
  }
  updatePreferredNameFields();
  const referralSources = elements.profileForm.elements.namedItem("referralSources");
  if (referralSources) referralSources.value = value.referralSources.join("\n");
  renderRecords("education", value.education);
  renderRecords("experience", value.experience);
  renderWebsites(value.websites);
  renderLanguages(value.languages);
  elements.profileEmpty.hidden = !isProfileEmpty(value);
}

function updatePreferredNameFields() {
  const fields = document.querySelector("#preferred-name-fields");
  const hasPreferredName = elements.profileForm.elements.namedItem("hasPreferredName");
  if (fields) fields.hidden = hasPreferredName?.value !== "true";
}

function readRecords(container, fields) {
  return [...container.querySelectorAll("[data-record-type]")]
    .map((record) => {
      const value = {};
      for (const field of fields) {
        value[field] = record.querySelector(`[data-field="${field}"]`)?.value.trim() ?? "";
      }
      return value;
    });
}

function readExperienceRecords() {
  return readRecords(elements.experienceList, EXPERIENCE_FIELDS).map((record, index) => {
    const control = elements.experienceList.querySelector(`[data-record-index="${index}"] [data-field="currentlyWorkHere"]`);
    return {
      ...record,
      currentlyWorkHere: control?.value === "true" ? true : control?.value === "false" ? false : null,
    };
  });
}

function readLanguages() {
  return [...elements.languageList.querySelectorAll('[data-record-type="language"]')].map((record) => {
    const value = {};
    for (const field of LANGUAGE_FIELDS) value[field] = record.querySelector(`[data-field="${field}"]`)?.value.trim() ?? "";
    const fluent = record.querySelector('[data-field="fluent"]')?.value;
    value.fluent = fluent === "true" ? true : fluent === "false" ? false : null;
    return value;
  });
}

function readProfileForm() {
  const value = emptyProfile();
  for (const field of PROFILE_FIELDS) {
    const control = elements.profileForm.elements.namedItem(field);
    value[field] = typeof control?.value === "string" ? control.value.trim() : "";
  }
  for (const field of NULLABLE_BOOLEAN_PROFILE_FIELDS) {
    const control = elements.profileForm.elements.namedItem(field);
    value[field] = control?.value === "true" ? true : control?.value === "false" ? false : null;
  }
  for (const field of NULLABLE_NUMBER_PROFILE_FIELDS) {
    const control = elements.profileForm.elements.namedItem(field);
    const parsed = control?.value === "" ? null : Number(control?.value);
    value[field] = Number.isInteger(parsed) && parsed >= 0 && parsed <= 20 ? parsed : null;
  }
  const referralSources = elements.profileForm.elements.namedItem("referralSources");
  value.referralSources = typeof referralSources?.value === "string"
    ? referralSources.value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)
    : [];
  value.education = readRecords(elements.educationList, EDUCATION_FIELDS);
  value.experience = readExperienceRecords();
  value.websites = readRecords(elements.websiteList, ["url"]);
  value.languages = readLanguages();
  return value;
}

function renderAnswers() {
  elements.answerList.replaceChildren();
  elements.answersEmpty.hidden = answers.length > 0;

  for (const answer of answers) {
    const item = document.createElement("article");
    item.className = "helper-answer-item";
    item.setAttribute("role", "listitem");
    item.dataset.answerId = answer.id;

    const copy = document.createElement("div");
    copy.className = "helper-answer-copy";
    const question = document.createElement("h3");
    question.textContent = answer.question;
    const response = document.createElement("p");
    response.textContent = answerSummary(answer);
    copy.append(question, response);
    const scopeText = document.createElement("p");
    scopeText.className = "helper-answer-scope-summary";
    scopeText.textContent = `Reuse scope: ${answer.scope && typeof answer.scope === "object" ? formatAnswerScope(answer.scope) : "Any matching application"}`;
    copy.append(scopeText);

    const actions = document.createElement("div");
    actions.className = "helper-answer-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.editAnswer = "";
    edit.setAttribute("aria-label", `Edit answer: ${answer.question}`);
    edit.textContent = "Edit";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.deleteAnswer = "";
    remove.setAttribute("aria-label", `Delete answer: ${answer.question}`);
    remove.textContent = "Delete";
    actions.append(edit, remove);

    const editor = document.createElement("form");
    editor.className = "helper-answer-editor";
    editor.hidden = true;
    editor.setAttribute("aria-label", `Edit saved answer: ${answer.question}`);
    const fields = document.createElement("div");
    fields.dataset.answerFields = "";
    editor.append(fields);
    createAnswerFields(editor, answer);

    const editActions = document.createElement("div");
    editActions.className = "helper-answer-editor-actions";
    const cancel = document.createElement("button");
    cancel.className = "helper-answer-cancel";
    cancel.type = "button";
    cancel.dataset.cancelEdit = "";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.className = "helper-primary-button";
    save.type = "submit";
    save.textContent = "Save changes";
    editActions.append(cancel, save);
    editor.append(editActions);

    item.append(copy, actions, editor);
    elements.answerList.append(item);
  }
}

function appendOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function appendFieldLabel(parent, title, control) {
  const label = document.createElement("label");
  label.className = "helper-field";
  const caption = document.createElement("span");
  caption.textContent = title;
  label.append(caption, control);
  parent.append(label);
}

function formatAnswerScope(scope) {
  const values = [scope.origin, scope.country, scope.locale].filter((value) => typeof value === "string" && value.trim());
  return values.length ? values.join(" · ") : "Any application";
}

function answerSummary(answer) {
  const answerType = answer.answerType ?? "text";
  if (answerType === "boolean") return answer.booleanValue === true ? "Yes" : "No";
  if (answerType === "single-choice") return Array.isArray(answer.selectedChoices) ? answer.selectedChoices[0] ?? "No selection saved" : "No selection saved";
  if (answerType === "multi-choice") {
    return Array.isArray(answer.selectedChoices) && answer.selectedChoices.length
      ? answer.selectedChoices.join(" · ")
      : "No options selected (saved explicitly)";
  }
  return answer.answer;
}

function createAnswerFields(form, answer = {}) {
  const mount = form.querySelector("[data-answer-fields]");
  if (!mount) return;
  mount.replaceChildren();

  const grid = document.createElement("div");
  grid.className = "helper-answer-fields";
  const question = document.createElement("input");
  question.name = "question";
  question.type = "text";
  question.maxLength = 1000;
  question.required = true;
  question.value = typeof answer.question === "string" ? answer.question : "";
  appendFieldLabel(grid, "Question or prompt", question);

  const answerType = document.createElement("select");
  answerType.name = "answerType";
  appendOption(answerType, "text", "Written answer");
  appendOption(answerType, "single-choice", "One exact choice");
  appendOption(answerType, "multi-choice", "Multiple exact choices");
  appendOption(answerType, "boolean", "Yes or no");
  answerType.value = ["text", "single-choice", "multi-choice", "boolean"].includes(answer.answerType)
    ? answer.answerType
    : "text";
  appendFieldLabel(grid, "Answer format", answerType);

  const textPanel = document.createElement("div");
  textPanel.dataset.answerPanel = "text";
  const textAnswer = document.createElement("textarea");
  textAnswer.name = "answer";
  textAnswer.rows = 4;
  textAnswer.maxLength = 2000;
  textAnswer.value = typeof answer.answer === "string" ? answer.answer : "";
  appendFieldLabel(textPanel, "Your answer", textAnswer);

  const choicesPanel = document.createElement("div");
  choicesPanel.dataset.answerPanel = "choices";
  const choices = document.createElement("textarea");
  choices.name = "selectedChoices";
  choices.rows = 3;
  choices.maxLength = 15029;
  choices.placeholder = "One exact option label per line";
  choices.value = Array.isArray(answer.selectedChoices) ? answer.selectedChoices.join("\n") : "";
  appendFieldLabel(choicesPanel, "Exact option labels", choices);
  const choicesNote = document.createElement("p");
  choicesNote.className = "helper-answer-hint";
  choicesNote.textContent = "Copy the labels exactly as shown on the form. Leave this blank only when you explicitly want to save no selections.";
  choicesPanel.append(choicesNote);

  const booleanPanel = document.createElement("div");
  booleanPanel.dataset.answerPanel = "boolean";
  const booleanValue = document.createElement("select");
  booleanValue.name = "booleanValue";
  appendOption(booleanValue, "", "Choose yes or no…");
  appendOption(booleanValue, "true", "Yes");
  appendOption(booleanValue, "false", "No");
  booleanValue.value = typeof answer.booleanValue === "boolean" ? String(answer.booleanValue) : "";
  appendFieldLabel(booleanPanel, "Your reviewed choice", booleanValue);

  const scope = answer.scope && typeof answer.scope === "object" ? answer.scope : {};
  const scopeFieldset = document.createElement("fieldset");
  scopeFieldset.className = "helper-answer-scope-fields";
  const scopeLegend = document.createElement("legend");
  scopeLegend.textContent = "Limit reuse to this context (optional)";
  scopeFieldset.append(scopeLegend);
  const scopeNote = document.createElement("p");
  scopeNote.className = "helper-answer-hint";
  scopeNote.textContent = "Leave blank to reuse the exact prompt and saved response across applications. A filled scope must match the application context.";
  scopeFieldset.append(scopeNote);
  const scopeGrid = document.createElement("div");
  scopeGrid.className = "helper-answer-scope-grid";
  const origin = document.createElement("input");
  origin.name = "scopeOrigin";
  origin.type = "url";
  origin.maxLength = 2048;
  origin.placeholder = "https://jobs.example.com";
  origin.value = typeof scope.origin === "string" ? scope.origin : "";
  appendFieldLabel(scopeGrid, "ATS website origin", origin);
  const country = document.createElement("input");
  country.name = "scopeCountry";
  country.type = "text";
  country.maxLength = 100;
  country.value = typeof scope.country === "string" ? scope.country : "";
  appendFieldLabel(scopeGrid, "Country", country);
  const locale = document.createElement("input");
  locale.name = "scopeLocale";
  locale.type = "text";
  locale.maxLength = 32;
  locale.placeholder = "e.g., en-CA";
  locale.value = typeof scope.locale === "string" ? scope.locale : "";
  appendFieldLabel(scopeGrid, "Locale", locale);
  scopeFieldset.append(scopeGrid);

  grid.append(textPanel, choicesPanel, booleanPanel, scopeFieldset);
  mount.append(grid);

  const updatePanels = () => {
    const kind = answerType.value;
    for (const [name, panel] of [["text", textPanel], ["choices", choicesPanel], ["boolean", booleanPanel]]) {
      const visible = (name === "text" && kind === "text")
        || (name === "choices" && (kind === "single-choice" || kind === "multi-choice"))
        || (name === "boolean" && kind === "boolean");
      panel.hidden = !visible;
      for (const control of panel.querySelectorAll("input, select, textarea")) {
        control.disabled = !visible;
        control.required = visible && ((name === "text" && control === textAnswer)
          || (name === "choices" && kind === "single-choice")
          || (name === "boolean" && control === booleanValue));
      }
    }
  };
  answerType.addEventListener("change", updatePanels);
  updatePanels();
}

async function loadProfileData() {
  if (loading) return;
  loading = true;
  showGate("loading");
  setStatus(elements.pageStatus, "Checking your Scout session…");
  try {
    const session = await requestJson("/api/auth/session", { method: "GET" });
    csrfToken = typeof session.csrfToken === "string" ? session.csrfToken : "";
    if (session.configured === false) {
      showGate("unconfigured");
      setStatus(elements.pageStatus, "Scout sign-in is not configured.");
      return;
    }
    if (!session.authenticated) {
      showSignIn();
      return;
    }
    if (!csrfToken) throw new HelperRequestError("Scout could not prepare a secure form session. Reload the page and try again.", 0);

    const payload = await requestJson(PROFILE_PATH, { method: "GET" });
    accountId = typeof payload.accountId === "string" ? payload.accountId : "";
    profile = normalizeProfile(payload.profile);
    answers = Array.isArray(payload.answers)
      ? payload.answers.filter((entry) => entry && typeof entry.id === "string" && typeof entry.question === "string" && typeof entry.answer === "string")
      : [];
    writeProfileForm(profile);
    renderAnswers();
    showGate("content");
    setStatus(elements.pageStatus, "Profile loaded. Review it before saving or using it.");
    setStatus(elements.profileSaveStatus, "");
    setStatus(elements.answerSaveStatus, "");
  } catch (error) {
    if (error instanceof HelperRequestError && error.status === 401) {
      showSignIn();
    } else {
      showLoadError(error instanceof Error ? error.message : "Check your connection and try again.");
    }
  } finally {
    loading = false;
  }
}

async function refreshAnswerList() {
  const payload = await requestJson(PROFILE_PATH, { method: "GET" });
  if (accountId && typeof payload.accountId === "string" && payload.accountId !== accountId) {
    throw new HelperRequestError("The signed-in Scout account changed. Reload Scout and reconnect before saving.", 409);
  }
  answers = Array.isArray(payload.answers)
    ? payload.answers.filter((entry) => entry && typeof entry.id === "string" && typeof entry.question === "string" && typeof entry.answer === "string")
    : [];
  renderAnswers();
}

function setProfileBusy(isBusy) {
  profileSaving = isBusy;
  elements.profileSave.disabled = isBusy;
  elements.profileForm.setAttribute("aria-busy", String(isBusy));
  elements.profileSave.textContent = isBusy ? "Saving…" : "Save profile";
  for (const control of elements.profileForm.querySelectorAll("button, input, select, textarea")) {
    if (control !== elements.profileSave) control.disabled = isBusy;
  }
}

elements.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (profileSaving) return;
  if (!elements.profileForm.checkValidity()) {
    elements.profileForm.reportValidity();
    return;
  }
  const nextProfile = readProfileForm();
  if (nextProfile.referralSources.length > 30
    || nextProfile.referralSources.some((source) => source.length > 500)
    || new Set(nextProfile.referralSources).size !== nextProfile.referralSources.length) {
    setStatus(elements.profileSaveStatus, "Enter up to 30 distinct exact referral labels, each up to 500 characters.", "error");
    return;
  }
  nextProfile.education = nextProfile.education.filter((entry) => EDUCATION_FIELDS.some((field) => entry[field]));
  nextProfile.experience = nextProfile.experience.filter((entry) => EXPERIENCE_FIELDS.some((field) => entry[field]) || entry.currentlyWorkHere !== null);
  nextProfile.languages = nextProfile.languages.filter((entry) => LANGUAGE_FIELDS.some((field) => entry[field]) || entry.fluent !== null);
  const languageNames = nextProfile.languages.map((entry) => normalizeLanguageName(entry.language));
  if (nextProfile.education.length > 12 || nextProfile.experience.length > 20) {
    setStatus(elements.profileSaveStatus, "Keep up to 12 education entries and 20 work experience entries.", "error");
    return;
  }
  if (nextProfile.languages.length > 20 || nextProfile.languages.some((entry) => !entry.language)
    || new Set(languageNames).size !== languageNames.length) {
    setStatus(elements.profileSaveStatus, "Enter a distinct language name for each of up to 20 language entries.", "error");
    return;
  }
  const websiteUrlError = nextProfile.websites.some(({ url }) => {
    if (!url) return false;
    if (url.length > 2048) return true;
    try {
      const parsed = new URL(url);
      return !["http:", "https:"].includes(parsed.protocol) || Boolean(parsed.username || parsed.password);
    } catch {
      return true;
    }
  });
  if (websiteUrlError) {
    setStatus(elements.profileSaveStatus, "Use an HTTP or HTTPS website URL without sign-in credentials, up to 2,048 characters.", "error");
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(nextProfile)).byteLength > 64 * 1024) {
    setStatus(elements.profileSaveStatus, "This profile is too large to save. Remove some long entries and try again.", "error");
    return;
  }
  setProfileBusy(true);
  setStatus(elements.profileSaveStatus, "Saving your profile…");
  try {
    const payload = await requestJson(PROFILE_PATH, {
      method: "PUT",
      body: JSON.stringify({ profile: nextProfile }),
    });
    profile = normalizeProfile(payload.profile ?? nextProfile);
    writeProfileForm(profile);
    setStatus(elements.profileSaveStatus, "Profile saved to your Scout account.", "success");
    setStatus(elements.pageStatus, "Profile saved. Review it before using it.", "success");
  } catch (error) {
    setStatus(elements.profileSaveStatus, error instanceof Error ? error.message : "Scout could not save your profile. Try again.", "error");
  } finally {
    setProfileBusy(false);
  }
});

elements.profileForm.elements.namedItem("hasPreferredName")?.addEventListener("change", updatePreferredNameFields);

elements.clearProfile.addEventListener("click", () => {
  if (profileSaving) return;
  profile = emptyProfile();
  writeProfileForm(profile);
  setStatus(elements.profileSaveStatus, "Fields cleared. Save profile to update Scout.");
  setStatus(elements.pageStatus, "Profile fields cleared. Save to update your Scout account.");
});

function addRecord(type) {
  const next = readProfileForm();
  if (type === "education") {
    if (next.education.length >= 12) {
      setStatus(elements.profileSaveStatus, "You can add up to 12 education entries.", "error");
      return;
    }
    next.education.push(normalizeRecord({}, EDUCATION_FIELDS));
  } else if (type === "experience") {
    if (next.experience.length >= 20) {
      setStatus(elements.profileSaveStatus, "You can add up to 20 work experience entries.", "error");
      return;
    }
    next.experience.push({ ...normalizeRecord({}, EXPERIENCE_FIELDS), currentlyWorkHere: null });
  } else if (type === "website") {
    next.websites.push({ url: "" });
  } else if (type === "language") {
    if (next.languages.length >= 20) {
      setStatus(elements.profileSaveStatus, "You can add up to 20 language entries.", "error");
      return;
    }
    next.languages.push({
      ...normalizeRecord({}, LANGUAGE_FIELDS),
      fluent: null,
    });
  } else {
    return;
  }
  profile = next;
  if (type === "education" || type === "experience") renderRecords(type, next[type]);
  else if (type === "website") renderWebsites(next.websites);
  else renderLanguages(next.languages);
  elements.profileEmpty.hidden = !isProfileEmpty(next);
  const container = type === "education" ? elements.educationList
    : type === "experience" ? elements.experienceList
      : type === "website" ? elements.websiteList : elements.languageList;
  const lastInput = container.querySelector(`[data-record-index="${container.querySelectorAll("[data-record-type]").length - 1}"] input, [data-record-index="${container.querySelectorAll("[data-record-type]").length - 1}"] select`);
  lastInput?.focus();
}

document.querySelectorAll("[data-add-record]").forEach((button) => {
  button.addEventListener("click", () => addRecord(button.dataset.addRecord));
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-record]");
  if (!button || profileSaving) return;
  const type = button.dataset.removeRecord;
  const next = readProfileForm();
  const lists = {
    education: next.education,
    experience: next.experience,
    website: next.websites,
    language: next.languages,
  };
  const list = lists[type];
  if (!Array.isArray(list)) return;
  list.splice(Number(button.dataset.index), 1);
  profile = next;
  if (type === "education" || type === "experience") renderRecords(type, list);
  else if (type === "website") renderWebsites(list);
  else renderLanguages(list);
  elements.profileEmpty.hidden = !isProfileEmpty(next);
});

function getAnswerFormValue(form) {
  const formData = new FormData(form);
  const value = {
    question: String(formData.get("question") ?? "").trim(),
    answerType: String(formData.get("answerType") ?? "text"),
  };
  const scope = {
    origin: String(formData.get("scopeOrigin") ?? "").trim(),
    country: String(formData.get("scopeCountry") ?? "").trim(),
    locale: String(formData.get("scopeLocale") ?? "").trim(),
  };
  const populatedScope = Object.fromEntries(Object.entries(scope).filter(([, fieldValue]) => fieldValue));
  if (Object.keys(populatedScope).length) value.scope = populatedScope;
  if (value.answerType === "text") {
    value.answer = String(formData.get("answer") ?? "").trim();
  } else if (value.answerType === "single-choice" || value.answerType === "multi-choice") {
    value.selectedChoices = String(formData.get("selectedChoices") ?? "")
      .split("\n")
      .map((choice) => choice.trim())
      .filter(Boolean);
  } else if (value.answerType === "boolean") {
    const answer = formData.get("booleanValue");
    value.booleanValue = answer === "true" ? true : answer === "false" ? false : null;
  }
  return value;
}

function setAnswerBusy(isBusy) {
  answerSaving = isBusy;
  elements.answerSave.disabled = isBusy;
  elements.answerSave.textContent = isBusy ? "Saving…" : "Save answer";
  for (const control of elements.answerForm.querySelectorAll("button, input, select, textarea")) control.disabled = isBusy;
  for (const control of elements.answerList.querySelectorAll("button, input, select, textarea")) control.disabled = isBusy;
}

async function saveAnswer(value, oldAnswer = null) {
  if (!value.question || value.question.length > 1000) {
    setStatus(elements.answerSaveStatus, "Add a question or prompt up to 1,000 characters.", "error");
    return;
  }
  if (value.answerType === "text" && (!value.answer || value.answer.length > 2000)) {
    setStatus(elements.answerSaveStatus, "Add a written answer up to 2,000 characters.", "error");
    return;
  }
  if (value.answerType === "single-choice" && (value.selectedChoices.length !== 1 || value.selectedChoices.some((choice) => choice.length > 500))) {
    setStatus(elements.answerSaveStatus, "Add exactly one option label, up to 500 characters.", "error");
    return;
  }
  if (value.answerType === "multi-choice" && (value.selectedChoices.length > 30 || value.selectedChoices.some((choice) => choice.length > 500))) {
    setStatus(elements.answerSaveStatus, "Add up to 30 exact option labels, each up to 500 characters.", "error");
    return;
  }
  if (value.answerType === "boolean" && typeof value.booleanValue !== "boolean") {
    setStatus(elements.answerSaveStatus, "Choose yes or no for this saved response.", "error");
    return;
  }
  if (answerSaving) return;
  setAnswerBusy(true);
  setStatus(elements.answerSaveStatus, "Saving your answer…");
  try {
    const savedPayload = await requestJson(ANSWERS_PATH, {
      method: "PUT",
      body: JSON.stringify(value),
    });
    const savedId = savedPayload?.answer?.id ?? savedPayload?.id ?? null;
    if (oldAnswer?.id && savedId && savedId !== oldAnswer.id) {
      try {
        await requestJson(ANSWERS_PATH, {
          method: "DELETE",
          body: JSON.stringify({ id: oldAnswer.id }),
        });
      } catch {
        await refreshAnswerList();
        setStatus(elements.answerSaveStatus, "The new answer was saved, but the previous prompt could not be removed. Delete it from the list when ready.", "error");
        return;
      }
    }
    await refreshAnswerList();
    if (!oldAnswer) elements.answerForm.reset();
    setStatus(elements.answerSaveStatus, "Answer saved to your Scout account.", "success");
  } catch (error) {
    setStatus(elements.answerSaveStatus, error instanceof Error ? error.message : "Scout could not save that answer. Try again.", "error");
  } finally {
    setAnswerBusy(false);
  }
}

elements.answerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.answerForm.reportValidity()) return;
  await saveAnswer(getAnswerFormValue(elements.answerForm));
});

elements.answerList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || answerSaving) return;
  const item = button.closest("[data-answer-id]");
  const answer = answers.find((entry) => entry.id === item?.dataset.answerId);
  if (!answer) return;

  if (button.hasAttribute("data-edit-answer")) {
    const editor = item.querySelector(".helper-answer-editor");
    editor.hidden = !editor.hidden;
    if (!editor.hidden) editor.querySelector("input")?.focus();
    return;
  }
  if (button.hasAttribute("data-cancel-edit")) {
    const editor = button.closest("form");
    editor.hidden = true;
    return;
  }
  if (button.hasAttribute("data-delete-answer")) {
    button.disabled = true;
    setStatus(elements.answerSaveStatus, "Deleting saved answer…");
    try {
      await requestJson(ANSWERS_PATH, {
        method: "DELETE",
        body: JSON.stringify({ id: answer.id }),
      });
      await refreshAnswerList();
      setStatus(elements.answerSaveStatus, "Answer deleted.", "success");
    } catch (error) {
      button.disabled = false;
      setStatus(elements.answerSaveStatus, error instanceof Error ? error.message : "Scout could not delete that answer. Try again.", "error");
    }
  }
});

elements.answerList.addEventListener("submit", async (event) => {
  const form = event.target.closest(".helper-answer-editor");
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity() || answerSaving) return;
  const item = form.closest("[data-answer-id]");
  const answer = answers.find((entry) => entry.id === item?.dataset.answerId);
  if (!answer) return;
  await saveAnswer(getAnswerFormValue(form), answer);
});

elements.retry.addEventListener("click", () => loadProfileData());
applySavedTheme();
elements.scoutOrigin.textContent = window.location.origin;
createAnswerFields(elements.answerForm);
loadProfileData();
