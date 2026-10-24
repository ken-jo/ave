/**
 * The per-run directories `vitest.globalSetup.ts` makes: the run's Ave homes
 * (`h-*`) and its sandbox base (`sbx-*`) under `~/.ave/test-tmp`, and its temp
 * directory (`t-*`) under {@link runTmpRoot}.
 *
 * A run removes its own at teardown, and on a failed setup before returning.
 * One that was killed cannot, so each run also removes what a run left behind
 * — but only what a dead run left. Each run directory carries an owner record
 * naming the process that made it; the sweep removes a directory only when
 * that process is provably gone and the directory is old. Age alone proves
 * nothing: writes deep inside a live run's home do not move its timestamp, and
 * a clock that jumps forward makes every directory old. A directory whose
 * owner cannot be read, parsed or checked is kept.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { POSIX_SHARED_TMP } from "../../permissions/base-allowed-directories.js";

/** Run directory names: `mkdtemp` adds six characters after the prefix. */
const RUN_DIR_RE = /^(?:h|sbx|t)-[A-Za-z0-9]{6}$/;

/** A run directory a sweep renamed aside to remove (`.del-<uuid>`). */
const ASIDE_DIR_RE = /^\.del-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Inside each run directory: who made it. */
export const RUN_OWNER_FILE = ".ave-test-run-owner.json";

/**
 * The owner record's format. A record of any other version — including the
 * unversioned ones, whose start was the raw `ps` text of whatever time zone
 * and locale the recording shell had — is not evidence, so its directory is
 * kept.
 */
export const RUN_OWNER_VERSION = 2;

/** Older than any run: a whole suite takes minutes. */
export const STALE_RUN_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A process's start, in a form that does not depend on the environment that
 * reads it: the same process gives the same string under any time zone,
 * locale or later clock change.
 *
 *   - `linux:<boot id>:<start ticks since boot>`
 *   - `win32:<creation time, FILETIME UTC>`
 *   - `ps:<start, seconds since the epoch>` (macOS and other `ps` systems)
 */
const START_IDENTITY_RE = /^(?:linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+|win32:\d+|ps:\d+)$/;

export interface RunOwner {
  version: typeof RUN_OWNER_VERSION;
  pid: number;
  /** When the operating system says `pid` started; see {@link START_IDENTITY_RE}. */
  started: string;
  host: string;
}

/** What a sweep needs from the operating system; replaced in tests. */
export interface ProcessProbe {
  /** False only when no process has this pid. */
  exists(pid: number): boolean;
  /** The process's start identity, or undefined when it cannot be read. */
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
    let identity: string | undefined;
    try {
      identity = processStartIdentity(pid);
    } catch {
      // Unreadable is not evidence of anything: the owner is then kept.
      return undefined;
    }
    return identity !== undefined && START_IDENTITY_RE.test(identity) ? identity : undefined;
  },
  host: () => hostname(),
};

/** `ps` with its output pinned: C locale, UTC, whatever the caller's shell has. */
const PS_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C", LANG: "C" };
const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `ps -o lstart` text in the C locale and UTC (`Thu Oct  2 04:29:05 2026`) as
 * seconds since the epoch, or undefined for anything else.
 */
export function parsePsLstartUtc(text: string): number | undefined {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim());
  if (match === null) return undefined;
  const month = PS_MONTHS.indexOf(match[1]!);
  if (month < 0) return undefined;
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(Number) as [
    number, number, number, number, number,
  ];
  // No process started before the epoch; and `Date.UTC` reads years 0-99 as
  // 1900-1999, so those would come back as another instant.
  if (year < 1970 || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  // Reject a date that does not exist (Feb 30) rather than let it roll over.
  const back = new Date(ms);
  if (back.getUTCMonth() !== month || back.getUTCDate() !== day) return undefined;
  return ms / 1000;
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    // Both are kernel counters, free of time zone, locale and wall clock.
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the command name, which is parenthesized and may hold
    // spaces; `starttime` is the 22nd field, the 20th after it.
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return ticks === undefined ? undefined : `linux:${bootId}:${ticks}`;
  }
  if (process.platform === "win32") {
    // FILETIME in UTC: independent of the session's time zone and culture.
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
      // A pid with no process is an answer here, not news for the console.
      { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return `win32:${out}`;
  }
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 15_000,
    env: PS_ENV,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const seconds = parsePsLstartUtc(out);
  return seconds === undefined ? undefined : `ps:${seconds}`;
}

