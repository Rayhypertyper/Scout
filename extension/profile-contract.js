/* global structuredClone */
(() => {
  if (globalThis.ScoutProfileContract) return;

  const EMPTY_PROFILE = Object.freeze({
    firstName: "",
    lastName: "",
    preferredFirstName: "",
    preferredLastName: "",
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
    experienceCount: null,
    education: [],
    experience: [],
    languages: [],
    websites: Object.freeze(Array.from({ length: 4 }, () => Object.freeze({ url: "" }))),
    referralSources: [],
  });

  function safeText(value) {
    return typeof value === "string" ? value.slice(0, 5_000) : "";
  }

  function monthInputValue(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    const numeric = raw.match(/^(\d{4})-(0?[1-9]|1[0-2])$/);
    if (numeric) return `${numeric[1]}-${numeric[2].padStart(2, "0")}`;
    const slash = raw.match(/^(0?[1-9]|1[0-2])\/(\d{4})$/);
    if (slash) return `${slash[2]}-${slash[1].padStart(2, "0")}`;
    const named = raw.match(/^([a-z]{3,9})\s+(\d{4})$/i);
    if (named) {
      const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
        .findIndex((name) => name.startsWith(named[1].toLowerCase()));
      if (month >= 0) return `${named[2]}-${String(month + 1).padStart(2, "0")}`;
    }
    return "";
  }

  function monthInputField(value) {
    const original = typeof value === "string" ? value : "";
    const normalized = monthInputValue(original);
    return { type: normalized || !original ? "month" : "text", value: normalized || original };
  }

  function shouldStageRemoteStarter(profileSaved) {
    return profileSaved === false;
  }

  function normalizeProfile(value) {
    const profile = { ...structuredClone(EMPTY_PROFILE), ...(value && typeof value === "object" ? value : {}) };
    for (const key of Object.keys(EMPTY_PROFILE)) {
      if (["education", "experience", "languages", "websites", "referralSources"].includes(key)) continue;
      if (["previousWorker", "hasPreferredName"].includes(key)) {
        profile[key] = profile[key] === true || profile[key] === false ? profile[key] : null;
        continue;
      }
      if (key === "experienceCount") {
        profile[key] = Number.isInteger(profile[key]) && profile[key] >= 0 && profile[key] <= 20 ? profile[key] : null;
        continue;
      }
      if (key === "requiresSponsorship") {
        profile[key] = profile[key] === true ? "true" : profile[key] === false ? "false" : profile[key] == null ? "" : String(profile[key]);
      } else {
        profile[key] = typeof profile[key] === "string" ? profile[key] : "";
      }
    }
    profile.education = Array.isArray(profile.education) ? profile.education.filter((item) => item && typeof item === "object").map((item) => ({
      school: safeText(item.school), degree: safeText(item.degree), fieldOfStudy: safeText(item.fieldOfStudy),
      startDate: safeText(item.startDate), endDate: safeText(item.endDate), gradeAverage: safeText(item.gradeAverage),
    })).slice(0, 12) : [];
    profile.experience = Array.isArray(profile.experience) ? profile.experience.filter((item) => item && typeof item === "object").map((item) => ({
      company: safeText(item.company), title: safeText(item.title), location: safeText(item.location),
      startDate: safeText(item.startDate), endDate: safeText(item.endDate), description: safeText(item.description),
      currentlyWorkHere: item.currentlyWorkHere === true || item.currentlyWorkHere === false ? item.currentlyWorkHere : null,
    })).slice(0, 20) : [];
    profile.languages = Array.isArray(profile.languages) ? profile.languages.filter((item) => item && typeof item === "object").map((item) => ({
      language: safeText(item.language),
      fluent: item.fluent === true || item.fluent === false ? item.fluent : null,
      comprehension: safeText(item.comprehension),
      overall: safeText(item.overall),
      reading: safeText(item.reading),
      speaking: safeText(item.speaking),
      writing: safeText(item.writing),
    })).slice(0, 20) : [];
    profile.websites = Array.isArray(profile.websites)
      ? profile.websites.filter((item) => item && typeof item === "object").map((item) => ({ url: safeText(item.url).slice(0, 2_048) }))
      : structuredClone(EMPTY_PROFILE.websites);
    profile.referralSources = Array.isArray(profile.referralSources)
      ? [...new Set(profile.referralSources.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
        .slice(0, 30).map((item) => item.slice(0, 500))
      : [];
    return profile;
  }

  globalThis.ScoutProfileContract = Object.freeze({ EMPTY_PROFILE, normalizeProfile, monthInputField, shouldStageRemoteStarter });
})();
