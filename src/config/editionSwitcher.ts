import type { IncomingMessage } from "node:http";

import { parseScoutEdition } from "./edition.js";
import type { ScoutEdition } from "../domain/schemas.js";

/**
 * The switcher is a local development convenience, never a production
 * control. Keep this policy in a small server-only module so route handlers
 * and tests share exactly the same guard.
 */
export function editionSwitcherEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnvironment = environment.NODE_ENV?.trim().toLocaleLowerCase();
  if (nodeEnvironment === "production") return false;
  const switcherSetting = environment.SCOUT_ENABLE_EDITION_SWITCHER?.trim().toLocaleLowerCase();
  const explicit = switcherSetting === "true";
  const safeDevelopment = nodeEnvironment === "development";
  // The plain local dashboard command does not set NODE_ENV. Treat that
  // unspecified environment as local only when no setting was supplied.
  const unspecifiedEnvironment = !nodeEnvironment && switcherSetting === undefined;
  return explicit || safeDevelopment || unspecifiedEnvironment;
}

function hostnameFromRequest(request: IncomingMessage): string | null {
  const raw = request.headers.host?.trim();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string | null): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "").toLocaleLowerCase();
  return isLoopbackHostname(normalized);
}

function configuredSiteOrigin(environment: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = environment.AUTH_SITE_URL?.trim() || "http://127.0.0.1:4173";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Compare browser origin and Host against the configured site, never Host alone. */
export function isConfiguredOriginRequest(
  request: IncomingMessage,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = configuredSiteOrigin(environment);
  if (!configured) return false;
  const host = request.headers.host?.trim();
  if (!host) return false;
  try {
    const requestUrl = new URL(`${configured.protocol}//${host}`);
    if (requestUrl.origin !== configured.origin) return false;
    const origin = request.headers.origin;
    if (origin && new URL(origin).origin !== configured.origin) return false;
    return request.headers["sec-fetch-site"] !== "cross-site";
  } catch {
    return false;
  }
}

/** Require both a loopback peer and a loopback Host header. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  return isLoopbackHostname(hostnameFromRequest(request))
    && isLoopbackAddress(request.socket?.remoteAddress);
}

/** Reject cross-origin browser writes even on a local development server. */
export function isSameOriginRequest(request: IncomingMessage): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = hostnameFromRequest(request);
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    const hostHeader = request.headers.host?.trim();
    if (!hostHeader) return false;
    const hostUrl = new URL(`http://${hostHeader}`);
    const expectedPort = hostUrl.port || (parsed.protocol === "https:" ? "443" : "80");
    const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase() === host
      && originPort === expectedPort;
  } catch {
    return false;
  }
}

export function canUseEditionSwitcher(request: IncomingMessage, environment: NodeJS.ProcessEnv = process.env): boolean {
  return editionSwitcherEnabled(environment)
    && isLoopbackRequest(request)
    && isSameOriginRequest(request)
    && isConfiguredOriginRequest(request, environment);
}

export function parseEditionSwitcherValue(value: unknown): ScoutEdition {
  return parseScoutEdition(value);
}