/**
 * Refuse `testTmp` unless it is a real directory (not a link) inside the
 * `.ave` it is named under: the sweep removes what is in it, so it must not
 * stand for somewhere else.
 */
export function assertTestTmpRoot(testTmp: string): void {
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

/**
 * Where a run's temp directory (`t-*`, which `os.tmpdir()` names in every
 * worker) lives. It must be somewhere the sandbox grants as ordinary temp,
 * as the user's own temp directory is: a confined command writes there, and
 * under `~/.ave` the Linux bubblewrap wrap, whose temp grant is `/tmp`, left
 * it read-only. On POSIX that is a per-user directory in the shared `/tmp`
 * (canonical `/private/tmp` on macOS), shorter than macOS's own 56-byte temp
 * directory, which several suites are sized against (a 128-byte shebang read,
 * the unix socket limit, a typed command line). On Windows, beside
 * `~/.ave` and outside it, for the 8.3 short names of the system temp path.
 */
export function runTmpRoot(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") return join(home, ".ave-test-tmp");
  // macOS's `/tmp` is a link to `/private/tmp`; the root is named canonically.
  const sharedTmp = platform === "darwin" ? join("/private", POSIX_SHARED_TMP) : POSIX_SHARED_TMP;
  return join(sharedTmp, `ave-test-${process.getuid!()}`);
}

/**
 * Make {@link runTmpRoot} if missing, and refuse one this account does not
 * own or that is a link: in a shared `/tmp` another account could have made
 * it first, and the sweep removes what is in it. Mode 0700 on POSIX.
 */
export function ensureRunTmpRoot(root: string): void {
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertTestTmpRoot(root);
  if (process.platform === "win32") return;
  const owner = lstatSync(root).uid;
  if (owner !== process.getuid!()) {
    throw new Error(`refusing ${root} as the tests' temp root: it belongs to uid ${owner}, not this account`);
  }
  chmodSync(root, 0o700);
}

/** Make `~/.ave/test-tmp` if missing, then {@link assertTestTmpRoot}. */
export function ensureTestTmpRoot(testTmp: string, mkdir: (path: string) => void): void {
  mkdir(testTmp);
  assertTestTmpRoot(testTmp);
}

/**
 * Record this process as the owner of a run directory it just made. A process
 * whose start cannot be read writes no record: its directory then cannot be
 * shown abandoned, and is kept.
 */
export function claimRunDir(dir: string, probe: ProcessProbe = systemProcessProbe): void {
  const started = probe.startedAt(process.pid);
  if (started === undefined) return;
  const owner: RunOwner = { version: RUN_OWNER_VERSION, pid: process.pid, started, host: probe.host() };
  writeFileSync(join(dir, RUN_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
}

/** The record exactly as written, and what it says when it says it validly. */
interface OwnerEvidence {
  text: string;
  owner: RunOwner;
}

function readOwnerEvidence(dir: string): OwnerEvidence | undefined {
  let text: string;
  let value: unknown;
  try {
    text = readFileSync(join(dir, RUN_OWNER_FILE), "utf8");
    value = JSON.parse(text);
  } catch {
    // Missing, unreadable or torn: no evidence of whose it is.
    return undefined;
  }
  const owner = validRunOwner(value);
  return owner === undefined ? undefined : { text, owner };
}

/** `value` as a run owner record of this version, or undefined. */
export function validRunOwner(value: unknown): RunOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== RUN_OWNER_VERSION) return undefined;
  const { pid, started, host } = record;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== "string" || host === "") return undefined;
  if (typeof started !== "string" || !START_IDENTITY_RE.test(started)) return undefined;
  return { version: RUN_OWNER_VERSION, pid, started, host };
}

/** Gone: no process has its pid, or the one that does started at another time. */
function ownerIsDead(owner: RunOwner, probe: ProcessProbe): boolean {
  // A run on another machine sharing this home cannot be checked from here.
  if (owner.host !== probe.host()) return false;
  if (!probe.exists(owner.pid)) return true;
  const started = probe.startedAt(owner.pid);
  // Unreadable, or read in another form than recorded: not evidence.
  if (started === undefined || started.split(":")[0] !== owner.started.split(":")[0]) return false;
  return started !== owner.started;
}

