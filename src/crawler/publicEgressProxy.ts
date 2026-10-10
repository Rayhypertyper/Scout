import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as connectSocket, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import {
  assertSafeHttpUrl,
  isAllowedPublicHttpPort,
  resolvePublicHostname,
  type PublicHostnameResolver,
  type PublicResolvedAddress,
  UnsafeUrlError,
  validatePublicResolvedAddresses,
} from "../utils/url.js";

/** Keep a renderer from turning a browser fallback into an unbounded proxy. */
export const PUBLIC_EGRESS_PROXY_MAX_RESPONSE_BYTES = 25 * 1_000_000;
export const PUBLIC_EGRESS_PROXY_MAX_REQUEST_BYTES = 2 * 1_000_000;
export const PUBLIC_EGRESS_PROXY_RESOLVE_TIMEOUT_MS = 10_000;
export const PUBLIC_EGRESS_PROXY_CONNECT_TIMEOUT_MS = 10_000;
export const PUBLIC_EGRESS_PROXY_IDLE_TIMEOUT_MS = 30_000;

/** Minimal lifecycle contract used by BrowserManager. Tests may inject a
 * recording implementation without opening a local listener; production
 * always uses PublicEgressProxy below. */
export interface BrowserEgressProxy {
  start(): Promise<string>;
  close(): Promise<void>;
}

interface ProxyTarget {
  url: URL;
  address: PublicResolvedAddress;
  port: number;
}

function writeProxyError(response: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function resolveWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Public egress resolution timed out")), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function proxyHeaders(request: IncomingMessage, host: string): Record<string, string | string[]> {
  const omitted = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !omitted.has(name.toLocaleLowerCase())) headers[name] = value;
  }
  headers.host = host;
  return headers;
}

