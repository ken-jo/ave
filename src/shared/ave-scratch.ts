import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmdirSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aveHome } from "./ave-home.js";

/** Use a verified app-owned private scratch directory, never the shared temp root; include account and app-home identity. */
export type AveScratchState =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string };

const SCRATCH_MODE = 0o700;

export function aveScratchDir(home = aveHome()): string {
  const uid = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  const homeDigest = createHash("sha256").update(home).digest("hex").slice(0, 8);
  return join(tmpdir(), `ave-scratch${uid}-${homeDigest}`);
}

function ownedByThisAccount(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function reject(path: string, reason: string): AveScratchState {
  return { ok: false, path, reason };
}

/** Recheck every offer and refuse replaced links or unsafe ownership; same-account and root races remain outside this control. */
export function verifyAveScratchDir(path = aveScratchDir()): AveScratchState {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    return reject(path, `not present: ${(err as Error).message}`);
  }
  if (stat.isSymbolicLink()) return reject(path, "is a symbolic link");
  if (!stat.isDirectory()) return reject(path, "is not a directory");
  if (!ownedByThisAccount(stat)) return reject(path, `owned by uid ${stat.uid}, not this account`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    return reject(path, `mode ${(stat.mode & 0o777).toString(8)} is readable by other accounts`);
  }
  return { ok: true, path };
}

/** Verify even preexisting directories; on Windows protection comes from the per-user temp DACL, not POSIX mode bits. */
export function ensureAveScratchDir(path = aveScratchDir()): AveScratchState {
  try {
    mkdirSync(path, { recursive: true, mode: SCRATCH_MODE });
  } catch (err) {
    return reject(path, `could not create: ${(err as Error).message}`);
  }
  return verifyAveScratchDir(path);
}

export type AveScratchRemoval =
  | { status: "removed" | "kept" }
  | { status: "failed"; code: string };

/** On exit the scratch directory is removed only while it is still empty; anything the agent, a tool or the user left in it stays. */
export function removeAveScratchDirIfEmpty(path = aveScratchDir()): AveScratchRemoval {
  try {
    // Windows cannot remove a process's current directory; its paths compare without case.
    const fold = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
    if (fold(process.cwd()) === fold(path)) process.chdir(tmpdir());
    rmdirSync(path);
    return { status: "removed" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return { status: "kept" };
    return { status: "failed", code: code ?? "unknown" };
  }
}
