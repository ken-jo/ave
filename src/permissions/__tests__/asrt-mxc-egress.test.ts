import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager, type SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
import { setDestinationResolverForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
import { deferred, useTempDirs } from "../../__tests__/test-helpers.js";
import { prepareOwnedMxcShellLaunch } from "../../__tests__/support/contained-shell-launch.js";
import { closed, echoParentProxy, openTunnel, probePort, within } from "../../__tests__/support/proxy-tunnel-probe.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { createShellNetworkPermissionEvaluator } from "../egress-approval.js";
import { createEgressAskCallback, EGRESS_DENY_REASONS, type EgressApprovalRequester } from "../egress-ask.js";
import { EgressGrantStore } from "../egress-grants.js";
import * as hostListener from "../egress-host-listener.js";
import * as frontendListener from "../egress-invocation-listener.js";
import { egressIdentityStrength } from "../egress-identity.js";
import { egressInvocationAbortSignal, egressInvocationOwner, openEgressInvocation, type EgressInvocation } from "../egress-invocations.js";
import { PermissionManager } from "../permission-manager.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  detectMxcShellCapability,
  getWindowsSandboxSubstrate,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  setWindowsShellLocalNetworkAccess,
  setWindowsSandboxSubstrate,
} from "../sandbox-capability.js";

vi.mock("../mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => "C:\\Ave\\resources\\mxc\\x64\\wxc-exec.exe",
}));

