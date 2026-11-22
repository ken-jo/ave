/** The browser's download staging folder through the Windows launch projections of every confined lane: the container shell request
 * handed to its launcher, the srt-win session floor and worker wrap handed to the runtime, the ACL holder's grant turn, and the
 * container holder's request handed to its native entry. A foreign host uses an in-memory drive; win32 uses real scratch directories
 * and native identity pins. Projection composers run against OS stand-ins; the cleanup regression uses a real scratch-file DACL on Windows.
 * Each lane is checked for the folder and a staged file inside it, for read, list and write, against grants that name the folder, a
 * path in it, the Ave home or a parent of it, under a relocated Ave home and the default profile-child one, including a process whose
 * projection was taken before the folder existed. */
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { checkSandboxStampTargets } from "../../__tests__/support/ave-home-isolation-guard.js";
import { withProvidedContext } from "../../__tests__/support/provided-context.js";
import { claimRunDir, STALE_RUN_DIR_AGE_MS, sweepStaleRunDirs } from "../../__tests__/support/test-run-dirs.js";
import { createTmpDirTracker } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources, getHostResources } from "../../main/host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { win32SystemBinary } from "../../shared/windows-system-path.js";

const { hostPlatform } = vi.hoisted(() => ({ hostPlatform: process.platform }));
const resourceLifecycle = vi.hoisted(() => ({ events: [] as ("configured" | "identity")[] }));
const drive = vi.hoisted(() => ({
  dirs: new Set<string>(),
  files: new Set<string>(),
  identities: new Map<string, number>(),
  // Paths whose DACL also grants Users read: their read deny is "readable" evidence and stays a deny row.
  readable: new Set<string>(),
  pins: new Map<string, { stamp: string; facts: import("../../shared/windows-path-facts.js").WindowsPathFacts }>(),
}));
const runtime = vi.hoisted(() => ({
  initialize: vi.fn(), wrap: vi.fn(), update: vi.fn(), grant: vi.fn(), stamp: vi.fn(), revoke: vi.fn(), spawn: vi.fn(), nativeSpawn: vi.fn(),
  identityQuery: vi.fn(), openMxcEgressLease: vi.fn(),
  containerBackend: false,
  policyFrames: [] as Buffer[],
}));

vi.mock("../../main/host-resources.js", async (original) => {
  const actual = await original<typeof import("../../main/host-resources.js")>();
  return { ...actual, configureHostResources: (input: Parameters<typeof actual.configureHostResources>[0]) => {
    actual.configureHostResources(input);
    resourceLifecycle.events.push("configured");
  } };
});

// Model the checkout as the account home without including neighboring scratch roots.
vi.mock("../../shared/ave-home-test-guard.js", async (original) => {
  const actual = await original<typeof import("../../shared/ave-home-test-guard.js")>();
  return { ...actual, checkSandboxStampTargets: (paths: readonly string[]) => {
    actual.checkSandboxStampTargets(paths);
    checkCheckoutStampTargets(paths);
  } };
});

