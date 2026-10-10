import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

interface ObservedControl {
  prompt: string;
  selector?: string;
  name?: string;
  checked?: boolean;
  state?: string;
  temporaryInspection?: {
    checkedToRevealConditionalFields: boolean;
    fields: Array<{ prompt: string; selector: string; name: string; wrapperAutomationId: string; role: string; ariaRequired: boolean; required: boolean }>;
    noTextEntered: boolean;
    restoredToOriginalUncheckedState: boolean;
    fieldsHiddenAfterRestore: boolean;
  };
  choices?: string[];
  control?: { type: string; checked: boolean; visibleRequiredMarker: boolean };
  popup?: { options?: string[] };
  interaction?: {
    searchTerm: string;
    emptyOpenOptionRowsBySelector: { selector: string; count: number };
    searchedOptionRowsBySelector: { selector: string; count: number };
    afterClearing: { selectedItemCount: number };
    popupStructuresNotInventoried: string[];
    laterMenuObservation: {
      optionNode: { tag: string; role: string; dataAutomationId: string };
      visibleLabels: string[];
      socialMediaChildLabelHierarchy: string;
      selectionDisplayStructure: {
        presentationRow: { tag: string; role: string; dataAutomationId: string };
        selectedItem: { tag: string; role: string; dataAutomationId: string };
        labelElement: string;
        removeControlAutomationId: string;
        selectedLabelRetained: boolean;
      };
    };
  };
  interpretationBoundary?: string;
}

interface WorkdayObservation {
  fixtureType: string;
  tenant: string;
  host: string;
  locale: string;
  step: { heading: string; index: number; count: number };
  sanitization: string;
  controls: ObservedControl[];
}

interface WorkdayExperienceObservation {
  fixtureType: string;
  tenant: string;
  step: { heading: string; index: number; count: number; headingHierarchy: Array<{ level: number; text: string }> };
  sanitization: string;
  sections: Array<{
    heading: string;
    visibleControls?: Array<{ role: string; label: string }>;
    controls?: Array<Record<string, unknown>>;
    rowsVisible?: boolean;
    wrapper?: { dataAutomationId: string; ariaLabelledBy?: string[]; accessibleLabelText?: string };
    applicationFieldWrapper?: { dataAutomationIdPrefix: string; suffixObserved: boolean };
    fileConstraint?: string;
    uploadResult?: {
      status: string;
      visibleFileName: string;
      itemAutomationId: string;
      fileNameAutomationId: string;
      successAutomationId: string;
      liveRegionRole: string;
      deleteControl: { dataAutomationId: string; type: string };
    };
  }>;
  visibleRequirements: string[];
  unseenOrUnverified: string[];
}

interface WorkdayApplicationQuestionsObservation {
  fixtureType: string;
  tenant: string;
  step: { heading: string; index: number; count: number; routeNote: string };
  state: { requiredPrompts: number; allAnswersBlank: boolean; dropdownsOpenedAndDismissed: number; choicesSelected: number };
  validationAtBlankSnapshot?: { visibleHeading: string; requiredErrorCount: number };
  subsequentUserAction?: { questionsCompletedByUser: boolean; answerAndDeclarationValuesRetained: boolean };
  sharedChoiceControl: {
    selector: string;
    type: string;
    ariaHasPopup: string;
    ariaLabel: string;
    required: boolean;
    popup: { selector: string; optionSelector: string; placeholder: { label: string; disabled: boolean } };
  };
  questions: Array<{
    number: number;
    prompt: string;
    control: string | Record<string, unknown>;
    options?: string[];
  }>;
  stepActions: {
    dropdownsOpened: number;
    dropdownOptionsRead: boolean;
    dropdownsDismissedWithoutSelection: boolean;
    applicationSubmitted: boolean;
  };
}

interface WorkdayDisclosuresObservation {
  fixtureType: string;
  tenant: string;
  step: { heading: string; index: number; count: number };
  controls: Array<{ prompt: string; selector?: string; options?: string[]; wrapperAutomationId?: string; selectedValueRetained?: boolean; selectedValuesRetained?: boolean }>;
  termsDescription: string;
  disabilityFieldPresent: boolean;
  userSelectionsRetained: boolean;
}

interface WorkdayReviewObservation {
  fixtureType: string;
  tenant: string;
  step: { heading: string; index: number; count: number };
  reviewWrapper: { dataAutomationId: string; interactiveDescendants: Record<string, number>; groups: string[] };
  pageActionsOutsideReviewWrapper: Array<{ label: string; tag: string; type: string | null; dataAutomationId?: string }>;
  syntheticUploadTestItem: { presentInResumeCvSummary: boolean; deleteControlPresentInReview: boolean; mustBeReplacedBeforeRealSubmission: boolean };
  stepActions: { submitActivated: boolean; applicationSubmitted: boolean };
}

interface SemtechGateObservation {
  fixtureType: string;
  tenant: string;
  host: string;
  locale: string;
  job: {
    headingLevel: number;
    title: string;
    locationLabel: string;
    country: string;
    requisition: string;
    countrySource: string;
  };
  application: {
    path: string;
    entryChoice: string;
    stageCountBeforeSignIn: number;
    stagesBeforeSignIn: string[];
    stageCountAfterSignIn: number;
    currentStepAfterSignIn: { headingLevel: number; heading: string; index: number; count: number };
    progressBarAfterSignIn: {
      containerSelector: string;
      activeItemAutomationId: string;
      activeItemText: string;
      activeItemAriaCurrent: string | null;
      activeItemAriaLabel: string | null;
      inactiveItemTextPattern: string;
    };
    accountGate: {
      initialHeading: { level: number; text: string };
      handoffMode: string;
      stageIndexBeforeSignIn: number;
      controlsCaptured: boolean;
    };
    resumeUpload: {
      wrapperAutomationId: string;
      ancestorChainFromInput: string[];
      visibleInstructionSummary: string;
      visibleDropPrompt: string;
      fileLimitMB: number;
      acceptedExtensions: string[];
      button: { selector: string; text: string; type: string; generatedIdObservedButNotRetained: boolean };
      input: {
        selector: string;
        multiple: boolean;
        accept: string | null;
        name: string | null;
        id: string | null;
        required: boolean;
        ariaRequired: boolean;
      };
      existingFileCount: number;
      existingUploadItemCount: number;
      selectButtonClickedAtInitialSnapshot: boolean;
      uploadResult: {
        nativeChooserUsed: boolean;
        syntheticFileName: string;
        sizeKB: number;
        statusText: string;
        successAutomationId: string;
        deleteButtonAutomationId: string;
        deleteButtonType: string;
        deleteActivated: boolean;
        extensionAttachmentTested: boolean;
      };
    };
    resumeWidgetObserved: boolean;
    fileUploaded: boolean;
    currentStepAfterContinue: { headingLevel: number; heading: string; index: number; count: number };
    progressBarAfterContinue: {
      containerSelector: string;
      activeItemAutomationId: string;
      activeItemText: string;
      activeItemAriaCurrent: string | null;
      activeItemAriaLabel: string | null;
      inactiveItemTextPattern: string;
    };
    myInformation: {
      step: { headingLevel: number; heading: string; index: number; count: number };
      source: { prompt: string; requiredMarkerObserved: boolean; selector: string; name: string; element: string; type: string; ariaHasPopup: string; wrapperAutomationId: string; options: string[]; selectionPresent: boolean; selectedValueRetained: boolean; absentAttributes: string[] };
      previousWorker: { prompt: string; requiredMarkerObserved: boolean; type: string; name: string; options: string[]; selectedValueRetained: boolean };
      country: { selector: string; element: string; selectedValueRetained: boolean; absentAttributes: string[] };
      phoneType: { selector: string; element: string; options: string[]; selectedValueRetained: boolean; absentAttributes: string[] };
      phoneCountryCode: { searchInputBlank: boolean; selectedItemListPresent: boolean; selectedValueRetained: boolean };
      provinceOrTerritory: { selector: string; prompt: string; required: boolean; listboxOptionCount: number; optionLabelsRetained: boolean; selectedValueRetained: boolean; absentAttributes: string[] };
      preferredName: { checkboxSelector: string; checkboxValueRetained: boolean; conditionalFieldsVisible: boolean; conditionalFields: Array<{ selector: string; name: string; label: string; required: boolean; blank: boolean }> };
      legalNameAndPhoneBlank: boolean;
      optionalAddressFieldsBlank: boolean;
      unreportedFieldSelectors: string;
      nextControl: { automationId: string; text: string; visible: boolean; activated: boolean };
      candidateResponseValuesRetained: boolean;
    };
    currentStepAfterMyInformation: { headingLevel: number; heading: string; index: number; count: number };
    myExperience: Record<string, unknown>;
    stepActions: {
      nativeResumeChooserUsed: boolean;
      continueActivatedToReachMyInformation: boolean;
      myInformationSaveAndContinueActivated: boolean;
      myInformationSaveAndContinueActivatedAfterSnapshot: boolean;
      myExperienceSaveAndContinueActivated: boolean;
      applicationSubmitted: boolean;
    };
    laterStepObservations: Array<{ heading: string; index: number; count: number; metadataFile: string }>;
    applicationSubmitted: boolean;
  };
  sanitization: string;
  boundary: string;
}

interface SavedAnswer {
  question: string;
  answer: string;
  answerType?: "text" | "single-choice" | "multi-choice" | "boolean";
  selectedChoices?: string[];
  booleanValue?: boolean;
  scope?: { origin?: string; country?: string; locale?: string };
}

interface AnswerContract {
  inferCountry(value: string): string;
  isValidAnswer(answer: SavedAnswer): boolean;
  resolveAnswer(question: string, answers: SavedAnswer[], context: { origin?: string; country?: string; locale?: string }): {
    answer: SavedAnswer | null;
    ambiguous: boolean;
  };
}

interface WorkdayPayload {
  profile: Record<string, unknown>;
  answers: SavedAnswer[];
  applicationCountry?: "Canada" | "United States" | "";
  documents?: {
    resume?: { name: string; type: string; size: number; base64: string } | null;
    coverLetter?: { name: string; type: string; size: number; base64: string } | null;
  };
}

interface WorkdayTestHelper {
  scan(payload: WorkdayPayload): {
    supported: boolean;
    ats: string;
    workdayStep: string;
    manualReason?: string;
    unknownQuestions: Array<{ question: string; kind: string; choices: Array<{ label: string }>; writtenDraftEligible?: boolean; scopeContext?: { origin?: string; country?: string; locale?: string } }>;
  };
  startWorkdaySession(payload: WorkdayPayload): Promise<{
    supported?: boolean;
    sessionActive: boolean;
    workdayStep: string;
    manualReason?: string;
    selected: Array<{ question: string; choices: string[] }>;
    reviewedChoices: string[];
    filled: string[];
    attachments: string[];
    sectionWarnings: Array<{ section: string; rowIndex?: number; message: string }>;
    unknownQuestions: Array<{ question: string; kind: string; choices: Array<{ label: string }>; writtenDraftEligible?: boolean; scopeContext?: { origin?: string; country?: string; locale?: string } }>;
  }>;
  stopWorkdaySession(): { stopped: boolean };
  inspectWrittenDraft(question: string, applicationUrl: string, previousDraft?: string): { eligible: boolean; reason?: string; maxLength?: number };
  applyWrittenDraft(request: { question: string; draft: string; applicationUrl: string; previousDraft?: string; userEditedKeys?: string[] }): { applied: boolean; reason?: string; message?: string };
}

