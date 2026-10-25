import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager, type SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { setDestinationResolverForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
import { connect, createServer, Server, Socket, type AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressAskCallback, type EgressApprovalAnswer, type EgressApprovalRequest } from "../egress-ask.js";
import { EgressGrantStore, type EgressGrantSubject } from "../egress-grants.js";
import { openEgressInvocation, type EgressInvocationOwner } from "../egress-invocations.js";
import { egressIdentityStrength } from "../egress-identity.js";
import { startEgressDenyMonitor } from "../egress-deny-monitor.js";
import { openHostEgressListener } from "../egress-host-listener.js";
import { prepareMxcShellLaunch } from "../../tools/mxc-shell-launch.js";
import type { SandboxEgressDecisionAuditEntry, SandboxEgressDenyAuditEntry } from "../../audit/sandbox-audit.js";
import { createUpstreamProxyRouter } from "../upstream-proxy.js";
import { DEFAULT_UPSTREAM_PROXY, type UpstreamProxySettings } from "../../shared/upstream-proxy.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { sandboxCasesRun } from "../../plugins/isolation/__tests__/sandbox-cases.js";

vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../asrt-sandbox.js")>(),
  getProtectedReadDenyFloor: () => [],
}));
vi.mock("../mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`,
}));

const DESTINATION = { host: "data.egress.example", port: 443 };
const TOKEN = "0123456789abcdef0123456789abcdef";
const SHELL: EgressInvocationOwner = {
  kind: "shell",
  toolName: "bash",
  toolUseId: "egress-tool",
  context: { sessionId: "egress-session", workspaceRoot: "/work/egress", approvalSurface: "interactive" },
};
const TERMINAL: EgressInvocationOwner = { kind: "terminal", tabId: "egress-tab" };
const GRANT_CASES = [
  { origin: "shell", scope: "once" },
  { origin: "shell", scope: "session" },
  { origin: "shell", scope: "always" },
  { origin: "terminal", scope: "once" },
  { origin: "terminal", scope: "tab" },
  { origin: "terminal", scope: "always" },
] as const;

const directories: string[] = [];

beforeEach(async (context) => {
  if (process.platform !== "win32" && !(await sandboxCasesRun())) context.skip("sandbox backend is unavailable");
});

afterEach(async () => {
  setDestinationResolverForTesting(undefined);
  await SandboxManager.reset();
  await Promise.all(directories.splice(0).map((directory) => cleanupTmpDir(directory)));
});

function approvalFixture(origin: "shell" | "terminal", invocationToken = TOKEN) {
  const directory = mkdtempSync(join(tmpdir(), "egress-class-routing-"));
  directories.push(directory);
  const grants = new EgressGrantStore(join(directory, "grants.json"));
  const requests: EgressApprovalRequest[] = [];
  const decisions: SandboxEgressDecisionAuditEntry[] = [];
  let time = Date.now();
  let answer = async (_request: EgressApprovalRequest): Promise<EgressApprovalAnswer> => ({ allow: false, reason: "destination refused" });
  const callback = createEgressAskCallback({
    identityStrength: egressIdentityStrength,
    ownerOf: (token) => token === invocationToken ? (origin === "shell" ? SHELL : TERMINAL) : undefined,
    abortSignalOf: () => undefined,
    workerAllowedDomains: () => [],
    grants,
    networkRule: async () => undefined,
    shellAskEnabled: () => true,
    requester: () => async (request) => {
      requests.push(request);
      return answer(request);
    },
    audit: (entry) => decisions.push(entry),
    now: () => new Date(time),
  });
  return {
    callback,
    grants,
    requests,
    decisions,
    advance(ms: number) { time += ms; },
    set answer(requester: typeof answer) { answer = requester; },
  };
}

function latch<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