vi.mock("node:path", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
// Keep the production vendor path composition on both hosts. Only the package location is supplied by the fixture.
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  const locator = new URL("../asrt-sandbox.ts", import.meta.url).href;
  const createRequire: typeof actual.createRequire = (filename) => {
    const require = actual.createRequire(filename);
    if (String(filename) !== locator) return require;
    const resolve = Object.assign((id: string, options?: { paths?: string[] }) =>
      id === "@anthropic-ai/sandbox-runtime/package.json" ? fixtureSandboxPackage : require.resolve(id, options),
    { paths: require.resolve.paths });
    return Object.assign((id: string) => require(id), require, { resolve });
  };
  return { ...actual, default: { ...actual, createRequire }, createRequire };
});
vi.mock("../windows-stamp-targets.js", async (original) => {
  const actual = await original<typeof import("../windows-stamp-targets.js")>();
  const simulated = (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedStampTargets(actual);
  return { ...actual, pinWindowsFilesystemConfig: <T extends Parameters<typeof actual.pinWindowsFilesystemConfig>[0]>(filesystem: T): T =>
    runtime.containerBackend ? actual.pinWindowsFilesystemConfig(filesystem) : simulated.pinWindowsFilesystemConfig(filesystem) };
});
// Keep both overrides in one mock. Container fixtures use literal drive paths so real pinning
// reaches the holder's missing-grant decision, and only the worker path uses the async stamp stand-in.
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js", async (original) => {
  const utils = {
    ...await original<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js")>(),
    stampWindowsAclAsync: async (opts: unknown) => runtime.stamp(opts),
  };
  const { win32 } = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...utils, expandWindowsFsPaths: (entries: Parameters<typeof utils.expandWindowsFsPaths>[0], options: Parameters<typeof utils.expandWindowsFsPaths>[1]) => {
    if (process.platform !== "win32" || !runtime.containerBackend) return utils.expandWindowsFsPaths(entries, options);
    if (options?.mode !== "deny") throw new Error("The drive fixture requires literal deny-mode expansion");
    return entries.map((entry) => {
      const path = typeof entry === "string" ? entry : entry.path;
      if (!/^[a-z]:[\\/]/iu.test(path) || /[*?]/u.test(path)) throw new Error("The drive fixture requires an absolute literal path");
      return win32.normalize(path).replace(/^[a-z]:/u, drive => drive.toUpperCase());
    });
  } };
});
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original(), "linux"));
// A foreign host's drive-letter paths exist only once the fixture creates them; win32 uses its real scratch filesystem.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  if (hostPlatform === "win32") return actual;
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
  if (hostPlatform === "win32") return actual;
  const guarded = Object.fromEntries(Object.entries(actual).filter(([, value]) => typeof value === "function").map(([name, value]) => [name, async (...args: unknown[]) => {
    if (typeof args[0] === "string" && /^[a-z]:[\\/]/iu.test(args[0])) throw Object.assign(new Error(`ENOENT: the simulated drive does not model ${name}`), { code: "ENOENT" });
    return Reflect.apply(value as (...values: unknown[]) => unknown, actual, args);
  }]));
  return { ...actual, ...guarded, default: { ...actual, ...guarded } };
});
// Native identity pins on win32, injected facts on a foreign host. Only suite-owned paths and ancestors participate in the
// fixture cache. DACLs stay modeled: `drive.readable` also grants Users read.
vi.mock("../../shared/windows-path-facts.js", async (original) => {
  const actual = await original<typeof import("../../shared/windows-path-facts.js")>();
  const { getHostResources } = await import("../../main/host-resources.js");
  const fs = await import("node:fs");
  const { posix, win32 } = await vi.importActual<typeof import("node:path")>("node:path");
  const pathFor = (path: string) => hostPlatform !== "win32" && posix.isAbsolute(path) ? posix : win32;
  const owner = "S-1-5-21-100-200-300-1001";
  const component = (path: string): Omit<import("../../shared/windows-path-facts.js").WindowsPathFacts, "ancestors"> => {
    const info = fs.lstatSync(path, { throwIfNoEntry: false, bigint: true });
    if (info === undefined) {
      return { exists: false as const, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null, fileIndex: null,
        fileSystemName: null, changeTime: null, attributes: 0, reparseTag: 0, directory: false, reparseTarget: null };
    }
    const paths = pathFor(path);
    const normalized = paths.normalize(path);
    const canonical = normalized === paths.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, "");
    const changeTime = `0x${(info.ctimeNs / 100n + 116444736000000000n).toString(16).padStart(16, "0")}`;
    const link = info.isSymbolicLink();
    return { exists: true as const, canonical, volumeSerial: `0x${info.dev.toString(16)}`,
      fileId: `0x${info.ino.toString(16).padStart(32, "0")}`, volumeSerialNumber: `0x${info.dev.toString(16)}`, fileIndex: `0x${info.ino.toString(16)}`,
      fileSystemName: null, changeTime, attributes: link ? 0x400 : info.isDirectory() ? 16 : 0,
      reparseTag: link ? 0xa000000c : 0, directory: info.isDirectory(), reparseTarget: link ? fs.readlinkSync(path) : null };
  };
  const facts = (path: string): import("../../shared/windows-path-facts.js").WindowsPathFacts => {
    const paths = pathFor(path);
    const normalized = paths.normalize(path);
    const ancestors: ReturnType<typeof component>[] = [];
    for (let parent = paths.dirname(normalized); parent !== normalized;) {
      ancestors.unshift(component(parent));
      const above = paths.dirname(parent);
      if (above === parent) break;
      parent = above;
    }
    return { ...component(path), ancestors };
  };
  const stamp = (path: string): string | undefined => {
    const paths = pathFor(path);
    if (!paths.isAbsolute(path)) return undefined;
    const root = hostPlatform !== "win32" && paths === win32 && /^[a-z]:[\\/]/iu.test(path)
      ? win32.parse(path).root
      : [pinRoot, resourceRoot].find((directory) => {
        const relative = paths.relative(directory, path);
        return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
      });
    if (root === undefined) return undefined;
    const chain: string[] = [];
    for (let entry = path;; entry = paths.dirname(entry)) {
      chain.unshift(entry);
      if (paths.relative(root, entry) === "") break;
    }
    return JSON.stringify(chain.map(entry => {
      const info = fs.lstatSync(entry, { throwIfNoEntry: false, bigint: true });
      return info === undefined ? null : [info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size, info.mode,
        info.isSymbolicLink(), info.isDirectory()].map(String);
    }));
  };
  const pin = (paths: readonly string[]) => {
    expect(getHostResources()).toEqual(fixtureResources);
    if (!resourceLifecycle.events.includes("identity")) resourceLifecycle.events.push("identity");
    const keys = paths.map(path => pathFor(path).normalize(path));
    const stamps = new Map([...new Set(keys)].map(path => [path, stamp(path)]));
    const pending = [...stamps].filter(([path, current]) => current === undefined || drive.pins.get(path)?.stamp !== current);
    const fresh = new Map<string, import("../../shared/windows-path-facts.js").WindowsPathFacts>();
    if (pending.length > 0) {
      const requested = pending.map(([path]) => path);
      runtime.identityQuery(requested);
      const rows = hostPlatform === "win32" ? actual.pinWindowsPaths(requested) : requested.map(facts);
      pending.forEach(([path, current], index) => {
        const row = rows[index];
        if (row === undefined) throw new Error("The drive fixture returned an incomplete pin");
        fresh.set(path, row);
        // A changing tree cannot populate the cache, even if the native request itself succeeded.
        drive.pins.delete(path);
        if (current !== undefined && current === stamp(path)) drive.pins.set(path, { stamp: current, facts: row });
      });
    }
    return keys.map(path => {
      const row = fresh.get(path) ?? drive.pins.get(path)?.facts;
      if (row === undefined) throw new Error("The drive fixture returned an incomplete pin");
      return row;
    });
  };
  const readable = (path: string): boolean => [...drive.readable].some((entry) => actual.windowsPathKey(entry) === actual.windowsPathKey(path));
  const descriptor = (path: string, entry: import("../../shared/windows-path-facts.js").WindowsPathFacts) => {
    const aces = [{ type: 0, flags: 3, mask: 0x1f01ff, sid: owner }, ...(readable(path) ? [{ type: 0, flags: 3, mask: 0x1200a9, sid: "S-1-5-32-545" }] : [])];
    return entry.exists ? { identity: { volumeSerial: entry.volumeSerial, fileId: entry.fileId }, owner, protected: true, nullDacl: false, aces } : null;
  };
  return {
    ...actual,
    pinWindowsPaths: pin,
    readWindowsDacls: (paths: readonly string[], options?: { parent?: boolean }) => {
      const rows = pin(paths);
      const parents = options?.parent ? pin(paths.map(path => win32.dirname(path))) : [];
      return paths.map((path, index) => {
        const row = rows[index];
        const parent = parents[index];
        if (row === undefined || options?.parent && parent === undefined) throw new Error("The drive fixture returned an incomplete pin");
        return { ...row, currentUserSid: owner, elevated: false, principals: {}, dacl: descriptor(path, row),
          ...(parent === undefined ? {} : { parent: descriptor(win32.dirname(path), parent) }) };
      });
    },
  };
});
vi.mock("../../shared/policy-home.js", async (original) => ({
  ...await original<typeof import("../../shared/policy-home.js")>(),
  policyHomeAnchors: () => [profileRoot],
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => (process.platform === "win32" ? profileRoot : actual.homedir()) };
});
// The container shell's OS edge: the host relay its listener forwards to, and the installed launcher.
vi.mock("../egress-host-listener.js", async (original) => ({
  ...await original<typeof import("../egress-host-listener.js")>(),
  openHostEgressListener: async () => ({ port: 9, proxyAuthorization: "Basic eA==", registerPort: () => {}, recordRefusal: () => {}, close: async () => {} }),
  openMxcEgressLease: runtime.openMxcEgressLease.mockImplementation(async () => ({ url: "http://127.0.0.1:43210", port: 43210, close: async () => {} })),
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
  resolveHostWxcExecPath: async () => launcherPath,
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
    resolveSrtWin: () => ({ path: srtPath }),
    getWindowsSandboxUserStatus: () => ({ provisioned: true, credPresent: true, sid: "S-1-5-21-100-200-300-2002" }),
    grantWindowsAcl: runtime.grant,
    revokeWindowsAcl: runtime.revoke,
  };
});
vi.mock("../srt-win-integrity.js", async (original) => ({
  ...await original<typeof import("../srt-win-integrity.js")>(),
  prepareSrtWinExecutable: () => srtPath,
  srtWinPrivateDirectories: () => [fixturePrivateSrtWin],
}));
// The ACL grant holder is a pinned System32 process; a stand-in with a pid.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { createPolicyPipeHelper } = await import("../../__tests__/support/policy-pipe-helper.js");
  return { ...actual, spawn: (...args: unknown[]) => runtime.spawn(...args), default: { ...actual,
    spawn: (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => {
      if (args[0] !== "--mxc-policy") return actual.spawn(command, args, options);
      const helper = createPolicyPipeHelper(new actual.ChildProcess());
      helper.stdin.once("data", (frame: Buffer) => {
        runtime.policyFrames.push(frame);
        queueMicrotask(() => helper.stdout.write("ready\n"));
      });
      return helper.child;
    },
  } };
});
vi.mock("../../main/windows-path-kind-launcher.js", async (original) => {
  const actual = await original<typeof import("../../main/windows-path-kind-launcher.js")>();
  return { ...actual, resolveWindowsPathKindHelper: () => hostPlatform === "win32"
    ? actual.resolveWindowsPathKindHelper() : `${programRoot}\\app\\resources\\windows-path-kind\\ave-path-kind.exe` };
});
vi.mock("../../main/managed-child-processes.js", async (original) => {
  const actual = await original<typeof import("../../main/managed-child-processes.js")>();
  const track: typeof actual.trackManagedChildProcess = () => vi.fn();
  return { ...actual, trackManagedChildProcess: vi.fn(track), assertManagedChildProcessAdmissionOpen: vi.fn() };
});

const hostFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const hostPath = await vi.importActual<typeof import("node:path")>("node:path");
const hostOs = await vi.importActual<typeof import("node:os")>("node:os");
const nativeDirectories = createTmpDirTracker();
afterAll(async () => { await nativeDirectories.cleanup(); });
const runTmp = hostFs.realpathSync.native(hostOs.tmpdir());
function createPinRoot(runRoot: string): string {
  return hostFs.realpathSync.native(nativeDirectories.track(hostFs.mkdtempSync(hostPath.join(runRoot, "browser-download-drive-"))));
}
const pinRoot = createPinRoot(runTmp);
const nativeRoot = hostPlatform === "win32" ? pinRoot : null;
const resourceRoot = hostFs.realpathSync.native(nativeDirectories.track(hostFs.mkdtempSync(hostPath.join(hostOs.tmpdir(), "browser-download-resources-"))));
const fixtureResources = { resourcePath: hostPath.join(resourceRoot, "resources"), isPackaged: false };
const fixtureScripts = hostPath.join(resourceRoot, "dist", "skill-scripts");
const fixtureRuntime = hostPath.join(resourceRoot, "host-runtime.exe");
const fixtureSandboxPackage = hostPath.join(resourceRoot, "sandbox-runtime", "package.json");
const fixtureVendoredSrtWin = hostPath.join(hostPath.dirname(fixtureSandboxPackage), "vendor", "srt-win");
const fixturePrivateSrtWin = hostPath.join(resourceRoot, "srt-win-private", "bin");
const fixtureProgramData = hostPath.join(resourceRoot, "program-data");
const fixtureExternalKey = hostPath.join(resourceRoot, "external-key");
const fixtureGlobalGitConfig = hostPath.join(resourceRoot, "user.gitconfig");
const fixtureSystemGitConfig = hostPath.join(resourceRoot, "system.gitconfig");
const srtPath = hostPath.join(fixturePrivateSrtWin, "srt-win.exe");
const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
if (originalExecPath === undefined) throw new Error("The host runtime path descriptor is missing");
const profileRoot = nativeRoot === null ? "C:\\Users\\alice" : hostPath.join(nativeRoot, "profile");
const programRoot = nativeRoot === null ? "C:\\Program Files" : hostPath.join(nativeRoot, "programs");
const launcherPath = `${programRoot}\\app\\resources\\mxc\\x64\\wxc-exec.exe`;
const nodePath = `${programRoot}\\nodejs\\node.exe`;

