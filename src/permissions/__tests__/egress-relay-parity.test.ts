// The same cases against the relay the routes use today and the relay in `egress-relay/`. RECORDED is the pin: one value per row means both
// relays must give it; a row with two values is an intended difference and is listed in DIFFERENCES. Direct sockets from a contained process
// (P1) and its reach to other loopback ports (P5) are properties of the container request and are measured natively, not here.
import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParentProxyRouter, SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { setDestinationResolverForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
import { useTempDirs as tempDirs } from "../../__tests__/test-helpers.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import {
  closeAllEgressConnections,
  closeEgressConnections,
  initializeAsrtSandbox,
  resetAsrtSandbox,
  subscribeAsrtViolations,
  type AsrtViolationRecord,
} from "../asrt-sandbox.js";
import { startEgressDenyMonitor } from "../egress-deny-monitor.js";
import { openHostEgressListener } from "../egress-host-listener.js";
import { openInvocationProxyListener, type InvocationProxyAdmission } from "../egress-invocation-listener.js";
import { openEgressInvocation, releaseEgressInvocation } from "../egress-invocations.js";
import {
  closeAllEgressRelayConnections,
  closeEgressRelayConnections,
  openEgressRelay,
  setEgressRelayRouter,
  startEgressRelayService,
  stopEgressRelayService,
  subscribeEgressRelayViolations,
  type EgressRelayAsk,
  type EgressRelayRouter,
} from "../egress-relay/relay.js";

type RelayName = "today" | "new";

// The recorded behaviour. `both` rows were measured on today's relay first and are the acceptance value for the new one.
const RECORDED = {
  // P17
  connectReply: { today: "HTTP/1.1 200 Connection Established", new: "HTTP/1.0 200 Connection Established" },
  // P18: an entry with a port admits that port only, on both.
  portlessAllowEntry: { today: "admits every port", new: "refused when the service starts" },
  // P14
  noAskCallback: { today: "403 host is not on the allow list", new: "the service does not start" },
  // P15
  openBeforeStart: { today: "the sandbox proxy is not running", new: "the service is not started" },
  denied: { both: "HTTP/1.1 403 no" },
  unauthenticated: { both: "HTTP/1.1 407 Proxy Authentication Required" },
  otherInvocationName: { both: "HTTP/1.1 403 proxy username does not match the listener" },
  reservedAddress: { both: "HTTP/1.1 403 destination resolves to this host or a reserved address" },
  relayListener: { both: "HTTP/1.1 403 sandbox proxy listener" },
  upstreamAuth: { both: "HTTP/1.1 403 upstream proxy requires authentication" },
  promptFailed: { both: "HTTP/1.1 403 permission prompt failed" },
  notABoolean: { both: "HTTP/1.1 403 user denied" },
  // P21: the same reserved address in every spelling. Today asks about each one, then dials.
  reservedLiteral: { today: "asked", new: "HTTP/1.1 403 destination is a reserved address" },
  // P24, per-invocation route: the ports are freed at close and are ordinary loopback ports again.
  endedPortHop: { both: "asked" },
  // P21: the allow list does not exempt a reserved literal on the new relay.
  allowedReservedLiteral: { today: "tunnelled", new: "HTTP/1.1 403 destination is a reserved address" },
  oversizedHeader: { both: "HTTP/1.1 431 Request Header Fields Too Large" },
  reusedToken: { both: "the invocation already had a relay" },
} as const;

// Every row where the two relays differ, and why that is intended.
const DIFFERENCES = [
  { row: "P17", today: RECORDED.connectReply.today, new: RECORDED.connectReply.new, why: "a client that accepts only an HTTP/1.0 status line must get its tunnel" },
  { row: "P18", today: RECORDED.portlessAllowEntry.today, new: RECORDED.portlessAllowEntry.new, why: "an allow entry is a host and a port" },
  { row: "P14", today: RECORDED.noAskCallback.today, new: RECORDED.noAskCallback.new, why: "the ask callback is a precondition of the service" },
  { row: "P15", today: RECORDED.openBeforeStart.today, new: RECORDED.openBeforeStart.new, why: "same refusal, the relay's own wording" },
  { row: "P16", today: "4096 relays, not exercised here", new: "4096 relays, exercised with a lower injected limit", why: "same limit" },
  { row: "P21", today: "a reserved address literal is asked about, then dialled", new: RECORDED.reservedLiteral.new, why: "no spelling of a link-local, metadata, multicast or unspecified address is a destination; loopback and private-use literals are asked as today; the allow list does not exempt a literal (today an allow-listed one is tunnelled without an ask)" },
  { row: "407 challenge", today: "its own realm name", new: 'realm "egress relay"', why: "nothing reads the realm" },
  { row: "listener", today: "a port outside the shared proxy range", new: "any ephemeral loopback port", why: "the container makes the connection, so no range has to match a host rule" },
] as const;

// P24 on the wrapped-command route. Today has it on one OS only, where this suite's today adapter cannot run, so today's column is read
// from the package manager module and the new relay is pinned to it: an ended listener keeps its port bound and refused for 30 minutes,
// up to 24 hours while its process group lives (:147-152, :1882-1914); held listeners count toward the limit (:1738, :1907); after the hold
// the port number stays refused and is never given out again until reset (:1158, :1762, :1910, :3739).
const HELD = "HTTP/1.1 403 sandbox proxy listener";
type RouteKind = "invocation" | "wrapped-command";

