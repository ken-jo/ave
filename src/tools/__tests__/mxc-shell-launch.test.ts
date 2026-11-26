import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as winPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMxcShellLaunchAdmissionFixture } from "../../__tests__/support/mxc-shell-launch-admission.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { configureHostResources } from "../../main/host-resources.js";
import { closed, echoParentProxy, openTunnel, probePort, within } from "../../__tests__/support/proxy-tunnel-probe.js";
import { isWatchedWorkspaceConsumable, pruneWatchedRows, WATCHED_ROW_VIOLATION, watchedProtectedRows } from "../../permissions/windows-watched-rows.js";

const h = vi.hoisted(() => ({
  openRelay: vi.fn(),
  floor: vi.fn(() => [] as string[]),
  userDenies: vi.fn(() => [] as string[]),
  boundary: vi.fn((_path: string): string | undefined => undefined),
  privateRoots: vi.fn(() => [] as string[]),
  liveHomes: new Set<string>(),
  wxcExec: vi.fn(async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`),
  registerPort: vi.fn(),
  recordRefusal: vi.fn(),
  closeRelay: vi.fn(async () => {}),
  // The synthetic C: drive the fixture paths live on. A placeholder is a non-link reparse directory (a cloud file), and a
  // vanished entry is still listed but gone when looked up; a listing reports both, and every link, as a link.
  drive: new Map<string, { path: string; kind: DriveKind; target?: string }>(),
  listed: [] as string[],
  synthetic: /^(\\\\\?\\)?c:\\/iu,
  // The runtime root start-up proved, or the refusal of one that was not.
  startRoot: vi.fn((): string => "C:\\Users\\alice\\AppData\\Local\\ai.agent-connector.ave\\mxc-runtime"),
  // Stands for the issued-HOME identity check (its own suite runs it on real directories): the invocation's HOME itself.
  issuedHome: vi.fn((cwd: string, home: string | undefined): boolean => cwd === home),
}));
vi.mock("../../permissions/mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/mxc-runtime-root.js")>(),
  requireMxcContainerStartRoot: () => h.startRoot(),
}));
vi.mock("../../permissions/sandbox-home-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/sandbox-home-registry.js")>(),
  isIssuedContainerHome: (cwd: string, home: string | undefined) => h.issuedHome(cwd, home),
}));
type DriveKind = "dir" | "file" | "link" | "placeholder" | "vanished";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { win32 } = await import("node:path");
  const synthetic = (path: unknown): path is string => typeof path === "string" && h.synthetic.test(path);
  const spell = (path: string) => win32.normalize(path.replace(/^\\\\\?\\/u, ""));
  const key = (path: string) => spell(path).toLowerCase().replace(/\\$/u, "");
  const resolve = (path: string, hops = 0): string | undefined => {
    let current: string | undefined = spell(path).slice(0, 3).toUpperCase();
    for (const part of spell(path).slice(3).split("\\").filter(Boolean)) {
      const next = h.drive.get(key(win32.join(current, part)));
      if (next === undefined || next.kind === "vanished") return undefined;
      current = next.kind !== "link" ? next.path : hops > 8 || next.target === undefined ? undefined : resolve(next.target, hops + 1);
      if (current === undefined) return undefined;
    }
    return current;
  };
  const lookup = (path: string) => {
    if (spell(path).length === 3) return { path: spell(path).toUpperCase(), kind: "dir" as const, target: undefined };
    const parent = resolve(win32.dirname(spell(path)));
    const found = parent === undefined ? undefined : h.drive.get(key(win32.join(parent, win32.basename(spell(path)))));
    return found?.kind === "vanished" ? undefined : found;
  };
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const stats = (kind: DriveKind) => ({ isSymbolicLink: () => kind === "link",
    isDirectory: () => kind === "dir" || kind === "placeholder", isFile: () => kind === "file" });
  const real = (path: string) => {
    const resolved = resolve(path);
    if (resolved === undefined) throw missing(path);
    return resolved;
  };
  return { ...actual,
    existsSync: (path: unknown) => synthetic(path) ? resolve(path) !== undefined : actual.existsSync(path as string),
    accessSync: ((path: unknown, mode?: number) => synthetic(path) ? void real(path) : actual.accessSync(path as string, mode)) as typeof actual.accessSync,
    lstatSync: ((path: unknown, options?: { throwIfNoEntry?: boolean }) => {
      if (!synthetic(path)) return actual.lstatSync(path as string, options as never);
      const found = lookup(path);
      if (found !== undefined) return stats(found.kind);
      if (options?.throwIfNoEntry === false) return undefined;
      throw missing(path);
    }) as typeof actual.lstatSync,
    statSync: ((path: unknown, options?: unknown) => synthetic(path) ? stats(lookup(real(path))?.kind ?? "dir")
      : actual.statSync(path as string, options as never)) as typeof actual.statSync,
    readlinkSync: ((path: unknown, options?: unknown) => {
      if (!synthetic(path)) return actual.readlinkSync(path as string, options as never);
      const found = lookup(path);
      if (found?.kind !== "link" || found.target === undefined) throw Object.assign(new Error(`EINVAL: ${path}`), { code: "EINVAL" });
      return found.target;
    }) as typeof actual.readlinkSync,
    realpathSync: Object.assign((path: unknown, options?: unknown) => synthetic(path) ? real(path) : actual.realpathSync(path as string, options as never),
      { native: (path: unknown, options?: unknown) => synthetic(path) ? real(path) : actual.realpathSync.native(path as string, options as never) }),
    opendirSync: ((path: unknown, options?: unknown) => {
      if (!synthetic(path)) return actual.opendirSync(path as string, options as never);
      const directory = real(path);
      h.listed.push(spell(path));
      const entries = [...h.drive.values()].filter(entry => win32.dirname(entry.path).toLowerCase() === directory.toLowerCase())
        .map(entry => ({ name: win32.basename(entry.path), isSymbolicLink: () => entry.kind !== "dir" && entry.kind !== "file",
          isDirectory: () => entry.kind === "dir", isFile: () => entry.kind === "file" }));
      return { readSync: () => entries.shift() ?? null, closeSync: () => {} };
    }) as typeof actual.opendirSync,
  };
});
// Admission pins the synthetic drive by the same entries; other drives keep the native facts.
vi.mock("../../shared/windows-path-facts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/windows-path-facts.js")>();
  const { win32 } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs");
  type Facts = ReturnType<typeof actual.pinWindowsPaths>[number];
  const facts = (path: string): Facts => {
    const entry = fs.lstatSync(path, { throwIfNoEntry: false });
    const canonical = entry === undefined ? null : fs.realpathSync.native(path);
    const listed = h.drive.get(win32.normalize(path).toLowerCase().replace(/\\$/u, ""));
    const link = entry?.isSymbolicLink() === true;
    const reparseTag = link ? 0xa0000003 : listed?.kind === "placeholder" ? 0x9000001a : 0;
    const directory = entry?.isDirectory() === true || link;
    const id = canonical === null ? null : `0x${createHash("md5").update(canonical.toLowerCase()).digest("hex")}`;
    const volume = id === null ? null : "0x0000000000000007";
    return { exists: canonical !== null, canonical, directory, attributes: (directory ? 0x10 : 0) | (reparseTag === 0 ? 0 : 0x400),
      volumeSerial: volume, volumeSerialNumber: volume, fileId: id, fileIndex: id, changeTime: id === null ? null : "0x0000000000000001",
      fileSystemName: null, reparseTag, reparseTarget: link ? listed?.target ?? null : null, ancestors: [] };
  };
  const pin = (path: string): Facts => {
    const ancestors: Facts[] = [];
    for (let parent = win32.dirname(path); ; parent = win32.dirname(parent)) {
      ancestors.unshift(facts(parent));
      if (parent === win32.dirname(parent)) break;
    }
    return { ...facts(path), ancestors };
  };
  return { ...actual, pinWindowsPaths: (paths: readonly string[]) => paths.flatMap(path =>
    h.synthetic.test(path) ? [pin(path)] : actual.pinWindowsPaths([path])) };
});
function onDrive(path: string, kind: DriveKind = "dir", target?: string): void {
  for (let parent = winPath.dirname(path); parent !== winPath.dirname(parent); parent = winPath.dirname(parent)) {
    if (!h.drive.has(parent.toLowerCase())) h.drive.set(parent.toLowerCase(), { path: parent, kind: "dir" });
  }
  h.drive.set(path.toLowerCase(), { path, kind, ...(target === undefined ? {} : { target }) });
}
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
  getUserReadDenies: h.userDenies,
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
import * as sandboxCapability from "../../permissions/sandbox-capability.js";

// The container route goes away: no capability, announced as a status change.
function endRoute(): () => void {
  const requested = sandboxCapability.isShellSandboxRequestedAtBoot();
  vi.mocked(sandboxCapability.detectMxcShellCapability).mockReturnValue(undefined);
  sandboxCapability.setShellSandboxRequestedAtBoot(!requested);
  return () => sandboxCapability.setShellSandboxRequestedAtBoot(requested);
}

const WS = String.raw`C:\work\repo`;
beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  h.drive.clear();
  h.listed.length = 0;
  onDrive(WS);
});
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
  it.runIf(process.platform === "win32")("sweeps only the watched project children after the shell job exits", async () => {
    relay();
    configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false });
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-shell-watch-")));
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    const carrier = join(cwd, ".ave");
    const agents = join(cwd, ".agents");
    const children = [join(carrier, "commands"), join(carrier, "hooks")];
    const denied = [agents, ...children];
    const lifecycle = createContainedShellLifecycle();
    const job = deferred<void>();
    try {
      const launch = await prepareMxcShellLaunch({ ...INPUT, cwd,
        filesystem: { ...INPUT.filesystem, allowWrite: [cwd], denyWrite: denied, requiredWriteDenies: denied },
        exists: (path) => existsSync(path) || path.endsWith("wxc-exec.exe"),
      }, lifecycle);
      expect(decodeRequest(launch.argv).filesystem.deniedPaths).toEqual([agents]);
      expect(existsSync(carrier)).toBe(false);
      expect(watchedProtectedRows()).toEqual(expect.arrayContaining(children));
      pruneWatchedRows([]);
      lifecycle.jobStarted(job.promise);
      mkdirSync(carrier);
      for (const child of children) mkdirSync(child);
      const sibling = join(carrier, "ordinary.txt");
      writeFileSync(sibling, "keep");
      expect(isWatchedWorkspaceConsumable(cwd)).toBe(false);
      const disposal = lifecycle.dispose();
      expect(children.every(existsSync)).toBe(true);
      job.resolve(undefined);
      expect(await disposal).toEqual([]);
      expect(launch.watchedNotice).toContain(WATCHED_ROW_VIOLATION);
      expect(children.some(existsSync)).toBe(false);
      expect(watchedProtectedRows().some((path) => children.includes(path))).toBe(false);
      expect(isWatchedWorkspaceConsumable(cwd)).toBe(true);
      expect(readFileSync(sibling, "utf8")).toBe("keep");
    } finally {
      job.resolve(undefined);
      await lifecycle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    for (const path of [workspace, `${home}\\logs`, `${home}\\traces`]) onDrive(path);
    const lifecycle = createContainedShellLifecycle();
    try {
      const launch = await prepareMxcShellLaunch({ ...INPUT, cwd: workspace, filesystem: {
        // The home boundary is a read boundary, as the shell composes it; a re-allowed child carves it.
        allowWrite: [workspace, `${home}\\logs`], allowRead: [`${home}\\traces`, workspace], denyRead: [`${home}\\`], denyWrite: [],
      } }, lifecycle);
      const request = decodeRequest(launch.argv);
      expect(request.filesystem.readwritePaths).toEqual([workspace]);
      expect(JSON.stringify(request.filesystem)).not.toMatch(/logs|traces/);
    } finally {
      expect(await lifecycle.dispose()).toEqual([]);
    }
  });

  it("states the user's read denies as their own rows: one inside a grant is denied, one over the workspace refuses the launch", async () => {
    relay();
    const secret = winPath.join(WS, "secret");
    onDrive(secret);
    try {
      h.userDenies.mockReturnValue([secret]);
      const lifecycle = createContainedShellLifecycle();
      try {
        const request = decodeRequest((await prepareMxcShellLaunch(INPUT, lifecycle)).argv);
        expect(request.filesystem.readwritePaths).toEqual([WS]);
        expect(request.filesystem.deniedPaths).toEqual([secret]);
      } finally {
        expect(await lifecycle.dispose()).toEqual([]);
      }
      h.userDenies.mockReturnValue([WS]);
      const refused = createContainedShellLifecycle();
      try {
        await expect(prepareMxcShellLaunch(INPUT, refused)).rejects.toThrow(/working directory must lie inside a granted path/);
      } finally {
        await refused.dispose();
      }
    } finally {
      h.userDenies.mockReturnValue([]);
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
      // Admission ranks only what is on the drive.
      for (const path of [OWN, `${OWN}\\AppData`, `${ROOT}-other\\repo`, ...CLOSED]) onDrive(path);
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

    it("refuses the launch before anything is allocated while the root is not proved", async () => {
      h.startRoot.mockImplementationOnce(() => { throw new Error("Container runtime root was not established when the sandbox started"); });
      const lifecycle = createContainedShellLifecycle();
      try {
        await expect(prepareMxcShellLaunch({ ...INPUT, sandboxHome: OWN }, lifecycle)).rejects.toThrow(/not established/u);
        expect(h.wxcExec).not.toHaveBeenCalled();
        expect(h.openRelay).not.toHaveBeenCalled();
      } finally {
        expect(await lifecycle.dispose()).toEqual([]);
      }
    });

    it("admits a working directory beside it", async () => {
      const sibling = `${ROOT}-other\\repo`;
      const filesystem = await launchWith({ cwd: sibling, sandboxHome: OWN, filesystem: { allowWrite: [sibling, OWN], allowRead: [], denyRead: [], denyWrite: [] } });
      expect(filesystem.readwritePaths).toEqual([sibling, OWN]);
    });

    it("admits its own issued HOME itself, asking with this invocation's HOME", async () => {
      const filesystem = await launchWith({ cwd: OWN, sandboxHome: OWN, filesystem: { allowWrite: [OWN], allowRead: [], denyRead: [], denyWrite: [] } });
      expect(filesystem.readwritePaths).toEqual([OWN]);
      expect(h.issuedHome).toHaveBeenCalledWith(OWN, OWN);
    });

    it("refuses its own HOME by name once it is no longer the directory issued", async () => {
      h.issuedHome.mockReturnValueOnce(false);
      await expect(launchWith({ cwd: OWN, sandboxHome: OWN, filesystem: { allowWrite: [OWN], allowRead: [], denyRead: [], denyWrite: [] } }))
        .rejects.toThrow(/working directory is inside the sandbox runtime root/u);
    });

    it.each([...CLOSED, `${OWN}\\work`])("refuses a working directory inside it: %s", async (cwd) => {
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
    const sessions = String.raw`C:\Users\bob\.ave\sessions`;
    // Listing reports every reparse point as a link; lstat separates a real link from a cloud placeholder directory.
    onDrive(`${sessions}\\one\\.ssh`);
    onDrive(String.raw`C:\Users\bob\elsewhere\.ssh`);
    onDrive(`${sessions}\\link`, "link", String.raw`C:\Users\bob\elsewhere`);
    onDrive(`${sessions}\\cloud`, "placeholder");
    onDrive(`${sessions}\\gone`, "vanished");
    const lifecycle = createContainedShellLifecycle();
    try {
      // A pattern row is expanded over the filesystem whatever its floor.
      const pattern = `${sessions}/**/.ssh`;
      const launch = await prepareMxcShellLaunch({ ...INPUT, filesystem: { ...INPUT.filesystem, allowRead: [sessions],
        denyRead: [pattern] } }, lifecycle);
      expect(h.listed).toContain(sessions);
      for (const name of ["link", "cloud", "gone"]) expect(h.listed).not.toContain(`${sessions}\\${name}`);
      expect(decodeRequest(launch.argv)["filesystem"]["deniedPaths"]).toEqual([`${sessions}\\cloud`, `${sessions}\\one\\.ssh`]);
    } finally {
      expect(await lifecycle.dispose()).toEqual([]);
    }
  });

  it("skips entries removed since the listing, so they count toward no walk cap", async () => {
    relay();
    const sessions = String.raw`C:\Users\bob\.ave\sessions`;
    onDrive(`${sessions}\\one\\.ssh`);
    // One more than the walk cap; a listing still reports each, as a link.
    for (let index = 0; index <= 20_000; index++) onDrive(`${sessions}\\gone-${index}`, "vanished");
    const lifecycle = createContainedShellLifecycle();
    try {
      const pattern = `${sessions}/**/.ssh`;
      const launch = await prepareMxcShellLaunch({ ...INPUT, filesystem: { ...INPUT.filesystem, allowRead: [sessions],
        denyRead: [pattern] } }, lifecycle);
      expect(decodeRequest(launch.argv).filesystem.deniedPaths).toEqual([`${sessions}\\one\\.ssh`]);
    } finally {
      expect(await lifecycle.dispose()).toEqual([]);
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

  it.each(["release", "cancel", "route"] as const)("stops every tunnel at once when %s ends a running invocation, and keeps its ports until the job exits", async (trigger) => {
    const controller = new AbortController();
    let restoreRoute: (() => void) | undefined;
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
      else restoreRoute = endRoute();
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
      restoreRoute?.();
    }
  });

  it.skipIf(process.platform !== "win32").each(["release", "cancel", "route"] as const)("releases the policy pipe even when a release observer throws during %s", async (trigger) => {
    const controller = new AbortController();
    let restoreRoute: (() => void) | undefined;
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
      else restoreRoute = endRoute();
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
      restoreRoute?.();
    }
  });
});
