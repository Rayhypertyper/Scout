import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

type HelperProfile = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneType: string;
  phoneCountryCode: string;
  phoneExtension: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  workAuthorization: string;
  requiresSponsorship: string;
  previousWorker: boolean | null;
  hasPreferredName: boolean | null;
  preferredFirstName: string;
  preferredLastName: string;
  referralSources: string[];
  experienceCount: number | null;
  education: Array<{ school: string; degree: string; fieldOfStudy: string; startDate: string; endDate: string; gradeAverage: string }>;
  experience: Array<{ company: string; title: string; startDate: string; endDate: string; description: string; location: string; currentlyWorkHere: boolean | null }>;
  websites: Array<{ url: string }>;
  languages: Array<{ language: string; fluent: boolean | null; comprehension: string; overall: string; reading: string; speaking: string; writing: string }>;
};

type SavedAnswer = {
  id: string;
  question: string;
  answer: string;
  answerType?: "text" | "single-choice" | "multi-choice" | "boolean";
  selectedChoices?: string[];
  booleanValue?: boolean;
  scope?: { origin?: string; country?: string; locale?: string };
};

const blankProfile: HelperProfile = {
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
  preferredFirstName: "",
  preferredLastName: "",
  referralSources: [],
  experienceCount: null,
  education: [],
  experience: [],
  websites: [],
  languages: [],
};

