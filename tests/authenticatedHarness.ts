import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { AuthGateway, AuthGatewayFactory, AuthUser } from "../src/auth/types.js";
import { parseCookies } from "../src/auth/http.js";
import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import type { Internship } from "../src/domain/schemas.js";
import { saveInternshipPreferenceStep } from "../src/preferences/store.js";
import { analyzed, makeInternship } from "./helpers.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_URL = "https://example.test/roleradar-e2e";

export type HarnessSession = "anonymous" | "unverified" | "incomplete" | "complete" | "zero";

interface HarnessUser extends AuthUser {
  session: Exclude<HarnessSession, "anonymous">;
}

interface HarnessResponse {
  response: Response;
  text: string;
}

export interface AuthenticatedHarness {
  readonly baseUrl: string;
  readonly databasePath: string;
  readonly transport: "network" | "in-process";
  readonly sessions: Record<Exclude<HarnessSession, "anonymous">, string>;
  request(path: string, init?: RequestInit): Promise<HarnessResponse>;
  useSession(session: HarnessSession): void;
  sessionCookie(session: Exclude<HarnessSession, "anonymous">): string;
  installAuthFactory(): void;
  close(): Promise<void>;
}

function roleFixture(id: string, overrides: Partial<Internship> = {}): Internship {
  return makeInternship({
    id,
    jobId: `REQ-${id}`,
    sourceUrl: SOURCE_URL,
    sources: [SOURCE_URL],
    applicationUrl: `https://jobs.example.test/${id}/apply`,
    postingUrl: `https://jobs.example.test/${id}`,
    ...overrides,
  });
}

function roles(): Internship[] {
  return [
    roleFixture("match-preferred", {
      company: "Alpha Match",
      title: "Software Engineering Intern",
      categories: ["swe", "frontend"],
      technologies: ["TypeScript", "React"],
      relevanceScore: 98,
    }),
    roleFixture("match-secondary", {
      company: "Beta Match",
      title: "Backend Engineering Intern",
      categories: ["swe", "backend"],
      technologies: ["Python"],
      relevanceScore: 82,
      location: ["Ottawa, ON, Canada"],
      normalizedLocations: [{
        raw: "Ottawa, ON, Canada",
        country: "Canada",
        provinceState: "Ontario",
        city: "Ottawa",
        remote: false,
        remoteScope: null,
      }],
    }),
    roleFixture("match-unknown", {
      company: "Unknown Metadata",
      title: "Software Engineering Intern",
      categories: ["swe"],
      technologies: ["TypeScript"],
      internshipTerm: null,
      internshipYear: null,
      location: ["Remote"],
      normalizedLocations: [{
        raw: "Remote",
        country: null,
        provinceState: null,
        city: null,
        remote: true,
        // The country scope is known, while the posting still omits term and
        // other qualification metadata.  This lets the harness distinguish
        // conservative unknown handling from a genuinely incompatible remote
        // geography in the zero-match fixture.
        remoteScope: "canada",
      }],
      remoteStatus: "remote",
      relevanceScore: 72,
    }),
    roleFixture("match-ineligible", {
      company: "Outside Term",
      title: "Fall Software Engineering Intern",
      internshipTerm: "Fall",
      internshipYear: "2027",
      relevanceScore: 99,
    }),
  ];
}

function crawlResult(jobs: Internship[]): CrawlResult {
  const analyzedJobs = jobs.map(analyzed);
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 1,
    potentialPostingsInspected: jobs.length,
    jobs: analyzedJobs,
    failures: [],
    closedPages: [],
    completedSourceUrls: [SOURCE_URL],
    sourceResults: [{
      sourceUrl: SOURCE_URL,
      pagesVisited: 1,
      potentialPostingsInspected: jobs.length,
      jobs: analyzedJobs,
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
    }],
  };
}

function userFor(session: Exclude<HarnessSession, "anonymous">): HarnessUser {
  const email = `${session}@e2e.example.test`;
  return {
    id: `e2e-${session}-user`,
    email,
    emailVerified: session !== "unverified",
    createdAt: "2026-08-23T12:00:00.000Z",
    session,
  };
}

