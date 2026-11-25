import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMxcShellLaunchAdmissionFixture } from "../../__tests__/support/mxc-shell-launch-admission.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { closed, echoParentProxy, openTunnel, probePort, within } from "../../__tests__/support/proxy-tunnel-probe.js";

const h = vi.hoisted(() => ({
  openRelay: vi.fn(),
  floor: vi.fn(() => [] as string[]),
  boundary: vi.fn((_path: string): string | undefined => undefined),
  privateRoots: vi.fn(() => [] as string[]),
  liveHomes: new Set<string>(),
  wxcExec: vi.fn(async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`),
  registerPort: vi.fn(),
  recordRefusal: vi.fn(),
  closeRelay: vi.fn(async () => {}),
  readdir: vi.fn(),
  lstat: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => h.readdir.getMockImplementation() ? h.readdir(...args) : actual.readdirSync(...args),
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => h.lstat.getMockImplementation() ? h.lstat(...args) : actual.lstatSync(...args) };
});
vi.mock("../../permissions/egress-host-listener.js", () => ({
  openHostEgressListener: h.openRelay,
}));

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  aveHomeReadBoundaryCovering: h.boundary,
  appOwnedSandboxPrivateRoots: h.privateRoots,
  // Stand-ins with the real functions' meaning: a path at or under a root, and a path at or inside a HOME the host still holds.
  protectedReadDenyMatcher: (roots: readonly string[]) => (path: string) =>
    roots.find((root) => `${path.toLowerCase()}\\`.startsWith(root.toLowerCase())),
  insideOwnWindowsSandboxHome: (path: string, home: string | undefined) =>
    home !== undefined && h.liveHomes.has(home) && (path === home || path.startsWith(`${home}\\`)),
  getProtectedReadDenyFloor: h.floor,
  getWindowsProxyPortRange: () => [60080, 60089],
}));
vi.mock("../../permissions/mxc-windows.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../permissions/mxc-windows.js")>()),
  resolveHostWxcExecPath: h.wxcExec,
}));

import { prepareMxcShellLaunch, type PrepareMxcShellLaunchInput } from "../mxc-shell-launch.js";
import { createContainedShellLifecycle } from "../contained-shell-lifecycle.js";
import { MXC_REQUEST_CHARACTER_LIMIT } from "../../permissions/mxc-windows.js";
import { egressInvocationOwner, onEgressInvocationReleased, openEgressInvocation } from "../../permissions/egress-invocations.js";
import * as policyPipe from "../../permissions/mxc-policy-pipe.js";
import { isWindowsShellLocalNetworkAccessAllowed, setWindowsShellLocalNetworkAccess } from "../../permissions/sandbox-capability.js";

const WS = String.raw`C:\work\repo`;
beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows"); });
registerMxcShellLaunchAdmissionFixture("tok");
const INPUT = {
  egressToken: "tok",
  commandLine: "cmd.exe /d /c echo hi",
  cwd: WS,
  filesystem: { allowWrite: [WS], allowRead: [], denyRead: [], denyWrite: [] },
  env: { SYSTEMROOT: String.raw`C:\Windows`, LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local` },
  timeoutMs: 5_000,
  exists: () => true,
};

// The relay stand-in hands its close to the lifecycle at allocation, as the runtime relay does.
function relay(port = 9): void {
  h.openRelay.mockImplementation(async (_token: string, admission?: { adopt(close: () => Promise<void>): void }) => {
    admission?.adopt(h.closeRelay);
    return { port, proxyAuthorization: "Basic eA==", registerPort: h.registerPort, recordRefusal: h.recordRefusal, close: h.closeRelay };
  });
}

function decodeRequest(argv: readonly string[]): Record<string, any> {
  expect(argv[1]).toBe("--config-base64");
  return JSON.parse(Buffer.from(argv[2] ?? "", "base64").toString("utf8"));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("prepareMxcShellLaunch", () => {
  it("leaves what it allocated to its owner when the system root is missing", async () => {
    const roots = ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"];
    const previous = roots.map(key => process.env[key]);
    const lifecycle = createContainedShellLifecycle();
    try {
      for (const key of roots) vi.stubEnv(key, undefined);
      relay();
      const listen = vi.spyOn(net.Server.prototype, "listen");
      await expect(prepareMxcShellLaunch(INPUT, lifecycle)).rejects.toThrow(/system root/i);
      const server = listen.mock.contexts[0] as net.Server | undefined;
      expect(server?.listening).toBe(true);
      expect(h.closeRelay).not.toHaveBeenCalled();
      expect(await lifecycle.dispose()).toEqual([]);
      expect(server?.listening).toBe(false);
      expect(h.closeRelay).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.dispose();
      vi.unstubAllEnvs();
      // Environment keys alias each other on Windows; restore defined values after all removals.
      roots.forEach((key, index) => { if (previous[index] !== undefined) process.env[key] = previous[index]; });
    }
  });

  it("opens the invocation's own listener and points the container's only network path at it", async () => {
    relay();
    const lifecycle = createContainedShellLifecycle();
    const launch = await prepareMxcShellLaunch(INPUT, lifecycle);
    try {
      expect(h.openRelay).toHaveBeenCalledWith("tok", expect.objectContaining({ signal: lifecycle.signal }));
      const admission = h.openRelay.mock.calls[0]?.[1];
      expect(admission.acceptsConnections()).toBe(false);
      launch.activate();
      expect(admission.acceptsConnections()).toBe(true);
      expect(launch.argv[0]).toBe(String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`);
      const request = decodeRequest(launch.argv);
      expect(request["runtimeConfig"]).toEqual({ networkProxy: `http://127.0.0.1:${launch.proxyPort}` });
      expect(request["network"]["egress"]).toEqual({ default: "deny" });
      expect(request["filesystem"]["readwritePaths"]).toEqual([WS]);
      // The MXC timeout trails the host's own lifetime watch.
      expect(request["process"]["timeout"]).toBe(35_000);
      expect(await probePort(launch.proxyPort)).toBe("served");
      expect(h.registerPort).toHaveBeenCalledWith(launch.proxyPort);
    } finally {
      expect(await lifecycle.dispose()).toEqual([]);
    }
    expect(await probePort(launch.proxyPort)).toBe("refused");
    expect(h.closeRelay).toHaveBeenCalledOnce();
  });

  it("grants nothing inside the Ave home outside its re-allowed children", async () => {
    relay();
    const home = String.raw`C:\Users\alice\.ave`;
    const workspace = String.raw`C:\Users\alice\.ave\workspace\repo`;
    h.boundary.mockImplementation((path: string) => path.startsWith(`${home}\\`) && !path.startsWith(`${home}\\workspace\\`) ? home : undefined);
    const lifecycle = createContainedShellLifecycle();
    try {
      const launch = await prepareMxcShellLaunch({ ...INPUT, cwd: workspace, filesystem: {
        allowWrite: [workspace, `${home}\\logs`], allowRead: [`${home}\\traces`, workspace], denyRead: [`${home}\\`], denyWrite: [],
      } }, lifecycle);
      const request = decodeRequest(launch.argv);
      expect(request.filesystem.readwritePaths).toEqual([workspace]);
      expect(JSON.stringify(request.filesystem)).not.toMatch(/logs|traces/);
    } finally {
      expect(await lifecycle.dispose()).toEqual([]);
    }
  });

  describe("the container runtime root", () => {
    const ROOT = String.raw`C:\Users\alice\AppData\Local\ai.agent-connector.ave\mxc-runtime`;
    const HOMES = `${ROOT}\\homes`;
    const OWN = `${HOMES}\\ave-sandbox-home-own`;
    const SIBLING = `${HOMES}\\ave-sandbox-home-sibling`;
    const STAGING = `${ROOT}\\staging`;
    const CLOSED = [ROOT, HOMES, SIBLING, `${SIBLING}\\AppData`, `${SIBLING}.owner`, STAGING, `${STAGING}\\0123456789abcdef0123456789abcdef`];
    beforeEach(() => {
      relay();
      h.privateRoots.mockReturnValue([`${ROOT}\\`]);
      h.liveHomes.add(OWN);
    });
    afterEach(() => {
      h.privateRoots.mockReturnValue([]);
      h.liveHomes.clear();
    });
    const launchWith = async (input: Partial<PrepareMxcShellLaunchInput>) => {
      const lifecycle = createContainedShellLifecycle();
      try {
        return decodeRequest((await prepareMxcShellLaunch({ ...INPUT, ...input }, lifecycle)).argv).filesystem;
      } finally {
        expect(await lifecycle.dispose()).toEqual([]);
      }
    };

    it("grants only this invocation's own HOME there, for writes and reads alike", async () => {
      const filesystem = await launchWith({ sandboxHome: OWN, filesystem: {
        allowWrite: [WS, ...CLOSED, OWN], allowRead: [...CLOSED, `${OWN}\\AppData`], denyRead: [], denyWrite: [],
      } });
      expect(filesystem.readwritePaths).toEqual([WS, OWN]);
      expect(filesystem.readonlyPaths ?? []).toEqual([`${OWN}\\AppData`]);
      expect(JSON.stringify(filesystem)).not.toMatch(/sibling|staging|homes"|mxc-runtime"/u);
    });

    it("keeps the root denied beneath a granted ancestor, whatever is asked for inside it", async () => {
      const profile = String.raw`C:\Users\alice`;
      const filesystem = await launchWith({ cwd: profile, filesystem: {
        allowWrite: [profile, ...CLOSED], allowRead: CLOSED, denyRead: [], denyWrite: [],
      } });
      expect(filesystem.readwritePaths).toEqual([profile]);
      expect(filesystem.deniedPaths).toEqual([ROOT]);
    });

    it("grants no HOME the host does not hold, and none without a HOME of its own", async () => {
      for (const sandboxHome of [SIBLING, HOMES, ROOT, undefined]) {
        const filesystem = await launchWith({ ...(sandboxHome === undefined ? {} : { sandboxHome }), filesystem: {
          allowWrite: [WS, SIBLING, OWN], allowRead: [SIBLING, OWN], denyRead: [], denyWrite: [],
        } });
        expect(filesystem.readwritePaths, String(sandboxHome)).toEqual([WS]);
      }
    });

    it.each(CLOSED)("refuses a working directory inside it: %s", async (cwd) => {
      const lifecycle = createContainedShellLifecycle();
      try {
        await expect(prepareMxcShellLaunch({ ...INPUT, cwd, sandboxHome: OWN,
          filesystem: { allowWrite: [cwd, OWN], allowRead: [], denyRead: [], denyWrite: [] } }, lifecycle))
          .rejects.toThrow(/working directory is inside the sandbox runtime root/u);
        expect(h.openRelay).not.toHaveBeenCalled();
      } finally {
        expect(await lifecycle.dispose()).toEqual([]);
      }
    });
  });

  it("expands a pattern deny over the filesystem by default, denies a placeholder directory whole and leaves links alone", async () => {
    relay();
    const sessions = String.raw`C:\Users\u\.ave\sessions`;
    // Listing reports every reparse point as a link; lstat separates a real link from a cloud placeholder directory.
    const entry = (name: string, kind: "directory" | "file" | "reparse") => ({ name, isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "reparse" });
    h.readdir.mockImplementation((directory: string) => directory === sessions
      ? [entry("one", "directory"), entry("link", "reparse"), entry("cloud", "reparse"), entry("gone", "reparse")]
      : directory === `${sessions}\\one` ? [entry(".ssh", "directory")] : []);
    h.lstat.mockImplementation((path: string) => {
      if (path === `${sessions}\\gone`) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => path === `${sessions}\\link`, isDirectory: () => path === `${sessions}\\cloud` };
    });
    const lifecycle = createContainedShellLifecycle();
    try {
      const launch = await prepareMxcShellLaunch({ ...INPUT, filesystem: { ...INPUT.filesystem, allowRead: [sessions], denyRead: [`${sessions}/**/.ssh`] } }, lifecycle);
      expect(h.readdir).toHaveBeenCalledWith(sessions, { withFileTypes: true });
      for (const name of ["link", "cloud", "gone"]) expect(h.readdir).not.toHaveBeenCalledWith(`${sessions}\\${name}`, expect.anything());
      expect(decodeRequest(launch.argv)["filesystem"]["deniedPaths"]).toEqual([`${sessions}\\cloud`, `${sessions}\\one\\.ssh`]);
    } finally {
      expect(await lifecycle.dispose()).toEqual([]);
      h.readdir.mockReset();
      h.lstat.mockReset();
    }
  });

  it("refuses without the ASRT proxy, since the container would have no network path", async () => {
    h.openRelay.mockRejectedValueOnce(new Error("the sandbox proxy is not running"));
    const lifecycle = createContainedShellLifecycle();
    await expect(prepareMxcShellLaunch(INPUT, lifecycle)).rejects.toThrow(/sandbox proxy is not running/);
    expect(await lifecycle.dispose()).toEqual([]);
  });

  it("refuses when the launcher is missing from the installation", async () => {
    relay();
    const lifecycle = createContainedShellLifecycle();
    // Fixed words: the launcher's absolute path is not part of the failure.
    await expect(prepareMxcShellLaunch({ ...INPUT, exists: (p) => !p.endsWith("wxc-exec.exe") }, lifecycle))
      .rejects.toThrow(/^Contained shell launcher is missing from this installation$/u);
    expect(await lifecycle.dispose()).toEqual([]);
    expect(h.openRelay).not.toHaveBeenCalled();
  });

  it("refuses in fixed words, with no cause, when the launcher cannot be verified", async () => {
    relay();
    h.wxcExec.mockRejectedValueOnce(new Error(String.raw`launcher D:\example\outside\wxc-exec.exe is not the pinned build`));
    const lifecycle = createContainedShellLifecycle();
    const error: unknown = await prepareMxcShellLaunch(INPUT, lifecycle).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Contained shell launcher could not be verified on this installation");
    expect((error as Error).cause).toBeUndefined();
    expect(await lifecycle.dispose()).toEqual([]);
    expect(h.openRelay).not.toHaveBeenCalled();
  });

  it.each([
    ["the request cannot be built", { cwd: String.raw`D:\elsewhere` }, /./],
    ["the policy exceeds the delivery cap", { commandLine: "x".repeat(MXC_REQUEST_CHARACTER_LIMIT) }, /^Windows sandbox policy is too large:/],
  ] as const)("hands every endpoint it bound to its owner when %s", async (_case, change, failure) => {
    relay();
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const lifecycle = createContainedShellLifecycle();
    await expect(prepareMxcShellLaunch({ ...INPUT, ...change }, lifecycle)).rejects.toThrow(failure);
    const server = listen.mock.contexts[0] as net.Server | undefined;
    expect(server?.listening).toBe(true);
    expect(await lifecycle.dispose()).toEqual([]);
    expect(server?.listening).toBe(false);
    expect(h.closeRelay).toHaveBeenCalledOnce();
  });

  it("closes a listener whose bind was still pending when the invocation ended", async () => {
    relay();
    const lifecycle = createContainedShellLifecycle();
    const listen = net.Server.prototype.listen;
    const bind = deferred<void>();
    const binding = deferred<void>();
    const servers: net.Server[] = [];
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
      servers.push(this);
      binding.resolve();
      void bind.promise.then(() => listen.apply(this, args as Parameters<typeof listen>));
      return this;
    });
    const prepared = prepareMxcShellLaunch(INPUT, lifecycle).then(() => "prepared", (error: unknown) => error);
    await binding.promise;
    expect(servers).toHaveLength(1);
    lifecycle.revoke();
    bind.resolve();
    expect(await prepared).toBeInstanceOf(Error);
    expect(await lifecycle.dispose()).toEqual([]);
    expect(servers.every((server) => !server.listening)).toBe(true);
    expect(h.closeRelay).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== "win32")("releases an unused policy pipe with the invocation listener", async () => {
    const release = vi.fn(async () => {});
    vi.spyOn(policyPipe, "openMxcPolicyPipe").mockResolvedValue({ bindChild: () => {}, release });
    relay();
    const lifecycle = createContainedShellLifecycle();
    const launch = await prepareMxcShellLaunch({ ...INPUT, commandLine: "x".repeat(25_000) }, lifecycle);
    expect(launch.argv[1]).toBe("--config");
    expect(await lifecycle.dispose()).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect(await probePort(launch.proxyPort)).toBe("refused");
  });

  it.each(["release", "cancel", "consent"] as const)("stops every tunnel at once when %s ends a running invocation, and keeps its ports until the job exits", async (trigger) => {
    const controller = new AbortController();
    const consent = isWindowsShellLocalNetworkAccessAllowed();
    const invocation = openEgressInvocation({
      kind: "shell", toolName: "powershell", toolUseId: undefined, requiresListener: true,
      context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" },
    }, { abortSignal: controller.signal });
    const upstream = await echoParentProxy();
    relay(upstream.port);
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const lifecycle = createContainedShellLifecycle();
    const exit = deferred<void>();
    let tunnel: net.Socket | undefined;
    try {
      const launch = await prepareMxcShellLaunch({ ...INPUT, egressToken: invocation.token }, lifecycle);
      // The front listener: the last server bound is the hold on the IPv6 loopback port.
      const server = listen.mock.contexts.at(-2) as net.Server;
      const accepted: net.Socket[] = [];
      server.on("connect", (_request, socket: net.Socket) => accepted.push(socket));
      launch.activate();
      lifecycle.jobStarted(exit.promise);
      tunnel = await openTunnel(launch.proxyPort);
      expect(upstream.received).toBe("ping");
      const tunnelClosed = closed(tunnel);

      if (trigger === "release") invocation.release();
      else if (trigger === "cancel") controller.abort();
      else setWindowsShellLocalNetworkAccess(!consent);
      // Before any await: the token names nobody, admission is closed and the tunnel is torn down.
      expect(lifecycle.signal.aborted).toBe(true);
      expect(egressInvocationOwner(invocation.token)).toBeUndefined();
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.destroyed).toBe(true);
      tunnel.write("after");

      await within(tunnelClosed, "tunnel teardown");
      await within(upstream.drained(), "parent tunnel close");
      expect(upstream.received).toBe("ping");
      expect(await probePort(launch.proxyPort)).toBe("dropped");
      // The job is still running: its ports stay reserved and nothing is closed yet.
      expect(server.listening).toBe(true);
      expect(h.closeRelay).not.toHaveBeenCalled();
      exit.resolve();
      expect(await lifecycle.dispose()).toEqual([]);
      expect(server.listening).toBe(false);
      expect(h.closeRelay).toHaveBeenCalledOnce();
      expect(await probePort(launch.proxyPort)).toBe("refused");
    } finally {
      exit.resolve();
      tunnel?.destroy();
      await lifecycle.dispose();
      invocation.release();
      await upstream.close();
      if (trigger === "consent") setWindowsShellLocalNetworkAccess(consent);
    }
  });

  it.skipIf(process.platform !== "win32").each(["release", "cancel", "consent"] as const)("releases the policy pipe even when a release observer throws during %s", async (trigger) => {
    const controller = new AbortController();
    const consent = isWindowsShellLocalNetworkAccessAllowed();
    const invocation = openEgressInvocation({
      kind: "shell", toolName: "powershell", toolUseId: undefined, requiresListener: true,
      context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" },
    }, { abortSignal: controller.signal });
    const releasePipe = vi.fn(async () => {});
    vi.spyOn(policyPipe, "openMxcPolicyPipe").mockResolvedValue({ bindChild: () => {}, release: releasePipe });
    relay();
    const failure = new Error("Invocation release observer failed");
    const unsubscribe = onEgressInvocationReleased((token) => {
      if (token === invocation.token) throw failure;
    });
    const lifecycle = createContainedShellLifecycle();
    try {
      const launch = await prepareMxcShellLaunch({ ...INPUT, egressToken: invocation.token, commandLine: "x".repeat(25_000) }, lifecycle);
      if (trigger === "release") launch.activate();
      else if (trigger === "cancel") controller.abort();
      else setWindowsShellLocalNetworkAccess(!consent);
      const released = await lifecycle.dispose();
      expect(released).toEqual([failure]);
      expect(releasePipe).toHaveBeenCalledOnce();
      expect(h.closeRelay).toHaveBeenCalledOnce();
      expect(await probePort(launch.proxyPort)).toBe("refused");
      expect(await lifecycle.dispose()).toBe(released);
      expect(releasePipe).toHaveBeenCalledOnce();
      expect(h.closeRelay).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      await lifecycle.dispose();
      invocation.release();
      if (trigger === "consent") setWindowsShellLocalNetworkAccess(consent);
    }
  });
});
