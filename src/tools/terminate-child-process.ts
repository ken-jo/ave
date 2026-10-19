import type { ChildProcess } from "node:child_process";

type TerminableChild = Pick<ChildProcess, "exitCode" | "signalCode" | "kill"> & { readonly pid?: number | undefined };

export interface TerminateChildOptions {
  /**
   * The child leads its own process group (spawned `detached` on POSIX):
   * signal the whole group, so what it started goes with it. Ignored on
   * Windows, where `detached` means a new console instead.
   */
  readonly processGroup?: boolean;
}

function signal(child: TerminableChild, name: NodeJS.Signals, group: boolean): void {
  if (group && child.pid !== undefined) {
    try {
      process.kill(-child.pid, name);
      return;
    } catch {
      // The group may already be gone; signal the child itself below.
    }
  }
  child.kill(name);
}

/**
 * Ask a child to stop, then force it down if SIGTERM has not produced an exit.
 *
 * `ChildProcess.killed` only means that Node successfully sent a signal. It
 * becomes true immediately after SIGTERM even while the process is still
 * alive, so it must not be used as the force-kill guard.
 */
export function terminateChildProcess(
  child: TerminableChild,
  forceAfterMs = 2_000,
  options: TerminateChildOptions = {},
): ReturnType<typeof setTimeout> {
  const group = options.processGroup === true && process.platform !== "win32";
  try {
    signal(child, "SIGTERM", group);
  } catch {
    // A failed graceful signal does not prove the child is gone. Keep the
    // escalation timer so a later force signal still has a chance to stop it.
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        signal(child, "SIGKILL", group);
      } catch {
        // The caller retains lifecycle ownership until exit/close.
      }
    }
  }, forceAfterMs);
  const nodeTimer = forceTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
  nodeTimer.unref?.();
  return forceTimer;
}
