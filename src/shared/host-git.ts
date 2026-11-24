import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { inspectPhysicalFilesystemPath } from "./shell-filesystem-path.js";

/** Configuration every host-owned Git process carries before its subcommand. */
const HOST_GIT_CONFIG = ["safe.bareRepository=explicit", "core.fsmonitor=false"] as const;
/** Every hook event Git documents, as of the release `HOOK_EVENTS_VALIDATED` names; bumping that release means validating this list
 * again. A configured hook is found apart from the hooks path, and some events are run under `--no-verify` too, so each event is
 * switched off as a whole; a Git child the process starts inherits the switches. */
export const HOOK_EVENTS_VALIDATED = [2, 56] as const;
export const HOOK_EVENTS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase",
  "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout",
  "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
  "post-index-change",
] as const;
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

/** The one place host git starts on a workspace: the hold on `workspace` is asked and the process started in one synchronous step, so
 * no sandboxed command can take the hold in between. `held` starts nothing; neither does `no-folder`, a `cwd` that is no folder, which
 * says nothing of the program and so is no failure to start it. */
export function spawnHostGitIfWorkspaceFree(workspace: string, program: string, args: readonly string[], options: SpawnOptions, deadline?: number): ChildProcess | "held" | "no-folder" {
  if (!isHostGitWorkspaceAvailable(workspace)) return "held";
  if (options.cwd !== undefined && !isFolder(options.cwd)) return "no-folder";
  const spawnOptions = { ...options, shell: false };
  if (deadline !== undefined && performance.now() >= deadline) throw new DOMException("Git launch timed out", "TimeoutError");
  return spawn(program, args, spawnOptions);
}

function isFolder(path: string | URL): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
    ...HOOK_EVENTS.flatMap((event) => ["-c", `hook.${event}.enabled=false`]),
    ...args,
  ];
}
