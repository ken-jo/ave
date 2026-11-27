import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import type { MxcLinuxShellPrograms } from "../permissions/mxc-linux.js";
import { isRecord } from "../shared/is-record.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export interface LinuxContainerShellExit {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly rejected: boolean;
  readonly cleanupUnverified: boolean;
  readonly failure?: { readonly code: string };
  readonly cleanupNotice?: string;
}

function isLauncherErrorEnvelope(line: string): boolean {
  if (!line.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string";
  } catch {
    return false;
  }
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
  const child = spawn(programs.launcher, ["--config", staged.requestPath], {
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
  let stderr = "";
  let launcherError = false;
  child.stderr.on("data", (chunk: Buffer) => {
    const lines = (stderr + chunk.toString()).split("\n");
    stderr = (lines.pop() ?? "").slice(-8192);
    launcherError ||= lines.some(isLauncherErrorEnvelope);
  });
  const completion = new Promise<LinuxContainerShellExit>((resolve) => {
    child.on("error", () => { launchError = true; });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      clearTimeout(escalator);
      signal.removeEventListener("abort", stop);
      const envelope = code === 255 && (launcherError || isLauncherErrorEnvelope(stderr));
      resolve({ code: code ?? -1, timedOut: timeout, cancelled, cleanupUnverified: false,
        rejected: !timeout && !cancelled && (launchError || envelope) });
    });
  });
  trackManagedChildProcess(child, { label, killProcessGroup: true, cooperativeStop: stop });
  return { child, completion };
}
