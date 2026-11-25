// The two contained routes, driven through the entry points their owners call: a shell's launch and an extension's lease.
// Every row uses an address literal and a loopback upstream, so nothing is resolved and no destination traffic leaves this process.
import net from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareOwnedMxcShellLaunch } from "../../__tests__/support/contained-shell-launch.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import {
  closeEgressConnections,
  initializeAsrtSandbox,
  resetAsrtSandbox,
  subscribeAsrtViolations,
  type AsrtViolationRecord,
} from "../asrt-sandbox.js";
import { openMxcEgressLease } from "../egress-host-listener.js";
import { __resetIpv6HoldNoticeForTest } from "../egress-invocation-listener.js";
import { openEgressInvocation } from "../egress-invocations.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  setWindowsSandboxSubstrate,
} from "../sandbox-capability.js";

vi.mock("../mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => "C:\\Ave\\resources\\mxc\\x64\\wxc-exec.exe",
}));

const PUBLIC = "93.184.216.34";
const AUTHORITY = `${PUBLIC}:443`;
type AskAnswer = boolean | { allow: false; reason: string };
interface Asked {
  readonly host: string;
  readonly port: number;
  readonly phase: unknown;
  readonly identity: unknown;
  readonly attributionKey: unknown;
}

describe.skipIf(process.platform !== "win32").each(["shell", "extension"] as const)("contained %s route", (route) => {
  const policyFixture = useTempDirs("egress-route-parity-");
  const cleanups: Array<() => void | Promise<void>> = [];
  let asked: Asked[];
  let answer: (destination: { host: string; port: number }) => AskAnswer | Promise<AskAnswer>;
  let upstream: { port: number; connects: string[]; sockets: Set<net.Socket> };
  let violations: AsrtViolationRecord[];

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([policyFixture()]);
    asked = [];
    answer = () => true;
    violations = [];
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
        connects.push(head.split("\r\n")[0] ?? "");
        socket.off("data", onHead);
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
    upstream = { port: (server.address() as net.AddressInfo).port, connects, sockets };
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability(windowsProxyOnlyCapability());
    const { substrate } = planWindowsSandbox({
      shellRequested: true, shellLocalNetworkAccess: true, workerRequested: false,
      mxc: { state: "available" }, windowsBuild: "10.0.26300", srtWinReady: false,
    });
    setWindowsSandboxSubstrate(substrate, mxcShellCapability());
    await initializeAsrtSandbox({
      allowedDomains: [],
      strictAllowlist: false,
      windows: { externalConfinement: true },
      upstreamRouter: async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstream.port }] }),
    }, async (destination, context) => {
      asked.push({ host: destination.host, port: destination.port ?? 0, phase: context?.phase, identity: context?.identity, attributionKey: context?.attributionKey });
      return answer({ host: destination.host, port: destination.port ?? 0 });
    });
    const seen = new WeakSet<AsrtViolationRecord>();
    cleanups.push(await subscribeAsrtViolations((all) => {
      for (const violation of all) {
        if (seen.has(violation)) continue;
        seen.add(violation);
        violations.push(violation);
      }
    }));
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    await resetAsrtSandbox();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    vi.restoreAllMocks();
    if (failures.length > 0) throw new AggregateError(failures, "route parity teardown failed");
  });

  // The route's endpoint as the contained process gets it: a port, and no credential of its own.
  async function openRoute(): Promise<{ token: string; port: number; end(): void }> {
    if (route === "shell") {
      const invocation = openEgressInvocation({
        kind: "shell", toolName: "powershell", toolUseId: "route-parity", requiresListener: true,
        context: { sessionId: "conversation", workspaceRoot: policyFixture(), approvalSurface: "interactive" },
      });
      cleanups.push(invocation.release);
      const launch = await prepareOwnedMxcShellLaunch({
        egressToken: invocation.token,
        commandLine: "contained command",
        cwd: "C:\\work",
        filesystem: { allowRead: [], allowWrite: ["C:\\work"], denyRead: [], denyWrite: [] },
        env: { LOCALAPPDATA: "C:\\example\\AppData\\Local" },
        timeoutMs: 1_000,
        exists: () => true,
        list: () => [],
      });
      cleanups.push(launch.release);
      launch.activate();
      return { token: invocation.token, port: launch.proxyPort, end: invocation.release };
    }
    const invocation = openEgressInvocation({ kind: "worker", role: "worker", pluginId: "fixture", instanceId: "a" });
    cleanups.push(invocation.release);
    const lease = await openMxcEgressLease(invocation.token);
    cleanups.push(lease.close);
    return { token: invocation.token, port: lease.port, end: invocation.release };
  }

  function send(port: number, request: string) {
    let output = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => { output += chunk.toString("latin1"); });
    socket.on("error", () => {});
    cleanups.push(() => { socket.destroy(); });
    return { socket, output: () => output, statusLine: () => output.split("\r\n")[0] ?? "" };
  }

  // A client that names somebody else in its own proxy credential, as a contained process could.
  const connect = (port: number, authority = AUTHORITY) =>
    send(port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic Zm9yZ2Vk\r\n\r\n`);

  async function refusal(port: number, authority = AUTHORITY): Promise<string> {
    const client = connect(port, authority);
    await expect.poll(client.statusLine).toMatch(/^HTTP\/1\.[01] \d{3}/u);
    return client.statusLine();
  }

  const linesFor = (token: string): string[] => violations
    .filter((violation) => violation.encodedCommand === Buffer.from(token).toString("base64"))
    .map((violation) => violation.line);

  it("tunnels an allowed address under the route's own identity, asked by name and then as resolved", async () => {
    const opened = await openRoute();
    const client = connect(opened.port);
    await expect.poll(client.statusLine).toMatch(/^HTTP\/1\.[01] 200 /u);
    client.socket.write("ping");
    await expect.poll(client.output).toContain("ping");
    expect(asked).toEqual([
      { host: PUBLIC, port: 443, phase: "name", identity: "listener", attributionKey: opened.token },
      { host: PUBLIC, port: 443, phase: "resolved", identity: "listener", attributionKey: opened.token },
    ]);
    expect(upstream.connects).toEqual([`CONNECT ${AUTHORITY} HTTP/1.1`]);
    expect(linesFor(opened.token)).toEqual([]);
  });

  it("refuses a denied address with the callback's reason, records it for the route and dials nothing", async () => {
    answer = () => ({ allow: false, reason: "no" });
    const opened = await openRoute();
    expect(await refusal(opened.port)).toBe("HTTP/1.1 403 no");
    expect(asked.map(({ phase }) => phase)).toEqual(["name"]);
    expect(upstream.connects).toEqual([]);
    expect(linesFor(opened.token)).toEqual([`deny network-outbound ${AUTHORITY} (no)`]);
  });

  it("refuses a denied plain-HTTP request the same way", async () => {
    answer = () => ({ allow: false, reason: "no" });
    const opened = await openRoute();
    const client = send(opened.port, `GET http://${PUBLIC}/ HTTP/1.1\r\nHost: ${PUBLIC}\r\nConnection: close\r\n\r\n`);
    await expect.poll(client.statusLine).toBe("HTTP/1.1 403 Forbidden");
    expect(upstream.connects).toEqual([]);
    expect(linesFor(opened.token)).toEqual([`deny network-outbound ${PUBLIC}:80 (no)`]);
  });

  it("refuses when the callback throws or answers anything but true", async () => {
    const opened = await openRoute();
    answer = () => { throw new Error("prompt broke"); };
    expect(await refusal(opened.port)).toBe("HTTP/1.1 403 permission prompt failed");
    answer = () => "yes" as unknown as boolean;
    expect(await refusal(opened.port)).toBe("HTTP/1.1 403 user denied");
    expect(upstream.connects).toEqual([]);
  });

  it("refuses this host's loopback at the route's endpoint, before any ask", async () => {
    const opened = await openRoute();
    expect(await refusal(opened.port, `127.0.0.1:${upstream.port}`)).toBe("HTTP/1.1 403 Forbidden");
    expect(await refusal(opened.port, `127.0.0.1:${opened.port}`)).toBe("HTTP/1.1 403 Forbidden");
    expect(asked).toEqual([]);
    expect(upstream.connects).toEqual([]);
    expect(linesFor(opened.token)).toEqual([
      "deny http-request CONNECT 127.0.0.1 (loopback destination)",
      "deny http-request CONNECT 127.0.0.1 (loopback destination)",
    ]);
  });

  it("closes a live tunnel when its grant is revoked", async () => {
    const opened = await openRoute();
    const client = connect(opened.port);
    await expect.poll(client.statusLine).toMatch(/^HTTP\/1\.[01] 200 /u);
    expect(closeEgressConnections([opened.token], PUBLIC, 443)).toBe(1);
    await expect.poll(() => client.socket.destroyed).toBe(true);
    await expect.poll(() => upstream.sockets.size).toBe(0);
  });

  it("stops a live tunnel and asks nothing more once the invocation ends", async () => {
    const opened = await openRoute();
    const client = connect(opened.port);
    await expect.poll(client.statusLine).toMatch(/^HTTP\/1\.[01] 200 /u);
    opened.end();
    await expect.poll(() => client.socket.destroyed).toBe(true);
    await expect.poll(() => upstream.sockets.size).toBe(0);
    const before = asked.length;
    const late = connect(opened.port);
    await expect.poll(() => late.socket.destroyed || late.socket.closed).toBe(true);
    expect(late.output()).not.toMatch(/ 200 /u);
    expect(asked).toHaveLength(before);
  });

  it("never opens the route a second time for the same invocation", async () => {
    const opened = await openRoute();
    await expect(openMxcEgressLease(opened.token)).rejects.toThrow();
    expect(await refusal(opened.port)).toMatch(/^HTTP\/1\.[01] 200 /u);
  });

  // No spelling of a link-local or metadata address is a destination on these routes.
  it("refuses a reserved address literal before any ask", async () => {
    const opened = await openRoute();
    expect(await refusal(opened.port, "169.254.169.254:80")).toBe("HTTP/1.1 403 destination is a reserved address");
    expect(asked).toEqual([]);
    expect(upstream.connects).toEqual([]);
  });

  // What a connection attempt meets at a loopback address.
  function probe(host: string, port: number): Promise<string> {
    return new Promise((done) => {
      const socket = net.connect(port, host);
      socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
      socket.once("connect", () => socket.once("close", () => done("dropped")));
    });
  }

  // A contained process reaches the endpoint's port number on 127.0.0.1 and on [::1] alike, so the route owns both.
  it("holds the endpoint's port on both loopback addresses and serves only the IPv4 one", async () => {
    const opened = await openRoute();
    expect(await probe("::1", opened.port)).toBe("dropped");
    const foreign = net.createServer();
    const bind = await new Promise<string>((done) => {
      foreign.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
      foreign.listen({ host: "::1", port: opened.port, ipv6Only: true, exclusive: true }, () => foreign.close(() => done("bound")));
    });
    expect(bind).toBe("EADDRINUSE");
    expect(await refusal(opened.port)).toMatch(/^HTTP\/1\.[01] 200 /u);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("refuses to open when another listener has the endpoint's IPv6 loopback port, and leaves no IPv4 endpoint behind", async () => {
    const listen = net.Server.prototype.listen;
    const foreign = net.createServer((socket) => socket.destroy());
    cleanups.push(() => new Promise<void>((done) => { foreign.close(() => done()); }));
    let taken: number | undefined;
    // The other listener takes [::1]:P the moment the route asks for it.
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
      const options = args[0] as { host?: string; port?: number } | null;
      if (this === foreign || typeof options !== "object" || options === null || options.host !== "::1") {
        return listen.apply(this, args as Parameters<typeof listen>);
      }
      taken = options.port;
      listen.call(foreign, { host: "::1", port: options.port, ipv6Only: true, exclusive: true }, () => {
        listen.apply(this, args as Parameters<typeof listen>);
      });
      return this;
    });

    await expect(openRoute()).rejects.toThrow(/could not hold \[::1\]:\d+ \(EADDRINUSE\)/u);
    expect(taken).toBeTypeOf("number");
    await expect.poll(() => probe("127.0.0.1", taken ?? 0)).toBe("ECONNREFUSED");
    expect(asked).toEqual([]);
  });

  // The bind of [::1]:P fails with the given code instead of reaching the host.
  function failIpv6Hold(code: string): void {
    const listen = net.Server.prototype.listen;
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
      const options = args[0] as { host?: string } | null;
      if (typeof options !== "object" || options === null || options.host !== "::1") {
        return listen.apply(this, args as Parameters<typeof listen>);
      }
      queueMicrotask(() => this.emit("error", Object.assign(new Error(`listen ${code}`), { code })));
      return this;
    });
  }

  // A host with no IPv6 loopback address has nothing there for another process to own, so the endpoint opens without the hold.
  it.each(["EADDRNOTAVAIL", "EAFNOSUPPORT"])("opens without the IPv6 hold when the address is unavailable (%s), and says so once", async (code) => {
    __resetIpv6HoldNoticeForTest();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    failIpv6Hold(code);
    const first = await openRoute();
    expect(await refusal(first.port)).toMatch(/^HTTP\/1\.[01] 200 /u);
    expect(await probe("::1", first.port)).toBe("ECONNREFUSED");
    await openRoute();
    const lines = warned.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("IPv6 loopback"));
    expect(lines).toHaveLength(1);
  });

  it.each(["EADDRINUSE", "EACCES", "EINVAL"])("refuses to open when the IPv6 hold fails with %s", async (code) => {
    failIpv6Hold(code);
    await expect(openRoute()).rejects.toThrow(new RegExp(`could not hold \\[::1\\]:\\d+ \\(${code}\\)`, "u"));
    expect(asked).toEqual([]);
  });
});
