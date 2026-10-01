import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAddress, NetworkGuardError, selectAnswers, type AddressPolicy } from "../../../core/network-guard.js";
import { MarketplaceError } from "../../errors.js";
import { createTestAuthority, type TestAuthority } from "../../__tests__/fixtures/test-certificates.js";
import { createPinnedFetch, routeFromPac } from "../pinned-fetch.js";

// The transport's own TLS calls pass through to Node unchanged; the spy records the options each
// was given, so a test can read what the transport asked for rather than what the process defaults to.
vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>();
  return { ...actual, connect: vi.fn(actual.connect) };
});

/** The options of every TLS connection the transport opened since the last reset. */
function tlsCalls(): ConnectionOptions[] {
  return vi.mocked(tlsConnect).mock.calls.map((call) => call[0] as ConnectionOptions);
}

/** Drops metadata answers, keeps every other one: the shape of the gate's rule. */
const dropMetadata: AddressPolicy = (address) => (classifyAddress(address) === "metadata" ? new NetworkGuardError(`${address} is metadata`, { rank: 4 }) : "allow");

interface Seen {
  method: string;
  url: string;
  host: string | undefined;
}

/** Every socket a server accepted, tunnels included, so closing it ends them too. */
const accepted = new WeakMap<HttpServer | NetServer, Set<Socket>>();

function listen(server: HttpServer | NetServer): Promise<number> {
  const sockets = new Set<Socket>();
  accepted.set(server, sockets);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: HttpServer | NetServer): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of accepted.get(server) ?? []) socket.destroy();
    server.close(() => resolve());
  });
}

