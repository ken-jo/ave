/** Module factories for tests that simulate win32 on a POSIX host; each returns the real module on Windows. Use from vi.mock factories via a dynamic import. */
import type * as Fs from "node:fs";
import type * as Module from "node:module";
import type * as Path from "node:path";
import type * as StampTargets from "../../permissions/windows-stamp-targets.js";
import type * as ConfigurationHandles from "../../shared/windows-configuration-handles.js";
import type * as PathFacts from "../../shared/windows-path-facts.js";

type Fn = (...args: unknown[]) => unknown;
const DRIVE_PATH = /^[A-Za-z]:[\x5c/]/;
const DRIVE_ROOT = /^[A-Za-z]:[\x5c/]$/;
const host = process.platform;

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

/** ASRT's package, and so its vendored srt-win, resolves on the simulated drive; no real checkout path becomes a stamp target. */
export function simulatedDriveModule(actual: typeof Module) {
  if (host === "win32") return actual;
  const createRequire = (...args: Parameters<typeof actual.createRequire>) => {
    const real = actual.createRequire(...args);
    const resolve = Object.assign((id: string, options?: { paths?: string[] }) => process.platform === "win32" && id === "@anthropic-ai/sandbox-runtime/package.json"
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
