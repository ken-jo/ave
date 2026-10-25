import { isAbsolute, relative, sep } from "node:path";
import { inspectPhysicalFilesystemPath } from "./shell-filesystem-path.js";

/** Configuration every host-owned Git process carries before its subcommand. */
const HOST_GIT_CONFIG = ["safe.bareRepository=explicit", "core.fsmonitor=false"] as const;
const MAX_WORKSPACE_PATH_COMPONENTS = 64;
const sandboxGitWrites = new Map<symbol, readonly string[]>();

function canonicalWorkspacePath(root: string): string {
  const resolution = inspectPhysicalFilesystemPath(root, process.cwd(), MAX_WORKSPACE_PATH_COMPONENTS);
  if (resolution.unresolvedParentTraversal) throw new Error("Git workspace path has unresolved parent traversal");
  return process.platform === "win32" ? resolution.path.toLowerCase() : resolution.path;
}

function containsWorkspace(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Defer host workspace Git reads until the sandbox's post-command cleanup succeeds. The owner retains the hold
 * after failed cleanup; release is idempotent and affects only this invocation, including overlapping holds. */
export function holdSandboxGitWrites(writeRoots: readonly string[]): () => void {
  const roots = [...new Set(writeRoots.map(canonicalWorkspacePath))];
  if (roots.length === 0) return () => {};
  const token = Symbol();
  sandboxGitWrites.set(token, roots);
  return () => { sandboxGitWrites.delete(token); };
}

/** In-process ordering only; independent sibling workspaces remain available. */
export function isHostGitWorkspaceAvailable(root: string): boolean {
  if (sandboxGitWrites.size === 0) return true;
  let workspace: string;
  try {
    workspace = canonicalWorkspacePath(root);
  } catch {
    return false;
  }
  for (const roots of sandboxGitWrites.values()) {
    if (roots.some((held) => containsWorkspace(held, workspace) || containsWorkspace(workspace, held))) return false;
  }
  return true;
}

/** Refuse implicit bare-repository discovery and prevent repository metadata from starting monitors or hooks. Callers retain their environment,
 * transport and credential policy. A supplied hooks path must be an empty host-owned directory; otherwise the null device makes every hook lookup absent. */
export function buildHostGitArgs(args: readonly string[], options: {
  /** Caller-owned global configuration, applied before the mandatory floor. */
  configArgs?: readonly string[];
  disabledHooksPath?: string;
} = {}): string[] {
  const disabledHooksPath = options.disabledHooksPath ?? (process.platform === "win32" ? "NUL" : "/dev/null");
  return [
    ...options.configArgs ?? [],
    ...HOST_GIT_CONFIG.flatMap((entry) => ["-c", entry]),
    "-c", `core.hooksPath=${disabledHooksPath}`,
    ...args,
  ];
}
