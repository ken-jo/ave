import { admitLocalRoute, localFs, rethrowLocalityFailure, withLocalityDecision } from "../shared/local-path-io.js";
import { realpathSync } from "node:fs";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";

// Early boot anchors cwd at the managed workspace before IPC registration, independent of the OS launch directory.
export function getDefaultWorkspaceRoot(): string {
  const cwd = process.cwd();
  return process.platform === "win32"
    ? withLocalityDecision(() => localFs.realpathNative(admitLocalRoute(cwd).verdict))
    : realpathSync.native(cwd);
}

export function isDefaultWorkspaceRoot(projectRoot: string, defaultWorkspaceRoot?: string): boolean {
  return withLocalityDecision(() => {
    const root = defaultWorkspaceRoot ?? getDefaultWorkspaceRoot();
    try {
      return caseFoldForMatch(canonicalizePathForMatch(projectRoot)) === caseFoldForMatch(canonicalizePathForMatch(root));
    } catch (error) {
      rethrowLocalityFailure(error);
      return projectRoot.trim() === root.trim();
    }
  });
}
