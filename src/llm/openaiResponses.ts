export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

export type OpenAIInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_file"; filename: string; file_data: string };

/** Build the same strict, non-stored Responses request for both AI features. */
export function structuredResponseBody(options: {
  model: string;
  instructions: string;
  parts: OpenAIInputPart[];
  schema: object;
  maxOutputTokens: number;
}): string {
  return JSON.stringify({
    model: options.model,
    instructions: options.instructions,
    input: [{ role: "user", content: options.parts }],
    text: { format: { type: "json_schema", name: "scout_result", strict: true, schema: options.schema } },
    max_output_tokens: options.maxOutputTokens,
    ...(options.model === DEFAULT_OPENAI_MODEL ? { reasoning: { effort: "low" } } : {}),
    store: false,
  });
}

export class OpenAIResponseError extends Error {
  constructor(public readonly kind: "invalid" | "incomplete" | "refusal" | "empty") {
    super(`OpenAI response ${kind}.`);
    this.name = "OpenAIResponseError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Read raw REST output, skipping reasoning and refusing partial or refused text. */
export function extractResponseText(envelope: unknown): string {
  const response = record(envelope);
  if (!response) throw new OpenAIResponseError("invalid");
  if (response.status !== "completed" || response.error || response.incomplete_details) {
    throw new OpenAIResponseError("incomplete");
  }
  if (!Array.isArray(response.output)) throw new OpenAIResponseError("invalid");
  const texts: string[] = [];
  for (const value of response.output) {
    const item = record(value);
    if (!item) throw new OpenAIResponseError("invalid");
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new OpenAIResponseError("invalid");
    }
    if (item.status !== "completed") throw new OpenAIResponseError("incomplete");
    for (const value of item.content) {
      const part = record(value);
      if (!part) throw new OpenAIResponseError("invalid");
      if (part.type === "refusal") throw new OpenAIResponseError("refusal");
      if (part.type !== "output_text" || typeof part.text !== "string") throw new OpenAIResponseError("invalid");
      texts.push(part.text);
    }
  }
  const text = texts.join("").trim();
  if (!text) throw new OpenAIResponseError("empty");
  return text;
}
