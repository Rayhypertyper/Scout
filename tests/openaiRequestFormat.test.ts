import { openAIEnvelope } from "./helpers/openaiResponse.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIJobFallback } from "../src/llm/openaiJobFallback.js";
import { generateOpenAIStructuredJson } from "../src/resume/openai.js";
import type { PageSnapshot, RawJob } from "../src/domain/types.js";

function providerResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    ...openAIEnvelope(value),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`Expected a OpenAI request object containing ${key}.`);
  }
  const child: unknown = (value as Record<string, unknown>)[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error(`Expected ${key} to be a JSON object.`);
  }
  return child as Record<string, unknown>;
}

function parseRequestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected the OpenAI request body to be serialized JSON.");
  const parsed: unknown = JSON.parse(init.body);
  return parsed;
}

function expectStructuredJsonEnvelope(body: unknown): Record<string, unknown> {
  const textFormat = objectAt(objectAt(body, "text"), "format");
  expect(textFormat.type).toBe("json_schema");
  expect(textFormat.strict).toBe(true);
  expect(typeof textFormat.schema).toBe("object");
  expect(textFormat.schema).not.toBeNull();
  return textFormat;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAI structured JSON request format", () => {
  it.each(["", "gpt-6-luna", "openai-test-model"])("uses a strict Responses schema, bearer authentication, and crawler model %s", async (configuredModel) => {
    const expectedModel = configuredModel || "gpt-6-luna";
    const text = [
      "Software Engineering Intern",
      "Northstar Labs",
      "Job description",
      "Build and maintain production software used by customers and engineering teams.",
      "Pay: $42 per hour",
    ].join("\n");
    const url = "https://careers.northstar.example/jobs/123";
    const page: PageSnapshot = {
      requestedUrl: url,
      url,
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Careers | Northstar Labs",
      html: `<main>${text}</main>`,
      text,
      links: [],
      fetchedAt: "2026-10-01T12:00:00.000Z",
    };
    const existingJob: RawJob = {
      title: "Software Engineering Intern",
      company: "Northstar Labs",
      description: "Build and maintain production software used by customers and engineering teams.",
      postingUrl: url,
      sourceProvider: "greenhouse",
    };
    let body: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(input).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-key");
      body = parseRequestBody(init);
      return new Response("provider rejected response format", { status: 400 });
    };
    const fallback = new OpenAIJobFallback({
      outputDirectory: "/tmp",
      env: { OPENAI_API_KEY: "test-only-key", OPENAI_MODEL: "gpt-6-luna", SCOUT_LLM_MODEL: configuredModel },
      fetchImpl,
      auditWriter: async () => undefined,
    });

    await fallback.recover(page, [existingJob], url);

    expectStructuredJsonEnvelope(body);
    expect(body).toMatchObject({ model: expectedModel, store: false, max_output_tokens: 8_000 });
    if (expectedModel === "gpt-6-luna") expect(objectAt(body, "reasoning")).toEqual({ effort: "low" });
  });

  it.each(["", "gpt-6-luna", "openai-test-model"])("uses a strict Responses schema and resume model %s", async (configuredModel) => {
    const expectedModel = configuredModel || "gpt-6-luna";
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("OPENAI_MODEL", configuredModel);
    let body: unknown;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      body = parseRequestBody(init);
      return providerResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const schema = {
      type: "object" as const,
      properties: { ok: { type: "boolean" as const } },
      required: ["ok"],
      additionalProperties: false,
    };

    await expect(generateOpenAIStructuredJson({
      systemInstruction: "Return the requested structured object.",
      parts: [{ type: "input_text", text: "Synthetic request-format fixture." }],
      schema,
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const textFormat = expectStructuredJsonEnvelope(body);
    expect(textFormat.schema).toEqual(schema);
    expect(body).toMatchObject({ model: expectedModel, store: false, max_output_tokens: 4096 });
    if (expectedModel === "gpt-6-luna") expect(objectAt(body, "reasoning")).toEqual({ effort: "low" });
  });
});
