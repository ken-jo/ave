import { lstat, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { readWindowsAdminPolicy } from "../shared/windows-admin-policy.js";
import { checkAdminPolicyPath } from "../shared/ave-home-test-guard.js";
import type { AuditLogger } from "../audit/audit-logger.js";

let policyAuditLogger: Pick<AuditLogger, "log"> | undefined;

export function initAdminPolicyAudit(logger: Pick<AuditLogger, "log">): void {
  policyAuditLogger = logger;
}

export function auditAdminPolicyFailure(reason: string): void {
  policyAuditLogger?.log({ timestamp: new Date().toISOString(), sessionId: "policy", type: "error", output: reason });
}

export async function readAdminPolicyFile(filePath: string): Promise<Buffer> {
  checkAdminPolicyPath(filePath);
  try {
    return await (process.platform === "win32" ? readWindowsAdminPolicy(filePath) : readFile(filePath));
  } catch (error) {
    if (!(await isAdminPolicyFileAbsent(filePath, error))) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      auditAdminPolicyFailure(`invalid policy file at ${filePath}: ${code === "untrusted-policy" ? (error as Error).message : `read failed (${code})`}`);
    }
    throw error;
  }
}

async function hasDirectoryAncestor(filePath: string): Promise<boolean> {
  let parent = dirname(filePath);
  for (;;) {
    try {
      const entry = await lstat(parent);
      if (entry.isSymbolicLink()) {
        try {
          return (await stat(parent)).isDirectory();
        } catch {
          return false;
        }
      }
      return entry.isDirectory();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
    }
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
}

/** Only confirmed absence counts as missing policy; dangling links and inconclusive probes remain unreadable. */
export async function isAdminPolicyFileAbsent(
  filePath: string,
  readError: unknown,
  inspectEntry: (path: string) => Promise<unknown> = lstat,
): Promise<boolean> {
  if ((readError as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
  try {
    await inspectEntry(filePath);
    return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
    // ENOENT can also mean a non-directory parent.
    return await hasDirectoryAncestor(filePath);
  }
}
