import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import type { MxcLinuxShellPrograms } from "../permissions/mxc-linux.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export interface LinuxContainerShellExit {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly rejected: boolean;
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
  if (/^Exit code: \d+ /u.test(exit)) return "exited";
  if (!exit.startsWith("Exit code: -1 ")) return "unrecorded";
  const error = lines.findLast(line => line.startsWith("Error: "));
  return error?.includes("script timed out") === true ? "timed-out" : "refused";
}

export function startMxcLinuxShell(
  programs: MxcLinuxShellPrograms,
  staged: { readonly requestPath: string; readonly requestSha256: string },
  timeoutMs: number,
  signal: AbortSignal,
  revoke: () => void,
  label: string,
) {
  signal.throwIfAborted();
  if (createHash("sha256").update(readFileSync(staged.requestPath)).digest("hex") !== staged.requestSha256) {
    throw new Error("Linux container request changed before launch");
  }
  // A fresh, private log beside the staged request. The launcher appends to it, so an existing file is refused.
  const logPath = join(dirname(staged.requestPath), "launcher.log");
  closeSync(openSync(logPath, "wx", 0o600));
  const child = spawn(programs.launcher, ["--log-file", logPath, "--config", staged.requestPath], {
    env: programs.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
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
      const timedOut = timeout || outcome === "timed-out";
      // A run that ended by a signal has no launcher verdict, so it is never reported as a refused start.
      const refused = outcome === "refused" && (launchError || code !== null);
      resolve({ code: code ?? -1, timedOut, cancelled: cancelled && !timedOut, cleanupUnverified: false,
        rejected: !timedOut && !cancelled && refused });
    });
  });
  trackManagedChildProcess(child, { label, killProcessGroup: true, cooperativeStop: stop });
  return { child, completion };
}
