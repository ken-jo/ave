// A host-owned holder PID keeps explicit filesystem grants alive; release revokes them and crash recovery prunes dead holders. All confined processes share one account, so concurrent plugins can reach each other's held grants: this provides no inter-plugin isolation (docs/design/plugin-hostapi-protocol.md).
import { spawn, type ChildProcess } from "node:child_process";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";

import { terminateChildProcess } from "../tools/terminate-child-process.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import {
  grantWindowsWorkerFilesystemAccess,
  type WindowsWorkerFilesystemGrant,
} from "./asrt-sandbox.js";

function windowsHolderEnv(): NodeJS.ProcessEnv {
  const root = windowsSystemRoot();
  return {
    SystemRoot: root,
    WINDIR: root,
  };
}

// Terminate a child unless it already exited, clearing the force timer on exit.
export function terminateChildBestEffort(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    const forceTimer = terminateChildProcess(child, 3_000);
    const clearForceTimer = (): void => clearTimeout(forceTimer);
    child.once("exit", clearForceTimer);
    child.once("close", clearForceTimer);
  } catch {
    // Already gone.
  }
}

// Start the holder process a grant is refcounted against: a pinned System32 binary, never resolved through `PATH`, that does nothing but stay alive until its stdin is closed or it is terminated.
export function startWindowsAclGrantHolder(label: string): ChildProcess {
  const system32 = win32SystemBinary("");
  assertManagedChildProcessAdmissionOpen(label);
  const child = spawn(win32SystemBinary("more.com"), [], {
    cwd: system32,
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
    windowsHide: true,
    env: windowsHolderEnv(),
  });
  if (child.pid === undefined) {
    child.once("error", () => {
      // The synchronous throw below is the fail-closed signal for this path. Keep the later async spawn error from becoming an unhandled event.
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // Spawn failed before pid publication.
    }
    throw new Error("[windows-acl-grant-holder] Windows ACL grant holder started without a pid");
  }
  trackManagedChildProcess(child, { label });
  return child;
}

export function stopWindowsAclGrantHolder(child: ChildProcess): void {
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  terminateChildBestEffort(child);
}

// A held grant: revoke it with HeldWindowsGrant.release, exactly once or more.
export interface HeldWindowsGrant {
  // Throws the reason the holder is gone if it died before release.
  assertAlive(): void;
  // Called once if the holder exits or errors before release — the grant is then no longer guaranteed, and the process it served must stop.
  onLost(listener: (reason: Error) => void): void;
  // Revoke the grant and stop the holder. Idempotent; never throws.
  release(): void;
}

// Start a holder and grant it `allowRead` (read and execute) and `allowWrite` (modify) for the `srt-sandbox` account. Every path must already exist: ASRT drops a grant on a missing path rather than refusing it. On any failure the holder is stopped and whatever was granted is revoked before the throw.
export async function holdWindowsFilesystemGrant(opts: {
  readonly label: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
}): Promise<HeldWindowsGrant> {
  const holder = startWindowsAclGrantHolder(opts.label);
  const holderPid = holder.pid;
  if (holderPid === undefined) {
    stopWindowsAclGrantHolder(holder);
    throw new Error("[windows-acl-grant-holder] Windows ACL grant holder started without a pid");
  }
  let grant: WindowsWorkerFilesystemGrant | undefined;
  let released = false;
  let lost: Error | undefined;
  const lostListeners: Array<(reason: Error) => void> = [];
  const release = (): void => {
    if (released) return;
    released = true;
    if (grant !== undefined) {
      try {
        grant.release();
      } catch {
        // Cleanup must continue even if ASRT reports the grant was already gone.
      }
    }
    stopWindowsAclGrantHolder(holder);
  };
  const holderGone = (first?: unknown, second?: unknown): void => {
    if (released || lost !== undefined) return;
    lost = first instanceof Error
      ? first
      : new Error(
          `[windows-acl-grant-holder] ${opts.label}: grant holder exited before release `
            + `(code=${String(first ?? "null")} signal=${String(second ?? "null")})`,
        );
    for (const listener of lostListeners.splice(0)) listener(lost);
  };
  holder.once("exit", holderGone);
  holder.once("error", holderGone);
  try {
    grant = await grantWindowsWorkerFilesystemAccess({
      holderPid,
      allowRead: opts.allowRead,
      allowWrite: opts.allowWrite,
    });
    if (lost !== undefined) throw lost;
  } catch (error) {
    release();
    throw error instanceof Error ? error : new Error(String(error));
  }
  return {
    assertAlive: () => {
      if (lost !== undefined) throw lost;
    },
    onLost: (listener) => {
      if (lost !== undefined) listener(lost);
      else lostListeners.push(listener);
    },
    release,
  };
}