function gatewayFactory(users: Map<string, HarnessUser>): AuthGatewayFactory {
  return (request): AuthGateway => {
    const session = parseCookies(request).get("rr-e2e-session");
    const user = session ? users.get(session) ?? null : null;
    return {
      async getCurrentUser() { return user; },
      async signUp() { throw new Error("The authenticated harness does not exercise provider signup."); },
      async signIn() { throw new Error("The authenticated harness does not exercise provider login."); },
      async resendVerification() { throw new Error("The authenticated harness does not exercise provider verification."); },
      async requestPasswordReset() { throw new Error("The authenticated harness does not exercise provider recovery."); },
      async verifyToken() { throw new Error("The authenticated harness does not exercise provider callbacks."); },
      async exchangeCode() { throw new Error("The authenticated harness does not exercise provider callbacks."); },
      async updatePassword() { throw new Error("The authenticated harness does not exercise provider recovery."); },
      async signOut() {},
    };
  };
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function setCookieFromHeader(jar: Map<string, string>, header: string): void {
  const pair = header.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) return;
  jar.set(pair.slice(0, separator), pair.slice(separator + 1));
}

function responseSetCookies(response: Response): string[] {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

interface DirectResponseCapture {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

function directRequest(
  url: string,
  method: string,
  headers: Headers,
  body: string,
): IncomingMessage {
  const requestHeaders: Record<string, string> = {};
  for (const [name, value] of headers.entries()) requestHeaders[name.toLocaleLowerCase()] = value;
  const requestBody = body.length > 0 ? Buffer.from(body, "utf8") : null;
  return {
    method,
    url,
    headers: requestHeaders,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (requestBody !== null) yield requestBody;
    },
  } as unknown as IncomingMessage;
}

async function invokeHandlerInProcess(
  handler: (request: IncomingMessage, response: ServerResponse, databasePath: string) => Promise<void>,
  request: IncomingMessage,
  databasePath: string,
): Promise<DirectResponseCapture> {
  let status = 500;
  let headers: Record<string, string | string[]> = {};
  let body = Buffer.alloc(0);
  const responseState = { headersSent: false, writableEnded: false };
  const response = {
    ...responseState,
    writeHead(nextStatus: number, nextHeaders: Record<string, string | string[]> = {}) {
      status = nextStatus;
      headers = nextHeaders;
      responseState.headersSent = true;
    },
    end(nextBody?: Buffer | string) {
      body = nextBody === undefined ? Buffer.alloc(0) : Buffer.from(nextBody);
      responseState.writableEnded = true;
    },
  } as unknown as ServerResponse;
  try {
    await handler(request, response, databasePath);
  } catch (error: unknown) {
    if (!responseState.headersSent && !responseState.writableEnded) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { status, headers, body };
}

function responseFromCapture(capture: DirectResponseCapture): Response {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(capture.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(name, item);
    } else {
      responseHeaders.set(name, value);
    }
  }
  return new Response(capture.body.toString("utf8"), { status: capture.status, headers: responseHeaders });
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body === undefined || body === null) return "";
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}

