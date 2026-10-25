import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
