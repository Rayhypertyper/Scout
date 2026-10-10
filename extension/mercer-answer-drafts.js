(() => {
  if (globalThis.ScoutMercerAnswerDrafts) return;

  const ORIGIN = "https://merceruniversity.wd1.myworkdayjobs.com";
  const SCOPE = Object.freeze({ origin: ORIGIN, locale: "en-US" });
  const YES_NO = Object.freeze(["Yes", "No"]);
  const RACE_OPTIONS = Object.freeze([
    "American Indian or Alaska Native (United States of America)",
    "Asian (United States of America)",
    "Black or African American (United States of America)",
    "Native Hawaiian or Other Pacific Islander (United States of America)",
    "White (United States of America)",
  ]);
  const PRESETS = Object.freeze([
    {
      draftId: "mercer-direct-employment",
      group: "Application Questions",
      question: "Have you ever been employed at Mercer University or Mercer Engineering Research Center (MERC)?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-desired-salary",
      group: "Application Questions",
      question: "What is your desired starting salary?",
      answer: "Negotiable",
      answerType: "text",
    },
    {
      draftId: "mercer-salary-negotiable",
      group: "Application Questions",
      question: "Is the desired salary negotiable?",
      answer: "",
      answerType: "boolean",
      booleanValue: true,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-conviction-history",
      group: "Application Questions",
      question: "Have you, since the age of 18, ever been convicted of a misdemeanor or felony, excluding speeding tickets? (NOTE: It is of vital importance that this question be answered truthfully. A conviction will not necessarily bar you from employment. Each conviction will be judged on its own merits with respect to time, circumstances and seriousness.)",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-us-citizenship",
      group: "Application Questions",
      question: "Are you a U.S. citizen?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-clearance-current",
      group: "Application Questions",
      question: "Do you currently hold a security clearance?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-clearance-ever",
      group: "Application Questions",
      question: "Have you ever held a security clearance?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-clearance-denied",
      group: "Application Questions",
      question: "Have you ever been denied a security clearance?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-non-compete",
      group: "Application Questions",
      question: "Have you signed a non-compete agreement in the last 5 years?",
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-hispanic-or-latino",
      group: "Voluntary Disclosures",
      question: "Are you Hispanic or Latino?",
      answer: "",
      answerType: "single-choice",
      selectedChoices: ["No"],
      allowedChoices: YES_NO,
    },
    {
      draftId: "mercer-race-category",
      group: "Voluntary Disclosures",
      question: "Race Category: (Please select all that apply.)",
      answer: "",
      answerType: "multi-choice",
      selectedChoices: ["Asian (United States of America)"],
      allowedChoices: RACE_OPTIONS,
    },
    {
      draftId: "mercer-veteran-status",
      group: "Voluntary Disclosures",
      question: "Please select one of the options below:",
      answer: "",
      answerType: "single-choice",
      selectedChoices: ["I AM NOT A VETERAN"],
      allowedChoices: [
        "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE",
        "I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN",
        "I AM NOT A VETERAN",
        "I DO NOT WISH TO SELF-IDENTIFY",
      ],
    },
    {
      draftId: "mercer-gender",
      group: "Voluntary Disclosures",
      question: "Gender",
      answer: "",
      answerType: "single-choice",
      selectedChoices: ["Male"],
      allowedChoices: ["Female", "Male", "Not declared"],
    },
  ]);

  function create() {
    return PRESETS.map((preset) => ({
      ...preset,
      scope: { ...SCOPE },
      allowedChoices: preset.allowedChoices ? [...preset.allowedChoices] : undefined,
      selectedChoices: preset.selectedChoices ? [...preset.selectedChoices] : undefined,
    }));
  }

  function normalize(value) {
    if (!value || typeof value !== "object" || typeof value.draftId !== "string"
      || typeof value.group !== "string" || typeof value.question !== "string") return null;
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

  globalThis.ScoutMercerAnswerDrafts = Object.freeze({ create, normalize, origin: ORIGIN });
})();
