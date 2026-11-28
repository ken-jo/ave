import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { admitLocalRoute, localFs, matcherMemo, withLocalityDecision } from "../shared/local-path-io.js";
import { inspectPhysicalFilesystemPath, relativeNativePath, tryNativeRealpath } from "../shared/shell-filesystem-path.js";

/** Host-minted, memory only: a session id to the one real stage folder it works in. Never a path-prefix rule. */
const bindings = new Map<string, string>();

const segmentsOf = (path: string): string[] => (sep === "\\" ? path.split(/[\\/]+/u) : path.split(sep)).filter(Boolean);
/** The native segments below the root, with its exact spelling. */
function below(root: string, path: string): string[] | null {
  const rel = relativeNativePath(root, path);
  return rel === undefined ? null : segmentsOf(rel);
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
  withLocalityDecision(() => {
    const refused = new Error("not a stage workspace folder");
    if (sessionId === "" || !isAbsolute(workspaceRoot) || segmentsOf(workspaceRoot).includes("..")) throw refused;
    const home = localFs.realpathNative(admitLocalRoute(resolve(aveHome())).verdict);
    const physical = localFs.realpathNative(admitLocalRoute(workspaceRoot).verdict);
    const segments = below(home, physical);
    if (segments === null || segments.length !== 4 || !isStageWorkspaceSegments(segments)) throw refused;
    // The spelling given must already be the physical one: a link on the way would be followed again at every later use.
    const spelled = below(home, resolve(workspaceRoot)) ?? below(resolve(aveHome()), resolve(workspaceRoot));
    if (spelled === null || spelled.join("/") !== segments.join("/")) throw refused;
    let cursor = home;
    for (const segment of ["", ...segments]) {
      cursor = join(cursor, segment);
      const stat = process.platform === "win32" ? localFs.lstat(admitLocalRoute(cursor).verdict) : lstatSync(cursor);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw refused;
    }
    bindings.set(sessionId, physical);
  });
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
  return withLocalityDecision(() => {
    const root = sessionId === undefined ? undefined : bindings.get(sessionId);
    if (root === undefined || !isAbsolute(path) || segmentsOf(path).includes("..")) return false;
    if (process.platform === "win32" && tryNativeRealpath(root) !== root) return false;
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
  });
}

/** Whether a native resolved path lies inside the stage workspace this session is bound to. */
export function isBoundStageWorkspacePath(sessionId: string | undefined, path: string): boolean {
  return withLocalityDecision(() => {
    const root = sessionId === undefined ? undefined : bindings.get(sessionId);
    if (root === undefined || below(root, path) === null) return false;
    if (process.platform !== "win32") return true;
    return tryNativeRealpath(root) === root;
  });
}

/** Whether an absolute path, as spelled, is `<home>/worktrees` or lies beneath it, for the home's given and physical spelling. */
export function createStageWorkspacesMatcher(): (path: string) => boolean {
  const owner = {};
  const match = (path: string) => withLocalityDecision(() => {
    if (!isAbsolute(path)) return false;
    const memo = matcherMemo<string[]>(owner);
    let homes = memo.get("homes");
    if (homes === undefined) {
      const home = resolve(aveHome());
      homes = [home];
      const physical = tryNativeRealpath(home);
      if (physical !== undefined) homes.push(physical);
      memo.set("homes", homes);
    }
    // This matcher applies a protection floor, including to case variants.
    const fold = (value: string): string => process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
    return homes.some(home => below(fold(home), fold(resolve(path)))?.[0] === "worktrees");
  });
  if (process.platform !== "win32") match(resolve(aveHome()));
  return match;
}

export function isStageWorkspacesPath(path: string): boolean {
  return createStageWorkspacesMatcher()(path);
}
