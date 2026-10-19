import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDestinationHost,
  openInvocationProxyListener,
  refusedInvocationProxyDestination,
  type InvocationProxyListener,
} from "../egress-invocation-listener.js";

/** A fake upstream proxy that records the Proxy-Authorization of every request. */
async function startRecordingUpstream(): Promise<{
  port: number;
  seen: Array<{ kind: string; target: string; auth: string | undefined }>;
  close(): Promise<void>;
}> {
  const seen: Array<{ kind: string; target: string; auth: string | undefined }> = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    seen.push({ kind: "http", target: req.url ?? "", auth: req.headers["proxy-authorization"] });
    res.end(`upstream saw ${req.url}`);
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("connect", (req, socket: net.Socket) => {
    seen.push({ kind: "connect", target: req.url ?? "", auth: req.headers["proxy-authorization"] });
    if (req.url?.startsWith("denied.example")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (d: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    seen,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    let out = "";
    socket.on("data", (d) => { out += d.toString("latin1"); });
    socket.on("end", () => resolve(out));
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 1500);
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(identity: string): Promise<{ listener: InvocationProxyListener; upstream: Awaited<ReturnType<typeof startRecordingUpstream>>; refused: string[] }> {
  const upstream = await startRecordingUpstream();
  cleanups.push(upstream.close);
  const refused: string[] = [];
  const listener = await openInvocationProxyListener({
    upstream: () => ({ host: "127.0.0.1", port: upstream.port, proxyAuthorization: identity }),
    onRefused: (destination, reason) => refused.push(`${destination}|${reason}`),
  });
  cleanups.push(listener.close);
  return { listener, upstream, refused };
}

describe("refusedInvocationProxyDestination", () => {
  it.each([
    ["127.0.0.1", "loopback destination"],
    ["127.5.6.7", "loopback destination"],
    ["localhost", "loopback destination"],
    ["LOCALHOST.", "loopback destination"],
    ["foo.localhost", "loopback destination"],
    ["[::1]", "loopback destination"],
    ["::ffff:127.0.0.1", "loopback destination"],
    ["::ffff:7f00:1", "loopback destination"],
    ["0.0.0.0", "unspecified destination"],
    ["::", "unspecified destination"],
  ])("refuses %s", (host, reason) => {
    expect(refusedInvocationProxyDestination(host)).toBe(reason);
  });

  it.each(["example.com", "10.0.0.5", "192.168.1.10", "1.1.1.1", "[2606:4700::1111]"])("forwards %s to the proxy's own policy", (host) => {
    expect(refusedInvocationProxyDestination(host)).toBeUndefined();
  });

  it("canonicalizes numeric spellings a resolver would treat as loopback", () => {
    expect(canonicalDestinationHost("2130706433:80")).toBe("127.0.0.1");
    expect(canonicalDestinationHost("0x7f.1:443")).toBe("127.0.0.1");
    expect(canonicalDestinationHost("http://2130706433/x")).toBe("127.0.0.1");
    expect(canonicalDestinationHost("http://[::ffff:127.0.0.1]/")).toBe("[::ffff:7f00:1]");
    expect(refusedInvocationProxyDestination(canonicalDestinationHost("2130706433:80")!)).toBe("loopback destination");
  });
});

describe("openInvocationProxyListener", () => {
  it("stamps its own identity on a plain request and drops the client's", async () => {
    const { listener, upstream } = await setup("Basic aW52b2NhdGlvbi1h");
    const reply = await rawRequest(
      listener.port,
      "GET http://example.com/a HTTP/1.1\r\nHost: example.com\r\n" +
        "Proxy-Authorization: Basic c3RvbGVuLWlkLWI6dG9rZW4=\r\nConnection: close\r\n\r\n",
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(upstream.seen).toEqual([{ kind: "http", target: "http://example.com/a", auth: "Basic aW52b2NhdGlvbi1h" }]);
  });

  it("re-stamps every pipelined request on one connection", async () => {
    const { listener, upstream } = await setup("Basic aWQtYQ==");
    await rawRequest(
      listener.port,
      "GET http://example.com/1 HTTP/1.1\r\nHost: example.com\r\n\r\n" +
        "GET http://example.com/2 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic Zm9yZ2Vk\r\nConnection: close\r\n\r\n",
    );
    expect(upstream.seen.map((s) => [s.target, s.auth])).toEqual([
      ["http://example.com/1", "Basic aWQtYQ=="],
      ["http://example.com/2", "Basic aWQtYQ=="],
    ]);
  });

  it("stamps a CONNECT and splices the tunnel after the upstream's 200", async () => {
    const { listener, upstream } = await setup("Basic aWQtYw==");
    const reply = await rawRequest(
      listener.port,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic Zm9yZ2Vk\r\n\r\nhello",
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain("echo:hello");
    expect(upstream.seen).toEqual([{ kind: "connect", target: "example.com:443", auth: "Basic aWQtYw==" }]);
  });

  it("relays an upstream CONNECT refusal and closes", async () => {
    const { listener } = await setup("Basic aWQ=");
    const reply = await rawRequest(listener.port, "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });

  it.each([
    "CONNECT 127.0.0.1:5883 HTTP/1.1\r\nHost: 127.0.0.1:5883\r\n\r\n",
    "CONNECT localhost:5883 HTTP/1.1\r\nHost: localhost:5883\r\n\r\n",
    "CONNECT 2130706433:5883 HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET http://127.0.0.1:5883/ HTTP/1.1\r\nHost: 127.0.0.1:5883\r\nConnection: close\r\n\r\n",
    "GET http://[::1]:5883/ HTTP/1.1\r\nHost: [::1]:5883\r\nConnection: close\r\n\r\n",
  ])("refuses a loopback destination before the proxy sees it: %s", async (payload) => {
    const { listener, upstream, refused } = await setup("Basic aWQ=");
    const reply = await rawRequest(listener.port, payload);
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(reply.toLowerCase()).toContain("x-ave-egress-refused: loopback destination");
    expect(upstream.seen).toEqual([]);
    expect(refused).toHaveLength(1);
  });

  it("answers 502 and sends nothing when the proxy is gone", async () => {
    const listener = await openInvocationProxyListener({ upstream: () => undefined });
    cleanups.push(listener.close);
    const reply = await rawRequest(listener.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 502/);
  });

  it("does not serve SOCKS or origin-form requests", async () => {
    const { listener, upstream } = await setup("Basic aWQ=");
    const socks = await rawRequest(listener.port, "\x05\x01\x00");
    expect(socks).not.toMatch(/^HTTP\/1\.1 200/);
    const origin = await rawRequest(listener.port, "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
    expect(origin).toMatch(/^HTTP\/1\.1 400/);
    expect(upstream.seen).toEqual([]);
  });

  it("binds loopback only and stops accepting on close", async () => {
    const { listener } = await setup("Basic aWQ=");
    expect(listener.url).toBe(`http://127.0.0.1:${listener.port}`);
    await listener.close();
    await listener.close();
    await expect(new Promise((resolve, reject) => {
      const s = net.connect(listener.port, "127.0.0.1", () => { s.destroy(); resolve("connected"); });
      s.on("error", reject);
    })).rejects.toThrow();
  });
});
