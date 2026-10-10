/* global URL */
(() => {
  if (globalThis.ScoutAnswerContract) return;

  const normalizeText = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  const normalizeQuestion = (value) => normalizeText(value).toLocaleLowerCase("en-US");

  function workdayJobKey(value) {
    try {
      const url = new URL(String(value ?? ""));
      if (!/(?:^|\.)myworkdayjobs\.com$/i.test(url.hostname)) return "";
      const segments = url.pathname.split("/").filter(Boolean);
      const jobIndex = segments.findIndex((segment) => normalizeQuestion(segment) === "job");
      if (jobIndex < 0 || !segments[jobIndex + 1] || !segments[jobIndex + 2]) return "";
      const normalizeSegment = (segment) => {
        try { return normalizeQuestion(decodeURIComponent(segment)); } catch { return normalizeQuestion(segment); }
      };
      const country = normalizeSegment(segments[jobIndex + 1]);
      const role = normalizeSegment(segments[jobIndex + 2]);
      return country && role ? `${url.origin}|${country}|${role}` : "";
    } catch {
      return "";
    }
  }

  function inferWorkdayJobCountry(value, locationEvidence = []) {
    let url;
    try { url = new URL(String(value ?? "")); } catch { return ""; }
    if (url.protocol !== "https:" || !/(?:^|\.)myworkdayjobs\.com$/i.test(url.hostname)) return "";

    const candidates = [];
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
    const jobIndex = segments.findIndex((segment) => normalizeQuestion(segment) === "job");
    const slug = jobIndex >= 0 ? (segments[jobIndex + 1] ?? "") : "";
    const slugCode = slug.match(/^([A-Z]{3})---/u)?.[1] ?? "";
    if (slugCode && !["CAN", "USA"].includes(slugCode)) return "";
    if (/^(?:CAN|Canada)(?:[-_]|$)/i.test(slug)) candidates.push("Canada");
    if (/^(?:USA|United[-_ ]States)(?:[-_]|$)/i.test(slug)) candidates.push("United States");

    const evidenceItems = (Array.isArray(locationEvidence) ? locationEvidence : [locationEvidence])
      .filter((item) => typeof item === "string").map((item) => normalizeText(item).slice(0, 500)).filter(Boolean);
    const text = evidenceItems.join("\n");
    if (text) {
      const otherCountryNames = /\b(?:united kingdom|u\.?\s*k\.?|great britain|england|scotland|wales|australia|india|france|germany|japan|china|singapore|ireland|netherlands|spain|italy|brazil|mexico|new zealand|sweden|norway|denmark|finland|switzerland|belgium|austria|poland|czech republic|portugal|south korea|korea|taiwan|hong kong|united arab emirates|uae|saudi arabia|south africa|israel|argentina|colombia|chile|malaysia|indonesia|philippines|thailand|vietnam|pakistan|bangladesh|nigeria|egypt|turkey|türkiye)\b/i;
      const otherCountryCodes = /(?:^|[\s,(/])(?:GBR|AUS|IND|FRA|DEU|JPN|CHN|SGP|IRL|NLD|ESP|ITA|BRA|MEX|NZL|SWE|NOR|DNK|FIN|CHE|BEL|AUT|POL|CZE|PRT|KOR|TWN|HKG|ARE|SAU|ZAF|ISR|ARG|COL|CHL|MYS|IDN|PHL|THA|VNM|PAK|BGD|NGA|EGY|TUR)(?=$|[\s,)./])/u;
      const hasCanada = (value) => /\bcanada\b/i.test(value) || /(?:^|[\s,(/])CAN(?=$|[\s,)./])/u.test(value);
      const hasUnitedStates = (value) => /\b(?:united states(?: of america)?)\b/i.test(value)
        || /(?:^|[\s,(/])(?:USA|US)(?=$|[\s,)./])/u.test(value);
      const hasOtherCountry = (value) => otherCountryNames.test(value) || otherCountryCodes.test(value);
      if (evidenceItems.some((item) => hasOtherCountry(item))) return "";
      if (evidenceItems.length > 1 && evidenceItems.some((item) => !hasCanada(item) && !hasUnitedStates(item))) return "";
      if (evidenceItems.some(hasCanada)) candidates.push("Canada");
      if (evidenceItems.some(hasUnitedStates)) candidates.push("United States");
    }

    const distinct = [...new Set(candidates)];
    return distinct.length === 1 ? distinct[0] : "";
  }

  function canonicalApplicationUrl(value) {
    try {
      const url = new URL(String(value ?? ""));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
      url.hash = "";
      const tracking = new Set([
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gh_src", "source", "ref", "referrer",
        "tracking", "trk", "visit", "fbclid", "gclid", "embed", "mc_cid", "mc_eid", "oly_enc_id", "oly_anon_id",
        "vero_id", "yclid", "msclkid", "_ga", "_gl",
      ]);
      const identity = new Set([
        "jobid", "job_id", "gh_jid", "reqid", "requisitionid", "requisition_id", "positionid", "position_id",
        "postingid", "posting_id", "externaljobid", "external_job_id",
      ]);
      const sensitive = new Set([
        "token", "access_token", "auth", "authorization", "key", "api_key", "apikey", "mcp_token", "session",
        "session_id", "secret", "signature", "credential",
      ]);
      for (const key of [...url.searchParams.keys()]) {
        const normalized = key.toLocaleLowerCase("en-US");
        if ((tracking.has(normalized) && !identity.has(normalized)) || sensitive.has(normalized)) url.searchParams.delete(key);
      }
      url.hostname = url.hostname.toLocaleLowerCase("en-US");
      if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
      url.searchParams.sort();
      return url.toString();
    } catch {
      return "";
    }
  }

  function workdayPublicListingUrl(applicationUrl, expectedJobKey = workdayJobKey(applicationUrl)) {
    try {
      const application = new URL(String(applicationUrl ?? ""));
      if (application.protocol !== "https:" || !/(?:^|\.)myworkdayjobs\.com$/i.test(application.hostname)) return "";
      const match = application.pathname.match(/^(.*\/job\/[^/]+\/[^/]+)\/apply(?:\/.*)?$/i);
      if (!match?.[1]) return "";
      const listing = new URL(application.origin);
      listing.pathname = match[1];
      return workdayJobKey(listing.href) === expectedJobKey ? listing.href : "";
    } catch {
      return "";
    }
  }

  function applicationCountryForJob(state, expectedJobKey) {
    if (!state || !expectedJobKey || workdayJobKey(state.applicationCountryApplicationUrl) !== expectedJobKey) return "";
    if (state.applicationCountryReviewed === true) {
      return ["Canada", "United States"].includes(state.applicationCountry) ? state.applicationCountry : "";
    }
    if (state.applicationCountryReviewed === false) {
      return inferWorkdayJobCountry(state.applicationCountryApplicationUrl, state.applicationCountryEvidence);
    }
    // Older cached helper states did not distinguish a manual choice from inference.
    return ["Canada", "United States"].includes(state.applicationCountry) ? state.applicationCountry : "";
  }

  function sameWrittenDraftInputs(before, current) {
    if (!before || !current) return false;
    const keys = ["accountId", "startedAt", "applicationUrl", "jobKey", "applicationCountry", "autoDraftWrittenAnswers", "jobDescription"];
    if (keys.some((key) => before[key] !== current[key])) return false;
    return JSON.stringify(before.professionalProfile ?? {}) === JSON.stringify(current.professionalProfile ?? {})
      && JSON.stringify(before.answers ?? []) === JSON.stringify(current.answers ?? []);
  }

  function isWrittenNarrativePrompt(value) {
    const question = normalizeText(value);
    if (question.length < 20 || question.length > 1_000) return false;
    const blocked = /password|passcode|captcha|recaptcha|hcaptcha|security code|one.?time code|social security|\bssn\b|bank|credit card|payment|credential|salary|compensation|pay expectations?|citizen(?:ship)?|nationality|country of (?:birth|origin)|place of birth|birth country|\bcountry\b.*\bborn\b|permanent resident|work authorization|authorized to work|eligible to work|entitled to work|sponsorship|visa status|immigration status|employment eligibility|consent|privacy policy|terms of service|certify|attest|acknowledge|agree to|reference|background check|criminal|security clearance|race|ethnicity|gender|pronoun|veteran|disabilit|medical|pregnan|religion|sexual orientation/i;
    if (blocked.test(question)) return false;
    const narrativeTopic = /\b(?:relevant|professional|work|technical)?\s*(?:experience|skills?|project|achievement|accomplishment|background|technology|technologies|tools|systems|approach|interest|motivation|contribution|strengths?)\b/i.test(question);
    const explicitNarrativeInstruction = /\b(?:please\s+(?:(?:take a moment to|briefly)\s+)*(?:describe|tell us|explain|highlight|share|outline|summari[sz]e|discuss)|(?:describe|tell us|explain|highlight|share|outline|summari[sz]e|discuss)\b)/i.test(question);
    const openNarrativePrompt = /\b(?:what (?:is|are|was|were|do|did|have|has|can|would)|why (?:do you|are you|did you)|how (?:do|did|have|would|can) you)\b/i.test(question);
    if (explicitNarrativeInstruction && narrativeTopic) return true;
    return openNarrativePrompt && narrativeTopic;
  }

  const countryAliases = [
      ["canada", /\bcanada\b/],
      ["united kingdom", /\b(?:united kingdom|u\.?\s*k\.?|great britain|england|scotland|wales)(?=$|[^a-z])/],
      ["australia", /\baustralia\b/],
      ["india", /\bindia\b/],
  ];

  function countriesMentioned(value) {
    const original = normalizeText(value);
    const text = normalizeQuestion(original);
    const matches = [...new Set(countryAliases.filter(([, pattern]) => pattern.test(text)).map(([country]) => country))];
    if (/\b(?:united states(?: of america)?|u\.\s*s\.?|usa)\b/i.test(original)
      || /(?:^|[^\p{L}\p{N}])US(?:$|[^\p{L}\p{N}])/u.test(original)) matches.push("united states");
    return [...new Set(matches)];
  }

  function inferCountry(value) {
    const matches = countriesMentioned(value);
    return matches.length === 1 ? matches[0] : "";
  }

  function answerScopeContext(question, { origin = "", locale = "", applicationCountry = "" } = {}) {
    const text = normalizeQuestion(question);
    const mentionsCountry = countriesMentioned(question).length > 0;
    const promptCountry = inferCountry(question);
    const savedJobCountry = inferCountry(applicationCountry);
    const ambiguousJobLocation = /\b(?:remote|worldwide|globally|global locations|anywhere|all countries|multiple countries|north america)\b/i.test(text);
    const country = ambiguousJobLocation ? ""
      : promptCountry || (!mentionsCountry && ["canada", "united states"].includes(savedJobCountry) ? savedJobCountry : "");
    return {
      ...(normalizedOrigin(origin) ? { origin: normalizedOrigin(origin) } : {}),
      ...(country ? { country } : {}),
      ...(normalizeText(locale) ? { locale: normalizeText(locale) } : {}),
    };
  }

  function normalizedOrigin(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
      return url.origin;
    } catch {
      return "";
    }
  }

  function normalizeScope(value) {
    if (value == null) return { valid: true, scope: {} };
    if (typeof value !== "object" || Array.isArray(value)) return { valid: false, scope: {} };
    const scope = {};
    for (const key of ["origin", "country", "locale"]) {
      if (value[key] == null || value[key] === "") continue;
      if (typeof value[key] !== "string") return { valid: false, scope: {} };
      const entry = normalizeText(value[key]);
      if (!entry) continue;
      if (key === "origin") {
        const origin = normalizedOrigin(entry);
        if (!origin || entry.length > 512) return { valid: false, scope: {} };
        scope.origin = origin;
      } else if ((key === "country" && entry.length > 100) || (key === "locale" && entry.length > 32)) {
        return { valid: false, scope: {} };
      } else {
        scope[key] = entry;
      }
    }
    return { valid: true, scope };
  }

  function isDistinctChoices(values) {
    if (!Array.isArray(values) || values.length > 30) return false;
    const seen = new Set();
    for (const value of values) {
      if (typeof value !== "string" || value.trim().length < 1 || value.length > 500) return false;
      const key = normalizeQuestion(value);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }

  function isValidAnswer(value) {
    if (!value || typeof value !== "object" || typeof value.question !== "string"
      || !value.question.trim() || value.question.length > 1_000) return false;
    const scope = normalizeScope(value.scope);
    if (!scope.valid) return false;
    const answerType = value.answerType ?? "text";
    if (answerType === "text") {
      return typeof value.answer === "string" && value.answer.trim().length > 0 && value.answer.length <= 2_000;
    }
    if (typeof value.answer !== "string" || value.answer !== "") return false;
    if (answerType === "single-choice") return isDistinctChoices(value.selectedChoices) && value.selectedChoices.length === 1;
    if (answerType === "multi-choice") return isDistinctChoices(value.selectedChoices);
    if (answerType === "boolean") return typeof value.booleanValue === "boolean" && value.selectedChoices == null;
    return false;
  }

  function normalizeAnswer(value) {
    if (!isValidAnswer(value)) return null;
    const type = value.answerType ?? "text";
    const normalized = {
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      question: normalizeText(value.question),
      answer: value.answer,
      answerType: type,
    };
    if (type === "single-choice" || type === "multi-choice") normalized.selectedChoices = value.selectedChoices.map(normalizeText);
    if (type === "boolean") normalized.booleanValue = value.booleanValue;
    const scope = normalizeScope(value.scope).scope;
    if (Object.keys(scope).length) normalized.scope = scope;
    return normalized;
  }

  function scopeIdentity(value) {
    const normalized = normalizeScope(value);
    if (!normalized.valid) return "!invalid";
    const scope = normalized.scope;
    const key = {};
    if (scope.origin) key.origin = scope.origin;
    if (scope.country) key.country = normalizeQuestion(scope.country);
    if (scope.locale) key.locale = normalizeQuestion(scope.locale);
    return JSON.stringify(key);
  }

  function answerIdentityKey(value) {
    return `${normalizeQuestion(value?.question)}\u0000${scopeIdentity(value?.scope)}`;
  }

  function countryKey(value) {
    const normalized = normalizeQuestion(value);
    const aliases = [
      ["united states", /^(?:united states(?: of america)?|u\.?s\.?a?\.?|usa)$/],
      ["canada", /^canada$/],
      ["united kingdom", /^(?:united kingdom|u\.?k\.?|great britain|england|scotland|wales)$/],
      ["australia", /^australia$/],
      ["india", /^india$/],
    ];
    return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] ?? normalized;
  }

  function isDirectEmployerHistoryPrompt(value) {
    const question = normalizeQuestion(value).replace(/\s*\*$/, "").trim();
    if (!question || question.length > 180) return false;
    if (/\b(?:student|enrolled|current(?:ly)?|country|citizen|eligible|eligibility|authorization|authorized|visa|sponsorship|clearance|convicted|conviction|non.?compete|salary|describe|explain|how long|when did|since the age|within the last|in the last|for \d+|\d+ years?)\b/.test(question)) return false;
    return /^(?:have you (?:ever|previously) been employed (?:at|by|with)|have you (?:ever|previously) worked for|did you (?:ever|previously) work for)\s+[^?]+\??$/.test(question);
  }

  function isResidenceCountryLegalPrompt(value) {
    return /\b(?:citizen(?:ship)?|nationality|country of (?:birth|origin)|place of birth|birth country|country (?:were you )?born in|national origin)\b/.test(normalizeQuestion(value));
  }

  function isResidenceCountryPrompt(value) {
    const question = normalizeQuestion(value).replace(/\s*\*$/, "").trim();
    return /^(?:(?:(?:home|residential|residence|mailing) )?address )?country(?:\s*(?:\/|or)\s*region)?$/.test(question)
      || /^(?:country of (?:your )?(?:residence|residency)|(?:residence|residency) country|country where (?:you )?(?:live|reside)|what country (?:do you live|do you reside) in)$/.test(question);
  }

  function isObservedCompoundEmployerHistoryPrompt(value) {
    const question = normalizeQuestion(value);
    if (!question || question.length > 1_000) return false;
    return /^previous worker confirmation text: were you a previous employee or student at [^?]+ or are you a current [^?]+ employee\? if so, please enter your information below\. for current [^.?!]+ employees only: you must apply via the internal career portal\. please log in to your workday account to submit your application\.$/.test(question);
  }

  function parseWorkdayDate(value) {
    const text = normalizeText(value);
    const monthMatch = text.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (monthMatch && Number(monthMatch[1]) >= 1) {
      return { year: monthMatch[1], month: String(Number(monthMatch[2])) };
    }
    const yearMatch = text.match(/^(\d{4})$/);
    if (yearMatch && Number(yearMatch[1]) >= 1) return { year: yearMatch[1], month: "" };
    return null;
  }

  function validProfileWebsite(value) {
    const text = normalizeText(value);
    if (!text || text.length > 2_048) return false;
    try {
      const url = new URL(text);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  function profileRowIsMeaningful(kind, row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const hasText = (keys) => keys.some((key) => typeof row[key] === "string" && normalizeText(row[key]));
    if (kind === "experience") return hasText(["company", "title", "location", "startDate", "endDate", "description"]);
    if (kind === "education") return hasText(["school", "degree", "fieldOfStudy", "gradeAverage", "startDate", "endDate"]);
    if (kind === "languages") return hasText(["language"]);
    if (kind === "websites") return typeof row.url === "string" && validProfileWebsite(row.url);
    return false;
  }

  function profileRowsForWorkday(profile, kind) {
    const sourceRows = Array.isArray(profile?.[kind]) ? profile[kind] : [];
    if (kind === "websites") {
      const rows = [];
      let invalidCount = 0;
      for (const source of sourceRows) {
        const row = source && typeof source === "object" && !Array.isArray(source) ? source : null;
        const url = normalizeText(row?.url);
        if (url && !validProfileWebsite(url)) invalidCount += 1;
        else if (url) rows.push(row);
      }
      return { rows, targetCount: rows.length, invalidCount };
    }
    const slots = sourceRows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? row : null);
    let targetCount = 0;
    let invalidCount = 0;
    for (let index = 0; index < slots.length; index += 1) {
      const row = slots[index];
      if (profileRowIsMeaningful(kind, row)) targetCount = index + 1;
    }
    if (kind === "experience" && Number.isInteger(profile?.experienceCount)
      && profile.experienceCount >= 0 && profile.experienceCount <= 20) {
      targetCount = profile.experienceCount;
      slots.length = targetCount;
      while (slots.length < targetCount) slots.push(null);
    }
    return { rows: slots, targetCount, invalidCount };
  }

  function profileRowIdentity(kind, row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return "";
    const field = kind === "experience" ? "company"
      : kind === "education" ? "school"
        : kind === "languages" ? "language"
          : kind === "websites" ? "url" : "";
    return field && typeof row[field] === "string" ? normalizeText(row[field]) : "";
  }

  function planWorkdayRows(profile, kind, existingIdentities = []) {
    const configured = profileRowsForWorkday(profile, kind);
    const existing = Array.isArray(existingIdentities) ? existingIdentities : [];
    const identityConflicts = [];
    const fillableRowIndices = [];
    for (let index = 0; index < Math.min(existing.length, configured.rows.length); index += 1) {
      const row = configured.rows[index];
      const meaningful = profileRowIsMeaningful(kind, row);
      const hasWorkdayChoice = kind === "experience" && (row?.currentlyWorkHere === true || row?.currentlyWorkHere === false);
      if (!meaningful && !hasWorkdayChoice) continue;
      const expected = normalizeQuestion(profileRowIdentity(kind, row));
      const current = normalizeQuestion(existing[index]);
      if (current && (!expected || expected !== current)) identityConflicts.push(index);
      else if (meaningful) fillableRowIndices.push(index);
    }
    return {
      ...configured,
      rowsToAdd: Math.max(0, configured.targetCount - existing.length),
      excessRows: Math.max(0, existing.length - configured.targetCount),
      identityConflicts,
      fillableRowIndices,
    };
  }

  function shouldApplyWorkdayCurrentFlag(row, identityConflict) {
    if (!row || typeof row.currentlyWorkHere !== "boolean") return false;
    if (!identityConflict) return true;
    // The user explicitly asked for an “off” default on otherwise-unidentified
    // parsed rows. A company-bound on/off value must never cross to another row.
    return row.currentlyWorkHere === false && !normalizeText(row.company);
  }

  function scopeMatches(scopeValue, contextValue) {
    const normalized = normalizeScope(scopeValue);
    if (!normalized.valid) return false;
    const scope = normalized.scope;
    const context = contextValue && typeof contextValue === "object" ? contextValue : {};
    if (scope.origin && scope.origin !== normalizedOrigin(context.origin)) return false;
    if (scope.country && (!context.country || countryKey(scope.country) !== countryKey(context.country))) return false;
    if (scope.locale && (!context.locale || normalizeQuestion(scope.locale) !== normalizeQuestion(context.locale))) return false;
    return true;
  }

  function scopeSpecificity(scopeValue) {
    const normalized = normalizeScope(scopeValue);
    if (!normalized.valid) return -1;
    const scope = normalized.scope;
    if (scope.origin && scope.country && scope.locale) return 70;
    if (scope.origin && scope.country) return 60;
    if (scope.origin && scope.locale) return 55;
    if (scope.origin) return 50;
    if (scope.country && scope.locale) return 30;
    if (scope.country) return 20;
    if (scope.locale) return 10;
    return 0;
  }

  function answerPayloadKey(value) {
    const type = value.answerType ?? "text";
    return JSON.stringify({ type, answer: value.answer, selectedChoices: value.selectedChoices ?? null, booleanValue: value.booleanValue ?? null });
  }

  function resolveAnswer(question, answers, context) {
    const exact = (answers ?? []).filter((answer) => isValidAnswer(answer)
      && normalizeQuestion(answer.question) === normalizeQuestion(question)
      && scopeMatches(answer.scope, context));
    if (!exact.length) return { answer: null, ambiguous: false };
    const topRank = Math.max(...exact.map((answer) => scopeSpecificity(answer.scope)));
    const top = exact.filter((answer) => scopeSpecificity(answer.scope) === topRank);
    const payloads = new Set(top.map(answerPayloadKey));
    if (payloads.size > 1) return { answer: null, ambiguous: true };
    return { answer: top[0], ambiguous: false };
  }

  globalThis.ScoutAnswerContract = Object.freeze({
    normalizeText,
    normalizeQuestion,
    workdayJobKey,
    inferWorkdayJobCountry,
    canonicalApplicationUrl,
    workdayPublicListingUrl,
    applicationCountryForJob,
    sameWrittenDraftInputs,
    isWrittenNarrativePrompt,
    inferCountry,
    answerScopeContext,
    isDirectEmployerHistoryPrompt,
    isResidenceCountryLegalPrompt,
    isResidenceCountryPrompt,
    normalizeScope,
    normalizedOrigin,
    isValidAnswer,
    normalizeAnswer,
    scopeIdentity,
    answerIdentityKey,
    scopeMatches,
    scopeSpecificity,
    isObservedCompoundEmployerHistoryPrompt,
    resolveAnswer,
    parseWorkdayDate,
    validProfileWebsite,
    profileRowIsMeaningful,
    profileRowsForWorkday,
    profileRowIdentity,
    planWorkdayRows,
    shouldApplyWorkdayCurrentFlag,
  });
})();
