/** The browser's download staging folder through the Windows launch projections of every confined lane: the container shell request
 * handed to its launcher, the srt-win session floor and worker wrap handed to the runtime, the ACL holder's grant turn, and the
 * container holder's request handed to its native entry. Only the OS edge is a stand-in (an in-memory Windows drive, native path
 * facts and DACLs, the runtime's native calls, the launcher and the native process entry); every projection composer runs for real.
 * Each lane is checked for the folder and a staged file inside it, for read, list and write, against grants that name the folder, a
 * path in it, the Ave home or a parent of it, under a relocated Ave home and the default profile-child one, including a process whose
 * projection was taken before the folder existed. */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { checkSandboxStampTargets } from "../../__tests__/support/ave-home-isolation-guard.js";
import { withProvidedContext } from "../../__tests__/support/provided-context.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";

const { PROFILE } = vi.hoisted(() => ({ PROFILE: "C:\\Users\\alice" }));
const drive = vi.hoisted(() => ({
  dirs: new Set<string>(),
  files: new Set<string>(),
  identities: new Map<string, number>(),
  // Paths whose DACL also grants Users read: their read deny is "readable" evidence and stays a deny row.
  readable: new Set<string>(),
}));
const runtime = vi.hoisted(() => ({
  initialize: vi.fn(), wrap: vi.fn(), update: vi.fn(), grant: vi.fn(), stamp: vi.fn(), revoke: vi.fn(), spawn: vi.fn(), nativeSpawn: vi.fn(),
  containerBackend: false,
}));

