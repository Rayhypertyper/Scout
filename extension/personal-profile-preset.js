(() => {
  if (globalThis.ScoutPersonalProfilePreset) return;

  const defaults = Object.freeze({
    country: "Canada",
    phoneType: "Mobile",
    phoneCountryCode: "Canada (+1)",
    experienceCount: 1,
    previousWorker: false,
    hasPreferredName: true,
    experience: Object.freeze([{ currentlyWorkHere: false }]),
    referralSources: Object.freeze(["LinkedIn"]),
    languages: Object.freeze(["Chinese", "English"].map((language) => Object.freeze({
      language,
      fluent: true,
      comprehension: "5 - Fluent",
      overall: "5 - Fluent",
      reading: "5 - Fluent",
      speaking: "5 - Fluent",
      writing: "5 - Fluent",
    }))),
    websites: Object.freeze(Array.from({ length: 4 }, () => Object.freeze({ url: "" }))),
  });

  function cloneDefault(value) {
    if (!Array.isArray(value)) return value;
    return value.map((item) => item && typeof item === "object" ? { ...item } : item);
  }

  function merge(profileValue) {
    const profile = { ...(profileValue && typeof profileValue === "object" ? profileValue : {}) };
    for (const [key, value] of Object.entries(defaults)) {
      const current = profile[key];
      const blank = Array.isArray(current)
        ? current.length === 0
        : current == null || (typeof current !== "boolean" && !String(current).trim());
      if (blank) profile[key] = cloneDefault(value);
    }
    if (Array.isArray(profile.experience)) {
      profile.experience = profile.experience.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.currentlyWorkHere === "boolean") return row;
        return { ...row, currentlyWorkHere: false };
      });
    }
    return profile;
  }

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  }

  function equal(left, right) {
    return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  }

  function shouldStageRemote(remoteApplied, hasLocalProfileDraft) {
    return remoteApplied !== true && hasLocalProfileDraft !== true;
  }

  globalThis.ScoutPersonalProfilePreset = Object.freeze({ defaults, merge, equal, shouldStageRemote });
})();
