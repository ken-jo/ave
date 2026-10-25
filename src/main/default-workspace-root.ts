import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";

// Early boot anchors cwd at the managed workspace before IPC registration, independent of the OS launch directory.
export function getDefaultWorkspaceRoot(): string {
  return process.cwd();
}

export function isDefaultWorkspaceRoot(projectRoot: string, defaultWorkspaceRoot = getDefaultWorkspaceRoot()): boolean {
  try {
    return caseFoldForMatch(canonicalizePathForMatch(projectRoot)) ===
      caseFoldForMatch(canonicalizePathForMatch(defaultWorkspaceRoot));
  } catch {
    return projectRoot.trim() === defaultWorkspaceRoot.trim();
  }
}