describe("Scout browser helper profile UI", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")(
    "loads the signed-in profile, edits repeatable records and answers, and protects the application flow",
    async () => {
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
        const baseUrl = "https://scout.test";
        const publicRoot = resolve(process.cwd(), "public");
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== baseUrl) {
            await route.abort();
            return;
          }
          const relativePath = url.pathname === "/browser-helper" ? "browser-helper.html" : url.pathname.replace(/^\/+/, "");
          const filePath = resolve(publicRoot, relativePath);
          if (!filePath.startsWith(`${publicRoot}/`)) {
            await route.abort();
            return;
          }
          try {
            const extension = extname(filePath);
            const contentType = extension === ".html" ? "text/html; charset=utf-8"
              : extension === ".css" ? "text/css; charset=utf-8"
                : extension === ".js" ? "text/javascript; charset=utf-8"
                  : extension === ".woff2" ? "font/woff2"
                    : extension === ".png" ? "image/png" : "application/octet-stream";
            await route.fulfill({ status: 200, contentType, body: readFileSync(filePath) });
          } catch {
            await route.abort();
          }
        });

        let authMode: "authenticated" | "anonymous" | "unavailable" | "unconfigured" = "authenticated";
        let failProfileRead = false;
        let storedProfile = structuredClone(blankProfile);
        let storedAnswers: SavedAnswer[] = [];
        let nextAnswerId = 1;
        let profileReads = 0;
        const profileWrites: Array<{ profile: HelperProfile; csrf: string | undefined; accountId: string | undefined }> = [];
        const profileMutationAccountIds: Array<string | undefined> = [];
        const answerWrites: Array<{
          question: string;
          answer: string;
          payload: Record<string, unknown>;
          csrf: string | undefined;
          accountId: string | undefined;
        }> = [];
        const answerDeletes: string[] = [];
        const answerDeleteAccountIds: Array<string | undefined> = [];
        let failNextProfileWriteWithAccountConflict = false;

        await context.route("**/api/auth/session", async (route) => {
          if (authMode === "unavailable") {
            await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Session service is unavailable." } }) });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ configured: authMode !== "unconfigured", authenticated: authMode === "authenticated", csrfToken: "helper-e2e-csrf" }),
          });
        });

        await context.route("**/api/browser-helper/profile**", async (route) => {
          const request = route.request();
          if (request.method() === "GET") {
            profileReads += 1;
            if (failProfileRead) {
              await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Profile storage is unavailable." } }) });
              return;
            }
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ contract: "scout.browser-helper.v1", profile: storedProfile, answers: storedAnswers, updatedAt: null, accountId: "synthetic-account", csrfToken: "helper-e2e-csrf" }),
            });
            return;
          }
          if (request.method() === "PUT") {
            const body = request.postDataJSON() as { profile: HelperProfile };
            const accountHeader = request.headers()["x-scout-account-id"];
            profileMutationAccountIds.push(accountHeader);
            if (failNextProfileWriteWithAccountConflict) {
              failNextProfileWriteWithAccountConflict = false;
              await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The signed-in Scout account changed. Reload Scout and reconnect before saving." }) });
              return;
            }
            profileWrites.push({ profile: structuredClone(body.profile), csrf: request.headers()["x-csrf-token"], accountId: accountHeader });
            storedProfile = structuredClone(body.profile);
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profile: storedProfile }) });
            return;
          }
          await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "Unsupported profile action." }) });
        });

        await context.route("**/api/browser-helper/answers", async (route) => {
          const request = route.request();
          const body = request.postDataJSON() as {
            id?: string;
            question?: string;
            answer?: string;
            answerType?: SavedAnswer["answerType"];
            selectedChoices?: string[];
            booleanValue?: boolean;
            scope?: SavedAnswer["scope"];
          };
          if (request.method() === "PUT") {
            answerWrites.push({
              question: body.question ?? "",
              answer: body.answer ?? "",
              payload: structuredClone(body),
              csrf: request.headers()["x-csrf-token"],
              accountId: request.headers()["x-scout-account-id"],
            });
            const normalizedQuestion = (body.question ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
            const existing = storedAnswers.find((entry) => entry.question.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US") === normalizedQuestion);
            let saved: SavedAnswer;
            if (existing) {
              existing.question = (body.question ?? "").trim();
              existing.answer = body.answer ?? "";
              existing.answerType = body.answerType ?? "text";
              if (body.selectedChoices) existing.selectedChoices = body.selectedChoices;
              else delete existing.selectedChoices;
              if (body.booleanValue !== undefined) existing.booleanValue = body.booleanValue;
              else delete existing.booleanValue;
              if (body.scope) existing.scope = body.scope;
              else delete existing.scope;
              saved = existing;
            } else {
              saved = {
                id: `answer-${nextAnswerId++}`,
                question: (body.question ?? "").trim(),
                answer: body.answer ?? "",
                answerType: body.answerType ?? "text",
                ...(body.selectedChoices ? { selectedChoices: body.selectedChoices } : {}),
                ...(body.booleanValue !== undefined ? { booleanValue: body.booleanValue } : {}),
                ...(body.scope ? { scope: body.scope } : {}),
              };
              storedAnswers.push(saved);
            }
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: saved }) });
            return;
          }
          if (request.method() === "DELETE") {
            const id = body.id ?? "";
            answerDeletes.push(id);
            answerDeleteAccountIds.push(request.headers()["x-scout-account-id"]);
            storedAnswers = storedAnswers.filter((entry) => entry.id !== id);
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
            return;
          }
          await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "Unsupported answer action." }) });
        });

        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${baseUrl}/browser-helper`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Your profile" }).waitFor({ state: "visible", timeout: 8_000 });
        expect(await page.locator("#profile-empty-note").isVisible()).toBe(true);
        expect(await page.getByLabel("Work authorization (country-specific)").inputValue()).toBe("");
        expect(await page.locator('[name="requiresSponsorship"]').inputValue()).toBe("");
        expect(await page.getByLabel("Were you a previous employee or student at Mercer University OR are you a current MERC employee?").inputValue()).toBe("");
        expect(await page.getByLabel("Do you have a preferred name?").inputValue()).toBe("");
        expect(await page.locator("#preferred-name-fields").isVisible()).toBe(false);
        expect(await page.getByText("The original resume document is not retained here", { exact: false }).isVisible()).toBe(true);

        await page.getByLabel("First name").fill("Taylor");
        await page.getByLabel("Last name").fill("Nguyen");
        await page.getByLabel("Email").fill("taylor@example.test");
        await page.getByLabel("Phone number").fill("416-555-0100");
        await page.getByLabel("Phone type").selectOption("Mobile");
        await page.getByLabel("Phone country or region code label").fill("Canada (+1)");
        await page.getByLabel("Phone extension (optional)").fill("42");
        await page.getByLabel("Country", { exact: true }).fill("Canada");
        await page.getByLabel("Work authorization (country-specific)").fill("Authorized to work in Canada");
        await page.getByLabel("Will you need sponsorship now or in the future?").selectOption("false");
        await page.getByLabel("Were you a previous employee or student at Mercer University OR are you a current MERC employee?").selectOption("false");
        await page.getByLabel("Do you have a preferred name?").selectOption("true");
        expect(await page.locator("#preferred-name-fields").isVisible()).toBe(true);
        await page.getByLabel("Preferred first name").fill("Taylor");
        await page.getByLabel("Preferred last name").fill("N.");
        await page.getByLabel("How did you hear about us? (exact option labels)").fill("University career center\nEmployee referral");
        await page.getByLabel("LinkedIn").fill("https://linkedin.com/in/taylor-nguyen");

        await page.getByRole("button", { name: "Add education" }).click();
        const education = page.locator("#education-list .helper-record").first();
        await education.locator('[data-field="school"]').fill("Synthetic University");
        await education.locator('[data-field="degree"]').fill("BSc Computer Science");
        await education.locator('[data-field="fieldOfStudy"]').fill("Computer Science");
        await education.locator('[data-field="startDate"]').fill("2024-09");
        await education.locator('[data-field="endDate"]').fill("2028-04");
        await education.locator('[data-field="gradeAverage"]').fill("3.8");
        await page.getByRole("button", { name: "Add education" }).click();
        await page.getByRole("button", { name: "Add education" }).click();
        const thirdEducation = page.locator("#education-list .helper-record").nth(2);
        await thirdEducation.locator('[data-field="school"]').fill("Second Example University");
        await page.locator("#education-list .helper-record").nth(1).getByRole("button", { name: "Remove education 2" }).click();
        expect(await page.locator("#education-list .helper-record").count()).toBe(2);
        expect(await page.locator("#education-list .helper-record").nth(1).locator('[data-field="school"]').inputValue()).toBe("Second Example University");

        await page.getByRole("button", { name: "Add experience" }).click();
        const experience = page.locator("#experience-list .helper-record").first();
        await experience.locator('[data-field="company"]').fill("Example Labs");
        await experience.locator('[data-field="title"]').fill("Software Intern");
        await experience.locator('[data-field="location"]').fill("Remote");
        await experience.locator('[data-field="startDate"]').fill("2025-05");
        await experience.locator('[data-field="endDate"]').fill("2025-08");
        await experience.locator('[data-field="currentlyWorkHere"]').selectOption("false");
        await experience.locator('[data-field="description"]').fill("Built a role-tracking tool and reviewed every release.");
        await page.getByRole("button", { name: "Add experience" }).click();
        const secondExperience = page.locator("#experience-list .helper-record").nth(1);
        await secondExperience.locator('[data-field="company"]').fill("Second Example Labs");
        await secondExperience.locator('[data-field="title"]').fill("Research Assistant");
        await page.getByLabel("Work experience panels to fill (0–20)").fill("1");

        await page.getByRole("button", { name: "Add website" }).click();
        const website = page.locator("#website-list .helper-record").first();
        await website.locator('[data-field="url"]').fill("https://portfolio.example.test");
        await page.getByRole("button", { name: "Add website" }).click();
        expect(await page.locator("#website-list .helper-record").count()).toBe(2);
        await page.locator("#website-list .helper-record").nth(1).getByRole("button", { name: "Remove website 2" }).click();
        expect(await page.locator("#website-list .helper-record").count()).toBe(1);

        await page.getByRole("button", { name: "Add language" }).click();
        const language = page.locator("#language-list .helper-record").first();
        await language.locator('[data-field="language"]').fill("Examplelang");
        await language.locator('[data-field="fluent"]').selectOption("true");
        for (const field of ["comprehension", "overall", "reading", "speaking", "writing"]) {
          await language.locator(`[data-field="${field}"]`).fill("5 - Fluent");
        }
        await page.getByRole("button", { name: "Save profile" }).click();
        await page.waitForFunction(() => document.querySelector("#profile-save-status")?.textContent?.includes("Profile saved") === true);
        expect(await page.locator("#profile-save-status").innerText()).toContain("Profile saved");

        expect(profileWrites).toHaveLength(1);
        expect(profileWrites[0]?.csrf).toBe("helper-e2e-csrf");
        expect(profileWrites[0]?.accountId).toBe("synthetic-account");
        expect(profileWrites[0]?.profile).toMatchObject({
          firstName: "Taylor",
          lastName: "Nguyen",
          email: "taylor@example.test",
          phone: "416-555-0100",
          phoneType: "Mobile",
          phoneCountryCode: "Canada (+1)",
          phoneExtension: "42",
          country: "Canada",
          referralSources: ["University career center", "Employee referral"],
          experienceCount: 1,
          workAuthorization: "Authorized to work in Canada",
          requiresSponsorship: "false",
          previousWorker: false,
          hasPreferredName: true,
          preferredFirstName: "Taylor",
          preferredLastName: "N.",
          education: [
            { school: "Synthetic University", degree: "BSc Computer Science", fieldOfStudy: "Computer Science", startDate: "2024-09", endDate: "2028-04", gradeAverage: "3.8" },
            { school: "Second Example University", degree: "", fieldOfStudy: "", startDate: "", endDate: "", gradeAverage: "" },
          ],
          experience: [
            { company: "Example Labs", title: "Software Intern", startDate: "2025-05", endDate: "2025-08", description: "Built a role-tracking tool and reviewed every release.", location: "Remote", currentlyWorkHere: false },
            { company: "Second Example Labs", title: "Research Assistant", startDate: "", endDate: "", description: "", location: "", currentlyWorkHere: null },
          ],
          websites: [{ url: "https://portfolio.example.test" }],
          languages: [{ language: "Examplelang", fluent: true, comprehension: "5 - Fluent", overall: "5 - Fluent", reading: "5 - Fluent", speaking: "5 - Fluent", writing: "5 - Fluent" }],
        });

        await page.getByLabel("Question or prompt").fill("Why are you interested in this team?");
        await page.getByLabel("Your answer").fill("I like building reliable tools with thoughtful teams.");
        await page.getByRole("button", { name: "Save answer" }).click();
        await page.getByRole("heading", { name: "Why are you interested in this team?" }).waitFor({ state: "visible" });
        expect(answerWrites[0]?.csrf).toBe("helper-e2e-csrf");
        expect(answerWrites[0]?.accountId).toBe("synthetic-account");

        await page.getByRole("button", { name: "Edit answer: Why are you interested in this team?" }).click();
        const answerEditor = page.getByRole("form", { name: "Edit saved answer: Why are you interested in this team?" });
        await answerEditor.getByLabel("Question or prompt").fill("  WHY ARE YOU INTERESTED IN THIS TEAM?  ");
        await answerEditor.getByLabel("Your answer").fill("I enjoy building careful tools with collaborative teams.");
        await answerEditor.getByRole("button", { name: "Save changes" }).click();
        await page.getByRole("heading", { name: "WHY ARE YOU INTERESTED IN THIS TEAM?" }).waitFor({ state: "visible" });
        expect(answerWrites).toHaveLength(2);
        expect(answerDeletes).toHaveLength(0);

        await page.getByRole("button", { name: "Edit answer: WHY ARE YOU INTERESTED IN THIS TEAM?" }).click();
        const semanticEditor = page.getByRole("form", { name: "Edit saved answer: WHY ARE YOU INTERESTED IN THIS TEAM?" });
        await semanticEditor.getByLabel("Question or prompt").fill("What interests you about this team?");
        await semanticEditor.getByLabel("Your answer").fill("I enjoy building careful tools with collaborative teams.");
        await semanticEditor.getByRole("button", { name: "Save changes" }).click();
        await page.getByRole("heading", { name: "What interests you about this team?" }).waitFor({ state: "visible" });
        expect(answerWrites).toHaveLength(3);
        expect(answerDeletes).toHaveLength(1);
        expect(answerDeleteAccountIds).toEqual(["synthetic-account"]);

        await page.getByRole("button", { name: "Edit answer: What interests you about this team?" }).click();
        const typedEditor = page.getByRole("form", { name: "Edit saved answer: What interests you about this team?" });
        await typedEditor.getByLabel("Answer format").selectOption("multi-choice");
        await typedEditor.getByLabel("Exact option labels").fill("First generation\nTransfer student");
        await typedEditor.getByLabel("Country", { exact: true }).fill("Canada");
        await typedEditor.getByRole("button", { name: "Save changes" }).click();
        await page.getByText("First generation · Transfer student", { exact: true }).waitFor({ state: "visible" });
        expect(answerWrites).toHaveLength(4);
        expect(answerWrites[3]?.payload).toMatchObject({
          answerType: "multi-choice",
          selectedChoices: ["First generation", "Transfer student"],
          scope: { country: "Canada" },
        });

        const reviewDirectory = resolve(process.cwd(), ".impeccable/review");
        mkdirSync(reviewDirectory, { recursive: true });
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        await page.addStyleTag({ content: ".skip-link { visibility: hidden !important; } .helper-aside { position: static !important; }" });
        await page.setViewportSize({ width: 1365, height: 900 });
        await page.screenshot({ path: resolve(reviewDirectory, "browser-helper-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: resolve(reviewDirectory, "browser-helper-mobile.png"), fullPage: true });
        const mobileWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
        expect(mobileWidth).toBeLessThanOrEqual(390);
        const mobileActionHeights = await page.locator(".helper-add-button, .helper-remove-button, .helper-answer-actions button, #save-profile").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
        expect(mobileActionHeights.every((height) => height >= 44)).toBe(true);
        expect(await page.locator(".helper-field > span").first().evaluate((label) => getComputedStyle(label).fontSize)).toBe("13px");

        await page.getByRole("button", { name: "Clear profile fields" }).click();
        await page.getByText("Fields cleared. Save profile to update Scout.").waitFor({ state: "visible" });
        expect(await page.locator("#education-list .helper-record").count()).toBe(0);
        expect(await page.locator("#experience-list .helper-record").count()).toBe(0);
        expect(await page.locator("#website-list .helper-record").count()).toBe(0);
        expect(await page.locator("#language-list .helper-record").count()).toBe(0);
        expect(profileWrites).toHaveLength(1);
        await page.getByRole("button", { name: "Save profile" }).click();
        await page.waitForFunction(() => document.querySelector("#profile-save-status")?.textContent?.includes("Profile saved") === true);
        expect(profileWrites).toHaveLength(2);
        expect(profileWrites[1]?.profile).toEqual(blankProfile);

        failNextProfileWriteWithAccountConflict = true;
        await page.getByLabel("Email").fill("stale@example.test");
        await page.getByRole("button", { name: "Save profile" }).click();
        await page.getByText("The signed-in Scout account changed. Reload Scout and reconnect before saving.", { exact: true }).waitFor({ state: "visible" });
        expect(profileWrites).toHaveLength(2);
        expect(profileMutationAccountIds).toEqual(["synthetic-account", "synthetic-account", "synthetic-account"]);

        await page.getByRole("button", { name: "Delete answer: What interests you about this team?" }).click();
        await page.locator("#answers-empty").waitFor({ state: "visible" });
        expect(await page.locator("#answers-empty").isVisible()).toBe(true);
        expect(answerDeletes).toHaveLength(2);

        authMode = "anonymous";
        const signedOutPage = await context.newPage();
        await signedOutPage.goto(`${baseUrl}/browser-helper`, { waitUntil: "domcontentloaded" });
        await signedOutPage.getByRole("heading", { name: "Sign in to use your application profile" }).waitFor({ state: "visible" });
        expect(profileReads).toBe(5);

        authMode = "unconfigured";
        const unconfiguredPage = await context.newPage();
        await unconfiguredPage.goto(`${baseUrl}/browser-helper`, { waitUntil: "domcontentloaded" });
        await unconfiguredPage.getByRole("heading", { name: "Scout sign-in is unavailable" }).waitFor({ state: "visible" });

        authMode = "authenticated";
        failProfileRead = true;
        const errorPage = await context.newPage();
        await errorPage.goto(`${baseUrl}/browser-helper`, { waitUntil: "domcontentloaded" });
        await errorPage.getByRole("heading", { name: "Your profile could not load" }).waitFor({ state: "visible" });
        failProfileRead = false;
        await errorPage.getByRole("button", { name: "Try again" }).click();
        await errorPage.getByRole("heading", { name: "Your profile" }).waitFor({ state: "visible" });

        authMode = "unavailable";
        const unavailablePage = await context.newPage();
        await unavailablePage.goto(`${baseUrl}/browser-helper`, { waitUntil: "domcontentloaded" });
        await unavailablePage.getByRole("heading", { name: "Your profile could not load" }).waitFor({ state: "visible" });
        expect(pageErrors).toEqual([]);
        await context.close();
      } finally {
        await browser?.close();
      }
    },
    45_000,
  );
});
