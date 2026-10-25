import { statSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";

import { validateShellWorkingDirectory } from "./shell-path-policy.js";

// Carry cwd between fresh shell calls only within allowed scope; environment, functions, and options do not persist.
// Bind records to the observed workspace root so project switches cannot reuse stale directories.
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

// Resolve session cwd before hooks, permission, approval, and route checks so all bind the execution directory.
// Drop missing or out-of-scope records and return to the workspace root.
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