vi.mock("node:path", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
vi.mock("node:module", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveModule(await original()));
vi.mock("../windows-stamp-targets.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedStampTargets(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original(), "linux"));
// An in-memory Windows drive: drive-letter paths exist only once a test creates them; every other path reaches the real filesystem.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const { win32 } = await vi.importActual<typeof import("node:path")>("node:path");
  const isDrive = (path: unknown): path is string => typeof path === "string" && /^[a-z]:[\\/]/iu.test(path);
  const key = (path: string): string => {
    const normalized = win32.normalize(path).replace(/[\\/]+$/, "");
    return (normalized.endsWith(":") ? `${normalized}\\` : normalized).toLowerCase();
  };
  const isRoot = (path: string): boolean => /^[a-z]:[\\/]?$/iu.test(path);
  const dir = (path: string): boolean => isRoot(path) || [...drive.dirs].some((entry) => key(entry) === key(path));
  const file = (path: string): boolean => [...drive.files].some((entry) => key(entry) === key(path));
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });
  const identity = (path: string): number => {
    const known = drive.identities.get(key(path));
    if (known !== undefined) return known;
    const next = drive.identities.size + 100;
    drive.identities.set(key(path), next);
    return next;
  };
  const stat = (path: string, bigint: boolean) => {
    const n = (value: number) => (bigint ? BigInt(value) : value);
    return {
      isSymbolicLink: () => false, isDirectory: () => dir(path), isFile: () => file(path),
      dev: n(7), ino: n(identity(path)), uid: n(0), gid: n(0), mode: n(dir(path) ? 0o40700 : 0o100600), size: n(4096),
      mtimeMs: n(1), ctimeMs: n(1), mtimeNs: 1n, ctimeNs: 1n, birthtimeNs: 1n,
    };
  };
  const present = (path: string): boolean => dir(path) || file(path);
  const realpath = (path: string): string => {
    if (!present(path)) throw enoent(path);
    return win32.normalize(path).replace(/(?<!:)[\\/]+$/, "");
  };
  const stats = (real: typeof actual.lstatSync) => ((path: unknown, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) => {
    if (!isDrive(path)) return real(path as string, options as never);
    if (!present(path)) {
      if (options?.throwIfNoEntry === false) return undefined;
      throw enoent(path);
    }
    return stat(path, options?.bigint === true);
  }) as typeof actual.lstatSync;
  const names = (path: string): string[] => [...new Set([...drive.dirs, ...drive.files]
    .filter((entry) => key(win32.dirname(entry)) === key(path) && key(entry) !== key(path)).map((entry) => win32.basename(entry)))];
  const remove = (path: string): void => {
    for (const set of [drive.dirs, drive.files]) for (const entry of [...set]) if (key(entry) === key(path)) set.delete(entry);
  };
  const modelled = {
    existsSync: (path: unknown) => (isDrive(path) ? present(path) : actual.existsSync(path as string)),
    realpathSync: Object.assign((path: unknown, options?: unknown) => (isDrive(path) ? realpath(path) : actual.realpathSync(path as string, options as never)), {
      native: (path: unknown, options?: unknown) => (isDrive(path) ? realpath(path) : actual.realpathSync.native(path as string, options as never)),
    }),
    lstatSync: stats(actual.lstatSync),
    statSync: stats(actual.statSync as typeof actual.lstatSync) as unknown as typeof actual.statSync,
    readdirSync: ((path: unknown, options?: { withFileTypes?: boolean }) => {
      if (!isDrive(path)) return actual.readdirSync(path as string, options as never);
      if (!dir(path)) throw enoent(path);
      return options?.withFileTypes === true
        ? names(path).map((name) => ({ name, isDirectory: () => dir(win32.join(path, name)), isFile: () => file(win32.join(path, name)), isSymbolicLink: () => false }))
        : names(path);
    }) as typeof actual.readdirSync,
    mkdirSync: ((path: unknown, options?: unknown) => {
      if (!isDrive(path)) return actual.mkdirSync(path as string, options as never);
      for (let entry = win32.normalize(path); win32.dirname(entry) !== entry; entry = win32.dirname(entry)) drive.dirs.add(entry);
      return undefined;
    }) as typeof actual.mkdirSync,
    rmdirSync: ((path: unknown) => (isDrive(path) ? remove(path) : actual.rmdirSync(path as string))) as typeof actual.rmdirSync,
    unlinkSync: ((path: unknown) => (isDrive(path) ? remove(path) : actual.unlinkSync(path as string))) as typeof actual.unlinkSync,
    chmodSync: ((path: unknown, mode: unknown) => (isDrive(path) ? undefined : actual.chmodSync(path as string, mode as never))) as typeof actual.chmodSync,
  };
  // Any other call on a drive path would reach the host's filesystem as a relative path: answer it as absent instead.
  const unmodelled = Object.fromEntries(Object.entries(actual).filter(([name, value]) => typeof value === "function" && !(name in modelled))
    .map(([name, value]) => [name, (...args: unknown[]) => {
      if (isDrive(args[0])) throw Object.assign(new Error(`ENOENT: the simulated drive does not model ${name}: '${args[0]}'`), { code: "ENOENT" });
      return Reflect.apply(value as (...values: unknown[]) => unknown, actual, args);
    }]));
  const fs = { ...actual, ...unmodelled, ...modelled };
  return { ...fs, default: fs };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const guarded = Object.fromEntries(Object.entries(actual).filter(([, value]) => typeof value === "function").map(([name, value]) => [name, async (...args: unknown[]) => {
    if (typeof args[0] === "string" && /^[a-z]:[\\/]/iu.test(args[0])) throw Object.assign(new Error(`ENOENT: the simulated drive does not model ${name}`), { code: "ENOENT" });
    return Reflect.apply(value as (...values: unknown[]) => unknown, actual, args);
  }]));
  return { ...actual, ...guarded, default: { ...actual, ...guarded } };
});
// Native path facts and DACLs of the in-memory drive. The Ave home is private to its owner, as boot verifies; a path in
// `drive.readable` also grants Users read, which makes its read deny "readable" evidence.
vi.mock("../../shared/windows-path-facts.js", async (original) => {
  const actual = await original<typeof import("../../shared/windows-path-facts.js")>();
  const fs = await import("node:fs");
  const { win32 } = await vi.importActual<typeof import("node:path")>("node:path");
  const owner = "S-1-5-21-100-200-300-1001";
  const facts = (path: string) => {
    const info = fs.lstatSync(path, { throwIfNoEntry: false, bigint: true });
    if (info === undefined) {
      return { exists: false as const, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null, fileIndex: null,
        fileSystemName: null, changeTime: null, attributes: 0, reparseTag: 0, directory: false, reparseTarget: null, ancestors: [] };
    }
    return { exists: true as const, canonical: win32.normalize(path).replace(/(?<!:)[\\/]+$/, ""), volumeSerial: `0x${info.dev.toString(16)}`,
      fileId: `0x${info.ino.toString(16).padStart(32, "0")}`, volumeSerialNumber: `0x${info.dev.toString(16)}`, fileIndex: `0x${info.ino.toString(16)}`,
      fileSystemName: null, changeTime: "0x1", attributes: info.isDirectory() ? 16 : 0, reparseTag: 0, directory: info.isDirectory(),
      reparseTarget: null, ancestors: [] };
  };
  const readable = (path: string): boolean => [...drive.readable].some((entry) => win32.normalize(entry).replace(/[\\/]+$/, "").toLowerCase()
    === win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase());
  return {
    ...actual,
    pinWindowsPaths: (paths: readonly string[]) => paths.map(facts),
    readWindowsDacls: (paths: readonly string[], options?: { parent?: boolean }) => paths.map((path) => {
      const row = facts(path);
      const aces = [{ type: 0, flags: 3, mask: 0x1f01ff, sid: owner }, ...(readable(path) ? [{ type: 0, flags: 3, mask: 0x1200a9, sid: "S-1-5-32-545" }] : [])];
      const dacl = row.exists ? { identity: { volumeSerial: row.volumeSerial, fileId: row.fileId }, owner, protected: true, nullDacl: false, aces } : null;
      return { ...row, currentUserSid: owner, elevated: false, principals: {}, dacl, ...(options?.parent ? { parent: dacl } : {}) };
    }),
  };
});
vi.mock("../../shared/policy-home.js", async (original) => ({
  ...await original<typeof import("../../shared/policy-home.js")>(),
  policyHomeAnchors: () => [PROFILE],
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => (process.platform === "win32" ? PROFILE : actual.homedir()) };
});
// The container shell's OS edge: the host relay its listener forwards to, and the installed launcher.
vi.mock("../egress-host-listener.js", async (original) => ({
  ...await original<typeof import("../egress-host-listener.js")>(),
  openHostEgressListener: async () => ({ port: 9, proxyAuthorization: "Basic eA==", registerPort: () => {}, recordRefusal: () => {}, close: async () => {} }),
  openMxcEgressLease: async () => ({ url: "http://127.0.0.1:43210", port: 43210, close: async () => {} }),
}));
// The container holder's OS edge: the native process entry, and the boot plan that selects the container backend.
vi.mock("../mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: (...args: unknown[]) => runtime.nativeSpawn(...args) }));
vi.mock("../sandbox-capability.js", async (original) => {
  const actual = await original<typeof import("../sandbox-capability.js")>();
  const { planWindowsExtensionHolder } = await import("../mxc-extension-readiness.js");
  const ready = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" }, fallback: { version: "0.0.80", ready: false } });
  return { ...actual, getWindowsExtensionBackendPlan: () => (runtime.containerBackend ? ready : actual.getWindowsExtensionBackendPlan()) };
});
vi.mock("../mxc-windows.js", async (original) => ({
  ...await original<typeof import("../mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => "C:\\Program Files\\Ave\\resources\\mxc\\x64\\wxc-exec.exe",
}));

// The srt-win runtime's native edge: what it is initialized with, what each wrap hands it, and its ACL grant, stamp and revoke calls.
vi.mock("@anthropic-ai/sandbox-runtime", async (original) => {
  const actual = await original<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    SandboxManager: {
      ...actual.SandboxManager,
      initialize: runtime.initialize,
      wrapWithSandboxArgv: runtime.wrap,
      reset: vi.fn(async () => undefined),
      updateConfig: runtime.update,
      openInvocationListener: vi.fn(async () => undefined),
      closeInvocationListener: vi.fn(),
      cleanupAfterCommand: vi.fn(),
      setParentProxyRouter: vi.fn(),
      setSignalCleanupOwnedByHost: vi.fn(),
      getProxyPort: () => undefined,
      getSocksProxyPort: () => undefined,
    },
    resolveSrtWin: () => ({ path: "C:\\Program Files\\Ave\\resources\\srt-win\\srt-win.exe" }),
    getWindowsSandboxUserStatus: () => ({ provisioned: true, credPresent: true, sid: "S-1-5-21-100-200-300-2002" }),
    grantWindowsAcl: runtime.grant,
    stampWindowsAcl: runtime.stamp,
    revokeWindowsAcl: runtime.revoke,
  };
});
vi.mock("../srt-win-integrity.js", async (original) => ({
  ...await original<typeof import("../srt-win-integrity.js")>(),
  prepareSrtWinExecutable: () => "C:\\Program Files\\Ave\\resources\\srt-win\\srt-win.exe",
}));
// The ACL grant holder is a pinned System32 process; a stand-in with a pid.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => runtime.spawn(...args) };
});
vi.mock("../../main/managed-child-processes.js", async (original) => ({
  ...await original<typeof import("../../main/managed-child-processes.js")>(),
  trackManagedChildProcess: vi.fn(),
  assertManagedChildProcessAdmissionOpen: vi.fn(),
}));

