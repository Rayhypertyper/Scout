import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIApiError, generateOpenAIStructuredJson } from "../src/resume/openai.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function rejectedRequest(): Promise<OpenAIApiError> {
  try {
    await generateOpenAIStructuredJson({
      systemInstruction: "Return the requested test object.",
      parts: [{ type: "input_text", text: "Synthetic request." }],
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
  } catch (error) {
    if (error instanceof OpenAIApiError) return error;
    throw new Error("Expected a sanitized OpenAI API error.", { cause: error });
  }
  throw new Error("Expected the provider request to be rejected.");
}

describe("OpenAI request error mapping", () => {
  it("identifies a rejected structured request without mislabeling it as a model-name error", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: 400, status: "INVALID_ARGUMENT", message: "raw provider detail must not be exposed" },
    }), { status: 400, headers: { "content-type": "application/json" } })));

    const error = await rejectedRequest();

    expect(error.status).toBe(502);
    expect(error.message).toContain("structured JSON request");
    expect(error.message).toContain("schema and request options");
    expect(error.message).not.toContain("OPENAI_MODEL");
    expect(error.message).not.toContain("raw provider detail");
  });

  it("reserves OPENAI_MODEL guidance for a model-not-found response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: 404, status: "NOT_FOUND", message: "raw model details must not be exposed" },
    }), { status: 404, headers: { "content-type": "application/json" } })));

    const error = await rejectedRequest();

    expect(error.status).toBe(502);
    expect(error.message).toContain("model was not found");
    expect(error.message).toContain("OPENAI_MODEL");
    expect(error.message).not.toContain("raw model details");
  });
});