function writeDriveFile(path: string): void {
  if (nativeRoot === null) {
    mkdirSync(hostPath.win32.dirname(path), { recursive: true });
    drive.files.add(path);
  }
  else {
    const relative = hostPath.relative(nativeRoot, path);
    if (relative === ".." || relative.startsWith(`..${hostPath.sep}`) || hostPath.isAbsolute(relative)) throw new Error("The drive fixture must stay under its scratch root");
    hostFs.mkdirSync(hostPath.dirname(path), { recursive: true });
    hostFs.writeFileSync(path, "fixture");
  }
}

const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");
const {
  cleanupAsrtSandboxAfterCommand, getBuiltinShellReadPolicy, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, wrapWorkerCommand,
} = await import("../asrt-sandbox.js");
const { holdWindowsFilesystemGrant } = await import("../windows-acl-grant-holder.js");
const { createAveHomeBoundarySnapshot } = await import("../ave-home-boundary-snapshot.js");
const { openEgressInvocation } = await import("../egress-invocations.js");
const { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
const { TEST_WORKER_EGRESS_OWNER } = await import("../../__tests__/support/egress-fixture.js");
const { buildMandatorySandboxWritePolicy } = await import("../sandbox-write-policy.js");
const { pinWindowsPaths, windowsPathKey } = await import("../../shared/windows-path-facts.js");
const { assertWindowsGrantGrammar, pinWindowsGrantTargets } = await import("../windows-grant-targets.js");
const { prepareMxcShellLaunch } = await import("../../tools/mxc-shell-launch.js");
const { existsSync, mkdirSync, mkdtempSync, rmdirSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join: hostJoin } = await vi.importActual<typeof import("node:path")>("node:path");

const originalCwd = process.cwd();

function checkCheckoutStampTargets(paths: readonly string[], checkout = originalCwd): void {
  withProvidedContext("realAccountHome", checkout, () => checkSandboxStampTargets(paths));
}

beforeAll(() => {
  checkSandboxStampTargets([resourceRoot]);
  hostFs.mkdirSync(fixtureResources.resourcePath, { recursive: true });
  hostFs.mkdirSync(fixtureScripts, { recursive: true });
  hostFs.mkdirSync(fixtureVendoredSrtWin, { recursive: true });
  hostFs.mkdirSync(fixturePrivateSrtWin, { recursive: true });
  hostFs.mkdirSync(fixtureProgramData, { recursive: true });
  hostFs.writeFileSync(fixtureSandboxPackage, "{}");
  hostFs.writeFileSync(fixtureRuntime, "runtime image fixture");
  hostFs.writeFileSync(fixtureExternalKey, "key path fixture");
  hostFs.writeFileSync(fixtureGlobalGitConfig, "");
  hostFs.writeFileSync(fixtureSystemGitConfig, "");
  if (hostPlatform === "win32") {
    const relative = hostPath.join("windows-path-kind", process.arch, "ave-path-kind.exe");
    const target = hostPath.join(fixtureResources.resourcePath, relative);
    hostFs.mkdirSync(hostPath.dirname(target), { recursive: true });
    hostFs.copyFileSync(hostPath.join(originalCwd, "resources", relative), target);
  }
  configureHostResources(fixtureResources);
});
const STAGED = "0123456789abcdef0123456789abcdef";
const RELOCATED = { name: "a relocated Ave home inside the project", project: `${profileRoot}\\work`, home: `${profileRoot}\\work\\ave` } as const;
const PROFILE_CHILD = { name: "the default profile-child Ave home", project: `${profileRoot}\\work`, home: `${profileRoot}\\.ave` } as const;
const OUTSIDE_PROFILE = { name: "a relocated Ave home outside the profile",
  project: nativeRoot === null ? "D:\\work" : hostPath.join(nativeRoot, "work"),
  home: nativeRoot === null ? "D:\\Data\\Ave\\home" : hostPath.join(nativeRoot, "relocated", "home") } as const;
type Layout = typeof RELOCATED | typeof PROFILE_CHILD | typeof OUTSIDE_PROFILE;

const staging = (): string => `${aveHome()}\\browser-downloads`;
const stagedFile = (): string => `${staging()}\\${STAGED}`;

function useLayout(layout: Layout, options: { staged: boolean }): void {
  vi.stubEnv("AVE_HOME", layout.home);
  for (const path of [`${layout.project}\\src`, `${layout.home}\\sessions`, `${layout.home}\\logs`, `${layout.home}\\secrets`, `${layout.home}\\workspace`,
    hostPath.win32.dirname(launcherPath)]) mkdirSync(path, { recursive: true });
  writeDriveFile(`${layout.project}\\src\\main.ts`);
  writeDriveFile(launcherPath);
  if (options.staged) stage();
}

// A container cannot hold a read-only grant over a deny whose parent is missing too (the deny would be raised onto a directory it can
// read), so a grant of the whole profile is launched only where every row's parent exists, as on an installed profile. Create them;
// the staging row's parent is the Ave home itself, so the folder stays absent.
function materializeProfileRowParents(): void {
  for (const row of getBuiltinShellReadPolicy([profileRoot], profileRoot).denyRead) {
    if (!/^[A-Z]:\\/i.test(row) || /[*?]/.test(row) || !atOrUnder(row, profileRoot)) continue;
    mkdirSync(row.replace(/[\\/]+$/, "").replace(/\\[^\\]+$/, ""), { recursive: true });
  }
}

// What the browser's staging does at start and on a download: create the folder, then stage a file in it.
function stage(): void {
  mkdirSync(staging(), { recursive: true });
  writeDriveFile(stagedFile());
}

beforeEach(() => {
  if (nativeRoot !== null) {
    hostFs.rmSync(nativeRoot, { recursive: true, force: true });
    hostFs.mkdirSync(nativeRoot, { recursive: true });
  }
  // A foreign drive spelling is relative to the real host; keep that projection inside the validated test scratch.
  if (hostPlatform !== "win32") process.chdir(nativeDirectories.track(mkdtempSync(hostJoin(tmpdir(), "browser-download-drive-"))));
  setProcessPlatform("win32");
  Object.defineProperty(process, "execPath", { ...originalExecPath, value: fixtureRuntime });
  vi.stubEnv("USERPROFILE", profileRoot);
  vi.stubEnv("HOME", profileRoot);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("ProgramData", fixtureProgramData);
  vi.stubEnv("AVE_SECRET_KEY_FILE", fixtureExternalKey);
  vi.stubEnv("GIT_CONFIG_GLOBAL", fixtureGlobalGitConfig);
  vi.stubEnv("GIT_CONFIG_SYSTEM", fixtureSystemGitConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", undefined);
  mkdirSync(profileRoot, { recursive: true });
});

afterEach(async () => {
  try {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
  } finally {
    _resetAveHomePrivacyForTest();
    process.chdir(originalCwd);
    setProcessPlatform(hostPlatform);
    Object.defineProperty(process, "execPath", originalExecPath);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    drive.dirs.clear();
    drive.files.clear();
    drive.identities.clear();
    drive.readable.clear();
    drive.pins.clear();
    runtime.policyFrames.length = 0;
  }
});

// The arguments of a stand-in's latest call; a stand-in the lane never reached fails the test here.
function lastCall(stub: { mock: { calls: unknown[][] } }): unknown[] {
  const call = stub.mock.calls.at(-1);
  if (call === undefined) throw new Error("the stand-in was never called");
  return call;
}
const fold = windowsPathKey;
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
async function containerShellRequest(input: { cwd: string; writePaths: readonly string[]; readPaths?: readonly string[]; policyPadding?: number }): Promise<ContainerFilesystem> {
  const sandboxHome = `${aveHome()}\\sandbox\\homes\\h1`;
  mkdirSync(sandboxHome, { recursive: true });
  const sandboxWritePaths = [...input.writePaths, sandboxHome];
  const { allowRead, denyRead, floorPierces } = getBuiltinShellReadPolicy([input.cwd, ...sandboxWritePaths, ...(input.readPaths ?? [])], profileRoot, sandboxHome);
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
    env: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: `${profileRoot}\\AppData\\Local`, PAD: "x".repeat(input.policyPadding ?? 0) },
    timeoutMs: 5_000,
    exists: existsSync,
  });
  try {
    expect(launch.argv).toHaveLength(3);
    let bytes: Buffer;
    if (launch.argv[1] === "--config") {
      expect(launch.argv[2]).toMatch(/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/u);
      expect(runtime.policyFrames).toHaveLength(1);
      const frame = runtime.policyFrames.pop();
      if (!frame) throw new Error("The policy helper received no frame");
      expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
      bytes = frame.subarray(4);
    } else {
      expect(launch.argv[1]).toBe("--config-base64");
      expect(runtime.policyFrames).toHaveLength(0);
      bytes = Buffer.from(launch.argv[2] ?? "", "base64");
    }
    if (input.policyPadding) expect(launch.argv[1]).toBe("--config");
    return (JSON.parse(bytes.toString("utf8")) as { filesystem: ContainerFilesystem }).filesystem;
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

it("reclaims a pin fixture when its run owner is dead and suite teardown never ran", async () => {
  const scratch = nativeDirectories.track(hostFs.mkdtempSync(hostPath.join(runTmp, "abandoned-pin-run-")));
  const run = hostFs.mkdtempSync(hostPath.join(scratch, "t-"));
  const deadOwner = { exists: () => false, startedAt: () => "ps:1", host: () => "fixture-host" };
  claimRunDir(run, deadOwner);
  const abandoned = createPinRoot(run);
  hostFs.writeFileSync(hostPath.join(abandoned, "held-fixture"), "fixture");
  const swept = await sweepStaleRunDirs(scratch, async path => {
    hostFs.rmSync(path, { recursive: true });
  }, { probe: deadOwner, now: Date.now() + 2 * STALE_RUN_DIR_AGE_MS });
  expect(swept).toEqual({ removed: [run], stranded: [], leftAside: [] });
  expect(hostFs.existsSync(abandoned)).toBe(false);
});

it("composes host resources before the first native identity request", () => {
  const [profile] = pinWindowsPaths([profileRoot]);
  expect(profile).toMatchObject({ exists: true, directory: true });
  expect(getHostResources()).toEqual(fixtureResources);
  const configuredAt = resourceLifecycle.events.indexOf("configured");
  expect(configuredAt).toBeGreaterThanOrEqual(0);
  expect(resourceLifecycle.events.indexOf("identity")).toBeGreaterThan(configuredAt);
});

function changeSharedPinAncestors(): void {
  nativeDirectories.track(hostFs.mkdtempSync(hostPath.join(runTmp, "pin-cache-neighbor-")));
  // Model churn from another run without leaving an unowned entry in the shared scratch base.
  const scratchBase = hostPath.dirname(runTmp);
  const { atime, mtimeMs } = hostFs.statSync(scratchBase);
  hostFs.utimesSync(scratchBase, atime, new Date(mtimeMs - 1_000));
}

it("pins unchanged fixture paths once instead of starting a helper for each grant read", () => {
  const path = hostPath.join(pinRoot, "present");
  hostFs.mkdirSync(path);
  const first = pinWindowsPaths([path]);
  expect(first[0]).toMatchObject({ exists: true, directory: true });
  const queries = runtime.identityQuery.mock.calls.length;
  changeSharedPinAncestors();
  expect(pinWindowsPaths([path])).toEqual(first);
  expect(runtime.identityQuery).toHaveBeenCalledTimes(queries);
});

it("refreshes fixture pins when a missing target is created or an existing target is removed", () => {
  const path = hostPath.join(pinRoot, "changing");
  expect(pinWindowsPaths([path])[0]).toMatchObject({ exists: false });
  const queries = runtime.identityQuery.mock.calls.length;
  changeSharedPinAncestors();
  expect(pinWindowsPaths([path])[0]).toMatchObject({ exists: false });
  expect(runtime.identityQuery).toHaveBeenCalledTimes(queries);
  mkdirSync(path);
  expect(pinWindowsPaths([path])[0]).toMatchObject({ exists: true, directory: true });
  expect(runtime.identityQuery).toHaveBeenCalledTimes(queries + 1);
  rmdirSync(path);
  expect(pinWindowsPaths([path])[0]).toMatchObject({ exists: false });
  expect(runtime.identityQuery).toHaveBeenCalledTimes(queries + 2);
});

it("refreshes an owned path on identity replacement and on substitution with a link", () => {
  const path = hostPath.join(pinRoot, "replaceable");
  const original = hostPath.join(pinRoot, "original");
  hostFs.mkdirSync(path);
  const [first] = pinWindowsPaths([path]);
  expect(first).toMatchObject({ exists: true, directory: true, reparseTag: 0 });
  const queries = runtime.identityQuery.mock.calls.length;
  hostFs.renameSync(path, original);
  hostFs.mkdirSync(path);
  const [replacement] = pinWindowsPaths([path]);
  expect(replacement).toMatchObject({ exists: true, directory: true, reparseTag: 0 });
  expect(replacement?.fileId).not.toBe(first?.fileId);
  expect(runtime.identityQuery).toHaveBeenCalledTimes(queries + 1);
  hostFs.renameSync(path, hostPath.join(pinRoot, "replacement"));
  hostFs.symlinkSync(original, path, hostPlatform === "win32" ? "junction" : "dir");
  expect(pinWindowsPaths([path])[0]?.reparseTag).toBeGreaterThan(0);
  expect(runtime.identityQuery).toHaveBeenCalledTimes(queries + 2);
});

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

  it.each([0, 25_000])("stays denied once created when the shell started before the folder existed, under a read grant above a profile-child Ave home (policy padding %i)", async (policyPadding) => {
    useLayout(PROFILE_CHILD, { staged: false });
    materializeProfileRowParents();
    expect(existsSync(staging())).toBe(false);
    // The shell reads the whole profile; the Ave home is its direct child, which the boundary denies child by child.
    const filesystem = await containerShellRequest({ cwd: PROFILE_CHILD.project, writePaths: [PROFILE_CHILD.project], readPaths: [profileRoot], policyPadding });
    expect(containerAccess(filesystem, `${profileRoot}\\Documents\\notes.txt`)).toBe("readonly");
    expect(containerAccess(filesystem, `${aveHome()}\\logs`)).toBe("denied");
    // The request was built without the folder; the browser then creates it and stages a download while the command runs.
    stage();
    for (const path of [staging(), stagedFile()]) expect(containerAccess(filesystem, path), path).toBe("denied");
    // A command started after the folder exists is held the same way.
    const later = await containerShellRequest({ cwd: PROFILE_CHILD.project, writePaths: [PROFILE_CHILD.project], readPaths: [profileRoot], policyPadding });
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
    runtime.wrap.mockResolvedValueOnce({ argv: [srtPath, "node", "server.js"], env: {} });
    await wrapWorkerCommand("node server.js", {
      commandId: egress.token, boundarySnapshot,
      filesystem: boundarySnapshot.run(() => ({ denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyPaths() })),
    });
    return (lastCall(runtime.wrap)[2] as { filesystem: { denyRead: DenyList; denyWrite: DenyList } }).filesystem;
  } finally {
    try {
      await cleanupAsrtSandboxAfterCommand();
    } finally {
      egress.release();
    }
  }
}

describe("the browser download staging folder in the srt-win session floor and worker wraps", () => {
  beforeEach(() => {
    runtime.initialize.mockResolvedValue(undefined);
  });

  it.each([
    { checkout: "/private/tmp/ave", scratch: "/private/tmp/ave-test-1000/t-run/resource" },
    { checkout: "C:\\ave", scratch: "C:\\Users\\alice\\.ave-test-tmp\\t-run\\resource" },
  ])("accepts default scratch beside $checkout and refuses its scripts", ({ checkout, scratch }) => {
    // Preserve each layout's ancestry inside the run's scratch on either host.
    const project = (path: string) => hostPath.join(
      resourceRoot, ...path.slice(hostPath.win32.parse(path).root.length).split(/[\\/]/u),
    );
    const checkoutPath = project(checkout);
    const scratchPath = project(scratch);
    const checkoutScripts = hostPath.join(checkoutPath, "dist", "skill-scripts");
    // The modeled layouts use default scratch, with no explicit root allowance.
    withProvidedContext("explicitTestTmpRoot", null, () => {
      expect(() => checkCheckoutStampTargets([scratchPath], checkoutPath)).not.toThrow();
      expect(() => checkCheckoutStampTargets([checkoutScripts], checkoutPath)).toThrow(/under the real/);
    });
  });

  it("keeps application write-deny targets isolated when the checkout lies under the account home", async () => {
    const checkoutScripts = hostPath.join(originalCwd, "dist", "skill-scripts");
    expect(() => checkCheckoutStampTargets([checkoutScripts])).toThrow(/under the real/);
    useLayout(PROFILE_CHILD, { staged: false });
    const filesystem = await sessionFloor();
    const writeDenies = spelledRows(filesystem.denyWrite).map(fold);
    for (const target of [
      fixtureScripts, fixtureRuntime, fixtureVendoredSrtWin, fixturePrivateSrtWin, fixtureExternalKey,
      fixtureGlobalGitConfig, fixtureSystemGitConfig,
    ]) {
      expect(writeDenies).toContain(fold(target));
    }
  });

  it("proves missing grant targets through the drive's existing ancestor identities", () => {
    useLayout(PROFILE_CHILD, { staged: false });
    const missing = `${PROFILE_CHILD.home}\\plugins\\cache`;
    const [row] = pinWindowsPaths([missing]);
    expect(row?.exists).toBe(false);
    const { root } = hostPath.win32.parse(PROFILE_CHILD.home);
    const parts = PROFILE_CHILD.home.slice(root.length).split("\\");
    const chain = [root, ...parts.map((_part, index) => hostPath.win32.join(root, ...parts.slice(0, index + 1)))];
    expect(row?.ancestors.map((ancestor) => ancestor.canonical === null ? null : windowsPathKey(ancestor.canonical)))
      .toEqual([...chain.map(windowsPathKey), null]);
    const parent = row?.ancestors.at(-2);
    const [home] = pinWindowsPaths([PROFILE_CHILD.home]);
    expect(parent).toMatchObject({ exists: true, directory: true, volumeSerial: home?.volumeSerial, fileId: home?.fileId });
    expect(windowsPathKey(parent?.canonical ?? "")).toBe(windowsPathKey(PROFILE_CHILD.home));
    expect(parent?.volumeSerial).toMatch(/^0x[0-9a-f]+$/u);
    expect(parent?.fileId).toMatch(/^0x[0-9a-f]+$/u);
    const granted = pinWindowsGrantTargets([missing], { allowMissing: true, validatePath: assertWindowsGrantGrammar })[0]?.canonical;
    expect(windowsPathKey(granted ?? "")).toBe(windowsPathKey(missing));
  });

  it("keeps foreign drive projections outside a checkout's account home while refusing real home targets", async () => {
    const { join } = await vi.importActual<typeof import("node:path")>("node:path");
    const targets = [`${OUTSIDE_PROFILE.home}\\secrets\\`, `${PROFILE_CHILD.home}\\browser-downloads\\`];
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
      for (const row of spelledRows(floor.denyRead)) expect([fold(profileRoot), fold(aveHome())]).not.toContain(fold(row));
    }
  });
});

