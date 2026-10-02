/**
 * The per-run directories `vitest.globalSetup.ts` makes under
 * `~/.ave/test-tmp`: the run's Ave homes (`h-*`) and its sandbox base
 * (`sbx-*`).
 *
 * A run removes its own at teardown, and on a failed setup before returning.
 * One that was killed cannot, so each run also removes what a run left behind
 * — but only what a dead run left. Each run directory carries an owner record
 * naming the process that made it; the sweep removes a directory only when
 * that process is provably gone and the directory is old. Age alone proves
 * nothing: writes deep inside a live run's home do not move its timestamp, and
 * a clock that jumps forward makes every directory old. A directory whose
 * owner cannot be read or checked is kept.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** Run directory names: `mkdtemp` adds six characters after the prefix. */
const RUN_DIR_RE = /^(?:h|sbx)-[A-Za-z0-9]{6}$/;

/** Inside each run directory: who made it. */
export const RUN_OWNER_FILE = ".ave-test-run-owner.json";

/** Older than any run: a whole suite takes minutes. */
export const STALE_RUN_DIR_AGE_MS = 24 * 60 * 60 * 1000;

export interface RunOwner {
  pid: number;
  /**
   * When the operating system says `pid` started, read the same way for the
   * record and for the check, so equal means the same process. Absent when it
   * could not be read; such an owner can only be shown dead by its pid.
   */
  started?: string;
  host: string;
}

/** What a sweep needs from the operating system; replaced in tests. */
export interface ProcessProbe {
  /** False only when no process has this pid. */
  exists(pid: number): boolean;
  /** When the process started, or undefined when that cannot be read. */
  startedAt(pid: number): string | undefined;
  host(): string;
}

export const systemProcessProbe: ProcessProbe = {
  exists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: it exists and belongs to someone else.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  startedAt(pid) {
    try {
      return processStartedAt(pid);
    } catch {
      // Unreadable is not evidence of anything: the owner is then kept.
      return undefined;
    }
  },
  host: () => hostname(),
};

/**
 * The start of `pid` as the kernel recorded it, immune to later clock changes:
 * on Linux the boot and the tick count since it, elsewhere the wall time the
 * kernel stored when the process started.
 */
function processStartedAt(pid: number): string | undefined {
  if (process.platform === "linux") {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the command name, which is parenthesized and may hold
    // spaces; `starttime` is the 22nd field, the 20th after it.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return `${bootId}:${fields[19]}`;
  }
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
    return /^\d+$/.test(out) ? out : undefined;
  }
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 15_000 }).trim();
  return out === "" ? undefined : out;
}

/**
 * Make `~/.ave/test-tmp` if missing, and refuse it unless it is a real
 * directory (not a link) inside the `.ave` it is named under: the sweep
 * removes what is in it, so it must not stand for somewhere else.
 */
export function ensureTestTmpRoot(testTmp: string, mkdir: (path: string) => void): void {
  mkdir(testTmp);
  const stat = lstatSync(testTmp);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing ${testTmp} as the tests' scratch root: it is not a real directory`);
  }
  const canonical = realpathSync.native(testTmp);
  const expected = join(realpathSync.native(dirname(testTmp)), basename(testTmp));
  if (canonical !== expected) {
    throw new Error(`refusing ${testTmp} as the tests' scratch root: it resolves to ${canonical}, not ${expected}`);
  }
}

/** Record this process as the owner of a run directory it just made. */
export function claimRunDir(dir: string, probe: ProcessProbe = systemProcessProbe): void {
  const owner: RunOwner = { pid: process.pid, host: probe.host() };
  const started = probe.startedAt(process.pid);
  if (started !== undefined) owner.started = started;
  writeFileSync(join(dir, RUN_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
}

function readOwner(dir: string): RunOwner | undefined {
  let value: Partial<RunOwner>;
  try {
    value = JSON.parse(readFileSync(join(dir, RUN_OWNER_FILE), "utf8")) as Partial<RunOwner>;
  } catch {
    // Missing, unreadable or torn: no evidence of whose it is, so it is kept.
    return undefined;
  }
  if (!Number.isInteger(value.pid) || typeof value.host !== "string") return undefined;
  if (value.started !== undefined && typeof value.started !== "string") return undefined;
  return value as RunOwner;
}

/** Gone: no process has its pid, or the one that does started at another time. */
function ownerIsDead(owner: RunOwner, probe: ProcessProbe): boolean {
  // A run on another machine sharing this home cannot be checked from here.
  if (owner.host !== probe.host()) return false;
  if (!probe.exists(owner.pid)) return true;
  if (owner.started === undefined) return false;
  const started = probe.startedAt(owner.pid);
  return started !== undefined && started !== owner.started;
}

/**
 * Remove the run directories in `testTmp` whose owner is gone and that were
 * last modified more than `maxAgeMs` before `now`. Only real directories
 * directly inside it, with a run directory's name and a readable owner record;
 * a link is never followed. Returns what it removed.
 */
export async function sweepStaleRunDirs(
  testTmp: string,
  remove: (path: string) => Promise<void>,
  options: { now?: number; maxAgeMs?: number; probe?: ProcessProbe } = {},
): Promise<string[]> {
  const { now = Date.now(), maxAgeMs = STALE_RUN_DIR_AGE_MS, probe = systemProcessProbe } = options;
  const removed: string[] = [];
  for (const name of readdirSync(testTmp)) {
    if (!RUN_DIR_RE.test(name)) continue;
    const path = join(testTmp, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      // Another run's teardown may remove it between the listing and here.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
    const owner = readOwner(path);
    if (owner === undefined || !ownerIsDead(owner, probe)) continue;
    try {
      await remove(path);
    } catch (error) {
      // Two runs starting together sweep the same leftovers.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    removed.push(path);
  }
  return removed;
}
