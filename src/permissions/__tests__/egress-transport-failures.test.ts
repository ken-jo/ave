import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpProxyServer, type HttpProxyServerOptions } from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";
import { createSocksProxyServer, type SocksProxyServerOptions } from "@anthropic-ai/sandbox-runtime/dist/sandbox/socks-proxy.js";
import { ProxyTransportError } from "@anthropic-ai/sandbox-runtime/dist/sandbox/proxy-failure.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function exchange(method: "CONNECT" | "GET", options: HttpProxyServerOptions): Promise<string> {
  const sockets = new Set<net.Socket>();
  const server = createHttpProxyServer(options);
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
      const target = method === "CONNECT" ? "service.example:443" : "http://service.example/";
      client.write(`${method} ${target} HTTP/1.1\r\nHost: service.example\r\nConnection: close\r\n\r\n`);
    });
    client.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    client.once("end", () => { client.destroy(); resolve(output); });
    client.once("error", reject);
    cleanups.push(async () => { client.destroy(); });
  });
}

describe.each(["CONNECT", "GET"] as const)("%s transport failure responses", (method) => {
  it.each(["dns", "routing", "timeout"] as const)("distinguishes a %s planning failure from policy denial", async (kind) => {
    const onTransportFailure = vi.fn();
    const dial = vi.fn();
    const output = await exchange(method, {
      filter: () => { throw new ProxyTransportError(kind, "destination unavailable"); },
      onTransportFailure,
      openRoute: dial,
      openPlainHttpRoute: dial,
    });
    expect(output).toMatch(new RegExp(`^HTTP/1.1 ${kind === "timeout" ? 504 : 502} `));
    expect(output).toContain(`X-Proxy-Error: transport-${kind}`);
    expect(onTransportFailure).toHaveBeenCalledOnce();
    expect(dial).not.toHaveBeenCalled();
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"])("reports %s after allow without a policy refusal", async (code) => {
    const onTransportFailure = vi.fn();
    const dial = vi.fn(async () => { throw Object.assign(new Error("dial failed"), { code }); });
    const output = await exchange(method, {
      filter: () => true,
      onTransportFailure,
      openRoute: dial,
      openPlainHttpRoute: dial,
    });
    expect(output).toMatch(new RegExp(`^HTTP/1.1 ${code === "ETIMEDOUT" ? 504 : 502} `));
    expect(output).not.toContain("403");
    expect(onTransportFailure).toHaveBeenCalledOnce();
    expect(dial).toHaveBeenCalledOnce();
  });

  it("sanitizes hostile failure reasons before writing response headers", async () => {
    const output = await exchange(method, { filter: () => { throw new ProxyTransportError("dns", "unavailable\r\nX-Injected: yes\u0000"); } });
    expect(output).toMatch(/^HTTP\/1\.1 502 /);
    expect(output).toContain("X-Proxy-Error: transport-dns");
    expect(output).not.toContain("\r\nX-Injected:");
    expect(output).not.toContain("\u0000");
  });

  it("preserves a genuine policy denial as 403 without dialing or failure telemetry", async () => {
    const onTransportFailure = vi.fn();
    const dial = vi.fn();
    const output = await exchange(method, { filter: () => false, onTransportFailure, openRoute: dial, openPlainHttpRoute: dial });
    expect(output).toMatch(/^HTTP\/1\.1 403 /);
    expect(onTransportFailure).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });
});

async function socksReply(options: SocksProxyServerOptions): Promise<Buffer> {
  const proxy = createSocksProxyServer(options);
  const server = net.createServer((socket) => proxy.handleConnection(socket));
  cleanups.push(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new Promise<Buffer>((resolve, reject) => {
    let output = Buffer.alloc(0);
    let requested = false;
    const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => client.write(Buffer.from([5, 1, 0])));
    cleanups.push(async () => { client.destroy(); });
    client.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (!requested && output.length >= 2) {
        expect([...output.subarray(0, 2)]).toEqual([5, 0]);
        output = output.subarray(2);
        requested = true;
        const host = Buffer.from("service.example");
        client.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 187])]));
      }
      if (requested && output.length >= 10) { client.destroy(); resolve(output); }
    });
    client.once("error", reject);
    client.once("end", () => { if (output.length < 10) reject(new Error("incomplete SOCKS failure reply")); });
  });
}

describe("SOCKS failure separation", () => {
  it("answers a planning failure with general failure and attribution for the failure observer", async () => {
    const onTransportFailure = vi.fn();
    const dial = vi.fn();
    const output = await socksReply({ filter: () => { throw new ProxyTransportError("dns", "unavailable"); }, onTransportFailure, openRoute: dial });
    expect(output[1]).toBe(1);
    expect(onTransportFailure).toHaveBeenCalledExactlyOnceWith("service.example", 443, expect.objectContaining({ kind: "dns" }), undefined);
    expect(dial).not.toHaveBeenCalled();
  });

  it("reports a post-allow dial failure without a ruleset denial", async () => {
    const onTransportFailure = vi.fn();
    const output = await socksReply({ filter: () => true, onTransportFailure, openRoute: async () => { throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }); } });
    expect(output[1]).toBe(4);
    expect(onTransportFailure).toHaveBeenCalledExactlyOnceWith("service.example", 443, expect.objectContaining({ code: "ECONNREFUSED" }), undefined);
  });

  it("keeps a policy refusal as a ruleset denial without a transport failure", async () => {
    const onTransportFailure = vi.fn();
    const dial = vi.fn();
    const output = await socksReply({ filter: () => false, onTransportFailure, openRoute: dial });
    expect(output[1]).toBe(2);
    expect(onTransportFailure).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });
});
