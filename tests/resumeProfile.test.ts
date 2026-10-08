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

interface ResumeFact {
  value: string;
  quote: string;
}

function fact(value: string, quote = value): ResumeFact {
  return { value, quote };
}

function modelEvidenceResume(
  candidate = modelResume(),
  quoteFor: (path: string, value: string) => string = (_path, value) => value,
): { model: Record<string, unknown>; source: string } {
  const quotes: string[] = [];
  const evidence = (path: string, value: string): ResumeFact => {
    const quote = quoteFor(path, value);
    quotes.push(quote);
    return fact(value, quote);
  };
  const model = {
    name: evidence("name", candidate.name),
    contact: candidate.contact.map((item, index) => evidence(`contact ${index + 1}`, item)),
    education: candidate.education.map((entry, index) => ({
      title: evidence(`education ${index + 1} title`, entry.title),
      subtitle: evidence(`education ${index + 1} subtitle`, entry.subtitle),
      date: evidence(`education ${index + 1} date`, entry.date),
      bullets: entry.bullets.map((item, bulletIndex) => evidence(`education ${index + 1} bullet ${bulletIndex + 1}`, item)),
    })),
    experience: candidate.experience.map((entry, index) => ({
      title: evidence(`experience ${index + 1} title`, entry.title),
      subtitle: evidence(`experience ${index + 1} subtitle`, entry.subtitle),
      date: evidence(`experience ${index + 1} date`, entry.date),
      bullets: entry.bullets.map((item, bulletIndex) => evidence(`experience ${index + 1} bullet ${bulletIndex + 1}`, item)),
    })),
    projects: candidate.projects.map((entry, index) => ({
      title: evidence(`project ${index + 1} title`, entry.title),
      subtitle: evidence(`project ${index + 1} subtitle`, entry.subtitle),
      date: evidence(`project ${index + 1} date`, entry.date),
      bullets: entry.bullets.map((item, bulletIndex) => evidence(`project ${index + 1} bullet ${bulletIndex + 1}`, item)),
    })),
    awards: candidate.awards.map((item, index) => evidence(`award ${index + 1}`, item)),
    skills: candidate.skills.map((group, index) => ({
      label: evidence(`skill group ${index + 1} label`, group.label),
      items: group.items.map((item, itemIndex) => evidence(`skill group ${index + 1} item ${itemIndex + 1}`, item)),
    })),
  };
  return { model, source: quotes.join("\n") };
}

