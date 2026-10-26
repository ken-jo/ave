import net, { type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as policyHome from "../../shared/policy-home.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { SandboxManager, type SandboxAskCallback, type ParentProxyRouter } from "@anthropic-ai/sandbox-runtime";
import {
  closeAllEgressConnections,
  closeEgressConnections,
  initializeAsrtSandbox,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";
import { openInvocationProxyListener } from "../egress-invocation-listener.js";
import { openHostEgressListener } from "../egress-host-listener.js";
import { EgressGrantStore, egressGrantScopesFor } from "../egress-grants.js";
import { prepareMxcShellLaunch } from "../../tools/mxc-shell-launch.js";

vi.mock("../mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`,
}));

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);
const DESTINATION = { host: "203.0.113.10", port: 443, network: "public" as const };
const sockets: Socket[] = [];
const servers: net.Server[] = [];
const listeners: Array<{ close(): Promise<void> }> = [];
const policyFixture = useTempDirs("relay-stamp-floor-");

beforeEach(() => {
  vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([policyFixture()]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  await resetAsrtSandbox();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function track(socket: Socket): Socket {
  sockets.push(socket);
  socket.on("error", () => {});
  socket.setTimeout(3_000, () => socket.destroy(new Error("Timed out")));
  return socket;
}

function exchange(socket: Socket, request: string, complete = (text: string) => text.includes("\r\n\r\n")): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("Connection closed"));
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (complete(text)) { cleanup(); resolve(text); }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(request);
  });
}

async function localProxy() {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    track(socket);
    let head = "";
    let connected = false;
    socket.on("data", (chunk) => {
      if (connected) {
        received.push(chunk.toString());
        socket.write(chunk);
        return;
      }
      head += chunk.toString();
      if (!head.includes("\r\n\r\n")) return;
      connected = true;
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: (server.address() as AddressInfo).port, received };
}

const connectRequest = (host = DESTINATION.host, port = DESTINATION.port) =>
  `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`;

function forceFirstPort(port: number) {
  const original = net.Server.prototype.listen;
  const bound: number[] = [];
  let injected = false;
  const spy = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
    if (!injected && args[0] === 0) {
      injected = true;
      args[0] = port;
    }
    this.once("listening", () => bound.push((this.address() as AddressInfo).port));
    return Reflect.apply(original, this, args);
  } as typeof original);
  return { bound, restore: () => spy.mockRestore() };
}