export interface SweepResult {
  /** Removed: a dead run's directories. */
  removed: string[];
  /**
   * Taken aside for removal, then found not to be what was judged dead, and
   * not put back because its name was taken again: left in place under this
   * name inside `test-tmp`, for a person to look at.
   */
  stranded: string[];
  /**
   * Directories renamed aside for removal that are still there: one whose
   * removal failed in this sweep, or one an earlier sweep left (stranded, or
   * interrupted) whose owner cannot be shown dead. Reported so a person knows
   * to look; a later sweep removes any whose evidence becomes complete.
   */
  leftAside: string[];
}

export interface SweepOptions {
  now?: number;
  maxAgeMs?: number;
  probe?: ProcessProbe;
  /**
   * Called after a directory is judged abandoned and again once it is taken
   * aside, with its name; tests change the tree there to model a concurrent
   * process.
   */
  onStep?: (step: "judged" | "taken-aside", path: string) => void;
}

/**
 * Remove the run directories in `testTmp` whose owner is gone and that were
 * last modified more than `maxAgeMs` before `now`: only real directories
 * directly inside it, with a run directory's name and a valid owner record; a
 * link is never followed. A directory judged dead is first renamed aside
 * within `testTmp`, and removed only when what was renamed is still the
 * directory judged — same device and inode, same record — so a directory made
 * at that name in between is never the one removed.
 */
export async function sweepStaleRunDirs(
  testTmp: string,
  remove: (path: string) => Promise<void>,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const { now = Date.now(), maxAgeMs = STALE_RUN_DIR_AGE_MS, probe = systemProcessProbe, onStep } = options;
  const result: SweepResult = { removed: [], stranded: [], leftAside: [] };
  // Again here, not only when setup made it: what is removed below is
  // whatever `testTmp` names now.
  assertTestTmpRoot(testTmp);
  for (const name of readdirSync(testTmp)) {
    if (ASIDE_DIR_RE.test(name)) {
      await reclaimAside(join(testTmp, name), remove, { now, maxAgeMs, probe }, result);
      continue;
    }
    if (!RUN_DIR_RE.test(name)) continue;
    const path = join(testTmp, name);
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      // Another run's teardown may remove it between the listing and here.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || now - Number(stat.mtimeMs) <= maxAgeMs) continue;
    const evidence = readOwnerEvidence(path);
    if (evidence === undefined || !ownerIsDead(evidence.owner, probe)) continue;

    onStep?.("judged", path);
    const aside = join(testTmp, `.del-${randomUUID()}`);
    try {
      renameSync(path, aside);
    } catch (error) {
      // Another sweep took it first.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    onStep?.("taken-aside", path);
    const taken = lstatSync(aside, { bigint: true });
    const same = taken.isDirectory() && taken.dev === stat.dev && taken.ino === stat.ino
      && readOwnerEvidence(aside)?.text === evidence.text;
    if (!same) {
      if (!putBack(aside, path)) result.stranded.push(aside);
      continue;
    }
    if (await removeAside(aside, remove, result)) result.removed.push(path);
  }
  return result;
}

/**
 * A directory an earlier sweep renamed aside and did not remove — its removal
 * failed or was interrupted, or it was stranded. Removed on the same evidence
 * as a run directory (a valid record, old, owner gone); kept and reported
 * otherwise. Its name is a fresh UUID only a sweep makes, so nothing else
 * comes to hold it between the judgment and the removal.
 */
async function reclaimAside(
  aside: string,
  remove: (path: string) => Promise<void>,
  options: { now: number; maxAgeMs: number; probe: ProcessProbe },
  result: SweepResult,
): Promise<void> {
  let stat;
  try {
    stat = lstatSync(aside);
  } catch (error) {
    // Another sweep removed it between the listing and here.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) return;
  const evidence = readOwnerEvidence(aside);
  if (options.now - stat.mtimeMs <= options.maxAgeMs || evidence === undefined || !ownerIsDead(evidence.owner, options.probe)) {
    result.leftAside.push(aside);
    return;
  }
  if (await removeAside(aside, remove, result)) result.removed.push(aside);
}

/**
 * Remove a directory renamed aside. A failure leaves it there, reported, for
 * a later sweep: a stale directory that will not go is no reason to stop a
 * test run. Returns whether this sweep removed it.
 */
async function removeAside(aside: string, remove: (path: string) => Promise<void>, result: SweepResult): Promise<boolean> {
  try {
    await remove(aside);
    return true;
  } catch (error) {
    // Another sweep reclaimed it first.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    result.leftAside.push(aside);
    return false;
  }
}

/** Rename `aside` back to `path` unless something holds that name again. */
function putBack(aside: string, path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  renameSync(aside, path);
  return true;
}
