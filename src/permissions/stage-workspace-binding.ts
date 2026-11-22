import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { inspectPhysicalFilesystemPath } from "../shared/shell-filesystem-path.js";

/** Host-minted, memory only: a session id to the one real stage folder it works in. Never a path-prefix rule. */
const bindings = new Map<string, string>();

const fold = (path: string): string => process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
const segmentsOf = (path: string): string[] => path.split(/[\\/]+/u).filter(Boolean);
/** The segments of `path` below `root` under the platform's case rule; empty for the root itself, null outside it. */
function below(root: string, path: string): string[] | null {
  const rel = relative(fold(root), fold(path));
  return rel.startsWith("..") || isAbsolute(rel) ? null : segmentsOf(rel);
}

/** `worktrees/<project>/<run>/<stage>` as the provider lays it out; a `_` name is never a stage folder. */
function isStageWorkspaceSegments(segments: readonly string[]): boolean {
  const [top, project, run, stage] = segments;
  return top === "worktrees" && /^[a-z0-9][a-z0-9-]*$/u.test(project ?? "") && /^[a-z0-9]{12}$/u.test(run ?? "") && /^[a-z0-9][a-z0-9-]{0,31}$/u.test(stage ?? "");
}

/**
 * Binds a session to its stage workspace. Throws unless the root is exactly `<real home>/worktrees/<project>/<run>/<stage>` and each
 * component, in the spelling given and on disk, is a real directory.
 */
export function bindStageWorkspace(sessionId: string, workspaceRoot: string): void {
  const refused = new Error("not a stage workspace folder");
  if (sessionId === "" || !isAbsolute(workspaceRoot) || segmentsOf(workspaceRoot).includes("..")) throw refused;
  const home = realpathSync.native(aveHome());
  const physical = realpathSync.native(workspaceRoot);
  const segments = below(home, physical);
  if (segments === null || segments.length !== 4 || !isStageWorkspaceSegments(segments)) throw refused;
  // The spelling given must already be the physical one: a link on the way would be followed again at every later use.
  const spelled = below(home, resolve(workspaceRoot)) ?? below(resolve(aveHome()), resolve(workspaceRoot));
  if (spelled === null || spelled.join("/") !== segments.join("/")) throw refused;
  let cursor = home;
  for (const segment of ["", ...segments]) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused;
  }
  bindings.set(sessionId, physical);
}

export function boundStageWorkspace(sessionId: string): string | undefined {
  return bindings.get(sessionId);
}

export function unbindStageWorkspace(sessionId: string): void {
  bindings.delete(sessionId);
}

/**
 * True only when the session has a binding and the target's physical path lies inside it. Links are resolved to where they point, an
 * uncollapsed `..` is refused, and a nested `.ave` stays protected.
 */
export function isOwnStageWorkspacePath(sessionId: string | undefined, path: string): boolean {
  const root = sessionId === undefined ? undefined : bindings.get(sessionId);
  if (root === undefined || !isAbsolute(path) || segmentsOf(path).includes("..")) return false;
  let physical: string;
  try {
    const inspected = inspectPhysicalFilesystemPath(path, root, Number.POSITIVE_INFINITY);
    if (inspected.unresolvedParentTraversal) return false;
    physical = inspected.path;
  } catch {
    return false;
  }
  const inside = below(root, physical);
  return inside !== null && !inside.some(segment => segment.toLowerCase() === ".ave");
}

/** Whether a canonical path lies inside a stage workspace some live session is bound to; the sandbox ceiling opens nothing else beneath `worktrees`. */
export function isBoundStageWorkspacePath(path: string): boolean {
  for (const root of bindings.values()) if (below(root, path) !== null) return true;
  return false;
}