// The recording server observes writes independently of the approval callback.
async function recordingUpstream() {
  const requests: string[] = [];
  let bytesReceived = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const handleData = (chunk: Buffer): void => {
      bytesReceived += chunk.length;
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.removeListener("data", handleData);
      requests.push(head.split("\r\n")[0]!);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    socket.on("data", handleData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    get bytesReceived() { return bytesReceived; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startProxy(callback: SandboxAskCallback) {
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  }, callback);
  const listener = await SandboxManager.openInvocationListener(TOKEN);
  const wrapped = await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId: TOKEN });
  const proxy = /(http:\/\/srt\.[^'"\s:@]+:[^'"\s@]+@[^'"\s/]+)/u.exec(wrapped)?.[1];
  if (proxy === undefined) throw new Error("Missing invocation proxy URL");
  const front = listener.port ?? listener.socketPath;
  if (front === undefined) throw new Error("Missing invocation listener");
  return { front, proxy: new URL(proxy) };
}

function wireRequest(
  lane: Awaited<ReturnType<typeof startProxy>>,
  method: "CONNECT" | "GET" = "CONNECT",
  destination = DESTINATION,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const handleConnect = (): void => {
      const auth = Buffer.from(`srt.${Buffer.from(TOKEN).toString("base64")}:${decodeURIComponent(lane.proxy.password)}`).toString("base64");
      const target = `${destination.host}:${destination.port}`;
      const line = method === "CONNECT" ? `CONNECT ${target} HTTP/1.1` : `GET http://${target}/ HTTP/1.1`;
      socket.write(`${line}\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`);
    };
    const socket = typeof lane.front === "number" ? connect(lane.front, "127.0.0.1", handleConnect) : connect(lane.front, handleConnect);
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n")) socket.destroy();
    });
    socket.setTimeout(3_000, () => socket.destroy(new Error("Invocation proxy request timed out")));
    socket.once("error", reject);
    socket.once("close", () => resolve(response.split("\r\n")[0] ?? ""));
  });
}

function routingFixture(port: number, initialMode: "off" | "manual" = "off") {
  let settings: UpstreamProxySettings = { ...DEFAULT_UPSTREAM_PROXY, mode: initialMode, manualUrl: `http://127.0.0.1:${port}` };
  const router = createUpstreamProxyRouter({ settings: () => settings, manualCredentials: () => null, env: () => ({}) });
  return {
    router: router.router,
    useUpstream(resolvesNames = false) {
      settings = { ...settings, mode: "manual", resolvesNames };
      router.invalidate();
    },
  };
}

function proxyOnlyConfig() {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    windows: { externalConfinement: "embedder" as const, proxyPortRange: [0, 0] as [number, number] },
  };
}

// The listener rejects Windows before sandbox initialization, so this contract does not require a live sandbox backend.
describe.runIf(process.platform === "win32")("egress grant class on Windows without a listener lane", () => {
  async function expectListenerRefusalWithoutNetworkActivity() {
    const listenSpy = vi.spyOn(Server.prototype, "listen");
    const connectSpy = vi.spyOn(Socket.prototype, "connect");
    try {
      await expect(SandboxManager.openInvocationListener(TOKEN)).rejects.toThrow(/not supported on windows/);
      expect(listenSpy).not.toHaveBeenCalled();
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      listenSpy.mockRestore();
      connectSpy.mockRestore();
    }
  }

  it("refuses to bind or connect before sandbox initialization", async () => {
    await expectListenerRefusalWithoutNetworkActivity();
  });

  it("refuses to open a per-invocation listener and asks nothing", async () => {
    let asked = 0;
    await SandboxManager.initialize(proxyOnlyConfig(), async () => { asked += 1; return true; });
    await expectListenerRefusalWithoutNetworkActivity();
    expect(asked).toBe(0);
  });
});

