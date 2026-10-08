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

function propertiesOf(value: unknown): Record<string, unknown> {
  return objectAt(value, "properties");
}

function assertFactSchema(value: unknown): void {
  const schema = value as Record<string, unknown>;
  expect(schema).toMatchObject({
    type: "object",
    required: ["value", "quote"],
    additionalProperties: false,
  });
  expect(Object.keys(propertiesOf(schema))).toEqual(["value", "quote"]);
  expect(propertiesOf(schema).value).toEqual({ type: "string" });
  expect(propertiesOf(schema).quote).toEqual({ type: "string" });
}

function arrayItem(value: unknown): Record<string, unknown> {
  return objectAt(value, "items");
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
    const contacts = Array.from({ length: 9 }, (_unused, index) => `contact-${index + 1}@example.invalid`);
    const asFact = (value: string) => ({ value, quote: value });
    const candidate = {
      name: asFact("Synthetic Candidate"),
      contact: contacts.map(asFact),
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
        data: Buffer.from(["Synthetic Candidate", ...contacts, "Synthetic resume fixture."].join("\n")).toString("base64"),
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
    const schema = objectAt(textFormat, "schema");
    const rootProperties = propertiesOf(schema);
    expect(Object.keys(rootProperties)).toEqual(["name", "contact", "education", "experience", "projects", "awards", "skills"]);
    expect(schema).toMatchObject({ additionalProperties: false });
    expect((schema.required as string[])).toEqual(Object.keys(rootProperties));
    expect(rootProperties).not.toHaveProperty("ownerEmail");
    assertFactSchema(rootProperties.name);
    assertFactSchema(arrayItem(rootProperties.contact));
    assertFactSchema(arrayItem(rootProperties.awards));
    for (const key of ["education", "experience", "projects"]) {
      const entryProperties = propertiesOf(arrayItem(rootProperties[key]));
      for (const field of ["title", "subtitle", "date"]) assertFactSchema(entryProperties[field]);
      assertFactSchema(arrayItem(entryProperties.bullets));
    }
    const skillProperties = propertiesOf(arrayItem(rootProperties.skills));
    assertFactSchema(skillProperties.label);
    assertFactSchema(arrayItem(skillProperties.items));
    expect(maxItemsPaths(textFormat.schema)).toEqual([]);
    expect(body?.store).toBe(false);
    expect(body?.max_output_tokens).toBe(10_000);
    expect(body?.instructions).toMatch(/quote/i);
    expect(body?.instructions).toMatch(/exact|verbatim/i);
    expect(JSON.stringify(body?.input)).toContain("untrusted source text");
    expect(JSON.stringify(body?.input)).toContain("Synthetic Candidate");
  });
});
