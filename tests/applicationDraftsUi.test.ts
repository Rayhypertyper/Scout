import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "playwright";
import { expect, describe, it } from "vitest";

import { createAuthenticatedHarness } from "./authenticatedHarness.js";

type ResumeEntryFixture = { title: string; subtitle: string; date: string; bullets: string[] };
type ResumeFixture = {
  ownerEmail: string;
  name: string;
  contact: string[];
  education: ResumeEntryFixture[];
  experience: ResumeEntryFixture[];
  projects: ResumeEntryFixture[];
  awards: string[];
  skills: Array<{ label: string; items: string[] }>;
};

const resumeFixture: ResumeFixture = {
  ownerEmail: "account-owner@synthetic.example",
  name: "Sample Candidate",
  contact: ["sample@example.test", "Toronto, ON", "example.test/sample"],
  education: [{ title: "BSc Computer Science", subtitle: "Synthetic University", date: "2024–2028", bullets: ["Dean's list"] }],
  experience: [],
  projects: [],
  awards: ["Synthetic hackathon finalist"],
  skills: [{ label: "Languages", items: ["TypeScript", "Python"] }],
};

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

describe("application draft and resume profile UI", () => {
  it("places one global resume entry directly before Add source", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const profileButton = html.indexOf('id="resume-profile-button"');
    const addSourceButton = html.indexOf('id="add-source-button"');
    expect(profileButton).toBeGreaterThanOrEqual(0);
    expect(profileButton).toBeLessThan(addSourceButton);
    expect([...html.matchAll(/data-open-resume-profile/g)]).toHaveLength(1);
    expect(html.slice(profileButton, addSourceButton)).toContain("Your resume");

    const app = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
    expect(app).not.toContain('data-open-resume-profile>Upload a resume');
    expect(app).toContain("global resume control beside Add source");
  });

  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")(
    "reviews resume changes, exports the exact tailored draft, and handles profile, keyboard and mobile states",
    async () => {
      const harness = await createAuthenticatedHarness();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      const requests = {
        profileGets: 0,
        profileImports: [] as Array<{ filename: string; contentType: string; data: string; csrf: string | undefined }>,
        profileSaves: [] as Array<{ filename: string; resume: typeof resumeFixture; csrf: string | undefined }>,
        profileDeletes: 0,
        drafts: [] as Array<{ id: string; kind: string; csrf: string | undefined }>,
        pdfs: [] as Array<{ id: string; resume: typeof resumeFixture; csrf: string | undefined }>,
        cancelDraftRequests: 0,
      };
      let savedProfile: { resume: typeof resumeFixture; filename: string; updatedAt: string } | null = null;
      let resumeDraftAttempts = 0;
      const updatedResume = structuredClone(resumeFixture);
      updatedResume.experience = [{
        title: "Research Assistant",
        subtitle: "Synthetic University Lab",
        date: "May 2025 – Aug 2025",
        bullets: ["Added automated tests for model inputs", "Developed a TypeScript data tool that reduced review time by 20%"],
      }];
      updatedResume.projects = [{
        title: "Signal Board",
        subtitle: "Personal project",
        date: "2025",
        bullets: ["Developed a React and SQLite app to track roles"],
      }];
      const draftChanges = {
        bullets: [
          { sourceRef: "experience.0.bullets.0", section: "experience", title: "Research Assistant", subtitle: "Synthetic University Lab", before: "Built a TypeScript data tool that cut review time by 20%", after: updatedResume.experience[0]!.bullets[1], roleKeyword: "TypeScript", roleRequirement: "Build backend tools with TypeScript." },
          { sourceRef: "experience.0.bullets.1", section: "experience", title: "Research Assistant", subtitle: "Synthetic University Lab", before: "Wrote automated tests for model inputs", after: updatedResume.experience[0]!.bullets[0] },
          { sourceRef: "projects.0.bullets.0", section: "projects", title: "Signal Board", subtitle: "Personal project", before: "Created a role-tracking app with React and SQLite", after: updatedResume.projects[0]!.bullets[0] },
        ],
        ordering: [{ label: "Research Assistant · bullet order", before: ["Built a TypeScript data tool that cut review time by 20%", "Wrote automated tests for model inputs"], after: updatedResume.experience[0]!.bullets }],
      };
      const screenshotDirectory = resolve(process.cwd(), ".impeccable/review");
      mkdirSync(screenshotDirectory, { recursive: true });

      try {
        if (harness.transport !== "network") throw new Error("Draft UI browser test requires an ephemeral loopback listener.");
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: true });
        try {
          await context.addCookies([{
            name: "rr-e2e-session",
            value: harness.sessions.complete,
            url: harness.baseUrl,
          }]);
          const page = await context.newPage();
          await page.addInitScript(() => {
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: { writeText: async (text: string) => { Object.assign(window, { __copiedText: text }); } },
            });
          });
          await context.route("https://logos.hunter.io/**", (route) => route.abort());
          await context.route("https://www.google.com/s2/favicons**", (route) => route.abort());
          await context.route("**/api/resume-profile**", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (request.method() === "GET" && path === "/api/resume-profile") {
              requests.profileGets += 1;
              await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ profile: savedProfile, csrfToken: "synthetic-csrf-token" }) });
              return;
            }
            if (request.method() === "POST" && path === "/api/resume-profile/import") {
              const body = request.postDataJSON() as { filename: string; contentType: string; data: string };
              requests.profileImports.push({ ...body, csrf: request.headers()["x-csrf-token"] });
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: jsonBody({
                  filename: body.filename,
                  resume: structuredClone(resumeFixture),
                  warnings: ["Review the dates in the extracted experience section."],
                }),
              });
              return;
            }
            if (request.method() === "PUT" && path === "/api/resume-profile") {
              const body = request.postDataJSON() as { filename: string; resume: typeof resumeFixture };
              requests.profileSaves.push({ ...body, csrf: request.headers()["x-csrf-token"] });
              savedProfile = { ...body, updatedAt: "2026-10-01T15:00:00.000Z" };
              await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ profile: savedProfile }) });
              return;
            }
            if (request.method() === "DELETE" && path === "/api/resume-profile") {
              requests.profileDeletes += 1;
              savedProfile = null;
              await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ profile: null }) });
              return;
            }
            await route.fulfill({ status: 405, contentType: "application/json", body: jsonBody({ error: "Unsupported profile request" }) });
          });
          await context.route("**/api/application-drafts/**", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const id = decodeURIComponent(url.pathname.split("/").at(-1) || "");
            const body = request.postDataJSON() as { kind: string };
            requests.drafts.push({ id, kind: body.kind, csrf: request.headers()["x-csrf-token"] });
            if (body.kind === "resume") {
              resumeDraftAttempts += 1;
              if (resumeDraftAttempts === 1) {
                await route.fulfill({
                  status: 200,
                  contentType: "application/json",
                  body: jsonBody({
                    kind: "resume",
                    role: { title: "Backend Engineering Intern", company: "Beta Match" },
                    source: "deterministic",
                    matchedSkills: ["TypeScript"],
                    warnings: ["OpenAI is unavailable. This draft uses rule-based matching."],
                    resume: structuredClone(savedProfile!.resume),
                    changes: { bullets: [], ordering: [] },
                  }),
                });
                return;
              }
              if (resumeDraftAttempts === 2) {
                await route.fulfill({ status: 503, contentType: "application/json", body: jsonBody({ error: "OpenAI could not prepare this draft. Try again." }) });
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: jsonBody({
                  kind: "resume",
                  role: { title: "Backend Engineering Intern", company: "Beta Match" },
                  source: "llm",
                  matchedSkills: ["TypeScript", "Python"],
                  warnings: ["Review each result and date before applying."],
                  resume: structuredClone(updatedResume),
                  changes: draftChanges,
                }),
              });
              return;
            }
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: jsonBody({
                kind: "cover-letter",
                role: { title: "Backend Engineering Intern", company: "Beta Match" },
                source: "deterministic",
                matchedSkills: ["TypeScript"],
                warnings: [],
                text: "Dear Hiring Team,\n\nI am interested in the Backend Engineering Intern role at Beta Match. My TypeScript experience includes building a data tool for a university lab.\n\nSincerely,\nSample Candidate",
              }),
            });
          });
          await context.route("**/api/resumes/**", async (route) => {
            const request = route.request();
            const id = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) || "");
            const body = request.postDataJSON() as { resume: typeof resumeFixture };
            requests.pdfs.push({ id, resume: body.resume, csrf: request.headers()["x-csrf-token"] });
            await route.fulfill({
              status: 200,
              contentType: "application/pdf",
              headers: { "content-disposition": 'attachment; filename="resume.pdf"' },
              body: Buffer.from("%PDF-1.4 synthetic mock"),
            });
          });

          await page.goto(`${harness.baseUrl}/jobs?view=all&tab=canada&sort=posted`, { waitUntil: "domcontentloaded" });
          const roleList = page.locator("#role-list .job-card[data-listing-key]");
          await roleList.first().waitFor({ state: "visible", timeout: 10_000 });
          const betaRole = roleList.filter({ hasText: "Beta Match" }).first();
          const globalResumeButton = page.locator("#resume-profile-button");
          const resumeButton = betaRole.locator("button[data-application-draft='resume']");
          expect(await resumeButton.innerText()).toBe("Download resume");
          expect(await betaRole.locator("button[data-application-draft='cover-letter']").count()).toBe(1);
          expect(await globalResumeButton.innerText()).toBe("Your resume");
          expect(await globalResumeButton.getAttribute("aria-label")).toBe("Upload or manage your resume");
          expect(await globalResumeButton.evaluate((button) => button.nextElementSibling?.id)).toBe("add-source-button");
          expect(await page.locator(".sidebar [data-open-resume-profile]").count()).toBe(0);
          expect(await betaRole.locator("button[data-open-resume-profile]").count()).toBe(0);
          await globalResumeButton.focus();
          await page.keyboard.press("Tab");
          expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("add-source-button");
          expect(requests.profileGets).toBe(0);
          expect(requests.profileImports).toHaveLength(0);
          expect(requests.drafts).toHaveLength(0);

          await globalResumeButton.click();
          await page.getByText("No resume saved yet").waitFor();
          expect(await globalResumeButton.innerText()).toBe("Upload resume");
          expect(requests.profileGets).toBe(1);
          await page.locator("#resume-profile-file").setInputFiles({
            name: "unsupported.doc",
            mimeType: "application/msword",
            buffer: Buffer.from("Synthetic file"),
          });
          await page.getByRole("alert").getByText("Choose a PDF or plain text resume.").waitFor();
          expect(requests.profileImports).toHaveLength(0);
          await page.locator("#resume-profile-file").setInputFiles({
            name: "oversized-resume.txt",
            mimeType: "text/plain",
            buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
          });
          await page.getByRole("alert").getByText("Choose a resume file that is 5 MiB or smaller.").waitFor();
          expect(requests.profileImports).toHaveLength(0);
          await page.locator("#resume-profile-file").setInputFiles({
            name: "synthetic-resume.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Synthetic resume content for browser test only."),
          });
          await page.getByText("Extraction ready · review before saving").waitFor({ timeout: 2_000 });
          expect(await page.getByText(/original file was sent to OpenAI/i).count()).toBe(1);
          expect(await page.getByText("Review the dates in the extracted experience section.").count()).toBe(1);
          await page.screenshot({ path: join(screenshotDirectory, "application-drafts-upload-review.png"), animations: "disabled" });
          expect(requests.profileSaves).toHaveLength(0);
          expect(requests.profileImports[0]?.contentType).toBe("text/plain");
          expect(Buffer.from(requests.profileImports[0]?.data || "", "base64").toString("utf8")).toContain("Synthetic resume content");
          expect(requests.profileImports[0]?.csrf).toBeTruthy();

          await page.getByRole("button", { name: "Add experience" }).click();
          const experience = page.locator("[data-resume-entry][data-entry-group='experience']").last();
          await experience.locator("[data-entry-field='title']").fill("Research Assistant");
          await experience.locator("[data-entry-field='subtitle']").fill("Synthetic University Lab");
          await experience.locator("[data-entry-field='date']").fill("May 2025 – Aug 2025");
          await experience.locator("[data-entry-field='bullets']").fill("Built a TypeScript data tool that cut review time by 20%\nWrote automated tests for model inputs");
          await page.getByRole("button", { name: "Add project" }).click();
          const project = page.locator("[data-resume-entry][data-entry-group='projects']").last();
          await project.locator("[data-entry-field='title']").fill("Signal Board");
          await project.locator("[data-entry-field='subtitle']").fill("Personal project");
          await project.locator("[data-entry-field='date']").fill("2025");
          await project.locator("[data-entry-field='bullets']").fill("Created a role-tracking app with React and SQLite");
          await page.getByRole("button", { name: "Add skill group" }).click();
          const skill = page.locator("[data-resume-skill]").last();
          await skill.locator("[data-skill-label]").fill("Tools");
          await skill.locator("[data-skill-items]").fill("Git\nSQLite");
          await page.getByRole("button", { name: "Save as my resume" }).click();
          await page.getByText("Active resume", { exact: true }).waitFor();
          expect(requests.profileSaves).toHaveLength(1);
          expect(requests.profileSaves[0]?.filename).toBe("synthetic-resume.txt");
          expect(requests.profileSaves[0]?.resume.experience[0]?.title).toBe("Research Assistant");
          expect(requests.profileSaves[0]?.resume.projects[0]?.title).toBe("Signal Board");
          expect(requests.profileSaves[0]?.resume.skills[1]?.items).toEqual(["Git", "SQLite"]);
          expect(requests.profileSaves[0]?.csrf).toBeTruthy();
          expect(await globalResumeButton.innerText()).toBe("Manage resume");
          expect(await page.locator("[data-resume-email]").count()).toBe(0);

          await page.locator("#resume-profile-file").setInputFiles({
            name: "synthetic-replacement.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF-1.4 synthetic replacement"),
          });
          await page.getByText("Extraction ready · review before saving").waitFor({ timeout: 2_000 });
          expect(requests.profileImports.at(-1)?.contentType).toBe("application/pdf");
          expect(requests.profileSaves).toHaveLength(1);
          expect(await page.locator("#resume-profile-filename").innerText()).toBe("synthetic-replacement.pdf");
          await page.getByRole("button", { name: "Discard draft" }).click();
          expect(await page.locator("#resume-profile-filename").innerText()).toBe("synthetic-resume.txt");
          expect(await page.getByText("Active resume", { exact: true }).count()).toBe(1);
          await page.getByRole("button", { name: "Close your resume" }).click();

          await resumeButton.click();
          await page.getByText("Fallback draft · rule-based matching").waitFor();
          expect(await page.getByRole("button", { name: "Try AI wording again" }).count()).toBe(1);
          expect(await page.locator("#application-draft-content input, #application-draft-content textarea").count()).toBe(0);
          expect(await page.getByText("No bullet wording was changed in this draft.").count()).toBe(1);
          await page.getByRole("button", { name: "Try AI wording again" }).click();
          await page.getByRole("alert").getByText("OpenAI could not prepare this draft. Try again.").waitFor();
          expect(await page.getByRole("button", { name: "Keep current draft" }).count()).toBe(1);
          await page.getByRole("button", { name: "Keep current draft" }).click();
          expect(await page.getByText("No bullet wording was changed in this draft.").count()).toBe(1);
          await page.getByRole("button", { name: "Try AI wording again" }).click();
          await page.getByRole("heading", { name: "Resume changes" }).waitFor();
          await page.getByText("AI-assisted wording").waitFor();
          expect(await page.getByText("Relevant skills found in your resume").count()).toBe(1);
          expect(await page.getByRole("button", { name: "Download tailored resume PDF" }).count()).toBe(1);
          expect(await page.locator("#application-draft-content input, #application-draft-content textarea").count()).toBe(0);
          expect(await page.locator(".resume-changes .resume-change-comparison").count()).toBe(3);
          expect(await page.locator(".resume-changes .resume-change-original").first().innerText()).toContain(draftChanges.bullets[0]!.before);
          expect(await page.locator(".resume-changes .resume-change-tailored").first().innerText()).toContain(draftChanges.bullets[0]!.after);
          expect(await page.getByText("Role focus: TypeScript", { exact: true }).count()).toBe(1);
          expect(await page.getByText(/Build backend tools with TypeScript\./).count()).toBe(1);
          expect(await page.locator("#application-draft-content").evaluate((content) => content.scrollTop)).toBe(0);
          expect(await page.getByRole("button", { name: "Download tailored resume PDF" }).evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight;
          })).toBe(true);
          await page.screenshot({ path: join(screenshotDirectory, "application-drafts-desktop.png"), animations: "disabled" });
          await page.locator(".resume-change-ordering summary").click();
          expect(await page.locator(".resume-change-ordering .resume-change-tailored li").allTextContents()).toEqual(updatedResume.experience[0]!.bullets);
          await page.locator(".resume-draft-notes summary").click();
          expect(await page.getByText("Review each result and date before applying.").isVisible()).toBe(true);
          await page.locator("#application-draft-close").focus();
          await page.keyboard.press("Shift+Tab");
          expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.downloadResume)).toBe("");
          await page.keyboard.press("Tab");
          expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("application-draft-close");
          const pdfDownloadPromise = page.waitForEvent("download");
          await page.getByRole("button", { name: "Download tailored resume PDF" }).click();
          const pdfDownload = await pdfDownloadPromise;
          expect(pdfDownload.suggestedFilename()).toBe("resume.pdf");
          expect(requests.pdfs).toHaveLength(1);
          expect(requests.pdfs[0]?.resume).toEqual(updatedResume);
          expect(requests.pdfs[0]?.csrf).toBeTruthy();
          await page.keyboard.press("Escape");
          expect(await page.locator("#application-draft-dialog").isVisible()).toBe(false);
          expect(await page.evaluate(() => document.activeElement?.getAttribute("data-application-draft"))).toBe("resume");

          await betaRole.locator("button[data-application-draft='cover-letter']").click();
          await page.getByRole("heading", { name: "Cover letter draft" }).waitFor();
          await page.locator("[data-cover-letter-text]").fill("Dear Beta Match,\n\nThis is edited, synthetic cover letter text.\n\nSincerely,\nSample Candidate");
          await page.getByRole("button", { name: "Copy text" }).click();
          await page.getByRole("status").getByText("Cover letter copied.").waitFor();
          expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toContain("edited, synthetic cover letter text");
          const coverDownloadPromise = page.waitForEvent("download");
          await page.getByRole("button", { name: "Download .txt" }).click();
          const coverDownload = await coverDownloadPromise;
          expect(coverDownload.suggestedFilename()).toBe("cover-letter-beta-match.txt");
          await page.keyboard.press("Escape");

          const detailOpenButton = betaRole.locator("button[data-open-role-detail]").first();
          await detailOpenButton.click();
          const roleDetail = page.locator("#role-detail-panel");
          await roleDetail.waitFor({ state: "visible" });
          expect(await roleDetail.locator("button[data-application-draft='resume']").count()).toBe(1);
          expect(await roleDetail.locator("button[data-application-draft='cover-letter']").count()).toBe(1);
          await page.getByRole("button", { name: "Close role details" }).click();

          const generatedResumeRequests = requests.drafts.filter((draft) => draft.kind === "resume").length;
          await globalResumeButton.click();
          await page.getByText("Active resume", { exact: true }).waitFor();
          await page.locator("#resume-profile-content [data-resume-contact]").fill("sample@example.test\nToronto, ON\nexample.test/sample\nUpdated synthetic contact");
          await page.getByRole("button", { name: "Save changes" }).click();
          await page.getByRole("status").getByText("Resume changes saved.").waitFor();
          expect(requests.profileSaves).toHaveLength(2);
          expect(requests.profileSaves[1]?.resume.contact).toContain("Updated synthetic contact");
          await page.getByRole("button", { name: "Close your resume" }).click();
          await resumeButton.click();
          await page.getByText("AI-assisted wording").waitFor();
          expect(requests.drafts.filter((draft) => draft.kind === "resume")).toHaveLength(generatedResumeRequests + 1);
          await page.locator("#application-draft-content").evaluate((content) => { content.scrollTop = 200; });
          await page.keyboard.press("Escape");
          await resumeButton.click();
          await page.getByText("AI-assisted wording").waitFor();
          expect(await page.locator("#application-draft-content").evaluate((content) => content.scrollTop)).toBe(0);
          await page.keyboard.press("Escape");

          const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
          try {
            await mobileContext.addCookies([{
              name: "rr-e2e-session",
              value: harness.sessions.complete,
              url: harness.baseUrl,
            }]);
            const mobilePage = await mobileContext.newPage();
            await mobilePage.addInitScript(() => {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: { writeText: async (text: string) => { Object.assign(window, { __copiedText: text }); } },
              });
            });
            await mobileContext.route("https://logos.hunter.io/**", (route) => route.abort());
            await mobileContext.route("https://www.google.com/s2/favicons**", (route) => route.abort());
            await mobileContext.route("**/api/resume-profile**", async (route) => {
              const request = route.request();
              const path = new URL(request.url()).pathname;
              if (request.method() === "GET" && path === "/api/resume-profile") {
                requests.profileGets += 1;
                await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ profile: savedProfile, csrfToken: "synthetic-csrf-token" }) });
                return;
              }
              if (request.method() === "POST" && path === "/api/resume-profile/import") {
                const body = request.postDataJSON() as { filename: string; contentType: string; data: string };
                requests.profileImports.push({ ...body, csrf: request.headers()["x-csrf-token"] });
                await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ filename: body.filename, resume: structuredClone(resumeFixture), warnings: [] }) });
                return;
              }
              if (request.method() === "PUT" && path === "/api/resume-profile") {
                const body = request.postDataJSON() as { filename: string; resume: typeof resumeFixture };
                requests.profileSaves.push({ ...body, csrf: request.headers()["x-csrf-token"] });
                savedProfile = { ...body, updatedAt: "2026-10-01T15:00:00.000Z" };
                await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ profile: savedProfile }) });
                return;
              }
              if (request.method() === "DELETE" && path === "/api/resume-profile") {
                requests.profileDeletes += 1;
                savedProfile = null;
                await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({ profile: null }) });
                return;
              }
              await route.fulfill({ status: 405, contentType: "application/json", body: jsonBody({ error: "Unsupported profile request" }) });
            });
            await mobileContext.route("**/api/application-drafts/**", async (route) => {
              const request = route.request();
              const url = new URL(request.url());
              const id = decodeURIComponent(url.pathname.split("/").at(-1) || "");
              const body = request.postDataJSON() as { kind: string };
              requests.drafts.push({ id, kind: body.kind, csrf: request.headers()["x-csrf-token"] });
              if (id === "match-secondary" && body.kind === "resume" && requests.cancelDraftRequests === 0) {
                requests.cancelDraftRequests += 1;
                await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 350));
                try { await route.fulfill({ status: 200, contentType: "application/json", body: jsonBody({}) }); } catch { /* expected after close */ }
                return;
              }
              if (id === "match-secondary" && body.kind === "resume" && !savedProfile) {
                await route.fulfill({ status: 404, contentType: "application/json", body: jsonBody({ error: "Your resume is not saved yet. Upload and save it before generating an application draft." }) });
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: jsonBody(body.kind === "cover-letter"
                  ? { kind: "cover-letter", role: { title: "Backend Engineering Intern", company: "Beta Match" }, source: "llm", matchedSkills: ["TypeScript"], warnings: [], text: "Dear Hiring Team,\n\nMobile synthetic cover letter.\n\nSincerely,\nSample Candidate" }
                  : { kind: "resume", role: { title: "Backend Engineering Intern", company: "Beta Match" }, source: "llm", matchedSkills: ["TypeScript", "Python"], warnings: [], resume: structuredClone(updatedResume), changes: draftChanges }),
              });
            });
            await mobileContext.route("**/api/resumes/**", async (route) => {
              const request = route.request();
              const id = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) || "");
              const body = request.postDataJSON() as { resume: typeof resumeFixture };
              requests.pdfs.push({ id, resume: body.resume, csrf: request.headers()["x-csrf-token"] });
              await route.fulfill({ status: 200, contentType: "application/pdf", headers: { "content-disposition": 'attachment; filename="resume.pdf"' }, body: Buffer.from("%PDF-1.4 synthetic mock") });
            });
            await mobilePage.goto(`${harness.baseUrl}/jobs?view=all&tab=canada&sort=posted`, { waitUntil: "domcontentloaded" });
            const mobileRoles = mobilePage.locator("#role-list .job-card[data-listing-key]");
            await mobileRoles.first().waitFor({ state: "visible", timeout: 10_000 });
            const mobileBeta = mobileRoles.filter({ hasText: "Beta Match" }).first();
            await mobileBeta.scrollIntoViewIfNeeded();
            const mobileResumeButton = mobilePage.locator("#resume-profile-button");
            const toolbarLayout = await mobilePage.evaluate(() => {
              const resume = document.querySelector("#resume-profile-button")?.getBoundingClientRect();
              const source = document.querySelector("#add-source-button")?.getBoundingClientRect();
              return {
                viewportWidth: window.innerWidth,
                documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                resumeRight: resume?.right ?? 0,
                addSourceLeft: source?.left ?? 0,
                resumeHeight: resume?.height ?? 0,
              };
            });
            expect(toolbarLayout.resumeRight).toBeLessThanOrEqual(toolbarLayout.addSourceLeft);
            expect(toolbarLayout.documentWidth).toBeLessThanOrEqual(toolbarLayout.viewportWidth);
            expect(toolbarLayout.resumeHeight).toBeGreaterThanOrEqual(44);
            await mobileResumeButton.focus();
            await mobilePage.keyboard.press("Tab");
            expect(await mobilePage.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("add-source-button");
            await mobilePage.setViewportSize({ width: 600, height: 844 });
            const tabletToolbar = await mobilePage.evaluate(() => {
              const resume = document.querySelector("#resume-profile-button")?.getBoundingClientRect();
              const source = document.querySelector("#add-source-button")?.getBoundingClientRect();
              return {
                viewportWidth: window.innerWidth,
                documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                resumeRight: resume?.right ?? 0,
                addSourceLeft: source?.left ?? 0,
                resumeHeight: resume?.height ?? 0,
                resumeWidth: resume?.width ?? 0,
              };
            });
            expect(tabletToolbar.resumeRight).toBeLessThanOrEqual(tabletToolbar.addSourceLeft);
            expect(tabletToolbar.documentWidth).toBeLessThanOrEqual(tabletToolbar.viewportWidth);
            expect(tabletToolbar.resumeHeight).toBeGreaterThanOrEqual(44);
            expect(tabletToolbar.resumeWidth).toBeGreaterThanOrEqual(44);
            await mobileResumeButton.focus();
            await mobilePage.keyboard.press("Tab");
            expect(await mobilePage.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("add-source-button");
            await mobilePage.setViewportSize({ width: 390, height: 844 });
            await mobileBeta.locator("button[data-application-draft='cover-letter']").click();
            await mobilePage.getByRole("heading", { name: "Cover letter draft" }).waitFor();
            expect(await mobilePage.locator("#application-draft-content").evaluate((content) => content.scrollTop)).toBe(0);
            await mobilePage.locator("[data-cover-letter-text]").fill("Dear Beta Match,\n\nThis mobile draft is fully editable.\n\nSincerely,\nSample Candidate");
            await mobilePage.screenshot({ path: join(screenshotDirectory, "application-drafts-mobile.png"), animations: "disabled" });
            const mobileLayout = await mobilePage.evaluate(() => {
              const dialog = document.querySelector("#application-draft-dialog");
              const box = dialog?.getBoundingClientRect();
              return {
                viewportWidth: window.innerWidth,
                documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                dialogWidth: box?.width || 0,
                textAreaWidth: document.querySelector("[data-cover-letter-text]")?.getBoundingClientRect().width || 0,
                buttonMinHeight: Math.min(...[...document.querySelectorAll(".application-draft-actions button")].map((button) => button.getBoundingClientRect().height)),
              };
            });
            expect(mobileLayout.dialogWidth).toBe(mobileLayout.viewportWidth);
            expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
            expect(mobileLayout.textAreaWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
            expect(mobileLayout.buttonMinHeight).toBeGreaterThanOrEqual(44);
            await mobilePage.locator("#application-draft-close").focus();
            await mobilePage.keyboard.press("Shift+Tab");
            expect(await mobilePage.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.downloadCoverLetter)).toBe("");
            await mobilePage.keyboard.press("Escape");

            await mobileBeta.locator("button[data-application-draft='resume']").click();
            await expect.poll(() => requests.cancelDraftRequests).toBe(1);
            await mobilePage.keyboard.press("Escape");
            await mobilePage.waitForTimeout(450);
            expect(await mobilePage.locator("#application-draft-dialog").isVisible()).toBe(false);
            expect(await mobilePage.getByRole("heading", { name: "Resume changes" }).isVisible().catch(() => false)).toBe(false);

            await mobileBeta.locator("button[data-application-draft='resume']").click();
            await mobilePage.getByRole("heading", { name: "Rewritten bullets" }).waitFor();
            expect(await mobilePage.locator("#application-draft-content input, #application-draft-content textarea").count()).toBe(0);
            const comparisonLayout = await mobilePage.locator(".resume-change-comparison").first().evaluate((comparison) => {
              const before = comparison.querySelector(".resume-change-original")!.getBoundingClientRect();
              const after = comparison.querySelector(".resume-change-tailored")!.getBoundingClientRect();
              return { beforeBottom: before.bottom, afterTop: after.top, right: comparison.getBoundingClientRect().right, viewportWidth: window.innerWidth };
            });
            expect(comparisonLayout.afterTop).toBeGreaterThanOrEqual(comparisonLayout.beforeBottom);
            expect(comparisonLayout.right).toBeLessThanOrEqual(comparisonLayout.viewportWidth);
            expect(await mobilePage.getByRole("button", { name: "Download tailored resume PDF" }).evaluate((button) => {
              const rect = button.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.height >= 44;
            })).toBe(true);
            await mobilePage.screenshot({ path: join(screenshotDirectory, "resume-changes-mobile.png"), animations: "disabled" });
            const mobilePdfPromise = mobilePage.waitForEvent("download");
            await mobilePage.getByRole("button", { name: "Download tailored resume PDF" }).click();
            await mobilePdfPromise;
            expect(requests.pdfs.at(-1)?.resume).toEqual(updatedResume);
            await mobilePage.keyboard.press("Escape");

            await mobileResumeButton.click();
            await mobilePage.getByText("Active resume", { exact: true }).waitFor();
            expect(await mobileResumeButton.innerText()).toBe("Manage resume");
            expect(await mobileResumeButton.getAttribute("aria-label")).toBe("Manage your resume");
            await mobilePage.locator("#resume-profile-file").setInputFiles({
              name: "mobile-synthetic.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("Synthetic mobile profile review content."),
            });
            await mobilePage.getByText("Extraction ready · review before saving").waitFor();
            await mobilePage.screenshot({ path: join(screenshotDirectory, "application-drafts-profile-mobile.png"), animations: "disabled" });
            await mobilePage.getByRole("button", { name: "Discard draft" }).click();
            expect(await mobilePage.getByText("Active resume", { exact: true }).count()).toBe(1);
            await mobilePage.getByRole("button", { name: "Remove saved resume" }).click();
            await mobilePage.getByRole("group", { name: "Confirm resume removal" }).waitFor();
            await mobilePage.getByRole("button", { name: "Keep resume" }).click();
            expect(requests.profileDeletes).toBe(0);
            await mobilePage.getByRole("button", { name: "Remove saved resume" }).click();
            await mobilePage.getByRole("button", { name: "Remove resume" }).last().click();
            await mobilePage.getByText("No resume saved yet").waitFor();
            expect(await mobilePage.locator("#resume-profile-button").innerText()).toBe("Upload resume");
            expect(requests.profileDeletes).toBe(1);
            expect(await mobilePage.getByText("Saved resume removed.").count()).toBe(1);
            await mobilePage.getByRole("button", { name: "Close your resume" }).click();
            const requestsBeforeMissingProfile = requests.drafts.length;
            await mobileBeta.locator("button[data-application-draft='resume']").click();
            await mobilePage.getByRole("alert").getByText(/resume is not saved yet/i).waitFor();
            expect(await mobilePage.getByText(/global resume control beside Add source/i).count()).toBe(1);
            expect(await mobilePage.locator("#application-draft-content button[data-open-resume-profile]").count()).toBe(0);
            expect(requests.drafts).toHaveLength(requestsBeforeMissingProfile + 1);
          } finally {
            await mobileContext.close();
          }
        } finally {
          await context.close();
        }
      } finally {
        await browser?.close();
        await harness.close();
      }
    },
    60_000,
  );
});