function connectTarget(value: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    const port = parsed.port ? Number(parsed.port) : 443;
    if (!isAllowedPublicHttpPort(port)) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/**
 * A local HTTP CONNECT/forward proxy for Chromium. Chromium resolves hosts
 * itself when it connects directly, so route checks alone cannot prevent DNS
 * rebinding. The proxy resolves each request, rejects every non-public answer,
 * and opens the socket to the selected address while preserving the original
 * HTTP Host/TLS SNI inside the tunnel.
 */
export class PublicEgressProxy implements BrowserEgressProxy {
  private server: Server | null = null;
  private startPromise: Promise<string> | null = null;
  private readonly sockets = new Set<Socket>();

  public constructor(
    private readonly resolver: PublicHostnameResolver = (hostname) => resolvePublicHostname(hostname),
  ) {}

  public async start(): Promise<string> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === "object") return `http://127.0.0.1:${address.port}`;
    }
    if (this.startPromise) return this.startPromise;
    const server = createServer((request, response) => {
      void this.handleForwardRequest(request, response);
    });
    server.on("connect", (request, client, head) => {
      void this.handleConnect(request, client, head);
    });
    server.on("connection", (socket) => {
      socket.setTimeout(PUBLIC_EGRESS_PROXY_IDLE_TIMEOUT_MS, () => socket.destroy());
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    this.startPromise = (async () => {
      try {
        const listening = new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ host: "127.0.0.1", port: 0 });
        });
        await listening;
        const address = server.address();
        if (!address || typeof address !== "object") throw new Error("Public egress proxy did not expose a local port");
        this.server = server;
        return `http://127.0.0.1:${address.port}`;
      } catch (error) {
        server.close();
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  }

  private async targetForUrl(value: string): Promise<ProxyTarget> {
    const url = assertSafeHttpUrl(value);
    const addresses = validatePublicResolvedAddresses(await resolveWithTimeout(
      resolvePublicHostname(url.hostname, this.resolver),
      PUBLIC_EGRESS_PROXY_RESOLVE_TIMEOUT_MS,
    ));
    const [address] = addresses;
    if (!address) throw new UnsafeUrlError("URL host could not be resolved safely");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!isAllowedPublicHttpPort(port)) throw new UnsafeUrlError("URL port is not allowed");
    return { url, address, port };
  }

  private async handleForwardRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = request.url?.trim();
    const host = request.headers.host?.trim();
    if (!raw) {
      writeProxyError(response, 400, "Invalid proxy request");
      return;
    }
    const targetUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : host ? `http://${host}${raw}` : "";
    let target: ProxyTarget;
    try {
      target = await this.targetForUrl(targetUrl);
    } catch {
      writeProxyError(response, 403, "Destination is not allowed");
      return;
    }
    const contentLength = Number(request.headers["content-length"] ?? "");
    if (Number.isFinite(contentLength) && contentLength > PUBLIC_EGRESS_PROXY_MAX_REQUEST_BYTES) {
      writeProxyError(response, 413, "Proxy request body is too large");
      return;
    }
    const path = `${target.url.pathname || "/"}${target.url.search}`;
    const options = {
      hostname: target.address.address,
      family: target.address.family,
      port: target.port,
      method: request.method,
      path,
      headers: proxyHeaders(request, target.url.host),
      ...(target.url.protocol === "https:" ? { servername: target.url.hostname, rejectUnauthorized: true } : {}),
    };
    const upstream = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(options, (upstreamResponse) => {
      this.pipeResponse(upstreamResponse, response);
    });
    upstream.setTimeout(PUBLIC_EGRESS_PROXY_IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("Proxy upstream idle timeout")));
    request.once("aborted", () => upstream.destroy());
    request.once("close", () => {
      if (!request.complete) upstream.destroy();
    });
    response.once("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.once("error", () => {
      if (!response.headersSent) writeProxyError(response, 502, "Destination could not be reached");
      else response.destroy();
    });
    this.limitRequestBody(request, () => {
      upstream.destroy();
      if (!response.headersSent) writeProxyError(response, 413, "Proxy request body is too large");
      else response.destroy();
    });
    request.pipe(upstream);
  }

  private limitRequestBody(request: IncomingMessage, onLimit: () => void): void {
    let bytes = 0;
    let oversized = false;
    request.on("data", (chunk: Buffer | string) => {
      if (oversized) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > PUBLIC_EGRESS_PROXY_MAX_REQUEST_BYTES) {
        oversized = true;
        request.destroy();
        onLimit();
      }
    });
  }

  private pipeResponse(upstream: IncomingMessage, response: ServerResponse): void {
    const declaredLength = Number(upstream.headers["content-length"] ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > PUBLIC_EGRESS_PROXY_MAX_RESPONSE_BYTES) {
      upstream.destroy();
      writeProxyError(response, 413, "Proxy response body is too large");
      return;
    }
    const headers: Record<string, string | string[]> = {};
    const omitted = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && !omitted.has(name.toLocaleLowerCase())) headers[name] = value;
    }
    response.writeHead(upstream.statusCode ?? 502, headers);
    let bytes = 0;
    let oversized = false;
    upstream.on("data", (chunk: Buffer | string) => {
      if (oversized) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > PUBLIC_EGRESS_PROXY_MAX_RESPONSE_BYTES) {
        oversized = true;
        upstream.destroy();
        response.destroy();
        return;
      }
      response.write(chunk);
    });
    upstream.once("end", () => {
      if (!oversized) response.end();
    });
    upstream.once("error", () => {
      if (!response.destroyed) response.destroy();
    });
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const target = request.url ? connectTarget(request.url) : null;
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    let addresses: PublicResolvedAddress[];
    try {
      // The proxy's resolver is the pinning boundary for HTTPS and WebSocket
      // tunnels; a later DNS answer cannot replace this selected socket.
      addresses = await resolveWithTimeout(
        resolvePublicHostname(target.host, this.resolver),
        PUBLIC_EGRESS_PROXY_RESOLVE_TIMEOUT_MS,
      );
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      addresses = validatePublicResolvedAddresses(addresses);
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const address = addresses[0];
    if (!address) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connectSocket({ host: address.address, family: address.family, port: target.port });
    let closed = false;
    const closeBoth = (): void => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
    };
    upstream.setTimeout(PUBLIC_EGRESS_PROXY_CONNECT_TIMEOUT_MS, closeBoth);
    upstream.once("error", closeBoth);
    client.once("error", closeBoth);
    client.once("close", closeBoth);
    upstream.once("close", closeBoth);
    upstream.once("connect", () => {
      upstream.setTimeout(PUBLIC_EGRESS_PROXY_IDLE_TIMEOUT_MS, closeBoth);
      client.write("HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n");
      let clientBytes = head.length;
      let upstreamBytes = 0;
      if (clientBytes > PUBLIC_EGRESS_PROXY_MAX_RESPONSE_BYTES) {
        closeBoth();
        return;
      }
      if (head.length) upstream.write(head);
      client.on("data", (chunk: Buffer | string) => {
        clientBytes += Buffer.byteLength(chunk);
        if (clientBytes > PUBLIC_EGRESS_PROXY_MAX_RESPONSE_BYTES) closeBoth();
      });
      upstream.on("data", (chunk: Buffer | string) => {
        upstreamBytes += Buffer.byteLength(chunk);
        if (upstreamBytes > PUBLIC_EGRESS_PROXY_MAX_RESPONSE_BYTES) closeBoth();
      });
      client.pipe(upstream).pipe(client);
    });
  }
}

/** Convert a browser request URL to the policy URL used by the proxy route. */
export function browserRequestPolicyUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    if (parsed.protocol === "ws:") return new URL(`http://${parsed.host}${parsed.pathname}${parsed.search}`).toString();
    if (parsed.protocol === "wss:") return new URL(`https://${parsed.host}${parsed.pathname}${parsed.search}`).toString();
    return null;
  } catch {
    return null;
  }
}
