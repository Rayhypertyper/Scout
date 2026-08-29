/* global document, fetch, history, requestAnimationFrame, window */

const STEP_LABELS = ["Term", "Search boundary", "Eligibility"];
const SEASON_ORDER = new Map([["winter", 0], ["spring", 1], ["summer", 2], ["fall", 3]]);
const POPULAR_TECHNOLOGIES = ["Python", "JavaScript", "TypeScript", "React", "SQL", "Java", "C++", "AWS", "Git", "Docker"];
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function createSubmissionGate() {
  let active = false;
  return {
    enter() {
      if (active) return false;
      active = true;
      return true;
    },
    leave() {
      active = false;
    },
    isActive() {
      return active;
    },
  };
}

export function requiredCountries(state) {
  const answers = objectOrEmpty(state);
  return [...new Set([
    ...(Array.isArray(answers.countries) ? answers.countries : []),
    ...(Array.isArray(answers.cities) ? answers.cities.map((city) => city?.country) : []),
  ])].filter((country) => country === "canada" || country === "united_states");
}

export function stepForField(field) {
  const fieldName = typeof field === "string" ? field : "";
  if (fieldName === "terms" || fieldName.startsWith("terms.")) return 1;
  if (["countries", "cities", "remote", "roleCategories"].some((name) => fieldName === name || fieldName.startsWith(`${name}.`))) return 2;
  return 3;
}

export function validationIssuesForStep(step, state) {
  const answers = normalizePreferenceState(state);
  if (step === 1) {
    return answers.terms.length
      ? []
      : [{ field: "terms", message: "Add at least 1 internship term." }];
  }
  if (step === 2) {
    const issues = [];
    if (!(answers.countries.length || answers.cities.length || answers.remote)) {
      issues.push({ field: "countries", message: "Choose a country, a city, or remote roles." });
    }
    if (!answers.roleCategories.length) {
      issues.push({ field: "roleCategories", message: "Choose at least 1 role category." });
    }
    return issues;
  }
  const issues = [];
  if (!answers.degree) issues.push({ field: "degree", message: "Choose your current degree." });
  if (!answers.graduationYear) issues.push({ field: "graduationYear", message: "Choose your expected graduation year." });
  for (const country of requiredCountries(answers)) {
    const key = country === "canada" ? "canada" : "unitedStates";
    if (!answers.workAuthorization[key]) {
      issues.push({ field: `workAuthorization.${key}`, message: "Choose your work authorization status for this location." });
    }
    if (!answers.sponsorship[key]) {
      issues.push({ field: `sponsorship.${key}`, message: "Choose your sponsorship needs for this location." });
    }
  }
  return issues;
}

export function payloadForStep(step, state) {
  const answers = normalizePreferenceState(state);
  if (step === 1) return { terms: answers.terms.map((term) => ({ ...term })) };
  if (step === 2) {
    return {
      countries: [...answers.countries],
      cities: answers.cities.map((city) => ({ ...city })),
      remote: answers.remote,
      roleCategories: [...answers.roleCategories],
      technologies: [...answers.technologies],
    };
  }
  return {
    degree: answers.degree,
    graduationYear: answers.graduationYear,
    graduationYearOrLater: answers.graduationYearOrLater,
    workAuthorization: { ...answers.workAuthorization },
    sponsorship: { ...answers.sponsorship },
  };
}

export function previousStepState(step, state) {
  const current = Number(step);
  return { step: Number.isFinite(current) ? Math.max(1, current - 1) : 1, state };
}

export function emptyState() {
  return {
    terms: [],
    countries: [],
    cities: [],
    remote: false,
    roleCategories: [],
    technologies: [],
    degree: null,
    graduationYear: null,
    graduationYearOrLater: false,
    workAuthorization: { canada: null, unitedStates: null },
    sponsorship: { canada: null, unitedStates: null },
    onboardingCompleted: false,
    currentStep: 1,
  };
}

