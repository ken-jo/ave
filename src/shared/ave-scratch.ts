import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aveHome } from "./ave-home.js";

/**
 * The application-owned scratch directory.
 *
 * Why a dedicated directory rather than the whole temp root: an agent needs
 * somewhere to stage intermediate files without asking — holding a scratch
 * write behind an approval only taught models to relocate the same write into
 * the project. But the platform temp root is shared space. On Linux `/tmp` is
 * world-writable, so a directory the app merely *names* there can be created
 * first by another local account, and every file the agent then stages lands
 * in a directory that account controls. The scratch root is therefore a
 * directory the app CREATES with `0o700`, VERIFIES before it is ever offered
 * (a real directory, not a symlink, owned by this account, not group/world
 * accessible) and REFUSES otherwise. The refusal is reported, never silently
 * downgraded to "use the temp root instead".
 *
 * The path is advertised to the model in the environment block of the system
 * prompt and seeded into the Layer 1 default allow-list
 * (`permissions/allowed-directories.ts`), both only while verification holds.
 *
 * The name carries the uid (POSIX) and a digest of the application home, so
 * two accounts sharing `/tmp` do not contend for one name, and an isolated
 * instance booted with its own `AVE_HOME` (the way tests and bench runs are
 * isolated) gets its own scratch directory rather than sharing, advertising
 * and cleaning the one the user's live app is staging work in.
 */
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

/**
 * Inspect the scratch directory without creating it. Every offer of the path —
 * to the model and to the allow-list — goes through this check, so a directory
 * that was fine at boot and was replaced afterwards stops being offered from
 * the next check on. It is a per-call `lstat`, not a guarantee across the gap
 * to the write itself; against another unprivileged account that gap is
 * closed by the sticky bit and `0o700`, and a same-account or root swap is
 * outside what this control claims.
 */
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

/**
 * Create the scratch directory with `0o700` and verify it. `mkdir` with
 * `recursive: true` does not fail on an existing directory, which is exactly
 * why the verification follows rather than trusting the create: a pre-existing
 * directory another account planted is reported here instead of being used.
 * On Windows `mode` is not a permission; the per-user `%LOCALAPPDATA%\Temp`
 * DACL is what protects the directory there, and the ownership check is
 * skipped because `getuid` does not exist.
 */
export function ensureAveScratchDir(path = aveScratchDir()): AveScratchState {
  try {
    mkdirSync(path, { recursive: true, mode: SCRATCH_MODE });
  } catch (err) {
    return reject(path, `could not create: ${(err as Error).message}`);
  }
  return verifyAveScratchDir(path);
}
