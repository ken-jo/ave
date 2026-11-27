import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { createLogger } from "../lib/logger.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import { LINUX_SHELL_READY_FD, linuxShellExtraDescriptors, type MxcLinuxShellPrograms } from "../permissions/mxc-linux.js";
import { linuxLauncherStateDir, removeLinuxLauncherStateDir } from "../permissions/mxc-linux-raw-ip.js";
import { errorMessage } from "../shared/error-message.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const log = createLogger("linux-container-shell");

export interface LinuxContainerShellExit {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly rejected: boolean;
  /** The command started (its ready byte arrived) and the launcher then failed: a failed run, never a refused start. */
  readonly runFailed: boolean;
  readonly cleanupUnverified: boolean;
  readonly cleanupNotice?: string;
}

/**
 * What the launcher itself recorded about a run, read from its diagnostic log. The log lives in the request's staging
 * folder under the runtime root, which the container cannot reach, so the command cannot write it. The command does
 * share stderr with the launcher, so a stderr error envelope is never evidence. The pinned launcher writes `Exit code: N`
 * with the command's status, or `Exit code: -1` and an `Error:` line when the launcher, not the command, ended the run.
 */
type LauncherOutcome = "exited" | "timed-out" | "refused" | "unrecorded";

export function launcherOutcomeFromLog(log: string): LauncherOutcome {
  // Each write is prefixed with a `[<seconds>] ` stamp, including writes in the middle of a line.
  const lines = log.replace(/\[\d+\] /gu, "").split("\n");
  const exit = lines.findLast(line => line.startsWith("Exit code: "));
  if (exit === undefined) return lines.some(line => line.trim() !== "") ? "refused" : "unrecorded";
  // The status may stand alone or be followed by the launcher's hexadecimal echo of it.
  if (/^Exit code: \d+(?: |$)/u.test(exit)) return "exited";
  if (!/^Exit code: -1(?: |$)/u.test(exit)) return "unrecorded";
  const error = lines.findLast(line => line.startsWith("Error: "));
  return error?.includes("script timed out") === true ? "timed-out" : "refused";
}

export function startMxcLinuxShell(
  programs: MxcLinuxShellPrograms,
  staged: {
    readonly requestPath: string; readonly requestSha256: string;
    /** The contained shell's environment script, a 0600 file beside the request. */
    readonly environmentPath: string; readonly environmentSha256: string;
  },
  timeoutMs: number,
  signal: AbortSignal,
  revoke: () => void,
  label: string,
) {
  signal.throwIfAborted();
  if (createHash("sha256").update(readFileSync(staged.requestPath)).digest("hex") !== staged.requestSha256) {
    throw new Error("Linux container request changed before launch");
  }
  // The environment travels on a descriptor, never as launcher arguments, which any local user can read.
  const environment = openSync(staged.environmentPath, "r");
  let child: ChildProcessByStdio<null, Readable, Readable>;
  // A fresh, private log beside the staged request. The launcher appends to it, so an existing file is refused.
  const logPath = join(dirname(staged.requestPath), "launcher.log");
  try {
    // A positional read leaves the descriptor at offset 0 for the shell that sources it.
    const bytes = Buffer.alloc(fstatSync(environment).size);
    if (readSync(environment, bytes, 0, bytes.length, 0) !== bytes.length
      || createHash("sha256").update(bytes).digest("hex") !== staged.environmentSha256) {
      throw new Error("Linux container environment changed before launch");
    }
    closeSync(openSync(logPath, "wx", 0o600));
    child = spawn(programs.launcher, ["--log-file", logPath, "--config", staged.requestPath], {
      env: programs.env, detached: true,
      stdio: ["ignore", "pipe", "pipe", ...linuxShellExtraDescriptors(), environment],
    }) as ChildProcessByStdio<null, Readable, Readable>;
  } finally {
    closeSync(environment);
  }
  let timeout = false;
  let cancelled = false;
  let escalator: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (escalator !== undefined || child.exitCode !== null || child.signalCode !== null) return;
    cancelled = !timeout;
    child.kill("SIGTERM");
    escalator = setTimeout(() => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    }, TOOL_TIMEOUT_POLICY.mxcLinuxShellStopMs);
    escalator.unref();
  };
  const watchdog = setTimeout(() => {
    timeout = true;
    revoke();
  }, timeoutMs + TOOL_TIMEOUT_POLICY.mxcLinuxShellStopMs);
  watchdog.unref();
  signal.addEventListener("abort", stop, { once: true });
  let launchError = false;
  // Only the filter helper, once its filter is on, writes here; it closes the descriptor before the command runs.
  let started = false;
  // The launcher's network state folder, learned from its supervisor's argv once the command started. A launcher
  // stopped by a signal cannot remove it, so the launch does, after the launcher is gone.
  let stateDir: Promise<string | undefined> | undefined;
  const ready = child.stdio[LINUX_SHELL_READY_FD] as Readable | null;
  ready?.on("data", () => {
    if (!started && child.pid !== undefined) stateDir = linuxLauncherStateDir(child.pid).catch(() => undefined);
    started = true;
  });
  const completion = new Promise<LinuxContainerShellExit>((resolve, reject) => {
    child.on("error", () => { launchError = true; });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      clearTimeout(escalator);
      signal.removeEventListener("abort", stop);
      let outcome: LauncherOutcome;
      try { outcome = launchError ? "refused" : launcherOutcomeFromLog(readFileSync(logPath, "utf8")); } catch (error) {
        reject(error);
        return;
      }
      const removed = stateDir?.then(dir => dir === undefined ? undefined
        : removeLinuxLauncherStateDir(dir, programs.env.TMPDIR ?? "/tmp"));
      const timedOut = timeout || outcome === "timed-out";
      // A run that ended by a signal has no launcher verdict, so it is never reported as a refused start.
      const refused = !timedOut && !cancelled && outcome === "refused" && (launchError || code !== null);
      const exit = { code: code ?? -1, timedOut, cancelled: cancelled && !timedOut, cleanupUnverified: false,
        rejected: refused && !started, runFailed: refused && started };
      if (removed === undefined) resolve(exit);
      // A folder that cannot be removed never costs the command its result: the command ran.
      else removed.then(() => resolve(exit), (error: unknown) => {
        log.warn("Linux launcher state folder not removed: %s", errorMessage(error));
        resolve(exit);
      });
    });
  });
  trackManagedChildProcess(child, { label, killProcessGroup: true, cooperativeStop: stop });
  return { child, completion };
}