const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");
const {
  getBuiltinShellReadPolicy, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths, initializeAsrtSandbox, isAsrtSandboxActive,
  resetAsrtSandbox, wrapWorkerCommand,
} = await import("../asrt-sandbox.js");
const { holdWindowsFilesystemGrant } = await import("../windows-acl-grant-holder.js");
const { createAveHomeBoundarySnapshot } = await import("../ave-home-boundary-snapshot.js");
const { openEgressInvocation } = await import("../egress-invocations.js");
const { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
const { TEST_WORKER_EGRESS_OWNER } = await import("../../__tests__/support/egress-fixture.js");
const { buildMandatorySandboxWritePolicy } = await import("../sandbox-write-policy.js");
const { prepareMxcShellLaunch } = await import("../../tools/mxc-shell-launch.js");
const { existsSync, mkdirSync } = await import("node:fs");

const HOST_PLATFORM = process.platform;
const originalCwd = process.cwd();
const fixtureCwd = useTempDirs("browser-download-drive-");
const STAGED = "0123456789abcdef0123456789abcdef";
const RELOCATED = { name: "a relocated Ave home inside the project", project: `${PROFILE}\\work`, home: `${PROFILE}\\work\\ave` } as const;
const PROFILE_CHILD = { name: "the default profile-child Ave home", project: `${PROFILE}\\work`, home: `${PROFILE}\\.ave` } as const;
const OUTSIDE_PROFILE = { name: "a relocated Ave home outside the profile", project: "D:\\work", home: "D:\\Data\\Ave\\home" } as const;
type Layout = typeof RELOCATED | typeof PROFILE_CHILD | typeof OUTSIDE_PROFILE;

const staging = (): string => `${aveHome()}\\browser-downloads`;
const stagedFile = (): string => `${staging()}\\${STAGED}`;

function useLayout(layout: Layout, options: { staged: boolean }): void {
  vi.stubEnv("AVE_HOME", layout.home);
  for (const path of [`${layout.project}\\src`, `${layout.home}\\sessions`, `${layout.home}\\logs`, `${layout.home}\\secrets`, `${layout.home}\\workspace`,
    "C:\\Program Files\\Ave\\resources\\mxc\\x64"]) mkdirSync(path);
  drive.files.add(`${layout.project}\\src\\main.ts`);
  drive.files.add("C:\\Program Files\\Ave\\resources\\mxc\\x64\\wxc-exec.exe");
  if (options.staged) stage();
}

// A container cannot hold a read-only grant over a deny whose parent is missing too (the deny would be raised onto a directory it can
// read), so a grant of the whole profile is launched only where every row's parent exists, as on an installed profile. Create them;
// the staging row's parent is the Ave home itself, so the folder stays absent.
function materializeProfileRowParents(): void {
  for (const row of getBuiltinShellReadPolicy([PROFILE], PROFILE).denyRead) {
    if (!/^[A-Z]:\\/i.test(row) || /[*?]/.test(row) || !atOrUnder(row, PROFILE)) continue;
    mkdirSync(row.replace(/[\\/]+$/, "").replace(/\\[^\\]+$/, ""));
  }
}

// What the browser's staging does at start and on a download: create the folder, then stage a file in it.
function stage(): void {
  mkdirSync(staging());
  drive.files.add(stagedFile());
}

beforeEach(() => {
  // A foreign drive spelling is relative to the real host; keep that projection inside the validated test scratch.
  if (HOST_PLATFORM !== "win32") process.chdir(fixtureCwd());
  setProcessPlatform("win32");
  vi.stubEnv("USERPROFILE", PROFILE);
  vi.stubEnv("HOME", PROFILE);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mkdirSync(PROFILE);
});

afterEach(async () => {
  try {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    _resetAveHomePrivacyForTest();
  } finally {
    process.chdir(originalCwd);
    setProcessPlatform(HOST_PLATFORM);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    drive.dirs.clear();
    drive.files.clear();
    drive.identities.clear();
    drive.readable.clear();
  }
});

// The arguments of a stand-in's latest call; a stand-in the lane never reached fails the test here.
function lastCall(stub: { mock: { calls: unknown[][] } }): unknown[] {
  const call = stub.mock.calls.at(-1);
  if (call === undefined) throw new Error("the stand-in was never called");
  return call;
}
const fold = (path: string): string => path.replace(/[\\/]+$/, "").toLowerCase();
const atOrUnder = (path: string, parent: string): boolean => fold(path) === fold(parent) || fold(path).startsWith(`${fold(parent)}\\`);

// What a container grants at `path`: the most specific listed path at or above it decides, and a deny or read-only entry outranks a
// grant at the same depth. Nothing listed at or above it means the container cannot reach it at all.
type ContainerAccess = "readwrite" | "readonly" | "denied" | "unreachable";
function containerAccess(filesystem: { readwritePaths: string[]; readonlyPaths: string[]; deniedPaths: string[] }, path: string): ContainerAccess {
  const rules = [
    ...filesystem.readwritePaths.map((rule) => ({ rule, kind: "readwrite" as const, rank: 0 })),
    ...filesystem.readonlyPaths.map((rule) => ({ rule, kind: "readonly" as const, rank: 1 })),
    ...filesystem.deniedPaths.map((rule) => ({ rule, kind: "denied" as const, rank: 2 })),
  ].filter(({ rule }) => atOrUnder(path, rule));
  rules.sort((a, b) => fold(b.rule).length - fold(a.rule).length || b.rank - a.rank);
  return rules[0]?.kind ?? "unreachable";
}

type ContainerFilesystem = { readwritePaths: string[]; readonlyPaths: string[]; deniedPaths: string[] };

/** The filesystem a container shell command is launched with, composed as `spawnPowerShellInMxc` composes it (the shell read
 * policy, the write floor and the mandatory write policy), ranked and encoded by the real launch preparation, and decoded from the
 * launcher's own arguments. */
async function containerShellRequest(input: { cwd: string; writePaths: readonly string[]; readPaths?: readonly string[] }): Promise<ContainerFilesystem> {
  const sandboxHome = `${aveHome()}\\sandbox\\homes\\h1`;
  mkdirSync(sandboxHome);
  const sandboxWritePaths = [...input.writePaths, sandboxHome];
  const { allowRead, denyRead, floorPierces } = getBuiltinShellReadPolicy([input.cwd, ...sandboxWritePaths, ...(input.readPaths ?? [])], PROFILE, sandboxHome);
  const sensitiveDenyWrite = getDefaultSensitiveWriteDenyPaths();
  const mandatory = buildMandatorySandboxWritePolicy(sandboxWritePaths, undefined, sensitiveDenyWrite);
  const launch = await prepareMxcShellLaunch({
    egressToken: "staging-probe",
    commandLine: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand AA==",
    cwd: input.cwd,
    filesystem: {
      allowWrite: mandatory.allowWrite, allowRead, denyRead,
      denyWrite: [...new Set([...sensitiveDenyWrite, ...mandatory.denyWrite.map((entry) => (typeof entry === "string" ? entry : entry.path))])],
      floorPierces,
    },
    env: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: `${PROFILE}\\AppData\\Local` },
    timeoutMs: 5_000,
    exists: existsSync,
  });
  try {
    expect(launch.argv[1]).toBe("--config-base64");
    return (JSON.parse(Buffer.from(launch.argv[2] ?? "", "base64").toString("utf8")) as { filesystem: ContainerFilesystem }).filesystem;
  } finally {
    await launch.release();
  }
}