function textUpload(filename: string, source: string) {
  return {
    filename,
    contentType: "text/plain",
    data: Buffer.from(source).toString("base64"),
  };
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
    generate.mockResolvedValue(modelEvidenceResume().model);
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
      const requestPayload = generate.mock.calls[0]?.[0] as {
        systemInstruction: string;
        schema: { properties?: Record<string, unknown> };
        parts: Array<{ text?: string }>;
      } | undefined;
      expect(requestPayload?.parts[0]?.text).toContain("untrusted source text");
      expect(requestPayload?.systemInstruction).toContain("quote");
      expect(requestPayload?.schema.properties?.name).toMatchObject({ type: "object" });
      expect(imported.resume).not.toHaveProperty("evidence");
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
    const payload = generate.mock.calls[0]?.[0] as {
      parts: Array<{ type: string; filename?: string; file_data?: string }>;
      schema: { properties?: Record<string, unknown> };
    } | undefined;
    expect(payload?.parts[1]).toEqual({ type: "input_file", filename: "Morgan.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` });
    expect(payload?.schema.properties?.name).toEqual({ type: "string" });
    expect(imported.warnings.join(" ")).toContain("full uploaded PDF is sent");
    expect(imported.warnings.join(" ")).toContain("not saved");
  });

  it("keeps extracted value and quote text within local resume field limits", async () => {
    const oversizedValue = "A".repeat(2_001);
    const model = modelEvidenceResume().model;
    model.name = fact(oversizedValue, oversizedValue);
    generate.mockResolvedValue(model);

    await expect(importResumeCandidate(textUpload("long.txt", oversizedValue), "candidate@example.invalid"))
      .rejects.toMatchObject({ status: 422 });
  });

  it("bounds exact source quote text in the local importer", async () => {
    const oversizedQuote = `Name: Morgan Lee\n${"x".repeat(4_000)}`;
    const model = modelEvidenceResume().model;
    model.name = fact("Morgan Lee", oversizedQuote);
    generate.mockResolvedValue(model);

    await expect(importResumeCandidate(textUpload("long-quote.txt", oversizedQuote), "candidate@example.invalid"))
      .rejects.toMatchObject({ status: 422 });
  });

  it("accepts exact wrapped quotes for normalized title, date, and bullet variants", async () => {
    const source = [
      "Riley Chen",
      "riley@example.com",
      "University of Waterloo",
      "Computer Science",
      "2024 - 2028",
      "Software Developer\nNokia",
      "Nokia",
      "May 2025 - Aug 2025",
      "Built develop-\nment tools",
      "Improved open-\nsource libraries",
      "Dean's List",
      "Languages TypeScript C++",
      "Skills:\nPython",
    ].join("\n");
    const candidate: Omit<ResumeProfileCandidate, "ownerEmail"> = {
      name: "Riley Chen",
      contact: ["riley@example.com"],
      education: [{ title: "University of Waterloo", subtitle: "Computer Science", date: "2024–2028", bullets: [] }],
      experience: [{
        title: "Software Developer, Nokia",
        subtitle: "Nokia",
        date: "May 2025 – Aug 2025",
        bullets: ["Built development tools", "Improved open-source libraries"],
      }],
      projects: [],
      awards: ["Dean's List"],
      skills: [{ label: "Languages", items: ["TypeScript", "C++", "Python"] }],
    };
    const evidence = modelEvidenceResume(candidate);
    const evidenceModel = evidence.model as {
      education: Array<{ date: ResumeFact }>;
      experience: Array<{ title: ResumeFact; date: ResumeFact; bullets: ResumeFact[] }>;
    };
    evidenceModel.education[0]!.date = fact("2024–2028", "2024 - 2028");
    evidenceModel.experience[0]!.title = fact("Software Developer, Nokia", "Software Developer\nNokia");
    evidenceModel.experience[0]!.date = fact("May 2025 – Aug 2025", "May 2025 - Aug 2025");
    evidenceModel.experience[0]!.bullets = [
      fact("Built development tools", "Built develop-\nment tools"),
      fact("Improved open-source libraries", "Improved open-\nsource libraries"),
    ];
    const evidenceSkills = evidence.model.skills as Array<{ items: ResumeFact[] }>;
    evidenceSkills[0]!.items[2] = fact("Python", "Skills: Python");
    generate.mockResolvedValue(evidence.model);

    const imported = await importResumeCandidate(textUpload("Riley.txt", source), "riley@example.com");

    expect(imported.resume.education[0]?.date).toBe("2024–2028");
    expect(imported.resume.experience).toEqual(candidate.experience);
    expect(imported.resume.skills).toEqual([{ label: "Languages", items: ["TypeScript", "C++"] }]);
    expect(imported.warnings.join(" ")).toContain("skill group 1 item 3");
  });

  it("drops fabricated or unrelated facts while retaining an incomplete entry and supported sibling fields", async () => {
    const source = [
      "Morgan Lee",
      "morgan@example.com",
      "Northstar Labs",
      "Software Intern",
      "Summer 2025",
      "Built TypeScript services",
      "Dean's List",
      "Languages TypeScript",
      "morgan+jobs@example.com",
      "Handled 1.2 million requests",
      "Reduced latency by 12%",
      "Signed a +$2.5M contract",
      "Built C++ and C# clients with .NET, Node.js, and R",
      "Built a Q# quantum simulator",
      "F#",
    ].join("\n");
    const candidate: Omit<ResumeProfileCandidate, "ownerEmail"> = {
      name: "Jordan Kim",
      contact: ["morgan@example.com", "morgan@example.com"],
      education: [],
      experience: [{
        title: "Senior Software Manager",
        subtitle: "Northstar Labs",
        date: "Summer 2025",
        bullets: [
          "Built TypeScript services",
          "Increased throughput to 1.3 million requests",
          "Reduced latency by 120%",
          "Signed a $2.5M contract",
          "Built C and C# clients with .NET, Node.js, and R",
          "Built a Q quantum simulator",
        ],
      }],
      projects: [],
      awards: ["National Tech Prize"],
      skills: [{ label: "Languages", items: ["Rust", "F", "F#"] }],
    };
    const model = modelEvidenceResume(candidate).model;
    model.name = fact("Jordan Kim", "Morgan Lee");
    model.contact = [
      fact("morgan@example.com", "morgan+jobs@example.com"),
      fact("morgan@example.com", "not present in this resume"),
    ];
    const experience = (model.experience as Array<Record<string, unknown>>)[0]!;
    experience.title = fact("Senior Software Manager", "Software Intern");
    experience.date = fact("Summer 2025", "Summer 2025");
    experience.bullets = [
      fact("Built TypeScript services", "Built TypeScript services"),
      fact("Increased throughput to 1.3 million requests", "Handled 1.2 million requests"),
      fact("Reduced latency by 120%", "Reduced latency by 12%"),
      fact("Signed a $2.5M contract", "Signed a +$2.5M contract"),
      fact("Built C and C# clients with .NET, Node.js, and R", "Built C++ and C# clients with .NET, Node.js, and R"),
      fact("Built a Q quantum simulator", "Built a Q# quantum simulator"),
    ];
    model.awards = [fact("National Tech Prize", "Dean's List")];
    model.skills = [{
      label: fact("Languages"),
      items: [fact("Rust", "TypeScript"), fact("F", "F#"), fact("F#", "F#")],
    }];
    generate.mockResolvedValue(model);

    const imported = await importResumeCandidate(textUpload("Morgan.txt", source), "signed-in@example.com");

    expect(imported.resume.ownerEmail).toBe("signed-in@example.com");
    expect(imported.resume.name).toBe("");
    expect(imported.resume.contact).toEqual([]);
    expect(imported.resume.experience).toEqual([{
      title: "",
      subtitle: "Northstar Labs",
      date: "Summer 2025",
      bullets: ["Built TypeScript services"],
    }]);
    expect(imported.resume.awards).toEqual([]);
    expect(imported.resume.skills).toEqual([{ label: "Languages", items: ["F#"] }]);
    expect(imported.warnings.join(" ")).toContain("name");
    expect(imported.warnings.join(" ")).toContain("Experience 1 title");
    expect(imported.warnings.join(" ")).not.toContain("Experience 1 dates");
    expect(imported.warnings.join(" ")).toContain("contact details");
    expect(imported.warnings.join(" ")).toContain("award 1");
    expect(imported.warnings.join(" ")).toContain("skill group 1 item 1");
    expect(imported.warnings.join(" ")).toContain("skill group 1 item 2");
  });

  it("preserves URL path case when matching an exact source quote", async () => {
    const source = [
      "Morgan Lee",
      "(https://example.com/cv)",
      "https://example.com/cv(2)",
      "https://example.com/cv/2024-2028",
    ].join("\n");
    const literalUrl = "https://example.com/cv";
    const parenthesizedPathUrl = "https://example.com/cv(2)";
    const literalDatePathUrl = "https://example.com/cv/2024-2028";
    const candidate: Omit<ResumeProfileCandidate, "ownerEmail"> = {
      name: "Morgan Lee",
      contact: [
        literalUrl,
        "https://example.com/CV",
        "HTTPS://EXAMPLE.COM/cv",
        parenthesizedPathUrl,
        literalUrl,
        literalDatePathUrl,
        "https://example.com/cv/2024–2028",
      ],
      education: [],
      experience: [],
      projects: [],
      awards: [],
      skills: [],
    };
    const model = modelEvidenceResume(candidate).model;
    model.contact = [
      fact(literalUrl, `(${literalUrl})`),
      fact("https://example.com/CV", "(https://example.com/cv)"),
      fact("HTTPS://EXAMPLE.COM/cv", literalUrl),
      fact(parenthesizedPathUrl, parenthesizedPathUrl),
      fact(literalUrl, parenthesizedPathUrl),
      fact(literalDatePathUrl, literalDatePathUrl),
      fact("https://example.com/cv/2024–2028", literalDatePathUrl),
    ];
    generate.mockResolvedValue(model);

    const imported = await importResumeCandidate(textUpload("Morgan.txt", source), "morgan@example.com");

    expect(imported.resume.contact).toEqual([literalUrl, "HTTPS://EXAMPLE.COM/cv", parenthesizedPathUrl, literalDatePathUrl]);
    expect(imported.warnings.join(" ")).toContain("contact detail 2");
    expect(imported.warnings.join(" ")).toContain("contact detail 5");
    expect(imported.warnings.join(" ")).toContain("contact detail 7");
  });

  it("preserves currency and Unicode minus signs when checking numeric quote tokens", async () => {
    const source = [
      "Morgan Lee",
      "Software Intern",
      "Northstar Labs",
      "Summer 2025",
      "Amount: ¥500",
      "Amount: 500",
      "Cost: −2.5",
      "Change: 5%",
      "Change: −5%",
    ].join("\n");
    const candidate: Omit<ResumeProfileCandidate, "ownerEmail"> = {
      name: "Morgan Lee",
      contact: [],
      education: [],
      experience: [{
        title: "Software Intern",
        subtitle: "Northstar Labs",
        date: "Summer 2025",
        bullets: [
          "Amount: 500",
          "Amount: ¥500",
          "Amount: ¥500",
          "Cost: 2.5",
          "Change: 5%",
          "Change: −5%",
          "Change: −5%",
        ],
      }],
      projects: [],
      awards: [],
      skills: [],
    };
    const model = modelEvidenceResume(candidate).model;
    const experience = (model.experience as Array<Record<string, unknown>>)[0]!;
    experience.bullets = [
      fact("Amount: 500", "Amount: ¥500"),
      fact("Amount: ¥500", "Amount: 500"),
      fact("Amount: ¥500", "Amount: ¥500"),
      fact("Cost: 2.5", "Cost: −2.5"),
      fact("Change: 5%", "Change: −5%"),
      fact("Change: −5%", "Change: 5%"),
      fact("Change: −5%", "Change: −5%"),
    ];
    generate.mockResolvedValue(model);

    const imported = await importResumeCandidate(textUpload("Morgan.txt", source), "morgan@example.com");

    expect(imported.resume.experience[0]?.bullets).toEqual(["Amount: ¥500", "Change: −5%"]);
    expect(imported.warnings.join(" ")).toContain("Experience 1 bullet 1");
    expect(imported.warnings.join(" ")).toContain("Experience 1 bullet 2");
    expect(imported.warnings.join(" ")).toContain("Experience 1 bullet 4");
    expect(imported.warnings.join(" ")).toContain("Experience 1 bullet 5");
    expect(imported.warnings.join(" ")).toContain("Experience 1 bullet 6");
  });

  it("strips raw quote evidence from the API candidate and the saved profile", async () => {
    const { directory, databasePath } = tempDatabase();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("AUTH_SITE_URL", "");
    const labeled = modelEvidenceResume(modelResume(), (path, value) => `${path}: ${value}`);
    generate.mockResolvedValue(labeled.model);
    try {
      const result = response();
      await handleResumeProfileRequest(request("/api/resume-profile/import", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: textUpload("Morgan.txt", labeled.source),
      }), result as unknown as ServerResponse, databasePath);
      expect(result.statusCode).toBe(200);
      const serializedResponse = result.body.toString("utf8");
      expect(serializedResponse).not.toContain("name: Morgan Lee");
      expect(serializedResponse).not.toContain("contact 1: morgan@example.com");
      const returnedCandidate = (parsed(result).resume as ResumeProfileCandidate);
      expect(returnedCandidate).not.toHaveProperty("evidence");
      expect(returnedCandidate.name).toBe("Morgan Lee");

      const save = response();
      await handleResumeProfileRequest(request("/api/resume-profile", {
        method: "PUT",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: { resume: returnedCandidate, filename: "Morgan.txt" },
      }), save as unknown as ServerResponse, databasePath);
      expect(save.statusCode).toBe(200);
      const stored = readResumeProfile(databasePath, "local:private");
      expect(stored?.resume).not.toHaveProperty("evidence");
      expect(JSON.stringify(stored)).not.toContain("name: Morgan Lee");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    generate.mockResolvedValue(modelEvidenceResume().model);
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
