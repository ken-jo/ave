import { statSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";

import { validateShellWorkingDirectory } from "./shell-path-policy.js";

/**
 * Session-scoped working directory for the `bash` tool.
 *
 * A `cd` in one foreground command carries into the next call of the same
 * session while the directory stays inside the workspace or an allowed
 * directory. Environment variables, functions, and shell options do not
 * persist: every call is still a fresh process.
 *
 * The record is bound to the workspace root it was observed under. A session
 * whose execution root changes (for example a project switch) ignores the old
 * record rather than resolving a stale directory against the new root. The
 * workspace root itself is never stored: it is the default.
 */
interface SessionCwdRecord {
  readonly root: string;
  readonly cwd: string;
}

const sessionCwds = new Map<string, SessionCwdRecord>();

/** Tracking needs a real conversation; unattributed calls start at the root. */
function isTrackableSession(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === "string" && sessionId !== "" && sessionId !== "unknown";
}

export function readShellSessionCwd(sessionId: string | undefined, root: string): string | undefined {
  if (!isTrackableSession(sessionId)) return undefined;
  const record = sessionCwds.get(sessionId);
  if (record === undefined || record.root !== pathResolve(root)) return undefined;
  return record.cwd;
}

export function recordShellSessionCwd(sessionId: string | undefined, root: string, cwd: string): void {
  if (!isTrackableSession(sessionId)) return;
  const resolvedRoot = pathResolve(root);
  const resolvedCwd = pathResolve(cwd);
  if (resolvedCwd === resolvedRoot) {
    sessionCwds.delete(sessionId);
    return;
  }
  sessionCwds.set(sessionId, Object.freeze({ root: resolvedRoot, cwd: resolvedCwd }));
}

export function clearShellSessionCwd(sessionId: string): void {
  sessionCwds.delete(sessionId);
}

/**
 * Resolve a `bash` input against the session directory before any hook,
 * permission, approval, or route check reads it, so every one of them binds
 * the directory the command will actually run in. An absent `cwd` becomes the
 * session directory; a relative `cwd` resolves from it. A stored directory
 * that no longer exists or has left the allowed scope is dropped and the call
 * starts at the workspace root.
 */
export function withShellSessionCwd(
  input: Record<string, unknown>,
  context: {
    readonly sessionId: string | undefined;
    readonly root: string;
    readonly allowedDirectories: readonly string[];
  },
): Record<string, unknown> {
  const sessionCwd = readShellSessionCwd(context.sessionId, context.root);
  if (sessionCwd === undefined) return input;
  if (
    !isExistingDirectory(sessionCwd) ||
    validateShellWorkingDirectory(sessionCwd, context.root, context.allowedDirectories) !== null
  ) {
    clearShellSessionCwd(context.sessionId!);
    return input;
  }
  const requested = input.cwd;
  if (requested === undefined || requested === "") return { ...input, cwd: sessionCwd };
  if (typeof requested === "string" && !isAbsolute(requested)) {
    return { ...input, cwd: pathResolve(sessionCwd, requested) };
  }
  return input;
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