// No grant names the folder, a path in it, or the Ave home itself; a grant above the home is checked by the access it resolves to.
function expectNoGrantInside(filesystem: ContainerFilesystem): void {
  for (const grant of [...filesystem.readwritePaths, ...filesystem.readonlyPaths]) {
    expect(atOrUnder(grant, staging()) || fold(grant) === fold(aveHome()), grant).toBe(false);
  }
}

describe("the browser download staging folder in a container shell's launch request", () => {
  it("is denied for read, list and write with its staged file when the writable project encloses a relocated Ave home", async () => {
    useLayout(RELOCATED, { staged: true });
    const filesystem = await containerShellRequest({ cwd: RELOCATED.project, writePaths: [RELOCATED.project] });
    // The control: the project itself is the container's to write.
    expect(containerAccess(filesystem, `${RELOCATED.project}\\src\\main.ts`)).toBe("readwrite");
    for (const path of [staging(), stagedFile()]) expect(containerAccess(filesystem, path), path).toBe("denied");
    expectNoGrantInside(filesystem);
    // The Ave home's other write-floor rows are held the same way: no read-only grant re-opens one of them under the home's deny.
    expect(containerAccess(filesystem, `${aveHome()}\\secrets`)).toBe("denied");
    for (const path of filesystem.readonlyPaths) expect(atOrUnder(path, staging()) || atOrUnder(path, `${aveHome()}\\secrets`), path).toBe(false);
  });

  it("stays denied once created when the shell started before the folder existed, under a read grant above a profile-child Ave home", async () => {
    useLayout(PROFILE_CHILD, { staged: false });
    materializeProfileRowParents();
    expect(existsSync(staging())).toBe(false);
    // The shell reads the whole profile; the Ave home is its direct child, which the boundary denies child by child.
    const filesystem = await containerShellRequest({ cwd: PROFILE_CHILD.project, writePaths: [PROFILE_CHILD.project], readPaths: [PROFILE] });
    expect(containerAccess(filesystem, `${PROFILE}\\Documents\\notes.txt`)).toBe("readonly");
    expect(containerAccess(filesystem, `${aveHome()}\\logs`)).toBe("denied");
    // The request was built without the folder; the browser then creates it and stages a download while the command runs.
    stage();
    for (const path of [staging(), stagedFile()]) expect(containerAccess(filesystem, path), path).toBe("denied");
    // A command started after the folder exists is held the same way.
    const later = await containerShellRequest({ cwd: PROFILE_CHILD.project, writePaths: [PROFILE_CHILD.project], readPaths: [PROFILE] });
    for (const path of [staging(), stagedFile()]) expect(containerAccess(later, path), path).toBe("denied");
  });

  it.each([RELOCATED, PROFILE_CHILD])("never grants the folder, a staged file or the Ave home itself under $name", async (layout) => {
    useLayout(layout, { staged: true });
    const filesystem = await containerShellRequest({ cwd: layout.project, writePaths: [layout.project, staging(), aveHome()], readPaths: [stagedFile(), staging(), aveHome()] });
    expect(containerAccess(filesystem, `${layout.project}\\src\\main.ts`)).toBe("readwrite");
    for (const path of [staging(), stagedFile()]) {
      expect(["denied", "unreachable"], path).toContain(containerAccess(filesystem, path));
    }
    expectNoGrantInside(filesystem);
  });
});

