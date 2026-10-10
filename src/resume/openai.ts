import {
  DEFAULT_OPENAI_MODEL,
  OPENAI_RESPONSES_ENDPOINT,
  OpenAIResponseError,
  extractResponseText,
  structuredResponseBody,
  type OpenAIInputPart,
} from "../llm/openaiResponses.js";

export interface OpenAIJsonSchema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, OpenAIJsonSchema>;
  items?: OpenAIJsonSchema;
  required?: string[];
  enum?: string[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

export type OpenAIPart = OpenAIInputPart;

export interface OpenAIStructuredRequest {
  systemInstruction: string;
  parts: OpenAIPart[];
  schema: OpenAIJsonSchema;
  signal?: AbortSignal | undefined;
  maxOutputTokens?: number;
  /** Explicit per-call model override for tightly scoped server-only features. */
  model?: string;
}

export class OpenAIApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "OpenAIApiError";
  }
}

function abortedRequestError(requestSignal?: AbortSignal): OpenAIApiError {
  return new OpenAIApiError(504, requestSignal?.aborted
    ? "Draft generation was cancelled or exceeded its time limit. Please retry."
    : "OpenAI did not respond before the time limit. Please retry.");
}

const MAX_CONCURRENT_CALLS = 2;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;
let activeCalls = 0;

function providerConfig(requestedModel?: string): { apiKey: string; model: string } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenAIApiError(503, "OpenAI drafting is not configured. Set OPENAI_API_KEY on the server, then restart Scout.");
  }
  const model = requestedModel?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
    throw new OpenAIApiError(503, "OPENAI_MODEL must be a model name such as gpt-6-luna.");
  }
  return { apiKey, model };
}

async function readBoundedBody(response: Response): Promise<string> {
  const announcedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new OpenAIApiError(502, "OpenAI returned an unexpectedly large response. Retry the draft.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenAIApiError(502, "OpenAI returned an unexpectedly large response. Retry the draft.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function parseProviderJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OpenAIApiError(502, "OpenAI returned malformed structured output. Retry the draft.");
  }
}

/**
 * A small server-side OpenAI Responses API transport shared by drafting and
 * private profile import. It accepts only in-memory content and never logs it.
 */
export async function generateOpenAIStructuredJson(request: OpenAIStructuredRequest): Promise<unknown> {
  if (activeCalls >= MAX_CONCURRENT_CALLS) {
    throw new OpenAIApiError(429, "OpenAI is handling the maximum number of draft requests. Please try again shortly.");
  }
  activeCalls += 1;
  let combinedSignal: AbortSignal | undefined;
  try {
    const { apiKey, model } = providerConfig(request.model);
    if (request.parts.length === 0 || request.parts.length > 32) {
      throw new OpenAIApiError(400, "The OpenAI request content is invalid.");
    }
    const body = structuredResponseBody({
      model,
      instructions: request.systemInstruction,
      parts: request.parts,
      schema: request.schema,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
    });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new OpenAIApiError(413, "The source content is too large to send to OpenAI. Shorten the imported document or resume.");
    }
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    combinedSignal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: combinedSignal,
      });
    } catch {
      if (combinedSignal.aborted) throw abortedRequestError(request.signal);
      throw new OpenAIApiError(503, "OpenAI could not be reached. Check server network access and try again.");
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      if (status === 401 || status === 403) {
        throw new OpenAIApiError(503, "OpenAI rejected the server API key. Check OPENAI_API_KEY and OpenAI API access.");
      }
      if (status === 429) {
        throw new OpenAIApiError(429, "OpenAI is rate limited. Please wait and try again.");
      }
      if (status >= 500) throw new OpenAIApiError(503, "OpenAI is temporarily unavailable. Please try again shortly.");
      if (status === 404) throw new OpenAIApiError(502, "The configured OpenAI model was not found. Check OPENAI_MODEL and retry.");
      if (status === 400) {
        throw new OpenAIApiError(502, "OpenAI rejected the structured JSON request. Check that the schema and request options are supported.");
      }
      throw new OpenAIApiError(502, "OpenAI rejected the structured JSON request. Check the request format and model, then retry.");
    }
    const envelope = parseProviderJson(await readBoundedBody(response));
    const generated = extractResponseText(envelope);
    return parseProviderJson(generated);
  } catch (error) {
    if (error instanceof OpenAIApiError) throw error;
    if (combinedSignal?.aborted) throw abortedRequestError(request.signal);
    if (error instanceof OpenAIResponseError) {
      if (error.kind === "invalid") throw new OpenAIApiError(502, "OpenAI returned an invalid response. Retry the draft.");
      if (error.kind === "incomplete") throw new OpenAIApiError(422, "OpenAI did not finish a verifiable draft. Try again with shorter source text.");
      if (error.kind === "refusal") throw new OpenAIApiError(422, "OpenAI could not draft this request. Review the source text and try again.");
      throw new OpenAIApiError(422, "OpenAI returned no draft text. Review the source text and try again.");
    }
    throw new OpenAIApiError(503, "OpenAI draft generation failed. Check server configuration and retry.");
  } finally {
    activeCalls -= 1;
  }
}
