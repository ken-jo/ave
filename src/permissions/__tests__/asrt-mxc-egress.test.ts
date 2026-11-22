import http from "node:http";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager, type SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
import { setDestinationResolverForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
import { deferred, useTempDirs } from "../../__tests__/test-helpers.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { prepareMxcShellLaunch } from "../../tools/mxc-shell-launch.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { createShellNetworkPermissionEvaluator } from "../egress-approval.js";
import { createEgressAskCallback, EGRESS_DENY_REASONS, type EgressApprovalRequester } from "../egress-ask.js";
import { EgressGrantStore } from "../egress-grants.js";
import * as hostListener from "../egress-host-listener.js";
import * as frontendListener from "../egress-invocation-listener.js";
import { egressIdentityStrength } from "../egress-identity.js";
import { egressInvocationOwner, openEgressInvocation, type EgressInvocation } from "../egress-invocations.js";
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
  let invocation: EgressInvocation;
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
    const launch = await prepareMxcShellLaunch({
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

  function request(port: number, authorization: string, method: "GET" | "CONNECT" = "GET", destination = DESTINATION): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const target = new URL(destination);
      const path = method === "CONNECT" ? target.host : destination;
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Proxy-Authorization": authorization }, agent: false }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      req.on("connect", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  }

  function expectSharedDenial(index: number): void {
    expect(observed[index]?.context?.attributionKey === invocation.token).toBe(true);
    expect(observed[index]?.context?.identity).toBe("username");
    expect(observed[index]?.context?.phase).toBe("name");
    expect(observed[index]?.decision).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
  }

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(async () => {
    const dir = policyFixture();
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([dir]);
    observed = [];
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
      abortSignalOf: () => undefined,
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
      // Exercise the resolved policy without dialing the test destination.
      return context?.phase === "name" && decision === true;
    });
    const port = SandboxManager.getProxyPort();
    if (port === undefined) throw new Error("Shared proxy did not start");
    sharedPort = port;
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      await resetAsrtSandbox();
    } finally {
      setDestinationResolverForTesting(undefined);
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetWindowsSandboxSubstrateForTest();
      vi.restoreAllMocks();
    }
  });

  it.each(["GET", "CONNECT"] as const)("keeps shared proxy labels at username identity and refuses them for a contained shell (%s)", async (method) => {
    expect(await request(sharedPort, sharedAuthorization(invocation.token), method)).toBe(403);
    expectSharedDenial(0);
    expect(observed).toHaveLength(1);
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
    expectSharedDenial(2);
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

  it("refuses a mismatched relay credential, proxy hops and an ended invocation before approval", async () => {
    const relay = await openRelay();
    const sameInvocation = await openRelay();
    const other = openInvocation(invocation.owner);
    const otherRelay = await openRelay(other.token);
    expect(await request(relay.port, sameInvocation.proxyAuthorization)).toBe(407);
    expect(await request(sameInvocation.port, relay.proxyAuthorization)).toBe(407);
    expect(await request(relay.port, otherRelay.proxyAuthorization)).toBe(407);
    for (const port of [sharedPort, relay.port]) {
      expect(await request(relay.port, relay.proxyAuthorization, "GET", `http://127.0.0.1:${port}/`)).toBe(403);
    }
    expect(observed).toEqual([]);
    invocation.release();
    const requestApproval = vi.fn(requester);
    requester = requestApproval;
    expect(await request(relay.port, relay.proxyAuthorization)).toBe(403);
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
      if (revocation === "consent") {
        setWindowsShellLocalNetworkAccess(false);
        setWindowsShellLocalNetworkAccess(true);
      } else if (revocation === "cancel") {
        controller.abort();
      } else {
        pendingInvocation.release();
      }
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
});
