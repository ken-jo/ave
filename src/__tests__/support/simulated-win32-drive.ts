/** Module factories for tests that simulate win32 on a POSIX host; each returns the real module on Windows. Use from vi.mock factories via a dynamic import. */
import type * as Fs from "node:fs";
import type * as Module from "node:module";
import type * as Path from "node:path";
import type * as StampTargets from "../../permissions/windows-stamp-targets.js";

type Fn = (...args: unknown[]) => unknown;
const DRIVE_PATH = /^[A-Za-z]:[\x5c/]/;
const DRIVE_ROOT = /^[A-Za-z]:[\x5c/]$/;
const host = process.platform;

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
  return { ...actual, default: { ...actual, realpathSync }, realpathSync };
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
