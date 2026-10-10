import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const publicRoot = resolve("public");
const csrfToken = "synthetic-only-csrf-token";
const accountId = "iab-synthetic-account";
const contract = "scout.browser-helper.v1";
const updatedAt = () => new Date().toISOString();

const state = {
  profile: {
    firstName: "Taylor",
    lastName: "Sample",
    email: "taylor.sample@example.test",
    phone: "+1 416 555 0100",
    phoneType: "Mobile",
    phoneCountryCode: "+1 (Canada)",
    phoneExtension: "",
    address: "100 Example Street",
    city: "Toronto",
    region: "Ontario",
    postalCode: "M5V 1A1",
    country: "Canada",
    linkedin: "https://www.linkedin.com/in/taylor-sample",
    github: "https://github.com/taylor-sample",
    portfolio: "",
    education: [{ school: "Example University", degree: "BSc", fieldOfStudy: "Computer Science", startDate: "Sep 2022", endDate: "Apr 2026" }],
    experience: [{ company: "Sample Labs", title: "Software Intern", startDate: "May 2025", endDate: "Aug 2025", description: "Built a synthetic demo project." }],
    workAuthorization: "",
    requiresSponsorship: "",
    referralSources: ["University career fair", "Employee referral"],
  },
  answers: [
    { id: "synthetic-text", question: "Why are you interested in this role?", answer: "I am interested in the role's sample product work.", answerType: "text", updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "synthetic-boolean", question: "Are you authorized to work in Canada?", answer: "", answerType: "boolean", booleanValue: false, scope: { country: "Canada" }, updatedAt: "2026-10-02T00:00:00.000Z" },
    { id: "synthetic-multi", question: "Which sample options have you reviewed?", answer: "", answerType: "multi-choice", selectedChoices: ["Option Alpha", "Option Beta"], scope: { origin: "https://jobs.example.test" }, updatedAt: "2026-10-03T00:00:00.000Z" },
  ],
  profileUpdatedAt: "2026-10-01T00:00:00.000Z",
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-synthetic-data": "true",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 128_000) {
        rejectBody(new Error("Synthetic harness body limit exceeded."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { rejectBody(new Error("Malformed JSON body.")); }
    });
    request.on("error", rejectBody);
  });
}

function answerScopeKey(answer) {
  const scope = answer?.scope && typeof answer.scope === "object" ? answer.scope : {};
  const normalized = {};
  if (typeof scope.origin === "string" && scope.origin) {
    try { normalized.origin = new URL(scope.origin).origin; }
    catch { normalized.origin = scope.origin; }
  }
  for (const key of ["country", "locale"]) {
    if (typeof scope[key] === "string" && scope[key].trim()) {
      normalized[key] = scope[key].normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
    }
  }
  return JSON.stringify(normalized);
}

function answerIdentity(answer) {
  const question = String(answer?.question ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return `${question}\u0000${answerScopeKey(answer)}`;
}

function sessionHeadersValid(request) {
  return request.headers["x-csrf-token"] === csrfToken
    && request.headers["x-scout-account-id"] === accountId;
}

async function serveStatic(pathname, response) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch {
    response.writeHead(400).end("Invalid path");
    return;
  }
  const filePath = resolve(publicRoot, `.${decodedPath}`);
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const contents = await readFile(filePath);
    const contentType = new Map([
      [".css", "text/css; charset=utf-8"],
      [".js", "text/javascript; charset=utf-8"],
      [".html", "text/html; charset=utf-8"],
      [".png", "image/png"],
      [".svg", "image/svg+xml"],
      [".woff2", "font/woff2"],
    ]).get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-synthetic-data": "true" });
    response.end(contents);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ready: true, syntheticOnly: true, accountId });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    sendJson(response, 200, { configured: true, authenticated: true, csrfToken });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/browser-helper/profile") {
    sendJson(response, 200, {
      contract,
      accountId,
      csrfToken,
      profile: state.profile,
      answers: state.answers,
      updatedAt: state.profileUpdatedAt,
    });
    return;
  }
  if (["PUT", "DELETE"].includes(request.method) && url.pathname.startsWith("/api/browser-helper/") && !sessionHeadersValid(request)) {
    sendJson(response, 403, { error: { message: "Synthetic harness rejected the mutation headers." } });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/browser-helper/profile") {
    try {
      const body = await readBody(request);
      if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
        sendJson(response, 400, { error: { message: "Profile payload must be an object." } });
        return;
      }
      state.profile = body.profile;
      state.profileUpdatedAt = updatedAt();
      sendJson(response, 200, { profile: state.profile, syntheticOnly: true });
    } catch (error) {
      sendJson(response, 400, { error: { message: error instanceof Error ? error.message : "Bad request." } });
    }
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/browser-helper/answers") {
    try {
      const body = await readBody(request);
      if (typeof body.question !== "string" || body.question.trim() === "") {
        sendJson(response, 400, { error: { message: "Answer payload is incomplete." } });
        return;
      }
      const answerType = body.answerType ?? "text";
      if (answerType === "text" && typeof body.answer !== "string") {
        sendJson(response, 400, { error: { message: "Written answers need text." } });
        return;
      }
      const answer = { ...body, answer: body.answer ?? "", answerType, updatedAt: updatedAt() };
      const index = state.answers.findIndex((item) => answerIdentity(item) === answerIdentity(answer));
      if (index >= 0) answer.id = state.answers[index].id;
      else answer.id = `synthetic-answer-${Date.now().toString(36)}`;
      if (index >= 0) state.answers[index] = answer;
      else state.answers.push(answer);
      sendJson(response, 200, { answer, syntheticOnly: true });
    } catch (error) {
      sendJson(response, 400, { error: { message: error instanceof Error ? error.message : "Bad request." } });
    }
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/browser-helper/answers") {
    try {
      const body = await readBody(request);
      const before = state.answers.length;
      state.answers = state.answers.filter((answer) => answer.id !== body.id);
      sendJson(response, 200, { deleted: state.answers.length !== before, id: body.id, syntheticOnly: true });
    } catch (error) {
      sendJson(response, 400, { error: { message: error instanceof Error ? error.message : "Bad request." } });
    }
    return;
  }
  if (request.method === "GET" && (url.pathname === "/browser-helper" || url.pathname === "/browser-helper/")) {
    try {
      let html = await readFile(resolve(publicRoot, "browser-helper.html"), "utf8");
      html = html.replace("<title>Application profile — Scout</title>", "<title>Application profile — Scout · synthetic test</title>");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-synthetic-data": "true" });
      response.end(html);
    } catch {
      response.writeHead(500).end("Could not load the profile editor.");
    }
    return;
  }
  if (request.method === "GET") {
    await serveStatic(url.pathname, response);
    return;
  }
  sendJson(response, 404, { error: { message: "Synthetic route not found." } });
});

const port = Number(process.env.SCOUT_HELPER_IAB_PORT ?? 43871);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Synthetic browser-helper harness ready at http://127.0.0.1:${port}/browser-helper\n`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
