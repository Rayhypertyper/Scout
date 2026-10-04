import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../src/resume/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resume/openai.js")>();
  return { ...actual, generateOpenAIStructuredJson: generate };
});

import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";
import type { AuthGateway, AuthUser } from "../src/auth/types.js";
import { OpenAIApiError } from "../src/resume/openai.js";
import {
  deleteResumeProfile,
  importResumeCandidate,
  MAX_RESUME_UPLOAD_BYTES,
  readResumeProfile,
  resolveResumeProfileIdentity,
  resolveResumeForRequest,
  saveResumeProfile,
  type ResumeProfileCandidate,
} from "../src/resume/profile.js";
import { handleResumeProfileRequest } from "../src/resume/profileHttp.js";

const person: ResumeProfileCandidate = {
  ownerEmail: "source@example.com",
  name: "Morgan Lee",
  contact: ["morgan@example.com", "416-555-0100"],
  education: [{ title: "University of Waterloo", subtitle: "BMath Computer Science", date: "2024–2028", bullets: [] }],
  experience: [{ title: "Software Intern", subtitle: "Northstar Labs", date: "Summer 2025", bullets: ["Built TypeScript services", "Led a team of 12"] }],
  projects: [{ title: "Course Planner", subtitle: "React application", date: "2024", bullets: ["Built a course planner with React"] }],
  awards: ["Dean's List"],
  skills: [{ label: "Languages", items: ["TypeScript", "Python"] }],
};

const plainResume = [
  "Morgan Lee",
  "morgan@example.com | 416-555-0100",
  "University of Waterloo",
  "BMath Computer Science",
  "2024–2028",
  "Software Intern",
  "Northstar Labs",
  "Summer 2025",
  "Built TypeScript services",
  "Course Planner",
  "React application",
  "2024",
  "Built a course planner with React",
  "Dean's List",
  "Languages TypeScript Python",
].join("\n");

function modelResume(): Omit<ResumeProfileCandidate, "ownerEmail"> {
  const candidate: Partial<ResumeProfileCandidate> = { ...person };
  delete candidate.ownerEmail;
  return candidate as Omit<ResumeProfileCandidate, "ownerEmail">;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string | string[]>): void;
  setHeader(name: string, value: string | string[]): void;
  end(body?: Buffer | string): void;
}

function response(): CapturedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

function request(
  url: string,
  options: {
    method?: string;
    host?: string;
    remoteAddress?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): IncomingMessage {
  const body = options.body === undefined
    ? undefined
    : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return {
    method: options.method ?? "GET",
    url,
    headers: { host: options.host ?? "localhost", ...options.headers },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
    once: vi.fn(),
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body;
    },
  } as unknown as IncomingMessage;
}

function parsed(responseValue: CapturedResponse): Record<string, unknown> {
  return JSON.parse(responseValue.body.toString("utf8")) as Record<string, unknown>;
}

function tempDatabase(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "scout-resume-profile-"));
  return { directory, databasePath: join(directory, "scout.db") };
}