const observationPath = resolve("tests/fixtures/browserHelperWorkday/mercer-my-information.json");
const syntheticFixturePath = resolve("tests/fixtures/browserHelperWorkday/synthetic-session.html");
const experienceObservationPath = resolve("tests/fixtures/browserHelperWorkday/mercer-my-experience.json");
const syntheticExperienceFixturePath = resolve("tests/fixtures/browserHelperWorkday/synthetic-experience-session.html");
const applicationQuestionsObservationPath = resolve("tests/fixtures/browserHelperWorkday/mercer-application-questions.json");
const syntheticApplicationQuestionsFixturePath = resolve("tests/fixtures/browserHelperWorkday/synthetic-application-questions-session.html");
const disclosuresObservationPath = resolve("tests/fixtures/browserHelperWorkday/mercer-voluntary-disclosures.json");
const reviewObservationPath = resolve("tests/fixtures/browserHelperWorkday/mercer-review.json");
const syntheticReviewFixturePath = resolve("tests/fixtures/browserHelperWorkday/synthetic-review-session.html");
const semtechGateObservationPath = resolve("tests/fixtures/browserHelperWorkday/semtech-account-gate.json");
const syntheticSemtechAutofillFixturePath = resolve("tests/fixtures/browserHelperWorkday/semtech-autofill-resume.html");
const syntheticSemtechMyInformationFixturePath = resolve("tests/fixtures/browserHelperWorkday/semtech-my-information.html");
const syntheticSemtechMyExperienceFixturePath = resolve("tests/fixtures/browserHelperWorkday/semtech-my-experience.html");
const semtechApplicationQuestionsObservationPath = resolve("tests/fixtures/browserHelperWorkday/semtech-application-questions.json");
const syntheticSemtechApplicationQuestionsFixturePath = resolve("tests/fixtures/browserHelperWorkday/semtech-application-questions.html");
const semtechVoluntaryDisclosuresObservationPath = resolve("tests/fixtures/browserHelperWorkday/semtech-voluntary-disclosures.json");
const syntheticSemtechVoluntaryDisclosuresFixturePath = resolve("tests/fixtures/browserHelperWorkday/semtech-voluntary-disclosures.html");
const semtechReviewObservationPath = resolve("tests/fixtures/browserHelperWorkday/semtech-review.json");
const uploadFixturePath = resolve("tests/fixtures/browserHelperWorkday/scout-upload-test.pdf");
const contractPath = resolve("extension/answer-contract.js");
const extensionRoot = resolve("extension");
const runBrowserE2E = process.env.RUN_BROWSER_E2E === "1";

function loadObservation(): WorkdayObservation {
  return JSON.parse(readFileSync(observationPath, "utf8")) as WorkdayObservation;
}

function loadAnswerContract(): AnswerContract {
  const context: { URL: typeof URL; ScoutAnswerContract?: AnswerContract } = { URL };
  runInNewContext(readFileSync(contractPath, "utf8"), context);
  if (!context.ScoutAnswerContract) throw new Error("ScoutAnswerContract did not initialize");
  return context.ScoutAnswerContract;
}