export async function createAuthenticatedHarness(): Promise<AuthenticatedHarness> {
  const directory = mkdtempSync(join(tmpdir(), "roleradar-authenticated-e2e-"));
  const databasePath = join(directory, "e2e.db");
  const outputDirectory = join(directory, "output");
  const previousEnvironment: Record<string, string | undefined> = {};
  for (const name of [
    "INTERNSHIPMATIC_ROOT",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "AUTH_SITE_URL",
    "DASHBOARD_SKIP_LIVE_BOARD",
    "DASHBOARD_SKIP_STARTUP_SCAN",
    "SCOUT_OUTPUT_DIR",
    "GRIND_JOB_BOARD_CACHE_PATH",
  ]) previousEnvironment[name] = process.env[name];

  process.env.INTERNSHIPMATIC_ROOT = PROJECT_ROOT;
  process.env.SUPABASE_URL = "https://e2e.supabase.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_e2e_test";
  process.env.AUTH_SITE_URL = "http://127.0.0.1";
  process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
  process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
  process.env.SCOUT_OUTPUT_DIR = outputDirectory;
  process.env.GRIND_JOB_BOARD_CACHE_PATH = join(directory, "missing-board-cache.json");

  const users = new Map<Exclude<HarnessSession, "anonymous">, HarnessUser>([
    ["unverified", userFor("unverified")],
    ["incomplete", userFor("incomplete")],
    ["complete", userFor("complete")],
    ["zero", userFor("zero")],
  ]);
  const sessionValues = Object.fromEntries([...users.keys()].map((session) => [session, session])) as Record<Exclude<HarnessSession, "anonymous">, string>;
  const database = new InternshipDatabase(databasePath);
  const settings = resolveSettings({ databasePath, outputDirectory });
  const options: ScoutRunOptions = {
    sources: [SOURCE_URL],
    settings,
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
  const runId = database.startRun(options);
  database.persistRun(runId, crawlResult(roles()), 2);
  database.close();
  // Give the complete-session fixture a real persisted profile. Other
  // sessions intentionally begin with no row so the API exercises its safe
  // default/partial-restore path.
  const completeUser = userFor("complete");
  saveInternshipPreferenceStep(databasePath, completeUser.id, 1, { terms: [{ term: "summer", year: 2027 }] });
  saveInternshipPreferenceStep(databasePath, completeUser.id, 2, {
    countries: ["canada"],
    cities: [{ name: "Toronto", country: "canada" }],
    remote: false,
    roleCategories: ["swe"],
    technologies: ["TypeScript"],
  });
  saveInternshipPreferenceStep(databasePath, completeUser.id, 3, {
    degree: "bachelors",
    graduationYear: 2028,
    graduationYearOrLater: false,
    workAuthorization: { canada: "authorized", unitedStates: null },
    sponsorship: { canada: "none", unitedStates: null },
  });

  // Load the production request handler only after the test root/configuration
  // is set. The test factory is the sole injected dependency; the production
  // entrypoint never calls this helper or sets this factory.
  const dashboard = await import("../src/dashboard.js");
  const handler = dashboard.requestHandler;
  const authFactory = gatewayFactory(users);
  setAuthGatewayFactoryForTests(authFactory);

  let server: ReturnType<typeof createServer> | null = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handler(request, response, databasePath).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) return;
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  let networkTransport = true;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => resolvePromise());
    });
  } catch {
    // Some restricted test runners prohibit loopback listeners. Keep the
    // same production request handler executable through an in-process HTTP
    // adapter; a normal verifier with listener permissions still gets the
    // real ephemeral server above.
    networkTransport = false;
    await new Promise<void>((resolvePromise) => {
      try {
        server?.close(() => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
    server = null;
  }
  const address = networkTransport ? server?.address() : null;
  if (networkTransport && (!address || typeof address === "string")) throw new Error("The authenticated harness did not receive an ephemeral port.");
  const baseUrl = networkTransport ? `http://127.0.0.1:${(address as { port: number }).port}` : "http://127.0.0.1:4173";
  process.env.AUTH_SITE_URL = baseUrl;
  const cookies = new Map<string, string>();
  let closed = false;

  const request = async (path: string, init: RequestInit = {}): Promise<HarnessResponse> => {
    if (closed) throw new Error("The authenticated harness is closed.");
    const headers = new Headers(init.headers);
    if (!headers.has("cookie") && cookies.size > 0) {
      headers.set("cookie", [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", baseUrl);
    const requestUrl = new URL(path, baseUrl);
    const body = requestBodyText(init.body);
    const response = networkTransport
      ? await fetch(requestUrl, { ...init, headers, redirect: "manual" })
      : responseFromCapture(
        await invokeHandlerInProcess(handler, directRequest(requestUrl.toString(), method, headers, body), databasePath),
      );
    for (const cookie of responseSetCookies(response)) setCookieFromHeader(cookies, cookie);
    return { response, text: await response.text() };
  };

  const useSession = (session: HarnessSession): void => {
    if (session === "anonymous") cookies.delete("rr-e2e-session");
    else cookies.set("rr-e2e-session", sessionValues[session]);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    setAuthGatewayFactoryForTests(null);
    dashboard.closeFastRevisionTrackersForTests();
    dashboard.clearFastDashboardCacheForTests();
    if (server !== null) {
      await new Promise<void>((resolvePromise, reject) => {
        server?.close((error) => error ? reject(error) : resolvePromise());
      });
    }
    restoreEnvironment(previousEnvironment);
    rmSync(directory, { recursive: true, force: true });
  };

  return {
    baseUrl,
    databasePath,
    transport: networkTransport ? "network" : "in-process",
    sessions: sessionValues,
    request,
    useSession,
    sessionCookie(session) { return `rr-e2e-session=${sessionValues[session]}`; },
    installAuthFactory() { setAuthGatewayFactoryForTests(authFactory); },
    close,
  };
}
