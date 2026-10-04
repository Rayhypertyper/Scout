import { openAIEnvelope } from "./helpers/openaiResponse.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { importResumeCandidate, ResumeProfileError } from "../src/resume/profile.js";

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
    throw new Error(`Expected a request object containing ${key}.`);
  }
  const child: unknown = (value as Record<string, unknown>)[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error(`Expected ${key} to be an object.`);
  }
  return child as Record<string, unknown>;
}

function serializedRequestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a serialized OpenAI request body.");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected the OpenAI request body to be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function maxItemsPaths(value: unknown, path = "$schema"): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => maxItemsPaths(child, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(Object.prototype.hasOwnProperty.call(record, "maxItems") ? [`${path}.maxItems`] : []),
    ...Object.entries(record).flatMap(([key, child]) => maxItemsPaths(child, `${path}.${key}`)),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resume-import provider schema", () => {
  it("uses a strict Responses schema while preserving local profile limits", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("OPENAI_MODEL", "openai-test-model");
    let body: Record<string, unknown> | undefined;
    const candidate = {
      name: "Synthetic Candidate",
      contact: Array.from({ length: 9 }, (_unused, index) => `Contact ${index + 1}`),
      education: [],
      experience: [],
      projects: [],
      awards: [],
      skills: [],
    };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      body = serializedRequestBody(init);
      return new Response(JSON.stringify({
        ...openAIEnvelope(candidate),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    let error: unknown;
    try {
      await importResumeCandidate({
        filename: "synthetic-resume.txt",
        contentType: "text/plain",
        data: Buffer.from("Synthetic Candidate\nSynthetic resume fixture.").toString("base64"),
      }, "candidate@example.invalid");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ResumeProfileError);
    expect(error).toMatchObject({ status: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const textFormat = objectAt(objectAt(body, "text"), "format");
    expect(textFormat.type).toBe("json_schema");
    expect(textFormat.strict).toBe(true);
    expect(maxItemsPaths(textFormat.schema)).toEqual([]);
  });
});