/** Tunnels a CONNECT to the loopback port it names; the proxy resolves nothing ("pkg.test" goes to 127.0.0.1). */
function tunnel(connects: string[]) {
  return (request: IncomingMessage, client: Duplex, head: Buffer) => {
    connects.push(request.url ?? "");
    const port = Number((request.url ?? "").split(":").pop());
    const upstream = netConnect({ host: "127.0.0.1", port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
}

/** Answers an absolute-form request itself, as a forwarding proxy would after fetching it. */
function forward(requests: string[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url ?? "");
    response.end(`via proxy: ${request.url}`);
  };
}

describe("routeFromPac", () => {
  it("takes the first entry only, and never a later DIRECT", () => {
    expect(routeFromPac("PROXY proxy.corp.example:8080; DIRECT", "pkg.test")).toEqual({ kind: "PROXY", proxy: { host: "proxy.corp.example", port: 8080 } });
    expect(routeFromPac("DIRECT", "pkg.test")).toEqual({ kind: "DIRECT", proxy: null });
    expect(routeFromPac("HTTPS proxy.corp.example:443", "pkg.test").kind).toBe("HTTPS");
    expect(routeFromPac("SOCKS5 [::1]:1080", "pkg.test")).toEqual({ kind: "SOCKS5", proxy: { host: "::1", port: 1080 } });
    expect(routeFromPac("SOCKS socks.corp.example:1080", "pkg.test").kind).toBe("SOCKS4");
    expect(routeFromPac("SOCKS4 socks.corp.example:1080", "pkg.test").kind).toBe("SOCKS4");
  });

  it("fails a kind it cannot speak as SOURCE_UNREACHABLE proxy, naming the entry", () => {
    for (const pac of ["QUIC quic.corp.example:443", "PROXY", "PROXY proxy.corp.example:0"]) {
      const error = (() => {
        try {
          routeFromPac(pac, "pkg.test");
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      expect(error, pac).toBeInstanceOf(MarketplaceError);
      expect((error as MarketplaceError).code).toBe("SOURCE_UNREACHABLE");
      expect((error as MarketplaceError).detail).toEqual({ reason: "proxy", host: "pkg.test", proxy: pac });
    }
  });
});

describe("createPinnedFetch", () => {
  let authority: TestAuthority;
  let plain: HttpServer;
  let plainPort: number;
  let secure: HttpServer;
  let securePort: number;
  let httpProxy: HttpServer;
  let httpProxyPort: number;
  let httpsProxy: HttpServer;
  let httpsProxyPort: number;
  let socks5: NetServer;
  let socks5Port: number;
  let socks4: NetServer;
  let socks4Port: number;
  const seen: Seen[] = [];
  const proxied: string[] = [];
  const connects: string[] = [];
  const socks5Requests: Array<{ type: number; host: string; port: number }> = [];
  const socks4Requests: Array<{ address: string; port: number }> = [];

  const record = (request: IncomingMessage, response: ServerResponse) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", host: request.headers.host });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/elsewhere" });
      response.end();
      return;
    }
    response.end(`served ${request.url}`);
  };

  beforeAll(async () => {
    authority = createTestAuthority();
    plain = createHttpServer(record);
    plainPort = await listen(plain);
    secure = createHttpsServer(authority.issue(["pkg.test"]), record);
    securePort = await listen(secure);
    httpProxy = createHttpServer(forward(proxied));
    httpProxy.on("connect", tunnel(connects));
    httpProxyPort = await listen(httpProxy);
    httpsProxy = createHttpsServer(authority.issue(["proxy.test"]), forward(proxied));
    httpsProxy.on("connect", tunnel(connects));
    httpsProxyPort = await listen(httpsProxy);

    socks5 = createNetServer((client: Socket) => {
      client.once("data", () => {
        client.write(Buffer.from([5, 0]));
        client.once("data", (request: Buffer) => {
          const type = request[3]!;
          const length = type === 3 ? request[4]! : 4;
          const start = type === 3 ? 5 : 4;
          const host = type === 3 ? request.subarray(start, start + length).toString("utf8") : [...request.subarray(4, 8)].join(".");
          const port = request.readUInt16BE(start + length);
          socks5Requests.push({ type, host, port });
          const upstream = netConnect({ host: "127.0.0.1", port }, () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff]));
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("error", () => client.destroy());
        });
      });
      client.on("error", () => undefined);
    });
    socks5Port = await listen(socks5);

    socks4 = createNetServer((client: Socket) => {
      client.once("data", (request: Buffer) => {
        const port = request.readUInt16BE(2);
        const address = [...request.subarray(4, 8)].join(".");
        socks4Requests.push({ address, port });
        const upstream = netConnect({ host: address, port }, () => {
          client.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
      });
      client.on("error", () => undefined);
    });
    socks4Port = await listen(socks4);
  });

  afterAll(async () => {
    await Promise.all([plain, secure, httpProxy, httpsProxy, socks5, socks4].map(close));
  });

  beforeEach(() => {
    vi.mocked(tlsConnect).mockClear();
  });

  /** A resolver over a table, recording each name it is asked. */
  function resolver(table: Record<string, readonly string[]>) {
    const lookups: string[] = [];
    const lookup = vi.fn(async (host: string) => {
      lookups.push(host);
      const answers = table[host];
      if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return answers;
    });
    return { lookup, lookups };
  }

  const keepAll = (answers: readonly string[]) => [...answers];

  it("resolves the target once and connects by address, keeping the name for the request (DIRECT)", async () => {
    // A rebinding resolver: the fixture's address to the first lookup, the metadata address to any later one.
    const lookups: string[] = [];
    const lookup = async (host: string) => {
      lookups.push(host);
      return lookups.length === 1 ? ["127.0.0.1"] : ["169.254.169.254"];
    };
    const select = vi.fn(keepAll);
    const fetch = createPinnedFetch({ lookup });
    const response = await fetch(`http://pkg.test:${plainPort}/direct?x=1`, { method: "GET" }, select);
    expect(await response.text()).toBe("served /direct?x=1");
    expect(lookups).toEqual(["pkg.test"]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(["127.0.0.1"]);
    expect(seen.at(-1)).toEqual({ method: "GET", url: "/direct?x=1", host: `pkg.test:${plainPort}` });
    // Plain http is plain: no TLS connection is opened on the way.
    expect(tlsCalls()).toEqual([]);
  });

  it("connects only to the answers the rule keeps: a public name that also answers metadata is used through its kept answer", async () => {
    const { lookup } = resolver({ "pkg.test": ["169.254.169.254", "127.0.0.1"] });
    const fetch = createPinnedFetch({ lookup });
    const hop = new URL(`http://pkg.test:${plainPort}/kept`);
    const response = await fetch(hop.href, { signal: AbortSignal.timeout(3000) }, (answers) => selectAnswers(answers, hop, dropMetadata));
    expect(await response.text()).toBe("served /kept");
  });

  it("opens no connection when the rule keeps no answer", async () => {
    const { lookup } = resolver({ "pkg.test": ["169.254.169.254"] });
    const before = seen.length;
    const hop = new URL(`http://pkg.test:${plainPort}/refused`);
    await expect(createPinnedFetch({ lookup })(hop.href, {}, (answers) => selectAnswers(answers, hop, dropMetadata))).rejects.toBeInstanceOf(NetworkGuardError);
    expect(seen.length).toBe(before);
  });

  it("checks the certificate against the name while connecting to the address", async () => {
    const { lookup } = resolver({ "pkg.test": ["127.0.0.1"], "other.test": ["127.0.0.1"] });
    const fetch = createPinnedFetch({ lookup, ca: () => [authority.caPem] });
    expect(await (await fetch(`https://pkg.test:${securePort}/secure`, {}, keepAll)).text()).toBe("served /secure");
    // The same address under a name the certificate does not carry fails verification.
    await expect(fetch(`https://other.test:${securePort}/secure`, {}, keepAll)).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    // A root the transport was not given is not trusted.
    await expect(createPinnedFetch({ lookup, ca: () => [createTestAuthority("Stranger").caPem] })(`https://pkg.test:${securePort}/secure`, {}, keepAll)).rejects.toThrow();
  });

  it("asks every TLS connection itself to verify the certificate against the name, whatever the process default (§7.4)", async () => {
    const { lookup } = resolver({ "pkg.test": ["127.0.0.1"], "proxy.test": ["127.0.0.1"] });
    // To the target: connected by address, the certificate checked against the name.
    await createPinnedFetch({ lookup, ca: () => [authority.caPem] })(`https://pkg.test:${securePort}/structural`, {}, keepAll);
    expect(tlsCalls()).toEqual([expect.objectContaining({ host: "pkg.test", servername: "pkg.test", rejectUnauthorized: true })]);

    // To an HTTPS proxy, and through it to the target: each connection carries the setting itself.
    vi.mocked(tlsConnect).mockClear();
    const viaProxy = createPinnedFetch({ lookup, ca: () => [authority.caPem], resolveProxy: async () => `HTTPS proxy.test:${httpsProxyPort}` });
    await viaProxy(`https://pkg.test:${securePort}/structural-tunnel`, {}, keepAll);
    expect(tlsCalls()).toEqual([
      expect.objectContaining({ host: "proxy.test", servername: "proxy.test", rejectUnauthorized: true }),
      expect.objectContaining({ host: "pkg.test", servername: "pkg.test", rejectUnauthorized: true }),
    ]);
  });

  it("returns a redirect as it is, with no body, for the guard to check the next hop", async () => {
    const { lookup } = resolver({ "pkg.test": ["127.0.0.1"] });
    const response = await createPinnedFetch({ lookup })(`http://pkg.test:${plainPort}/redirect`, {}, keepAll);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/elsewhere");
    expect(response.body).toBeNull();
  });

  it("sends an http request to a PROXY in absolute form; the proxy resolves the target, only the proxy is looked up", async () => {
    const { lookup, lookups } = resolver({ "proxy.test": ["127.0.0.1"] });
    const select = vi.fn(keepAll);
    const fetch = createPinnedFetch({ lookup, resolveProxy: async () => `PROXY proxy.test:${httpProxyPort}; DIRECT` });
    const response = await fetch(`http://pkg.test:${plainPort}/through`, {}, select);
    expect(await response.text()).toBe(`via proxy: http://pkg.test:${plainPort}/through`);
    expect(proxied.at(-1)).toBe(`http://pkg.test:${plainPort}/through`);
    expect(lookups).toEqual(["proxy.test"]);
    expect(select).not.toHaveBeenCalled();
    expect(tlsCalls()).toEqual([]);
  });

  it("never falls back to DIRECT when the first PAC entry's proxy fails", async () => {
    const { lookup, lookups } = resolver({ "proxy.test": ["127.0.0.1"], "pkg.test": ["127.0.0.1"] });
    const down = createNetServer();
    const downPort = await listen(down);
    await close(down);
    const before = seen.length;
    const fetch = createPinnedFetch({ lookup, resolveProxy: async () => `PROXY proxy.test:${downPort}; DIRECT` });
    await expect(fetch(`http://pkg.test:${plainPort}/fallback`, {}, keepAll)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(seen.length).toBe(before);
    expect(lookups).toEqual(["proxy.test"]);
  });

  it("tunnels an https request through a PROXY with CONNECT to the name, then checks the certificate end to end", async () => {
    const { lookup, lookups } = resolver({ "proxy.test": ["127.0.0.1"] });
    const fetch = createPinnedFetch({ lookup, ca: () => [authority.caPem], resolveProxy: async () => `PROXY proxy.test:${httpProxyPort}` });
    expect(await (await fetch(`https://pkg.test:${securePort}/tunneled`, {}, keepAll)).text()).toBe("served /tunneled");
    expect(connects.at(-1)).toBe(`pkg.test:${securePort}`);
    expect(lookups).toEqual(["proxy.test"]);
  });

  it("speaks TLS to an HTTPS proxy, checked against the proxy's own name", async () => {
    const { lookup } = resolver({ "proxy.test": ["127.0.0.1"] });
    const fetch = createPinnedFetch({ lookup, ca: () => [authority.caPem], resolveProxy: async () => `HTTPS proxy.test:${httpsProxyPort}` });
    expect(await (await fetch(`http://pkg.test:${plainPort}/tls-proxy`, {}, keepAll)).text()).toBe(`via proxy: http://pkg.test:${plainPort}/tls-proxy`);
    expect(await (await fetch(`https://pkg.test:${securePort}/tls-proxy-tunnel`, {}, keepAll)).text()).toBe("served /tls-proxy-tunnel");
  });

  it("asks a SOCKS5 proxy for the target by name (the domain-name address type), resolving nothing here", async () => {
    const { lookup, lookups } = resolver({ "proxy.test": ["127.0.0.1"] });
    const select = vi.fn(keepAll);
    const fetch = createPinnedFetch({ lookup, resolveProxy: async () => `SOCKS5 proxy.test:${socks5Port}` });
    expect(await (await fetch(`http://pkg.test:${plainPort}/socks5`, {}, select)).text()).toBe("served /socks5");
    expect(socks5Requests.at(-1)).toEqual({ type: 3, host: "pkg.test", port: plainPort });
    expect(lookups).toEqual(["proxy.test"]);
    expect(select).not.toHaveBeenCalled();
  });

  it("hands a SOCKS4 proxy the target's checked IPv4 answer", async () => {
    const { lookup, lookups } = resolver({ "proxy.test": ["127.0.0.1"], "pkg.test": ["::1", "127.0.0.1"] });
    const select = vi.fn(keepAll);
    const fetch = createPinnedFetch({ lookup, resolveProxy: async () => `SOCKS proxy.test:${socks4Port}` });
    expect(await (await fetch(`http://pkg.test:${plainPort}/socks4`, {}, select)).text()).toBe("served /socks4");
    expect(socks4Requests.at(-1)).toEqual({ address: "127.0.0.1", port: plainPort });
    expect(select).toHaveBeenCalledWith(["::1", "127.0.0.1"]);
    expect(lookups.sort()).toEqual(["pkg.test", "proxy.test"]);
  });

  it("refuses a proxy that resolves only to a metadata address, and an unknown PAC kind, before connecting", async () => {
    const { lookup } = resolver({ "proxy.test": ["169.254.169.254"] });
    const before = proxied.length;
    await expect(createPinnedFetch({ lookup, resolveProxy: async () => "PROXY proxy.test:8080" })(`http://pkg.test:${plainPort}/x`, {}, keepAll))
      .rejects.toMatchObject({ code: "SOURCE_URL_REJECTED", detail: { reason: "address-metadata", host: "proxy.test", address: "169.254.169.254" } });
    // A literal proxy is its own one answer, judged the same way; nothing is looked up for it.
    for (const [pac, reason] of [
      ["PROXY 169.254.169.254:8080", "address-metadata"],
      ["PROXY 192.0.2.1:8080", "address-unroutable"],
      ["HTTPS [fd00:ec2::254]:443", "address-metadata"],
      ["SOCKS5 [::ffff:169.254.169.254]:1080", "address-metadata"],
    ] as const) {
      await expect(createPinnedFetch({ lookup, resolveProxy: async () => pac })(`http://pkg.test:${plainPort}/x`, {}, keepAll)).rejects.toMatchObject({ code: "SOURCE_URL_REJECTED", detail: { reason } });
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(createPinnedFetch({ lookup, resolveProxy: async () => "QUIC proxy.test:443" })(`http://pkg.test:${plainPort}/x`, {}, keepAll))
      .rejects.toMatchObject({ code: "SOURCE_UNREACHABLE", detail: { reason: "proxy" } });
    expect(proxied.length).toBe(before);
  });
});