type Ask = EgressRelayAsk;
interface StartOptions {
  readonly ask?: Ask;
  readonly router?: EgressRelayRouter;
  readonly allow?: readonly string[];
  readonly resolve?: (name: string) => Promise<readonly { address: string; family?: number }[]>;
  readonly maxRelays?: number;
  readonly endedPortHold?: { readonly ms: number; readonly maxMs: number; readonly groupAlive?: (group: number) => boolean };
}
interface RelayUnderTest {
  readonly port: number;
  readonly proxyAuthorization: string;
  registerPort(port: number): void;
  close(): Promise<void>;
}
interface Adapter {
  readonly name: RelayName;
  start(options: StartOptions): Promise<void>;
  open(token: string, admission?: InvocationProxyAdmission, kind?: RouteKind): Promise<RelayUnderTest & { recordRefusal(destination: string, reason: string): void }>;
  setRouter(router: EgressRelayRouter): void;
  closeConnections(tokens: readonly string[], host: string, port: number): number;
  closeAll(): number;
  subscribe(listener: (violations: readonly AsrtViolationRecord[]) => void): Promise<() => void>;
  stop(): Promise<void>;
}

// The contracts boot wires today are the ones the new relay takes.
const contracts = (ask: SandboxAskCallback, router: ParentProxyRouter): [EgressRelayAsk, EgressRelayRouter] => [ask, router];

const today: Adapter = {
  name: "today",
  async start(options) {
    setDestinationResolverForTesting(options.resolve);
    await initializeAsrtSandbox({
      allowedDomains: [...(options.allow ?? [])],
      strictAllowlist: false,
      windows: { externalConfinement: true },
      ...(options.router ? { upstreamRouter: options.router } : {}),
    }, options.ask as SandboxAskCallback | undefined);
  },
  open: (token, admission) => openHostEgressListener(token, admission),
  setRouter: () => { throw new Error("today's router is installed at start"); },
  closeConnections: closeEgressConnections,
  closeAll: closeAllEgressConnections,
  subscribe: subscribeAsrtViolations,
  async stop() {
    await resetAsrtSandbox();
    setDestinationResolverForTesting(undefined);
  },
};

const next: Adapter = {
  name: "new",
  async start(options) {
    const { endedPortHold, ...rest } = options;
    startEgressRelayService({ ...rest, ask: options.ask as Ask, ...(endedPortHold ? { endedPortHold: { "wrapped-command": endedPortHold } } : {}) });
  },
  async open(token, admission, kind) {
    const relay = await openEgressRelay(token, admission, kind);
    return { ...relay, recordRefusal: (destination, reason) => relay.recordRefusal(destination, undefined, reason) };
  },
  setRouter: setEgressRelayRouter,
  closeConnections: closeEgressRelayConnections,
  closeAll: closeAllEgressRelayConnections,
  subscribe: async (listener) => subscribeEgressRelayViolations(listener),
  stop: stopEgressRelayService,
};

const cleanups: Array<() => Promise<void> | void> = [];
const policyFixture = tempDirs("egress-relay-parity-");
const PUBLIC = "93.184.216.34";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
beforeEach(() => {
  vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([policyFixture()]);
});

function newToken(): string {
  const { token } = openEgressInvocation({ kind: "worker", role: "worker", pluginId: undefined });
  cleanups.push(() => releaseEgressInvocation(token));
  return token;
}

// A loopback upstream proxy: answers CONNECT with `status` and echoes tunnel bytes. No destination traffic leaves this process.
async function startUpstream(status = 200) {
  const sockets = new Set<net.Socket>();
  const connects: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const onHead = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      connects.push(head);
      socket.off("data", onHead);
      if (status !== 200) {
        socket.end(`HTTP/1.1 ${status} Refused\r\n\r\n`);
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", (data: Buffer) => socket.write(data));
    };
    socket.on("data", onHead);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const port = (server.address() as net.AddressInfo).port;
  const router: EgressRelayRouter = async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port }] });
  return { port, connects, sockets, router };
}

function send(port: number, request: string) {
  let output = "";
  const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
  socket.on("data", (chunk: Buffer) => { output += chunk.toString("latin1"); });
  socket.on("error", () => {});
  cleanups.push(() => { socket.destroy(); });
  return { socket, output: () => output, statusLine: () => output.split("\r\n")[0] ?? "" };
}

