import { openAIEnvelope } from "./helpers/openaiResponse.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeRawJob } from "../src/classification/analyzeJob.js";
import { OpenAIJobFallback } from "../src/llm/openaiJobFallback.js";
import type { PageSnapshot, RawJob } from "../src/domain/types.js";

const temporaryDirectories: string[] = [];
const testApiKey = "fixture-key-must-not-enter-audit";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Fact {
  value: string;
  quote: string;
}

interface Candidate {
  title: Fact | null;
  company: Fact | null;
  description: Fact | null;
  salary: Fact | null;
  postingDate: Fact | null;
  deadline: Fact | null;
  internshipTerm: Fact | null;
  internshipYear: Fact | null;
  duration: Fact | null;
  applicationUrl: Fact | null;
  jobId: Fact | null;
  locations: Fact[];
  responsibilities: Fact[];
  requiredQualifications: Fact[];
  preferredQualifications: Fact[];
}

function fact(value: string, quote = value): Fact {
  return { value, quote };
}

function candidateFor(
  title: string,
  company: string,
  description: string,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    title: fact(title),
    company: fact(company),
    description: fact(description),
    salary: null,
    postingDate: null,
    deadline: null,
    internshipTerm: null,
    internshipYear: null,
    duration: null,
    applicationUrl: null,
    jobId: null,
    locations: [],
    responsibilities: [],
    requiredQualifications: [],
    preferredQualifications: [],
    ...overrides,
  };
}

function roleText(title = "Software Engineering Intern", company = "Northstar Labs", suffix = ""): string {
  return [
    title,
    company,
    "Job description",
    `As a ${title} at ${company}, you will develop and test production software services using Python and TypeScript.`,
    "Responsibilities",
    "Build and maintain software tools used by customers.",
    "Qualifications",
    "Must be currently pursuing a Computer Science degree.",
    "Location: Toronto, Ontario, Canada",
    suffix,
  ].filter(Boolean).join("\n");
}

function page(text: string, name = "role-100", links: PageSnapshot["links"] = []): PageSnapshot {
  const url = `https://careers.northstar.example/jobs/${name}`;
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "text/html; charset=utf-8",
    title: "Careers | Northstar Labs",
    html: `<main>${text}</main>`,
    text,
    links,
    fetchedAt: "2026-10-01T12:00:00.000Z",
  };
}

