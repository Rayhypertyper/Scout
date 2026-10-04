import type { IncomingMessage, ServerResponse } from "node:http";
import { assertCsrfToken, assertSameOrigin } from "../auth/http.js";
import { createAuthRequestContext, requireTrustedUser } from "../auth/router.js";
import { ResumeError } from "./service.js";

/** Local personal setup, or the verified owner on an authenticated deployment. */
export async function authorizeResume(
  request: IncomingMessage,
  response: ServerResponse,
  ownerEmail: string,
  options: { requireCsrf?: boolean; allowLocalBypass?: boolean } = {},
): Promise<void> {
  const remote = request.socket.remoteAddress;
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const host = new URL(`http://${request.headers.host || "invalid"}`).hostname;
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (options.allowLocalBypass && process.env.NODE_ENV !== "production" && loopback && localHost
    && !request.headers["x-forwarded-for"] && !request.headers.forwarded) {
    if (options.requireCsrf) {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
        throw new ResumeError(403, "This request did not come from Scout. Reload the page and try again.");
      }
      if (request.headers["sec-fetch-site"] === "cross-site") {
        throw new ResumeError(403, "This request did not come from Scout. Reload the page and try again.");
      }
    }
    return;
  }
  const context = createAuthRequestContext(request);
  if (options.requireCsrf) {
    assertSameOrigin(request, context.config);
    assertCsrfToken(request);
  }
  const user = await requireTrustedUser(context);
  if (context.responseState.cookies.length) response.setHeader("Set-Cookie", context.responseState.cookies);
  const ownerId = process.env.RESUME_OWNER_USER_ID?.trim();
  if (ownerId ? user.id !== ownerId : user.email.toLowerCase() !== ownerEmail.toLowerCase()) {
    throw new ResumeError(403, "Resume downloads are only available to the owner of the configured base resume.");
  }
}