function connect(relay: { port: number; proxyAuthorization?: string }, authority: string) {
  const auth = relay.proxyAuthorization !== undefined ? `Proxy-Authorization: ${relay.proxyAuthorization}\r\n` : "";
  return send(relay.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
}

async function openTunnel(relay: { port: number; proxyAuthorization?: string }, authority: string) {
  const client = connect(relay, authority);
  await expect.poll(client.output).toContain("\r\n\r\n");
  expect(client.statusLine()).toMatch(/^HTTP\/1\.[01] 200 /u);
  client.socket.write("ping");
  await expect.poll(client.output).toContain("ping");
  return client;
}

async function refused(relay: { port: number; proxyAuthorization?: string }, authority: string): Promise<string> {
  const client = connect(relay, authority);
  await expect.poll(client.output).toContain("\r\n\r\n");
  return client.statusLine();
}

const resolverFor = (table: Record<string, string[]>) => vi.fn(async (name: string) => {
  const addresses = table[name];
  if (addresses === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family: net.isIP(address) }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

it("takes the ask callback and the router boot builds today", () => {
  expect(contracts).toBeTypeOf("function");
  expect(DIFFERENCES.map((difference) => difference.row)).toEqual(["P17", "P18", "P14", "P15", "P16", "P21", "407 challenge", "listener"]);
});

describe.each([today, next])("egress relay parity: $name relay", (adapter) => {
  const supported = adapter.name === "new" || process.platform === "win32";
  const recorded = <K extends keyof typeof RECORDED>(row: K): string => {
    const value: Partial<Record<RelayName | "both", string>> = RECORDED[row];
    return value.both ?? value[adapter.name] ?? "";
  };
  const start = async (options: StartOptions): Promise<void> => {
    await adapter.start(options);
    cleanups.push(adapter.stop);
  };
  const open = async (token = newToken(), admission?: InvocationProxyAdmission, kind?: RouteKind) => {
    const relay = await adapter.open(token, admission, kind);
    cleanups.push(relay.close);
    return relay;
  };

  describe.skipIf(!supported)("cases", () => {
    it("P2, P8, P12, P17: an allowed host:port gets a working tunnel, resolved once and sent upstream as that address", async () => {
      const upstream = await startUpstream();
      let answer = PUBLIC;
      const resolveName = vi.fn(async () => {
        const address = answer;
        answer = "93.184.216.99";
        return [{ address, family: 4 }];
      });
      const ask = vi.fn<Ask>(async () => false);
      await start({ ask, allow: ["allowed.example:443"], router: upstream.router, resolve: resolveName });
      const relay = await open();

      const tunnel = await openTunnel(relay, "allowed.example:443");

      expect(tunnel.statusLine()).toBe(recorded("connectReply"));
      expect(ask).not.toHaveBeenCalled();
      expect(resolveName).toHaveBeenCalledTimes(1);
      expect(upstream.connects).toHaveLength(1);
      expect(upstream.connects[0]).toMatch(new RegExp(`^CONNECT ${PUBLIC.replaceAll(".", "\\.")}:443 HTTP/1\\.1\\r\\n`, "u"));
      expect(upstream.connects[0]).not.toContain("allowed.example");
    });

    it("P3: a host the callback denies gets 403 with the callback's reason, before any lookup or route", async () => {
      const upstream = await startUpstream();
      const resolveName = resolverFor({ "denied.example": [PUBLIC] });
      const router = vi.fn(upstream.router);
      await start({ ask: async () => ({ allow: false, reason: "no" }), router, resolve: resolveName });
      const relay = await open();

      expect(await refused(relay, "denied.example:443")).toBe(recorded("denied"));
      expect(resolveName).not.toHaveBeenCalled();
      expect(router).not.toHaveBeenCalled();
      expect(upstream.connects).toEqual([]);
    });

    it("P4: a plain HTTP request to a denied host gets 403", async () => {
      await start({ ask: async () => ({ allow: false, reason: "no" }), resolve: resolverFor({}) });
      const relay = await open();

      const client = send(relay.port, `GET http://denied.example/path HTTP/1.1\r\nHost: denied.example\r\nProxy-Authorization: ${relay.proxyAuthorization}\r\n\r\n`);
      await expect.poll(client.output).toContain("\r\n\r\n");

      expect(client.statusLine()).toMatch(/^HTTP\/1\.1 403 /u);
    });

    it("P4: a plain HTTP request the callback allows is forwarded to the address it named", async () => {
      const origin = http.createServer((req, res) => res.end(`origin saw ${req.method} ${req.url} for ${req.headers.host}`));
      await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
      cleanups.push(() => new Promise<void>((done) => { origin.closeAllConnections(); origin.close(() => done()); }));
      const port = (origin.address() as net.AddressInfo).port;
      await start({ ask: async () => true });
      const relay = await open();

      const client = send(relay.port, `GET http://127.0.0.1:${port}/path?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: ${relay.proxyAuthorization}\r\nConnection: close\r\n\r\n`);

      await expect.poll(client.output).toContain(`origin saw GET /path?q=1 for 127.0.0.1:${port}`);
      expect(client.statusLine()).toMatch(/^HTTP\/1\.1 200 /u);
    });

    it("P5: a relay listener is never a destination, by literal or through the listener a container is given", async () => {
      await start({ ask: async () => true });
      const relay = await open();
      const other = await open();
      const front = await openInvocationProxyListener({ upstream: () => ({ host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }) });
      cleanups.push(front.close);
      relay.registerPort(front.port);

      expect(await refused(relay, `127.0.0.1:${other.port}`)).toBe(recorded("relayListener"));
      expect(await refused(relay, `127.0.0.1:${front.port}`)).toBe(recorded("relayListener"));
      expect(await refused(front, `127.0.0.1:${other.port}`)).toMatch(/^HTTP\/1\.1 403 /u);
    });

    it("P6: an unlisted host is asked by name, then with what it resolved to, under the invocation's token", async () => {
      const upstream = await startUpstream();
      const ask = vi.fn<Ask>(async () => true);
      await start({ ask, router: upstream.router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const token = newToken();
      const relay = await open(token);

      await openTunnel(relay, "asked.example:8443");

      expect(ask.mock.calls).toEqual([
        [{ host: "asked.example", port: 8443 }, { attributionKey: token, identity: "listener", phase: "name" }],
        [{ host: "asked.example", port: 8443 }, { attributionKey: token, identity: "listener", phase: "resolved", addresses: [PUBLIC], resolution: "pinned" }],
      ]);
    });

    it("P6: only `true` allows; a thrown callback or another answer is a refusal", async () => {
      let answer: () => ReturnType<Ask> = async () => { throw new Error("card failed"); };
      await start({ ask: () => answer(), resolve: resolverFor({}) });
      const relay = await open();

      expect(await refused(relay, "asked.example:443")).toBe(recorded("promptFailed"));
      answer = async () => ({ allow: true }) as unknown as boolean;
      expect(await refused(relay, "asked.example:443")).toBe(recorded("notABoolean"));
      answer = () => { throw new Error("card failed early"); };
      expect(await refused(relay, "asked.example:443")).toBe(recorded("promptFailed"));
    });

    it.each([
      ["loopback", "127.0.0.1"],
      ["link-local metadata", "169.254.169.254"],
      ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
      ["IPv4-translated loopback", "::ffff:0:127.0.0.1"],
    ])("P7: an allowed name that resolves to a %s address is refused", async (_label, address) => {
      const upstream = await startUpstream();
      await start({ ask: async () => true, allow: ["allowed.example:443"], router: upstream.router, resolve: resolverFor({ "allowed.example": [PUBLIC, address] }) });
      const relay = await open();

      expect(await refused(relay, "allowed.example:443")).toBe(recorded("reservedAddress"));
      expect(upstream.connects).toEqual([]);
    });

    it("P7: a private-use address is left to the callback, which is told the address", async () => {
      const upstream = await startUpstream();
      const ask = vi.fn<Ask>(async (_destination, context) => context.phase === "name");
      await start({ ask, router: upstream.router, resolve: resolverFor({ "intranet.example": ["10.0.0.5"] }) });
      const relay = await open();

      expect(await refused(relay, "intranet.example:443")).toMatch(/^HTTP\/1\.1 403 /u);
      expect(ask.mock.calls[1]?.[1]).toMatchObject({ phase: "resolved", addresses: ["10.0.0.5"], resolution: "pinned" });
      expect(upstream.connects).toEqual([]);
    });

    it("P7, P21: a name is refused at the address it resolved to, after the lookup and before any dial", async () => {
      const upstream = await startUpstream();
      const resolveName = resolverFor({ "allowed.example": ["169.254.169.254"] });
      await start({ ask: async () => true, allow: ["allowed.example:80"], router: upstream.router, resolve: resolveName });
      const relay = await open();

      expect(await refused(relay, "allowed.example:80")).toBe(recorded("reservedAddress"));
      expect(resolveName).toHaveBeenCalledTimes(1);
      expect(upstream.connects).toEqual([]);
    });

    it("P21: a reserved address is refused in every spelling of it", async () => {
      const upstream = await startUpstream();
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "asked" }));
      const router = vi.fn(upstream.router);
      await start({ ask, router, resolve: resolverFor({}) });
      const relay = await open();
      const spellings = [
        "169.254.169.254",
        "2852039166",
        "0251.0376.0251.0376",
        "0xa9fea9fe",
        "[::ffff:169.254.169.254]",
        "[::ffff:a9fe:a9fe]",
        "[::ffff:0:169.254.169.254]",
        "[fe80::1]",
        "0.0.0.0",
        "224.0.0.1",
        "[::a9fe:a9fe]",
        "[64:ff9b::a9fe:a9fe]",
        "[2002:a9fe:a9fe::1]",
        "169.254.43518",
        "169.254.169.254.",
      ];

      const outcomes: Record<string, string> = {};
      for (const spelling of spellings) {
        ask.mockClear();
        const status = await refused(relay, `${spelling}:80`);
        outcomes[spelling] = ask.mock.calls.length > 0 ? "asked" : status;
      }
      // The plain-HTTP path makes the same decision.
      ask.mockClear();
      const plain = send(relay.port, `GET http://169.254.169.254/latest HTTP/1.1\r\nHost: 169.254.169.254\r\nProxy-Authorization: ${relay.proxyAuthorization}\r\n\r\n`);
      await expect.poll(plain.output).toContain("\r\n\r\n");
      const refusedPlain = plain.statusLine() === "HTTP/1.1 403 Forbidden" && plain.output().includes("destination is a reserved address");
      expect(ask.mock.calls.length > 0 ? "asked" : refusedPlain && RECORDED.reservedLiteral.new).toBe(recorded("reservedLiteral"));
      // A zone id is not a destination on either relay.
      ask.mockClear();
      const zoned = await refused(relay, "[fe80::1%25eth0]:80");

      expect(outcomes).toEqual(Object.fromEntries(spellings.map((spelling) => [spelling, recorded("reservedLiteral")])));
      expect(zoned).toMatch(/^HTTP\/1\.1 40[03] /u);
      expect(ask).not.toHaveBeenCalled();
      expect(router).not.toHaveBeenCalled();
      expect(upstream.connects).toEqual([]);
    });

    it("P21: a loopback literal is asked about and then dialled", async () => {
      const echo = net.createServer((socket) => { socket.on("error", () => {}); socket.pipe(socket); });
      await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done));
      cleanups.push(() => new Promise<void>((done) => { echo.close(() => done()); }));
      const port = (echo.address() as net.AddressInfo).port;
      const ask = vi.fn<Ask>(async () => true);
      await start({ ask });
      const relay = await open();

      const tunnel = await openTunnel(relay, `127.0.0.1:${port}`);
      tunnel.socket.destroy();

      expect(ask.mock.calls.map(([destination, context]) => [destination.host, context.phase])).toEqual([["127.0.0.1", "name"], ["127.0.0.1", "resolved"]]);
    });

    it("P21: a private-use literal is asked about", async () => {
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "no" }));
      await start({ ask });
      const relay = await open();

      expect(await refused(relay, "10.0.0.5:443")).toBe(recorded("denied"));
      expect(ask.mock.calls.map(([destination]) => destination.host)).toEqual(["10.0.0.5"]);
    });

    it("P5: a name that resolves to an allowed loopback address is still refused on a relay listener's port", async () => {
      const held = net.createServer();
      await new Promise<void>((done) => held.listen(0, "127.0.0.1", done));
      cleanups.push(() => new Promise<void>((done) => { held.close(() => done()); }));
      const port = (held.address() as net.AddressInfo).port;
      await start({ ask: async () => true, allow: [`127.0.0.1:${port}`], resolve: resolverFor({ "hop.example": ["127.0.0.1"] }) });
      const relay = await open();
      relay.registerPort(port);

      expect(await refused(relay, `hop.example:${port}`)).toBe(recorded("relayListener"));
    });

    it("P4: when the origin dies in the middle of a body, the client's connection is closed", async () => {
      const origin = net.createServer((socket) => {
        socket.on("error", () => {});
        socket.once("data", () => {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial", () => socket.destroy());
        });
      });
      await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
      cleanups.push(() => new Promise<void>((done) => { origin.close(() => done()); }));
      const port = (origin.address() as net.AddressInfo).port;
      await start({ ask: async () => true });
      const relay = await open();

      const client = send(relay.port, `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: ${relay.proxyAuthorization}\r\n\r\n`);
      let closed = false;
      client.socket.once("close", () => { closed = true; });

      await expect.poll(client.output).toContain("partial");
      await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    });

    it("P21: a reserved literal on the allow list", async () => {
      const upstream = await startUpstream();
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "asked" }));
      await start({ ask, allow: ["169.254.169.254:80"], router: upstream.router });
      const relay = await open();

      const client = connect(relay, "169.254.169.254:80");
      await expect.poll(client.output).toContain("\r\n\r\n");

      expect(/ 200 /u.test(client.statusLine()) ? "tunnelled" : client.statusLine()).toBe(recorded("allowedReservedLiteral"));
      expect(ask).not.toHaveBeenCalled();
    });

    const unbound = (port: number): Promise<boolean> => new Promise((done) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); done(false); });
      socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
    });
    const hopOutcome = async (relay: { port: number; proxyAuthorization: string }, ask: ReturnType<typeof vi.fn<Ask>>, port: number): Promise<string> => {
      ask.mockClear();
      const status = await refused(relay, `127.0.0.1:${port}`);
      return ask.mock.calls.length > 0 ? "asked" : status;
    };
    const forwardingPort = async (): Promise<number> => {
      const front = net.createServer();
      await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
      cleanups.push(() => new Promise<void>((done) => { front.close(() => done()); }));
      return (front.address() as net.AddressInfo).port;
    };

    it("P24, per-invocation route: an ended relay frees its port and its forwarding ports at once", async () => {
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "asked" }));
      await start({ ask, endedPortHold: { ms: 1500, maxMs: 6000 } });
      const ended = await open();
      const frontPort = await forwardingPort();
      ended.registerPort(frontPort);
      await ended.close();
      const relay = await open();

      expect(await unbound(ended.port)).toBe(true);
      expect([await hopOutcome(relay, ask, ended.port), await hopOutcome(relay, ask, frontPort)]).toEqual([recorded("endedPortHop"), recorded("endedPortHop")]);
    });

    it.runIf(adapter.name === "new")("P24, wrapped-command route: an ended relay's ports are held back, then its port number is retired", async () => {
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "asked" }));
      await start({ ask, endedPortHold: { ms: 1500, maxMs: 6000 } });
      const ended = await open(newToken(), undefined, "wrapped-command");
      const frontPort = await forwardingPort();
      ended.registerPort(frontPort);
      await ended.close();
      const relay = await open();

      expect([await hopOutcome(relay, ask, ended.port), await hopOutcome(relay, ask, frontPort)]).toEqual([HELD, HELD]);
      // The held port is still bound, and answers nothing.
      const late = connect({ port: ended.port, proxyAuthorization: ended.proxyAuthorization }, "asked.example:443");
      await expect.poll(() => late.socket.destroyed).toBe(true);
      expect(late.output()).toBe("");

      // After the hold the port is unbound, its number stays refused, and the forwarding port is an ordinary port again.
      await expect.poll(() => unbound(ended.port), { timeout: 8000, interval: 100 }).toBe(true);
      expect(await hopOutcome(relay, ask, ended.port)).toBe(HELD);
      expect(await hopOutcome(relay, ask, frontPort)).toBe("asked");
    });

    it.runIf(adapter.name === "new")("P24, wrapped-command route: a retired port number is never given to a later relay", async () => {
      await start({ ask: async () => true, endedPortHold: { ms: 200, maxMs: 1000 } });
      const ended = await open(newToken(), undefined, "wrapped-command");
      await ended.close();
      await expect.poll(() => unbound(ended.port), { timeout: 8000, interval: 100 }).toBe(true);
      // The next listener is told it got the retired number once.
      const address = vi.spyOn(net.Server.prototype, "address").mockImplementationOnce(() => ({ address: "127.0.0.1", family: "IPv4", port: ended.port }));

      const relay = await open();
      address.mockRestore();

      expect(relay.port).not.toBe(ended.port);
      expect(await refused({ port: relay.port }, "asked.example:443")).toBe(recorded("unauthenticated"));
    });

    it.runIf(adapter.name === "new")("P24, wrapped-command route: opening fails when only retired port numbers come back", async () => {
      await start({ ask: async () => true, maxRelays: 1, endedPortHold: { ms: 200, maxMs: 1000 } });
      const ended = await open(newToken(), undefined, "wrapped-command");
      await ended.close();
      await expect.poll(() => unbound(ended.port), { timeout: 8000, interval: 100 }).toBe(true);
      const address = vi.spyOn(net.Server.prototype, "address").mockImplementation(() => ({ address: "127.0.0.1", family: "IPv4", port: ended.port }));

      const failed = adapter.open(newToken()).then(() => "opened", (error: Error) => error.message);
      await expect(failed).resolves.toBe("egress relay: no port outside the retired ones");
      address.mockRestore();
      // The same failure under an admission, whose owner closes later: nothing is left unhandled meanwhile.
      const retiredAgain = vi.spyOn(net.Server.prototype, "address").mockImplementation(() => ({ address: "127.0.0.1", family: "IPv4", port: ended.port }));
      let adopted: (() => Promise<void>) | undefined;
      const admission: InvocationProxyAdmission = {
        signal: new AbortController().signal,
        assertCanBind: () => {},
        acceptsConnections: () => true,
        adopt: (close) => { adopted = close; },
      };
      await expect(adapter.open(newToken(), admission)).rejects.toThrow("egress relay: no port outside the retired ones");
      retiredAgain.mockRestore();
      await new Promise((done) => setTimeout(done, 100));
      await adopted?.();

      // The failed relays left nothing behind: the one slot is free.
      const relay = await open();
      expect(relay.port).not.toBe(ended.port);
    });

    it.runIf(adapter.name === "new")("P24, wrapped-command route: held relays count toward the relay limit", async () => {
      await start({ ask: async () => true, maxRelays: 2, endedPortHold: { ms: 1500, maxMs: 6000 } });
      const ended = await open(newToken(), undefined, "wrapped-command");
      await open();
      await ended.close();

      await expect(adapter.open(newToken())).rejects.toThrow(/too many invocation relays/u);
      await expect.poll(() => unbound(ended.port), { timeout: 8000, interval: 100 }).toBe(true);
      await open();
    });

    it.runIf(adapter.name === "new")("P24, wrapped-command route: stopping the service frees held ports and forgets retired ones", async () => {
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "asked" }));
      startEgressRelayService({ ask, endedPortHold: { "wrapped-command": { ms: 200, maxMs: 1000 } } });
      const retired = await openEgressRelay(newToken(), undefined, "wrapped-command");
      await retired.close();
      await expect.poll(() => unbound(retired.port), { timeout: 8000, interval: 100 }).toBe(true);
      await stopEgressRelayService();
      startEgressRelayService({ ask, endedPortHold: { "wrapped-command": { ms: 60_000, maxMs: 120_000 } } });
      cleanups.push(stopEgressRelayService);
      const held = await openEgressRelay(newToken(), undefined, "wrapped-command");
      await held.close();
      expect(await unbound(held.port)).toBe(false);

      await stopEgressRelayService();

      expect(await unbound(held.port)).toBe(true);
      startEgressRelayService({ ask });
      const relay = await open();
      expect([await hopOutcome(relay, ask, held.port), await hopOutcome(relay, ask, retired.port)]).toEqual(["asked", "asked"]);
    });

    it.runIf(adapter.name === "new")("P24, wrapped-command route: a live process group extends the hold-back, up to the maximum", async () => {
      let alive = true;
      const groupAlive = vi.fn(() => alive);
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "asked" }));
      await start({ ask, endedPortHold: { ms: 500, maxMs: 1750, groupAlive } });
      const first = await openEgressRelay(newToken(), undefined, "wrapped-command");
      const second = await openEgressRelay(newToken(), undefined, "wrapped-command");

      await first.close({ processGroup: 4242 });
      await expect.poll(() => groupAlive.mock.calls.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      expect(groupAlive).toHaveBeenCalledWith(4242);
      expect(await unbound(first.port)).toBe(false);
      // The maximum ends it although the group still looks alive.
      await expect.poll(() => unbound(first.port), { timeout: 8000, interval: 50 }).toBe(true);

      alive = false;
      await second.close({ processGroup: 4243 });
      expect(await unbound(second.port)).toBe(false);
      await expect.poll(() => unbound(second.port), { timeout: 8000, interval: 50 }).toBe(true);
      expect(groupAlive).toHaveBeenCalledWith(4243);
    });

    it.runIf(adapter.name === "new")("ends the relay when its listener reports an error", async () => {
      const created = vi.spyOn(http, "createServer");
      await start({ ask: async () => true });
      const relay = await open();
      const server = created.mock.results.at(-1)?.value as http.Server;

      expect(() => server.emit("error", Object.assign(new Error("accept failed"), { code: "EMFILE" }))).not.toThrow();

      const late = connect(relay, "asked.example:443");
      await expect.poll(() => late.socket.destroyed).toBe(true);
      expect(late.output()).toBe("");
    });

    it("answers a request whose header is too large before closing", async () => {
      await start({ ask: async () => true });
      const relay = await open();

      const client = send(relay.port, `CONNECT asked.example:443 HTTP/1.1\r\nHost: asked.example:443\r\nProxy-Authorization: ${relay.proxyAuthorization}\r\nX-Fill: ${"a".repeat(20_000)}\r\n\r\n`);
      await expect.poll(client.output).toContain("\r\n\r\n");

      expect(client.statusLine()).toBe(recorded("oversizedHeader"));
    });

    it("P9: a refusal is recorded under the invocation and reaches the deny monitor", async () => {
      const emit = vi.fn(async () => {});
      cleanups.push(await startEgressDenyMonitor({ subscribe: adapter.subscribe, emit, capability: () => ({ kind: "none", confidence: "low" }) as never }));
      await start({ ask: async () => ({ allow: false, reason: "no" }), resolve: resolverFor({}) });
      const token = newToken();
      const relay = await open(token);
      const records: AsrtViolationRecord[] = [];
      cleanups.push(await adapter.subscribe((violations) => { records.splice(0, records.length, ...violations); }));

      await refused(relay, "denied.example:443");
      relay.recordRefusal("localhost", "loopback destination");

      // The record tail outlives a restart, so only this invocation's rows are compared.
      const mine = records.map((record) => [record.line, Buffer.from(record.encodedCommand ?? "", "base64").toString()]).filter(([, key]) => key === token);
      expect(mine).toEqual([
        ["deny network-outbound denied.example:443 (no)", token],
        ["deny http-request CONNECT localhost (loopback destination)", token],
      ]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        deny: expect.objectContaining({ action: "network-outbound", host: "denied.example", port: 443, reason: "no" }),
        invocation: expect.objectContaining({ kind: "worker" }),
      }));
    });

    it("P10: revoking one invocation's destination closes its tunnels and no other", async () => {
      const upstream = await startUpstream();
      await start({ ask: async () => true, router: upstream.router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const token = newToken();
      const relay = await open(token);
      const other = await open();
      const revokedTunnel = await openTunnel(relay, "asked.example:443");
      const otherPort = await openTunnel(relay, "asked.example:8443");
      const otherInvocation = await openTunnel(other, "asked.example:443");

      expect(adapter.closeConnections([token], "asked.example", 443)).toBe(1);

      await expect.poll(() => revokedTunnel.socket.destroyed).toBe(true);
      await expect.poll(() => upstream.sockets.size).toBe(2);
      expect(otherPort.socket.destroyed).toBe(false);
      expect(otherInvocation.socket.destroyed).toBe(false);
      expect(adapter.closeConnections([token], "asked.example", 443)).toBe(0);
    });

    it("P11: an upstream change closes every open tunnel, and new traffic takes the new route", async () => {
      const first = await startUpstream();
      const second = await startUpstream();
      let port = first.port;
      let generation = 0;
      const router: EgressRelayRouter = Object.assign(
        async () => ({ routes: [{ kind: "http" as const, host: "127.0.0.1", port }] }),
        { generation: () => generation },
      );
      await start({ ask: async () => true, router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const relay = await open();
      const other = await open();
      const old = [await openTunnel(relay, "asked.example:443"), await openTunnel(other, "asked.example:443")];

      port = second.port;
      generation++;
      expect(adapter.closeAll()).toBe(2);

      for (const tunnel of old) await expect.poll(() => tunnel.socket.destroyed).toBe(true);
      await openTunnel(relay, "asked.example:443");
      expect(first.connects).toHaveLength(2);
      expect(second.connects).toHaveLength(1);
    });

    it("P12: the upstream's credentials go to the upstream only, and an upstream that wants others is a refusal", async () => {
      const upstream = await startUpstream();
      const locked = await startUpstream(407);
      let target = upstream.port;
      const router: EgressRelayRouter = async () => ({
        routes: [
          { kind: "http", host: "127.0.0.1", port: target, auth: { username: "alice", password: "example" } },
          ...(target === upstream.port ? [] : [{ kind: "http" as const, host: "127.0.0.1", port: upstream.port }]),
        ],
      });
      await start({ ask: async () => true, router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const relay = await open();

      const tunnel = await openTunnel(relay, "asked.example:443");
      target = locked.port;

      expect(upstream.connects[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("alice:example").toString("base64")}\r\n`);
      expect(upstream.connects[0]).not.toContain(relay.proxyAuthorization);
      expect(tunnel.output()).not.toContain("alice");
      expect(await refused(relay, "asked.example:443")).toBe(recorded("upstreamAuth"));
      // P26: the refusal is final, the next route is not tried.
      expect(upstream.connects).toHaveLength(1);
    });

    it("P12: a route that cannot be reached falls over to the next one", async () => {
      const upstream = await startUpstream();
      const dead = net.createServer();
      await new Promise<void>((done) => dead.listen(0, "127.0.0.1", done));
      const deadPort = (dead.address() as net.AddressInfo).port;
      await new Promise<void>((done) => dead.close(() => done()));
      const router: EgressRelayRouter = async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: deadPort }, { kind: "http", host: "127.0.0.1", port: upstream.port }] });
      await start({ ask: async () => true, router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const relay = await open();

      await openTunnel(relay, "asked.example:443");

      expect(upstream.connects).toHaveLength(1);
    });

    it("P13: a closed relay drops its tunnels, accepts nothing, and its token cannot open another", async () => {
      const upstream = await startUpstream();
      await start({ ask: async () => true, router: upstream.router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const token = newToken();
      const relay = await open(token);
      const tunnel = await openTunnel(relay, "asked.example:443");

      await relay.close();

      await expect.poll(() => tunnel.socket.destroyed).toBe(true);
      await expect.poll(() => upstream.sockets.size).toBe(0);
      const late = connect(relay, "asked.example:443");
      await expect.poll(() => late.socket.destroyed).toBe(true);
      expect(late.output()).toBe("");
      await expect(adapter.open(token)).rejects.toThrow(recorded("reusedToken"));
    });

    it("P13: an aborted admission stops every forward at once and adopts the close", async () => {
      const upstream = await startUpstream();
      await start({ ask: async () => true, router: upstream.router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const abort = new AbortController();
      let adopted: (() => Promise<void>) | undefined;
      let admitted = false;
      const admission: InvocationProxyAdmission = {
        signal: abort.signal,
        assertCanBind: () => abort.signal.throwIfAborted(),
        acceptsConnections: () => admitted,
        adopt: (close) => { adopted = close; },
      };
      const relay = await open(newToken(), admission);
      expect(adopted).toBeTypeOf("function");
      const early = connect(relay, "asked.example:443");
      await expect.poll(() => early.socket.destroyed).toBe(true);
      admitted = true;
      const tunnel = await openTunnel(relay, "asked.example:443");

      abort.abort();

      await expect.poll(() => tunnel.socket.destroyed).toBe(true);
      expect(await refused(relay, "asked.example:443").catch(() => "closed")).not.toMatch(/ 200 /u);
      await expect(adapter.open(newToken(), admission)).rejects.toThrow();
    });

    it("P14: without an ask callback nothing unlisted is reachable", async () => {
      if (adapter.name === "new") {
        expect(() => startEgressRelayService({ ask: undefined as unknown as Ask })).toThrow(/ask callback is required/u);
        await expect(openEgressRelay(newToken())).rejects.toThrow(recorded("openBeforeStart"));
        return;
      }
      await start({ resolve: resolverFor({}) });
      const relay = await open();
      expect(`${(await refused(relay, "asked.example:443")).slice("HTTP/1.1 ".length)}`).toBe(recorded("noAskCallback"));
    });

    it("P15: a relay cannot be opened before the service is started", async () => {
      await expect(adapter.open(newToken())).rejects.toThrow(recorded("openBeforeStart"));
    });

    // Today's limit is the same constant (the package manager module's MAX_INVOCATION_LISTENERS); opening 4096 listeners is not a unit test.
    it.runIf(adapter.name === "new")("P16: the relay limit is enforced", async () => {
      await start({ ask: async () => true, maxRelays: 2 });
      await open();
      const second = await open();

      await expect(adapter.open(newToken())).rejects.toThrow(/too many invocation relays/u);
      await second.close();
      await open();
    });

    it("P17: the reply reaches a client behind the forwarding listener unchanged", async () => {
      const upstream = await startUpstream();
      await start({ ask: async () => true, router: upstream.router, resolve: resolverFor({ "asked.example": [PUBLIC] }) });
      const relay = await open();
      const front = await openInvocationProxyListener({ upstream: () => ({ host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }) });
      cleanups.push(front.close);
      relay.registerPort(front.port);

      const tunnel = await openTunnel(front, "asked.example:443");

      expect(tunnel.statusLine()).toBe(recorded("connectReply"));
    });

    it("P18: an allow entry admits its port only", async () => {
      const upstream = await startUpstream();
      const ask = vi.fn<Ask>(async () => ({ allow: false, reason: "no" }));
      await start({ ask, allow: ["allowed.example:443", "*.wild.example:443"], router: upstream.router, resolve: resolverFor({ "allowed.example": [PUBLIC], "a.wild.example": [PUBLIC] }) });
      const relay = await open();

      await openTunnel(relay, "allowed.example:443");
      await openTunnel(relay, "a.wild.example:443");
      expect(ask).not.toHaveBeenCalled();
      expect(await refused(relay, "allowed.example:22")).toBe(recorded("denied"));
      expect(await refused(relay, "a.wild.example:8443")).toBe(recorded("denied"));
      expect(await refused(relay, "wild.example:443")).toBe(recorded("denied"));
      expect(ask.mock.calls.map(([destination]) => `${destination.host}:${destination.port}`)).toEqual(["allowed.example:22", "a.wild.example:8443", "wild.example:443"]);
    });

    it("P18: an allow entry without a port", async () => {
      if (adapter.name === "new") {
        expect(() => startEgressRelayService({ ask: async () => true, allow: ["allowed.example"] })).toThrow(/needs host:port/u);
        return;
      }
      const upstream = await startUpstream();
      const ask = vi.fn<Ask>(async () => false);
      await start({ ask, allow: ["allowed.example"], router: upstream.router, resolve: resolverFor({ "allowed.example": [PUBLIC] }) });
      const relay = await open();
      await openTunnel(relay, "allowed.example:443");
      await openTunnel(relay, "allowed.example:22");
      expect(ask).not.toHaveBeenCalled();
    });

    it("refuses a client that does not present the relay's own credential", async () => {
      const ask = vi.fn<Ask>(async () => true);
      await start({ ask, resolve: resolverFor({}) });
      const relay = await open();
      const other = await open();

      expect(await refused({ port: relay.port }, "asked.example:443")).toBe(recorded("unauthenticated"));
      expect(await refused({ port: relay.port, proxyAuthorization: other.proxyAuthorization }, "asked.example:443")).toBe(recorded("unauthenticated"));
      expect(ask).not.toHaveBeenCalled();
    });

    it("refuses its own secret under another invocation's name, and an ended relay's credential", async () => {
      const ask = vi.fn<Ask>(async () => true);
      await start({ ask, resolve: resolverFor({}) });
      const relay = await open();
      const ended = await open();
      const [, secret] = Buffer.from(relay.proxyAuthorization.slice("Basic ".length), "base64").toString().split(":");
      const [otherName] = Buffer.from(ended.proxyAuthorization.slice("Basic ".length), "base64").toString().split(":");
      const renamed = `Basic ${Buffer.from(`${otherName}:${secret}`).toString("base64")}`;
      await ended.close();

      expect(await refused({ port: relay.port, proxyAuthorization: renamed }, "asked.example:443")).toBe(recorded("otherInvocationName"));
      expect(await refused({ port: relay.port, proxyAuthorization: ended.proxyAuthorization }, "asked.example:443")).toBe(recorded("unauthenticated"));
      expect(ask).not.toHaveBeenCalled();
    });

    it("refuses a CONNECT target that is not host:port", async () => {
      const ask = vi.fn<Ask>(async () => true);
      await start({ ask, resolve: resolverFor({}) });
      const relay = await open();

      expect(await refused(relay, "asked.example")).toMatch(/^HTTP\/1\.1 400 /u);
      expect(ask).not.toHaveBeenCalled();
    });
  });
});
