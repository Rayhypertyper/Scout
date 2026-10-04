import { describe, expect, it } from "vitest";

import { OpenAIResponseError, extractResponseText } from "../src/llm/openaiResponses.js";
import { openAIEnvelope } from "./helpers/openaiResponse.js";

describe("OpenAI Responses output validation", () => {
  it("reads assistant text after reasoning output rather than assuming the first item contains text", () => {
    const output = [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}' }] },
    ];
    expect(extractResponseText({ status: "completed", output })).toBe('{"ok":true}');
  });

  it.each([
    ["incomplete", { status: "incomplete", output: [] }],
    ["incomplete", { status: "failed", output: [] }],
    ["incomplete", { status: "completed", error: { message: "private provider details" }, output: [] }],
    ["incomplete", { status: "completed", output: [{ type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: '{"ok":true}' }] }] }],
    ["refusal", { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "private provider details" }] }] }],
    ["invalid", null],
    ["invalid", { status: "completed", output: {} }],
    ["invalid", { status: "completed", output: [null] }],
    ["invalid", { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: 123 }] }] }],
    ["empty", { status: "completed", output: [] }],
    ["empty", openAIEnvelope(null, "completed", " ")],
  ])("rejects %s output without exposing provider text", (kind, body) => {
    let error: unknown;
    try { extractResponseText(body); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(OpenAIResponseError);
    expect(error).toMatchObject({ kind });
    expect((error as Error).message).not.toContain("private provider details");
  });
});
