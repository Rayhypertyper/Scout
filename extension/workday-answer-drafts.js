(() => {
  if (globalThis.ScoutWorkdayAnswerDrafts) return;

  const SEMTECH_ORIGIN = "https://semtech.wd1.myworkdayjobs.com";
  const YES_NO = Object.freeze(["Yes", "No"]);
  const PRESETS = Object.freeze([
    {
      draftId: "semtech-canada-eligibility",
      group: "Canadian application answers",
      question: "Are you legally eligible to work in the country in which you are applying?",
      answer: "",
      answerType: "boolean",
      booleanValue: true,
      allowedChoices: YES_NO,
      scope: { country: "Canada" },
    },
    {
      draftId: "semtech-canada-sponsorship",
      group: "Canadian application answers",
      question: "Will you require visa sponsorship at any time?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
      scope: { country: "Canada" },
    },
    {
      draftId: "semtech-canada-relocation",
      group: "Canadian application answers",
      question: "Are you local or willing to relocate?",
      answer: "",
      answerType: "boolean",
      booleanValue: true,
      allowedChoices: YES_NO,
      scope: { country: "Canada" },
    },
    {
      draftId: "semtech-canada-salary-range",
      group: "Canadian application answers",
      question: "What are your base salary expectations (CAD)?",
      answer: "30,000 CAD  - 42,000 CAD",
      answerType: "text",
      scope: { country: "Canada" },
    },
    {
      draftId: "semtech-canada-related-employee",
      group: "Canadian application answers",
      question: "Are you related to any current employee of Semtech or any of its subsidiaries?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
      scope: { origin: SEMTECH_ORIGIN, country: "Canada" },
    },
    {
      draftId: "semtech-canada-education-requirements",
      group: "Canadian application answers",
      question: "Do you meet the minimum education requirements for this position?",
      answer: "",
      answerType: "boolean",
      booleanValue: true,
      allowedChoices: YES_NO,
      scope: { country: "Canada" },
    },
    {
      draftId: "semtech-canada-industry-experience",
      group: "Canadian application answers",
      question: "Do you have experience working in the semiconductors/electronics/manufacturing/or similar industry?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
      scope: { country: "Canada" },
    },
    {
      draftId: "semtech-us-eligibility",
      group: "United States application answers",
      question: "Are you legally eligible to work in the country in which you are applying?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
      scope: { country: "United States" },
    },
    {
      draftId: "semtech-us-sponsorship",
      group: "United States application answers",
      question: "Will you require visa sponsorship at any time?",
      answer: "",
      answerType: "boolean",
      booleanValue: true,
      allowedChoices: YES_NO,
      scope: { country: "United States" },
    },
  ]);

  function create() {
    return PRESETS.map((preset) => ({
      ...preset,
      allowedChoices: preset.allowedChoices ? [...preset.allowedChoices] : undefined,
      scope: { ...preset.scope },
    }));
  }

  function inferJobCountry(value, locationEvidence = []) {
    return globalThis.ScoutAnswerContract?.inferWorkdayJobCountry?.(value, locationEvidence) ?? "";
  }

  function normalize(value) {
    if (!value || typeof value !== "object" || typeof value.draftId !== "string"
      || !value.draftId.startsWith("semtech-") || typeof value.group !== "string"
      || typeof value.question !== "string") return null;
    const answer = globalThis.ScoutAnswerContract?.normalizeAnswer(value);
    if (!answer) return null;
    if (value.allowedChoices != null && !Array.isArray(value.allowedChoices)) return null;
    const allowed = (value.allowedChoices ?? []).filter((choice) => typeof choice === "string" && choice.trim());
    const allowedKeys = allowed.map((choice) => globalThis.ScoutAnswerContract.normalizeQuestion(choice));
    if (new Set(allowedKeys).size !== allowedKeys.length) return null;
    if (["single-choice", "multi-choice"].includes(answer.answerType)
      && !answer.selectedChoices.every((choice) => allowedKeys.includes(globalThis.ScoutAnswerContract.normalizeQuestion(choice)))) return null;
    if (answer.answerType === "boolean"
      && !["yes", "no"].every((choice) => allowedKeys.includes(globalThis.ScoutAnswerContract.normalizeQuestion(choice)))) return null;
    return {
      ...answer,
      draftId: value.draftId.slice(0, 100),
      group: value.group.slice(0, 100),
      allowedChoices: allowed,
    };
  }

  globalThis.ScoutWorkdayAnswerDrafts = Object.freeze({ create, normalize, inferJobCountry, origin: SEMTECH_ORIGIN });
})();