describe("Workday investigation evidence and typed-answer contract", () => {
  it("keeps the Mercer evidence scoped to the observed, sanitized My Information page", () => {
    const observation = loadObservation();
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Mercer University",
      host: "merceruniversity.wd1.myworkdayjobs.com",
      locale: "en-US",
      step: { heading: "My Information", index: 1, count: 5 },
    });
    expect(observation.sanitization).toContain("Candidate values");
    expect(observation.controls.find((control) => control.prompt === "Phone Device Type*")?.popup?.options).toEqual(["Landline", "Mobile"]);
    const previousWorker = observation.controls.find((control) => control.control?.type === "radio");
    expect(previousWorker?.choices).toEqual(["Yes", "No"]);
    expect(previousWorker?.control).toMatchObject({
      checked: false,
      visibleRequiredMarker: true,
    });
    expect(observation.controls.find((control) => control.prompt === "How Did You Hear About Us?*")?.interaction).toMatchObject({
      searchTerm: "Other",
      emptyOpenOptionRowsBySelector: { selector: "li[role=option]", count: 0 },
      searchedOptionRowsBySelector: { selector: "li[role=option]", count: 0 },
      afterClearing: { selectedItemCount: 0 },
    });
    expect(observation.controls.find((control) => control.prompt === "How Did You Hear About Us?*")?.interpretationBoundary)
      .toContain("does not establish that there are no choices");
    const source = observation.controls.find((control) => control.prompt === "How Did You Hear About Us?*")?.interaction?.laterMenuObservation;
    expect(source?.optionNode).toEqual({ tag: "div", role: "option", dataAutomationId: "menuItem" });
    expect(source?.visibleLabels).toEqual(["External Website", "Mercer University", "Other", "Referral", "Social Media"]);
    expect(source?.selectionDisplayStructure).toMatchObject({
      presentationRow: { tag: "li", role: "presentation", dataAutomationId: "menuItem" },
      selectedItem: { tag: "div", role: "option", dataAutomationId: "selectedItem" },
      removeControlAutomationId: "DELETE_charm",
      selectedLabelRetained: false,
    });
    expect(observation.controls.find((control) => control.prompt === "Country Phone Code*")?.state).toBe("selected-value-omitted");
    const preferredName = observation.controls.find((control) => control.prompt === "I have a preferred name");
    expect(preferredName?.temporaryInspection).toMatchObject({
      checkedToRevealConditionalFields: true,
      noTextEntered: true,
      restoredToOriginalUncheckedState: true,
      fieldsHiddenAfterRestore: true,
    });
    expect(preferredName?.temporaryInspection?.fields.map((field) => field.selector)).toEqual([
      "#name--preferredName--firstName",
      "#name--preferredName--lastName",
    ]);
  });

  it("records the relayed Mercer My Experience selectors without inventing reference controls", () => {
    const observation = JSON.parse(readFileSync(experienceObservationPath, "utf8")) as WorkdayExperienceObservation;
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Mercer University",
      step: { heading: "My Experience", index: 2, count: 5 },
    });
    expect(observation.step.headingHierarchy.map((heading) => heading.level)).toEqual([1, 2, 3]);
    const certifications = observation.sections.find((section) => section.heading === "Certifications");
    expect(certifications?.rowsVisible).toBe(false);
    expect(certifications?.visibleControls).toEqual([{ role: "button", label: "Add" }]);
    const uploads = observation.sections.find((section) => section.heading === "Resume/CV attachment");
    expect(uploads?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selector: "#resumeAttachments--attachments",
        dataAutomationId: "select-files",
        type: "button",
      }),
      expect.objectContaining({
        selector: "input[type=file][data-automation-id=file-upload-input-ref]",
        multiple: true,
        accept: null,
        required: false,
      }),
    ]));
    expect(uploads?.wrapper).toMatchObject({ dataAutomationId: "attachments-FileUpload" });
    expect(uploads?.wrapper).toMatchObject({ ariaLabelledBy: ["label86"], accessibleLabelText: "Upload a file (5MB max)*" });
    expect(uploads?.applicationFieldWrapper).toEqual({ dataAutomationIdPrefix: "formField-", suffixObserved: false });
    expect(uploads?.uploadResult).toMatchObject({
      status: "successfully uploaded",
      visibleFileName: "scout-upload-test.pdf",
      itemAutomationId: "file-upload-item",
      successAutomationId: "file-upload-successful",
      liveRegionRole: "alert",
      deleteControl: { dataAutomationId: "delete-file", type: "button" },
    });
    expect(observation.visibleRequirements).toContain("Three professional references, including names and contact information");
    expect(observation.unseenOrUnverified).toContain("Exact reference-field labels, selectors, widget types, and row relationships were not captured in the relayed observation.");
  });

  it("records the exact observed Application Questions prompts and custom-listbox semantics", () => {
    const observation = JSON.parse(readFileSync(applicationQuestionsObservationPath, "utf8")) as WorkdayApplicationQuestionsObservation;
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Mercer University",
      step: { heading: "Application Questions", index: 3, count: 5 },
      state: { requiredPrompts: 11, allAnswersBlank: true, dropdownsOpenedAndDismissed: 10, choicesSelected: 0 },
    });
    expect(observation.sharedChoiceControl).toMatchObject({
      selector: "button[id^=primaryQuestionnaire--]",
      type: "button",
      ariaHasPopup: "listbox",
      ariaLabel: " Select One Required",
      required: false,
      popup: {
        selector: "ul[role=listbox][aria-activedescendant]",
        optionSelector: "li[role=option]",
        placeholder: { label: "Select One", disabled: true },
      },
    });
    expect(observation.questions).toHaveLength(11);
    expect(observation.questions.filter((question) => question.control === "shared-choice-control")).toHaveLength(10);
    expect(observation.questions.find((question) => question.number === 3)?.prompt).toBe("What is your desired starting salary?");
    expect(observation.questions.find((question) => question.number === 11)?.options).toEqual([
      "Yes - I certify that I have read and agree with these statements.",
      "-",
    ]);
    expect(observation.stepActions).toEqual({
      dropdownsOpened: 10,
      dropdownOptionsRead: true,
      dropdownsDismissedWithoutSelection: true,
      applicationSubmitted: false,
    });
    expect(observation.validationAtBlankSnapshot).toEqual({ visibleHeading: "Errors Found", requiredErrorCount: 11 });
    expect(observation.subsequentUserAction).toEqual({ questionsCompletedByUser: true, answerAndDeclarationValuesRetained: false });
  });

  it("records Voluntary Disclosures structure without retaining selected answers", () => {
    const observation = JSON.parse(readFileSync(disclosuresObservationPath, "utf8")) as WorkdayDisclosuresObservation;
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Mercer University",
      step: { heading: "Voluntary Disclosures", index: 4, count: 5 },
      disabilityFieldPresent: false,
      userSelectionsRetained: false,
    });
    expect(observation.controls.find((control) => control.selector === "#personalInfoUS--veteranStatus")?.options).toContain("I DO NOT WISH TO SELF-IDENTIFY");
    expect(observation.controls.find((control) => control.selector === "#personalInfoUS--hispanicOrLatino")?.options).toEqual(["Select One", "Yes", "No"]);
    expect(observation.controls.find((control) => control.selector === "#personalInfoUS--gender")?.options).toEqual(["Select One", "Female", "Male", "Not declared"]);
    expect(observation.controls.find((control) => control.wrapperAutomationId === "formField-ethnicityMulti")?.selectedValuesRetained).toBe(false);
    expect(observation.controls.find((control) => control.selector === "#termsAndConditions--acceptTermsAndAgreements")).toMatchObject({
      prompt: "Certification*",
      selectedValueRetained: false,
      checkedValueRetained: false,
    });
    expect(observation.termsDescription).toContain("Participation is voluntary");
  });

  it("records Review as a read-only summary and keeps Submit outside the observed wrapper", () => {
    const observation = JSON.parse(readFileSync(reviewObservationPath, "utf8")) as WorkdayReviewObservation;
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Mercer University",
      step: { heading: "Review", index: 5, count: 5 },
      reviewWrapper: { dataAutomationId: "applyFlowReviewPage" },
      syntheticUploadTestItem: {
        presentInResumeCvSummary: true,
        deleteControlPresentInReview: false,
        mustBeReplacedBeforeRealSubmission: true,
      },
      stepActions: { submitActivated: false, applicationSubmitted: false },
    });
    expect(Object.values(observation.reviewWrapper.interactiveDescendants)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(observation.pageActionsOutsideReviewWrapper.find((action) => action.label === "Submit")).toMatchObject({
      tag: "button",
      type: null,
      dataAutomationId: "pageFooterNextButton",
    });
  });

  it("records Semtech Canadian job context and the observed single-file resume step separately from locale", () => {
    const observation = JSON.parse(readFileSync(semtechGateObservationPath, "utf8")) as SemtechGateObservation;
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Semtech",
      host: "semtech.wd1.myworkdayjobs.com",
      locale: "en-US",
      job: {
        headingLevel: 2,
        title: "Software Developer – Web/Cloud Application, Co-op",
        locationLabel: "CAN - Richmond, BC",
        country: "Canada",
        requisition: "REQ3644",
      },
      application: {
        entryChoice: "Autofill with Resume",
        stageCountBeforeSignIn: 7,
        stageCountAfterSignIn: 6,
        currentStepAfterSignIn: {
          headingLevel: 3,
          heading: "Autofill with Resume",
          index: 1,
          count: 6,
        },
        progressBarAfterSignIn: {
          containerSelector: "ol[data-automation-id=progressBar]",
          activeItemAutomationId: "progressBarActiveStep",
          activeItemText: "current step 1 of 6",
          activeItemAriaCurrent: null,
          activeItemAriaLabel: null,
          inactiveItemTextPattern: "stepNof6; step number only, no label",
        },
        accountGate: {
          initialHeading: { level: 3, text: "Create Account" },
          handoffMode: "Sign In",
          stageIndexBeforeSignIn: 1,
          controlsCaptured: false,
        },
        resumeUpload: {
          wrapperAutomationId: "resumeUpload",
          visibleDropPrompt: "Drop file here or Select file",
          fileLimitMB: 5,
          acceptedExtensions: [".doc", ".docx", ".html", ".pdf", ".txt"],
          button: {
            selector: "button[data-automation-id=select-files]",
            text: "Select file",
            type: "button",
            generatedIdObservedButNotRetained: true,
          },
          input: {
            selector: "input[type=file][data-automation-id=file-upload-input-ref]",
            multiple: false,
            accept: null,
            name: null,
            id: null,
            required: false,
            ariaRequired: false,
          },
          existingFileCount: 0,
          existingUploadItemCount: 0,
          selectButtonClickedAtInitialSnapshot: false,
        },
        resumeWidgetObserved: true,
        fileUploaded: true,
        applicationSubmitted: false,
      },
    });
    expect(observation.job.countrySource).toContain("not applicant address or locale");
    expect(observation.application.stagesBeforeSignIn).toEqual([
      "Create Account/Sign In",
      "Autofill with Resume",
      "My Information",
      "My Experience",
      "Application Questions",
      "Voluntary Disclosures",
      "Review",
    ]);
    expect(observation.application.path).toBe("/en-US/semtechcareers/job/CAN---Richmond%2C-BC/Software-Developer---Web-Cloud-Application--Co-op_REQ3644/apply/autofillWithResume");
    expect(observation.application.resumeUpload.ancestorChainFromInput).toEqual([
      "anonymous div",
      "div[data-automation-id=resumeUpload]",
      "anonymous div",
      "anonymous div",
      "formField-* wrapper",
    ]);
    expect(observation.application.resumeUpload.visibleInstructionSummary).toContain("relevant application information");
    expect(observation.application.resumeUpload.button.generatedIdObservedButNotRetained).toBe(true);
    expect(observation.application.resumeUpload.uploadResult).toMatchObject({
      nativeChooserUsed: true,
      syntheticFileName: "scout-upload-test.pdf",
      sizeKB: 2.25,
      statusText: "Successfully Uploaded!",
      successAutomationId: "file-upload-successful",
      deleteButtonAutomationId: "delete-file",
      deleteButtonType: "button",
      deleteActivated: false,
      extensionAttachmentTested: false,
    });
    expect(observation.boundary).toContain("All six Semtech application steps");
    expect(observation.boundary).toContain("native MV3 execution remain unverified");
    expect(observation.application.laterStepObservations).toEqual([
      { heading: "Application Questions", index: 4, count: 6, metadataFile: "semtech-application-questions.json" },
      { heading: "Voluntary Disclosures", index: 5, count: 6, metadataFile: "semtech-voluntary-disclosures.json" },
      { heading: "Review", index: 6, count: 6, metadataFile: "semtech-review.json" },
    ]);
  });

  it("records Semtech My Information controls and public choices without retaining answers", () => {
    const observation = JSON.parse(readFileSync(semtechGateObservationPath, "utf8")) as SemtechGateObservation;
    expect(observation.application.currentStepAfterContinue).toEqual({
      headingLevel: 3,
      heading: "My Information",
      index: 2,
      count: 6,
    });
    expect(observation.application.progressBarAfterContinue).toMatchObject({
      containerSelector: "ol[data-automation-id=progressBar]",
      activeItemAutomationId: "progressBarActiveStep",
      activeItemText: "current step 2 of 6",
      activeItemAriaCurrent: null,
      activeItemAriaLabel: null,
    });
    expect(observation.application.myInformation).toMatchObject({
      step: { heading: "My Information", index: 2, count: 6 },
      source: {
        prompt: "How Did You Hear About Us?",
        requiredMarkerObserved: true,
        selector: "#source--source",
        name: "source",
        element: "button",
        type: "button",
        ariaHasPopup: "listbox",
        wrapperAutomationId: "formField-source",
        options: ["Select One", "Agency", "Corporate Website", "Indeed", "LinkedIn", "Recruiter", "Semtech Employee Referral"],
        selectedValueRetained: false,
        absentAttributes: ["aria-controls", "aria-owns", "aria-expanded"],
      },
      previousWorker: {
        prompt: "Have you previously been employed by Semtech as a Full-time, Part-time, Contractor or Temporary worker in any of our global locations?",
        type: "radio",
        name: "candidateIsPreviousWorker",
        options: ["Yes", "No"],
        selectedValueRetained: false,
      },
      country: { selector: "#country--country", element: "button", selectedValueRetained: false, absentAttributes: ["aria-controls", "aria-owns", "aria-expanded"] },
      phoneType: {
        selector: "#phoneNumber--phoneType",
        element: "button",
        options: ["Select One", "Landline", "Mobile"],
        selectedValueRetained: false,
      },
      phoneCountryCode: { searchInputBlank: true, selectedItemListPresent: true, selectedValueRetained: false },
      provinceOrTerritory: {
        selector: "#address--countryRegion",
        prompt: "Province or Territory",
        required: false,
        listboxOptionCount: 13,
        optionLabelsRetained: false,
        selectedValueRetained: false,
      },
      preferredName: {
        checkboxSelector: "#name--preferredCheck",
        checkboxValueRetained: false,
        conditionalFieldsVisible: true,
        conditionalFields: [
          { selector: "#name--preferredName--firstName", name: "preferredName--firstName", label: "First Name*", required: true, blank: true },
          { selector: "#name--preferredName--lastName", name: "preferredName--lastName", label: "Last Name*", required: true, blank: true },
        ],
      },
      legalNameAndPhoneBlank: true,
      optionalAddressFieldsBlank: true,
      candidateResponseValuesRetained: false,
      nextControl: { automationId: "pageFooterNextButton", text: "Save and Continue", visible: true, activated: false },
    });
    expect(observation.application.stepActions).toEqual({
      nativeResumeChooserUsed: true,
      continueActivatedToReachMyInformation: true,
      myInformationSaveAndContinueActivated: false,
      myInformationSaveAndContinueActivatedAfterSnapshot: true,
      myExperienceSaveAndContinueActivated: true,
      applicationQuestionsSaveAndContinueActivated: true,
      voluntaryDisclosuresSaveAndContinueActivated: true,
      applicationSubmitted: false,
    });
    expect(observation.job.countrySource).toContain("not applicant address or locale");
  });

  it("records Semtech My Experience row and control metadata without candidate field values", () => {
    const observation = JSON.parse(readFileSync(semtechGateObservationPath, "utf8")) as SemtechGateObservation;
    expect(observation.application.currentStepAfterMyInformation).toEqual({
      headingLevel: 3,
      heading: "My Experience",
      index: 3,
      count: 6,
    });
    expect(observation.application.myExperience).toMatchObject({
      step: { headingLevel: 3, heading: "My Experience", index: 3, count: 6 },
      workExperience: {
        sectionLabelledBy: "Work-Experience-section",
        sectionHeading: { level: 4, id: "Work-Experience-section" },
        rowLabelPattern: "Work-Experience-N-panel",
        rowHeadingPattern: { level: 5, id: "WorkExperienceN", title: "WorkExperienceN" },
        visibleRowCount: 1,
        preexistingNonblankRowCountObserved: 2,
        secondRowDeletedByUserDirection: true,
        candidateFieldValuesRetained: false,
        fields: {
          jobTitle: { idPattern: "workExperience-N--jobTitle", label: "Job Title*", ariaRequired: true },
          companyName: { idPattern: "workExperience-N--companyName", label: "Company Name*", ariaRequired: true },
          location: { idPattern: "workExperience-N--location", label: "Location*", ariaRequired: true },
          currentlyWorkHere: { idPattern: "workExperience-N--currentlyWorkHere", name: "currentlyWorkHere", type: "checkbox", label: "I currently work here", selectedStateRetained: false },
          startDate: { wrapperAutomationId: "formField-startDate", label: "From*", month: { automationId: "dateSectionMonth-input", role: "spinbutton", typeAttribute: null, ariaLabel: "Month", minimum: 1, maximum: 12 }, year: { automationId: "dateSectionYear-input", role: "spinbutton", typeAttribute: null, ariaLabel: "Year", minimum: 1, maximum: 9999 } },
          endDate: { wrapperAutomationId: "formField-endDate", label: "To*" },
          roleDescription: { idPattern: "workExperience-N--roleDescription", label: "Role Description*", ariaRequired: true },
        },
        addAnother: { automationId: "add-button", text: "Add Another", typeAttribute: null },
        deleteControl: { text: "Delete", typeAttribute: null, id: null, name: null, dataAutomationId: null },
        extraRowDeletion: { userDirected: true, confirmationShown: false, secondPanelRemovedImmediately: true },
      },
      education: {
        sectionLabelledBy: "Education-section",
        visibleRowCount: 1,
        rowLabelPattern: "Education-N-panel",
        school: { idPattern: "education-N--schoolName", name: "schoolName", label: "School or University*", ariaRequired: true, control: "input" },
        degree: { idPattern: "education-N--degree", name: "degree", label: "Degree*", control: "button", type: "button", selectionRequiredInAriaLabel: true },
        fieldOfStudy: {
          idPattern: "education-N--fieldOfStudy",
          name: "fieldOfStudy",
          label: "Field of Study*",
          placeholder: "Search",
          ariaRequired: true,
          control: "input",
          enterKeyHint: "search",
          parentAutomationIds: ["multiSelectContainer", "multiselectInputContainer"],
          formAncestorPresent: false,
          typedQueryAloneFilters: false,
          enterAfterQueryOpensOptions: true,
          queryResultOptionCount: 9,
          queryResultLabelsRetained: false,
          unfilteredPopup: {
            containerAutomationId: "activeListContainer",
            role: "listbox",
            hasAriaActiveDescendant: true,
            virtualized: true,
            visibleOptionCount: 12,
            visibleOptionRange: ["Accounting", "Agricultural Education"],
            dynamicOptionAutomationId: "menuItem",
            fullOptionListRetained: false,
          },
          selectionMadeDuringProbe: false,
        },
        gradeAverage: { idPattern: "education-N--gradeAverage", name: "gradeAverage", label: "Overall Result (GPA)", control: "input", type: "text", ariaRequired: false },
      },
      languages: {
        sectionLabelledBy: "Languages-section",
        visibleRowCount: 2,
        language: { idPattern: "language-N--language", name: "language", label: "Language*", control: "button", type: "button", choiceCount: 20, fullOptionListRetained: false },
        fluent: { idPattern: "language-N--native", name: "native", control: "checkbox", label: "I am fluent in this language.", ariaRequired: false, selectedStateRetained: false },
        proficiency: { labels: ["Comprehension*", "Overall*", "Reading*", "Speaking*", "Writing*"], opaqueIdsRetained: false, options: ["Select One", "1 - Beginner", "2 - Classroom Study", "3 - Intermediate", "4 - Advanced", "5 - Fluent"] },
      },
      websites: {
        sectionLabelledBy: "Websites-section",
        visibleRowCount: 0,
        emptyProbeRowAdded: true,
        emptyProbeRowRemoved: true,
        url: { idPattern: "webAddress-N--url", name: "url", label: "URL*", type: "text", ariaRequired: true, wrapperAutomationId: "formField-url", valueRetained: false },
        addAnother: { automationId: "add-button", text: "Add Another", typeAttribute: null },
      },
      resumeAttachmentPresent: true,
      calendarIcon: { role: "button", dataAutomationId: "dateIcon", activated: false, dateValuesChanged: false },
      saveAndContinueActivated: true,
      validationBeforeExtraRowRemoval: { errorsFound: true, requiredBlankLabels: ["Job Title", "Location", "To", "Field of Study"], stepDidNotAdvance: true },
      fieldValuesRetained: false,
      responseValuesRetained: false,
    });
    expect(observation.application.stepActions).toMatchObject({
      myInformationSaveAndContinueActivatedAfterSnapshot: true,
      myExperienceSaveAndContinueActivated: true,
      applicationQuestionsSaveAndContinueActivated: true,
      voluntaryDisclosuresSaveAndContinueActivated: true,
      applicationSubmitted: false,
    });
  });

  it("records the observed Semtech Application Questions controls without retaining answers", () => {
    const observation = JSON.parse(readFileSync(semtechApplicationQuestionsObservationPath, "utf8")) as {
      questions: Array<{ control: string | Record<string, unknown>; options?: string[] }>;
      [key: string]: unknown;
    };
    expect(observation).toMatchObject({
      fixtureType: "sanitized-dom-observation",
      tenant: "Semtech",
      locale: "en-US",
      jobCountry: "Canada",
      step: { heading: "Application Questions", index: 4, count: 6, sameSpaRoute: true },
      state: {
        requiredChoicePrompts: 7,
        requiredEssayFields: 2,
        totalRequiredQuestionCount: 9,
        choiceMenuSelectionsRetained: false,
        userChoiceValuesRetained: false,
        essayValuesRetained: false,
        applicationSubmitted: false,
      },
      choiceControl: {
        selectorPattern: "button[id^=primaryQuestionnaire--<opaque>]",
        type: "button",
        ariaHasPopup: "listbox",
        ariaLabel: " Select One Required",
        fieldsetLegendIsQuestion: true,
        popup: { selector: "ul[role=listbox][aria-activedescendant]", optionSelector: "li[role=option]" },
        additionalInputs: { count: 7, retainedAsAnswerFields: false },
      },
    });
    expect(observation.questions).toHaveLength(9);
    expect(observation.questions[3]?.options).toEqual([
      "Select One", "30,000 CAD  - 42,000 CAD", "43,000 CAD  - 54,000 CAD", "55,000 CAD  - 79,000 CAD",
      "80,000 CAD  - 104,000 CAD", "105,000 CAD  -124,000 CAD", "125,000 CAD  - 149,000 CAD",
      "150,000 CAD  - 174,000 CAD", "175,000 CAD  - 199,000 CAD", "200,000 CAD  - 224,000 CAD", "225,000 CAD+",
    ]);
    expect(observation.questions.slice(7).every((question) => question.control === "textarea")).toBe(true);
  });

  it("records Semtech Terms-only Voluntary Disclosures and read-only Review boundaries", () => {
    const disclosures = JSON.parse(readFileSync(semtechVoluntaryDisclosuresObservationPath, "utf8")) as {
      controls: Array<{ visibleLabel: string }>;
      [key: string]: unknown;
    };
    expect(disclosures).toMatchObject({
      tenant: "Semtech",
      step: { heading: "Voluntary Disclosures", index: 5, count: 6, sameSpaRoute: true },
      visibleSections: ["Terms and Conditions"],
      controls: [{
        selector: "#termsAndConditions--acceptTermsAndAgreements",
        name: "acceptTermsAndAgreements",
        type: "checkbox",
        ariaRequired: true,
        nativeRequired: false,
        checkedValueRetained: false,
        manualOnly: true,
      }],
      otherDisclosureControlsObserved: false,
      candidateConsentRetained: false,
      stepActions: { termsActivatedByResearcher: false, applicationSubmitted: false },
    });
    expect(disclosures.controls[0]?.visibleLabel).toBe("Yes, I have read and agree to the terms and conditions*");

    const review = JSON.parse(readFileSync(semtechReviewObservationPath, "utf8")) as Record<string, unknown>;
    expect(review).toMatchObject({
      tenant: "Semtech",
      step: { heading: "Review", index: 6, count: 6, sameSpaRoute: true },
      reviewWrapper: {
        dataAutomationId: "applyFlowReviewPage",
        interactiveDescendants: { input: 0, textarea: 0, select: 0, button: 0, link: 0, roleButton: 0 },
      },
      pageActionsOutsideReviewWrapper: [{ label: "Submit", type: null, dataAutomationId: "pageFooterNextButton", disabled: false }],
      stepActions: { submitActivated: false, applicationSubmitted: false },
    });
  });

  it("keeps synthetic Semtech question and disclosure fixtures blank and clearly synthetic", () => {
    const questions = readFileSync(syntheticSemtechApplicationQuestionsFixturePath, "utf8");
    expect(questions).toContain("Synthetic adapter fixture based on sanitized Semtech Application Questions");
    expect(questions).toContain('<li data-automation-id="progressBarActiveStep">current step 4 of 6</li>');
    expect(questions).toContain('button id="primaryQuestionnaire--question-001" name="question-001" type="button" aria-haspopup="listbox"');
    expect(questions).toContain('<ul id="question-list-001" role="listbox" aria-activedescendant="question-option-001-placeholder"');
    expect(questions).toContain('aria-disabled="true">Select One</li>');
    expect(questions).toContain('<textarea id="primaryQuestionnaire--essay-001" aria-required="true" maxlength="2000"></textarea>');
    expect(questions).not.toContain("name=\"candidate@example.com\"");
    expect(questions).not.toMatch(/<textarea[^>]*>[^<]+<\/textarea>/);

    const disclosures = readFileSync(syntheticSemtechVoluntaryDisclosuresFixturePath, "utf8");
    expect(disclosures).toContain("Synthetic test fixture from sanitized Semtech Voluntary Disclosures metadata");
    expect(disclosures).toContain('id="termsAndConditions--acceptTermsAndAgreements" name="acceptTermsAndAgreements" type="checkbox" aria-required="true"');
    expect(disclosures).not.toContain("checked>");
    expect(disclosures).not.toContain("personalInfoUS--");
  });

  it.skipIf(!runBrowserE2E)("keeps Semtech Application Questions blank without exact saved answers", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const url = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/synthetic-country/Synthetic-Role/apply/applicationQuestions";
      await page.route("https://semtech.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticSemtechApplicationQuestionsFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const result = await page.evaluate((applicationUrl) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const report = helper.scan({ profile: {}, answers: [], applicationCountry: "Canada" });
        return {
          report,
          choiceButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('button[id^="primaryQuestionnaire--"]'), (button) => button.textContent?.trim()),
          essayValues: Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea[id^="primaryQuestionnaire--"]'), (field) => field.value),
          auxiliaryInputs: document.querySelectorAll('fieldset input[type="text"]:not([id]):not([name])').length,
          selectedOptionCount: document.querySelectorAll('[role="option"][aria-selected="true"]').length,
          continueCount: Number((window as unknown as { continueCount: number }).continueCount),
          submitCount: Number((window as unknown as { submitCount: number }).submitCount),
          currentUrl: location.href,
          expectedUrl: applicationUrl,
        };
      }, url);
      expect(result.report).toMatchObject({ supported: true, ats: "Workday", workdayStep: "Application Questions" });
      expect(result.report.unknownQuestions.map((question) => question.question)).toHaveLength(9);
      expect(result.report.unknownQuestions.filter((question) => question.writtenDraftEligible)).toHaveLength(2);
      expect(result.choiceButtons).toHaveLength(7);
      expect(result.choiceButtons.every((label) => label === "Select One")).toBe(true);
      expect(result.essayValues).toEqual(["", ""]);
      expect(result.auxiliaryInputs).toBe(7);
      expect(result.selectedOptionCount).toBe(0);
      expect(result.continueCount).toBe(0);
      expect(result.submitCount).toBe(0);
      expect(result.currentUrl).toBe(result.expectedUrl);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!runBrowserE2E)("limits written drafts to the exact blank professional question and protects edits", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const url = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/synthetic-country/Synthetic-Role/apply/applicationQuestions";
      const question = "Please take a moment to briefly highlight your relevant work experience.";
      const salaryQuestion = "What are your base salary expectations (CAD)?";
      await page.route("https://semtech.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticSemtechApplicationQuestionsFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const initial = await page.evaluate(({ prompt, salaryPrompt, applicationUrl }) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        return {
          eligibleEssay: helper.inspectWrittenDraft(prompt, applicationUrl),
          salary: helper.inspectWrittenDraft(salaryPrompt, applicationUrl),
        };
      }, { prompt: question, salaryPrompt: salaryQuestion, applicationUrl: url });
      expect(initial.eligibleEssay).toMatchObject({ eligible: true, maxLength: 2_000 });
      expect(initial.salary.eligible).toBe(false);

      const generated = "A reviewed synthetic response based on professional experience.";
      const applied = await page.evaluate(({ prompt, draft, applicationUrl }) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        return helper.applyWrittenDraft({ question: prompt, draft, applicationUrl });
      }, { prompt: question, draft: generated, applicationUrl: url });
      expect(applied).toMatchObject({ applied: true, question });
      await page.locator("#primaryQuestionnaire--essay-001").fill("A user-edited response that Scout must preserve.");
      const protectedEdit = await page.evaluate(({ prompt, draft, applicationUrl }) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        return {
          inspect: helper.inspectWrittenDraft(prompt, applicationUrl, draft),
          apply: helper.applyWrittenDraft({ question: prompt, draft: "Replacement text", previousDraft: draft, applicationUrl }),
          value: document.querySelector<HTMLTextAreaElement>("#primaryQuestionnaire--essay-001")?.value,
          continueCount: (window as unknown as { continueCount: number }).continueCount,
          submitCount: (window as unknown as { submitCount: number }).submitCount,
        };
      }, { prompt: question, draft: generated, applicationUrl: url });
      expect(protectedEdit.inspect.eligible).toBe(false);
      expect(protectedEdit.apply).toMatchObject({ applied: false });
      expect(protectedEdit.value).toBe("A user-edited response that Scout must preserve.");
      expect(protectedEdit.continueCount).toBe(0);
      expect(protectedEdit.submitCount).toBe(0);

      await page.evaluate(() => history.pushState({}, "", `${location.pathname}/next`));
      const staleRoute = await page.evaluate(({ prompt, applicationUrl }) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        return helper.inspectWrittenDraft(prompt, applicationUrl);
      }, { prompt: question, applicationUrl: url });
      expect(staleRoute.eligible).toBe(false);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!runBrowserE2E)("leaves Semtech terms consent manual despite a saved affirmative answer", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const url = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/synthetic-country/Synthetic-Role/apply/voluntaryDisclosures";
      await page.route("https://semtech.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticSemtechVoluntaryDisclosuresFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const result = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const report = await helper.startWorkdaySession({
          profile: {},
          answers: [{ question: "Yes, I have read and agree to the terms and conditions", answer: "", answerType: "single-choice", selectedChoices: ["Yes, I have read and agree to the terms and conditions"] }],
        });
        const checked = document.querySelector<HTMLInputElement>("#termsAndConditions--acceptTermsAndAgreements")?.checked;
        const continueText = document.querySelector("[data-automation-id=pageFooterNextButton]")?.textContent?.trim();
        helper.stopWorkdaySession();
        return { report, checked, continueText };
      });
      expect(result.report).toMatchObject({ supported: true, ats: "Workday", workdayStep: "Voluntary Disclosures" });
      expect(result.checked).toBe(false);
      expect(result.continueText).toBe("Save and Continue");
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("keeps the synthetic Semtech My Experience fixture explicit about observed controls", () => {
    const html = readFileSync(syntheticSemtechMyExperienceFixturePath, "utf8");
    expect(html).toContain("Synthetic test fixture from sanitized Semtech My Experience observations");
    expect(html).toContain('<li data-automation-id="progressBarActiveStep">current step 3 of 6</li>');
    expect(html).toContain('<h3>My Experience</h3>');
    expect(html).toContain('aria-labelledby="Work-Experience-1-panel"');
    expect(html).toContain('id="workExperience-2--startDate-dateSectionMonth-input"');
    expect(html).toContain('id="workExperience-2--endDate-dateSectionYear-input"');
    expect(html).toContain('name="currentlyWorkHere" type="checkbox"');
    expect(html).toContain('value="Preexisting synthetic role to be removed"');
    expect(html).toContain('<button onclick="deleteExperienceRow(this)">Delete</button>');
    expect(html).toContain('id="education-1--fieldOfStudy" name="fieldOfStudy" placeholder="Search" enterkeyhint="search"');
    expect(html).toContain('data-automation-id="multiSelectContainer"');
    expect(html).toContain('data-automation-id="formField-fieldOfStudy"');
    expect(html).toContain('id="education-1--gradeAverage" name="gradeAverage" type="text"');
    expect(html).toContain('id="language-1--native" name="native" type="checkbox"');
    expect(html).toContain('id="language-2--writing"');
    expect(html).toContain('id="webAddress-1--url" name="url"');
    expect(html).toContain('data-automation-id="pageFooterNextButton"');
    expect(html).toContain('id="continue-count"');
    expect(html).toContain('id="experience-delete-count"');
    expect(html).not.toContain("candidate@example.com");
  });

  it.skipIf(!runBrowserE2E)("matches the saved Workday experience count and fills other blank synthetic sections without advancing", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/synthetic-tenant/Synthetic-Role/apply/myExperience";
      await context.route("https://semtech.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticSemtechMyExperienceFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const payload: WorkdayPayload = {
        profile: {
          experienceCount: 1,
          experience: [
            { company: "Example Organization A", title: "Synthetic profile title", location: "Synthetic profile location", startDate: "2020-01", endDate: "2020-02", description: "Synthetic profile description", currentlyWorkHere: false },
            { company: "Example Organization B", title: "Synthetic developer B", location: "Synthetic city B", startDate: "2024-03", endDate: "2024-06", description: "Synthetic role B", currentlyWorkHere: false },
            { company: "Example Organization C", title: "Synthetic developer C", location: "Synthetic city C", startDate: "2023-04", endDate: "2023-08", description: "Synthetic role C", currentlyWorkHere: false },
          ],
          education: [
            { school: "Example University", degree: "Bachelors", fieldOfStudy: "Computer Engineering", startDate: "", endDate: "", gradeAverage: "3.8" },
            { school: "Example College", degree: "Masters", fieldOfStudy: "", startDate: "", endDate: "", gradeAverage: "4.0" },
          ],
          languages: [
            { language: "Chinese", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" },
            { language: "English", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" },
          ],
          websites: [{ url: "https://example.test/profile" }],
        },
        answers: [],
      };
      const result = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const report = await helper.startWorkdaySession(input);
        const state = {
          experienceRows: Array.from(document.querySelectorAll('#work-experience-rows > [aria-labelledby^="Work-Experience-"]')).map((row) => ({
            title: row.querySelector<HTMLInputElement>('input[id$="--jobTitle"]')?.value,
            company: row.querySelector<HTMLInputElement>('input[id$="--companyName"]')?.value,
            location: row.querySelector<HTMLInputElement>('input[id$="--location"]')?.value,
            startMonth: row.querySelector<HTMLInputElement>('[data-automation-id="formField-startDate"] [data-automation-id="dateSectionMonth-input"]')?.value,
            startYear: row.querySelector<HTMLInputElement>('[data-automation-id="formField-startDate"] [data-automation-id="dateSectionYear-input"]')?.value,
            current: row.querySelector<HTMLInputElement>('input[name="currentlyWorkHere"]')?.checked,
          })),
          educationRows: Array.from(document.querySelectorAll('#education-rows > [aria-labelledby^="Education-"]')).map((row) => ({
            school: row.querySelector<HTMLInputElement>('input[name="schoolName"]')?.value,
            degree: row.querySelector<HTMLButtonElement>('button[name="degree"]')?.textContent?.trim(),
            fieldOfStudy: row.querySelector<HTMLInputElement>('input[name="fieldOfStudy"]')?.value,
            selectedFieldOfStudy: row.querySelector<HTMLElement>('[data-automation-id="selectedItem"]')?.textContent?.trim(),
            gpa: row.querySelector<HTMLInputElement>('input[name="gradeAverage"]')?.value,
          })),
          languages: Array.from(document.querySelectorAll('#language-rows > [aria-labelledby^="Languages-"]')).map((row) => ({
            language: row.querySelector<HTMLButtonElement>('button[name="language"]')?.textContent?.trim(),
            fluent: row.querySelector<HTMLInputElement>('input[name="native"]')?.checked,
            ratings: Array.from(row.querySelectorAll<HTMLButtonElement>('[data-automation-id^="formField-"] button')).map((button) => button.textContent?.trim()),
          })),
          website: document.querySelector<HTMLInputElement>('input[id="webAddress-1--url"]')?.value,
          addCounts: ["experience-add-count", "education-add-count"].map((id) => Number(document.getElementById(id)?.textContent ?? "0")),
          deleteCount: Number(document.getElementById("experience-delete-count")?.textContent ?? "0"),
          continueCount: Number(document.querySelector("#continue-count")?.textContent ?? "0"),
          submitCount: Number(document.querySelector("#submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { report, state };
      }, payload);

      expect(result.report).toMatchObject({ supported: true, ats: "Workday", workdayStep: "My Experience", sessionActive: true });
      expect(result.state.experienceRows).toHaveLength(1);
      expect(result.state.experienceRows[0]).toMatchObject({ title: "Existing synthetic role", company: "Example Organization A", location: "Synthetic location", startMonth: "5", startYear: "2025", current: false });
      expect(result.state.deleteCount).toBe(1);
      expect(result.state.educationRows).toHaveLength(2);
      expect(result.state.educationRows[0]).toMatchObject({ school: "Example University", degree: "Bachelors", fieldOfStudy: "", selectedFieldOfStudy: "Computer Engineering", gpa: "3.8" });
      expect(result.state.educationRows[1]).toMatchObject({ school: "Example College", degree: "Masters", fieldOfStudy: "", gpa: "4.0" });
      expect(result.state.languages).toEqual([
        { language: "Chinese", fluent: true, ratings: Array(5).fill("5 - Fluent") },
        { language: "English", fluent: true, ratings: Array(5).fill("5 - Fluent") },
      ]);
      expect(result.state.website).toBe("https://example.test/profile");
      expect(result.state.addCounts).toEqual([0, 1]);
      expect(result.state.continueCount).toBe(0);
      expect(result.state.submitCount).toBe(0);
      expect(result.report.sectionWarnings.some((warning) => /Field of Study.*catalog picker/i.test(warning.message))).toBe(false);

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const unmatchedCatalog = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const report = await helper.startWorkdaySession({
          profile: { experienceCount: 1, education: [{ school: "Example University", degree: "Bachelors", fieldOfStudy: "Not in this visible catalog", gradeAverage: "" }] },
          answers: [],
        });
        const state = {
          fieldValue: document.querySelector<HTMLInputElement>('input[name="fieldOfStudy"]')?.value,
          selectedItems: document.querySelectorAll('[data-automation-id="selectedItem"]').length,
          continueCount: Number(document.querySelector("#continue-count")?.textContent ?? "0"),
          submitCount: Number(document.querySelector("#submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { report, state };
      });
      expect(unmatchedCatalog.state).toEqual({ fieldValue: "", selectedItems: 0, continueCount: 0, submitCount: 0 });
      expect(unmatchedCatalog.report.sectionWarnings.some((warning) => /did not match exactly one visible catalog item/i.test(warning.message))).toBe(true);

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const zeroCount = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const report = await helper.startWorkdaySession({ profile: { experienceCount: 0 }, answers: [] });
        const state = {
          workRows: document.querySelectorAll('#work-experience-rows > [aria-labelledby^="Work-Experience-"]').length,
          deleteCount: Number(document.getElementById("experience-delete-count")?.textContent ?? "0"),
          continueCount: Number(document.querySelector("#continue-count")?.textContent ?? "0"),
          submitCount: Number(document.querySelector("#submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { report, state };
      });
      expect(zeroCount.state).toEqual({ workRows: 1, deleteCount: 1, continueCount: 0, submitCount: 0 });
      expect(zeroCount.report.sectionWarnings.some((warning) => /at least one|minimum|cannot remove/i.test(warning.message))).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("keeps the synthetic Semtech My Information fixture blank and aligned with observed selectors", () => {
    const html = readFileSync(syntheticSemtechMyInformationFixturePath, "utf8");
    expect(html).toContain("Synthetic test fixture from sanitized Semtech My Information observations");
    expect(html).toContain('<h3>My Information</h3>');
    expect(html).toContain('data-automation-id="formField-source"');
    expect(html).toContain('id="source--source" name="source" type="button" aria-haspopup="listbox"');
    expect(html).toContain("How Did You Hear About Us?*");
    expect(html).toContain("Have you previously been employed by Semtech as a Full-time, Part-time, Contractor or Temporary worker in any of our global locations?*");
    expect(html).toContain('name="candidateIsPreviousWorker" value="Yes"');
    expect(html).toContain('name="candidateIsPreviousWorker" value="No"');
    expect(html).not.toMatch(/name="candidateIsPreviousWorker" value="(?:Yes|No)" checked/);
    expect(html).not.toContain("aria-controls=");
    expect(html).not.toContain("aria-owns=");
    expect(html).not.toContain("aria-expanded=");
  });

  it.skipIf(!runBrowserE2E)("uses only an exact single referral choice on the synthetic Semtech selector", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/synthetic-tenant/Synthetic-Role/apply/synthetic-step";
      await context.route("https://semtech.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticSemtechMyInformationFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });

      const filled = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession({ profile: { referralSources: ["LinkedIn"] }, answers: [] });
        const state = {
          buttonText: document.querySelector("#source--source")?.textContent?.trim(),
          pickerClicks: Number(document.querySelector("#source-picker-click-count")?.textContent ?? "0"),
          optionClicks: Number(document.querySelector("#source-option-click-count")?.textContent ?? "0"),
          previousWorkerChecked: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="candidateIsPreviousWorker"]')).some((input) => input.checked),
        };
        helper.stopWorkdaySession();
        return { result, state };
      });
      expect(filled.result).toMatchObject({ supported: true, ats: "Workday", workdayStep: "My Information" });
      expect(filled.result.selected).toContainEqual({ question: "How Did You Hear About Us?", choices: ["LinkedIn"] });
      expect(filled.state).toEqual({ buttonText: "LinkedIn", pickerClicks: 1, optionClicks: 1, previousWorkerChecked: false });
      expect(filled.result.unknownQuestions.some((item) => item.question === "Have you previously been employed by Semtech as a Full-time, Part-time, Contractor or Temporary worker in any of our global locations?" )).toBe(true);

      await page.reload();
      await page.locator("#source--source").evaluate((button) => { button.textContent = "LinkedIn"; });
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const preselected = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession({ profile: { referralSources: ["LinkedIn"] }, answers: [] });
        const state = {
          buttonText: document.querySelector("#source--source")?.textContent?.trim(),
          pickerClicks: Number(document.querySelector("#source-picker-click-count")?.textContent ?? "0"),
          optionClicks: Number(document.querySelector("#source-option-click-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { result, state };
      });
      expect(preselected.result.selected).toContainEqual({ question: "How Did You Hear About Us?", choices: ["LinkedIn"] });
      expect(preselected.state).toEqual({ buttonText: "LinkedIn", pickerClicks: 0, optionClicks: 0 });

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const multipleProfileChoices = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession({ profile: { referralSources: ["LinkedIn", "Indeed"] }, answers: [] });
        const state = {
          buttonText: document.querySelector("#source--source")?.textContent?.trim(),
          pickerClicks: Number(document.querySelector("#source-picker-click-count")?.textContent ?? "0"),
          optionClicks: Number(document.querySelector("#source-option-click-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { result, state };
      });
      expect(multipleProfileChoices.result.unknownQuestions.some((item) => item.question === "How Did You Hear About Us?" )).toBe(true);
      expect(multipleProfileChoices.state).toEqual({ buttonText: "Select One", pickerClicks: 0, optionClicks: 0 });

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const mismatch = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession({
          profile: {},
          answers: [{ question: "How Did You Hear About Us?", answer: "", answerType: "multi-choice", selectedChoices: ["LinkedIn"] }],
        });
        const state = {
          buttonText: document.querySelector("#source--source")?.textContent?.trim(),
          pickerClicks: Number(document.querySelector("#source-picker-click-count")?.textContent ?? "0"),
          optionClicks: Number(document.querySelector("#source-option-click-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { result, state };
      });
      expect(mismatch.result.unknownQuestions.some((item) => item.question === "How Did You Hear About Us?" )).toBe(true);
      expect(mismatch.state).toEqual({ buttonText: "Select One", pickerClicks: 0, optionClicks: 0 });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("keeps the synthetic Semtech fixture aligned with the observed parser upload attributes", () => {
    const html = readFileSync(syntheticSemtechAutofillFixturePath, "utf8");
    const input = html.match(/<input[^>]*data-automation-id="file-upload-input-ref"[^>]*>/)?.[0] ?? "";
    expect(html).toContain("Synthetic test fixture based on sanitized Semtech Workday IAB observations");
    expect(html).toContain('<ol data-automation-id="progressBar">');
    expect(html).toContain('<li data-automation-id="progressBarActiveStep">current step 1 of 6</li>');
    expect(html).toContain("<h3>Autofill with Resume</h3>");
    expect(html).toContain('<div data-automation-id="resumeUpload">');
    expect(html).toContain('<button type="button" data-automation-id="select-files"');
    expect(input).toContain('type="file"');
    expect(input).not.toContain("multiple");
    expect(input).not.toContain("accept=");
    expect(input).not.toContain("name=");
    expect(input).not.toContain("required");
    expect(input).not.toContain("aria-required");
    expect(html).toContain('<button data-automation-id="pageFooterNextButton"');
  });

  it.skipIf(!runBrowserE2E)("attaches only the resume to the synthetic Semtech single-file parser widget without clicking or continuing", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://semtech.wd1.myworkdayjobs.com/en-US/semtechcareers/job/synthetic-tenant/Synthetic-Role/apply/autofillWithResume";
      await context.route("https://semtech.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticSemtechAutofillFixturePath) });
      });
      const sampleBytes = readFileSync(uploadFixturePath);
      const resume = {
        name: "scout-upload-test.pdf",
        type: "application/pdf",
        size: sampleBytes.byteLength,
        base64: sampleBytes.toString("base64"),
      };
      const coverLetter = { ...resume, name: "scout-cover-letter-test.pdf" };
      const payload: WorkdayPayload = { profile: {}, answers: [], documents: { resume, coverLetter } };

      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const run = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession(input);
        const initial = {
          files: Array.from(document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files ?? [], (file) => file.name),
          uploadChangeCount: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
        };
        await new Promise((resolve) => setTimeout(resolve, 220));
        const afterMutation = {
          files: Array.from(document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files ?? [], (file) => file.name),
          uploadChangeCount: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
          selectFileClickCount: Number(document.querySelector("#select-files-click-count")?.textContent ?? "0"),
          continueClickCount: Number(document.querySelector("#continue-click-count")?.textContent ?? "0"),
        };
        const stop = helper.stopWorkdaySession();
        return { result, initial, afterMutation, stop };
      }, payload);

      expect(run.result).toMatchObject({ supported: true, ats: "Workday", workdayStep: "Autofill with Resume", sessionActive: true });
      expect(run.result.attachments).toEqual(["scout-upload-test.pdf"]);
      expect(run.initial).toEqual({ files: ["scout-upload-test.pdf"], uploadChangeCount: 1 });
      expect(run.afterMutation).toEqual({
        files: ["scout-upload-test.pdf"],
        uploadChangeCount: 1,
        selectFileClickCount: 0,
        continueClickCount: 0,
      });
      expect(run.stop.stopped).toBe(true);

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      await page.locator('[data-automation-id="file-upload-input-ref"]').setInputFiles({
        name: "already-selected-local-file.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("synthetic pre-existing local file"),
      });
      const existingFile = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession(input);
        const files = Array.from(document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files ?? [], (file) => file.name);
        const state = {
          attachments: result.attachments,
          files,
          uploadChangeCount: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
          selectFileClickCount: Number(document.querySelector("#select-files-click-count")?.textContent ?? "0"),
          continueClickCount: Number(document.querySelector("#continue-click-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return state;
      }, payload);
      expect(existingFile).toEqual({
        attachments: [],
        files: ["already-selected-local-file.pdf"],
        uploadChangeCount: 1,
        selectFileClickCount: 0,
        continueClickCount: 0,
      });

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      await page.locator('[data-automation-id="resumeUpload"]').evaluate((widget) => {
        const item = document.createElement("div");
        item.setAttribute("data-automation-id", "file-upload-item");
        const success = document.createElement("span");
        success.setAttribute("data-automation-id", "file-upload-successful");
        success.textContent = "Successfully Uploaded!";
        item.append(success);
        widget.append(item);
      });
      const existingUploadItem = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession(input);
        const state = {
          attachments: result.attachments,
          inputFileCount: document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files?.length ?? 0,
          successText: document.querySelector('[data-automation-id="file-upload-successful"]')?.textContent?.trim(),
          selectFileClickCount: Number(document.querySelector("#select-files-click-count")?.textContent ?? "0"),
          continueClickCount: Number(document.querySelector("#continue-click-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return state;
      }, payload);
      expect(existingUploadItem).toEqual({
        attachments: [],
        inputFileCount: 0,
        successText: "Successfully Uploaded!",
        selectFileClickCount: 0,
        continueClickCount: 0,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("does not reuse a Mercer US-scoped answer for the Semtech Canadian job context", () => {
    const observation = JSON.parse(readFileSync(semtechGateObservationPath, "utf8")) as SemtechGateObservation;
    const prompt = "Synthetic same-prompt collision for tenant scope regression";
    const mercerAnswer: SavedAnswer = {
      question: prompt,
      answer: "",
      answerType: "single-choice",
      selectedChoices: ["No"],
      scope: {
        origin: "https://merceruniversity.wd1.myworkdayjobs.com",
        country: "United States",
        locale: "en-US",
      },
    };
    const semtechJobContext = {
      origin: "https://" + observation.host,
      country: observation.job.country,
      locale: observation.locale,
    };

    expect(semtechJobContext).toEqual({
      origin: "https://semtech.wd1.myworkdayjobs.com",
      country: "Canada",
      locale: "en-US",
    });
    expect(loadAnswerContract().resolveAnswer(prompt, [mercerAnswer], semtechJobContext)).toEqual({
      answer: null,
      ambiguous: false,
    });
  });

  it("keeps the review fixture free of editable fields and does not click page actions", () => {
    const html = readFileSync(syntheticReviewFixturePath, "utf8");
    const reviewStart = html.indexOf('<div data-automation-id="applyFlowReviewPage">');
    const reviewEnd = html.indexOf('\n    </div>\n    <button id="main-menu"', reviewStart);
    const review = reviewStart >= 0 && reviewEnd >= 0 ? html.slice(reviewStart, reviewEnd) : "";
    expect(review).toBeTruthy();
    expect(review).not.toMatch(/<(?:input|textarea|select|button|a)\b|role="button"/i);
    expect(html).toContain('data-automation-id="pageFooterNextButton"');
    expect(html).toContain('id="submit-click-count"');
  });

  it("resolves only an exact, explicitly typed answer for the observed previous-worker prompt", () => {
    const observation = loadObservation();
    const prompt = observation.controls.find((control) => control.control?.type === "radio")?.prompt;
    expect(prompt).toBeTruthy();
    const contract = loadAnswerContract();
    const answer: SavedAnswer = {
      question: prompt!,
      answer: "",
      answerType: "boolean",
      booleanValue: false,
      scope: { origin: `https://${observation.host}`, locale: observation.locale },
    };

    expect(contract.isValidAnswer(answer)).toBe(true);
    expect(contract.resolveAnswer(prompt!, [answer], { origin: `https://${observation.host}`, locale: observation.locale }).answer).toMatchObject({
      answerType: "boolean",
      booleanValue: false,
    });
    expect(contract.resolveAnswer(prompt!, [answer], { origin: `https://${observation.host}`, locale: "fr-CA" }).answer).toBeNull();
    expect(contract.resolveAnswer(`${prompt} Please confirm`, [answer], { origin: `https://${observation.host}`, locale: observation.locale }).answer).toBeNull();
  });

  it("reports conflicting same-scope choices as ambiguous instead of choosing one", () => {
    const observation = loadObservation();
    const prompt = observation.controls.find((control) => control.control?.type === "radio")?.prompt;
    expect(prompt).toBeTruthy();
    const scope = { origin: `https://${observation.host}`, locale: observation.locale };
    const answers: SavedAnswer[] = [
      { question: prompt!, answer: "", answerType: "boolean", booleanValue: true, scope },
      { question: prompt!, answer: "", answerType: "boolean", booleanValue: false, scope },
    ];
    const result = loadAnswerContract().resolveAnswer(prompt!, answers, scope);
    expect(result).toEqual({ answer: null, ambiguous: true });
  });

  it("keeps country-scoped legal answers ineligible for ambiguous or other-jurisdiction prompts", () => {
    const contract = loadAnswerContract();
    expect(contract.inferCountry("Are you a U.S. citizen?")).toBe("united states");
    expect(contract.inferCountry("Are you authorized to work in the United States and Canada?")).toBe("");
    expect(contract.inferCountry("Are you authorized to work in the United States or Canada?")).toBe("");
    expect(contract.inferCountry("Are you authorized to work in Canada?")).toBe("canada");
  });

  it.skipIf(!runBrowserE2E)("attaches the locally selected resume and cover letter to the shared My Experience widget without replacing existing files", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/synthetic-tenant/Synthetic-Role/apply/applyManually";
      await context.route("https://merceruniversity.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticExperienceFixturePath) });
      });
      const sampleBytes = readFileSync(uploadFixturePath);
      const sampleDocument = {
        name: "scout-upload-test.pdf",
        type: "application/pdf",
        size: sampleBytes.byteLength,
        base64: sampleBytes.toString("base64"),
      };
      const sampleCoverLetter = { ...sampleDocument, name: "scout-cover-letter-test.pdf" };
      const payload: WorkdayPayload = {
        profile: {},
        answers: [],
        documents: { resume: sampleDocument, coverLetter: sampleCoverLetter },
      };

      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const firstRun = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession(input);
        const state = {
          step: result.workdayStep,
          files: Array.from(document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files ?? [], (file) => file.name),
          uploadChangeCount: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
          visibleFileName: document.querySelector('[data-automation-id="file-upload-item-name"]')?.textContent?.trim(),
          successText: document.querySelector('[data-automation-id="file-upload-successful"]')?.textContent?.trim(),
        };
        document.querySelector("#certification-rows")?.append(document.createElement("div"));
        await new Promise((resolve) => setTimeout(resolve, 220));
        const afterMutation = {
          files: Array.from(document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files ?? [], (file) => file.name),
          uploadChangeCount: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
          clickCount: Number(document.querySelector("#select-files-click-count")?.textContent ?? "0"),
          certificationAddCount: Number(document.querySelector("#certification-add-click-count")?.textContent ?? "0"),
          submitCount: Number(document.querySelector("#experience-submit-count")?.textContent ?? "0"),
          certificationRows: document.querySelector("#certification-rows")?.children.length,
        };
        const stop = helper.stopWorkdaySession();
        return { result, state, afterMutation, stop };
      }, payload);

      expect(firstRun.result).toMatchObject({ supported: true, ats: "Workday", workdayStep: "My Experience", sessionActive: true });
      expect(firstRun.result.attachments).toEqual(["scout-upload-test.pdf", "scout-cover-letter-test.pdf"]);
      expect(firstRun.state).toEqual({
        step: "My Experience",
        files: ["scout-upload-test.pdf", "scout-cover-letter-test.pdf"],
        uploadChangeCount: 1,
        visibleFileName: "scout-upload-test.pdf, scout-cover-letter-test.pdf",
        successText: "Successfully Uploaded!",
      });
      expect(firstRun.afterMutation).toEqual({
        files: ["scout-upload-test.pdf", "scout-cover-letter-test.pdf"],
        uploadChangeCount: 1,
        clickCount: 0,
        certificationAddCount: 0,
        submitCount: 0,
        certificationRows: 1,
      });
      expect(firstRun.stop.stopped).toBe(true);

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      await page.locator('[data-automation-id="file-upload-input-ref"]').setInputFiles({
        name: "already-selected-local-file.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("synthetic pre-existing file selection"),
      });
      const existingFileState = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession(input);
        const state = {
          resultAttachments: result.attachments,
          files: Array.from(document.querySelector<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]')?.files ?? [], (file) => file.name),
          uploadChangeCount: Number(document.querySelector("#upload-change-count")?.textContent ?? "0"),
          clickCount: Number(document.querySelector("#select-files-click-count")?.textContent ?? "0"),
          certificationAddCount: Number(document.querySelector("#certification-add-click-count")?.textContent ?? "0"),
          submitCount: Number(document.querySelector("#experience-submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return state;
      }, payload);
      expect(existingFileState).toEqual({
        resultAttachments: [],
        files: ["already-selected-local-file.pdf"],
        uploadChangeCount: 1,
        clickCount: 0,
        certificationAddCount: 0,
        submitCount: 0,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!runBrowserE2E)("fills only exact saved answers in synthetic Application Questions controls", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/synthetic-tenant/Synthetic-Role/apply/applyManually";
      await context.route("https://merceruniversity.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticApplicationQuestionsFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });

      const observation = JSON.parse(readFileSync(applicationQuestionsObservationPath, "utf8")) as WorkdayApplicationQuestionsObservation;
      const employmentPrompt = observation.questions.find((question) => question.number === 1)?.prompt;
      const clearancePrompt = observation.questions.find((question) => question.number === 8)?.prompt;
      const citizenshipPrompt = observation.questions.find((question) => question.number === 6)?.prompt;
      const agreementPrompt = observation.questions.find((question) => question.number === 11)?.prompt;
      const twoCountryPrompt = "Are you authorized to work in the United States or Canada?";
      const dashChoicePrompt = "Which synthetic schedule label should the test choose?";
      expect(employmentPrompt && clearancePrompt && citizenshipPrompt && agreementPrompt).toBeTruthy();
      const scope = { origin: "https://merceruniversity.wd1.myworkdayjobs.com", locale: "en-US" };
      const payload: WorkdayPayload = {
        // My Information profile defaults do not answer unrelated questionnaire prompts.
        profile: { previousWorker: true, hasPreferredName: true },
        answers: [
          { question: employmentPrompt!, answer: "", answerType: "single-choice", selectedChoices: ["No"], scope },
          { question: clearancePrompt!, answer: "", answerType: "single-choice", selectedChoices: ["Maybe"], scope },
          { question: citizenshipPrompt!, answer: "", answerType: "single-choice", selectedChoices: ["No"], scope: { ...scope, country: "United States" } },
          { question: twoCountryPrompt, answer: "", answerType: "single-choice", selectedChoices: ["Yes"], scope: { ...scope, country: "United States" } },
          { question: dashChoicePrompt, answer: "", answerType: "single-choice", selectedChoices: ["-"], scope },
          { question: agreementPrompt!, answer: "", answerType: "single-choice", selectedChoices: ["Yes - I certify that I have read and agree with these statements."], scope },
        ],
      };

      const initial = await page.evaluate(async (input: WorkdayPayload) => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const scan = helper.scan({ profile: input.profile, answers: [] });
        const start = await helper.startWorkdaySession(input);
        const state = {
          employment: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-question-1")?.textContent?.trim(),
          clearance: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-question-2")?.textContent?.trim(),
          citizenship: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-question-6")?.textContent?.trim(),
          twoCountry: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-question-two-countries")?.textContent?.trim(),
          dashChoice: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-dash-choice")?.textContent?.trim(),
          agreement: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-question-11")?.textContent?.trim(),
          salary: document.querySelector<HTMLTextAreaElement>("#primaryQuestionnaire--synthetic-salary")?.value,
          optionClicks: Number(document.querySelector("#option-click-count")?.textContent ?? "0"),
          nextClicks: Number(document.querySelector("#next-click-count")?.textContent ?? "0"),
          submitCount: Number(document.querySelector("#questionnaire-submit-count")?.textContent ?? "0"),
        };
        return { scan, start, state };
      }, payload);
      expect(initial.scan).toMatchObject({ supported: true, ats: "Workday", workdayStep: "Application Questions" });
      expect(initial.scan.unknownQuestions).toContainEqual(expect.objectContaining({ question: employmentPrompt }));
      const citizenshipUnknown = initial.scan.unknownQuestions.find((question) => question.question === citizenshipPrompt);
      const twoCountryUnknown = initial.scan.unknownQuestions.find((question) => question.question === twoCountryPrompt);
      expect(citizenshipUnknown?.scopeContext?.country).toBe("united states");
      expect(twoCountryUnknown?.scopeContext?.country).toBeUndefined();
      expect(initial.start.workdayStep).toBe("Application Questions");
      expect(initial.start.selected).toContainEqual({ question: employmentPrompt, choices: ["No"] });
      expect(initial.start.selected).toContainEqual({ question: citizenshipPrompt, choices: ["No"] });
      expect(initial.start.selected).toContainEqual({ question: dashChoicePrompt, choices: ["-"] });
      expect(initial.start.unknownQuestions).not.toContainEqual(expect.objectContaining({ question: dashChoicePrompt }));
      expect(initial.start.unknownQuestions).toContainEqual(expect.objectContaining({
        question: clearancePrompt,
        savedAnswerMismatch: true,
      }));
      expect(initial.start.unknownQuestions).toContainEqual(expect.objectContaining({
        question: twoCountryPrompt,
        savedAnswerMismatch: true,
      }));
      expect(initial.start.unknownQuestions).toContainEqual(expect.objectContaining({
        question: agreementPrompt,
        reviewRequired: true,
      }));
      expect(initial.start.selected).not.toContainEqual(expect.objectContaining({ question: agreementPrompt }));
      expect(initial.state).toEqual({
        employment: "No",
        clearance: "Select One",
        citizenship: "No",
        twoCountry: "Select One",
        dashChoice: "-",
        agreement: "Select One",
        salary: "",
        optionClicks: 3,
        nextClicks: 0,
        submitCount: 0,
      });

      await page.locator("#primaryQuestionnaire--synthetic-question-1").press("ArrowDown");
      await page.locator("#synthetic-question-1-no").press("ArrowDown");
      await page.locator("#synthetic-question-1-yes").press("Enter");
      await page.waitForTimeout(220);
      const keyboardEdit = await page.evaluate(() => ({
        label: document.querySelector<HTMLButtonElement>("#primaryQuestionnaire--synthetic-question-1")?.textContent?.trim(),
        optionClicks: Number(document.querySelector("#option-click-count")?.textContent ?? "0"),
        nextClicks: Number(document.querySelector("#next-click-count")?.textContent ?? "0"),
        submitCount: Number(document.querySelector("#questionnaire-submit-count")?.textContent ?? "0"),
      }));
      expect(keyboardEdit).toEqual({ label: "Yes", optionClicks: 4, nextClicks: 0, submitCount: 0 });
      const stop = await page.evaluate(() => (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper.stopWorkdaySession());
      expect(stop.stopped).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!runBrowserE2E)("keeps the synthetic Review summary read-only and never activates Submit", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/synthetic-tenant/Synthetic-Role/apply/applyManually";
      await context.route("https://merceruniversity.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticReviewFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const result = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const payload: WorkdayPayload = { profile: { firstName: "Synthetic" }, answers: [] };
        const scan = helper.scan(payload);
        const start = await helper.startWorkdaySession(payload);
        const summaryControls = document.querySelectorAll('[data-automation-id="applyFlowReviewPage"] input, [data-automation-id="applyFlowReviewPage"] textarea, [data-automation-id="applyFlowReviewPage"] select, [data-automation-id="applyFlowReviewPage"] button, [data-automation-id="applyFlowReviewPage"] a, [data-automation-id="applyFlowReviewPage"] [role="button"]').length;
        const actions = {
          summaryControls,
          mainMenuClicks: Number(document.querySelector("#main-menu-click-count")?.textContent ?? "0"),
          backClicks: Number(document.querySelector("#back-click-count")?.textContent ?? "0"),
          submitClicks: Number(document.querySelector("#submit-click-count")?.textContent ?? "0"),
          navigationSubmits: Number(document.querySelector("#navigation-submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        return { scan, start, actions };
      });
      expect(result.scan).toMatchObject({
        supported: false,
        ats: "Workday",
        workdayStep: "Review",
      });
      expect(result.scan.manualReason).toMatch(/read.only|before submit/i);
      expect(result.start).toMatchObject({
        supported: false,
        workdayStep: "Review",
        sessionActive: false,
      });
      expect(result.start.filled ?? []).toEqual([]);
      expect(result.start.selected ?? []).toEqual([]);
      expect(result.start.attachments ?? []).toEqual([]);
      expect(result.actions).toEqual({ summaryControls: 0, mainMenuClicks: 0, backClicks: 0, submitClicks: 0, navigationSubmits: 0 });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.skipIf(!runBrowserE2E)("fills an observed-step synthetic Workday session without guessing source choices or submitting", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = "https://merceruniversity.wd1.myworkdayjobs.com/en-US/external/job/synthetic-tenant/Synthetic-Role/apply/applyManually";
      await context.route("https://merceruniversity.wd1.myworkdayjobs.com/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(syntheticFixturePath) });
      });
      await page.goto(url);
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });

      const observation = loadObservation();
      const previousWorkerQuestion = observation.controls.find((control) => control.control?.type === "radio")?.prompt;
      expect(previousWorkerQuestion).toBeTruthy();
      const payload: WorkdayPayload = {
        profile: {
          firstName: "Taylor",
          lastName: "Sample",
          email: "taylor.sample@example.test",
          phone: "416-555-0100",
          previousWorker: true,
          phoneType: "Mobile",
          phoneExtension: "204",
          referralSources: ["Synthetic Alpha", "Synthetic Gamma"],
          education: [],
          experience: [],
        },
        answers: [
          {
            question: previousWorkerQuestion!,
            answer: "",
            answerType: "boolean",
            booleanValue: false,
            scope: { origin: "https://merceruniversity.wd1.myworkdayjobs.com", locale: observation.locale },
          },
          {
            question: "Which work locations would you consider?",
            answer: "",
            answerType: "multi-choice",
            selectedChoices: [],
            scope: { origin: "https://merceruniversity.wd1.myworkdayjobs.com", locale: observation.locale },
          },
          {
            question: "Phone Device Type",
            answer: "",
            answerType: "single-choice",
            selectedChoices: ["Mobile"],
            scope: { origin: "https://merceruniversity.wd1.myworkdayjobs.com", locale: observation.locale },
          },
          { question: "Legacy duplicate radio label check", answer: "No" },
        ],
      };

      const result = await page.evaluate(async (input: WorkdayPayload) => {
        const browserWindow = window as unknown as Window & {
          ScoutFormHelper: WorkdayTestHelper;
          __scoutWorkdaySession?: unknown;
        };
        const helper = browserWindow.ScoutFormHelper;
        const scanInput = structuredClone(input);
        scanInput.profile.referralSources = [];
        const scan = helper.scan(scanInput);
        const start = await helper.startWorkdaySession(input);
        const state = {
          firstName: document.querySelector<HTMLInputElement>("#name--legalName--firstName")?.value,
          lastName: document.querySelector<HTMLInputElement>("#name--legalName--lastName")?.value,
          extensionNonempty: Boolean(document.querySelector<HTMLInputElement>("#phoneNumber--extension")?.value),
          previousWorkerNoChecked: document.querySelector<HTMLInputElement>('input[name="candidateIsPreviousWorker"][value="No"]')?.checked,
          phoneType: document.querySelector<HTMLButtonElement>("#phoneNumber--phoneType")?.textContent?.trim(),
          phonePickerArrowDownCount: Number(document.querySelector("#phone-arrow-count")?.textContent ?? "0"),
          sourceValue: document.querySelector<HTMLInputElement>("#source--source")?.value,
          sourceSelectedCount: document.querySelectorAll('#source-selected li').length,
          duplicateNoCount: document.querySelectorAll('input[name="duplicateNo"]:checked').length,
          submitCount: Number(document.querySelector("#synthetic-submit-count")?.textContent ?? "0"),
        };
        const stop = helper.stopWorkdaySession();
        document.querySelector("#source-listbox")?.setAttribute("data-fixture-options", "ready");
        const partial = await helper.startWorkdaySession({
          ...input,
          profile: { ...input.profile, referralSources: ["Synthetic Alpha", "Synthetic Gamma"] },
        });
        const partialState = {
          sourceSelectedCount: document.querySelectorAll('#source-selected li').length,
          submitCount: Number(document.querySelector("#synthetic-submit-count")?.textContent ?? "0"),
        };
        helper.stopWorkdaySession();
        const complete = await helper.startWorkdaySession({
          ...input,
          profile: { ...input.profile, referralSources: ["Synthetic Alpha", "Synthetic Beta"] },
        });
        const completeState = {
          sourceTags: Array.from(document.querySelectorAll("#source-selected li"), (item) => {
            const clone = item.cloneNode(true) as HTMLElement;
            clone.querySelectorAll("button, [aria-label]").forEach((element) => element.remove());
            return clone.textContent?.trim() ?? "";
          }),
          sourceSearch: document.querySelector<HTMLInputElement>("#source--source")?.value,
          submitCount: Number(document.querySelector("#synthetic-submit-count")?.textContent ?? "0"),
        };
        const completeStop = helper.stopWorkdaySession();
        return {
          scan,
          start,
          stop,
          state,
          activeAfterStop: Boolean(browserWindow.__scoutWorkdaySession),
          partial,
          partialState,
          complete,
          completeState,
          completeStop,
          activeAfterFinalStop: Boolean(browserWindow.__scoutWorkdaySession),
        };
      }, payload);

      const sourcePrompt = "How Did You Hear About Us?";
      expect(result.scan).toMatchObject({ supported: true, ats: "Workday", workdayStep: "My Information" });
      expect(result.scan.unknownQuestions).toContainEqual(expect.objectContaining({
        question: sourcePrompt,
        kind: "multi-select",
        choices: [],
      }));
      expect(result.scan.unknownQuestions).not.toContainEqual(expect.objectContaining({
        question: "Which work locations would you consider?",
      }));
      expect(result.scan.unknownQuestions).toContainEqual(expect.objectContaining({
        question: "Legacy duplicate radio label check",
        savedAnswerMismatch: true,
      }));
      expect(result.start.sessionActive).toBe(true);
      expect(result.start.workdayStep).toBe("My Information");
      expect(result.start.selected).toEqual(expect.arrayContaining([
        { question: previousWorkerQuestion, choices: ["No"] },
        { question: "Phone Device Type", choices: ["Mobile"] },
        { question: "Which work locations would you consider?", choices: [] },
      ]));
      expect(result.start.unknownQuestions).toContainEqual(expect.objectContaining({
        question: sourcePrompt,
        kind: "multi-select",
        choices: [],
      }));
      expect(result.state).toMatchObject({
        firstName: "Taylor",
        lastName: "Sample",
        extensionNonempty: true,
        previousWorkerNoChecked: true,
        phoneType: "Mobile",
        sourceValue: "",
        sourceSelectedCount: 0,
        duplicateNoCount: 0,
        submitCount: 0,
      });
      expect(result.state.phonePickerArrowDownCount).toBeGreaterThan(0);
      expect(result.start.reviewedChoices).toContain("Which work locations would you consider?");
      expect(result.start.unknownQuestions).toContainEqual(expect.objectContaining({
        question: "Legacy duplicate radio label check",
        savedAnswerMismatch: true,
      }));
      expect(result.stop.stopped).toBe(true);
      expect(result.activeAfterStop).toBe(false);
      expect(result.partial.unknownQuestions).toContainEqual(expect.objectContaining({
        question: sourcePrompt,
        kind: "multi-select",
      }));
      expect(result.partialState).toEqual({ sourceSelectedCount: 0, submitCount: 0 });
      expect(result.complete.selected).toContainEqual({ question: sourcePrompt, choices: ["Synthetic Alpha", "Synthetic Beta"] });
      expect(result.completeState).toEqual({
        sourceTags: ["Synthetic Alpha", "Synthetic Beta"],
        sourceSearch: "",
        submitCount: 0,
      });
      expect(result.completeStop.stopped).toBe(true);
      expect(result.activeAfterFinalStop).toBe(false);

      await page.reload();
      await page.addScriptTag({ path: resolve(extensionRoot, "answer-contract.js") });
      await page.addScriptTag({ path: resolve(extensionRoot, "ats.js") });
      const profileOnly = await page.evaluate(async () => {
        const helper = (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper;
        const result = await helper.startWorkdaySession({
          profile: { firstName: "Taylor", previousWorker: false, hasPreferredName: true },
          answers: [],
        });
        return {
          result,
          firstName: document.querySelector<HTMLInputElement>("#name--legalName--firstName")?.value,
          previousWorkerNoChecked: document.querySelector<HTMLInputElement>('input[name="candidateIsPreviousWorker"][value="No"]')?.checked,
          preferredNameChecked: document.querySelector<HTMLInputElement>("#name--preferredCheck")?.checked,
        };
      });
      expect(profileOnly.result.sessionActive).toBe(true);
      expect(profileOnly).toMatchObject({
        firstName: "Taylor",
        previousWorkerNoChecked: true,
        preferredNameChecked: true,
      });
      await page.locator("#name--legalName--firstName").fill("User edit after initial fill");
      await page.evaluate(() => {
        const form = document.querySelector("#synthetic-application");
        const label = document.createElement("label");
        label.htmlFor = "synthetic-dynamic-first-name";
        label.textContent = "First Name*";
        const input = document.createElement("input");
        input.id = "synthetic-dynamic-first-name";
        form?.append(label, input);
      });
      await page.waitForTimeout(220);
      const preservedEdit = await page.locator("#name--legalName--firstName").inputValue();
      expect(preservedEdit).toBe("User edit after initial fill");
      expect(await page.locator("#synthetic-dynamic-first-name").inputValue()).toBe("Taylor");
      await page.evaluate(() => {
        (window as unknown as Window & { ScoutFormHelper: WorkdayTestHelper }).ScoutFormHelper.stopWorkdaySession();
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30_000);
});
