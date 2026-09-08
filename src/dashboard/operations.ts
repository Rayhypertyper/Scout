import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { writeAuthResponse, createAuthResponseState } from "../auth/http.js";
import type { AuthConfig, AuthRequestContext } from "../auth/types.js";

const PROJECT_ROOT = resolve(process.env.INTERNSHIPMATIC_ROOT ?? process.cwd());
const OPERATIONS_PUBLIC_ROOT = join(PROJECT_ROOT, "public", "admin");

/** Every operations page and asset is private; unknown /admin paths fail closed. */
export const OPERATIONS_PRIVATE_ROUTES = new Set([
  "/admin/operations",
  "/admin/operations/",
  "/admin/operations.html",
  "/admin/operations.js",
  "/admin/operations.css",
]);

export type OperationsResponseContext = Pick<AuthRequestContext, "config" | "responseState">;

function fallbackAuthConfig(request: IncomingMessage): AuthConfig {
  const host = typeof request.headers.host === "string" && request.headers.host.trim()
    ? request.headers.host.trim()
    : "127.0.0.1:4173";
  let siteUrl: URL;
  try {
    siteUrl = new URL(`http://${host}`);
  } catch {
    siteUrl = new URL("http://127.0.0.1:4173");
  }
  return {
    supabaseUrl: "http://127.0.0.1",
    publishableKey: "unconfigured",
    siteUrl,
    secureCookies: false,
    trustProxy: false,
  };
}

function routeFile(pathname: string): string | null {
  if (pathname === "/admin/operations" || pathname === "/admin/operations/" || pathname === "/admin/operations.html") return "operations.html";
  if (pathname === "/admin/operations.js") return "operations.js";
  if (pathname === "/admin/operations.css") return "operations.css";
  return null;
}

/**
 * Serve the already-built operations UI only after dashboard authorization.
 * `no-store` is intentional: the UI is request-private and asset edits must
 * be visible without relying on a deployment cache invalidation convention.
 */
export async function serveOperationsPrivateAsset(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context?: OperationsResponseContext,
): Promise<void> {
  const fileName = routeFile(pathname);
  const config = context?.config ?? fallbackAuthConfig(request);
  const state = context?.responseState ?? createAuthResponseState();
  if (!fileName) {
    writeAuthResponse(response, 404, "Not found.", "text/plain; charset=utf-8", config, state, {}, request.method === "HEAD");
    return;
  }
  const contentType = fileName.endsWith(".html")
    ? "text/html; charset=utf-8"
    : fileName.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/css; charset=utf-8";
  try {
    const body = await readFile(join(OPERATIONS_PUBLIC_ROOT, fileName));
    writeAuthResponse(response, 200, body, contentType, config, state, {}, request.method === "HEAD");
  } catch {
    writeAuthResponse(response, 404, "Not found.", "text/plain; charset=utf-8", config, state, {}, request.method === "HEAD");
  }
}