export function normalizePreferenceState(value = {}) {
  const source = objectOrEmpty(value);
  const base = emptyState();
  const workAuthorization = objectOrEmpty(source.workAuthorization);
  const sponsorship = objectOrEmpty(source.sponsorship);
  const currentStep = source.currentStep === 2 || source.currentStep === 3 ? source.currentStep : 1;
  return {
    ...base,
    ...source,
    terms: Array.isArray(source.terms) ? source.terms : base.terms,
    countries: Array.isArray(source.countries) ? source.countries : base.countries,
    cities: Array.isArray(source.cities) ? source.cities : base.cities,
    roleCategories: Array.isArray(source.roleCategories) ? source.roleCategories : base.roleCategories,
    technologies: Array.isArray(source.technologies) ? source.technologies : base.technologies,
    remote: source.remote === true,
    degree: source.degree || null,
    graduationYear: Number.isInteger(source.graduationYear) ? source.graduationYear : null,
    graduationYearOrLater: source.graduationYearOrLater === true,
    workAuthorization: { ...base.workAuthorization, ...workAuthorization },
    sponsorship: { ...base.sponsorship, ...sponsorship },
    onboardingCompleted: source.onboardingCompleted === true,
    currentStep,
  };
}

export function mergePreferenceState(previous, next) {
  const current = normalizePreferenceState(previous);
  const incoming = objectOrEmpty(next);
  return normalizePreferenceState({
    ...current,
    ...incoming,
    workAuthorization: { ...current.workAuthorization, ...objectOrEmpty(incoming.workAuthorization) },
    sponsorship: { ...current.sponsorship, ...objectOrEmpty(incoming.sponsorship) },
  });
}

export function mergeSavedStepState(previous, next, step) {
  const current = normalizePreferenceState(previous);
  const incoming = objectOrEmpty(next);
  const savedFields = step === 1
    ? ["terms"]
    : step === 2
      ? ["countries", "cities", "remote", "roleCategories", "technologies"]
      : ["degree", "graduationYear", "graduationYearOrLater", "workAuthorization", "sponsorship"];
  const merged = { ...current };
  for (const field of savedFields) {
    if (field in incoming) merged[field] = incoming[field];
  }
  for (const field of ["currentStep", "onboardingCompleted", "createdAt", "updatedAt", "completedAt"]) {
    if (field in incoming) merged[field] = incoming[field];
  }
  if (step === 3) {
    merged.workAuthorization = { ...current.workAuthorization, ...objectOrEmpty(incoming.workAuthorization) };
    merged.sponsorship = { ...current.sponsorship, ...objectOrEmpty(incoming.sponsorship) };
  }
  return normalizePreferenceState(merged);
}

export function graduationYearOptions(values = [], selectedYear = null) {
  const years = [...new Set([
    ...(Array.isArray(values) ? values : []),
    ...(Number.isInteger(selectedYear) ? [selectedYear] : []),
  ].map((value) => Number(value)).filter((value) => Number.isInteger(value)))]
    .toSorted((left, right) => left - right);
  const finalYear = years.at(-1) ?? null;
  return years.map((value) => {
    const label = value === finalYear ? `${value}+` : String(value);
    return { value: label, label };
  });
}

function optionElement(value, label, { selected = false } = {}) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}

