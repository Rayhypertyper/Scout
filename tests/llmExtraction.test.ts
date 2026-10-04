import { openAIEnvelope } from "./helpers/openaiResponse.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIJobFallback } from "../src/llm/openaiJobFallback.js";
import type { PageSnapshot, RawJob } from "../src/domain/types.js";

const directories: string[] = [];
const apiKey = "do-not-persist-this-openai-key";

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-llm-extraction-"));
  directories.push(directory);
  return directory;
}

const description = [
  "Software Engineering Intern",
  "Northstar Labs",
  "Job description",
  "As a Software Engineering Intern at Northstar Labs, you will build and maintain production software used by customers.",
  "Responsibilities",
  "Build and maintain reliable software tools for engineering teams.",
  "Qualifications",
  "Must be pursuing a Computer Science degree.",
  "Location: Toronto, Ontario, Canada",
].join("\n");
const pageText = description + "\nPay: $42 per hour\nApply now";

function snapshot(text = pageText): PageSnapshot {
  const url = "https://careers.northstar.example/jobs/123";
  return {
    requestedUrl: url,
    url,
    status: 200,
    contentType: "text/html; charset=utf-8",
    title: "Careers | Northstar Labs",
    html: "<main>" + text + "</main>",
    text,
    links: [],
    fetchedAt: "2026-10-01T12:00:00.000Z",
  };
}

function rawJob(descriptionText = description): RawJob {
  return {
    title: "Software Engineering Intern",
    company: "Northstar Labs",
    description: descriptionText,
    postingUrl: snapshot().url,
    sourceProvider: "greenhouse",
  };
}

interface Fact { value: string; quote: string }
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

function candidate(salary: Fact | null = { value: "$42 per hour", quote: "Pay: $42 per hour" }): Candidate {
  return {
    title: { value: "Software Engineering Intern", quote: "Software Engineering Intern" },
    company: { value: "Northstar Labs", quote: "Northstar Labs" },
    description: { value: pageText, quote: pageText },
    salary,
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
  };
}