function response(candidate: Candidate): Response {
  return new Response(JSON.stringify({
    ...openAIEnvelope({ jobs: [candidate] }),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function fallback(
  outputDirectory: string,
  fetchImpl: typeof fetch,
): OpenAIJobFallback {
  return new OpenAIJobFallback({
    outputDirectory,
    env: { OPENAI_API_KEY: testApiKey, SCOUT_LLM_MODEL: "openai-test-model" },
    fetchImpl,
  });
}

function outputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-llm-adversarial-"));
  temporaryDirectories.push(directory);
  return directory;
}

function recordedAudit(directory: string): Array<Record<string, unknown>> {
  const lines = readFileSync(join(directory, "parser-misses.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function roleCandidate(text: string, extras: Partial<Candidate> = {}): Candidate {
  return candidateFor("Software Engineering Intern", "Northstar Labs", text, {
    locations: [fact("Toronto, Ontario, Canada", "Location: Toronto, Ontario, Canada")],
    responsibilities: [fact("Build and maintain software tools used by customers.")],
    requiredQualifications: [fact("Must be currently pursuing a Computer Science degree.")],
    ...extras,
  });
}

describe("OpenAI fallback adversarial validation", () => {
  it("fills gaps on a known role without changing deterministic identity or omitting an allowed apply link", async () => {
    const applyUrl = "https://boards.greenhouse.io/northstar/jobs/100/apply";
    const text = `${roleText()}\nPay: $42 per hour\nApply now: ${applyUrl}`;
    const snapshot = page(text, "role-100", [{ url: applyUrl, text: "Apply now", rel: "" }]);
    const deterministic: RawJob = {
      company: "Northstar Labs",
      title: "Software Engineering Intern",
      locations: ["Toronto, Ontario, Canada"],
      // Deliberately omit the pay/apply lines captured in the full page text so
      // this exercises fallback recovery instead of deterministic backfill.
      description: roleText(),
      postingUrl: snapshot.url,
      sourceProvider: "greenhouse",
    };
    const generated = roleCandidate(text, {
      salary: fact("$42 per hour", "Pay: $42 per hour"),
      applicationUrl: fact(applyUrl, `Apply now: ${applyUrl}`),
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [deterministic], snapshot.url);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      company: deterministic.company,
      title: deterministic.title,
      description: deterministic.description,
      salary: "$42 per hour",
      applicationUrl: applyUrl,
    });
    expect(recovered[0]?.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "salary", value: "$42 per hour", quote: "Pay: $42 per hour" }),
      expect.objectContaining({ field: "applicationUrl", value: applyUrl, quote: `Apply now: ${applyUrl}` }),
    ]));
  });

  it("does not expose recovered fields when the required audit append fails", async () => {
    const text = `${roleText()}\nPay: $42 per hour`;
    const snapshot = page(text, "audit-write-failure");
    const deterministic: RawJob = {
      company: "Northstar Labs",
      title: "Software Engineering Intern",
      description: roleText(),
      postingUrl: snapshot.url,
      sourceProvider: "greenhouse",
    };
    const generated = roleCandidate(text, { salary: fact("$42 per hour", "Pay: $42 per hour") });
    const service = new OpenAIJobFallback({
      outputDirectory: outputDirectory(),
      env: { OPENAI_API_KEY: testApiKey, SCOUT_LLM_MODEL: "openai-test-model" },
      fetchImpl: async () => response(generated),
      auditWriter: async () => { throw new Error("disk write failed"); },
    });

    await expect(service.recover(snapshot, [deterministic], snapshot.url)).resolves.toEqual([deterministic]);
  });

  it("does not turn an expected graduation year into the internship year", async () => {
    const passage = roleText("Software Engineering Intern", "Northstar Labs", "Expected graduation: 2028");
    const text = `${passage}\nApply now`;
    const snapshot = page(text, "graduation-year");
    const generated = roleCandidate(passage, {
      internshipYear: fact("2028", "Expected graduation: 2028"),
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.internshipYear).toBeUndefined();
  });

  it("does not treat a copyright footer as a posting date", async () => {
    const passage = roleText("Software Engineering Intern", "Northstar Labs", "Posted by Northstar Recruiting\nCopyright 2025-06-14");
    const text = `${passage}\nApply now`;
    const snapshot = page(text, "copyright-date");
    const generated = roleCandidate(passage, {
      postingDate: fact("2025-06-14", "Copyright 2025-06-14"),
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.postingDate).toBeUndefined();
  });

  it("rejects unsupported and vague compensation values instead of attaching a nearby dollar field", async () => {
    const passage = `${roleText()}\nCompensation is competitive.`;
    const text = `${passage}\nApply now`;
    const snapshot = page(text, "vague-salary");
    const generated = roleCandidate(passage, {
      salary: fact("Competitive", "Compensation is competitive."),
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered[0]?.salary).toBeUndefined();
    expect((recovered[0]?.provenance ?? []).some((item) => item.field === "salary")).toBe(false);
  });

  it("does not collapse contradictory return-to-school statements into a required qualification", async () => {
    const passage = `${roleText()}\nMust return to school after the internship.\nStudents are not required to return to school after this internship.`;
    const text = `${passage}\nApply now`;
    const snapshot = page(text, "contradictory-qualification");
    const generated = roleCandidate(passage, {
      requiredQualifications: [fact("Must return to school after the internship.")],
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered[0]?.requiredQualifications).toBeUndefined();
    expect((recovered[0]?.provenance ?? []).some((item) => item.field.startsWith("requiredQualifications["))).toBe(false);
  });

  it("keeps a second role's compensation out of the first role and its description", async () => {
    const firstRole = roleText();
    const otherRole = [
      "Data Science Intern",
      "Northstar Labs",
      "Job description",
      "As a Data Science Intern at Northstar Labs, you will work with research datasets.",
      "Responsibilities",
      "Analyze machine learning data.",
      "Qualifications",
      "Must be pursuing a Statistics degree.",
      "Compensation: $200 per hour",
    ].join("\n");
    const text = `${firstRole}\n\n${otherRole}\nApply now`;
    const snapshot = page(text, "multi-role");
    const deterministic: RawJob = {
      company: "Northstar Labs",
      title: "Software Engineering Intern",
      description: firstRole,
      postingUrl: snapshot.url,
      sourceProvider: "greenhouse",
    };
    const generated = roleCandidate(firstRole, {
      salary: fact("$200 per hour", "Compensation: $200 per hour"),
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [deterministic], snapshot.url);

    expect(recovered).toEqual([deterministic]);
    expect(recovered[0]?.salary).toBeUndefined();
    expect(recovered[0]?.description ?? "").not.toContain("Data Science Intern");
  });

  it("accepts a single role with common job-title labels and internship section headings", async () => {
    const text = [
      "Job Title: Software Engineering Intern",
      "Company: Northstar Labs",
      "Internship Details",
      "Job description",
      "As a Software Engineering Intern at Northstar Labs, you will develop and test production software services using Python and TypeScript.",
      "Responsibilities",
      "Build and maintain software tools used by customers.",
      "Qualifications",
      "Must be currently pursuing a Computer Science degree.",
      "Location: Toronto, Ontario, Canada",
      "Apply now",
    ].join("\n");
    const snapshot = page(text, "labeled-role");
    const generated = roleCandidate(text);
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.title).toBe("Software Engineering Intern");
    expect(recovered[0]?.company).toBe("Northstar Labs");
  });

  it("does not promote a careers card into a job posting", async () => {
    const text = [
      "Northstar Labs Careers",
      "Software Engineering Intern Program",
      "Join our summer internship community and attend mentorship events with our engineering team.",
      "Responsibilities: Share ideas at career events and meet other students.",
      "Qualifications: Curiosity and enthusiasm for learning.",
      "Explore our culture and sign up for updates.",
    ].join("\n");
    const snapshot = page(text, "careers-card");
    const generated = candidateFor("Software Engineering Intern Program", "Northstar Labs", text, {
      responsibilities: [fact("Share ideas at career events and meet other students.")],
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered).toEqual([]);
  });

  it("does not treat a negated remote statement as an eligible location", async () => {
    const passage = [
      "Software Engineering Intern",
      "Northstar Labs",
      "Job description",
      "As a Software Engineering Intern at Northstar Labs, you will develop production software services.",
      "Responsibilities",
      "Build and maintain software tools used by customers.",
      "Qualifications",
      "Must be currently pursuing a Computer Science degree.",
      "Location: London, United Kingdom",
      "This role is not remote.",
    ].join("\n");
    const text = `${passage}\nApply now`;
    const snapshot = page(text, "negated-remote");
    const generated = candidateFor("Software Engineering Intern", "Northstar Labs", text, {
      locations: [fact("Remote", "This role is not remote.")],
      responsibilities: [fact("Build and maintain software tools used by customers.")],
      requiredQualifications: [fact("Must be currently pursuing a Computer Science degree.")],
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.locations ?? []).not.toContain("Remote");
    const analyzed = await analyzeRawJob(recovered[0]!, snapshot.url, 60, async (url) => url);
    expect(analyzed.accepted).toBe(false);
    if (!analyzed.accepted) {
      expect(analyzed.reason).toContain("not located in Canada, the United States, or a remote work arrangement");
    }
  });

  it("fails closed when a fallback role passage contradicts its explicit remote classification", async () => {
    const text = [
      "Software Engineering Intern",
      "Northstar Labs",
      "Job description",
      "Position Role Type: Remote",
      "As a Software Engineering Intern at Northstar Labs, you will develop production software services.",
      "Responsibilities",
      "Build and maintain software tools used by customers.",
      "Qualifications",
      "Must be currently pursuing a Computer Science degree.",
      "Location: London, United Kingdom",
      "This role is not remote.",
      "Apply now",
    ].join("\n");
    const snapshot = page(text, "contradictory-remote");
    const generated = candidateFor("Software Engineering Intern", "Northstar Labs", text, {
      locations: [fact("Remote", "Position Role Type: Remote")],
      responsibilities: [fact("Build and maintain software tools used by customers.")],
      requiredQualifications: [fact("Must be currently pursuing a Computer Science degree.")],
    });
    const service = fallback(outputDirectory(), async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);
    const analyzed = await Promise.all(recovered.map((job) =>
      analyzeRawJob(job, snapshot.url, 60, async (url) => url)));

    expect(analyzed.some((result) => result.accepted)).toBe(false);
  });

  it("does not retain navigation or footer text as part of a new role description", async () => {
    const text = `${roleText()}\nApply now\nPrivacy Policy\nCopyright © Northstar Labs 2025`;
    const snapshot = page(text, "footer-contamination");
    const generated = roleCandidate(text);
    const directory = outputDirectory();
    const service = fallback(directory, async () => response(generated));

    const recovered = await service.recover(snapshot, [], snapshot.url);

    const audit = recordedAudit(directory);
    expect(recovered, JSON.stringify(audit, null, 2)).toEqual([]);
    expect(audit[0]?.note).toContain("description_contains_unrelated_page_footer_or_navigation");
  });

  it("appends every concurrent attempt with exact source context, including API failures, without exposing the key", async () => {
    const directory = outputDirectory();
    const longRoleDetail = `Detailed engineering context: ${Array.from({ length: 30 }, () => "Build robust services and maintain stable APIs.").join(" ")}`;
    const firstPassage = roleText("Software Engineering Intern", "Northstar Labs", `Pay: $42 per hour\n${longRoleDetail}`);
    const secondPassage = roleText("Cloud Engineering Intern", "Harbor Systems", "Pay: $48 per hour");
    const failedPassage = roleText("Data Engineering Intern", "Fixture Failure Co", "Pay: $55 per hour");
    const firstText = `${firstPassage}\nApply now`;
    const secondText = `${secondPassage}\nApply now`;
    const failedText = `${failedPassage}\nApply now`;
    const firstPage = page(firstText, "audit-first");
    const secondPage = page(secondText, "audit-second");
    const failedPage = page(failedText, "audit-failure");
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = init?.body;
      const requestText = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "";
      const request = JSON.parse(requestText) as { input?: Array<{ content?: Array<{ text?: string }> }> };
      const prompt = request.input?.[0]?.content?.[0]?.text ?? "";
      if (prompt.includes("Fixture Failure Co")) return new Response("service unavailable", { status: 503 });
      const generated = prompt.includes("Harbor Systems")
        ? candidateFor("Cloud Engineering Intern", "Harbor Systems", secondPassage, {
          responsibilities: [fact("Build and maintain software tools used by customers.")],
        })
        : roleCandidate(firstPassage);
      return response(generated);
    };
    const service = fallback(directory, fetchImpl);

    const results = await Promise.all([
      service.recover(firstPage, [], firstPage.url),
      service.recover(secondPage, [], secondPage.url),
      service.recover(failedPage, [], failedPage.url),
    ]);

    expect(results[0], JSON.stringify(recordedAudit(directory).map((record) => ({
      status: record.status,
      note: record.note,
      recovered: (record.recovered as Array<{ field: string; reason: string; value: string; quote: string }>).map(({ field, reason, value, quote }) => ({ field, reason, valueLength: value.length, quoteLength: quote.length, equal: value === quote })),
    })))).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    expect(results[2]).toEqual([]);
    const audit = recordedAudit(directory);
    expect(audit).toHaveLength(3);
    expect(audit.map((record) => record.status)).toEqual(expect.arrayContaining(["accepted", "api_failure"]));
    for (const record of audit) {
      const missEvidence = record.missEvidence as Array<{ field: string; quote: string; context: string }>;
      expect(missEvidence.length).toBeGreaterThan(0);
      expect(missEvidence.some(({ quote, context }) => quote.length > 0 && context.includes(quote))).toBe(true);
      const recovered = record.recovered as Array<{ field: string; added: boolean }>;
      const confirmed = record.confirmedMisses as string[];
      for (const field of confirmed) {
        expect(recovered.some((item) => item.added && item.field.replace(/\[\d+\]$/, "") === field)).toBe(true);
      }
    }
    const failedRecord = audit.find((record) => record.status === "api_failure");
    const failedSalaryMiss = (failedRecord?.missEvidence as Array<{ field: string; quote: string; context: string }> | undefined)
      ?.find((item) => item.field === "salary");
    expect(failedSalaryMiss?.quote).toContain("Pay: $55 per hour");
    expect(failedSalaryMiss?.context).toContain("Pay: $55 per hour");
    const auditJson = readFileSync(join(directory, "parser-misses.jsonl"), "utf8");
    const auditMarkdown = readFileSync(join(directory, "parser-misses.md"), "utf8");
    expect(auditJson).toContain("Responsibilities");
    expect(auditMarkdown).toContain("Build and maintain software tools used by customers.");
    expect(auditMarkdown).toContain(longRoleDetail);
    expect(auditMarkdown).toContain("Pay: $55 per hour");
    expect(auditMarkdown).toContain("Data Engineering Intern");
    expect(`${auditJson}\n${auditMarkdown}`).not.toContain(testApiKey);
  });

  it("returns deterministic data on cancellation and records the cancelled attempt", async () => {
    const directory = outputDirectory();
    const snapshot = page(roleText("Software Engineering Intern", "Northstar Labs", "Pay: $42 per hour"), "cancelled");
    let notifyFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { notifyFetchStarted = resolve; });
    const fetchImpl: typeof fetch = async (_url, init) => {
      notifyFetchStarted?.();
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };
    const service = fallback(directory, fetchImpl);
    const controller = new AbortController();
    const pending = service.recover(snapshot, [], snapshot.url, controller.signal);
    await fetchStarted;
    controller.abort();

    await expect(pending).resolves.toEqual([]);
    const audit = recordedAudit(directory);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe("cancelled");
  });
});