function removeIcon() {
  return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function errorFromResponse(payload, status) {
  const message = payload?.error?.message || (status >= 200 && status < 300
    ? "The server returned an invalid response. Try again."
    : `Request failed (${status}). Try again.`);
  const error = new Error(message);
  error.status = status;
  error.code = payload?.error?.code || null;
  error.issues = payload?.error?.issues || (payload?.error?.field ? [{ field: payload.error.field, message }] : []);
  error.redirect = payload?.redirect || payload?.error?.redirect || null;
  return error;
}

async function readJsonResponse(response) {
  let payload = {};
  let parseFailed = false;
  try {
    payload = await response.json();
  } catch {
    parseFailed = true;
  }
  if (!response.ok) throw errorFromResponse(payload, response.status);
  if (parseFailed || payload?.ok !== true) throw errorFromResponse(payload, response.status);
  return payload;
}

function buildChoice({ name, value, label, checked = false, data = {} }) {
  const row = document.createElement("label");
  row.className = `choice-row${checked ? " is-selected" : ""}`;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.checked = checked;
  for (const [key, item] of Object.entries(data)) input.dataset[key] = item;
  input.addEventListener("change", () => row.classList.toggle("is-selected", input.checked));
  const text = document.createElement("span");
  text.textContent = label;
  row.append(input, text);
  return row;
}

function buildRadioChoice({ name, value, label, checked = false }) {
  const row = document.createElement("label");
  row.className = `choice-row${checked ? " is-selected" : ""}`;
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.addEventListener("change", () => {
    row.classList.toggle("is-selected", input.checked);
    if (input.checked) {
      row.parentElement?.querySelectorAll(`input[name="${name}"]`).forEach((candidate) => {
        if (candidate !== input) candidate.closest(".choice-row")?.classList.remove("is-selected");
      });
    }
  });
  const text = document.createElement("span");
  text.textContent = label;
  row.append(input, text);
  return row;
}

function fieldKeyForRegion(country) {
  return country === "canada" ? "canada" : "unitedStates";
}

function countryLabel(country) {
  return country === "canada" ? "Canada" : "United States";
}

function createRegionPanel(country, options, state) {
  const key = fieldKeyForRegion(country);
  const panel = document.createElement("section");
  panel.className = "region-panel";
  panel.id = `region-${country}`;
  panel.dataset.region = country;

  const heading = document.createElement("div");
  heading.className = "region-heading";
  const title = document.createElement("h2");
  title.textContent = countryLabel(country);
  const note = document.createElement("span");
  note.textContent = "Required for selected locations";
  heading.append(title, note);

  const questions = document.createElement("div");
  questions.className = "region-question-grid";

  const authorization = document.createElement("fieldset");
  authorization.className = "region-question";
  authorization.dataset.regionField = `workAuthorization.${key}`;
  const authorizationLegend = document.createElement("legend");
  authorizationLegend.textContent = `Can you currently work in ${countryLabel(country)}?`;
  authorization.append(authorizationLegend);
  const authorizationName = `workAuthorization${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  for (const option of options.workAuthorization || []) {
    authorization.append(buildRadioChoice({
      name: authorizationName,
      value: option.value,
      label: option.label.replace("Authorized to work", `Authorized to work in ${countryLabel(country)}`),
      checked: state.workAuthorization?.[key] === option.value,
    }));
  }
  const authorizationError = document.createElement("p");
  authorizationError.id = `region-${country}-authorization-error`;
  authorizationError.className = "region-error";
  authorizationError.role = "alert";
  authorizationError.hidden = true;
  authorization.setAttribute("aria-describedby", authorizationError.id);
  authorization.append(authorizationError);

  const sponsorship = document.createElement("fieldset");
  sponsorship.className = "region-question";
  sponsorship.dataset.regionField = `sponsorship.${key}`;
  const sponsorshipLegend = document.createElement("legend");
  sponsorshipLegend.textContent = `Will you need employer sponsorship in ${countryLabel(country)}?`;
  sponsorship.append(sponsorshipLegend);
  const sponsorshipName = `sponsorship${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  for (const option of options.sponsorship || []) {
    sponsorship.append(buildRadioChoice({
      name: sponsorshipName,
      value: option.value,
      label: option.label,
      checked: state.sponsorship?.[key] === option.value,
    }));
  }
  const sponsorshipError = document.createElement("p");
  sponsorshipError.id = `region-${country}-sponsorship-error`;
  sponsorshipError.className = "region-error";
  sponsorshipError.role = "alert";
  sponsorshipError.hidden = true;
  sponsorship.setAttribute("aria-describedby", sponsorshipError.id);
  sponsorship.append(sponsorshipError);

  questions.append(authorization, sponsorship);
  panel.append(heading, questions);
  return panel;
}

async function onboardingApp() {
  const mode = document.body?.dataset.preferenceMode === "edit" ? "edit" : "onboarding";
  const form = document.querySelector("#preference-form");
  const loading = document.querySelector("#preference-loading");
  const loadError = document.querySelector("#preference-load-error");
  const loadErrorMessage = document.querySelector("#preference-load-error-message");
  const submit = document.querySelector("#continue-button");
  const back = document.querySelector("#back-button");
  const saveState = document.querySelector("#save-state");
  const formError = document.querySelector("#form-error");
  const retry = document.querySelector("#retry-preferences");
  const stepCount = document.querySelector("#step-count");
  const progressState = document.querySelector("#progress-state");
  const progress = document.querySelector("#onboarding-progress");
  if (!form || !loading || !loadError || !loadErrorMessage || !submit || !back || !saveState || !formError || !retry || !stepCount || !progressState || !progress) return;

  const gate = createSubmissionGate();
  let state = emptyState();
  let options = {};
  let csrfToken = "";
  let currentStep = 1;
  let dirty = false;
  const dirtySteps = new Set();
  let navigating = false;
  let loadRequest = 0;
  let citySelector = null;
  let technologySelector = null;
  let createSearchMultiSelect = null;

  async function loadSearchMultiSelect() {
    const script = document.querySelector("script[data-selector-version]");
    const version = script?.dataset.selectorVersion?.trim();
    const specifier = version
      ? `./multi-select.js?v=${encodeURIComponent(version)}`
      : "./multi-select.js";
    const module = await import(specifier);
    if (typeof module.createSearchMultiSelect !== "function") {
      throw new Error("Search options could not be initialized. Refresh and try again.");
    }
    return module.createSearchMultiSelect;
  }

  function updateSaveState() {
    if (gate.isActive()) return;
    saveState.textContent = dirtySteps.has(currentStep)
      ? "Not saved on this step"
      : dirtySteps.size > 0
        ? "Unsaved answers on another step"
        : "Saved after each step";
  }

  function setDirty(next = true) {
    if (next) dirtySteps.add(currentStep);
    else dirtySteps.delete(currentStep);
    dirty = dirtySteps.size > 0;
    updateSaveState();
  }

  function selectedRadio(name) {
    return form.querySelector(`input[name="${name}"]:checked`)?.value || null;
  }

  function collectStep(step) {
    if (step === 1) return;
    if (step === 2) {
      state.countries = [...form.querySelectorAll('input[name="countries"]:checked')].map((input) => input.value);
      state.remote = Boolean(form.querySelector('input[name="remote"]:checked'));
      state.roleCategories = [...form.querySelectorAll('input[name="roleCategories"]:checked')].map((input) => input.value);
      state.cities = citySelector?.values() || [];
      state.technologies = (technologySelector?.values() || []).map(({ value }) => value);
      return;
    }
    const graduationControl = form.querySelector("#graduation-year");
    const degreeControl = form.querySelector("#degree");
    const graduationValue = graduationControl?.value || "";
    state.degree = degreeControl?.value || null;
    state.graduationYear = graduationValue ? Number.parseInt(graduationValue.replace(/\+$/, ""), 10) : null;
    state.graduationYearOrLater = graduationValue.endsWith("+");
    state.workAuthorization = {
      canada: selectedRadio("workAuthorizationCanada"),
      unitedStates: selectedRadio("workAuthorizationUnitedStates"),
    };
    state.sponsorship = {
      canada: selectedRadio("sponsorshipCanada"),
      unitedStates: selectedRadio("sponsorshipUnitedStates"),
    };
  }

  function clearErrors() {
    form.querySelectorAll(".field-error, .region-error").forEach((error) => {
      error.hidden = true;
      error.textContent = "";
    });
    form.querySelectorAll(".has-error").forEach((group) => {
      group.classList.remove("has-error");
      group.removeAttribute("aria-invalid");
    });
    form.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute("aria-invalid"));
    formError.hidden = true;
    formError.textContent = "";
  }

  function targetForIssue(field) {
    const fieldName = typeof field === "string" ? field : "";
    if (fieldName === "terms" || fieldName.startsWith("terms.")) return { group: form.querySelector("#term-group"), error: form.querySelector("#term-error") };
    if (fieldName === "countries" || fieldName === "cities" || fieldName === "remote") return { group: form.querySelector("#location-group"), error: form.querySelector("#location-error") };
    if (fieldName === "roleCategories" || fieldName.startsWith("roleCategories.")) return { group: form.querySelector("#role-group"), error: form.querySelector("#role-error") };
    if (fieldName === "degree" || fieldName === "graduationYear") return { group: form.querySelector("#education-group"), error: form.querySelector("#education-error") };
    const regional = [...form.querySelectorAll("[data-region-field]")]
      .find((candidate) => candidate.dataset.regionField === fieldName);
    return regional ? { group: regional, error: regional.querySelector(".region-error") } : null;
  }

  function showIssues(issues) {
    const earlierStep = issues
      .map((issue) => stepForField(issue.field))
      .find((step) => step < currentStep);
    if (earlierStep) {
      currentStep = earlierStep;
      renderStep();
    }
    clearErrors();
    let firstGroup = null;
    const grouped = new Map();
    for (const issue of issues) {
      const target = targetForIssue(issue.field);
      if (!target?.group || !target.error) continue;
      const existing = grouped.get(target.error) || [];
      grouped.set(target.error, [...existing, issue.message]);
      target.group.classList.add("has-error");
      target.group.setAttribute("aria-invalid", "true");
      target.group.querySelectorAll("input, select").forEach((control) => control.setAttribute("aria-invalid", "true"));
      if (!firstGroup) firstGroup = target.group;
    }
    for (const [error, messages] of grouped) {
      error.textContent = [...new Set(messages)].join(" ");
      error.hidden = false;
    }
    if (firstGroup) {
      firstGroup.tabIndex = -1;
      firstGroup.focus();
      firstGroup.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }

  function termLabel(term) {
    const season = options.seasons?.find(({ value }) => value === term.term)?.label || term.term;
    return `${season} ${term.year}`;
  }

  function renderTerms() {
    const list = form.querySelector("#selected-terms");
    const count = form.querySelector("#term-selection-count");
    if (!list || !count) return;
    list.replaceChildren();
    const sorted = [...state.terms].toSorted((left, right) => left.year - right.year
      || (SEASON_ORDER.get(left.term) ?? 9) - (SEASON_ORDER.get(right.term) ?? 9));
    if (sorted.length === 0) {
      const empty = document.createElement("li");
      empty.className = "is-empty";
      empty.textContent = "No terms added yet.";
      list.append(empty);
    } else {
      for (const term of sorted) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = termLabel(term);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.removeTerm = `${term.term}:${term.year}`;
        remove.setAttribute("aria-label", `Remove ${termLabel(term)}`);
        remove.innerHTML = removeIcon();
        item.append(label, remove);
        list.append(item);
      }
    }
    count.textContent = `${numberFormat.format(state.terms.length)} selected`;
  }

  function addTerm() {
    const seasonControl = form.querySelector("#term-season");
    const yearControl = form.querySelector("#term-year");
    const term = seasonControl?.value || "";
    const year = Number.parseInt(yearControl?.value || "", 10);
    const error = form.querySelector("#term-error");
    if (!term || !Number.isInteger(year)) {
      showIssues([{ field: "terms", message: "Choose a season and year before adding the term." }]);
      return;
    }
    if (state.terms.some((candidate) => candidate.term === term && candidate.year === year)) {
      showIssues([{ field: "terms", message: `${termLabel({ term, year })} is already selected.` }]);
      return;
    }
    state.terms = [...state.terms, { term, year }];
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    renderTerms();
    setDirty();
  }

  function renderRegionalVisibility() {
    const countries = requiredCountries(state);
    form.querySelectorAll("[data-region]").forEach((panel) => {
      panel.hidden = !countries.includes(panel.dataset.region);
    });
    const note = form.querySelector("#regional-eligibility-note");
    if (note) note.hidden = countries.length > 0;
  }

  function syncCheckboxes() {
    form.querySelectorAll('input[name="countries"]').forEach((input) => {
      input.checked = state.countries.includes(input.value);
      input.closest(".choice-row")?.classList.toggle("is-selected", input.checked);
    });
    const remote = form.querySelector('input[name="remote"]');
    if (remote) {
      remote.checked = state.remote;
      remote.closest(".choice-row")?.classList.toggle("is-selected", remote.checked);
    }
    form.querySelectorAll('input[name="roleCategories"]').forEach((input) => {
      input.checked = state.roleCategories.includes(input.value);
      input.closest(".choice-row")?.classList.toggle("is-selected", input.checked);
    });
  }

  function fillTermControls() {
    const season = form.querySelector("#term-season");
    const year = form.querySelector("#term-year");
    if (!season || !year) return;
    season.replaceChildren(...(options.seasons || []).map(({ value, label }) => optionElement(value, label)));
    const years = [...new Set([...(options.termYears || []), ...state.terms.map((term) => term.year)])].toSorted((left, right) => left - right);
    year.replaceChildren(...years.map((value) => optionElement(String(value), String(value))));
  }

  function fillEducationControls() {
    const degree = form.querySelector("#degree");
    const graduation = form.querySelector("#graduation-year");
    if (!degree || !graduation) return;
    degree.replaceChildren(optionElement("", "Choose Degree"), ...(options.degrees || []).map(({ value, label }) => optionElement(value, label)));
    degree.value = state.degree || "";
    const yearOptions = graduationYearOptions(options.graduationYears, state.graduationYear);
    graduation.replaceChildren(
      optionElement("", "Choose Year"),
      ...yearOptions.map(({ value, label }) => optionElement(value, label)),
    );
    graduation.value = state.graduationYear
      ? `${state.graduationYear}${state.graduationYearOrLater ? "+" : ""}`
      : "";
    if (state.graduationYear && ![...graduation.options].some((item) => item.value === graduation.value)) {
      graduation.append(optionElement(graduation.value, graduation.value, { selected: true }));
    }
  }

  function syncPopularTechnologyButtons() {
    const selectedValues = new Set((technologySelector?.values() || []).map(({ value }) => value));
    const atMaximum = selectedValues.size >= 12;
    form.querySelectorAll("#popular-technologies-options [data-technology]").forEach((button) => {
      const selected = selectedValues.has(button.dataset.technology || "");
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !selected && atMaximum;
    });
  }

  function renderPopularTechnologies(technologyOptions) {
    const group = form.querySelector("#popular-technologies");
    const container = form.querySelector("#popular-technologies-options");
    if (!group || !container) return;

    const available = new Set(technologyOptions.map(({ value }) => value));
    const popular = POPULAR_TECHNOLOGIES.filter((value) => available.has(value));
    container.replaceChildren();
    for (const value of popular) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "popular-technology";
      button.dataset.technology = value;
      button.setAttribute("aria-pressed", "false");
      button.textContent = value;
      button.addEventListener("click", () => {
        technologySelector?.toggle(value);
        syncPopularTechnologyButtons();
      });
      container.append(button);
    }
    group.hidden = popular.length === 0;
    syncPopularTechnologyButtons();
  }

  function buildOptionControls() {
    const countryOptions = form.querySelector("#country-options");
    const roleOptions = form.querySelector("#role-options");
    const regional = form.querySelector("#regional-eligibility");
    if (!countryOptions || !roleOptions || !regional) return;
    countryOptions.replaceChildren();
    for (const option of options.countries || []) {
      countryOptions.append(buildChoice({ name: "countries", value: option.value, label: option.label, checked: state.countries.includes(option.value) }));
    }
    countryOptions.append(buildChoice({ name: "remote", value: "remote", label: "Remote", checked: state.remote }));

    roleOptions.replaceChildren();
    for (const option of options.roleCategories || []) {
      roleOptions.append(buildChoice({ name: "roleCategories", value: option.value, label: option.label, checked: state.roleCategories.includes(option.value) }));
    }

    regional.querySelectorAll("[data-region]").forEach((panel) => panel.remove());
    regional.prepend(
      createRegionPanel("canada", options, state),
      createRegionPanel("united_states", options, state),
    );
  }

  function setupSearchSelectors() {
    if (typeof createSearchMultiSelect !== "function") throw new Error("Search options could not be initialized. Refresh and try again.");
    const cityOptions = (Array.isArray(options.cities) ? options.cities : []).filter((city) => city && typeof city === "object").map((city) => ({
      ...city,
      value: `${city.country}:${city.name}`,
      label: city.name,
      detail: `${city.region} · ${countryLabel(city.country)}`,
    }));
    citySelector = createSearchMultiSelect({
      input: form.querySelector("#city-search"),
      list: form.querySelector("#city-options"),
      selectedList: form.querySelector("#selected-cities"),
      options: cityOptions,
      keyForOption: (city) => city.value,
      labelForOption: (city) => `${city.name}, ${city.region}`,
      detailForOption: (city) => city.detail,
      emptyLabel: "No specific cities selected.",
      selectionContext: "selected cities",
      maximum: 12,
      onChange: (values) => {
        state.cities = values.map(({ name, country }) => ({ name, country }));
        renderRegionalVisibility();
        setDirty();
      },
    });
    citySelector.setValues(state.cities
      .filter((city) => city && typeof city === "object")
      .map((city) => cityOptions.find((option) => option.country === city.country && option.name === city.name))
      .filter(Boolean));

    const technologyOptions = (options.technologies || []).map((value) => ({ value, label: value }));
    technologySelector = createSearchMultiSelect({
      input: form.querySelector("#technology-search"),
      list: form.querySelector("#technology-options"),
      selectedList: form.querySelector("#selected-technologies"),
      options: technologyOptions,
      emptyLabel: "No technologies selected.",
      selectionContext: "selected technologies",
      maximum: 12,
      onChange: (values) => {
        state.technologies = values.map(({ value }) => value);
        setDirty();
      },
    });
    technologySelector.setValues(state.technologies.map((value) => ({ value, label: value })));
    renderPopularTechnologies(technologyOptions);
  }

  function renderStep({ focus = false } = {}) {
    form.querySelectorAll("[data-step]").forEach((section) => {
      const active = Number(section.dataset.step) === currentStep;
      section.hidden = !active;
      section.classList.remove("is-entering");
      if (active) {
        requestAnimationFrame(() => section.classList.add("is-entering"));
        if (focus) {
          const heading = section.querySelector("h1");
          if (heading) {
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }
          window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        }
      }
    });
    form.querySelectorAll("[data-step-index]").forEach((item) => {
      const step = Number(item.dataset.stepIndex);
      if (step === currentStep) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      item.classList.toggle("is-complete", step < currentStep);
    });
    stepCount.textContent = `${currentStep} of 3`;
    progressState.textContent = STEP_LABELS[currentStep - 1];
    progress.setAttribute("aria-valuenow", String(currentStep));
    progress.style.setProperty("--progress", String(currentStep / 3));
    back.hidden = currentStep === 1;
    submit.textContent = currentStep === 3
      ? mode === "edit" ? "Save Preferences" : "See My Matches"
      : "Save & Continue";
    clearErrors();
    renderRegionalVisibility();
    updateSaveState();
  }

  function setSaving(saving) {
    form.setAttribute("aria-busy", String(saving));
    submit.disabled = saving;
    back.disabled = saving;
    saveState.textContent = saving
      ? "Saving…"
      : dirtySteps.has(currentStep)
        ? "Not saved on this step"
        : dirtySteps.size > 0
          ? "Unsaved answers on another step"
          : "Step saved";
    if (saving) submit.textContent = "Saving…";
    else {
      submit.textContent = currentStep === 3
        ? mode === "edit" ? "Save Preferences" : "See My Matches"
        : "Save & Continue";
    }
  }

  async function saveCurrentStep() {
    collectStep(currentStep);
    const issues = validationIssuesForStep(currentStep, state);
    if (issues.length > 0) {
      showIssues(issues);
      return;
    }
    if (!gate.enter()) return;
    clearErrors();
    setSaving(true);
    try {
      const response = await fetch(`/api/preferences/steps/${currentStep}`, {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(payloadForStep(currentStep, state)),
      });
      const payload = await readJsonResponse(response);
      if (!payload.preferences || typeof payload.preferences !== "object") {
        throw new Error("Your answers could not be confirmed. Try again.");
      }
      state = mergeSavedStepState(state, payload.preferences, currentStep);
      setDirty(false);
      if (currentStep < 3) {
        currentStep += 1;
        renderStep({ focus: true });
      } else {
        navigating = true;
        history.replaceState(history.state, "", window.location.pathname);
        window.location.assign(payload.redirect || "/jobs?view=all&tab=main&sort=posted");
      }
    } catch (error) {
      if (error.redirect) {
        navigating = true;
        window.location.assign(error.redirect);
        return;
      }
      if (error.status === 401) {
        navigating = true;
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (error.issues?.length) showIssues(error.issues);
      formError.textContent = error.message || "Preferences could not be saved. Your answers are still here; try again.";
      formError.hidden = false;
      saveState.textContent = "Save failed · answers retained";
    } finally {
      gate.leave();
      if (!navigating) setSaving(false);
    }
  }

  async function loadPreferences() {
    const requestId = ++loadRequest;
    retry.disabled = true;
    loading.hidden = false;
    loadError.hidden = true;
    form.hidden = true;
    try {
      createSearchMultiSelect = await loadSearchMultiSelect();
      const response = await fetch("/api/preferences", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      if (requestId !== loadRequest) return;
      if (!payload.preferences || typeof payload.preferences !== "object" || !payload.options || typeof payload.options !== "object") {
        throw new Error("Saved preferences could not be loaded. Try again.");
      }
      options = objectOrEmpty(payload.options);
      state = mergePreferenceState(emptyState(), payload.preferences);
      csrfToken = payload.csrfToken || "";
      currentStep = mode === "edit" ? 1 : Math.max(1, Math.min(3, Number(state.currentStep) || 1));
      fillTermControls();
      fillEducationControls();
      buildOptionControls();
      setupSearchSelectors();
      syncCheckboxes();
      renderTerms();
      renderStep();
      setDirty(false);
      loading.hidden = true;
      form.hidden = false;
    } catch (error) {
      if (requestId !== loadRequest) return;
      if (error.status === 401) {
        navigating = true;
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      loading.hidden = true;
      loadErrorMessage.textContent = error.message || "Check your connection, then try again.";
      loadError.hidden = false;
    } finally {
      if (requestId === loadRequest) retry.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCurrentStep();
  });
  form.querySelector("#add-term")?.addEventListener("click", addTerm);
  form.querySelector("#selected-terms")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-remove-term]");
    if (!button) return;
    const [term, year] = button.dataset.removeTerm.split(":");
    state.terms = state.terms.filter((candidate) => !(candidate.term === term && candidate.year === Number(year)));
    renderTerms();
    setDirty();
  });
  back.addEventListener("click", () => {
    if (currentStep <= 1 || gate.isActive()) return;
    collectStep(currentStep);
    currentStep = previousStepState(currentStep, state).step;
    renderStep({ focus: true });
  });
  form.addEventListener("change", (event) => {
    const target = event.target;
    let answerChanged = false;
    if (target.matches?.('input[name="countries"], input[name="remote"], input[name="roleCategories"]')) {
      collectStep(2);
      renderRegionalVisibility();
      answerChanged = true;
    } else if (target?.matches?.("#degree, #graduation-year") || target?.type === "radio") {
      collectStep(3);
      answerChanged = true;
    }
    if (!answerChanged) return;
    const targetGroup = target.closest(".field-group, .region-question");
    targetGroup?.classList.remove("has-error");
    targetGroup?.removeAttribute("aria-invalid");
    targetGroup?.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute("aria-invalid"));
    const error = targetGroup?.querySelector(".field-error, .region-error");
    if (error) error.hidden = true;
    formError.hidden = true;
    formError.textContent = "";
    setDirty();
  });
  retry.addEventListener("click", () => void loadPreferences());
  window.addEventListener("beforeunload", (event) => {
    if (!dirty || navigating) return;
    event.preventDefault();
    event.returnValue = "";
  });

  void loadPreferences();
}

if (typeof document !== "undefined") void onboardingApp();