function openaiResponse(value: unknown, status = "completed"): Response {
  return new Response(JSON.stringify({
    ...openAIEnvelope(value, status),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function service(directory: string, fetchImpl: typeof fetch, extraEnv: NodeJS.ProcessEnv = {}): OpenAIJobFallback {
  return new OpenAIJobFallback({
    outputDirectory: directory,
    env: { OPENAI_API_KEY: apiKey, SCOUT_LLM_MODEL: "openai-test-model", ...extraEnv },
    fetchImpl,
  });
}

function audit(directory: string): Array<Record<string, unknown>> {
  const path = join(directory, "parser-misses.jsonl");
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
  catch { return []; }
}

describe("OpenAI fallback extraction guards", () => {
  it("does not call OpenAI or write audit files when the key is absent or fallback is disabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => openaiResponse({ jobs: [candidate()] }));
    const directory = outputDirectory();
    const noKey = new OpenAIJobFallback({ outputDirectory: directory, env: {}, fetchImpl });
    const disabled = service(directory, fetchImpl, { SCOUT_LLM_FALLBACK: "0" });

    await expect(noKey.recover(snapshot(), [rawJob()], snapshot().url)).resolves.toEqual([rawJob()]);
    await expect(disabled.recover(snapshot(), [rawJob()], snapshot().url)).resolves.toEqual([rawJob()]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audit(directory)).toEqual([]);
  });

  it("rejects a value whose quote is not exact source text", async () => {
    const directory = outputDirectory();
    const generated = candidate({ value: "$900 per hour", quote: "Pay: $900 per hour" });
    const fallback = service(directory, async () => openaiResponse({ jobs: [generated] }));

    const result = await fallback.recover(snapshot(), [rawJob()], snapshot().url);

    expect(result).toEqual([rawJob()]);
    expect(result[0]?.salary).toBeUndefined();
    expect((result[0]?.provenance ?? []).some((item) => item.field === "salary")).toBe(false);
    expect(audit(directory)[0]?.status).toBe("rejected");
  });

  it.each([
    ["http error", async () => new Response("service response contains " + apiKey, { status: 503 }), "api_failure"],
    ["malformed HTTP JSON", async () => new Response("not-json", { status: 200 }), "bad_json"],
    ["unfinished generation", async () => openaiResponse({ jobs: [candidate()] }, "incomplete"), "incomplete_response"],
    ["malformed candidate JSON", async () => new Response(JSON.stringify(openAIEnvelope(null, "completed", "{")), { status: 200 }), "bad_json"],
    ["schema-invalid candidate", async () => openaiResponse({ jobs: [{ title: "only a title" }] }), "schema_rejected"],
  ])("keeps deterministic jobs on %s and records a redacted audit", async (_label, responder, expectedStatus) => {
    const directory = outputDirectory();
    const fallback = service(directory, responder);

    await expect(fallback.recover(snapshot(), [rawJob()], snapshot().url)).resolves.toEqual([rawJob()]);

    expect(audit(directory)[0]?.status).toBe(expectedStatus);
    expect(readFileSync(join(directory, "parser-misses.jsonl"), "utf8")).not.toContain(apiKey);
    expect(readFileSync(join(directory, "parser-misses.md"), "utf8")).not.toContain(apiKey);
  });

  it("records timeout and leaves deterministic jobs untouched", async () => {
    const directory = outputDirectory();
    const fetchImpl: typeof fetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing request abort signal"));
      if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
    });
    const fallback = service(directory, fetchImpl, { SCOUT_LLM_TIMEOUT_MS: "1000" });

    await expect(fallback.recover(snapshot(), [rawJob()], snapshot().url)).resolves.toEqual([rawJob()]);

    expect(audit(directory)[0]?.status).toBe("timeout");
  }, 3000);

  it("refuses oversized prompts and oversized provider bodies", async () => {
    const directory = outputDirectory();
    const tooLongText = pageText + "\nSource note: " + "unrelated source detail ".repeat(70);
    const notCalled = vi.fn<typeof fetch>(async () => openaiResponse({ jobs: [candidate()] }));
    const limitedInput = service(directory, notCalled, { SCOUT_LLM_MAX_INPUT_CHARS: "1000" });
    await expect(limitedInput.recover(snapshot(tooLongText), [rawJob()], snapshot().url)).resolves.toEqual([rawJob()]);
    expect(notCalled).not.toHaveBeenCalled();
    expect(audit(directory).at(-1)?.status).toBe("input_too_large");

    const limitedOutput = service(directory, async () => new Response("x".repeat(1100), { status: 200 }), { SCOUT_LLM_MAX_OUTPUT_CHARS: "1000" });
    await expect(limitedOutput.recover(snapshot(), [rawJob()], snapshot().url)).resolves.toEqual([rawJob()]);
    expect(audit(directory).at(-1)?.status).toBe("output_too_large");
  });

  it("enforces the configured total request cap without exposing the key", async () => {
    const directory = outputDirectory();
    const fetchImpl = vi.fn<typeof fetch>(async () => openaiResponse({ jobs: [candidate()] }));
    const fallback = service(directory, fetchImpl, { SCOUT_LLM_MAX_REQUESTS: "1" });

    await fallback.recover(snapshot(), [rawJob()], snapshot().url);
    await fallback.recover(snapshot(), [rawJob()], snapshot().url);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit(directory).map((record) => record.status)).toEqual(["accepted", "request_limit"]);
  });

  it("keeps overlapping recoveries within the configured OpenAI concurrency cap", async () => {
    let notifyFirstStarted: (() => void) | undefined;
    let notifySecondStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { notifySecondStarted = resolve; });
    const resolveResponses: Array<(response: Response) => void> = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let totalCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      const requestIndex = totalCalls;
      totalCalls += 1;
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      if (requestIndex === 0) notifyFirstStarted?.();
      if (requestIndex === 1) notifySecondStarted?.();
      return await new Promise<Response>((resolve) => {
        resolveResponses.push(resolve);
      }).finally(() => { activeRequests -= 1; });
    });
    const fallback = new OpenAIJobFallback({
      outputDirectory: outputDirectory(),
      env: {
        OPENAI_API_KEY: apiKey,
        SCOUT_LLM_MODEL: "openai-test-model",
        SCOUT_LLM_CONCURRENCY: "1",
        SCOUT_LLM_MAX_REQUESTS: "10",
      },
      fetchImpl,
      auditWriter: async () => undefined,
    });

    const firstRecovery = fallback.recover(snapshot(), [rawJob()], snapshot().url);
    await firstStarted;
    const secondRecovery = fallback.recover(snapshot(), [rawJob()], snapshot().url);

    expect(totalCalls).toBe(1);
    expect(activeRequests).toBe(1);
    resolveResponses[0]!(openaiResponse({ jobs: [candidate()] }));
    await secondStarted;

    expect(totalCalls).toBe(2);
    expect(maximumActiveRequests).toBe(1);
    resolveResponses[1]!(openaiResponse({ jobs: [candidate()] }));
    const [firstResult, secondResult] = await Promise.all([firstRecovery, secondRecovery]);

    expect(firstResult[0]).toMatchObject({ salary: "$42 per hour" });
    expect(secondResult[0]).toMatchObject({ salary: "$42 per hour" });
    expect(totalCalls).toBe(2);
    expect(activeRequests).toBe(0);
  });
});