const student: AuthUser = {
  id: "student-a",
  email: "student@example.com",
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function configureAuth(user: AuthUser | null | (() => Promise<AuthUser | null>), siteUrl = "https://scout.example"): void {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubEnv("AUTH_SITE_URL", siteUrl);
  setAuthGatewayFactoryForTests(() => ({
    getCurrentUser: typeof user === "function" ? user : async () => user,
  }) as AuthGateway);
}

afterEach(() => {
  vi.unstubAllEnvs();
  setAuthGatewayFactoryForTests(null);
  generate.mockReset();
});

describe("resume profile import and storage", () => {
  it("extracts reviewable text candidates, removes unsupported values, and leaves the profile inactive", async () => {
    const { directory, databasePath } = tempDatabase();
    generate.mockResolvedValue(modelResume());
    try {
      const imported = await importResumeCandidate({
        filename: "../../Morgan.txt",
        contentType: "text/plain; charset=utf-8",
        data: Buffer.from(plainResume).toString("base64"),
      }, "signed-in@example.com");
      expect(imported.filename).toBe("Morgan.txt");
      expect(imported.resume.ownerEmail).toBe("signed-in@example.com");
      expect(imported.resume.experience[0]?.bullets).toEqual(["Built TypeScript services"]);
      expect(imported.warnings.join(" ")).toContain("full text");
      expect(imported.warnings.join(" ")).toContain("Experience 1 bullet 2");
      expect(readResumeProfile(databasePath, "student-a")).toBeNull();
      const requestPayload = generate.mock.calls[0]?.[0] as { schema: { properties?: Record<string, unknown> }; parts: Array<{ text?: string }> } | undefined;
      expect(requestPayload?.parts[0]?.text).toContain("untrusted source text");
      expect(requestPayload?.schema.properties?.name).toEqual({ type: "string" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sends only signature-validated PDF bytes as an OpenAI file input and warns the full document is sent", async () => {
    const pdf = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
    generate.mockResolvedValue(modelResume());
    const imported = await importResumeCandidate({
      filename: "Morgan.pdf",
      contentType: "application/pdf",
      data: pdf.toString("base64"),
    }, "student@example.com");
    const payload = generate.mock.calls[0]?.[0] as { parts: Array<{ type: string; filename?: string; file_data?: string }> } | undefined;
    expect(payload?.parts[1]).toEqual({ type: "input_file", filename: "Morgan.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` });
    expect(imported.warnings.join(" ")).toContain("full uploaded PDF is sent");
    expect(imported.warnings.join(" ")).toContain("not saved");
  });

  it("rejects unsupported files, malformed base64, fake PDFs, and oversize uploads before calling OpenAI", async () => {
    await expect(importResumeCandidate({ filename: "resume.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: "abcd" }, "student@example.com"))
      .rejects.toMatchObject({ status: 415 });
    await expect(importResumeCandidate({ filename: "resume.txt", contentType: "text/plain", data: "abcd!" }, "student@example.com"))
      .rejects.toMatchObject({ status: 400 });
    const fakePdfError = await importResumeCandidate({ filename: "resume.pdf", contentType: "application/pdf", data: Buffer.from("not pdf!!").toString("base64") }, "student@example.com")
      .then(() => undefined, (error: unknown) => error);
    expect(fakePdfError).toMatchObject({ status: 400 });
    if (fakePdfError instanceof Error) expect(fakePdfError.message).toContain("PDF signature");
    const oversizedBase64 = "A".repeat(Math.ceil(MAX_RESUME_UPLOAD_BYTES / 3) * 4 + 4);
    await expect(importResumeCandidate({ filename: "huge.pdf", contentType: "application/pdf", data: oversizedBase64 }, "student@example.com"))
      .rejects.toMatchObject({ status: 413 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("stores only validated reviewed content under its account ID and supports load, update, and delete", () => {
    const { directory, databasePath } = tempDatabase();
    try {
      const saved = saveResumeProfile(databasePath, "student-a", "student@example.com", person, "../../Morgan.pdf", new Date("2026-10-01T12:00:00.000Z"));
      expect(saved.resume.ownerEmail).toBe("student@example.com");
      expect(saved.filename).toBe("Morgan.pdf");
      expect(readResumeProfile(databasePath, "student-a")).toEqual(saved);
      expect(readResumeProfile(databasePath, "student-b")).toBeNull();
      expect(() => saveResumeProfile(databasePath, "student-a", "student@example.com", { ...person, education: [] }, "Morgan.pdf"))
        .toThrowError(expect.objectContaining({ status: 422 }));
      saveResumeProfile(databasePath, "student-a", "student@example.com", { ...person, name: "Updated Morgan" }, "updated.pdf");
      expect(readResumeProfile(databasePath, "student-a")?.resume.name).toBe("Updated Morgan");
      deleteResumeProfile(databasePath, "student-a");
      expect(readResumeProfile(databasePath, "student-a")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("resume profile API", () => {
  it("keeps local profile import inactive until reviewed save, then supports retrieval and deletion", async () => {
    const { directory, databasePath } = tempDatabase();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("AUTH_SITE_URL", "");
    generate.mockResolvedValue(modelResume());
    try {
      const upload = request("/api/resume-profile/import", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: { filename: "Morgan.txt", contentType: "text/plain", data: Buffer.from(plainResume).toString("base64") },
      });
      const importedResponse = response();
      expect(await handleResumeProfileRequest(upload, importedResponse as unknown as ServerResponse, databasePath)).toBe(true);
      expect(importedResponse.statusCode).toBe(200);
      expect(importedResponse.headers["Cache-Control"]).toContain("private, no-store");
      expect(readResumeProfile(databasePath, "local:private")).toBeNull();
      const candidate = parsed(importedResponse).resume as ResumeProfileCandidate;

      const saveResponse = response();
      await handleResumeProfileRequest(request("/api/resume-profile", {
        method: "PUT",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: { resume: candidate, filename: "Morgan.txt" },
      }), saveResponse as unknown as ServerResponse, databasePath);
      expect(saveResponse.statusCode).toBe(200);
      expect((parsed(saveResponse).profile as { resume: ResumeProfileCandidate }).resume.ownerEmail).toBe("local@localhost.invalid");

      const getResponse = response();
      await handleResumeProfileRequest(request("/api/resume-profile"), getResponse as unknown as ServerResponse, databasePath);
      expect((parsed(getResponse).profile as { filename: string }).filename).toBe("Morgan.txt");

      const deleteResponse = response();
      await handleResumeProfileRequest(request("/api/resume-profile", { method: "DELETE", headers: { origin: "http://localhost" } }), deleteResponse as unknown as ServerResponse, databasePath);
      expect(parsed(deleteResponse)).toEqual({ profile: null });
      expect(readResumeProfile(databasePath, "local:private")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses an authenticated local account ahead of the shared local identity and isolates account reads", async () => {
    const { directory, databasePath } = tempDatabase();
    const localProfile = saveResumeProfile(databasePath, "local:private", "local@localhost.invalid", { ...person, name: "Local Resume" }, "local.pdf");
    const studentProfile = saveResumeProfile(databasePath, student.id, student.email, { ...person, name: "Student Resume" }, "student.pdf");
    try {
      vi.stubEnv("NODE_ENV", "test");
      configureAuth(student, "http://localhost");
      const signedInResponse = response();
      const signedIn = await resolveResumeProfileIdentity(request("/api/resume-profile"), signedInResponse as unknown as ServerResponse);
      expect(signedIn.local).toBe(false);
      expect(readResumeProfile(databasePath, signedIn.userId)).toEqual(studentProfile);
      expect(readResumeProfile(databasePath, signedIn.userId)).not.toEqual(localProfile);

      configureAuth({ ...student, id: "student-b", email: "other@example.com" }, "https://scout.example");
      const otherResponse = response();
      const other = await resolveResumeProfileIdentity(request("/api/resume-profile", { host: "scout.example", remoteAddress: "192.0.2.40" }), otherResponse as unknown as ServerResponse);
      expect(readResumeProfile(databasePath, other.userId)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose the legacy owner's base resume to a signed-in non-owner on localhost", async () => {
    const { directory, databasePath } = tempDatabase();
    const baseResume = { ...person, ownerEmail: "owner@example.com", name: "Private Owner Resume" };
    const basePath = join(directory, "base.json");
    writeFileSync(basePath, JSON.stringify(baseResume), { mode: 0o600 });
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RESUME_BASE_PATH", basePath);
    vi.stubEnv("RESUME_OWNER_USER_ID", "");
    configureAuth(student, "http://localhost");
    try {
      const token = "a".repeat(43);
      const req = request("/api/application-drafts/coop/123", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie: `rr-csrf=${token}`,
          "x-csrf-token": token,
        },
      });
      let returned: unknown;
      let caught: unknown;
      try {
        returned = await resolveResumeForRequest(req, response() as unknown as ServerResponse, databasePath);
      } catch (error) {
        caught = error;
      }
      expect(returned).toBeUndefined();
      expect(caught).toMatchObject({ status: 404, message: "Your resume is not saved yet. Upload and save it before generating an application draft." });
      expect(String(caught)).not.toContain("Private Owner Resume");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a CSRF token on authenticated GET and rejects mutations without it", async () => {
    const { directory, databasePath } = tempDatabase();
    configureAuth(student);
    try {
      const getResponse = response();
      await handleResumeProfileRequest(request("/api/resume-profile", { host: "scout.example", remoteAddress: "192.0.2.40", headers: { origin: "https://scout.example" } }), getResponse as unknown as ServerResponse, databasePath);
      const token = parsed(getResponse).csrfToken;
      expect(typeof token).toBe("string");
      expect(String(getResponse.headers["Set-Cookie"])).toContain("rr-csrf=");
      expect(getResponse.headers["Cache-Control"]).toContain("private, no-store");

      const rejected = response();
      await handleResumeProfileRequest(request("/api/resume-profile", {
        method: "PUT", host: "scout.example", remoteAddress: "192.0.2.40",
        headers: { origin: "https://scout.example", "content-type": "application/json" },
        body: { resume: person, filename: "Morgan.pdf" },
      }), rejected as unknown as ServerResponse, databasePath);
      expect(rejected.statusCode).toBe(403);
      expect(readResumeProfile(databasePath, student.id)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to a local profile when the configured auth provider fails", async () => {
    const { directory, databasePath } = tempDatabase();
    saveResumeProfile(databasePath, "local:private", "local@localhost.invalid", { ...person, name: "Private Local Resume" }, "local.pdf");
    configureAuth(async () => { throw new Error("private provider details"); }, "http://localhost");
    try {
      const result = response();
      await handleResumeProfileRequest(request("/api/resume-profile"), result as unknown as ServerResponse, databasePath);
      expect(result.statusCode).toBe(503);
      expect(result.body.toString()).not.toContain("Private Local Resume");
      expect(result.body.toString()).not.toContain("private provider details");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps provider configuration and structured-output failures to safe private JSON", async () => {
    const { directory, databasePath } = tempDatabase();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("AUTH_SITE_URL", "");
    generate.mockRejectedValue(new OpenAIApiError(503, "OpenAI drafting is not configured. Set OPENAI_API_KEY on the server, then restart Scout."));
    try {
      const result = response();
      await handleResumeProfileRequest(request("/api/resume-profile/import", {
        method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
        body: { filename: "Morgan.txt", contentType: "text/plain", data: Buffer.from(plainResume).toString("base64") },
      }), result as unknown as ServerResponse, databasePath);
      expect(result.statusCode).toBe(503);
      expect(parsed(result).error).toContain("OPENAI_API_KEY");
      expect(result.headers["Cache-Control"]).toContain("private, no-store");
      expect(readResumeProfile(databasePath, "local:private")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