describe.runIf(process.platform === "win32")("egress grant class through the container lane", () => {
  async function initializeProxy(callback: SandboxAskCallback) {
    await SandboxManager.initialize(proxyOnlyConfig(), callback);
  }

  async function launchFor(token: string) {
    return prepareMxcShellLaunch({
      egressToken: token,
      commandLine: "cmd.exe /d /c echo hi",
      cwd: String.raw`C:\work\repo`,
      filesystem: { allowWrite: [String.raw`C:\work\repo`], allowRead: [], denyRead: [], denyWrite: [] },
      env: { SYSTEMROOT: String.raw`C:\Windows`, LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local` },
      timeoutMs: 5_000,
      exists: () => true,
    });
  }

  function laneFor(port: number) {
    // Deliberately supply a different username; the host listener must replace it.
    return { front: port, proxy: new URL("http://srt:client-supplied@127.0.0.1") };
  }

  it("approves and attributes the invocation through its host-owned listener", async () => {
    const approval = approvalFixture("shell");
    const upstream = await recordingUpstream();
    approval.answer = async () => ({ allow: true, scope: "once" });
    await initializeProxy(approval.callback);
    const launch = await launchFor(TOKEN);
    try {
      setDestinationResolverForTesting(async () => [{ address: "203.0.113.10", family: 4 }]);
      const routing = routingFixture(upstream.port, "manual");
      routing.useUpstream(true);
      SandboxManager.setParentProxyRouter(routing.router);
      expect(await wireRequest(laneFor(launch.proxyPort), "GET")).toMatch(/^HTTP\/1\.1 200/u);
      expect(approval.requests).toHaveLength(2);
      expect(approval.requests.every((request) => request.origin === "shell" && request.toolUseId === "egress-tool")).toBe(true);
      expect(approval.requests[0]?.scopes).toContain("always");
      expect(approval.decisions).toMatchObject([{ decision: "allow", invocation: { kind: "shell", toolUseId: "egress-tool" } }]);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await launch.release();
      await upstream.close();
    }
  });

  it("records a listener refusal in invocation output and network denials", async () => {
    const invocation = openEgressInvocation(SHELL);
    const approval = approvalFixture("shell", invocation.token);
    const rows: (SandboxEgressDenyAuditEntry | SandboxEgressDecisionAuditEntry)[] = [];
    const store = SandboxManager.getSandboxViolationStore();
    store.clear();
    const stop = await startEgressDenyMonitor({
      subscribe: async (listener) => store.subscribe(listener),
      emit: async (entry) => { rows.push(entry); },
      capability: () => ({ kind: "asrt", confidence: "verified" }),
    });
    await initializeProxy(approval.callback);
    const launch = await launchFor(invocation.token);
    try {
      expect(await wireRequest(laneFor(launch.proxyPort), "CONNECT", { host: "localhost", port: 443 }))
        .toMatch(/^HTTP\/1\.1 403/u);
      expect(approval.requests).toEqual([]);
      expect(store.getViolationsForCommand(invocation.token)).toHaveLength(1);
      expect(SandboxManager.annotateStderrWithSandboxFailures(invocation.token, "")).toContain("loopback destination");
      expect(rows.filter((row) => row.entryKind === "egress-deny")).toMatchObject([
        { invocation: { kind: "shell", toolUseId: "egress-tool" }, deny: { host: "localhost", reason: "loopback destination" } },
      ]);
      expect(rows.filter((row) => row.entryKind === "egress-decision")).toHaveLength(1);
    } finally {
      stop();
      await launch.release();
      invocation.release();
    }
  });

  it("masks refusal data before it enters the shared violation store", async () => {
    await initializeProxy(async () => true);
    const relay = await openHostEgressListener(TOKEN);
    const secret = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    try {
      relay.recordRefusal(`${secret}.example:443`, `refused ${secret}`);
      const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(TOKEN);
      expect(violations.at(-1)?.line).toContain("deny network-outbound");
      expect(violations.at(-1)?.line).not.toContain(secret);
      expect(violations.at(-1)?.line).toContain("REDACTED");
    } finally {
      await relay.close();
    }
  });

  it("refuses a shared proxy credential at the host relay without asking", async () => {
    const approval = approvalFixture("shell");
    await initializeProxy(approval.callback);
    const relay = await openHostEgressListener(TOKEN);
    try {
      const username = `srt.${Buffer.from(TOKEN).toString("base64")}`;
      const shared = new URL(`http://127.0.0.1:${relay.port}`);
      shared.username = username;
      shared.password = SandboxManager.getProxyAuthToken()!;
      expect(await wireRequest({ front: relay.port, proxy: shared })).toMatch(/^HTTP\/1\.1 407/u);
      expect(approval.requests).toEqual([]);
    } finally {
      await relay.close();
    }
  });

  it.each([
    { host: "127.0.0.1", rebind: false },
    { host: "relay.egress.example", rebind: false },
    { host: "relay.egress.example", rebind: true },
  ])("refuses a route chaining listener A to listener B by $host (rebind: $rebind)", async ({ host, rebind }) => {
    const approval = approvalFixture("shell");
    approval.answer = async () => ({ allow: true, scope: "once" });
    await initializeProxy(approval.callback);
    const first = await launchFor(TOKEN);
    const second = await launchFor("fedcba9876543210fedcba9876543210");
    let proxyLookups = 0;
    try {
      setDestinationResolverForTesting(async (name) => [{
        address: name === host && (!rebind || ++proxyLookups > 1) ? "127.0.0.1" : "203.0.113.10", family: 4,
      }]);
      SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "http", host, port: second.proxyPort, resolvesNames: !rebind }] }));
      expect(await wireRequest(laneFor(first.proxyPort), "GET")).toMatch(/^HTTP\/1\.1 403/u);
      expect(approval.requests).toHaveLength(host === "127.0.0.1" ? 1 : 2);
      expect(SandboxManager.getSandboxViolationStore().getViolationsForCommand(TOKEN).at(-1)?.line)
        .toContain("sandbox proxy listener");
      expect(SandboxManager.getSandboxViolationStore().getViolationsForCommand("fedcba9876543210fedcba9876543210"))
        .toHaveLength(0);
      if (rebind) expect(proxyLookups).toBeGreaterThan(1);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it("re-asks when the route changes from public to unverified before the dial", async () => {
    const approval = approvalFixture("shell");
    const upstream = await recordingUpstream();
    const routing = routingFixture(upstream.port);
    approval.answer = async (request) => request.network === "public"
      ? { allow: true, scope: "always" }
      : { allow: false, reason: "unverified destination refused" };
    let confirmations = 0;
    await initializeProxy(async (destination, context) => {
      const answer = await approval.callback(destination, context);
      if (context?.phase === "resolved" && ++confirmations === 1) routing.useUpstream(true);
      return answer;
    });
    const launch = await launchFor(TOKEN);
    try {
      setDestinationResolverForTesting(async () => [{ address: "203.0.113.10", family: 4 }]);
      SandboxManager.setParentProxyRouter(routing.router);
      expect(await wireRequest(laneFor(launch.proxyPort), "GET")).toMatch(/^HTTP\/1\.1 403/u);
      expect(approval.requests.map((request) => request.network)).toEqual(["public", "unverified"]);
      expect(approval.requests.at(-1)?.scopes).not.toContain("always");
      expect(confirmations).toBe(2);
      expect(upstream.bytesReceived).toBe(0);
    } finally {
      await launch.release();
      await upstream.close();
    }
  });
});

