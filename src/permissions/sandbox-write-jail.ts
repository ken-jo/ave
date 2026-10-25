// The write jail is the canonical union of plugin DATA storage and user-authorized directories; never grant the plugin root containing executable bundles or manifests, since self-rewrite enables later host execution. Reads use separate policy.
import { canonicalizePathForMatch } from "./sensitive-paths.js";

// Inputs for deriveSandboxWritePaths. Pure data — no I/O of its own.
export interface SandboxWriteJailInput {
  // Owner plugin writable root (`~/.ave/plugins/<pluginId>/data`) when the invoking tool is plugin-owned, else undefined. Builtins (bash/powershell invoked directly) have no owner plugin and pass undefined. Producers MUST derive it via `resolvePluginWritableRoot` so the installed bundle stays outside the jail.
  ownerPluginSandboxRoot?: string;
  // In-scope authorized directories for this invocation: the session cwd unioned with the user-authorized extra directories. These remain writable so a user who granted a directory can still write to it.
  allowedDirectories: readonly string[];
}

// Compute the canonicalized, de-duplicated set of filesystem paths the sandbox may grant write access to for this invocation. Canonicalization uses canonicalizePathForMatch (the same normalization the reviewer's sensitive-path layer uses) so the OS jail and the reviewer judgement see bit-identical path strings. That helper performs a bounded synchronous `realpath` walk-up (the only I/O here); the function has no global state and does not spawn, so it stays testable in isolation. Builtins / no-plugin shell: `ownerPluginSandboxRoot` is undefined, so the jail is exactly the allowed directories. A plugin-owned tool additionally gains its own writable data root.
export function deriveSandboxWritePaths(input: SandboxWriteJailInput): string[] {
  const raw: string[] = [];
  if (input.ownerPluginSandboxRoot !== undefined && input.ownerPluginSandboxRoot !== "") {
    raw.push(input.ownerPluginSandboxRoot);
  }
  for (const dir of input.allowedDirectories) {
    if (dir !== "") raw.push(dir);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of raw) {
    const canonical = canonicalizePathForMatch(path);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