// srt-win confines a separate sandbox account: a read deny ACE (inheritable on a directory row) on a path or an ancestor denies reading
// and listing it; otherwise the path's own DACL decides, and the Ave home's is private to its owner (boot verifies it, and the grant
// ceiling below refuses every grant that would add the sandbox account to it).
type DenyList = readonly (string | { path: string })[];
const spelledRows = (rows: DenyList): string[] => rows.map((row) => (typeof row === "string" ? row : row.path));
function deniedBy(rows: DenyList, path: string): string | undefined {
  return spelledRows(rows).find((row) => fold(row) === fold(path) || (/[\\/]$/.test(row) && atOrUnder(path, row)));
}
// A directory row: the deny is inherited by everything created inside it later.
function directoryRow(rows: DenyList, path: string): string | undefined {
  return spelledRows(rows).find((row) => /[\\/]$/.test(row) && fold(row) === fold(path));
}

/** Boot's session initialization on Windows: the shared floor handed to the runtime. */
async function sessionFloor(): Promise<{ denyRead: DenyList; denyWrite: DenyList }> {
  setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: aveHome(), sid: "S-1-5-21-100-200-300-1001" });
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  return (lastCall(runtime.initialize)[0] as { filesystem: { denyRead: DenyList; denyWrite: DenyList } }).filesystem;
}