const DESTINATION = "http://egress.example.invalid:8443/";
const PUBLIC_ADDRESS = "203.0.113.10";
describe.skipIf(process.platform !== "win32")("contained shell egress identity", () => {
  const policyFixture = useTempDirs("contained-shell-egress-");
  const cleanups: Array<() => void | Promise<void>> = [];
  // Every client socket a test opened, destroyed at teardown whatever the test left open.
  const sockets = new Set<net.Socket>();
  let invocation: EgressInvocation;
  // Set by a test that dials through the relay; others exercise the resolved policy without dialing.
  let dial: boolean;
  let observed: Array<{ context: SandboxAskContext | undefined; decision: unknown }>;
  let requester: EgressApprovalRequester;
  let sharedPort: number;

  function recordSubstrate(state: "checking" | "available"): void {
    const { substrate } = planWindowsSandbox({
      shellRequested: true,
      shellLocalNetworkAccess: true,
      workerRequested: false,
      mxc: { state },
      windowsBuild: "10.0.26300",
      srtWinReady: false,
    });
    setWindowsSandboxSubstrate(substrate, state === "available" ? mxcShellCapability() : undefined);
  }

  function openInvocation(owner: Parameters<typeof openEgressInvocation>[0]): EgressInvocation {
    const result = openEgressInvocation(owner);
    cleanups.push(result.release);
    return result;
  }

  async function openRelay(token = invocation.token) {
    const relay = await hostListener.openHostEgressListener(token);
    cleanups.push(relay.close);
    return relay;
  }

  async function launchShell(token = invocation.token, activate = true) {
    const launch = await prepareOwnedMxcShellLaunch({
      egressToken: token,
      commandLine: "contained command",
      cwd: "C:\\work",
      filesystem: { allowRead: [], allowWrite: ["C:\\work"], denyRead: [], denyWrite: [] },
      env: { LOCALAPPDATA: "C:\\example\\AppData\\Local" },
      timeoutMs: 1_000,
      exists: () => true,
      list: () => [],
    });
    cleanups.push(launch.release);
    if (activate) launch.activate();
    return launch;
  }

  function sharedAuthorization(token: string): string {
    const label = `srt.${Buffer.from(token).toString("base64")}`;
    const credential = SandboxManager.getProxyAuthToken();
    if (credential === undefined) throw new Error("Shared proxy did not issue a credential");
    return `Basic ${Buffer.from(`${label}:${credential}`).toString("base64")}`;
  }

  // Bounded, and its socket is destroyed at teardown even when an assertion leaves it open.
  function request(port: number, authorization: string, method: "GET" | "CONNECT" = "GET", destination = DESTINATION): Promise<number | undefined> {
    let req: http.ClientRequest | undefined;
    const response = new Promise<number | undefined>((resolve, reject) => {
      const target = new URL(destination);
      const path = method === "CONNECT" ? target.host : destination;
      req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Proxy-Authorization": authorization }, agent: false }, (answer) => {
        answer.resume();
        answer.once("end", () => resolve(answer.statusCode));
      });
      req.on("socket", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      req.on("connect", (answer, socket) => {
        socket.destroy();
        resolve(answer.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    return within(response, `request to port ${port}`).finally(() => req?.destroy());
  }

  // A shell's key named only by the shared proxy username: `attributionKey` is what the runtime let through (nothing while a relay owns
  // the key), and a key it let through is refused without being handed back for the proxy's own record.
  function expectSharedDenial(index: number, attributionKey: string | undefined): void {
    expect(observed[index]?.context?.attributionKey).toBe(attributionKey);
    expect(observed[index]?.context?.identity).toBe("username");
    expect(observed[index]?.context?.phase).toBe("name");
    expect(observed[index]?.decision).toEqual(attributionKey === undefined
      ? { allow: false, reason: EGRESS_DENY_REASONS.unattributed }
      : { allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
  }

  function endAdmission(revocation: "consent" | "cancel" | "release", controller: AbortController, ending: EgressInvocation): void {
    if (revocation === "consent") {
      setWindowsShellLocalNetworkAccess(false);
      setWindowsShellLocalNetworkAccess(true);
    } else if (revocation === "cancel") {
      controller.abort();
    } else {
      ending.release();
    }
  }

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(async () => {
    const dir = policyFixture();
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([dir]);
    observed = [];
    dial = false;
    requester = async () => ({ allow: true, scope: "once" });
    invocation = openInvocation({
      kind: "shell", toolName: "powershell", toolUseId: "contained-call", requiresListener: true,
      context: { sessionId: "conversation", workspaceRoot: dir, approvalSurface: "interactive" },
    });
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability(windowsProxyOnlyCapability());
    recordSubstrate("available");
    const permissions = new PermissionManager(join(dir, "permissions.json"));
    permissions.setMode("strict");
    const ask = createEgressAskCallback({
      identityStrength: egressIdentityStrength,
      ownerOf: egressInvocationOwner,
      abortSignalOf: egressInvocationAbortSignal,
      workerAllowedDomains: () => ["127.0.0.1"],
      grants: new EgressGrantStore(join(dir, "grants.json")),
      evaluateShellPermission: createShellNetworkPermissionEvaluator(permissions),
      shellAskEnabled: () => true,
      requester: () => requester,
      audit: () => {},
    });
    setDestinationResolverForTesting(async () => [{ address: PUBLIC_ADDRESS, family: 4 }]);
    await initializeAsrtSandbox({
      allowedDomains: [],
      strictAllowlist: false,
      windows: { externalConfinement: true, proxyPortRange: [42120, 42129] },
    }, async (destination, context) => {
      const decision = await ask(destination, context);
      observed.push({ context, decision });
      if (decision !== true) return decision;
      // Exercise the resolved policy without dialing the test destination.
      return dial || context?.phase === "name";
    });
    const port = SandboxManager.getProxyPort();
    if (port === undefined) throw new Error("Shared proxy did not start");
    sharedPort = port;
  });

  // Every step runs, whichever fails; the failures are thrown together afterwards.
  afterEach(async () => {
    const failures: unknown[] = [];
    const step = async (run: () => unknown): Promise<void> => {
      try { await run(); } catch (error) { failures.push(error); }
    };
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const cleanup of cleanups.splice(0).reverse()) await step(cleanup);
    await step(resetAsrtSandbox);
    await step(() => setDestinationResolverForTesting(undefined));
    await step(__resetActiveSandboxCapabilityForTest);
    await step(__resetSandboxRequestedAtBootForTest);
    await step(__resetWindowsSandboxSubstrateForTest);
    vi.restoreAllMocks();
    if (failures.length > 0) throw new AggregateError(failures, "contained shell egress teardown failed");
  });

  it.each(["GET", "CONNECT"] as const)("keeps shared proxy labels at username identity and refuses them for a contained shell (%s)", async (method) => {
    expect(await request(sharedPort, sharedAuthorization(invocation.token), method)).toBe(403);
    expectSharedDenial(0, invocation.token);
    expect(observed).toHaveLength(1);
    // The refusal is recorded, but not against the shell the username named.
    expect(SandboxManager.getSandboxViolationStore().getViolationsForCommand(invocation.token)).toEqual([]);
  });

  it.each(["GET", "CONNECT"] as const)("attributes a contained command at both listener decision phases (%s)", async (method) => {
    const launch = await launchShell();
    expect(await request(launch.proxyPort, "Basic forged", method)).toBe(403);
    expect(observed).toHaveLength(2);
    expect(observed.every(({ context }) => context?.attributionKey === invocation.token)).toBe(true);
    expect(observed.map(({ context, decision }) => ({ ...context, attributionKey: undefined, decision }))).toEqual([
      { attributionKey: undefined, identity: "listener", phase: "name", decision: true },
      { attributionKey: undefined, identity: "listener", phase: "resolved", addresses: [PUBLIC_ADDRESS], resolution: "pinned", decision: true },
    ]);
    expect(await request(sharedPort, sharedAuthorization(invocation.token), method)).toBe(403);
    // While the shell's own relay is open, the username names nobody.
    expectSharedDenial(2, undefined);
    expect(observed).toHaveLength(3);
  });

  it.each(["local", "unverified"] as const)("rechecks a contained listener's public project grant when the destination becomes %s", async (network) => {
    const approve = vi.fn<EgressApprovalRequester>(async (approval) => ({
      allow: true, scope: approval.network === "public" ? "project" : "session",
    }));
    requester = approve;
    const relay = await openRelay();
    expect(await request(relay.port, relay.proxyAuthorization)).toBe(403);
    expect(approve.mock.calls.map(([approval]) => approval.network)).toEqual(["public"]);

    if (network === "local") {
      setDestinationResolverForTesting(async () => [{ address: "10.0.0.5", family: 4 }]);
    } else {
      SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "http", host: "198.51.100.20", port: 8080, resolvesNames: true }] }));
    }
    expect(await request(relay.port, relay.proxyAuthorization)).toBe(403);
    expect(approve.mock.calls.map(([approval]) => ({ network: approval.network, scopes: approval.scopes }))).toEqual([
      { network: "public", scopes: ["once", "session", "project", "always"] },
      { network, scopes: ["once", "session"] },
    ]);
    expect(observed.map(({ context }) => context?.phase)).toEqual(["name", "resolved", "name", "resolved"]);
    expect(observed.every(({ context, decision }) => context?.identity === "listener" && decision === true)).toBe(true);
  });

  it("refuses the ordinary Windows invocation listener and rejects invalid host relay ports", async () => {
    await expect(SandboxManager.openInvocationListener(invocation.token)).rejects.toThrow(/not supported/u);
    const relay = await openRelay();
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => relay.registerPort(port)).toThrow("invalid listener port");
    }
  });

  it.each(["GET", "CONNECT"] as const)("refuses shared proxy destinations on frontend and relay ports before asking (%s)", async (method) => {
    const open = vi.spyOn(hostListener, "openHostEgressListener");
    const launch = await launchShell();
    const relay = await open.mock.results[0]?.value;
    if (relay === undefined) throw new Error("Shell launch did not open a relay");
    const worker = openInvocation({ kind: "worker", role: "worker", pluginId: "fixture" });
    for (const port of [launch.proxyPort, relay.port]) {
      expect(await request(sharedPort, sharedAuthorization(worker.token), method, `http://127.0.0.1:${port}/`)).toBe(403);
    }
    expect(observed).toEqual([]);
  });

  it("keeps the shell capability shared until the runtime and substrate are ready", () => {
    recordSubstrate("checking");
    expect(getWindowsSandboxSubstrate()?.shellEgressIdentity).toBe("shared");
    expect(detectMxcShellCapability()).toBeUndefined();
    recordSubstrate("available");
    expect(getWindowsSandboxSubstrate()?.shellEgressIdentity).toBe("kernel-channel");
    expect(detectMxcShellCapability()).toBeDefined();
    expect(egressIdentityStrength("shell", { identity: "listener" })).toBe("kernel-channel");
    expect(egressIdentityStrength("extension", { identity: "username" })).toBe("shared");
    setShellSandboxRequestedAtBoot(false);
    expect(detectMxcShellCapability()).toBeUndefined();
    setShellSandboxRequestedAtBoot(true);
    __resetActiveSandboxCapabilityForTest();
    expect(detectMxcShellCapability()).toBeUndefined();
  });

  it("does not prepare a contained shell listener for an unsettled substrate, unknown token or worker token", async () => {
    const open = vi.spyOn(hostListener, "openHostEgressListener");
    const worker = openInvocation({ kind: "worker", role: "worker", pluginId: "fixture" });
    recordSubstrate("checking");
    await expect.soft(launchShell().then(() => undefined)).rejects.toThrow(/unavailable/u);
    recordSubstrate("available");
    await expect.soft(launchShell("f".repeat(32)).then(() => undefined)).rejects.toThrow(/live shell invocation/u);
    await expect.soft(launchShell(worker.token).then(() => undefined)).rejects.toThrow(/live shell invocation/u);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens one relay per key for the session: never beside a live relay, nor after its relay closed", async () => {
    const relay = await openRelay();
    await expect(openRelay()).rejects.toThrow(/already had a relay/u);
    await expect(launchShell().then(() => undefined)).rejects.toThrow(/already had a relay/u);
    await relay.close();
    await expect(openRelay()).rejects.toThrow(/already had a relay/u);
    expect(observed).toEqual([]);
  });

  it("refuses a mismatched relay credential, proxy hops and an ended invocation before approval", async () => {
    const relay = await openRelay();
    const other = openInvocation(invocation.owner);
    const otherRelay = await openRelay(other.token);
    expect(await request(relay.port, otherRelay.proxyAuthorization)).toBe(407);
    expect(await request(otherRelay.port, relay.proxyAuthorization)).toBe(407);
    for (const port of [sharedPort, relay.port]) {
      expect(await request(relay.port, relay.proxyAuthorization, "GET", `http://127.0.0.1:${port}/`)).toBe(403);
    }
    expect(observed).toEqual([]);
    invocation.release();
    const requestApproval = vi.fn(requester);
    requester = requestApproval;
    expect(await request(relay.port, relay.proxyAuthorization)).toBe(403);
    expect(observed).toEqual([{
      context: expect.objectContaining({ attributionKey: invocation.token, identity: "listener", phase: "name" }),
      decision: { allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true },
    }]);
    expect(requestApproval).not.toHaveBeenCalled();
    await expect(launchShell().then(() => undefined)).rejects.toThrow(/live shell invocation/u);
  });

  it("fails closed if the host relay cannot open", async () => {
    vi.spyOn(hostListener, "openHostEgressListener").mockRejectedValueOnce(new Error("relay unavailable"));
    await expect(launchShell()).rejects.toThrow("relay unavailable");
    expect(observed).toEqual([]);
  });

  it.each([
    ["consent", "relay"],
    ["cancel", "relay"],
    ["release", "relay"],
    ["consent", "frontend"],
    ["cancel", "frontend"],
    ["release", "frontend"],
  ] as const)("closes bound endpoints before preparation resumes when %s ends admission at the %s", async (revocation, boundary) => {
    const controller = new AbortController();
    const pendingInvocation = openEgressInvocation(invocation.owner, { abortSignal: controller.signal });
    cleanups.push(pendingInvocation.release);
    const frontendBound = deferred<number>();
    const completeBind = deferred<void>();
    const openFrontend = frontendListener.openInvocationProxyListener;
    const openRelay = hostListener.openHostEgressListener;
    const backendBound = deferred<Awaited<ReturnType<typeof openRelay>>>();
    vi.spyOn(hostListener, "openHostEgressListener").mockImplementationOnce(async (...args) => {
      const relay = await openRelay(...args);
      backendBound.resolve(relay);
      if (boundary === "relay") await completeBind.promise;
      return relay;
    });
    if (boundary === "frontend") {
      vi.spyOn(frontendListener, "openInvocationProxyListener").mockImplementationOnce(async (...args) => {
        const listener = await openFrontend(...args);
        frontendBound.resolve(listener.port);
        await completeBind.promise;
        return listener;
      });
    }

    const launch = launchShell(pendingInvocation.token, false);
    const result = Promise.allSettled([launch]);
    try {
      const [backend, frontend] = await Promise.race([
        Promise.all([backendBound.promise, boundary === "frontend" ? frontendBound.promise : undefined]),
        launch.then(() => { throw new Error("Launch returned before the bind completed"); }),
      ]);
      const endpoints: Array<readonly [number, string]> = [[backend.port, backend.proxyAuthorization]];
      if (frontend !== undefined) endpoints.push([frontend, "Basic ignored"]);
      const responses = await Promise.allSettled(endpoints.map(([port, authorization]) => request(port, authorization)));
      endAdmission(revocation, controller, pendingInvocation);
      for (const [port, authorization] of endpoints) {
        await expect(request(port, authorization)).rejects.toMatchObject({ code: "ECONNREFUSED" });
      }
      expect(egressInvocationOwner(pendingInvocation.token)).toBeUndefined();
      expect(responses.map(({ status }) => status)).toEqual(endpoints.map(() => "rejected"));
      expect(observed).toEqual([]);
    } finally {
      completeBind.resolve();
      await result;
    }
    expect((await result)[0]?.status).toBe("rejected");
  });

  it.each(["consent", "cancel", "release"] as const)("closes a relay whose native bind was still pending when %s ended admission", async (revocation) => {
    const controller = new AbortController();
    const pendingInvocation = openEgressInvocation(invocation.owner, { abortSignal: controller.signal });
    cleanups.push(pendingInvocation.release);
    const listen = net.Server.prototype.listen;
    const bind = deferred<void>();
    const servers: net.Server[] = [];
    vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (this: net.Server, ...args: unknown[]) {
      servers.push(this);
      void bind.promise.then(() => listen.apply(this, args as Parameters<typeof listen>));
      return this;
    });
    const open = vi.spyOn(hostListener, "openHostEgressListener");
    const launch = launchShell(pendingInvocation.token, false).then(() => "prepared", (error: unknown) => error);
    try {
      await vi.waitFor(() => expect(servers).toHaveLength(1));
      endAdmission(revocation, controller, pendingInvocation);
      expect(egressInvocationOwner(pendingInvocation.token)).toBeUndefined();
    } finally {
      bind.resolve();
    }
    expect(await launch).not.toBe("prepared");
    expect(open).toHaveBeenCalledOnce();
    expect(servers[0]?.listening).toBe(false);
    expect(observed).toEqual([]);
  });

  it("stops live tunnels through both endpoints at cancellation while the job still runs, and frees the ports only at its exit", async () => {
    dial = true;
    const parent = await echoParentProxy();
    cleanups.push(parent.close);
    SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: parent.port, resolvesNames: true }] }));
    const controller = new AbortController();
    const running = openEgressInvocation(invocation.owner, { abortSignal: controller.signal });
    cleanups.push(running.release);
    const open = vi.spyOn(hostListener, "openHostEgressListener");
    const launch = await launchShell(running.token);
    const relay = await open.mock.results[0]?.value as Awaited<ReturnType<typeof hostListener.openHostEgressListener>>;
    const exit = deferred<void>();
    cleanups.push(() => exit.resolve());
    // The native job is still being killed: nothing is disposed until it exits.
    launch.lifecycle.jobStarted(exit.promise);
    const frontend = await openTunnel(launch.proxyPort, { authority: "tunnel.example.test:443", sockets });
    const direct = await openTunnel(relay.port, { authority: "tunnel.example.test:443", authorization: relay.proxyAuthorization, sockets });
    expect(parent.received).toBe("pingping");

    controller.abort();
    expect(launch.lifecycle.signal.aborted).toBe(true);
    expect(egressInvocationOwner(running.token)).toBeUndefined();
    for (const tunnel of [frontend, direct]) tunnel.write("after");
    await within(Promise.all([closed(frontend), closed(direct)]), "tunnel teardown");
    await vi.waitFor(() => expect(parent.open).toBe(0));
    expect(parent.received).toBe("pingping");
    for (const port of [launch.proxyPort, relay.port]) expect(await probePort(port, sockets)).toBe("dropped");

    exit.resolve();
    await launch.release();
    for (const port of [launch.proxyPort, relay.port]) expect(await probePort(port, sockets)).toBe("refused");
  });

  it("grants nothing when the shell is released while its egress decision is pending", async () => {
    const asked = deferred<void>();
    const answer = deferred<{ allow: true; scope: "session" }>();
    let approvalSignal: AbortSignal | undefined;
    requester = async (approval) => {
      approvalSignal = approval.abortSignal;
      asked.resolve();
      return answer.promise;
    };
    const launch = await launchShell();
    const response = request(launch.proxyPort, "Basic ignored", "CONNECT").catch((error: unknown) => error);
    await within(asked.promise, "approval request");
    await launch.release();
    expect(approvalSignal?.aborted).toBe(true);
    answer.resolve({ allow: true, scope: "session" });
    expect(await response).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0]?.decision).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    // No session grant was written: another call in the same conversation is asked again.
    const again = vi.fn<EgressApprovalRequester>(async () => ({ allow: false, reason: "denied by the user" }));
    requester = again;
    const next = openInvocation(invocation.owner);
    const nextLaunch = await launchShell(next.token);
    expect(await request(nextLaunch.proxyPort, "Basic ignored", "CONNECT")).toBe(403);
    expect(again).toHaveBeenCalledOnce();
  });

  it("unbinds a relay whose connection drain throws, rejects its close and keeps its key unattributable on the shared front end", async () => {
    // Not left to teardown: its close is the failure under test.
    const relay = await hostListener.openHostEgressListener(invocation.token);
    const failure = new Error("relay drain failed");
    vi.spyOn(http.Server.prototype, "closeAllConnections").mockImplementationOnce(() => { throw failure; });
    await expect(relay.close()).rejects.toBe(failure);
    // The drain's failure did not skip the unbind.
    expect(await probePort(relay.port, sockets)).toBe("refused");
    expect(await request(sharedPort, sharedAuthorization(invocation.token))).toBe(403);
    expectSharedDenial(0, undefined);
    // The unbound relay left the registry, so ending the session does not meet its failure again.
    await expect(resetAsrtSandbox()).resolves.toBeUndefined();
  });

  it("ends the session and unbinds a relay whose drain throws during that teardown", async () => {
    const relay = await hostListener.openHostEgressListener(invocation.token);
    const closeAll = http.Server.prototype.closeAllConnections;
    const drained: http.Server[] = [];
    // The shared proxy closes first; the relay's drain, which follows it, throws.
    vi.spyOn(http.Server.prototype, "closeAllConnections")
      .mockImplementationOnce(function (this: http.Server) { closeAll.call(this); })
      .mockImplementationOnce(function (this: http.Server) {
        drained.push(this);
        throw new Error("relay drain failed");
      });
    await expect(resetAsrtSandbox()).resolves.toBeUndefined();
    expect(drained).toHaveLength(1);
    for (const port of [relay.port, sharedPort]) expect(await probePort(port, sockets)).toBe("refused");
  });

  it("fails the session's reset after the rest of its teardown while a relay's port stays bound, and releases it at the next", async () => {
    const relay = await hostListener.openHostEgressListener(invocation.token);
    const close = http.Server.prototype.close;
    let refuse = true;
    vi.spyOn(http.Server.prototype, "close").mockImplementation(function (this: http.Server, callback?: (error?: Error) => void) {
      const address = this.address();
      if (refuse && address !== null && typeof address === "object" && address.port === relay.port) {
        queueMicrotask(() => callback?.(new Error("relay unbind failed")));
        return this;
      }
      return close.call(this, callback);
    });
    await expect(resetAsrtSandbox()).rejects.toThrow("Sandbox reset left 1 invocation relay port bound");
    // The rest of the session ended; the relay is still owned, and drops what connects.
    expect(await probePort(sharedPort, sockets)).toBe("refused");
    expect(await probePort(relay.port, sockets)).toBe("dropped");
    refuse = false;
    await expect(resetAsrtSandbox()).resolves.toBeUndefined();
    expect(await probePort(relay.port, sockets)).toBe("refused");
  });
});
