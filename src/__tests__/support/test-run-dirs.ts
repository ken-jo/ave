/** Sweep only old run directories whose recorded owner is provably dead; retain unreadable or uncertain ownership. */
import { execFileSync } from "node:child_process";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { POSIX_SHARED_TMP } from "../../permissions/base-allowed-directories.js";

const RUN_DIR_RE = /^(?:h|sbx|t)-[A-Za-z0-9]{6}$/;

const ASIDE_DIR_RE = /^\.del-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const RUN_OWNER_FILE = ".ave-test-run-owner.json";

/** Unknown owner-record versions cannot prove abandonment. */
export const RUN_OWNER_VERSION = 2;

export const STALE_RUN_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/** Use kernel or epoch-based start identities independent of locale, time zone, and wall-clock changes. */
const START_IDENTITY_RE = /^(?:linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+|win32:\d+|ps:\d+)$/;

export interface RunOwner {
  version: typeof RUN_OWNER_VERSION;
  pid: number;
  started: string;
  host: string;
}

export interface ProcessProbe {
  exists(pid: number): boolean;
  startedAt(pid: number): string | undefined;
  host(): string;
}

export const systemProcessProbe: ProcessProbe = {
  exists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists under another account.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  startedAt(pid) {
    let identity: string | undefined;
    try {
      identity = processStartIdentity(pid);
    } catch {
      // An unreadable process identity cannot prove abandonment.
      return undefined;
    }
    return identity !== undefined && START_IDENTITY_RE.test(identity) ? identity : undefined;
  },
  host: () => hostname(),
};

const PS_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C", LANG: "C" };
const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parsePsLstartUtc(text: string): number | undefined {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim());
  if (match === null) return undefined;
  const month = PS_MONTHS.indexOf(match[1]!);
  if (month < 0) return undefined;
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(Number) as [
    number, number, number, number, number,
  ];
  // Reject pre-epoch starts and years 0–99, which Date.UTC remaps to 1900–1999.
  if (year < 1970 || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  // Reject impossible dates instead of accepting rollover.
  const back = new Date(ms);
  if (back.getUTCMonth() !== month || back.getUTCDate() !== day) return undefined;
  return ms / 1000;
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The parenthesized command may contain spaces; starttime is field 22.
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return ticks === undefined ? undefined : `linux:${bootId}:${ticks}`;
  }
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
      { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: windowsPowerShellEnv() },
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

/** The sweep root must be a real directory contained within the named Ave home. */
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

/** Keep temp outside the Ave home for sandbox writes, with short POSIX paths for shebang and socket limits. */
export function runTmpRoot(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") return join(home, ".ave-test-tmp");
  // Canonicalize macOS /tmp to /private/tmp.
  const sharedTmp = platform === "darwin" ? join("/private", POSIX_SHARED_TMP) : POSIX_SHARED_TMP;
  return join(sharedTmp, `ave-test-${process.getuid!()}`);
}

/** Reject linked or foreign-owned shared temp roots; use mode 0700 on POSIX. */
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

export function ensureTestTmpRoot(testTmp: string, mkdir: (path: string) => void): void {
  mkdir(testTmp);
  assertTestTmpRoot(testTmp);
}

/** Without a readable process start, write no owner record and retain the directory. */
export function claimRunDir(dir: string, probe: ProcessProbe = systemProcessProbe): void {
  const started = probe.startedAt(process.pid);
  if (started === undefined) return;
  const owner: RunOwner = { version: RUN_OWNER_VERSION, pid: process.pid, started, host: probe.host() };
  writeFileSync(join(dir, RUN_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
}

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
    // Missing, unreadable, or torn records cannot prove ownership.
    return undefined;
  }
  const owner = validRunOwner(value);
  return owner === undefined ? undefined : { text, owner };
}

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

/** A reused pid is dead only when the recorded start differs. */
function ownerIsDead(owner: RunOwner, probe: ProcessProbe): boolean {
  // Owners on another machine cannot be checked locally.
  if (owner.host !== probe.host()) return false;
  if (!probe.exists(owner.pid)) return true;
  const started = probe.startedAt(owner.pid);
  // Unverifiable start identities cannot prove abandonment.
  if (started === undefined || started.split(":")[0] !== owner.started.split(":")[0]) return false;
  return started !== owner.started;
}

export interface SweepResult {
  removed: string[];
  /** Report stranded renamed directories when a replacement occupies the original name. */
  stranded: string[];
  /** Report failed or uncertain removals so a later sweep can retry with complete evidence. */
  leftAside: string[];
}

export interface SweepOptions {
  now?: number;
  maxAgeMs?: number;
  probe?: ProcessProbe;
  /** Tests mutate the tree at both abandonment checks to model races. */
  onStep?: (step: "judged" | "taken-aside", path: string) => void;
}

/** Rename abandoned directories aside, then recheck device, inode, and owner record before removal. */
export async function sweepStaleRunDirs(
  testTmp: string,
  remove: (path: string) => Promise<void>,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const { now = Date.now(), maxAgeMs = STALE_RUN_DIR_AGE_MS, probe = systemProcessProbe, onStep } = options;
  const result: SweepResult = { removed: [], stranded: [], leftAside: [] };
  // Revalidate the current sweep root rather than trusting setup-time checks.
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

/** Renamed leftovers require the same age and dead-owner proof as ordinary run directories. */
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

/** Report failed removal and leave it for a later sweep without failing the run. */
async function removeAside(aside: string, remove: (path: string) => Promise<void>, result: SweepResult): Promise<boolean> {
  try {
    await remove(aside);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    result.leftAside.push(aside);
    return false;
  }
}

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