/** A deny-only worker wrap, as `spawnConfinedChild` composes it for an srt-win MCP server, hook or plugin child: the floor restated under
 * one boundary snapshot, handed to the runtime's wrap. */
async function workerWrap(): Promise<{ denyRead: DenyList; denyWrite: DenyList }> {
  const egress = openEgressInvocation(TEST_WORKER_EGRESS_OWNER);
  try {
    const boundarySnapshot = createAveHomeBoundarySnapshot();
    runtime.wrap.mockResolvedValueOnce({ argv: ["C:\\Program Files\\Ave\\resources\\srt-win\\srt-win.exe", "node", "server.js"], env: {} });
    await wrapWorkerCommand("node server.js", {
      commandId: egress.token, boundarySnapshot,
      filesystem: boundarySnapshot.run(() => ({ denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyPaths() })),
    });
    return (lastCall(runtime.wrap)[2] as { filesystem: { denyRead: DenyList; denyWrite: DenyList } }).filesystem;
  } finally {
    egress.release();
  }
}

describe("the browser download staging folder in the srt-win session floor and worker wraps", () => {
  beforeEach(() => {
    runtime.initialize.mockResolvedValue(undefined);
  });

  it("keeps foreign drive projections outside a checkout's account home while refusing real home targets", async () => {
    const { join } = await vi.importActual<typeof import("node:path")>("node:path");
    const targets = [OUTSIDE_PROFILE.home + "\\secrets\\", PROFILE_CHILD.home + "\\browser-downloads\\"];
    withProvidedContext("realAccountHome", originalCwd, () => {
      expect(() => checkSandboxStampTargets(targets)).not.toThrow();
    });
    expect(() => checkSandboxStampTargets([join(inject("realAccountHome"), "secrets")])).toThrow(/under the real/);
    expect(runtime.stamp).not.toHaveBeenCalled();
  });

  it("denies reading and listing it, with a staged file, before and after it exists, and denies writing it once it does, for an Ave home outside the profile", async () => {
    useLayout(OUTSIDE_PROFILE, { staged: false });
    const session = await sessionFloor();
    const before = await workerWrap();
    // Taken before the folder existed: the home's root deny is inheritable, so the folder the browser creates later is covered.
    stage();
    for (const floor of [session, before]) {
      const root = directoryRow(floor.denyRead, aveHome());
      expect(root).toBeDefined();
      for (const path of [staging(), stagedFile()]) expect(deniedBy(floor.denyRead, path), path).toBe(root);
    }
    // A wrap taken once it exists also stamps the folder on the write floor, which the home root is not part of.
    const after = await workerWrap();
    expect(deniedBy(after.denyRead, stagedFile())).toBeDefined();
    const row = directoryRow(after.denyWrite, staging());
    expect(row).toBeDefined();
    for (const path of [staging(), stagedFile()]) expect(deniedBy(after.denyWrite, path), path).toBe(row);
    expect(deniedBy(after.denyWrite, `${aveHome()}\\logs\\main.log`)).toBeUndefined();
  });

  it("stamps a read deny on the folder under a profile-child Ave home where its DACL would let the sandbox account read it", async () => {
    useLayout(PROFILE_CHILD, { staged: true });
    // A folder whose DACL was widened: its own deny row has to hold it.
    drive.readable.add(staging());
    const session = await sessionFloor();
    const wrap = await workerWrap();
    for (const floor of [session, wrap]) {
      const row = directoryRow(floor.denyRead, staging());
      expect(row).toBeDefined();
      for (const path of [staging(), stagedFile()]) expect(deniedBy(floor.denyRead, path), path).toBe(row);
      // No profile-root or home-root row: a stamp there would walk the whole profile.
      for (const row of spelledRows(floor.denyRead)) expect([fold(PROFILE), fold(aveHome())]).not.toContain(fold(row));
    }
  });
});

