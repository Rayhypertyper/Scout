import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthHttpError, ensureCsrfToken } from "../auth/http.js";
import { OpenAIApiError } from "./openai.js";
import {
  deleteResumeProfile,
  importResumeCandidate,
  readResumeProfile,
  resolveResumeProfileIdentity,
  ResumeProfileError,
  ResumeProfileStorageError,
  saveResumeProfile,
} from "./profile.js";
import { ResumeError } from "./service.js";

const PROFILE_ROOT = "/api/resume-profile";
const MAX_JSON_BODY_BYTES = 7 * 1024 * 1024;

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    Vary: "Cookie",
  });
  response.end(body);
}

function applyAuthCookies(identity: Awaited<ReturnType<typeof resolveResumeProfileIdentity>>, response: ServerResponse): void {
  if (identity.context?.responseState.cookies.length) {
    response.setHeader("Set-Cookie", identity.context.responseState.cookies);
  }
}

async function readProfileJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ResumeProfileError(415, "Send resume profile changes as JSON.");
  }
  const announcedLength = Number(request.headers["content-length"]);
  if (Number.isFinite(announcedLength) && announcedLength > MAX_JSON_BODY_BYTES) {
    throw new ResumeProfileError(413, "The resume profile request is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk)
      : Buffer.isBuffer(chunk) ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_JSON_BODY_BYTES) throw new ResumeProfileError(413, "The resume profile request is too large.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ResumeProfileError(400, "The resume profile request must contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResumeProfileError(400, "The resume profile request must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function abortSignal(request: IncomingMessage, response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  if (typeof request.once === "function") request.once("aborted", () => controller.abort());
  if (typeof response.once === "function") {
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
  }
  return controller.signal;
}

function errorMessage(error: unknown): { status: number; message: string } {
  if (error instanceof ResumeProfileError || error instanceof ResumeError || error instanceof OpenAIApiError || error instanceof AuthHttpError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof ResumeProfileStorageError) {
    return { status: 503, message: "The saved resume profile is temporarily unavailable. Try again in a moment." };
  }
  return { status: 500, message: "Scout could not complete the resume profile request. Try again." };
}

/** Handles the authenticated, private resume-profile API. Returns false for unrelated routes. */
export async function handleResumeProfileRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname !== PROFILE_ROOT && !pathname.startsWith(`${PROFILE_ROOT}/`)) return false;

  try {
    if (pathname === `${PROFILE_ROOT}/import`) {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "Use POST to import a resume for review." });
        return true;
      }
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      applyAuthCookies(identity, response);
      const body = await readProfileJson(request);
      const candidate = await importResumeCandidate({
        filename: body.filename,
        contentType: body.contentType,
        data: body.data,
      }, identity.email, abortSignal(request, response));
      applyAuthCookies(identity, response);
      writeJson(response, 200, candidate);
      return true;
    }

    if (pathname !== PROFILE_ROOT) {
      writeJson(response, 404, { error: "Resume profile route not found." });
      return true;
    }

    if (request.method === "GET") {
      const identity = await resolveResumeProfileIdentity(request, response);
      const profile = readResumeProfile(databasePath, identity.userId);
      const csrfToken = identity.context && !identity.local
        ? ensureCsrfToken(request, identity.context.config, identity.context.responseState)
        : undefined;
      applyAuthCookies(identity, response);
      writeJson(response, 200, { profile, ...(csrfToken ? { csrfToken } : {}) });
      return true;
    }

    if (request.method === "PUT") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      applyAuthCookies(identity, response);
      const body = await readProfileJson(request);
      if (typeof body.filename !== "string") throw new ResumeProfileError(400, "Include the filename for the reviewed resume.");
      const profile = saveResumeProfile(databasePath, identity.userId, identity.email, body.resume, body.filename);
      applyAuthCookies(identity, response);
      writeJson(response, 200, { profile });
      return true;
    }

    if (request.method === "DELETE") {
      const identity = await resolveResumeProfileIdentity(request, response, { mutation: true, requireCsrf: true });
      applyAuthCookies(identity, response);
      deleteResumeProfile(databasePath, identity.userId);
      applyAuthCookies(identity, response);
      writeJson(response, 200, { profile: null });
      return true;
    }

    writeJson(response, 405, { error: "Use GET, PUT, or DELETE on the resume profile." });
    return true;
  } catch (error) {
    const mapped = errorMessage(error);
    writeJson(response, mapped.status, { error: mapped.message });
    return true;
  }
}
