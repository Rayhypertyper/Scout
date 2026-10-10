import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  browserRequestPolicyUrl,
  PublicEgressProxy,
} from "../src/crawler/publicEgressProxy.js";
import { validatePublicResolvedAddresses } from "../src/utils/url.js";

describe("public browser egress proxy", () => {
  it("rejects loopback HTTP targets before opening an upstream connection", async () => {
    const resolver = vi.fn(async (): Promise<Array<{ address: string; family: 4 | 6 }>> => {
      throw new Error("resolver must not be called for a literal private target");
    });
    const proxy = new PublicEgressProxy(resolver);
    const writeHead = vi.fn();
    const response = {
      writeHead,
      end: vi.fn(),
    } as unknown as ServerResponse;
    const request = {
      url: "http://127.0.0.1:8080/admin",
      headers: {},
    } as unknown as IncomingMessage;

    await (proxy as unknown as { handleForwardRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void> })
      .handleForwardRequest(request, response);
    expect(resolver).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("rejects every answer when DNS returns a mixed public/private set", () => {
    expect(() => validatePublicResolvedAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ])).toThrow();
    expect(() => validatePublicResolvedAddresses([
      { address: "93.184.216.34", family: 6 },
    ])).toThrow();
    expect(validatePublicResolvedAddresses([{ address: "93.184.216.34", family: 4 }]))
      .toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects private CONNECT targets and maps WebSocket schemes into the same policy lane", async () => {
    const resolver = vi.fn(async (): Promise<Array<{ address: string; family: 4 | 6 }>> => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const proxy = new PublicEgressProxy(resolver);
    const end = vi.fn();
    const client = {
      end,
      destroy: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as Duplex;

    await (proxy as unknown as { handleConnect: (request: IncomingMessage, client: Duplex, head: Buffer) => Promise<void> })
      .handleConnect({ url: "127.0.0.1:443" } as IncomingMessage, client, Buffer.alloc(0));
    expect(end).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    expect(resolver).not.toHaveBeenCalled();
    expect(browserRequestPolicyUrl("wss://public.example/socket")).toBe("https://public.example/socket");
    expect(browserRequestPolicyUrl("ws://user:pass@public.example/socket")).toBeNull();
    expect(browserRequestPolicyUrl("file:///etc/passwd")).toBeNull();
  });

  it("caps a CONNECT response stream after the configured decoded byte budget", async () => {
    const proxy = new PublicEgressProxy();
    let destroyed = false;
    const destroy = vi.fn(() => {
      destroyed = true;
    });
    const response = {
      headersSent: true,
      get destroyed() {
        return destroyed;
      },
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy,
    } as unknown as ServerResponse;
    const upstream = Object.assign(
      (await import("node:stream")).Readable.from([Buffer.alloc(25_000_001)]),
      { headers: {} },
    ) as unknown as Readable;

    (proxy as unknown as { pipeResponse: (upstream: IncomingMessage, response: ServerResponse) => void })
      .pipeResponse(upstream as unknown as IncomingMessage, response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(destroy).toHaveBeenCalled();
  });
});