describe("the browser download staging folder at the srt-win ACL holder's grant turn", () => {
  beforeEach(() => {
    runtime.initialize.mockResolvedValue(undefined);
    // The holder: a pinned System32 process that only has to stay alive.
    runtime.spawn.mockImplementation(() => Object.assign(new PassThrough(), { pid: 4321, exitCode: null, signalCode: null, stdin: new PassThrough(), kill: () => true }));
    runtime.revoke.mockImplementation(() => runtime.grant.mock.calls.flatMap(([request]) => (request as { read: string[] }).read.map((path) => ({ path, status: "revoked" }))));
  });

  // The grants an MCP server, hook or plugin child asks srt-win for (`spawnWindowsBundledProcess` hands its roots to the holder as is).
  const requests = (): Array<[string, { allowRead: string[]; allowWrite: string[] }, RegExp]> => [
    ["a read of the folder", { allowRead: [staging()], allowWrite: [] }, /protected sensitive target/],
    ["a read of a staged file", { allowRead: [stagedFile()], allowWrite: [] }, /protected sensitive target/],
    ["a write to the folder", { allowRead: [], allowWrite: [staging()] }, /protected sensitive target/],
    ["a read of the Ave home", { allowRead: [aveHome()], allowWrite: [] }, /ancestor of the workspace or Ave home/],
    ["a write to the Ave home's parent", { allowRead: [], allowWrite: [aveHome().replace(/\\[^\\]+$/, "")] }, /ancestor of the workspace or Ave home/],
  ];

  it.each([PROFILE_CHILD, OUTSIDE_PROFILE])("refuses every grant that would open the folder, a staged file, the Ave home or its parent under $name, before any native grant or stamp", async (layout) => {
    useLayout(layout, { staged: true });
    await sessionFloor();
    for (const [label, request, refusal] of requests()) {
      await expect(holdWindowsFilesystemGrant({ label: `mcp:fs:${label}`, ...request }), label).rejects.toThrow(refusal);
    }
    expect(runtime.grant).not.toHaveBeenCalled();
    expect(runtime.stamp).not.toHaveBeenCalled();
    // A refused turn starts no holder.
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("refuses a grant on the folder while it does not exist yet, and leaves it denied in the session floor a re-allowed child's grant updates", async () => {
    useLayout(OUTSIDE_PROFILE, { staged: false });
    await sessionFloor();
    await expect(holdWindowsFilesystemGrant({ label: "mcp:fs:absent", allowRead: [staging()], allowWrite: [] })).rejects.toThrow(/protected sensitive target|identity is unproven/);
    expect(runtime.grant).not.toHaveBeenCalled();
    // The control: a server's own sandbox root, a re-allowed child, is granted.
    const own = `${aveHome()}\\mcp\\fs\\sandbox`;
    mkdirSync(own);
    const held = await holdWindowsFilesystemGrant({ label: "mcp:fs", allowRead: [own], allowWrite: [] });
    try {
      expect(runtime.grant).toHaveBeenCalledTimes(1);
      const granted = lastCall(runtime.grant)[0] as { read: string[]; write: string[] };
      expect(granted.read.map(fold)).toEqual([fold(own)]);
      expect(granted.write).toEqual([]);
      // The session floor the runtime is updated with while the grant is held still denies the folder the browser creates next.
      stage();
      const updated = (lastCall(runtime.update)[0] as { filesystem: { denyRead: DenyList } }).filesystem;
      for (const path of [staging(), stagedFile()]) expect(deniedBy(updated.denyRead, path), path).toBe(directoryRow(updated.denyRead, aveHome()));
    } finally {
      held.release();
    }
    // Once the browser has created it, the same grant is refused as a protected target, not only for having no identity to pin.
    await expect(holdWindowsFilesystemGrant({ label: "mcp:fs:created", allowRead: [staging()], allowWrite: [] })).rejects.toThrow(/protected sensitive target/);
    expect(runtime.grant).toHaveBeenCalledTimes(1);
  });
});

describe("the browser download staging folder in a container holder's native request", () => {
  const NODE = "C:\\Program Files\\nodejs\\node.exe";
  let unregister: (() => void) | undefined;
  beforeEach(async () => {
    runtime.containerBackend = true;
    drive.dirs.add("C:\\Program Files\\nodejs");
    drive.files.add(NODE);
    const { registerMxcHolderReadinessProbe } = await import("../../sandbox/wrap-bundled-command.js");
    unregister = registerMxcHolderReadinessProbe(async () => ({ installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
      uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true, cleanTermination: true, ownProxySucceeded: true,
      otherListenerRefused: true, directEgressRefused: true, forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true }));
    runtime.nativeSpawn.mockImplementation(async (_request: unknown, options: { onOwned: (child: unknown) => void; beforeSpawn: () => void }) => {
      const child = { id: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), completion: new Promise(() => {}),
        dispose: vi.fn(async () => undefined), diagnostics: {} };
      options.onOwned(child);
      options.beforeSpawn();
      return child;
    });
  });
  afterEach(async () => {
    unregister?.();
    runtime.containerBackend = false;
    const { drainMxcHolderLifetimes } = await import("../mxc-holder-lifetime.js");
    await drainMxcHolderLifetimes();
  });

  /** An MCP server's container start as `McpClient.openContained` asks for it, through the real holder adapter and native-entry
   * admission; the request handed to the native process entry is returned. */
  async function containedServer(request: { allowRead?: string[]; allowWrite?: string[]; ownedReadRoots?: string[] } = {}): Promise<ContainerFilesystem> {
    const { spawnMxcBundledHolder } = await import("../../sandbox/wrap-bundled-command.js");
    const sandboxRoot = `${aveHome()}\\mcp\\fs\\sandbox`;
    mkdirSync(sandboxRoot);
    const holder = await spawnMxcBundledHolder({
      label: "mcp:fs", command: NODE, args: ["server.js"], baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: `${PROFILE}\\AppData\\Local` }, holderEnv: {},
      cwd: sandboxRoot, allowRead: request.allowRead ?? [], allowWrite: [sandboxRoot, ...(request.allowWrite ?? [])], ownedReadRoots: request.ownedReadRoots ?? [],
      egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "fs" },
    });
    try {
      const sent = lastCall(runtime.nativeSpawn)[0] as { filesystem: ContainerFilesystem };
      // The control: the server's own sandbox root is the container's to write.
      expect(containerAccess(sent.filesystem, `${sandboxRoot}\\cache.db`)).toBe("readwrite");
      return sent.filesystem;
    } finally {
      await holder.release();
    }
  }

  it.each([PROFILE_CHILD, OUTSIDE_PROFILE])("reaches neither the folder nor a staged file under $name, for a server that asked for the folder before it existed or after", async (layout) => {
    useLayout(layout, { staged: false });
    // A server configured with the folder as one of its roots, started before the browser creates it and again after.
    const asked = () => ({ allowRead: [staging()], ownedReadRoots: [staging()], allowWrite: [staging()] });
    const before = await containedServer(asked());
    stage();
    const after = await containedServer(asked());
    for (const filesystem of [before, after]) {
      for (const path of [staging(), stagedFile()]) expect(["denied", "unreachable"], path).toContain(containerAccess(filesystem, path));
      expectNoGrantInside(filesystem);
    }
  });

  it.each([PROFILE_CHILD, OUTSIDE_PROFILE])("never opens the folder, a staged file, the Ave home or its parent to a server that asks for them under $name", async (layout) => {
    useLayout(layout, { staged: true });
    const asking = (kind: "read" | "write", path: string) => (kind === "read" ? { allowRead: [path], ownedReadRoots: [path] } : { allowWrite: [path] });
    // A grant named inside the folder is withheld, and the server still starts without it.
    for (const [kind, asked] of [["read", staging()], ["read", stagedFile()], ["write", staging()]] as const) {
      const filesystem = await containedServer(asking(kind, asked));
      for (const path of [staging(), stagedFile()]) expect(["denied", "unreachable"], `${kind} ${asked} -> ${path}`).toContain(containerAccess(filesystem, path));
      expectNoGrantInside(filesystem);
    }
    // A grant on the Ave home or a directory holding it reaches other holders' and the host's storage: refused before the native entry.
    const parent = aveHome().replace(/\\[^\\]+$/, "");
    for (const [kind, asked] of [["read", aveHome()], ["read", parent], ["write", aveHome()], ["write", parent]] as const) {
      const starts = runtime.nativeSpawn.mock.calls.length;
      await expect(containedServer(asking(kind, asked)), `${kind} ${asked}`).rejects.toThrow(/ownership reaches another holder or host storage/);
      expect(runtime.nativeSpawn.mock.calls.length).toBe(starts);
    }
  });
});
