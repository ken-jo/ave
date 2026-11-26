/** Fixtures for tests that simulate win32. Load module factories from vi.mock via a dynamic import. */
import { vi } from "vitest";
import type * as Fs from "node:fs";
import type * as Module from "node:module";
import type * as Os from "node:os";
import type * as Path from "node:path";
import type * as RuntimeRoot from "../../permissions/mxc-runtime-root.js";
import type * as SandboxProcessHome from "../../permissions/sandbox-process-home.js";
import type * as StampTargets from "../../permissions/windows-stamp-targets.js";
import type * as ConfigurationHandles from "../../shared/windows-configuration-handles.js";
import type * as PathFacts from "../../shared/windows-path-facts.js";

type Fn = (...args: unknown[]) => unknown;
const DRIVE_PATH = /^[A-Za-z]:[\x5c/]/;
const DRIVE_ROOT = /^[A-Za-z]:[\x5c/]$/;
const host = process.platform;

export function stubSimulatedWindowsStateEnvironment(): void {
  vi.stubEnv("LOCALAPPDATA", "C:\\example-host\\local");
  vi.stubEnv("ProgramData", "C:\\example-host\\machine");
  if (host !== "win32") {
    vi.stubEnv("HOME", "C:\\Users\\alice");
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", "C:\\example-host\\sandbox");
  }
}

/** The simulated native clock has 100ns precision, including reads of the same host descriptor. */
export function simulatedConfigurationFs(actual: typeof Fs, nativeHost = host): typeof Fs {
  if (nativeHost === "win32") return actual;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    const stat = Reflect.apply(actual.fstatSync, undefined, args);
    return process.platform === "win32" && "ctimeNs" in stat
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ctimeNs: stat.ctimeNs / 100n * 100n }) : stat;
  }) as typeof actual.fstatSync;
  return { ...actual, fstatSync };
}

/** A foreign kernel cannot validate retained Windows handles; stay on the simulated facts path. */
export function simulatedConfigurationHandles(actual: typeof ConfigurationHandles, nativeHost = host): typeof ConfigurationHandles {
  return { ...actual, openWindowsConfigurationHandles: entries => nativeHost === "win32" || process.platform !== "win32"
    ? actual.openWindowsConfigurationHandles(entries) : { handles: undefined, fileOpened: false } };
}