async function expectPortClosed(port: number) {
  const socket = track(net.connect(port, "127.0.0.1"));
  const accepted = await new Promise<boolean>((resolve) => {
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  expect(accepted).toBe(false);
}

it("discards a frontend bind forced into the shared range before accepting requests", async () => {
  const proxy = await localProxy();
  const forced = forceFirstPort(60088);
  const listener = await openInvocationProxyListener({
    upstream: () => ({ host: "127.0.0.1", port: proxy.port, proxyAuthorization: "Basic cmV2aWV3OnRlc3Q=" }),
  });
  listeners.push(listener);
  forced.restore();
  expect(forced.bound[0]).toBe(60088);
  expect(forced.bound.length).toBeGreaterThanOrEqual(2);
  expect(listener.port < 60080 || listener.port > 60089).toBe(true);
  await expectPortClosed(60088);
  expect(await exchange(track(net.connect(listener.port, "127.0.0.1")), connectRequest())).toMatch(/^HTTP\/1\.1 200/u);
});

type LaneKind = "listener" | "launcher";

async function lane(token: string, kind: LaneKind) {
  if (kind === "launcher") {
    const launch = await prepareMxcShellLaunch({
      egressToken: token,
      commandLine: "cmd.exe /d /c echo hi",
      cwd: String.raw`C:\work\repo`,
      filesystem: { allowWrite: [String.raw`C:\work\repo`], allowRead: [], denyRead: [], denyWrite: [] },
      env: { SYSTEMROOT: String.raw`C:\Windows`, LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local` },
      timeoutMs: 5_000,
      exists: () => true,
    });
    listeners.push({ close: launch.release });
    return { port: launch.proxyPort };
  }
  const relay = await openHostEgressListener(token);
  listeners.push(relay);
  const listener = await openInvocationProxyListener({
    upstream: () => ({ host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }),
    onRefused: relay.recordRefusal,
  });
  listeners.push(listener);
  relay.registerPort(listener.port);
  return listener;
}

async function initialize(upstreamRouter: ParentProxyRouter, callback: SandboxAskCallback = async () => true) {
  await initializeAsrtSandbox({
    allowedDomains: [], strictAllowlist: false,
    windows: { externalConfinement: true }, upstreamRouter,
  }, callback);
}

// The host relay and proxy-only initialization are Windows-only contracts.
describe.skipIf(process.platform !== "win32")("container proxy regression coverage", () => {
  it("excludes the configured range from relay binds and frontend registration", async () => {
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true, proxyPortRange: [42000, 42009] } });
    const forced = forceFirstPort(42008);
    const relay = await openHostEgressListener(TOKEN_A);
    listeners.push(relay);
    forced.restore();
    expect(forced.bound[0]).toBe(42008);
    expect(relay.port < 42000 || relay.port > 42009).toBe(true);
    await expectPortClosed(42008);
    expect(() => relay.registerPort(42005)).toThrow("shared proxy range");
  });

  it("discards a relay bind in the shared range and keeps both launcher ports outside it", async () => {
    const proxy = await localProxy();
    await initialize(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: proxy.port }] }));
    const forced = forceFirstPort(60088);
    const listener = await lane(TOKEN_A, "launcher");
    forced.restore();
    expect(forced.bound[0]).toBe(60088);
    expect(forced.bound).toHaveLength(3);
    expect(forced.bound.slice(1).every((port) => port < 60080 || port > 60089)).toBe(true);
    expect(listener.port).toBe(forced.bound[2]);
    await expectPortClosed(60088);
    expect(await exchange(track(net.connect(listener.port, "127.0.0.1")), connectRequest())).toMatch(/^HTTP\/1\.1 200/u);
  });

  it.each(["listener", "launcher"] as const)("revokes live tunnels and stops echo through the %s path", async (kind) => {
    const proxy = await localProxy();
    const subject = { token: TOKEN_A, sessionId: "review", tabId: undefined, projectRoot: undefined, origin: "shell" as const };
    const grants = new EgressGrantStore(join(process.env.AVE_HOME!, "review-grants.json"));
    await grants.grant("session", ["session"], subject, DESTINATION);
    await initialize(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: proxy.port, resolvesNames: true }] }),
      async (request, context) => {
        if (context?.attributionKey !== TOKEN_A || request.host !== DESTINATION.host || request.port !== DESTINATION.port) return false;
        const scope = await grants.matchingScope(subject, DESTINATION, egressGrantScopesFor("kernel-channel", subject.origin));
        if (!scope) return false;
        if (context.phase === "resolved") grants.noteUse(scope, subject, DESTINATION);
        return true;
      });
    const listener = await lane(TOKEN_A, kind);
    const client = track(net.connect(listener.port, "127.0.0.1"));
    expect(await exchange(client, connectRequest())).toMatch(/^HTTP\/1\.1 200/u);
    expect(await exchange(client, "before-revoke", (text) => text.includes("before-revoke"))).toBe("before-revoke");
    const revoked = await grants.revoke({ scope: "session", sessionId: "review", ...DESTINATION });
    expect(revoked.tokens).toEqual([TOKEN_A]);
    expect(closeEgressConnections(revoked.tokens, DESTINATION.host, DESTINATION.port)).toBeGreaterThanOrEqual(1);
    // Install the observer before yielding to socket destruction, then try data.
    const after = exchange(client, "after-revoke", (text) => text.includes("after-revoke"));
    await expect(after).rejects.toThrow();
    await expect.poll(() => client.destroyed).toBe(true);
    expect(proxy.received).toEqual(["before-revoke"]);
  });

  it.each(["listener", "launcher"] as const)("closes all old-route tunnels through the %s path", async (kind) => {
    const proxy = await localProxy();
    await initialize(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: proxy.port }] }));
    const listener = await lane(TOKEN_A, kind);
    const client = track(net.connect(listener.port, "127.0.0.1"));
    expect(await exchange(client, connectRequest())).toMatch(/^HTTP\/1\.1 200/u);
    expect(closeAllEgressConnections()).toBeGreaterThanOrEqual(1);
    await expect(exchange(client, "after-change", (text) => text.includes("after-change"))).rejects.toThrow();
    await expect.poll(() => client.destroyed).toBe(true);
    expect(proxy.received).toEqual([]);
  });

  it.each(["listener", "launcher"] as const)("refuses chaining A through B without attributing B through the %s path", async (kind) => {
    const proxy = await localProxy();
    const attribution: string[] = [];
    let routeCalls = 0;
    let portB = 0;
    await initialize(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: ++routeCalls === 1 ? portB : proxy.port, resolvesNames: true }] }),
      async (_request, context) => {
        attribution.push(context?.attributionKey === TOKEN_A ? "A" : context?.attributionKey === TOKEN_B ? "B" : "unknown");
        return true;
      });
    portB = (await lane(TOKEN_B, kind)).port;
    const a = await lane(TOKEN_A, kind);
    expect(await exchange(track(net.connect(a.port, "127.0.0.1")), connectRequest())).toMatch(/^HTTP\/1\.1 403/u);
    expect(routeCalls).toBe(1);
    expect(attribution).toEqual(["A"]);
    expect(attribution).not.toContain("B");
    expect(proxy.received).toEqual([]);
  });

  it.each([
    { endpoint: "frontend", route: "upstream" },
    { endpoint: "relay", route: "upstream" },
    { endpoint: "frontend", route: "destination" },
    { endpoint: "relay", route: "destination" },
  ] as const)("registers B's $endpoint port in the $route guard", async ({ endpoint, route }) => {
    const attribution: string[] = [];
    let portB = 0;
    await initialize(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: portB, resolvesNames: true }] }),
      async (_request, context) => { attribution.push(context?.attributionKey ?? "unknown"); return true; });
    const b = await openHostEgressListener(TOKEN_B);
    listeners.push(b);
    const frontend = await openInvocationProxyListener({
      upstream: () => ({ host: "127.0.0.1", port: b.port, proxyAuthorization: b.proxyAuthorization }),
    });
    listeners.push(frontend);
    b.registerPort(frontend.port);
    portB = endpoint === "frontend" ? frontend.port : b.port;
    const a = await openHostEgressListener(TOKEN_A);
    listeners.push(a);
    const request = (route === "destination" ? connectRequest("127.0.0.1", portB) : connectRequest())
      .replace("\r\n\r\n", `\r\nProxy-Authorization: ${a.proxyAuthorization}\r\n\r\n`);
    expect(await exchange(track(net.connect(a.port, "127.0.0.1")), request)).toMatch(/^HTTP\/1\.1 403/u);
    expect(attribution).not.toContain(TOKEN_B);
    expect(SandboxManager.getSandboxViolationStore().getViolationsForCommand(TOKEN_A).at(-1)?.line)
      .toContain("sandbox proxy listener");
  });
});