describe.runIf(process.platform !== "win32")("egress grant class across route replanning", () => {
  it.each(GRANT_CASES)("asks the requester before $origin $scope becomes unverified", async ({ origin, scope }) => {
    const approval = approvalFixture(origin);
    const upstream = await recordingUpstream();
    const routing = routingFixture(upstream.port);
    approval.answer = async (request) => request.network === "public"
      ? { allow: true, scope }
      : { allow: false, reason: "unverified destination refused" };
    let confirmations = 0;
    try {
      const lane = await startProxy(async (destination, context) => {
        const answer = await approval.callback(destination, context);
        if (context?.phase === "resolved" && ++confirmations === 1) routing.useUpstream(true);
        return answer;
      });
      setDestinationResolverForTesting(async () => [{ address: "203.0.113.10", family: 4 }]);
      SandboxManager.setParentProxyRouter(routing.router);
      const response = await wireRequest(lane, "GET");
      expect.soft(approval.requests.map((request) => request.network)).toEqual(["public", "unverified"]);
      expect.soft(approval.requests.at(-1)?.scopes).not.toContain("always");
      expect.soft(confirmations).toBe(2);
      expect.soft(response).toMatch(/^HTTP\/1\.1 403/u);
      expect.soft(upstream.bytesReceived).toBe(0);
      expect(upstream.requests).toEqual([]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });

  it.each(GRANT_CASES)("asks about local addresses after a pending $origin $scope public answer", async ({ origin, scope }) => {
    const approval = approvalFixture(origin);
    const upstream = await recordingUpstream();
    const routing = routingFixture(upstream.port);
    const entered = latch<void>();
    const held = latch<EgressApprovalAnswer>();
    let changed = false;
    let resolutions = 0;
    let confirmations = 0;
    let pending: Promise<string> | undefined;
    approval.answer = async (request) => {
      if (request.network === "local") return { allow: false, reason: "local destination refused" };
      if (approval.requests.length === 2) {
        entered.release();
        return held.promise;
      }
      return { allow: true, scope: "once" };
    };
    try {
      const lane = await startProxy(async (destination, context) => {
        if (context?.phase === "resolved") confirmations++;
        return approval.callback(destination, context);
      });
      setDestinationResolverForTesting(async () => {
        // Expire the 120-second name answer so the resolved-phase card remains pending.
        if (++resolutions === 1) approval.advance(120_001);
        return [{ address: changed ? "10.23.45.67" : "203.0.113.10", family: 4 }];
      });
      SandboxManager.setParentProxyRouter(routing.router);
      pending = wireRequest(lane);
      await Promise.race([
        entered.promise,
        pending.then(() => { throw new Error("Connection ended before the public approval was pending"); }),
      ]);
      changed = true;
      routing.useUpstream();
      expect(SandboxManager.closeAllInvocationConnections()).toBe(0);
      held.release({ allow: true, scope });
      const response = await pending;
      expect.soft(approval.requests.map((request) => request.network)).toEqual(["public", "public", "local"]);
      expect.soft(approval.requests.at(-1)?.scopes).not.toContain("always");
      expect.soft(confirmations).toBe(2);
      expect.soft(response).toMatch(/^HTTP\/1\.1 403/u);
      expect.soft(upstream.bytesReceived).toBe(0);
      expect(upstream.requests).toEqual([]);
    } finally {
      held.release({ allow: false, reason: "test cleanup" });
      await SandboxManager.reset();
      if (pending !== undefined) await Promise.allSettled([pending]);
      await upstream.close();
    }
  });

  it.each(GRANT_CASES)("retains same-class $origin $scope behavior on the wire", async ({ origin, scope }) => {
    const approval = approvalFixture(origin);
    const upstream = await recordingUpstream();
    const routing = routingFixture(upstream.port, "manual");
    approval.answer = async () => ({ allow: true, scope });
    try {
      const lane = await startProxy(approval.callback);
      setDestinationResolverForTesting(async () => [{ address: "203.0.113.10", family: 4 }]);
      SandboxManager.setParentProxyRouter(routing.router);
      expect(await wireRequest(lane)).toMatch(/^HTTP\/1\.1 200/u);
      routing.useUpstream();
      expect(await wireRequest(lane)).toMatch(/^HTTP\/1\.1 200/u);
      expect(approval.requests.map((request) => request.network)).toEqual(
        origin === "terminal" && scope === "once" ? ["public", "public"] : ["public"],
      );
      expect(upstream.requests).toEqual([
        "CONNECT 203.0.113.10:443 HTTP/1.1",
        "CONNECT 203.0.113.10:443 HTTP/1.1",
      ]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });

  it.each(["shell", "terminal"] as const)("does not borrow a persistent %s grant for the other origin", async (grantedOrigin) => {
    const requestingOrigin = grantedOrigin === "shell" ? "terminal" : "shell";
    const approval = approvalFixture(requestingOrigin);
    const upstream = await recordingUpstream();
    const routing = routingFixture(upstream.port, "manual");
    const subject: EgressGrantSubject = {
      token: "fedcba9876543210fedcba9876543210",
      sessionId: undefined,
      tabId: undefined,
      projectRoot: undefined,
      origin: grantedOrigin,
    };
    await approval.grants.grant("always", ["always"], subject, DESTINATION);
    try {
      const lane = await startProxy(approval.callback);
      setDestinationResolverForTesting(async () => [{ address: "203.0.113.10", family: 4 }]);
      SandboxManager.setParentProxyRouter(routing.router);
      expect(await wireRequest(lane)).toMatch(/^HTTP\/1\.1 403/u);
      expect(approval.requests.map((request) => ({ origin: request.origin, network: request.network }))).toEqual([
        { origin: requestingOrigin, network: "public" },
      ]);
      expect(upstream.bytesReceived).toBe(0);
      expect(upstream.requests).toEqual([]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });
});