/** Native facts for composition fixtures come from their host files, never from a foreign executable. */
export async function simulatedWindowsPathFacts(actual: typeof PathFacts, nativeHost = host): Promise<typeof PathFacts> {
  if (nativeHost === "win32") return actual;
  const { vi } = await import("vitest");
  const { lstatSync, readFileSync } = await vi.importActual<typeof Fs>("node:fs");
  const sid = "S-1-5-21-100-200-300-1001";
  const hex = (value: bigint, width = 16) => `0x${value.toString(16).padStart(width, "0")}`;
  const facts = (path: string): PathFacts.WindowsPathFacts => {
    try {
      const stat = lstatSync(path, { bigint: true });
      return { exists: true, canonical: path, volumeSerial: hex(stat.dev), fileId: hex(stat.ino, 32),
        volumeSerialNumber: hex(stat.dev), fileIndex: hex(stat.ino), fileSystemName: null,
        changeTime: hex(stat.ctimeNs / 100n + 116444736000000000n),
        attributes: stat.isDirectory() ? 16 : 0, reparseTag: stat.isSymbolicLink() ? 0xa000000c : 0,
        directory: stat.isDirectory(), reparseTarget: null, ancestors: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { exists: false, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null,
        fileIndex: null, fileSystemName: null, changeTime: null, attributes: 0, reparseTag: 0,
        directory: false, reparseTarget: null, ancestors: [] };
    }
  };
  return { ...actual,
    pinWindowsPaths: paths => process.platform !== "win32"
      ? actual.pinWindowsPaths(paths) : paths.map(facts),
    readWindowsDacls: (paths, options) => process.platform !== "win32"
      ? actual.readWindowsDacls(paths, options) : paths.map(path => {
        const row = facts(path);
        return { ...row, currentUserSid: sid, elevated: false, principals: {},
          dacl: row.exists ? { identity: { volumeSerial: row.volumeSerial!, fileId: row.fileId! },
            owner: sid, protected: true, nullDacl: false, aces: [{ type: 0, flags: 0, mask: 0x1f01ff, sid }] } : null,
          ...(options?.content ? { contentHex: row.exists && !row.directory ? readFileSync(path).toString("hex") : null } : {}) };
      }),
  };
}

/** A Windows profile joined onto a POSIX temp root is one relative name to this kernel, which the real HOME would create in the working directory. While win32 is simulated, the HOME is a host temp directory and carries no Windows profile variables. */
export async function simulatedSandboxProcessHome(actual: typeof SandboxProcessHome, nativeHost = host): Promise<typeof SandboxProcessHome> {
  if (nativeHost === "win32") return actual;
  const { vi } = await import("vitest");
  const { mkdtempSync, realpathSync, rmSync } = await vi.importActual<typeof Fs>("node:fs");
  const { tmpdir } = await vi.importActual<typeof Os>("node:os");
  const { join } = await vi.importActual<typeof Path>("node:path");
  const createSandboxProcessHome: typeof actual.createSandboxProcessHome = (...args) => {
    if ((args[0] ?? process.platform) !== "win32") return actual.createSandboxProcessHome(...args);
    const path = realpathSync.native(mkdtempSync(join(tmpdir(), "simulated-sandbox-home-")));
    return Object.freeze({ path, env: Object.freeze({ HOME: path, USERPROFILE: path }),
      cleanup: () => rmSync(path, { recursive: true, force: true }) });
  };
  return { ...actual, createSandboxProcessHome };
}

/** The cache home of the runtime root a simulated win32 process denies: the run directory is spelled by this kernel, and no Windows path names it. */
export const SIMULATED_MXC_CACHE_HOME = "C:\\runtime-cache";

/** While win32 is simulated, the runtime root's floor row is on the simulated drive, and that root is the proved one a
 * container start requires. An explicit cache home is passed through. */
export function simulatedRuntimeRoot(actual: typeof RuntimeRoot, nativeHost = host): typeof RuntimeRoot {
  if (nativeHost === "win32") return actual;
  const mxcRuntimeRootFloorPath: typeof actual.mxcRuntimeRootFloorPath = (cacheHome, platform = process.platform) =>
    actual.mxcRuntimeRootFloorPath(cacheHome ?? (platform === "win32" ? SIMULATED_MXC_CACHE_HOME : undefined), platform);
  return { ...actual, mxcRuntimeRootFloorPath, requireMxcContainerStartRoot: () => mxcRuntimeRootFloorPath(SIMULATED_MXC_CACHE_HOME, "win32") };
}

/** Drive-path arguments use win32 path operations while the simulated platform is win32. */
export function simulatedDrivePath(actual: typeof Path): typeof Path {
  return { ...actual, ...Object.fromEntries(Object.entries(actual.win32)
    .filter(([, value]) => typeof value === "function")
    .map(([key, value]) => [key, (...args: unknown[]) =>
      Reflect.apply(process.platform === "win32" && args.some(arg => typeof arg === "string" && DRIVE_PATH.test(arg))
        ? value as Fn : actual[key as keyof typeof actual] as Fn, undefined, args)])) };
}

/** A simulated drive is empty: only its root resolves, so path resolution still walks up to it. */
export function simulatedDriveFs(actual: typeof Fs) {
  if (host === "win32") return actual;
  const simulated = (real: Fn) => (...args: unknown[]) => {
    const [path] = args;
    if (typeof path !== "string" || !DRIVE_PATH.test(path)) return real(...args);
    if (DRIVE_ROOT.test(path)) return path;
    throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
  };
  const realpathSync = Object.assign(simulated(actual.realpathSync as Fn),
    { native: simulated(actual.realpathSync.native as Fn) }) as typeof actual.realpathSync;
  const configurationFs = simulatedConfigurationFs(actual);
  return { ...configurationFs, default: { ...configurationFs, realpathSync }, realpathSync };
}

/**
 * ASRT's package, and so its vendored srt-win, resolves on the simulated drive; no real checkout path becomes a stamp target.
 * `onDrive` says when the simulated drive spells paths: by default a simulated win32 process, or whenever a fixture switches the path module to win32.
 */
export function simulatedDriveModule(actual: typeof Module, onDrive: () => boolean = () => process.platform === "win32") {
  if (host === "win32") return actual;
  const createRequire = (...args: Parameters<typeof actual.createRequire>) => {
    const real = actual.createRequire(...args);
    const resolve = Object.assign((id: string, options?: { paths?: string[] }) => onDrive() && id === "@anthropic-ai/sandbox-runtime/package.json"
      ? String.raw`C:\ave\node_modules\@anthropic-ai\sandbox-runtime\package.json` : real.resolve(id, options), { paths: real.resolve.paths });
    return Object.assign((id: string) => real(id), real, { resolve });
  };
  return { ...actual, default: { ...actual, createRequire }, createRequire };
}

/** Lifecycle fixtures on another kernel validate spellings but cannot open native handles. */
export function simulatedStampTargets(actual: typeof StampTargets): typeof StampTargets {
  return { ...actual, pinWindowsFilesystemConfig: <T extends Parameters<typeof actual.pinWindowsFilesystemConfig>[0]>(filesystem: T): T => {
    if (host === "win32") return actual.pinWindowsFilesystemConfig(filesystem);
    for (const entries of [filesystem?.allowRead, filesystem?.allowWrite, filesystem?.denyRead, filesystem?.denyWrite]) {
      for (const entry of entries ?? []) {
        const path = typeof entry === "string" ? entry : entry.path;
        if (/[A-Za-z]:/.test(path) && !actual.isPlainWindowsStampPath(path.replace(/\//g, "\x5c"))) throw new Error("Invalid simulated drive path");
      }
    }
    return filesystem;
  } };
}
