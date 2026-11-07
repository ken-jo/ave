import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";

const execFileAsync = promisify(execFile);
// A boot-time query, not a tool call: past this the result is unresolved and callers keep what it owns.
const START_TIME_PROBE_TIMEOUT_MS = 10_000;

// `startTime` is the process creation time as a UTC FILETIME, or null when the process runs but its start time cannot be read (another account's process).
export type ProcessRunState = { readonly running: false } | { readonly running: true; readonly startTime: string | null };

// A pid missing from the result is undetermined; callers keep whatever it owns.
export type ProcessRunStateProbe = (pids: readonly number[]) => Promise<ReadonlyMap<number, ProcessRunState>>;

const START_TIME_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "foreach ($id in ($env:AVE_PROBE_PIDS -split ',')) { $n = [int]$id; $v = 'unknown'; try { $p = [System.Diagnostics.Process]::GetProcessById($n); try { $v = $p.StartTime.ToFileTimeUtc().ToString() } catch { } finally { $p.Dispose() } } catch [System.ArgumentException] { $v = 'gone' }; [Console]::Out.WriteLine(\"$n $v\") }",
].join("; ");
const START_TIME_COMMAND = Buffer.from(START_TIME_SCRIPT, "utf16le").toString("base64");

function isPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fff_ffff;
}

// Signal 0 answers liveness without a spawn; only running pids pay for the start-time query.
function isRunning(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

function parseProcessStartTimes(output: string, pids: readonly number[]): Map<number, ProcessRunState> {
  const states = new Map<number, ProcessRunState>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9]+) (gone|unknown|[0-9]+)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    if (!pids.includes(pid)) continue;
    const value = match[2]!;
    states.set(pid, value === "gone" ? { running: false }
      : { running: true, startTime: value === "unknown" ? null : value });
  }
  return states;
}

export const readWindowsProcessRunStates: ProcessRunStateProbe = async (pids) => {
  const states = new Map<number, ProcessRunState>();
  if (process.platform !== "win32") return states;
  const running: number[] = [];
  for (const pid of new Set(pids)) {
    if (!isPid(pid)) continue;
    const alive = isRunning(pid);
    if (alive === false) states.set(pid, { running: false });
    else if (alive === true) running.push(pid);
  }
  if (running.length === 0) return states;
  const { stdout } = await execFileAsync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", START_TIME_COMMAND,
  ], {
    env: { SystemRoot: windowsSystemRoot(), AVE_PROBE_PIDS: running.join(",") },
    windowsHide: true, timeout: START_TIME_PROBE_TIMEOUT_MS, encoding: "utf8",
  });
  for (const [pid, state] of parseProcessStartTimes(stdout, running)) states.set(pid, state);
  return states;
};
