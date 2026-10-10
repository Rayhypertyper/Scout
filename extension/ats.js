/* global CSS, DataTransfer, Element, Event, File, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, KeyboardEvent, MouseEvent, MutationObserver, Node, URL, atob, chrome, clearInterval, clearTimeout, document, getComputedStyle, location, setInterval, setTimeout, window */
(() => {
  if (globalThis.ScoutFormHelper) return;

  const ANSWER_CONTRACT = globalThis.ScoutAnswerContract;
  const ATS_HOSTS = ["greenhouse.io", "greenhouse.com", "lever.co", "ashbyhq.com"];
  const HARD_BLOCKED_FIELD = /password|passcode|captcha|recaptcha|hcaptcha|beecatcher|website bot|robot|security code|one.?time code|social security|\bssn\b|bank|credit card|payment|create account|sign in|log in|login|account credential/i;
  const REVIEW_REQUIRED_FIELD = /race|ethnicity|gender|pronoun|veteran|disabilit|medical|pregnan|religion|sexual orientation|date of birth|birth date|\bage\b|\bcitizen(?:ship)?\b|nationality|country of (?:birth|origin)|place of birth|birth country|country (?:were you )?born in|national origin|permanent resident|legally entitled to work|legally allowed to work|entitled to work|allowed to work|consent|privacy policy|terms of service|agree to (?:the )?(?:terms|conditions|statement)|certify|attest|acknowledge|authorization|authorized to work|eligible to work|work authorization|sponsorship|visa status|immigration status|employment eligibility/i;
  const CONFIRMATION_PATTERNS = [
    /\bapplication (?:has been |was |is )?received\b/i,
    /\bapplication (?:was )?submitted(?: successfully)?\b/i,
    /\bthank you for applying\b/i,
    /\bthanks for applying\b/i,
    /\bwe (?:have )?received your application\b/i,
    /\bapplication complete\b/i,
    /\bsuccessfully applied\b/i,
  ];
  const applicationRouteListeners = new Set();
  let applicationRoutePoll = 0;
  let observedApplicationUrl = "";
  let programmaticWorkdayPickerKey = "";

  function observeApplicationRoutes(listener) {
    applicationRouteListeners.add(listener);
    if (!applicationRoutePoll) {
      observedApplicationUrl = location.href;
      const checkRoute = () => {
        const nextUrl = location.href;
        if (nextUrl === observedApplicationUrl) return;
        observedApplicationUrl = nextUrl;
        for (const callback of [...applicationRouteListeners]) callback(nextUrl);
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: "scout.applicationRouteChanged", url: nextUrl }).catch(() => undefined);
        }
      };
      window.addEventListener("popstate", checkRoute);
      window.addEventListener("hashchange", checkRoute);
      applicationRoutePoll = setInterval(checkRoute, 500);
    }
    return () => {
      applicationRouteListeners.delete(listener);
      if (applicationRouteListeners.size || !applicationRoutePoll) return;
      clearInterval(applicationRoutePoll);
      applicationRoutePoll = 0;
      observedApplicationUrl = "";
    };
  }

  function confirmationMatch(text) {
    for (const pattern of CONFIRMATION_PATTERNS) {
      const match = String(text ?? "").match(pattern);
      if (match?.[0]) return match[0].normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    }
    return "";
  }

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizedKey(value) {
    return ANSWER_CONTRACT.normalizeQuestion(value);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function textOf(element) {
    return String(element?.innerText ?? element?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function cleanVisibleQuestion(value) {
    return normalize(value).replace(/(?:\s*(?:\*|\(\s*required\s*\)|\brequired\b))+\s*$/i, "").trim();
  }

  function visibleLabelsFor(element) {
    const labels = [];
    if (element instanceof HTMLInputElement && element.type === "radio") {
      const legend = element.closest("fieldset")?.querySelector("legend");
      if (legend) labels.push(textOf(legend));
    } else {
      for (const label of Array.from(element.labels ?? [])) {
        const text = textOf(label);
        if (text) labels.push(text);
      }
      const legend = element.closest("fieldset")?.querySelector("legend");
      if (legend) labels.unshift(textOf(legend));
    }
    const aria = element.getAttribute("aria-label");
    if (aria) labels.push(aria);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const label = document.getElementById(id);
        if (label) labels.push(textOf(label));
      }
    }
    return [...new Set(labels.map(cleanVisibleQuestion).filter(Boolean))];
  }

  function groupQuestionFor(element) {
    const fieldset = element.closest("fieldset");
    const legend = fieldset?.querySelector(":scope > legend") ?? fieldset?.querySelector("legend");
    if (legend && textOf(legend)) return cleanVisibleQuestion(textOf(legend));

    const group = element.closest('[role="radiogroup"], [role="group"], [role="checkboxgroup"]');
    if (group) {
      const aria = group.getAttribute("aria-label");
      if (aria && cleanVisibleQuestion(aria)) return cleanVisibleQuestion(aria);
      const labelledBy = group.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labels = labelledBy.split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean);
        if (labels.length) return cleanVisibleQuestion(labels.join(" "));
      }
    }

    const workdayField = element.closest('[data-automation-id^="formField-"]');
    if (workdayField) {
      let text = textOf(workdayField);
      const optionLabels = Array.from(workdayField.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
        .map(choiceLabel).filter(Boolean).sort((left, right) => right.length - left.length);
      for (const option of optionLabels) text = text.replace(option, " ");
      text = cleanVisibleQuestion(text);
      if (text) return text;
    }

    const direct = element.closest(".form-group, .field, [class*=field]");
    const title = direct?.querySelector(":scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [aria-label]");
    if (title && !title.contains(element)) {
      const text = textOf(title);
      if (text) return cleanVisibleQuestion(text);
    }
    return "";
  }

  function questionFor(element, kind) {
    if (isWorkdayQuestionnaireControl(element)) {
      return workdayQuestionnairePrompt(element);
    }
    if (isWorkdayHost() && element instanceof HTMLInputElement) {
      const identity = `${element.id} ${element.getAttribute("name") ?? ""}`;
      if (/name--preferredName--firstName|preferredName--firstName/.test(identity)) return "Preferred first name";
      if (/name--preferredName--lastName|preferredName--lastName/.test(identity)) return "Preferred last name";
    }
    if (isWorkdayHost() && element instanceof HTMLTextAreaElement
      && element.matches('textarea[id^="primaryQuestionnaire--"]')) {
      return workdayQuestionnairePrompt(element);
    }
    if (kind === "radio" || kind === "checkbox") {
      const groupQuestion = groupQuestionFor(element);
      if (groupQuestion) return groupQuestion;
      const labels = visibleLabelsFor(element);
      if (labels.length) return labels[0];
      const aria = element.getAttribute("aria-label");
      if (aria) return cleanVisibleQuestion(aria);
      const groupName = element.getAttribute("name") || element.id;
      return cleanVisibleQuestion(groupName.replace(/[_-]+/g, " "));
    }
    const labels = visibleLabelsFor(element);
    if (!labels.length) {
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) labels.push(placeholder);
    }
    return labels.join(" ").replace(/\s+/g, " ").trim();
  }

  function fieldMetadata(element) {
    return ["autocomplete", "name", "id", "data-qa", "data-automation-id", "placeholder"]
      .map((attribute) => element.getAttribute(attribute) ?? "")
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ");
  }

  function isMutable(element) {
    return !element.disabled && !element.readOnly && !element.closest("fieldset[disabled]");
  }

  function isLabeledDocumentUpload(element) {
    if (!(element instanceof HTMLInputElement) || element.type !== "file") return false;
    const form = element.closest("form");
    if (!form || !isVisible(form)) return false;
    const labels = Array.from(element.labels ?? []).filter(isVisible).map(textOf);
    const externalLabel = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    if (externalLabel && isVisible(externalLabel)) labels.push(textOf(externalLabel));
    const wrapper = element.closest("label, fieldset, .form-group, .field, [data-testid*='upload'], [class*='upload']");
    if (wrapper && isVisible(wrapper)) labels.push(textOf(wrapper));
    return /resume|curriculum vitae|\bcv\b|cover letter/i.test(labels.join(" "));
  }

  function workdayResumeUpload(element) {
    return Boolean(workdayResumeUploadKind(element));
  }

  function workdayResumeUploadKind(element) {
    if (!isWorkdayHost() || !(element instanceof HTMLInputElement) || element.type !== "file"
      || element.getAttribute("data-automation-id") !== "file-upload-input-ref") return "";
    const applicationField = element.closest('[data-automation-id^="formField-"]');
    if (!applicationField || !isVisible(applicationField)) return "";
    if (element.multiple) {
      const widget = element.closest('[data-automation-id="attachments-FileUpload"]');
      const selectFiles = widget?.querySelector('#resumeAttachments--attachments[data-automation-id="select-files"]');
      return widget && isVisible(widget) && selectFiles && isVisible(selectFiles) ? "shared-resume-cv" : "";
    }
    const parser = element.closest('[data-automation-id="resumeUpload"]');
    const selectFile = parser?.querySelector('button[data-automation-id="select-files"]');
    return parser && isVisible(parser) && selectFile && isVisible(selectFile)
      && normalizedKey(textOf(selectFile)) === "select file" ? "resume-parser" : "";
  }

  function fileUploadAlreadyHasItems(input) {
    if (input.files?.length) return true;
    const widget = input.closest('[data-automation-id="attachments-FileUpload"], [data-automation-id="resumeUpload"]');
    return Boolean(widget?.querySelector('[data-automation-id="file-upload-item"], [data-automation-id="file-upload-successful"]'));
  }

  function isSupportedStoredDocument(doc) {
    if (!doc || typeof doc.name !== "string" || typeof doc.type !== "string"
      || typeof doc.base64 !== "string" || !Number.isFinite(doc.size)
      || doc.size <= 0 || doc.size > 5 * 1024 * 1024) return false;
    const extension = doc.name.split(".").pop()?.toLowerCase();
    return (extension === "pdf" && doc.type.toLowerCase() === "application/pdf")
      || (extension === "docx" && doc.type.toLowerCase() === "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }

  function choiceLabel(input) {
    const associated = Array.from(input.labels ?? []).map(textOf).filter(Boolean);
    return associated.join(" ") || input.value || "";
  }

  function collectDescriptors() {
    const candidates = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter((element) => !["hidden", "submit", "button", "reset", "image"].includes(element.type)
        && !isWorkdayRepeatableElement(element)
        && (isVisible(element) || (element instanceof HTMLInputElement && element.type === "file"
          && (isLabeledDocumentUpload(element) || workdayResumeUpload(element)))));
    const descriptors = [];
    const radioGroups = new Map();
    const checkboxGroups = new Map();

    for (const [candidateIndex, element] of candidates.entries()) {
      if (element instanceof HTMLInputElement && element.type === "radio") {
        const key = element.name || `radio:${descriptors.length}`;
        const group = radioGroups.get(key) ?? [];
        group.push(element);
        radioGroups.set(key, group);
        continue;
      }
      if (element instanceof HTMLInputElement && element.type === "checkbox") {
        const observedRaceGroup = isWorkdayHost()
          ? element.closest('[data-automation-id="formField-ethnicityMulti"]') : null;
        const semanticGroup = observedRaceGroup
          || element.closest('fieldset, [role="checkboxgroup"], [role="group"]');
        const sameTypeControls = semanticGroup
          ? semanticGroup.querySelectorAll('input[type="checkbox"]').length > 1 : false;
        const key = element.name || (observedRaceGroup
          ? "workday:ethnicityMulti"
          : sameTypeControls
            ? `checkbox-group:${semanticGroup.getAttribute("data-automation-id") || semanticGroup.id || normalizedKey(groupQuestionFor(element))}`
            : `checkbox:${element.id || candidateIndex}`);
        const group = checkboxGroups.get(key) ?? [];
        group.push(element);
        checkboxGroups.set(key, group);
        continue;
      }
      const kind = element instanceof HTMLInputElement && element.type === "file"
        ? "file"
        : element instanceof HTMLSelectElement && element.multiple ? "multi-select" : "text";
      descriptors.push({
        element,
        kind,
        question: workdayResumeUploadKind(element) === "resume-parser" ? "Resume" : workdayResumeUpload(element) ? "Resume / CV attachments" : questionFor(element, kind),
        choices: [],
      });
    }

    for (const group of radioGroups.values()) {
      descriptors.push({ element: group[0], kind: "radio", question: questionFor(group[0], "radio"), choices: group });
    }
    for (const group of checkboxGroups.values()) {
      descriptors.push({ element: group[0], kind: "checkbox", question: questionFor(group[0], "checkbox"), choices: group });
    }
    return descriptors.sort((a, b) => {
      const relation = a.element.compareDocumentPosition(b.element);
      return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : relation & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
  }

  function isWorkdayQuestionnaireControl(element) {
    return isWorkdayHost() && element instanceof HTMLButtonElement
      && element.matches('button[id^="primaryQuestionnaire--"][aria-haspopup="listbox"]');
  }

  function workdayQuestionnairePrompt(element) {
    const fieldset = element?.closest("fieldset");
    const legend = fieldset?.querySelector(":scope > legend");
    return cleanVisibleQuestion(textOf(legend));
  }

  function collectWorkdayQuestionnaireDescriptors() {
    if (!isWorkdayHost()) return [];
    return Array.from(document.querySelectorAll('button[id^="primaryQuestionnaire--"][aria-haspopup="listbox"]'))
      .filter((element) => isVisible(element) && isMutable(element))
      .map((element) => ({
        element,
        kind: "workday-questionnaire",
        question: workdayQuestionnairePrompt(element),
        choices: [],
      }))
      .filter((descriptor) => descriptor.question);
  }

  function inspectPage(payload = {}) {
    const host = location.hostname.toLowerCase();
    const hostKnown = ATS_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
    const workday = isWorkdayHost(host);
    if (workday) return inspectWorkdayPage(payload);
    const iframeCount = document.querySelectorAll("iframe").length;
    const descriptors = collectDescriptors();
    assignProfileIndexes(descriptors);
    const visibleFieldCount = descriptors.length;
    let manualReason = "";
    if (!hostKnown) manualReason = "This custom application page is outside the supported Greenhouse, Lever, and Ashby patterns.";
    else if (!visibleFieldCount && iframeCount > 0) manualReason = "The application form is inside an embedded frame. Scout does not fill across frames.";
    else if (!visibleFieldCount) manualReason = "No visible application fields were found.";
    const h1 = Array.from(document.querySelectorAll("h1")).find(isVisible);
    const pageTitle = textOf(h1) || document.title.trim();
    const confirmationText = (document.body?.innerText ?? "").slice(0, 20_000);
    const confirmationDetected = CONFIRMATION_PATTERNS.some((pattern) => pattern.test(confirmationText));
    const company = inferCompany(host);
    const unknownQuestions = [];
    const seen = new Set();
    for (const descriptor of descriptors) {
      const question = descriptor.question;
      if (!question || isHardBlocked(descriptorPrompt(descriptor)) || isWorkdayNonReusableConsent(descriptor)
        || !isMutable(descriptor.element) || descriptor.kind === "file") continue;
      if (!isBlank(descriptor)) continue;
      if (answerFor(descriptor, payload.profile ?? {}, payload.answers ?? {}, payload).applicable) continue;
      const normalizedQuestion = normalizedKey(question);
      if (!normalizedQuestion || seen.has(normalizedQuestion)) continue;
      seen.add(normalizedQuestion);
      unknownQuestions.push(unknownRecord(descriptor, {}, payload));
    }
    return {
      supported: !manualReason,
      ats: host.includes("greenhouse") ? "Greenhouse" : host.includes("lever") ? "Lever" : host.includes("ashby") ? "Ashby" : "Custom",
      host,
      title: pageTitle,
      company: company.name,
      companyCandidate: company.candidate,
      applicationUrl: location.href,
      location: "",
      manualReason,
      formCount: document.querySelectorAll("form").length,
      visibleFieldCount,
      iframeCount,
      iframeWarning: iframeCount > 0 && visibleFieldCount > 0 ? "Fields inside embedded frames remain manual." : "",
      confirmationDetected,
      unknownQuestions,
    };
  }

  function isWorkdayHost(host = location.hostname) {
    const normalized = String(host).toLowerCase();
    return normalized === "myworkdayjobs.com" || normalized.endsWith(".myworkdayjobs.com");
  }

  function workdayApplicationPath(pathname = location.pathname) {
    return /\/job\/[^/]+\/[^/]+\/apply(?:\/|$)/i.test(pathname);
  }

  function workdayListingDescription() {
    const description = Array.from(document.querySelectorAll('[data-automation-id="jobPostingDescription"]'))
      .filter((element) => isVisible(element))
      .map((element) => normalize(textOf(element)))
      .find((text) => text.length >= 40) ?? "";
    if (!description) return "";
    const header = Array.from(document.querySelectorAll('[data-automation-id="jobPostingHeader"]'))
      .find((element) => isVisible(element));
    const locations = Array.from(document.querySelectorAll('[data-automation-id="locations"], [data-automation-id="location"]'))
      .filter((element) => isVisible(element))
      .slice(0, 5)
      .map((element) => normalize(textOf(element)))
      .filter(Boolean);
    return [header ? normalize(textOf(header)).slice(0, 500) : "", ...locations.map((text) => text.slice(0, 200)), description]
      .filter(Boolean).join("\n\n").slice(0, 20_000);
  }

  function workdayJobLocationEvidence() {
    const nodes = Array.from(document.querySelectorAll('[data-automation-id="locations"], [data-automation-id="location"]'))
      .filter((element) => isVisible(element)
        && !(element.getAttribute("data-automation-id") === "locations"
          && element.querySelector('[data-automation-id="location"]')));
    return [...new Set(nodes.map((element) => normalize(textOf(element)).slice(0, 500)).filter(Boolean))].slice(0, 8);
  }

  function readWorkdayJobDescription(expectedJobKey) {
    if (!isWorkdayHost(location.hostname) || workdayApplicationPath()
      || !expectedJobKey || ANSWER_CONTRACT.workdayJobKey(location.href) !== expectedJobKey) {
      return { available: false, reason: "The public posting did not match this Workday job." };
    }
    const description = workdayListingDescription();
    const jobCountryEvidence = workdayJobLocationEvidence();
    return {
      available: description.length >= 40,
      listingRead: true,
      ...(description.length >= 40 ? { jobDescription: description } : {}),
      ...(description.length < 40 ? { reason: "The public Workday posting did not expose enough job description text." } : {}),
      jobKey: expectedJobKey,
      postingUrl: location.href,
      jobCountryEvidence,
      applicationCountry: ANSWER_CONTRACT.inferWorkdayJobCountry(location.href, jobCountryEvidence),
    };
  }

  function writtenDraftDescriptor(descriptor, previousDraft = "") {
    const element = descriptor?.element;
    if (!isWorkdayHost(location.hostname) || !workdayApplicationPath() || descriptor?.kind !== "text"
      || !(element instanceof HTMLTextAreaElement) || !isVisible(element) || !isMutable(element)
      || (String(element.value ?? "").trim() && String(element.value ?? "") !== String(previousDraft ?? ""))) return false;
    const prompt = descriptorPrompt(descriptor);
    return !isHardBlocked(prompt) && !isReviewRequired(prompt) && !isWorkdayNonReusableConsent(descriptor)
      && ANSWER_CONTRACT.isWrittenNarrativePrompt(descriptor.question);
  }

  function writtenDraftField(question, applicationUrl = location.href, previousDraft = "") {
    if (String(applicationUrl) !== location.href || !isWorkdayHost(location.hostname) || !workdayApplicationPath()) {
      return { eligible: false, reason: "The Workday application page changed." };
    }
    const report = inspectWorkdayPage();
    if (!report.supported || normalizedKey(report.workdayStep) === "review") {
      return { eligible: false, reason: report.manualReason || "Written drafts are unavailable on this Workday step." };
    }
    const matches = collectDescriptors().filter((descriptor) => normalizedKey(descriptor.question) === normalizedKey(question)
      && writtenDraftDescriptor(descriptor, previousDraft));
    if (matches.length !== 1) {
    const sameQuestion = collectDescriptors().some((descriptor) => normalizedKey(descriptor.question) === normalizedKey(question));
      return { eligible: false, reason: sameQuestion ? "That answer is no longer blank or is not an eligible professional response." : "That question is no longer on this page." };
    }
    const control = matches[0].element;
    if (String(control.value ?? "").trim() && String(control.value ?? "") !== String(previousDraft ?? "")) {
      return { eligible: false, reason: "That answer now contains text and is protected from replacement." };
    }
    const nativeLimit = Number(control.maxLength);
    const maxLength = Math.min(nativeLimit > 0 ? nativeLimit : 2_000, 2_000);
    return { eligible: true, question: matches[0].question, maxLength, fieldKey: workdayFieldKey(control) };
  }

  function applyWrittenDraft(request = {}) {
    const question = typeof request.question === "string" ? request.question : "";
    const draft = typeof request.draft === "string" ? request.draft.trim() : "";
    const field = writtenDraftField(question, request.applicationUrl, request.previousDraft);
    if (!field.eligible) return { applied: false, reason: "STALE_OR_INELIGIBLE", message: field.reason };
    if (!draft || draft.length > field.maxLength) return { applied: false, reason: "INVALID_DRAFT", message: "The reviewed draft is empty or exceeds this field’s length limit." };
    const descriptor = collectDescriptors().find((item) => normalizedKey(item.question) === normalizedKey(question)
      && writtenDraftDescriptor(item, request.previousDraft));
    if (!descriptor) return { applied: false, reason: "FIELD_CHANGED", message: "That answer is no longer blank." };
    if (String(descriptor.element.value ?? "").trim() && String(descriptor.element.value ?? "") !== String(request.previousDraft ?? "")) {
      return { applied: false, reason: "USER_EDITED", message: "You changed that answer after the draft was generated, so Scout left it untouched." };
    }
    if (Array.isArray(request.userEditedKeys) && request.userEditedKeys.includes(workdayFieldKey(descriptor.element))) {
      return { applied: false, reason: "USER_EDITED", message: "You edited that answer after the draft was generated, so Scout left it untouched." };
    }
    dispatchValue(descriptor.element, draft);
    if (String(descriptor.element.value ?? "") !== draft || location.href !== request.applicationUrl) {
      return { applied: false, reason: "FIELD_CHANGED", message: "The page changed while the draft was being inserted." };
    }
    return { applied: true, question: descriptor.question, applicationUrl: location.href, maxLength: field.maxLength };
  }

  function workdayStepTitle() {
    const active = document.querySelector('ol[data-automation-id="progressBar"] [aria-current="step"], ol[data-automation-id="progressBar"] [aria-current="page"], ol[data-automation-id="progressBar"] [data-automation-id="progressBarActiveStep"]');
    const pageHeader = document.querySelector('[data-automation-id="pageHeader"]');
    const heading = Array.from((pageHeader ?? document).querySelectorAll("h3")).find(isVisible)
      || Array.from(document.querySelectorAll("h3")).find(isVisible);
    const activeText = textOf(active);
    const activeIsCounter = /^(?:current\s*)?step\s*\d+\s*of\s*\d+$/i.test(activeText)
      || /^step\s*\d+\s*of\s*\d+$/i.test(activeText);
    return (!activeIsCounter ? activeText : "") || textOf(heading) || textOf(pageHeader) || activeText
      || textOf(Array.from(document.querySelectorAll("h2")).find(isVisible));
  }

  function isWorkdayAccountGate() {
    return Boolean(document.querySelector('input[type="password"], [data-automation-id="createAccountSubmitButton"], [data-automation-id="signInLink"]'));
  }

  function inspectWorkdayPage(payload = {}) {
    const host = location.hostname.toLowerCase();
    const descriptors = collectDescriptors().filter((descriptor) => !isWorkdaySearchControl(descriptor.element));
    assignProfileIndexes(descriptors);
    const accountGate = isWorkdayAccountGate();
    const applicationPath = workdayApplicationPath(location.pathname);
    const jobKey = ANSWER_CONTRACT.workdayJobKey(location.href);
    const jobCountryEvidence = workdayJobLocationEvidence();
    const stepTitle = workdayStepTitle();
    const isReviewPage = Boolean(document.querySelector('[data-automation-id="applyFlowReviewPage"]'))
      || normalizedKey(stepTitle) === "review";
    const iframeCount = document.querySelectorAll("iframe").length;
    const applicationTitle = textOf(Array.from(document.querySelectorAll("h2")).find(isVisible)) || document.title.trim() || stepTitle;
    const confirmationText = (document.body?.innerText ?? "").slice(0, 20_000);
    const questionnaireDescriptors = collectWorkdayQuestionnaireDescriptors();
    const knownControlCount = document.querySelectorAll("#address--countryRegion, #country--country, #phoneNumber--phoneType").length;
    const unknownQuestions = [];
    const seen = new Set();
    for (const descriptor of descriptors) {
      const question = descriptor.question;
      if (!question || isHardBlocked(descriptorPrompt(descriptor)) || isWorkdayNonReusableConsent(descriptor)
        || !isMutable(descriptor.element) || descriptor.kind === "file") continue;
      if (!isBlank(descriptor)) continue;
      const resolution = answerFor(descriptor, payload.profile ?? {}, payload.answers ?? [], payload);
      if (resolution.applicable) continue;
      const key = normalizedKey(question);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unknownQuestions.push(unknownRecord(descriptor, {
        ambiguous: resolution.ambiguous === true,
        reviewRequired: resolution.reviewRequired === true,
        savedAnswerMismatch: Boolean(resolution.answer && !resolution.applicable),
      }, payload));
    }
    for (const field of WORKDAY_CUSTOM_FIELDS) {
      const control = document.querySelector(field.selector);
      if (!control || !isVisible(control) || control.disabled) continue;
      const requested = customRequestedValues(field, payload);
      const current = customCurrentSelection(field, control);
      const hasCurrent = Array.isArray(current) ? current.length > 0 : Boolean(current);
      if (!requested.ambiguous && (requested.values.length || requested.reviewedEmpty || hasCurrent)) continue;
      const record = workdayCustomDescriptor(field, control, visibleWorkdayOptions(control).map((option) => option.label), payload);
      record.ambiguous = requested.ambiguous === true;
      unknownQuestions.push(record);
    }
    for (const descriptor of questionnaireDescriptors) {
      const current = workdayQuestionnaireCurrentLabel(descriptor.element);
      if (current) continue;
      if (isHardBlocked(descriptor.question)) continue;
      const resolution = workdayQuestionnaireAnswer(descriptor.question, payload.answers ?? [], payload.profile ?? {}, payload);
      if (resolution.applicable) continue;
      const key = normalizedKey(descriptor.question);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      descriptor.choices = visibleWorkdayOptions(descriptor.element);
      unknownQuestions.push(unknownRecord(descriptor, {
        ambiguous: resolution.ambiguous === true,
        reviewRequired: isReviewRequired(descriptor.question),
        savedAnswerMismatch: Boolean(resolution.answer && !resolution.applicable),
      }, payload));
    }
    const manualReason = isReviewPage
      ? "Workday Review is read-only here. Scout stops before the Submit button; review and submit the application yourself."
      : !applicationPath
      ? "Workday sign-in, account setup, and job-detail pages stay manual. Open the application form to start a session."
      : accountGate
        ? "Finish Workday sign-in or account setup yourself before starting an application session."
        : "";
    return {
      supported: applicationPath && !accountGate && !isReviewPage,
      ats: "Workday",
      host,
      title: applicationTitle,
      company: inferCompany(host).name,
      companyCandidate: true,
      applicationUrl: location.href,
      jobKey,
      jobCountryEvidence,
      inferredApplicationCountry: ANSWER_CONTRACT.inferWorkdayJobCountry(location.href, jobCountryEvidence),
      ...(!applicationPath && !isReviewPage && jobKey
        ? { jobDescription: workdayListingDescription() } : {}),
      locale: normalize(document.documentElement?.lang ?? ""),
      workdayStep: stepTitle || applicationTitle,
      manualReason,
      formCount: document.querySelectorAll("form").length,
      visibleFieldCount: descriptors.length + questionnaireDescriptors.length + knownControlCount
        + WORKDAY_REPEATABLE_SECTIONS.reduce((count, section) => count + workdayRowsForSection(section)
          .reduce((rowCount, row) => rowCount + Array.from(row.querySelectorAll("input, select, textarea, button"))
            .filter((element) => isVisible(element)).length, 0), 0),
      iframeCount,
      iframeWarning: iframeCount > 0 ? "Fields inside embedded frames remain manual." : "",
      confirmationDetected: CONFIRMATION_PATTERNS.some((pattern) => pattern.test(confirmationText)),
      unknownQuestions,
      sectionWarnings: workdaySectionWarnings(payload.profile ?? {}, payload.workdayUserEditedKeys),
      knownControlCount,
    };
  }

  function inferCompany(host) {
    const explicit = document.querySelector('meta[property="og:site_name"], meta[itemprop="hiringOrganization"], [itemprop="hiringOrganization"]');
    const explicitText = normalize(explicit?.getAttribute("content") || textOf(explicit));
    if (explicitText) return { name: explicitText.slice(0, 200), candidate: false };
    const segments = location.pathname.split("/").filter(Boolean).map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
    let slug = "";
    if (host.endsWith("greenhouse.io") && segments.length >= 2 && /^(?:boards|job-boards)$/.test(host.split(".")[0]) && segments[1] === "jobs") slug = segments[0];
    else if (host.endsWith("lever.co") && host.split(".")[0] === "jobs" && segments.length >= 2) slug = segments[0];
    else if (host.endsWith("ashbyhq.com") && host.split(".")[0] === "jobs" && segments.length >= 2) slug = segments[0];
    else {
      const label = host.split(".")[0];
      if (label && !["boards", "job-boards", "jobs"].includes(label)) slug = label;
    }
    const candidate = slug.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()).trim();
    return { name: candidate.slice(0, 200), candidate: Boolean(candidate) };
  }

  function isHardBlocked(question) {
    return HARD_BLOCKED_FIELD.test(question);
  }

  function isReviewRequired(question) {
    return REVIEW_REQUIRED_FIELD.test(question);
  }

  function descriptorPrompt(descriptor) {
    const type = descriptor.element instanceof HTMLInputElement ? descriptor.element.type : "";
    return `${descriptor.question} ${fieldMetadata(descriptor.element)} ${type}`.trim();
  }

  function pageScopeFor(question, payload = {}) {
    const locale = normalize(document.documentElement?.lang ?? "");
    const explicitCountry = ["Canada", "United States"].includes(payload.applicationCountry) ? payload.applicationCountry : "";
    const currentJobKey = ANSWER_CONTRACT.workdayJobKey(location.href);
    const suppliedEvidence = payload.jobKey === currentJobKey && Array.isArray(payload.jobCountryEvidence)
      ? payload.jobCountryEvidence : [];
    const countryEvidence = [...new Set([...suppliedEvidence, ...workdayJobLocationEvidence()])];
    const applicationCountry = payload.applicationCountryReviewed === true
      ? explicitCountry
      : ANSWER_CONTRACT.inferWorkdayJobCountry(location.href,
        countryEvidence);
    return ANSWER_CONTRACT.answerScopeContext(question, {
      origin: location.origin,
      locale,
      applicationCountry,
    });
  }

  function availableChoices(descriptor) {
    const choices = descriptor.kind === "radio" || descriptor.kind === "checkbox"
      ? descriptor.choices.map((element) => ({ element, label: cleanVisibleQuestion(choiceLabel(element)), value: element.value }))
      : descriptor.kind === "workday-questionnaire"
        ? descriptor.choices.map((choice) => ({ element: choice.element, label: choice.label, value: choice.label }))
      : descriptor.element instanceof HTMLSelectElement
        ? Array.from(descriptor.element.options).filter((option) => !option.disabled && normalize(option.value)
          && !/^(?:select|choose|please select|please choose|--)/i.test(normalize(option.textContent)))
          .map((element) => ({ element, label: cleanVisibleQuestion(textOf(element)), value: element.value }))
        : [];
    const seen = new Set();
    return choices.filter((choice) => {
      if (!choice.label) return false;
      const key = normalizedKey(choice.label);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ label, value }) => ({ label, value: String(value ?? "") }));
  }

  function unknownRecord(descriptor, extra = {}, payload = {}) {
    const writtenDraftEligible = !extra.savedAnswerMismatch && !extra.reviewRequired && writtenDraftDescriptor(descriptor);
    const nativeLimit = Number(descriptor?.element?.maxLength);
    return {
      question: descriptor.question,
      kind: descriptor.kind,
      key: normalizedKey(descriptor.question),
      choices: availableChoices(descriptor),
      scopeContext: pageScopeFor(descriptor.question, payload),
      reviewRequired: isReviewRequired(descriptorPrompt(descriptor)),
      ...(writtenDraftEligible ? { writtenDraftEligible: true, maxLength: Math.min(nativeLimit > 0 ? nativeLimit : 2_000, 2_000) } : {}),
      ...extra,
    };
  }

  function isBlank(descriptor) {
    const { element, kind, choices } = descriptor;
    if (kind === "file") return !(element.files?.length);
    if (kind === "radio" || kind === "checkbox") return !choices.some((choice) => choice.checked);
    if (kind === "multi-select") return !Array.from(element.selectedOptions).some((option) => option.value.trim());
    if (kind === "workday-questionnaire") return !workdayQuestionnaireCurrentLabel(element);
    if (element instanceof HTMLSelectElement) {
      const option = element.selectedOptions[0];
      if (!option) return true;
      return !option.value.trim() || /^(select|choose|please select|please choose|--)/i.test(normalize(option.textContent));
    }
    return !String(element.value ?? "").trim();
  }

  function isMeaningfullyFilled(descriptor) {
    return !isBlank(descriptor);
  }

  function countryIn(value) {
    return ANSWER_CONTRACT.inferCountry(value);
  }

  function assignProfileIndexes(descriptors) {
    const counts = new Map();
    for (const descriptor of descriptors) {
      const field = profileArrayField(descriptor);
      if (!field) continue;
      const index = counts.get(field) ?? 0;
      descriptor.profileArrayIndex = index;
      counts.set(field, index + 1);
    }
  }

  function profileArrayField(descriptor) {
    const q = normalize(descriptor.question);
    if (promptMatches(q, /school|university|college|institution/) || metadataMatches(descriptor.element, /(?:^| )(?:school|university|college|institution)(?: |$)/)) return "education:school";
    if (promptMatches(q, /degree|qualification/) || metadataMatches(descriptor.element, /(?:^| )(?:degree|qualification)(?: |$)/)) return "education:degree";
    if (promptMatches(q, /field of study|major|discipline|program of study/) || metadataMatches(descriptor.element, /(?:^| )(?:field of study|major|discipline)(?: |$)/)) return "education:fieldOfStudy";
    if (promptMatches(q, /education.*start|school.*start|degree.*start|start.*education/) || metadataMatches(descriptor.element, /(?:^| )education start date(?: |$)/)) return "education:startDate";
    if (promptMatches(q, /education.*end|school.*end|degree.*end|end.*education|graduation/) || metadataMatches(descriptor.element, /(?:^| )education end date(?: |$)/)) return "education:endDate";
    if (promptMatches(q, /^(?:company|employer|company name|employer name)$/) || metadataMatches(descriptor.element, /(?:^| )(?:company|employer)(?: name)?(?: |$)/)) return "experience:company";
    if (promptMatches(q, /^(?:job title|position|role title)$/) || metadataMatches(descriptor.element, /(?:^| )(?:job title|position|role title)(?: |$)/)) return "experience:title";
    if (promptMatches(q, /work.*start|employment.*start|start.*work|work start date/) || metadataMatches(descriptor.element, /(?:^| )work start date(?: |$)/)) return "experience:startDate";
    if (promptMatches(q, /work.*end|employment.*end|end.*work|work end date/) || metadataMatches(descriptor.element, /(?:^| )work end date(?: |$)/)) return "experience:endDate";
    if (promptMatches(q, /responsibilit|description|summary of work/) || metadataMatches(descriptor.element, /(?:^| )(?:work description|responsibilities)(?: |$)/)) return "experience:description";
    return "";
  }

  function promptMatches(question, pattern, maximumWords = 7) {
    return question.split(/\s+/).filter(Boolean).length <= maximumWords && pattern.test(question.toLocaleLowerCase("en-US"));
  }

  function metadataMatches(element, pattern) {
    const attributes = ["autocomplete", "name", "id", "data-qa", "data-automation-id"];
    const excluded = /description|reason|motivation|interest|why|essay|cover letter|statement|summary|details/i;
    return attributes.some((attribute) => {
      const value = normalize(element.getAttribute(attribute)).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLocaleLowerCase("en-US");
      if (!value || excluded.test(value)) return false;
      const tokens = value.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
      return tokens.split(" ").length <= 5 && pattern.test(` ${tokens} `);
    });
  }

  function exactProfileAnswer(descriptor, profile) {
    const q = normalize(descriptor.question).toLocaleLowerCase("en-US");
    const element = descriptor.element;
    const autocomplete = normalize(element.getAttribute("autocomplete")).toLocaleLowerCase("en-US");
    const metadata = normalize(fieldMetadata(element)).toLocaleLowerCase("en-US");
    const field = `${q} ${metadata}`.trim();
    const promptIsDirect = (pattern) => promptMatches(q, pattern);
    const education = profile.education ?? [];
    const experience = profile.experience ?? [];
    const take = (list, property) => {
      const index = Number.isInteger(descriptor.profileArrayIndex) ? descriptor.profileArrayIndex : 0;
      return list[index]?.[property] ? String(list[index][property]) : "";
    };

    if (isHardBlocked(field)) return "";
    if (ANSWER_CONTRACT.isResidenceCountryLegalPrompt(field)) return "";
    if (/work authorization|authorized to work|legally eligible|employment eligibility|visa status|immigration status|export control/.test(field)) {
      const answer = String(profile.workAuthorization ?? "").trim();
      if (!answer) return "";
      const requestedCountry = countryIn(q);
      const configuredCountry = countryIn(answer);
      if (!requestedCountry || requestedCountry !== configuredCountry) return "";
      return answer;
    }
    if (isReviewRequired(field)) return "";

    if (/preferred.*first name/.test(metadata) || /preferred first name/.test(q)) return profile.preferredFirstName ?? "";
    if (/preferred.*last name/.test(metadata) || /preferred last name/.test(q)) return profile.preferredLastName ?? "";

    if ((/given-name|first-name/.test(autocomplete) || promptIsDirect(/first name/) || metadataMatches(element, /(?:^| )(?:first name|given name)(?: |$)/))) return profile.firstName ?? "";
    if ((/family-name|last-name/.test(autocomplete) || promptIsDirect(/last name|surname/) || metadataMatches(element, /(?:^| )(?:last name|family name|surname)(?: |$)/))) return profile.lastName ?? "";
    if (promptIsDirect(/full name|legal name|your name/)) {
      const nameValue = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
      return nameValue || "";
    }
    if ((/email/.test(autocomplete) || promptIsDirect(/\bemail(?: address)?\b|\be mail\b/) || metadataMatches(element, /(?:^| )(?:email|e mail)(?: address)?(?: |$)/))) return profile.email ?? "";
    if (promptIsDirect(/^phone type$/) || metadataMatches(element, /(?:^| )phone type(?: |$)/)) return profile.phoneType ?? "";
    if (promptIsDirect(/^(?:phone )?(?:country )?code$/) || metadataMatches(element, /(?:^| )(?:phone country code|country code)(?: |$)/)) return profile.phoneCountryCode ?? "";
    if (promptIsDirect(/^phone extension$/) || metadataMatches(element, /(?:^| )phone extension(?: |$)/)) return profile.phoneExtension ?? "";
    if ((/^tel(?: national)?$/.test(autocomplete) || promptIsDirect(/\bphone\b|\bmobile\b|\btelephone\b/) || metadataMatches(element, /(?:^| )(?:phone|mobile|telephone)(?: number)?(?: |$)/)) && profile.phone) {
      let phone = String(profile.phone).trim();
      const explicitCode = String(profile.phoneCountryCode ?? "").match(/\+\d{1,4}/)?.[0];
      if (explicitCode && phone.startsWith(explicitCode) && phone.length > explicitCode.length) {
        phone = phone.slice(explicitCode.length).replace(/^[-().\s]+/, "").trim();
      }
      return phone;
    }

    if (/street-address/.test(autocomplete) || promptIsDirect(/^(?:address|street address|address line 1)$/) || metadataMatches(element, /(?:^| )(?:address|street address|street address 1)(?: |$)/)) return profile.address ?? "";
    if (/address-level2/.test(autocomplete) || promptIsDirect(/^(?:city|town)$/) || metadataMatches(element, /(?:^| )(?:city|town)(?: |$)/)) return profile.city ?? "";
    if (/address-level1/.test(autocomplete) || promptIsDirect(/^(?:region|province|state)$/) || metadataMatches(element, /(?:^| )(?:region|province|state)(?: |$)/)) return profile.region ?? "";
    if (/postal-code/.test(autocomplete) || promptIsDirect(/^(?:postal code|zip code|postcode)$/) || metadataMatches(element, /(?:^| )(?:postal code|zip code|postcode)(?: |$)/)) return profile.postalCode ?? "";
    if (ANSWER_CONTRACT.isResidenceCountryPrompt(q)) return profile.country ?? "";
    if (promptIsDirect(/linkedin/) || metadataMatches(element, /(?:^| )linkedin(?: |$)/)) return profile.linkedin ?? "";
    if (promptIsDirect(/github/) || metadataMatches(element, /(?:^| )github(?: |$)/)) return profile.github ?? "";
    if (promptIsDirect(/portfolio|personal website|personal site/) || metadataMatches(element, /(?:^| )(?:portfolio|personal website|personal site)(?: |$)/)) return profile.portfolio ?? "";

    if (promptIsDirect(/school|university|college|institution/) || metadataMatches(element, /(?:^| )(?:school|university|college|institution)(?: |$)/)) return take(education, "school");
    if (promptIsDirect(/degree|qualification/) || metadataMatches(element, /(?:^| )(?:degree|qualification)(?: |$)/)) return take(education, "degree");
    if (promptIsDirect(/field of study|major|discipline|program of study/) || metadataMatches(element, /(?:^| )(?:field of study|major|discipline)(?: |$)/)) return take(education, "fieldOfStudy");
    if (promptIsDirect(/education.*start|school.*start|degree.*start|start.*education/) || metadataMatches(element, /(?:^| )education start date(?: |$)/)) return take(education, "startDate");
    if (promptIsDirect(/education.*end|school.*end|degree.*end|end.*education|graduation/) || metadataMatches(element, /(?:^| )education end date(?: |$)/)) return take(education, "endDate");
    if (promptIsDirect(/^(?:company|employer|company name|employer name)$/) || metadataMatches(element, /(?:^| )(?:company|employer)(?: name)?(?: |$)/)) return take(experience, "company");
    if (promptIsDirect(/^(?:job title|position|role title)$/) || metadataMatches(element, /(?:^| )(?:job title|position|role title)(?: |$)/)) return take(experience, "title");
    if (promptIsDirect(/work.*start|employment.*start|start.*work|work start date/) || metadataMatches(element, /(?:^| )work start date(?: |$)/)) return take(experience, "startDate");
    if (promptIsDirect(/work.*end|employment.*end|end.*work|work end date/) || metadataMatches(element, /(?:^| )work end date(?: |$)/)) return take(experience, "endDate");
    if (promptIsDirect(/responsibilit|description|summary of work/) || metadataMatches(element, /(?:^| )(?:work description|responsibilities)(?: |$)/)) return take(experience, "description");
    return "";
  }

  function choiceElements(descriptor) {
    if (descriptor.kind === "radio" || descriptor.kind === "checkbox") {
      return descriptor.choices.map((element) => ({ element, label: cleanVisibleQuestion(choiceLabel(element)), value: String(element.value ?? "") }));
    }
    if (descriptor.element instanceof HTMLSelectElement) {
      return Array.from(descriptor.element.options).filter((option) => !option.disabled && normalize(option.value)
        && !/^(?:select|choose|please select|please choose|--)/i.test(normalize(option.textContent)))
        .map((element) => ({ element, label: cleanVisibleQuestion(textOf(element)), value: String(element.value ?? "") }));
    }
    return [];
  }

  function exactChoice(choice, requested) {
    const key = normalizedKey(requested);
    return key && (normalizedKey(choice.label) === key || normalizedKey(choice.value) === key);
  }

  function exactVisibleChoice(choice, requested) {
    const key = normalizedKey(requested);
    return Boolean(key && normalizedKey(choice.label) === key);
  }

  function booleanChoice(value) {
    const key = normalizedKey(value);
    if (["yes", "y", "true"].includes(key)) return true;
    if (["no", "n", "false"].includes(key)) return false;
    return null;
  }

  function hasChoice(descriptor, answer) {
    const type = answer.answerType ?? "text";
    const choices = choiceElements(descriptor);
    if (type === "text") {
      if (descriptor.kind === "checkbox") return false;
      return descriptor.kind === "radio" || descriptor.element instanceof HTMLSelectElement
        ? choices.filter((choice) => exactChoice(choice, answer.answer)).length === 1
        : Boolean(String(answer.answer ?? "").trim());
    }
    if (type === "single-choice") return (descriptor.kind === "radio" || descriptor.element instanceof HTMLSelectElement)
      && answer.selectedChoices?.length === 1 && choices.some((choice) => exactVisibleChoice(choice, answer.selectedChoices[0]));
    if (type === "multi-choice") {
      if (descriptor.kind !== "checkbox" && descriptor.kind !== "multi-select") return false;
      return answer.selectedChoices.every((requested) => choices.some((choice) => exactVisibleChoice(choice, requested)));
    }
    if (type === "boolean") {
      if (descriptor.kind === "checkbox" && choices.length === 1) return true;
      return (descriptor.kind === "radio" || descriptor.element instanceof HTMLSelectElement)
        && choices.filter((choice) => booleanChoice(choice.label) === answer.booleanValue).length === 1;
    }
    return false;
  }

  function answerFor(descriptor, profile, answers, payload = {}) {
    const question = descriptor.question;
    if (!question || isHardBlocked(descriptorPrompt(descriptor)) || isWorkdayNonReusableConsent(descriptor)) {
      return { answer: null, applicable: false, blocked: true };
    }
    const preferredNameField = workdayPreferredNameField(descriptor);
    const questionNamesPreferred = /\bpreferred\s+(?:first|last)\s+name\b/i.test(question);
    const resolved = preferredNameField && !questionNamesPreferred
      ? { answer: null, ambiguous: false }
      : ANSWER_CONTRACT.resolveAnswer(question, answers, pageScopeFor(question, payload));
    if (resolved.ambiguous) return { answer: null, applicable: false, ambiguous: true };
    if (resolved.answer) {
      const saved = resolved.answer;
      return { answer: saved, applicable: hasChoice(descriptor, saved), reviewRequired: isReviewRequired(descriptorPrompt(descriptor)) };
    }
    const profileChoice = workdayProfileChoiceAnswer(descriptor, profile);
    if (profileChoice) return { answer: profileChoice, applicable: hasChoice(descriptor, profileChoice), reviewRequired: isReviewRequired(descriptorPrompt(descriptor)) };
    const referralPrompt = /how did you hear about us|referral source|where did you hear/.test(normalizedKey(question))
      || metadataMatches(descriptor.element, /(?:^| )referral sources?(?: |$)/);
    if (referralPrompt && (descriptor.kind === "checkbox" || descriptor.kind === "multi-select")
      && Array.isArray(profile.referralSources) && profile.referralSources.length) {
      const answer = { answerType: "multi-choice", answer: "", selectedChoices: profile.referralSources.map((value) => normalize(value)).filter(Boolean) };
      return { answer, applicable: ANSWER_CONTRACT.isValidAnswer({ question, ...answer }) && hasChoice(descriptor, answer), reviewRequired: false };
    }
    const value = exactProfileAnswer(descriptor, profile).trim();
    const answer = value ? { answerType: "text", answer: value } : null;
    const reviewRequired = isReviewRequired(descriptorPrompt(descriptor));
    return { answer, applicable: Boolean(answer && hasChoice(descriptor, answer)), reviewRequired };
  }

  function workdayQuestionnaireCurrentLabel(control) {
    const value = cleanVisibleQuestion(textOf(control));
    return /^(?:select(?: one)?|choose|please select|please choose)$/i.test(value) ? "" : value;
  }

  function workdayQuestionnaireAnswer(question, answers, profile = {}, payload = {}) {
    if (isHardBlocked(question) || isWorkdayNonReusableAgreement(question)) {
      return { answer: null, applicable: false, blocked: true };
    }
    const resolved = ANSWER_CONTRACT.resolveAnswer(question, answers, pageScopeFor(question, payload));
    if (resolved.ambiguous) return { answer: null, applicable: false, ambiguous: true };
    const answer = resolved.answer;
    if (!answer && isWorkdayHost(location.hostname)
      && ANSWER_CONTRACT.isDirectEmployerHistoryPrompt(question)
      && (profile.previousWorker === true || profile.previousWorker === false)) {
      return {
        answer: { answer: "", answerType: "boolean", booleanValue: profile.previousWorker },
        applicable: true,
        reviewRequired: false,
        profileAnswer: true,
      };
    }
    if (!answer || !ANSWER_CONTRACT.isValidAnswer({ question, ...answer })) return { answer: answer ?? null, applicable: false };
    const type = answer.answerType ?? "text";
    const applicable = type === "text"
      ? Boolean(String(answer.answer ?? "").trim())
      : type === "single-choice"
        ? Array.isArray(answer.selectedChoices) && answer.selectedChoices.length === 1
        : type === "boolean" && typeof answer.booleanValue === "boolean";
    return { answer, applicable, reviewRequired: isReviewRequired(question) };
  }

  const WORKDAY_FEDERAL_REFERENCE_AGREEMENT = "In compliance with federal law, all persons hired will be required to verify identity and eligibility to work in the United States and to complete the required employment eligibility verification document form upon hire. I authorize representatives of Mercer University/MERC to contact the references that I have provided, and to make inquiries concerning my employment history with current or former employers if I am selected as a finalist. I understand that all final and official offers of employment shall be made by the MERC Executive Director.";

  function isWorkdayNonReusableAgreement(question) {
    return isWorkdayHost(location.hostname)
      && normalizedKey(question) === normalizedKey(WORKDAY_FEDERAL_REFERENCE_AGREEMENT);
  }

  function isWorkdayNonReusableConsent(descriptor) {
    if (!isWorkdayHost(location.hostname)) return false;
    const element = descriptor.element;
    return element.id === "termsAndConditions--acceptTermsAndAgreements"
      || element.getAttribute("name") === "acceptTermsAndAgreements"
      || isWorkdayNonReusableAgreement(descriptor.question);
  }

  function workdayPreferredNameField(descriptor) {
    if (!isWorkdayHost(location.hostname)) return "";
    const element = descriptor?.element;
    const identity = `${element?.id ?? ""} ${element?.getAttribute?.("name") ?? ""}`;
    if (/name--preferredName--firstName|preferredName--firstName/.test(identity)) return "first";
    if (/name--preferredName--lastName|preferredName--lastName/.test(identity)) return "last";
    return "";
  }

  function workdayProfileChoiceAnswer(descriptor, profile) {
    if (descriptor.kind === "file") return null;
    const element = descriptor.element;
    if ((descriptor.kind === "radio" || element instanceof HTMLSelectElement)
      && ANSWER_CONTRACT.isDirectEmployerHistoryPrompt(descriptor.question)
      && (profile.previousWorker === true || profile.previousWorker === false)) {
      return { answer: "", answerType: "boolean", booleanValue: profile.previousWorker };
    }
    if (isWorkdayHost(location.hostname) && descriptor.kind === "radio"
      && element.getAttribute("name") === "candidateIsPreviousWorker"
      && ANSWER_CONTRACT.isObservedCompoundEmployerHistoryPrompt(descriptor.question)
      && (profile.previousWorker === true || profile.previousWorker === false)) {
      return { answer: "", answerType: "boolean", booleanValue: profile.previousWorker };
    }
    if (isWorkdayHost(location.hostname) && descriptor.kind === "workday-questionnaire"
      && ANSWER_CONTRACT.isDirectEmployerHistoryPrompt(descriptor.question)
      && (profile.previousWorker === true || profile.previousWorker === false)) {
      return { answer: "", answerType: "boolean", booleanValue: profile.previousWorker };
    }
    if (descriptor.kind === "checkbox" && (element.id === "name--preferredCheck" || element.getAttribute("name") === "preferredCheck")
      && normalizedKey(descriptor.question) === normalizedKey("I have a preferred name")
      && (profile.hasPreferredName === true || profile.hasPreferredName === false)) {
      return { answer: "", answerType: "boolean", booleanValue: profile.hasPreferredName };
    }
    return null;
  }

  function dispatchValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchChecked(element, checked) {
    if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) return false;
    if (element.checked === checked) return true;
    // Click activation updates native checked state and reaches React's
    // checkbox/radio change plugin. Never click a form button here.
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return element.checked === checked;
  }

  function selectExactChoice(descriptor, answer) {
    const choices = choiceElements(descriptor);
    const answerType = answer.answerType ?? "text";
    if (answerType === "text") {
      const matches = choices.filter((choice) => exactChoice(choice, answer.answer));
      if (matches.length !== 1) return false;
      const [matched] = matches;
      if (descriptor.kind === "radio") return dispatchChecked(matched.element, true);
      else dispatchValue(descriptor.element, matched.element.value);
      return true;
    }
    if (answerType === "single-choice" && (descriptor.kind === "radio" || descriptor.element instanceof HTMLSelectElement)) {
      const matching = choices.filter((choice) => exactVisibleChoice(choice, answer.selectedChoices[0]));
      if (matching.length !== 1) return false;
      if (descriptor.kind === "radio") return dispatchChecked(matching[0].element, true);
      else dispatchValue(descriptor.element, matching[0].element.value);
      return true;
    }
    if (answerType === "boolean" && (descriptor.kind === "radio" || descriptor.element instanceof HTMLSelectElement)) {
      const matching = choices.filter((choice) => booleanChoice(choice.label) === answer.booleanValue);
      if (matching.length !== 1) return false;
      if (descriptor.kind === "radio") return dispatchChecked(matching[0].element, true);
      else dispatchValue(descriptor.element, matching[0].element.value);
      return true;
    }
    return false;
  }

  function selectExactMultiChoice(descriptor, answer) {
    if ((descriptor.kind !== "checkbox" && descriptor.kind !== "multi-select") || !["multi-choice", "boolean"].includes(answer.answerType)) return null;
    const choices = choiceElements(descriptor);
    if (answer.answerType === "boolean") {
      if (descriptor.kind !== "checkbox" || choices.length !== 1) return null;
      if (answer.booleanValue && !dispatchChecked(choices[0].element, true)) return null;
      return { changed: answer.booleanValue === true, reviewed: true };
    }
    const selected = [];
    for (const requested of answer.selectedChoices) {
      const matching = choices.filter((choice) => exactVisibleChoice(choice, requested));
      if (matching.length !== 1 || selected.includes(matching[0].element)) return null;
      selected.push(matching[0].element);
    }
    if (!selected.length) return { changed: false, reviewed: true };
    if (descriptor.kind === "checkbox") {
      const committed = [];
      for (const choice of selected) {
        if (!dispatchChecked(choice, true)) {
          for (const previous of committed.reverse()) dispatchChecked(previous, false);
          return null;
        }
        committed.push(choice);
      }
    } else {
      for (const choice of choices) choice.element.selected = selected.includes(choice.element);
      descriptor.element.dispatchEvent(new Event("input", { bubbles: true }));
      descriptor.element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { changed: true, reviewed: true };
  }

  function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function inputAccepts(input, documentInfo) {
    const accept = String(input.getAttribute("accept") ?? "").toLowerCase();
    if (!accept) return true;
    return accept.split(",").map((item) => item.trim()).some((item) => item === documentInfo.type.toLowerCase() || item === `.${documentInfo.name.split(".").pop()?.toLowerCase()}`);
  }

  function attachDocument(descriptor, kind, documents) {
    const input = descriptor.element;
    const doc = kind === "resume" ? documents?.resume : documents?.coverLetter;
    if (!doc || fileUploadAlreadyHasItems(input) || !inputAccepts(input, doc)) return false;
    const bytes = decodeBase64(doc.base64);
    const file = new File([bytes], doc.name, { type: doc.type });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function attachWorkdayDocuments(descriptor, documents) {
    const input = descriptor.element;
    const widgetKind = workdayResumeUploadKind(input);
    if (!widgetKind || fileUploadAlreadyHasItems(input)) return { attached: [], invalid: false };
    const selected = (widgetKind === "resume-parser" ? [documents?.resume] : [documents?.resume, documents?.coverLetter]).filter(Boolean);
    if (!selected.length) return { attached: [], invalid: false };
    const totalBytes = selected.reduce((sum, doc) => sum + (Number(doc?.size) || 0), 0);
    if (totalBytes > 5 * 1024 * 1024 || selected.some((doc) => !isSupportedStoredDocument(doc) || !inputAccepts(input, doc))) {
      return { attached: [], invalid: true };
    }
    const transfer = new DataTransfer();
    for (const doc of selected) {
      transfer.items.add(new File([decodeBase64(doc.base64)], doc.name, { type: doc.type }));
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { attached: selected.map((doc) => doc.name), invalid: false };
  }

  function fillPage(payload) {
    const report = inspectPage(payload);
    if (!report.supported || report.ats === "Workday") {
      return { ...report, filled: [], selected: [], reviewedChoices: [], attachments: [], unknownQuestions: report.unknownQuestions ?? [] };
    }
    return fillDescriptors(report, collectDescriptors(), payload, {});
  }

  function fillDescriptors(report, descriptors, payload, options = {}) {
    assignProfileIndexes(descriptors);
    const filled = [];
    const selected = [];
    const reviewedChoices = [];
    const attachments = [];
    const unknown = [];
    let leftExisting = 0;
    let sensitive = 0;

    for (const descriptor of descriptors) {
      const question = descriptor.question;
      if (descriptor.kind === "file") {
        if (!isMutable(descriptor.element)) continue;
        if (isMeaningfullyFilled(descriptor)
          || (options.workday && workdayResumeUpload(descriptor.element) && fileUploadAlreadyHasItems(descriptor.element))) {
          leftExisting += 1;
          continue;
        }
        if (options.workday && workdayResumeUpload(descriptor.element)) {
          const result = attachWorkdayDocuments(descriptor, payload.documents);
          if (result.attached.length) attachments.push(...result.attached);
          else if (result.invalid) unknown.push(unknownRecord(descriptor, { savedDocumentMismatch: true }, payload));
          continue;
        }
        const q = normalizedKey(question);
        const docKind = /cover letter|coverletter/.test(q) ? "coverLetter" : /resume|cv|curriculum vitae/.test(q) ? "resume" : "";
        if (docKind && attachDocument(descriptor, docKind, payload.documents)) attachments.push(question || docKind);
        continue;
      }
      if (!isMutable(descriptor.element) || descriptor.choices.some((choice) => !isMutable(choice))) continue;
      const workdayKey = options.workday ? workdayFieldKey(descriptor.element) : "";
      if (options.workday && workdayKey && options.userEditedKeys?.has(workdayKey)) { leftExisting += 1; continue; }
      const forcePreference = Boolean(options.forceDefaults && workdayPreferenceField(descriptor)
        && !options.userEditedKeys?.has(workdayKey));
      if (descriptor.kind === "radio" || descriptor.kind === "checkbox") {
        if (isMeaningfullyFilled(descriptor) && !forcePreference) { leftExisting += 1; continue; }
      } else if (isMeaningfullyFilled(descriptor) && !forcePreference) { leftExisting += 1; continue; }
      if (!question || isHardBlocked(descriptorPrompt(descriptor)) || isWorkdayNonReusableConsent(descriptor)) { sensitive += 1; continue; }
      const resolution = answerFor(descriptor, payload.profile ?? {}, payload.answers ?? [], payload);
      if (!resolution.applicable || !resolution.answer) {
        if (!unknown.some((item) => normalizedKey(item.question) === normalizedKey(question))) {
          unknown.push(unknownRecord(descriptor, {
            ambiguous: resolution.ambiguous === true,
            reviewRequired: resolution.reviewRequired === true,
            savedAnswerMismatch: Boolean(resolution.answer && !resolution.applicable),
          }, payload));
        }
        continue;
      }
      const answer = resolution.answer;
      if (descriptor.kind === "checkbox" || descriptor.kind === "multi-select") {
        const result = selectExactMultiChoice(descriptor, answer);
        if (!result) {
          unknown.push(unknownRecord(descriptor, { savedAnswerMismatch: true }, payload));
        } else {
          const labels = answer.answerType === "boolean"
            ? answer.booleanValue ? [choiceLabel(descriptor.choices[0])] : []
            : answer.selectedChoices.map((label) => normalize(label));
          if (result.changed) filled.push(question);
          selected.push({ question, choices: labels });
          reviewedChoices.push(question);
        }
        continue;
      }
      if (descriptor.kind === "radio" || descriptor.element instanceof HTMLSelectElement) {
        if (selectExactChoice(descriptor, answer)) {
          filled.push(question);
          const answerType = answer.answerType ?? "text";
          const selectedLabel = answerType === "boolean"
            ? choiceElements(descriptor).find((choice) => booleanChoice(choice.label) === answer.booleanValue)?.label
            : answerType === "single-choice" ? answer.selectedChoices[0] : answer.answer;
          selected.push({ question, choices: selectedLabel ? [normalize(selectedLabel)] : [] });
          if (isReviewRequired(descriptorPrompt(descriptor))) reviewedChoices.push(question);
        } else unknown.push(unknownRecord(descriptor, { savedAnswerMismatch: true }, payload));
        continue;
      }
      const value = answer.answerType === "text" || !answer.answerType ? String(answer.answer ?? "").trim() : "";
      if (!value) {
        unknown.push(unknownRecord(descriptor, { savedAnswerMismatch: true }, payload));
        continue;
      }
      if (descriptor.element instanceof HTMLInputElement && descriptor.element.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        unknown.push(unknownRecord(descriptor, { savedAnswerMismatch: true }, payload));
        continue;
      }
      dispatchValue(descriptor.element, value);
      filled.push(question);
    }
    return { ...report, filled, selected, reviewedChoices, attachments, leftExisting, protectedSkipped: sensitive, unknownQuestions: unknown };
  }

  function workdayFieldKey(element) {
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    if (type === "radio" || type === "checkbox") {
      const name = element.getAttribute("name");
      if (name) return `group:${type}:${name}`;
      const group = element.closest("fieldset, [data-automation-id^=\"formField-\"], [role=group]");
      const groupId = group?.getAttribute("data-automation-id") || group?.id || normalizedKey(groupQuestionFor(element));
      if (groupId) return `group:${type}:${groupId}`;
    }
    return [element.id, element.getAttribute("data-automation-id"), element.getAttribute("name")].find(Boolean) ?? "";
  }

  function workdayPreferenceField(descriptor) {
    const prompt = `${descriptor.question} ${fieldMetadata(descriptor.element)}`.toLocaleLowerCase("en-US");
    return /(?:^|\b)(?:country|phone country code|country phone code)(?:\b|$)/.test(prompt);
  }

  const WORKDAY_SESSION_WINDOW_MS = 30 * 60 * 1_000;
  const WORKDAY_CUSTOM_FIELDS = [
    { selector: "#country--country", question: "Country", profileField: "country", kind: "single", preference: true },
    { selector: "#address--countryRegion", question: "Province or Territory", profileField: "region", kind: "single" },
    { selector: "#phoneNumber--phoneType", question: "Phone Device Type", profileField: "phoneType", kind: "single" },
    { selector: "#phoneNumber--countryPhoneCode", question: "Country Phone Code", profileField: "phoneCountryCode", kind: "single", preference: true, search: true },
    { selector: "#source--source", question: "How Did You Hear About Us?", profileField: "referralSources", kind: "multi", search: true },
    { selector: "#personalInfoUS--veteranStatus", question: "Please select one of the options below:", kind: "single" },
    { selector: "#personalInfoUS--hispanicOrLatino", question: "Are you Hispanic or Latino?", kind: "single" },
    { selector: "#personalInfoUS--gender", question: "Gender", kind: "single" },
  ];

  const WORKDAY_REPEATABLE_SECTIONS = [
    { kind: "experience", sectionLabel: "Work-Experience-section", panelPrefix: "Work-Experience", controlPrefix: "workExperience" },
    { kind: "education", sectionLabel: "Education-section", panelPrefix: "Education", controlPrefix: "education" },
    { kind: "languages", sectionLabel: "Languages-section", panelPrefix: "Languages", controlPrefix: "language" },
    { kind: "websites", sectionLabel: "Websites-section", panelPrefix: "Websites", controlPrefix: "webAddress" },
  ];

  const WORKDAY_LANGUAGE_RATINGS = ["comprehension", "overall", "reading", "speaking", "writing"];

  function repeatableRowPattern(section) {
    return new RegExp(`^${section.panelPrefix}-\\d+-panel$`);
  }

  function workdayRowsForSection(section, root = document.querySelector(`[aria-labelledby="${section.sectionLabel}"]`)) {
    if (!root) return [];
    const pattern = repeatableRowPattern(section);
    return Array.from(root.querySelectorAll("[aria-labelledby]"))
      .filter((element) => pattern.test(element.getAttribute("aria-labelledby") ?? ""));
  }

  function workdayRepeatableField(element, section, row) {
    if (!(element instanceof Element) || !row?.contains(element)) return "";
    const id = element.getAttribute("id") ?? "";
    const name = element.getAttribute("name") ?? "";
    const idMatches = (field) => new RegExp(`^${section.controlPrefix}-\\d+--${field}$`).test(id);
    if (section.kind === "experience") {
      if (idMatches("jobTitle")) return "title";
      if (idMatches("companyName")) return "company";
      if (idMatches("location")) return "location";
      if (idMatches("currentlyWorkHere") || name === "currentlyWorkHere") return "currentlyWorkHere";
      if (id.includes("--startDate-dateSectionMonth-input") || id.includes("--startDate-dateSectionYear-input")
        || element.closest('[data-automation-id="formField-startDate"]')) return "startDate";
      if (id.includes("--endDate-dateSectionMonth-input") || id.includes("--endDate-dateSectionYear-input")
        || element.closest('[data-automation-id="formField-endDate"]')) return "endDate";
      if (idMatches("roleDescription")) return "description";
    }
    if (section.kind === "education") {
      if (idMatches("schoolName")) return "school";
      if (idMatches("degree")) return "degree";
      if (idMatches("fieldOfStudy")) return "fieldOfStudy";
      if (idMatches("gradeAverage")) return "gradeAverage";
      if (id.includes("--startDate-dateSectionMonth-input") || id.includes("--startDate-dateSectionYear-input")
        || element.closest('[data-automation-id="formField-startDate"]')) return "startDate";
      if (id.includes("--endDate-dateSectionMonth-input") || id.includes("--endDate-dateSectionYear-input")
        || element.closest('[data-automation-id="formField-endDate"]')) return "endDate";
    }
    if (section.kind === "languages") {
      if (name === "language" && element.matches('button[aria-haspopup="listbox"]')) return "language";
      if (name === "native" && element instanceof HTMLInputElement && element.type === "checkbox") return "fluent";
      if (element instanceof HTMLButtonElement && element.matches('button[aria-haspopup="listbox"]')) {
        const wrapper = element.closest('[data-automation-id^="formField-"]');
        const labels = [element.getAttribute("aria-label"), ...Array.from(wrapper?.querySelectorAll("label") ?? [], textOf), textOf(wrapper)]
          .filter(Boolean).join(" ").toLocaleLowerCase("en-US");
        return WORKDAY_LANGUAGE_RATINGS.find((field) => new RegExp(`\\b${field}\\b`).test(labels)) ?? "";
      }
    }
    if (section.kind === "websites" && name === "url" && idMatches("url")) return "url";
    return "";
  }

  function workdayRepeatableContext(element) {
    if (!isWorkdayHost() || !(element instanceof Element)) return null;
    for (const section of WORKDAY_REPEATABLE_SECTIONS) {
      const root = element.closest(`[aria-labelledby="${section.sectionLabel}"]`);
      if (!root) continue;
      let row = element;
      while (row && row !== root && !repeatableRowPattern(section).test(row.getAttribute("aria-labelledby") ?? "")) {
        row = row.parentElement;
      }
      if (!row || row === root || !repeatableRowPattern(section).test(row.getAttribute("aria-labelledby") ?? "")) return null;
      const rowIndex = workdayRowsForSection(section, root).indexOf(row);
      if (rowIndex < 0) return null;
      const field = workdayRepeatableField(element, section, row);
      if (!field) return null;
      return { section, root, row, rowIndex, field, key: `repeatable:${section.kind}:${rowIndex}:${field}` };
    }
    return null;
  }

  function isWorkdayRepeatableElement(element) {
    if (!isWorkdayHost() || !(element instanceof Element)) return false;
    for (const section of WORKDAY_REPEATABLE_SECTIONS) {
      const root = element.closest(`[aria-labelledby="${section.sectionLabel}"]`);
      if (!root) continue;
      for (let row = element; row && row !== root; row = row.parentElement) {
        if (repeatableRowPattern(section).test(row.getAttribute("aria-labelledby") ?? "")) return true;
      }
    }
    return false;
  }

  function workdayRepeatableStructureKey(element) {
    if (!(element instanceof Element)) return "";
    const button = element.closest("button");
    if (!button) return "";
    const names = [button.getAttribute("aria-label"), textOf(button)].map(normalizedKey).filter(Boolean);
    for (const section of WORKDAY_REPEATABLE_SECTIONS) {
      const root = button.closest(`[aria-labelledby="${section.sectionLabel}"]`);
      if (!root) continue;
      const add = button.getAttribute("data-automation-id") === "add-button"
        && names.some((name) => ["add", "add another"].includes(name));
      const row = button.closest(`[aria-labelledby]`);
      const deleteRow = names.includes("delete") && row && repeatableRowPattern(section).test(row.getAttribute("aria-labelledby") ?? "");
      if (add || deleteRow) return `repeatable:${section.kind}:structure`;
    }
    return "";
  }

  function workdaySectionWarnings(profile, userEditedKeys = []) {
    const editedKeys = userEditedKeys instanceof Set ? userEditedKeys : new Set(Array.isArray(userEditedKeys) ? userEditedKeys : []);
    const warnings = [];
    for (const section of WORKDAY_REPEATABLE_SECTIONS) {
      const configured = ANSWER_CONTRACT.profileRowsForWorkday(profile, section.kind);
      const root = document.querySelector(`[aria-labelledby="${section.sectionLabel}"]`);
      if (!root || !isVisible(root)) continue;
      const rows = workdayRowsForSection(section, root);
      if (rows.length > configured.targetCount) warnings.push({
        section: section.kind,
        requestedRows: configured.targetCount,
        existingRows: rows.length,
        message: section.kind === "experience"
          ? editedKeys.has("repeatable:experience:structure")
            ? `Workday has ${rows.length} work-experience panels and the saved row count is ${configured.targetCount}; trusted row changes in this session are preserved. Change and save the profile count if you want the session to resize them.`
            : `Workday has ${rows.length} work-experience panels and the saved row count is ${configured.targetCount}; Start will remove extra panels using only each extra panel’s Delete control.`
          : `${section.kind} has ${rows.length} existing row${rows.length === 1 ? "" : "s"} and ${configured.targetCount} configured meaningful row${configured.targetCount === 1 ? "" : "s"}; existing rows will be left in place.`,
      });
      if (configured.invalidCount) warnings.push({
        section: section.kind,
        requestedRows: configured.targetCount,
        existingRows: rows.length,
        message: `${configured.invalidCount} saved website URL${configured.invalidCount === 1 ? " is" : "s are"} not valid HTTP(S) addresses and will stay blank.`,
      });
    }
    return warnings;
  }

  function repeatableRowLabel(section, index) {
    const title = section.kind === "experience" ? "Work experience"
      : section.kind === "education" ? "Education"
        : section.kind === "languages" ? "Language" : "Website";
    return `${title} ${index + 1}`;
  }

  function workdayRowControl(row, section, field) {
    return Array.from(row.querySelectorAll("input, select, textarea, button"))
      .find((element) => workdayRepeatableField(element, section, row) === field) ?? null;
  }

  function workdayDateParts(row, section, field) {
    const wrapper = row.querySelector(`[data-automation-id="formField-${field}"]`);
    if (!wrapper) return { month: null, year: null };
    return {
      month: wrapper.querySelector('[data-automation-id="dateSectionMonth-input"]'),
      year: wrapper.querySelector('[data-automation-id="dateSectionYear-input"]'),
    };
  }

  function datePartIsBlank(element, part) {
    if (!element) return false;
    const value = normalize(element.value);
    if (!value) return true;
    return part === "month"
      ? /^(?:month|mm|select one|--)$/.test(value.toLocaleLowerCase("en-US"))
      : /^(?:year|yyyy|select one|--)$/.test(value.toLocaleLowerCase("en-US"));
  }

  function workdayPickerCurrentValue(control, knownLabels = []) {
    const candidates = [textOf(control), control.getAttribute("aria-label")].map(normalize).filter(Boolean);
    const normalizedLabels = knownLabels.map((label) => ({ label, key: normalizedKey(label) }));
    for (const candidate of candidates) {
      const key = normalizedKey(candidate);
      const exact = normalizedLabels.find((entry) => entry.key === key);
      if (exact) return exact.label;
      const suffix = normalizedLabels.find((entry) => key.endsWith(entry.key));
      if (suffix) return suffix.label;
      if (/^(?:.*\s)?(?:select(?: one)?|choose|please select(?: one)?)(?:\s+(?:required|optional))?$/i.test(candidate)) continue;
      if (isWorkdayPlaceholder(candidate)) continue;
      const stripped = candidate.replace(/\s+(?:required|optional)$/i, "").replace(/\s*\*\s*$/, "").trim();
      if (!isWorkdayPlaceholder(stripped)) return stripped;
    }
    return "";
  }

  function dispatchWorkdayAdd(button) {
    if (!(button instanceof HTMLButtonElement) || button.disabled || !isVisible(button)) return false;
    const label = normalizedKey(textOf(button));
    if (!new Set(["add", "add another"]).has(label)
      || button.getAttribute("data-automation-id") !== "add-button"
      || button.closest('[data-automation-id="applyFlowReviewPage"]')) return false;
    const originalType = button.getAttribute("type");
    button.setAttribute("type", "button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (originalType == null) button.removeAttribute("type");
    else button.setAttribute("type", originalType);
    return true;
  }

  async function addWorkdayRows(section, targetCount) {
    let rows = workdayRowsForSection(section);
    while (rows.length < targetCount) {
      const root = document.querySelector(`[aria-labelledby="${section.sectionLabel}"]`);
      const addButton = Array.from(root?.querySelectorAll('button[data-automation-id="add-button"]') ?? [])
        .find((button) => isVisible(button) && ["add", "add another"].includes(normalizedKey(textOf(button))));
      if (!root || !addButton || !dispatchWorkdayAdd(addButton)) break;
      const previousCount = rows.length;
      const startedAt = Date.now();
      do {
        await wait(50);
        rows = workdayRowsForSection(section, root);
        if (rows.length > previousCount) break;
      } while (Date.now() - startedAt < 900);
      if (rows.length <= previousCount) break;
    }
    return rows;
  }

  function workdayRowNumber(row, section) {
    const match = String(row?.getAttribute("aria-labelledby") ?? "").match(repeatableRowPattern(section));
    if (!match) return null;
    const number = String(row.getAttribute("aria-labelledby")).match(/-(\d+)-panel$/)?.[1];
    return number ? Number(number) : null;
  }

  async function trimWorkdayExperienceRows(section, targetCount, result) {
    let rows = workdayRowsForSection(section);
    let attempts = 0;
    while (rows.length > targetCount && attempts < 20) {
      const row = rows[rows.length - 1];
      const rowNumber = workdayRowNumber(row, section);
      const buttons = Array.from(row.querySelectorAll("button")).filter((button) => {
        const names = [button.getAttribute("aria-label"), textOf(button)].map(normalize).filter(Boolean);
        return isVisible(button) && !button.disabled && names.some((name) => normalizedKey(name) === "delete");
      });
      if (buttons.length !== 1 || !Number.isInteger(rowNumber)) {
        const isOnlyRow = rows.length === 1;
        addSectionWarning(result, section, rows.length - 1,
          isOnlyRow
            ? "Workday does not expose a Delete control for its remaining first work-experience panel; the requested row count cannot go below one here."
            : `The extra Work Experience ${rowNumber ?? rows.length} panel has no unique visible Delete control, so it and any earlier rows were preserved.`);
        break;
      }
      const button = buttons[0];
      const root = document.querySelector(`[aria-labelledby="${section.sectionLabel}"]`);
      const previousCount = rows.length;
      const originalType = button.getAttribute("type");
      button.setAttribute("type", "button");
      const cancelDefault = (event) => { if (!event.isTrusted) event.preventDefault(); };
      button.addEventListener("click", cancelDefault, { capture: true, once: true });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      button.removeEventListener("click", cancelDefault, true);
      if (originalType == null) button.removeAttribute("type");
      else button.setAttribute("type", originalType);
      const startedAt = Date.now();
      do {
        await wait(50);
        rows = workdayRowsForSection(section, root);
        if (rows.length < previousCount) break;
      } while (Date.now() - startedAt < 900);
      if (rows.length >= previousCount) {
        addSectionWarning(result, section, previousCount - 1,
          `Workday did not remove the extra Work Experience ${rowNumber} panel after its row-scoped Delete control; remaining rows were preserved.`);
        break;
      }
      attempts += 1;
    }
    if (rows.length > targetCount && attempts >= 20) {
      addSectionWarning(result, section, null,
        "Workday has more than 20 extra work-experience panels; removal stopped at the safety limit. Review the remaining rows manually.");
    }
    return rows;
  }

  function workdayRowIdentity(section, row) {
    if (section.kind === "experience") return normalize(workdayRowControl(row, section, "company")?.value);
    if (section.kind === "education") return normalize(workdayRowControl(row, section, "school")?.value);
    if (section.kind === "languages") return workdayPickerCurrentValue(workdayRowControl(row, section, "language"), ["Chinese", "English"]);
    if (section.kind === "websites") return normalize(workdayRowControl(row, section, "url")?.value);
    return "";
  }

  function addSectionWarning(result, section, index, message) {
    const key = `${section.kind}:${index ?? "section"}:${message}`;
    if (result.warningKeys.has(key)) return;
    result.warningKeys.add(key);
    result.sectionWarnings.push({
      section: section.kind,
      ...(Number.isInteger(index) ? { rowIndex: index } : {}),
      message,
    });
  }

  function fillWorkdayRowText(control, value, context, result, label) {
    const desired = normalize(value);
    if (!desired) return;
    if (!control || !isMutable(control) || !isVisible(control)) {
      addSectionWarning(result, context.section, context.rowIndex, `${label} is saved, but its editable field is not available on this row.`);
      return;
    }
    const key = `repeatable:${context.section.kind}:${context.rowIndex}:${context.field}`;
    if (context.options.userEditedKeys?.has(key)) { result.leftExisting += 1; return; }
    if (normalize(control.value)) { result.leftExisting += 1; return; }
    dispatchValue(control, desired);
    result.filled.push(`${repeatableRowLabel(context.section, context.rowIndex)} · ${label}`);
  }

  async function fillWorkdayRowPicker(control, value, context, result, label, knownLabels = []) {
    const desired = normalize(value);
    if (!desired) return false;
    if (!control || !isMutable(control) || !isVisible(control)) {
      addSectionWarning(result, context.section, context.rowIndex, `${label} is saved, but its picker is not available on this row.`);
      return false;
    }
    const key = `repeatable:${context.section.kind}:${context.rowIndex}:${context.field}`;
    if (context.options.userEditedKeys?.has(key)) { result.leftExisting += 1; return false; }
    const current = workdayPickerCurrentValue(control, knownLabels);
    if (current) {
      if (normalizedKey(current) !== normalizedKey(desired)) {
        addSectionWarning(result, context.section, context.rowIndex, `${label} already has a different selection and was left unchanged.`);
        result.leftExisting += 1;
        return false;
      }
      result.leftExisting += 1;
      return true;
    }
    const controlKey = workdayFieldKey(control) || control.id || "";
    programmaticWorkdayPickerKey = controlKey;
    const resultOptions = await workdayOptionFor(control, desired, {});
    if (!resultOptions.option || resultOptions.options.filter((option) => exactVisibleChoice(option, desired)).length !== 1) {
      await dismissWorkdayPickers();
      addSectionWarning(result, context.section, context.rowIndex, `${label} “${desired}” did not match exactly one visible Workday option and was left for review.`);
      return false;
    }
    chooseWorkdayOption(resultOptions.option.element);
    await wait(80);
    const selected = workdayPickerCurrentValue(control, [desired]);
    await dismissWorkdayPickers();
    if (!selected || normalizedKey(selected) !== normalizedKey(desired)) {
      addSectionWarning(result, context.section, context.rowIndex, `${label} selection could not be verified and was left for review.`);
      return false;
    }
    result.filled.push(`${repeatableRowLabel(context.section, context.rowIndex)} · ${label}`);
    result.selected.push({ question: `${repeatableRowLabel(context.section, context.rowIndex)} · ${label}`, choices: [desired] });
    return true;
  }

  function workdayFieldStudySelections(control) {
    const wrapper = control?.closest('[data-automation-id="formField-fieldOfStudy"]');
    return Array.from(wrapper?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])
      .filter(isVisible)
      .map((item) => cleanVisibleQuestion(textOf(item)))
      .filter(Boolean);
  }

  async function fillWorkdayFieldStudy(control, value, context, result) {
    const desired = normalize(value);
    if (!desired) return false;
    const label = "Field of Study";
    const key = `repeatable:${context.section.kind}:${context.rowIndex}:${context.field}`;
    const selections = workdayFieldStudySelections(control);
    if (selections.length) {
      if (selections.length === 1 && normalizedKey(selections[0]) === normalizedKey(desired)) {
        result.leftExisting += 1;
        return true;
      }
      addSectionWarning(result, context.section, context.rowIndex,
        `${label} already has a different or multiple catalog selection and was left unchanged.`);
      result.leftExisting += 1;
      return false;
    }
    if (!control || !(control instanceof HTMLInputElement) || !isMutable(control) || !isVisible(control)
      || !new RegExp(`^${context.section.controlPrefix}-\\d+--fieldOfStudy$`).test(control.id)
      || control.getAttribute("name") !== "fieldOfStudy"
      || control.getAttribute("enterkeyhint") !== "search"
      || !control.closest('[data-automation-id="multiSelectContainer"]')
      || !control.closest('[data-automation-id="formField-fieldOfStudy"]')
      || control.closest("form")) {
      addSectionWarning(result, context.section, context.rowIndex,
        `${label} is saved, but its observed Workday catalog search is not available on this row.`);
      return false;
    }
    if (context.options.userEditedKeys?.has(key) || normalize(control.value)) {
      result.leftExisting += 1;
      return false;
    }
    if (visibleWorkdayListboxes().length) {
      addSectionWarning(result, context.section, context.rowIndex,
        `${label} was left for review because another Workday picker is already open.`);
      return false;
    }

    const controlKey = workdayFieldKey(control) || control.id;
    programmaticWorkdayPickerKey = controlKey;
    control.focus();
    dispatchValue(control, desired);
    if (normalize(control.value) !== desired) {
      programmaticWorkdayPickerKey = "";
      addSectionWarning(result, context.section, context.rowIndex,
        `${label} search could not be entered and was left for review.`);
      return false;
    }
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await wait(180);

    const options = visibleWorkdayOptions(control);
    const exactMatches = options.filter((option) => normalizedKey(option.label) === normalizedKey(desired));
    if (exactMatches.length !== 1) {
      await dismissWorkdayPickers();
      if (!workdayFieldStudySelections(control).length && normalize(control.value) === desired) dispatchValue(control, "");
      addSectionWarning(result, context.section, context.rowIndex,
        `${label} “${desired}” did not match exactly one visible catalog item and was left for review.`);
      return false;
    }

    chooseWorkdayOption(exactMatches[0].element);
    await wait(100);
    await dismissWorkdayPickers();
    const selected = workdayFieldStudySelections(control);
    if (selected.length !== 1 || normalizedKey(selected[0]) !== normalizedKey(desired)) {
      addSectionWarning(result, context.section, context.rowIndex,
        `${label} selection could not be verified from its selected-item tag and was left for review.`);
      return false;
    }
    result.filled.push(`${repeatableRowLabel(context.section, context.rowIndex)} · ${label}`);
    result.selected.push({ question: `${repeatableRowLabel(context.section, context.rowIndex)} · ${label}`, choices: [desired] });
    return true;
  }

  function fillWorkdayRowCheckbox(control, desired, context, result, label, mayOverrideExistingFalse = false) {
    if (typeof desired !== "boolean") return;
    if (!(control instanceof HTMLInputElement) || control.type !== "checkbox" || !isMutable(control)) {
      addSectionWarning(result, context.section, context.rowIndex, `${label} is saved, but its checkbox is not editable on this row.`);
      return;
    }
    const key = `repeatable:${context.section.kind}:${context.rowIndex}:${context.field}`;
    if (context.options.userEditedKeys?.has(key)) { result.leftExisting += 1; return; }
    if (control.checked === desired) { result.leftExisting += 1; return; }
    if (!control.checked && !desired) { result.leftExisting += 1; return; }
    if (control.checked && !desired && !mayOverrideExistingFalse) { result.leftExisting += 1; return; }
    if (dispatchChecked(control, desired)) {
      const question = `${repeatableRowLabel(context.section, context.rowIndex)} · ${label}`;
      result.filled.push(question);
      result.selected.push({ question, choices: [desired ? "Yes" : "No"] });
    }
    else addSectionWarning(result, context.section, context.rowIndex, `${label} could not be set and was left for review.`);
  }

  async function fillWorkdayRowDate(row, section, field, value, rowIndex, result, options) {
    const desired = ANSWER_CONTRACT.parseWorkdayDate(value);
    if (!desired) {
      if (normalize(value)) addSectionWarning(result, section, rowIndex, `${field === "startDate" ? "Start" : "End"} date must use YYYY-MM or YYYY; other formats were left for review.`);
      return;
    }
    const parts = workdayDateParts(row, section, field);
    const key = `repeatable:${section.kind}:${rowIndex}:${field}`;
    if (options.userEditedKeys?.has(key)) { result.leftExisting += 1; return; }
    for (const part of ["month", "year"]) {
      const control = parts[part];
      const requested = desired[part];
      if (!requested) continue;
      if (!control || !isMutable(control) || !isVisible(control)) {
        addSectionWarning(result, section, rowIndex, `${field === "startDate" ? "Start" : "End"} ${part} input is not available; no calendar controls were activated.`);
        continue;
      }
      if (!datePartIsBlank(control, part)) { result.leftExisting += 1; continue; }
      dispatchValue(control, requested);
      result.filled.push(`${repeatableRowLabel(section, rowIndex)} · ${field === "startDate" ? "Start" : "End"} ${part}`);
    }
  }

  async function fillWorkdayRepeatableSections(payload, options = {}) {
    const result = { filled: [], selected: [], leftExisting: 0, sectionWarnings: [], warningKeys: new Set() };
    const profile = payload.profile ?? {};
    for (const section of WORKDAY_REPEATABLE_SECTIONS) {
      const configured = ANSWER_CONTRACT.profileRowsForWorkday(profile, section.kind);
      const root = document.querySelector(`[aria-labelledby="${section.sectionLabel}"]`);
      if (!root || !isVisible(root)) continue;
      const structureKey = `repeatable:${section.kind}:structure`;
      const structureEdited = options.userEditedKeys?.has(structureKey) === true;
      let rows = workdayRowsForSection(section, root);
      if (rows.length > configured.targetCount) {
        if (section.kind === "experience" && !structureEdited) {
          rows = await trimWorkdayExperienceRows(section, configured.targetCount, result);
        } else if (structureEdited) {
          addSectionWarning(result, section, null,
            `Workday currently has ${rows.length} ${section.kind} rows while the saved count is ${configured.targetCount}; your later row changes were preserved. Change and save the profile count if you want the session to resize them.`);
        }
      }
      if (configured.targetCount > rows.length) {
        if (!structureEdited) rows = await addWorkdayRows(section, configured.targetCount);
        else addSectionWarning(result, section, null,
          `Workday currently has ${rows.length} ${section.kind} rows while the saved count is ${configured.targetCount}; your later row changes were preserved. Change and save the profile count if you want the session to resize them.`);
      }
      const plan = ANSWER_CONTRACT.planWorkdayRows(profile, section.kind, rows.map((row) => workdayRowIdentity(section, row)));
      if (rows.length < configured.targetCount) addSectionWarning(result, section, null,
        `Workday shows ${rows.length} ${section.kind} row${rows.length === 1 ? "" : "s"}, but ${configured.targetCount} meaningful profile row${configured.targetCount === 1 ? "" : "s"} are saved. Only existing rows were filled; use the section’s Add control to complete the rest.`);
      if (rows.length > configured.targetCount) addSectionWarning(result, section, null,
        `Workday shows ${rows.length} ${section.kind} row${rows.length === 1 ? "" : "s"} and the profile has ${configured.targetCount} configured meaningful row${configured.targetCount === 1 ? "" : "s"}. Existing rows were kept.`);
      const identityConflicts = new Set(plan.identityConflicts);
      for (const rowIndex of plan.identityConflicts) {
        const noun = section.kind === "experience" ? "company" : section.kind === "education" ? "school" : section.kind === "languages" ? "language" : "website";
        const record = configured.rows[rowIndex];
        const isBlankCompanyOffDefault = section.kind === "experience"
          && record?.currentlyWorkHere === false && !normalize(record.company);
        addSectionWarning(result, section, rowIndex,
          `${repeatableRowLabel(section, rowIndex)} already contains a different ${noun}; profile-specific values were not copied${isBlankCompanyOffDefault ? ", but the blank-company current-work default was applied" : ""}.`);
      }
      for (let rowIndex = 0; rowIndex < Math.min(rows.length, configured.rows.length); rowIndex += 1) {
        const record = configured.rows[rowIndex];
        const meaningful = ANSWER_CONTRACT.profileRowIsMeaningful(section.kind, record);
        const explicitWorkdayCheckbox = section.kind === "experience"
          && (record?.currentlyWorkHere === true || record?.currentlyWorkHere === false);
        if (!meaningful && !explicitWorkdayCheckbox) continue;
        const context = { section, rowIndex, options };
        if (identityConflicts.has(rowIndex)) {
          if (ANSWER_CONTRACT.shouldApplyWorkdayCurrentFlag(record, true)) fillWorkdayRowCheckbox(workdayRowControl(rows[rowIndex], section, "currentlyWorkHere"), record.currentlyWorkHere,
            { ...context, field: "currentlyWorkHere" }, result, "I currently work here", true);
          continue;
        }
        if (section.kind === "experience") {
          if (meaningful) {
            fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "title"), record.title, { ...context, field: "title" }, result, "Role title");
            fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "company"), record.company, { ...context, field: "company" }, result, "Company");
            fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "location"), record.location, { ...context, field: "location" }, result, "Location");
            fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "description"), record.description,
              { ...context, field: "description" }, result, "Role description");
            await fillWorkdayRowDate(rows[rowIndex], section, "startDate", record.startDate, rowIndex, result, options);
            await fillWorkdayRowDate(rows[rowIndex], section, "endDate", record.endDate, rowIndex, result, options);
          }
          if (explicitWorkdayCheckbox) fillWorkdayRowCheckbox(workdayRowControl(rows[rowIndex], section, "currentlyWorkHere"), record.currentlyWorkHere,
            { ...context, field: "currentlyWorkHere" }, result, "I currently work here", true);
        } else if (section.kind === "education") {
          fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "school"), record.school, { ...context, field: "school" }, result, "School");
          fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "gradeAverage"), record.gradeAverage,
            { ...context, field: "gradeAverage" }, result, "Overall result (GPA)");
          await fillWorkdayRowPicker(workdayRowControl(rows[rowIndex], section, "degree"), record.degree,
            { ...context, field: "degree" }, result, "Degree");
          await fillWorkdayFieldStudy(workdayRowControl(rows[rowIndex], section, "fieldOfStudy"), record.fieldOfStudy,
            { ...context, field: "fieldOfStudy" }, result);
          await fillWorkdayRowDate(rows[rowIndex], section, "startDate", record.startDate, rowIndex, result, options);
          await fillWorkdayRowDate(rows[rowIndex], section, "endDate", record.endDate, rowIndex, result, options);
        } else if (section.kind === "languages") {
          const languageControl = workdayRowControl(rows[rowIndex], section, "language");
          const languageSet = await fillWorkdayRowPicker(languageControl, record.language, { ...context, field: "language" }, result, "Language");
          const currentLanguage = workdayRowIdentity(section, rows[rowIndex]);
          if (languageSet || normalizedKey(currentLanguage) === normalizedKey(record.language)) {
            fillWorkdayRowCheckbox(workdayRowControl(rows[rowIndex], section, "fluent"), record.fluent,
              { ...context, field: "fluent" }, result, "Fluent");
            for (const rating of WORKDAY_LANGUAGE_RATINGS) {
              await fillWorkdayRowPicker(workdayRowControl(rows[rowIndex], section, rating), record[rating],
                { ...context, field: rating }, result, rating.charAt(0).toUpperCase() + rating.slice(1),
                ["1 - Beginner", "2 - Classroom Study", "3 - Intermediate", "4 - Advanced", "5 - Fluent"]);
            }
          }
        } else if (section.kind === "websites") {
          fillWorkdayRowText(workdayRowControl(rows[rowIndex], section, "url"), record.url, { ...context, field: "url" }, result, "URL");
        }
      }
    }
    delete result.warningKeys;
    return result;
  }

  function isWorkdaySearchControl(element) {
    return WORKDAY_CUSTOM_FIELDS.some((field) => field.search && element.matches(field.selector));
  }

  function workdayPathPrefix(pathname) {
    const match = String(pathname).match(/^(.*\/apply)(?:\/|$)/i);
    return match?.[1] ?? "";
  }

  function workdaySessionRouteAllowed(session) {
    let current;
    try { current = new URL(location.href); } catch { return false; }
    return current.origin === session.origin
      && (current.pathname.toLowerCase() === session.pathPrefix.toLowerCase()
        || current.pathname.toLowerCase().startsWith(`${session.pathPrefix.toLowerCase()}/`));
  }

  function currentWorkdaySession() {
    const session = globalThis.__scoutWorkdaySession;
    if (!session || session.stopped || Date.now() - session.startedAt > WORKDAY_SESSION_WINDOW_MS) return null;
    return session;
  }

  function workdayCustomDescriptor(field, control, choices = [], payload = {}) {
    const choiceList = choices.map((label) => ({ label, value: label }));
    return {
      question: field.question,
      kind: workdayCustomKind(field, control) === "multi" ? "multi-select" : "select",
      key: normalizedKey(field.question),
      choices: choiceList,
      scopeContext: pageScopeFor(field.question, payload),
      reviewRequired: isReviewRequired(field.question),
      element: control,
    };
  }

  function workdayCustomKind(field, control) {
    // Mercer exposes this prompt as a searchable multi-select. Semtech exposes
    // the same prompt as a single-choice button; the observed control shape
    // determines the adapter without assuming a tenant-wide widget contract.
    if (field.profileField === "referralSources" && control instanceof HTMLButtonElement) return "single";
    return field.kind;
  }

  function workdayCustomUsesSearchInput(field, control) {
    return Boolean(field.search && !(field.profileField === "referralSources" && control instanceof HTMLButtonElement));
  }

  function customCurrentSelection(field, control) {
    if (workdayCustomKind(field, control) === "multi" || workdayCustomUsesSearchInput(field, control)) {
      const wrapper = control.closest('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"]')
        ?? control.closest('[data-automation-id^="formField-"]')
        ?? control.parentElement;
      const selected = wrapper?.querySelector('[role="listbox"][data-automation-id="selectedItemList"]');
      return selected ? Array.from(selected.querySelectorAll("li")).map((item) => {
        const clone = item.cloneNode(true);
        clone.querySelectorAll("button, [aria-label]").forEach((element) => element.remove());
        return cleanVisibleQuestion(textOf(clone));
      }).filter(Boolean) : [];
    }
    const prompt = normalize(field.question);
    const stripPrompt = (value) => {
      let candidate = normalize(value);
      if (candidate.toLocaleLowerCase("en-US").startsWith(prompt.toLocaleLowerCase("en-US"))) {
        candidate = candidate.slice(prompt.length).replace(/^\s*(?:\*\s*)?/, "");
      }
      candidate = candidate.replace(/\s+(?:required|optional)$/i, "").replace(/\s*\*\s*$/, "").trim();
      return isWorkdayPlaceholder(candidate) ? "" : candidate;
    };
    return stripPrompt(textOf(control)) || stripPrompt(control.getAttribute("aria-label"));
  }

  function isWorkdayPlaceholder(value) {
    const text = normalize(value);
    return !text || /^(?:select(?: one)?|choose|search|please select(?: one)?(?: of the options below)?|please choose)$/i.test(text);
  }

  function customRequestedValues(field, payload) {
    const control = document.querySelector(field.selector);
    const kind = workdayCustomKind(field, control);
    const resolved = ANSWER_CONTRACT.resolveAnswer(field.question, payload.answers ?? [], pageScopeFor(field.question, payload));
    if (resolved.ambiguous) return { ambiguous: true, values: [] };
    if (resolved.answer) {
      const answer = resolved.answer;
      if (kind === "multi") {
        if (answer.answerType === "multi-choice") return { values: answer.selectedChoices, reviewedEmpty: answer.selectedChoices.length === 0 };
        if ((answer.answerType ?? "text") === "text" && answer.answer.trim()) return { values: [answer.answer.trim()] };
        return { values: [], answerMismatch: true };
      }
      if (answer.answerType === "single-choice") {
        return answer.selectedChoices.length === 1 ? { values: answer.selectedChoices } : { values: [], answerMismatch: true };
      }
      if ((answer.answerType ?? "text") === "text" && answer.answer.trim()) return { values: [answer.answer.trim()] };
      return { values: [], answerMismatch: true };
    }
    const configured = payload.profile?.[field.profileField];
    if (kind === "multi") return { values: Array.isArray(configured) ? configured.map(normalize).filter(Boolean) : [] };
    if (field.profileField === "referralSources" && Array.isArray(configured)) {
      const values = configured.map(normalize).filter(Boolean);
      return values.length <= 1 ? { values } : { values: [], answerMismatch: true };
    }
    return { values: typeof configured === "string" && configured.trim() ? [configured.trim()] : [] };
  }

  function workdayListboxRoots(control) {
    const referenceIds = (control ? `${control.getAttribute("aria-controls") ?? ""} ${control.getAttribute("aria-owns") ?? ""}` : "")
      .split(/\s+/).filter(Boolean);
    const declaredReferences = referenceIds.length > 0;
    if (declaredReferences) {
      const referenced = referenceIds.map((id) => document.getElementById(id)).filter(Boolean);
      if (!referenced.length) return [];
      const roots = referenced.flatMap((node) => node.matches?.('[role="listbox"]')
        ? [node]
        : Array.from(node.querySelectorAll?.('[role="listbox"]') ?? []));
      return [...new Set(roots)].filter((listbox) => isVisible(listbox)
        && listbox.getAttribute("data-automation-id") !== "selectedItemList");
    }
    const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'))
      .filter((listbox) => isVisible(listbox) && listbox.getAttribute("data-automation-id") !== "selectedItemList");
    const controlKey = workdayFieldKey(control) || control?.id || "";
    const sessionPickerKey = currentWorkdaySession()?.activePicker?.key ?? "";
    const belongsToControl = (programmaticWorkdayPickerKey && programmaticWorkdayPickerKey === controlKey)
      || (sessionPickerKey && sessionPickerKey === controlKey);
    return belongsToControl && listboxes.length === 1 ? listboxes : [];
  }

  function visibleWorkdayOptions(control) {
    const controlKey = workdayFieldKey(control) || control?.id || "";
    const sessionPickerKey = currentWorkdaySession()?.activePicker?.key ?? "";
    if ((programmaticWorkdayPickerKey && programmaticWorkdayPickerKey !== controlKey)
      || (sessionPickerKey && sessionPickerKey !== controlKey)) return [];
    const roots = workdayListboxRoots(control);
    return roots.flatMap((root) => Array.from(root.querySelectorAll('[role="option"]')))
      .filter((option) => isVisible(option) && !option.closest('[data-automation-id="selectedItemList"]')
        && option.getAttribute("aria-disabled") !== "true" && !option.hasAttribute("disabled")
        && !/^(?:select(?: one)?|choose|please select|please choose)$/i.test(normalize(textOf(option))))
      .map((option) => ({ element: option, label: cleanVisibleQuestion(textOf(option)) }))
      .filter((option) => option.label);
  }

  function visibleWorkdayListboxes() {
    return Array.from(document.querySelectorAll('[role="listbox"]'))
      .filter((listbox) => isVisible(listbox) && listbox.getAttribute("data-automation-id") !== "selectedItemList");
  }

  function workdayStepHeadingElement() {
    const pageHeader = document.querySelector('[data-automation-id="pageHeader"]');
    return Array.from((pageHeader ?? document).querySelectorAll("h3")).find(isVisible)
      || Array.from(document.querySelectorAll("h3")).find(isVisible)
      || null;
  }

  async function dismissWorkdayPickers() {
    if (!visibleWorkdayListboxes().length) {
      programmaticWorkdayPickerKey = "";
      return true;
    }
    const heading = workdayStepHeadingElement();
    if (!heading) return false;
    heading.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    heading.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    dispatchWorkdayPickerClick(heading);
    await wait(100);
    const closed = visibleWorkdayListboxes().length === 0;
    if (closed) {
      programmaticWorkdayPickerKey = "";
      const session = currentWorkdaySession();
      if (session) session.activePicker = null;
    }
    return closed;
  }

  function hasActiveWorkdayOption(control) {
    if (!visibleWorkdayOptions(control).length) return false;
    const activeLists = Array.from(document.querySelectorAll('[role="listbox"][aria-activedescendant]'))
      .filter((listbox) => isVisible(listbox)
        && document.getElementById(listbox.getAttribute("aria-activedescendant"))?.closest('[role="listbox"]') === listbox);
    return activeLists.length === 1;
  }

  async function activateWorkdayListbox(control) {
    control.focus?.();
    const controlKey = workdayFieldKey(control) || control.id || "";
    const roots = workdayListboxRoots(control);
    const sessionPickerKey = currentWorkdaySession()?.activePicker?.key ?? "";
    if (roots.length && (programmaticWorkdayPickerKey === controlKey || sessionPickerKey === controlKey)) return true;
    if (visibleWorkdayListboxes().length && (roots.length === 0
      || (programmaticWorkdayPickerKey && programmaticWorkdayPickerKey !== controlKey)
      || (sessionPickerKey && sessionPickerKey !== controlKey))) {
      if (!await dismissWorkdayPickers()) return false;
    }
    if (control.getAttribute("aria-expanded") === "true") {
      await wait(80);
      return workdayListboxRoots(control).length > 0;
    }
    if (control instanceof HTMLButtonElement) {
      // Observed Mercer pickers are type=button controls. Click exactly once,
      // then wait for their React popup rather than racing ArrowDown + click.
      programmaticWorkdayPickerKey = controlKey;
      dispatchWorkdayPickerClick(control);
      await wait(80);
      return workdayListboxRoots(control).length > 0;
    }
    if (control.getAttribute("aria-expanded") !== "true") {
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
      await wait(80);
    }
    if (!visibleWorkdayOptions(control).length) {
      // Workday picker buttons can default to submit inside a form. Run their
      // delegated click handler while preventing that browser default action.
      programmaticWorkdayPickerKey = controlKey;
      dispatchWorkdayPickerClick(control);
      await wait(80);
    }
    return workdayListboxRoots(control).length > 0;
  }

  function dispatchWorkdayPickerClick(element) {
    const maySubmit = (element instanceof HTMLButtonElement && (element.type === "submit" || !element.hasAttribute("type")))
      || (element instanceof HTMLInputElement && element.type === "submit");
    const cancelDefault = (event) => { if (maySubmit && !event.isTrusted) event.preventDefault(); };
    if (maySubmit) element.addEventListener("click", cancelDefault, { capture: true, once: true });
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (maySubmit) element.removeEventListener("click", cancelDefault, true);
  }

  function chooseWorkdayOption(option) {
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    dispatchWorkdayPickerClick(option);
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function workdayDomSignature() {
    const descriptors = collectDescriptors().filter((descriptor) => !isWorkdaySearchControl(descriptor.element));
    const controls = descriptors.map((descriptor) => {
      const element = descriptor.element;
      const identity = [element.id, element.getAttribute("data-automation-id"), element.getAttribute("name"), descriptor.question, descriptor.kind];
      let value;
      if (descriptor.kind === "radio" || descriptor.kind === "checkbox") {
        value = descriptor.choices.map((choice) => Boolean(choice.checked));
      } else if (element instanceof HTMLSelectElement && element.multiple) {
        value = Array.from(element.selectedOptions, (option) => option.value);
      } else if (descriptor.kind === "file") {
        const widgetSelector = workdayResumeUploadKind(element) === "resume-parser"
          ? '[data-automation-id="resumeUpload"]'
          : '[data-automation-id="attachments-FileUpload"]';
        const widget = element.closest(widgetSelector);
        value = {
          inputFiles: Array.from(element.files ?? [], (file) => file.name),
          uploadedItems: Array.from(widget?.querySelectorAll('[data-automation-id="file-upload-item-name"]') ?? [], textOf),
          uploadSuccess: Boolean(widget?.querySelector('[data-automation-id="file-upload-successful"]')),
        };
      } else {
        value = String(element.value ?? "");
      }
      return [identity, value];
    });
    const custom = WORKDAY_CUSTOM_FIELDS.map((field) => {
      const control = document.querySelector(field.selector);
      if (!control || !isVisible(control)) return [field.selector, null];
      return [field.selector, customCurrentSelection(field, control)];
    });
    const questionnaire = collectWorkdayQuestionnaireDescriptors().map(({ element, question }) => [element.id, question, textOf(element)]);
    const repeatable = WORKDAY_REPEATABLE_SECTIONS.map((section) => {
      const root = document.querySelector(`[aria-labelledby="${section.sectionLabel}"]`);
      return [section.kind, workdayRowsForSection(section, root).map((row) => [
        row.getAttribute("aria-labelledby"),
        Array.from(row.querySelectorAll("input, select, textarea, button")).map((element) => [
          element.id,
          element.getAttribute("name"),
          element.getAttribute("data-automation-id"),
          element.getAttribute("aria-label"),
          String(element.value ?? ""),
          element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? element.checked : null,
          element instanceof HTMLButtonElement ? textOf(element) : "",
        ]),
      ])];
    });
    const step = workdayStepTitle();
    const progress = textOf(document.querySelector('[data-automation-id="progressBar"]'));
    return JSON.stringify({ controls, custom, questionnaire, repeatable, step, progress });
  }

  function workdayOptionMatches(field, option, requested) {
    if (normalizedKey(option.label) === normalizedKey(requested)) return true;
    if (field.profileField !== "phoneCountryCode") return false;
    const requestedCountry = countryIn(requested);
    return Boolean(requestedCountry
      && normalizedKey(requested) === normalizedKey(requestedCountry)
      && countryIn(option.label) === requestedCountry);
  }

  function workdayCurrentMatchesRequest(field, current, requested) {
    if (Array.isArray(current)) {
      return current.length === 1 && workdayOptionMatches(field, { label: current[0] }, requested);
    }
    return typeof current === "string" && workdayOptionMatches(field, { label: current }, requested);
  }

  async function workdayOptionFor(control, requested, field) {
    await activateWorkdayListbox(control);
    if (control instanceof HTMLInputElement && control.value !== requested) {
      dispatchValue(control, requested);
      await wait(180);
    }
    const options = visibleWorkdayOptions(control);
    const matches = options.filter((option) => workdayOptionMatches(field, option, requested));
    return matches.length === 1 ? { option: matches[0], options } : { option: null, options };
  }

  async function fillWorkdayCustomFields(payload, options = {}) {
    const filled = [];
    const selected = [];
    const reviewedChoices = [];
    const unknown = [];
    let leftExisting = 0;
    for (const field of WORKDAY_CUSTOM_FIELDS) {
      const control = document.querySelector(field.selector);
      if (!control || !isVisible(control) || control.disabled) continue;
      const key = field.selector.slice(1);
      const userEdited = options.userEditedKeys?.has(key);
      const kind = workdayCustomKind(field, control);
      const usesSearchInput = workdayCustomUsesSearchInput(field, control);
      const requested = customRequestedValues(field, payload);
      const current = customCurrentSelection(field, control);
      const forcePreference = field.preference && options.forceDefaults && !userEdited;
      if (requested.ambiguous) {
        unknown.push(workdayCustomDescriptor(field, control, [], payload));
        continue;
      }
      if (requested.answerMismatch) {
        unknown.push(workdayCustomDescriptor(field, control, [], payload));
        continue;
      }
      if (!requested.values.length) {
        if (requested.reviewedEmpty) {
          selected.push({ question: field.question, choices: [] });
          reviewedChoices.push(field.question);
          continue;
        }
        let choices = visibleWorkdayOptions(control).map((option) => option.label);
        if (!choices.length && !usesSearchInput) {
          await activateWorkdayListbox(control);
          choices = visibleWorkdayOptions(control).map((option) => option.label);
          await dismissWorkdayPickers();
        }
        if (!current || (Array.isArray(current) && current.length === 0)) unknown.push(workdayCustomDescriptor(field, control, choices, payload));
        else leftExisting += 1;
        continue;
      }
      if (userEdited) { leftExisting += 1; continue; }
      if (kind === "multi" && Array.isArray(current) && current.length) { leftExisting += 1; continue; }
      if (kind === "single" && workdayCurrentMatchesRequest(field, current, requested.values[0])) {
        selected.push({ question: field.question, choices: Array.isArray(current) ? current : [current] });
        leftExisting += 1;
        continue;
      }
      if (!forcePreference && current && (!Array.isArray(current) || current.length)) { leftExisting += 1; continue; }

      const exactLabels = [];
      const choicesToCommit = [];
      let failureChoices = [];
      let failed = false;
      for (const requestedLabel of requested.values) {
        const result = await workdayOptionFor(control, requestedLabel, field);
        const exactOptions = result.options.filter((option) => workdayOptionMatches(field, option, requestedLabel));
        if (!result.option || exactOptions.length !== 1) {
          failed = true;
          failureChoices = result.options.map((option) => option.label);
          break;
        }
        exactLabels.push(result.option.label);
        choicesToCommit.push(requestedLabel);
      }
      const committed = [];
      if (!failed) {
        for (let index = 0; index < choicesToCommit.length; index += 1) {
          const result = await workdayOptionFor(control, choicesToCommit[index], field);
          const exactOptions = result.options.filter((option) => workdayOptionMatches(field, option, choicesToCommit[index]));
          if (!result.option || exactOptions.length !== 1) {
            failed = true;
            failureChoices = result.options.map((option) => option.label);
            break;
          }
          chooseWorkdayOption(result.option.element);
          committed.push(result.option.label);
          await wait(60);
        }
      }
      if (failed && committed.length) {
        for (const label of committed.reverse()) {
          const result = await workdayOptionFor(control, label, field);
          const exactOptions = result.options.filter((option) => workdayOptionMatches(field, option, label));
          if (result.option && exactOptions.length === 1) {
            chooseWorkdayOption(result.option.element);
            await wait(60);
          }
        }
      }
      if (control instanceof HTMLInputElement && control.value) dispatchValue(control, "");
      if (failed) {
        if (!failureChoices.length) failureChoices = visibleWorkdayOptions(control).map((option) => option.label);
        await dismissWorkdayPickers();
        unknown.push(workdayCustomDescriptor(field, control, failureChoices, payload));
      } else {
        filled.push(field.question);
        selected.push({ question: field.question, choices: exactLabels });
      }
    }
    return { filled, selected, reviewedChoices, unknownQuestions: unknown, leftExisting };
  }

  async function fillWorkdayQuestionnaire(payload, options = {}) {
    const filled = [];
    const selected = [];
    const reviewedChoices = [];
    const unknownQuestions = [];
    let leftExisting = 0;
    for (const descriptor of collectWorkdayQuestionnaireDescriptors()) {
      const { element, question } = descriptor;
      if (isHardBlocked(question) || isWorkdayNonReusableAgreement(question)) continue;
      const key = workdayFieldKey(element);
      const current = workdayQuestionnaireCurrentLabel(element);
      if (current || options.userEditedKeys?.has(key)) {
        leftExisting += 1;
        continue;
      }
      const resolution = workdayQuestionnaireAnswer(question, payload.answers ?? [], payload.profile ?? {}, payload);
      if (!resolution.applicable || !resolution.answer) {
        descriptor.choices = [];
        unknownQuestions.push(unknownRecord(descriptor, {
          ambiguous: resolution.ambiguous === true,
          savedAnswerMismatch: Boolean(resolution.answer && !resolution.applicable),
        }, payload));
        continue;
      }
      const answer = resolution.answer;
      const answerType = answer.answerType ?? "text";
      const requested = answerType === "boolean"
        ? [answer.booleanValue ? "yes" : "no"]
        : answerType === "single-choice" ? answer.selectedChoices : [answer.answer];
      await activateWorkdayListbox(element);
      const optionsInList = visibleWorkdayOptions(element);
      const matches = requested.map((value) => {
        if (answerType === "boolean") {
          const expected = booleanChoice(value);
          return optionsInList.filter((option) => booleanChoice(option.label) === expected);
        }
        return optionsInList.filter((option) => exactVisibleChoice(option, value));
      });
      const exact = matches.length === 1 && matches[0].length === 1 ? matches[0][0] : null;
      if (!exact) {
        descriptor.choices = optionsInList;
        unknownQuestions.push(unknownRecord(descriptor, { savedAnswerMismatch: true }, payload));
        await dismissWorkdayPickers();
        continue;
      }
      chooseWorkdayOption(exact.element);
      await wait(60);
      filled.push(question);
      selected.push({ question, choices: [exact.label] });
      if (isReviewRequired(question)) reviewedChoices.push(question);
    }
    return { filled, selected, reviewedChoices, unknownQuestions, leftExisting };
  }

  async function fillWorkdayStep(payload, options = {}) {
    const report = inspectWorkdayPage(payload);
    if (!report.supported) return { ...report, filled: [], selected: [], reviewedChoices: [], attachments: [], unknownQuestions: report.unknownQuestions ?? [] };
    const repeatable = await fillWorkdayRepeatableSections(payload, options);
    const descriptors = collectDescriptors().filter((descriptor) => !isWorkdaySearchControl(descriptor.element));
    const native = fillDescriptors(report, descriptors, payload, {
      workday: true,
      forceDefaults: options.forceDefaults === true,
      userEditedKeys: options.userEditedKeys ?? new Set(),
    });
    const custom = await fillWorkdayCustomFields(payload, options);
    const questionnaire = await fillWorkdayQuestionnaire(payload, options);
    const unknown = [...native.unknownQuestions];
    for (const item of [...custom.unknownQuestions, ...questionnaire.unknownQuestions]) {
      if (!unknown.some((existing) => normalizedKey(existing.question) === normalizedKey(item.question))) unknown.push(item);
    }
    return {
      ...native,
      filled: [...repeatable.filled, ...native.filled, ...custom.filled, ...questionnaire.filled],
      selected: [...repeatable.selected, ...native.selected, ...custom.selected, ...questionnaire.selected],
      reviewedChoices: [...native.reviewedChoices, ...custom.reviewedChoices, ...questionnaire.reviewedChoices],
      leftExisting: repeatable.leftExisting + native.leftExisting + custom.leftExisting + questionnaire.leftExisting,
      unknownQuestions: unknown,
      sectionWarnings: [...workdaySectionWarnings(payload.profile ?? {}, options.userEditedKeys), ...repeatable.sectionWarnings]
        .filter((item, index, list) => list.findIndex((candidate) => candidate.message === item.message) === index),
      workdayStep: report.workdayStep,
      sessionActive: Boolean(options.session),
      sessionExpiresAt: options.session?.expiresAt ?? null,
    };
  }

  async function startWorkdaySession(payload = {}) {
    const report = inspectWorkdayPage(payload);
    if (!report.supported || !workdayApplicationPath()) return { ...report, sessionActive: false };
    const existing = currentWorkdaySession();
    const pathPrefix = workdayPathPrefix(location.pathname);
    if (!pathPrefix) return { ...report, supported: false, manualReason: "This Workday application route is not recognized. Use manual review.", sessionActive: false };
    existing?.stop?.(false);
    const session = {
      startedAt: Number(payload.workdayStartedAt) || Date.now(),
      expiresAt: Number(payload.workdayExpiresAt) || ((Number(payload.workdayStartedAt) || Date.now()) + WORKDAY_SESSION_WINDOW_MS),
      origin: location.origin,
      pathPrefix,
      payload,
      userEditedKeys: new Set(payload.workdayUserEditedKeys ?? []),
      running: false,
      fillTimer: 0,
      expiryTimer: 0,
      pendingMutation: false,
      mutationPasses: 0,
      lastFilledSignature: "",
      observer: null,
      stopped: false,
      activePicker: null,
    };
    const markTrustedEdit = (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const structureKey = workdayRepeatableStructureKey(target);
      if (structureKey && (event.type === "click" || (event.type === "keydown" && ["Enter", " "].includes(event.key)))) {
        recordWorkdayUserEdit(session, structureKey);
        return;
      }
      const selectedListbox = target.closest('[role="listbox"]') ?? target.closest('[role="option"]')?.closest('[role="listbox"]');
      const pickerKeyForListbox = (listbox) => {
        const associated = WORKDAY_CUSTOM_FIELDS.find((field) => {
          const control = document.querySelector(field.selector);
          if (!control) return false;
          const ids = `${control.getAttribute("aria-controls") ?? ""} ${control.getAttribute("aria-owns") ?? ""}`.split(/\s+/).filter(Boolean);
          return listbox?.id && ids.includes(listbox.id);
        });
        const active = session.activePicker && Date.now() - session.activePicker.openedAt < 30_000
          ? session.activePicker.key : "";
        return associated?.selector.slice(1) || active;
      };
      if (event.type === "click" && target.closest('[role="option"]')) {
        const key = pickerKeyForListbox(selectedListbox);
        if (key) recordWorkdayUserEdit(session, key);
        session.activePicker = null;
        return;
      }
      if (event.type === "keydown" && ["Enter", " "].includes(event.key) && selectedListbox) {
        const key = pickerKeyForListbox(selectedListbox);
        if (key) recordWorkdayUserEdit(session, key);
        session.activePicker = null;
        return;
      }
      const control = target.closest("input, select, textarea, button");
      if (!control) {
        if (event.type === "click") session.activePicker = null;
        return;
      }
      const spec = WORKDAY_CUSTOM_FIELDS.find((field) => control.matches(field.selector));
      const questionnaire = isWorkdayQuestionnaireControl(control);
      const repeatable = workdayRepeatableContext(control);
      const pickerKey = spec ? spec.selector.slice(1) : questionnaire ? workdayFieldKey(control) : repeatable?.key ?? "";
      if (event.type === "keydown" && pickerKey) {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          session.activePicker = { key: pickerKey, openedAt: Date.now() };
        } else if (["Enter", " "].includes(event.key) && session.activePicker?.key === pickerKey
          && hasActiveWorkdayOption(control)) {
          recordWorkdayUserEdit(session, pickerKey);
          session.activePicker = null;
        }
        return;
      }
      if (pickerKey && event.type === "click") {
        session.activePicker = { key: pickerKey, openedAt: Date.now() };
        return;
      }
      if (event.type === "click") session.activePicker = null;
      if (event.type !== "click") {
        const key = workdayFieldKey(control) || control.id || control.getAttribute("name") || "";
        const stableKey = spec ? spec.selector.slice(1) : repeatable?.key || key;
        if (stableKey) recordWorkdayUserEdit(session, stableKey);
      }
    };
    const scheduleFill = (force = false) => {
      if (session.stopped) return;
      if (session.running) {
        session.pendingMutation = true;
        return;
      }
      if (!force && workdayDomSignature() === session.lastFilledSignature) return;
      clearTimeout(session.fillTimer);
      session.fillTimer = setTimeout(async () => {
        if (!workdaySessionRouteAllowed(session)) return stopWorkdaySession(true);
        if (Date.now() >= session.expiresAt) return stopWorkdaySession(true);
        const before = workdayDomSignature();
        session.running = true;
        session.pendingMutation = false;
        let signatureChanged = false;
        try {
          const next = await fillWorkdayStep(session.payload, { session, userEditedKeys: session.userEditedKeys });
          session.lastFilledSignature = workdayDomSignature();
          signatureChanged = before !== session.lastFilledSignature;
          if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "scout.workdayStepResult", report: next }).catch(() => undefined);
        } finally {
          session.running = false;
          const changedDuringFill = session.pendingMutation;
          session.pendingMutation = false;
          if (changedDuringFill && signatureChanged && session.mutationPasses < 4) {
            session.mutationPasses += 1;
            scheduleFill(true);
          } else {
            session.mutationPasses = 0;
          }
        }
      }, 90);
    };
    const scheduleOnNavigation = () => scheduleFill();
    session.stop = (notify = false) => stopWorkdaySession(notify);
    session.scheduleFill = scheduleFill;
    session.markTrustedEdit = markTrustedEdit;
    session.scheduleOnNavigation = scheduleOnNavigation;
    session.stopRouteObservation = observeApplicationRoutes((nextUrl) => {
      scheduleOnNavigation();
      if (!workdaySessionRouteAllowed(session)) stopWorkdaySession(true);
      else session.applicationUrl = nextUrl;
    });
    session.observer = new MutationObserver(() => scheduleFill());
    globalThis.__scoutWorkdaySession = session;
    document.addEventListener("input", markTrustedEdit, true);
    document.addEventListener("change", markTrustedEdit, true);
    document.addEventListener("click", markTrustedEdit, true);
    document.addEventListener("keydown", markTrustedEdit, true);
    window.addEventListener("popstate", scheduleOnNavigation);
    window.addEventListener("hashchange", scheduleOnNavigation);
    session.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    session.lastFilledSignature = workdayDomSignature();
    session.running = true;
    let result;
    try {
      result = await fillWorkdayStep(payload, { session, forceDefaults: true, userEditedKeys: session.userEditedKeys });
      session.lastFilledSignature = workdayDomSignature();
    } finally {
      session.running = false;
      if (session.pendingMutation) {
        session.pendingMutation = false;
        session.mutationPasses = 0;
        scheduleFill(true);
      }
    }
    session.expiryTimer = setTimeout(() => stopWorkdaySession(true), Math.max(1, session.expiresAt - Date.now()));
    return { ...result, sessionActive: true, sessionExpiresAt: session.expiresAt };
  }

  function updateWorkdaySessionPayload(payload = {}) {
    const session = currentWorkdaySession();
    if (!session || !payload.profile || !Array.isArray(payload.answers)) return { updated: false };
    const previousExperienceCount = session.payload.profile?.experienceCount;
    const nextExperienceCount = payload.profile.experienceCount;
    if (previousExperienceCount !== nextExperienceCount && session.userEditedKeys.delete("repeatable:experience:structure")
      && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "scout.workdayUserEditCleared", fieldKey: "repeatable:experience:structure" }).catch(() => undefined);
    }
    session.payload = {
      ...session.payload,
      ...payload,
      workdayUserEditedKeys: [...session.userEditedKeys],
    };
    session.scheduleFill?.(true);
    return { updated: true, expiresAt: session.expiresAt };
  }

  function recordWorkdayUserEdit(session, key) {
    if (!key || session.userEditedKeys.has(key)) return;
    session.userEditedKeys.add(key);
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "scout.workdayUserEdit", fieldKey: key }).catch(() => undefined);
    }
  }

  function stopWorkdaySession(notify = false, expectedStartedAt = null) {
    const session = globalThis.__scoutWorkdaySession;
    if (!session) return { stopped: true };
    if (expectedStartedAt != null && session.startedAt !== expectedStartedAt) return { stopped: false, staleSession: true };
    session.stopped = true;
    session.observer?.disconnect();
    clearTimeout(session.fillTimer);
    clearTimeout(session.expiryTimer);
    document.removeEventListener("input", session.markTrustedEdit, true);
    document.removeEventListener("change", session.markTrustedEdit, true);
    document.removeEventListener("click", session.markTrustedEdit, true);
    document.removeEventListener("keydown", session.markTrustedEdit, true);
    window.removeEventListener("popstate", session.scheduleOnNavigation);
    window.removeEventListener("hashchange", session.scheduleOnNavigation);
    session.stopRouteObservation?.();
    globalThis.__scoutWorkdaySession = null;
    if (notify && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "scout.workdaySessionEnded", startedAt: session.startedAt }).catch(() => undefined);
    }
    return { stopped: true };
  }

  function watchForConfirmation(context) {
    if (!context || typeof context.applicationUrl !== "string" || !context.preparedAt || !document.body) return { armed: false };
    const page = new URL(location.href);
    const prepared = new URL(context.applicationUrl);
    if (page.origin !== prepared.origin || Date.now() - context.preparedAt > 30 * 60 * 1_000) return { armed: false };
    const existing = globalThis.__scoutSubmissionWatcher;
    if (existing?.context?.preparedAt === context.preparedAt && existing?.context?.applicationUrl === context.applicationUrl) {
      return { armed: true, alreadyWatching: true };
    }
    existing?.stop?.();
    const currentText = () => (document.body?.innerText ?? "").slice(0, 30_000);
    const detected = () => CONFIRMATION_PATTERNS.some((pattern) => pattern.test(currentText()));
    const routeChanged = page.pathname !== prepared.pathname || page.hash !== prepared.hash;
    const isConfirmationRoute = (url) => /(?:thank|success|confirm|complete|received)/i.test(url.pathname);
    const routeAllowed = () => {
      let current;
      try { current = new URL(location.href); } catch { return false; }
      if (current.origin !== prepared.origin) return false;
      const sameApplicationRoute = current.pathname === prepared.pathname && current.hash === prepared.hash;
      return sameApplicationRoute || (trustedSubmissionSent && isConfirmationRoute(current));
    };
    if (routeChanged && !isConfirmationRoute(page)) return { armed: false, differentApplication: true };
    if (routeChanged && !context.trustedSubmitted) return { armed: false, differentApplication: true };
    if (detected() && !context.trustedSubmitted && !context.allowInitialConfirmation) return { armed: false, alreadyVisible: true };
    let stopped = false;
    let trustedSubmissionSent = Boolean(context.trustedSubmitted);
    let trustedSubmissionPersisted = Boolean(context.trustedSubmitted);
    let confirmationSent = false;
    let trustedSubmitIntentAt = 0;
    let trustedSubmitUrl = context.trustedSubmitUrl || context.applicationUrl;
    let confirmationBaseline = normalize(context.confirmationBaseline ?? "").toLocaleLowerCase("en-US");
    const stopRouteObservation = observeApplicationRoutes(() => {
      if (!routeAllowed()) stop();
    });
    const applicationForm = Array.from(document.forms)
      .map((form) => {
        const controls = Array.from(form.querySelectorAll("input, select, textarea")).filter(isVisible);
        const score = controls.length
          + controls.filter((control) => control instanceof HTMLInputElement && control.type === "file").length * 4
          + controls.filter((control) => control instanceof HTMLInputElement && control.type === "email").length * 2;
        return { form, score };
      })
      .filter((entry) => entry.score >= 3)
      .sort((a, b) => b.score - a.score)[0]?.form ?? null;
    const sendTrustedSubmission = (event) => {
      if (event.isTrusted !== true || event.target !== applicationForm || Date.now() - trustedSubmitIntentAt > 5_000
        || !routeAllowed() || trustedSubmissionSent || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
      trustedSubmissionSent = true;
      trustedSubmitUrl = location.href;
      confirmationBaseline = confirmationMatch(currentText());
      chrome.runtime.sendMessage({
        type: "scout.trustedSubmission",
        application: {
          applicationUrl: context.applicationUrl,
          company: context.company,
          title: context.title,
          preparedAt: context.preparedAt,
          confirmationBaseline,
        },
      }).then((response) => {
        if (response?.trusted) {
          trustedSubmissionPersisted = true;
          sendConfirmation();
        }
      }).catch(() => undefined);
    };
    const recordSubmitIntent = (event) => {
      if (event.isTrusted !== true || !applicationForm || !(event.target instanceof Element) || !applicationForm.contains(event.target)) return;
      if (event.type === "click") {
        const button = event.target.closest('button[type="submit"], input[type="submit"], button:not([type])');
        if (button && button.form === applicationForm) trustedSubmitIntentAt = Date.now();
        return;
      }
      if (event.type === "keydown" && event.key === "Enter"
        && !(event.target instanceof HTMLTextAreaElement)
        && !(event.target instanceof HTMLInputElement && ["button", "submit", "checkbox", "radio"].includes(event.target.type))) {
        trustedSubmitIntentAt = Date.now();
      }
    };
    const observer = new MutationObserver(() => {
      if (stopped || Date.now() - context.preparedAt > 30 * 60 * 1_000) return stop();
      if (!routeAllowed()) return stop();
      if (!detected()) return;
      sendConfirmation();
    });
    const stop = () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("submit", sendTrustedSubmission, true);
      document.removeEventListener("click", recordSubmitIntent, true);
      document.removeEventListener("keydown", recordSubmitIntent, true);
      window.removeEventListener("hashchange", cancelOnRouteChange);
      window.removeEventListener("popstate", cancelOnRouteChange);
      stopRouteObservation();
      clearTimeout(expiry);
      globalThis.__scoutSubmissionWatcher = null;
    };
    const sendConfirmation = () => {
      if (stopped || confirmationSent || !trustedSubmissionSent || !trustedSubmissionPersisted || !detected() || !routeAllowed()) return;
      const current = new URL(location.href);
      const submitted = new URL(trustedSubmitUrl);
      const newConfirmation = Boolean(confirmationMatch(currentText()) && confirmationMatch(currentText()) !== confirmationBaseline);
      const newConfirmationRoute = current.origin === submitted.origin && isConfirmationRoute(current)
        && (current.pathname !== submitted.pathname || current.hash !== submitted.hash);
      if (!newConfirmation && !newConfirmationRoute) return;
      confirmationSent = true;
      stop();
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
      chrome.runtime.sendMessage({
        type: "scout.applicationConfirmation",
        application: {
          applicationUrl: context.applicationUrl,
          company: context.company,
          title: context.title,
          location: context.location,
          preparedAt: context.preparedAt,
          confirmationText: currentText().slice(0, 4_000),
          confirmationMatch: confirmationMatch(currentText()),
          trustedSubmitted: true,
        },
      }).catch(() => undefined);
    };
    const expiry = setTimeout(stop, Math.max(1, 30 * 60 * 1_000 - (Date.now() - context.preparedAt)));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    document.addEventListener("submit", sendTrustedSubmission, true);
    document.addEventListener("click", recordSubmitIntent, true);
    document.addEventListener("keydown", recordSubmitIntent, true);
    const cancelOnRouteChange = () => {
      if (!routeAllowed()) stop();
    };
    window.addEventListener("hashchange", cancelOnRouteChange);
    window.addEventListener("popstate", cancelOnRouteChange);
    globalThis.__scoutSubmissionWatcher = { stop, context };
    if (detected() && trustedSubmissionSent && trustedSubmissionPersisted && (context.allowInitialConfirmation || routeChanged)) sendConfirmation();
    return { armed: true };
  }

  globalThis.ScoutFormHelper = Object.freeze({
    scan: inspectPage,
    fill: fillPage,
    fillWorkdayStep,
    startWorkdaySession,
    updateWorkdaySessionPayload,
    stopWorkdaySession,
    inspectWrittenDraft: writtenDraftField,
    applyWrittenDraft,
    readWorkdayJobDescription,
    normalizeQuestion: normalizedKey,
    watchForConfirmation,
  });
})();
