import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

/**
 * Single source of truth for expanding a leading `~` in a path argument.
 *
 * WHY THIS IS ONE FUNCTION AND NOT FIVE
 * -------------------------------------
 * This string decides which file the PERMISSION layer judges AND which file
 * the TOOL opens. If the two sides expand differently, the Layer-0 sensitive
 * verdict, the approval dock text, the persisted grant pattern, and the audit
 * row are all computed about a file that is never touched. Agreement between
 * the sides IS the capability — there is no "stricter" variant that is also
 * correct, because a stricter-but-different answer still describes the wrong
 * file.
 *
 * Before consolidation this repo had five copies. Four handled `~` and `~/`
 * only; `resolveToolPathForPermission` (the permission side) additionally
 * handled `~\`. That one-sided branch is the drift: on win32 the tool opened
 * `<cwd>\~\Documents\x` while permission judged `<home>\Documents\x`.
 *
 * WHY `~\` IS PLATFORM-GUARDED
 * ----------------------------
 * Neither of the two prior behaviours was right on both platforms:
 *
 *  - On win32, `\` is a path separator, so `~\Documents\x` is the native form
 *    a Windows user types and MUST expand. Not expanding it (the four
 *    non-permission copies) makes the tool open a junk `<cwd>\~\...` path.
 *  - On POSIX, `\` is an ordinary, legal filename character, so
 *    `~\Documents\x` names ONE file called `~\Documents\x` in the current
 *    directory. Expanding it (the permission copy) makes the permission layer
 *    judge `$HOME/Documents/x` — a file the tool never opens.
 *
 * So the correct merge is neither side verbatim: expand `~\` if and only if
 * the platform treats `\` as a separator. `~` and `~/` expand everywhere —
 * `/` is a separator on win32 too.
 *
 * `~user` style is deliberately unsupported (POSIX-only concept, and the spec
 * scope is "the current user's home only"). It falls through unchanged.
 *
 * The platform is read per call, not captured at module load, so both branches
 * are reachable from tests on a single OS.
 */
export function expandLeadingTilde(path: string): string {
  if (path !== "~" && !path.startsWith("~/") && !(process.platform === "win32" && path.startsWith("~\\"))) return path;
  // An empty home would resolve the rest under cwd; refuse instead.
  const home = homedir();
  if (!home) throw new Error("Cannot resolve home for path policy");
  return path === "~" ? home : pathResolve(home, path.slice(2));
}

/** Shell operands retain both the policy home and the shell's HOME anchor. */
export function expandShellTildePaths(path: string): string[] {
  const policyPath = expandLeadingTilde(path);
  const home = process.env.HOME;
  if (!home) return [policyPath];
  const shellPath = path === "~" ? home
    : path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))
      ? pathResolve(home, path.slice(2)) : path;
  return [...new Set([policyPath, shellPath])];
}