describe("the browser download staging folder at the srt-win ACL holder's grant turn", () => {
  beforeEach(() => {
    runtime.initialize.mockResolvedValue(undefined);
    // The holder: a pinned System32 process that only has to stay alive.
    runtime.spawn.mockImplementation(() => {
      const child = Object.assign(new PassThrough(), { pid: 4321, exitCode: null, signalCode: null as NodeJS.Signals | null, stdin: new PassThrough() });
      return Object.assign(child, { kill: (signal: NodeJS.Signals) => {
        queueMicrotask(() => {
          child.signalCode = signal;
          child.stdin.destroy();
          child.destroy();
          child.emit("exit", null, signal);
        });
        return true;
      } });
    });
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

  async function expectGrantRefused(request: Parameters<typeof holdWindowsFilesystemGrant>[0], reason: RegExp, label?: string): Promise<void> {
    let held: Awaited<ReturnType<typeof holdWindowsFilesystemGrant>> | undefined;
    try {
      await expect(async () => { held = await holdWindowsFilesystemGrant(request); }, label).rejects.toThrow(reason);
    } finally {
      held?.release();
    }
  }

  it("revokes and closes a grant when an assertion fails after acquisition", async () => {
    useLayout(OUTSIDE_PROFILE, { staged: false });
    await sessionFloor();
    const own = `${aveHome()}\\mcp\\fs\\sandbox`;
    mkdirSync(own, { recursive: true });
    const directory = nativeDirectories.track(hostFs.mkdtempSync(hostPath.join(runTmp, "grant-cleanup-")));
    const marker = hostPath.join(directory, "held");
    const sid = "S-1-5-21-100-200-300-2002";
    const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { readWindowsDacls } = await vi.importActual<typeof import("../../shared/windows-path-facts.js")>("../../shared/windows-path-facts.js");
    let modeledDeny = false;
    let denyPending = false;
    let descriptor: number | undefined;
    let opened: number | undefined;
    const hasDeny = (): boolean => {
      if (hostPlatform !== "win32") return modeledDeny;
      const dacl = readWindowsDacls([marker])[0]?.dacl;
      if (!dacl) throw new Error("The fixture's DACL could not be read");
      return dacl.aces.some(ace => ace.type === 1 && ace.sid === sid);
    };
    const setDeny = (present: boolean): void => {
      if (hostPlatform === "win32") {
        const method = present ? "AddAccessRule" : "RemoveAccessRuleSpecific";
        const command = `$ErrorActionPreference='Stop'; $path='${marker.replace(/'/g, "''")}';
          $sid=[Security.Principal.SecurityIdentifier]::new('${sid}');
          $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Delete, 'Deny');
          $acl=Get-Acl -LiteralPath $path; $acl.${method}($rule); Set-Acl -LiteralPath $path -AclObject $acl;`;
        execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command", command],
          { env: windowsPowerShellEnv(), windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs });
      } else {
        modeledDeny = present;
      }
    };
    const restore = (): void => {
      try {
        if (denyPending) {
          setDeny(false);
          denyPending = false;
        }
      } finally {
        if (descriptor !== undefined) {
          hostFs.closeSync(descriptor);
          descriptor = undefined;
        }
      }
    };
    try {
      checkSandboxStampTargets([marker]);
      hostFs.writeFileSync(marker, "fixture");
      expect(hasDeny()).toBe(false);
      runtime.grant.mockImplementationOnce(() => {
        opened = descriptor = hostFs.openSync(marker, "r");
        denyPending = true;
        setDeny(true);
        expect(hasDeny()).toBe(true);
        expect(hostFs.fstatSync(descriptor).isFile()).toBe(true);
      });
      runtime.revoke.mockImplementationOnce(() => {
        restore();
        return [{ path: own, status: "revoked" }];
      });
      // The allowed grant makes the inner refusal assertion fail after acquisition.
      await expect(expectGrantRefused({ label: "mcp:fs", allowRead: [own], allowWrite: [] }, /protected sensitive target/))
        .rejects.toThrow(/resolved.*instead of rejecting/s);
      const closed = opened;
      if (closed === undefined) throw new Error("The fixture did not open a descriptor");
      expect(hasDeny()).toBe(false);
      expect(() => hostFs.fstatSync(closed)).toThrow(expect.objectContaining({ code: "EBADF" }));
      const child = runtime.spawn.mock.results[0]?.value;
      expect(child?.signalCode).toBe("SIGTERM");
      expect(child?.stdin.destroyed).toBe(true);
      hostFs.rmSync(directory, { recursive: true });
      expect(hostFs.existsSync(directory)).toBe(false);
    } finally {
      try {
        restore();
      } finally {
        runtime.grant.mockReset();
        runtime.revoke.mockReset();
      }
    }
  });

  it.each([PROFILE_CHILD, OUTSIDE_PROFILE])("refuses every grant that would open the folder, a staged file, the Ave home or its parent under $name, before any native grant or stamp", async (layout) => {
    useLayout(layout, { staged: true });
    await sessionFloor();
    for (const [label, request, refusal] of requests()) {
      await expectGrantRefused({ label: `mcp:fs:${label}`, ...request }, refusal, label);
    }
    expect(runtime.grant).not.toHaveBeenCalled();
    expect(runtime.stamp).not.toHaveBeenCalled();
    // A refused turn starts no holder.
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("refuses a grant on the folder while it does not exist yet, and leaves it denied in the session floor a re-allowed child's grant updates", async () => {
    useLayout(OUTSIDE_PROFILE, { staged: false });
    await sessionFloor();
    await expectGrantRefused({ label: "mcp:fs:absent", allowRead: [staging()], allowWrite: [] }, /protected sensitive target|identity is unproven/);
    expect(runtime.grant).not.toHaveBeenCalled();
    // The control: a server's own sandbox root, a re-allowed child, is granted.
    const own = `${aveHome()}\\mcp\\fs\\sandbox`;
    mkdirSync(own, { recursive: true });
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
    await expectGrantRefused({ label: "mcp:fs:created", allowRead: [staging()], allowWrite: [] }, /protected sensitive target/);
    expect(runtime.grant).toHaveBeenCalledTimes(1);
  });
});

describe("the browser download staging folder in a container holder's native request", () => {
  let unregister: (() => void) | undefined;
  beforeEach(async () => {
    runtime.containerBackend = true;
    writeDriveFile(nodePath);
    const { registerMxcHolderReadinessProbe } = await import("../../sandbox/wrap-bundled-command.js");
    unregister = registerMxcHolderReadinessProbe(async () => ({ installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
      uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true, cleanTermination: true, ownProxySucceeded: true,
      otherListenerRefused: true, directEgressRefused: true, forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true }));
    runtime.nativeSpawn.mockImplementation(async (request: { filesystem: ContainerFilesystem }, options: { onOwned: (child: unknown) => void; beforeSpawn: () => void }) => {
      for (const row of pinWindowsPaths([...request.filesystem.readonlyPaths, ...request.filesystem.readwritePaths])) {
        expect(row).toMatchObject({ exists: true, directory: true });
        expect(row.canonical).not.toBeNull();
        expect(row.volumeSerial).not.toBeNull();
        expect(row.fileId).not.toBeNull();
      }
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
    mkdirSync(sandboxRoot, { recursive: true });
    const holder = await spawnMxcBundledHolder({
      label: "mcp:fs", command: nodePath, args: ["server.js"], baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: `${profileRoot}\\AppData\\Local` }, holderEnv: {},
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

  async function expectHolderRefusal(request: Parameters<typeof containedServer>[0], message: string | RegExp, label?: string): Promise<void> {
    const starts = runtime.nativeSpawn.mock.calls.length;
    const leases = runtime.openMxcEgressLease.mock.calls.length;
    await expect(containedServer(request), label).rejects.toThrow(message);
    expect(runtime.nativeSpawn).toHaveBeenCalledTimes(starts);
    expect(runtime.openMxcEgressLease).toHaveBeenCalledTimes(leases);
    expect(runtime.stamp).not.toHaveBeenCalled();
    expect(runtime.grant).not.toHaveBeenCalled();
    expect(runtime.revoke).not.toHaveBeenCalled();
  }

  it.each(["read", "write"])("refuses a missing %s holder grant before the native entry", async (kind) => {
    useLayout(PROFILE_CHILD, { staged: false });
    const missing = `${aveHome()}\\mcp\\fs\\sandbox\\missing`;
    expect(existsSync(missing)).toBe(false);
    const request = kind === "read" ? { allowRead: [missing], ownedReadRoots: [missing] } : { allowWrite: [missing] };
    await expectHolderRefusal(request, "Container filesystem grant target is missing");
  });

  it.each([PROFILE_CHILD, OUTSIDE_PROFILE])("reaches neither the folder nor a staged file under $name, before and after a file is staged", async (layout) => {
    useLayout(layout, { staged: false });
    const asked = () => ({ allowRead: [staging()], ownedReadRoots: [staging()], allowWrite: [staging()] });
    expect(existsSync(staging())).toBe(false);
    await expectHolderRefusal(asked(), "Container filesystem grant target is missing");
    // A container grant must name an existing directory, even when the protected floor withholds it at handoff.
    mkdirSync(staging(), { recursive: true });
    expect(pinWindowsPaths([staging()])[0]).toMatchObject({ exists: true, directory: true });
    expect(existsSync(stagedFile())).toBe(false);
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
      await expectHolderRefusal(asking(kind, asked), /ownership reaches another holder or host storage/, `${kind} ${asked}`);
    }
  });
});
