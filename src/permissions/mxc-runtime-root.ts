import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix as posixPath, win32 as winPath } from "node:path";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { AVE_HOME_ISOLATION_GUARD_ACTIVE } from "../shared/ave-home-test-guard.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { assertMxcHolderStaging } from "./mxc-filesystem-ownership.js";

const log = createLogger("mxc-runtime-root");

/** No owned, private, non-link runtime root outside the Ave home could be established. The start is refused: nothing a
 * container needs is ever placed under the Ave home instead. */
export class MxcRuntimeRootError extends Error {
  readonly code = "mxc-runtime-root-unavailable";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcRuntimeRootError";
  }
}

/** What the selector reads from the host. Production uses `currentMxcRuntimeHost()`; a test replaces single fields. */
export interface MxcRuntimeHost {
  readonly platform: NodeJS.Platform;
  /** The account's cache directory: `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux. */
  readonly cacheHome: string;
  readonly uid: number | undefined;
  readonly pid: number;
  readonly aveHome: string;
  /** Whether a process with this pid exists, whoever owns it. */
  processExists(pid: number): boolean;
  /** A value that differs between two processes that had the same pid, or null when it cannot be read. */
  processStart(pid: number): string | null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists and belongs to another account.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function linuxProcessStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may hold spaces and parentheses; the fields after its closing one start at field 3 (state).
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (startTicks === undefined || !/^\d+$/u.test(startTicks)) return null;
    // Ticks count from boot, so the boot is part of the identity.
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return boot.length === 0 ? null : `${boot}:${startTicks}`;
  } catch {
    return null;
  }
}

function darwinProcessStart(pid: number): string | null {
  try {
    // A fixed zone and locale, so the same process reads the same across a clock-zone change.
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/** The electron-builder `appId` (package.json `build.appId`), which names the app's per-user directories. */
export const AVE_APP_ID = "ai.agent-connector.ave";

/**
 * The account's cache directory. It is per-user, so no other account can occupy a name in it; it is on disk, so a
 * HOME's worth of files fits; and nothing ages files out of it, as macOS does from the per-user temp directory after
 * days without a read. A `$XDG_CACHE_HOME` that is not absolute is ignored, as its specification says.
 */
export function mxcCacheHome(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (platform === "darwin") return posixPath.join(home, "Library", "Caches");
  const xdg = env.XDG_CACHE_HOME;
  return xdg !== undefined && posixPath.isAbsolute(xdg) ? xdg : posixPath.join(home, ".cache");
}

export function currentMxcRuntimeHost(): MxcRuntimeHost {
  const platform = process.platform;
  return {
    platform,
    // Under the test runner the root lives in the run's own directory, never in the account's cache.
    cacheHome: AVE_HOME_ISOLATION_GUARD_ACTIVE
      ? posixPath.join(process.env.AVE_TEST_SANDBOX_BASE ?? tmpdir(), "mxc-cache")
      : mxcCacheHome(platform, process.env, homedir()),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    pid: process.pid,
    aveHome: aveHome(),
    processExists,
    processStart: platform === "linux" ? linuxProcessStart : platform === "darwin" ? darwinProcessStart : () => null,
  };
}

function refuse(message: string, cause?: unknown): never {
  throw new MxcRuntimeRootError(message, cause === undefined ? undefined : { cause });
}

function posixUid(host: MxcRuntimeHost): number {
  if (host.platform !== "darwin" && host.platform !== "linux") {
    refuse(`Container runtime root has no placement on ${host.platform}`);
  }
  if (host.uid === undefined) refuse("Container runtime root needs the account's user id");
  return host.uid;
}

const privateTo = (entry: Stats, uid: number): boolean =>
  !entry.isSymbolicLink() && entry.isDirectory() && entry.uid === uid && (entry.mode & 0o077) === 0;

/** Create `path` 0700 if it is absent, then require a real directory of this account closed to every other account.
 * An existing directory that fails is refused as it is: it is never re-moded, replaced or bypassed. */
function ensurePrivateDirectory(path: string, uid: number, what: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") refuse(`${what} could not be created`, error);
  }
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (error) {
    return refuse(`${what} could not be inspected`, error);
  }
  if (!privateTo(entry, uid)) refuse(`${what} is a link, not a directory, not this account's, or open to other accounts`);
  return path;
}

const atOrUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/** `path` with its deepest existing ancestor resolved, so the result is canonical wherever it can be. */
function canonicalWhereItExists(path: string): string {
  const missing: string[] = [];
  for (let current = path; ; current = posixPath.dirname(current)) {
    try {
      return posixPath.join(realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || posixPath.dirname(current) === current) {
        return refuse("Container runtime root could not be resolved", error);
      }
      missing.unshift(posixPath.basename(current));
    }
  }
}

/**
 * Where the runtime root is, without creating or verifying it: `<cache home>/<app id>/mxc-runtime`, canonical because
 * the macOS sandbox matches real paths. The sandbox read floor denies this path to every confined process that is not
 * granted its own run directory inside it (`appOwnedSandboxPrivateRoots`): the run directories are Ave-private data,
 * as they were under the Ave home.
 */
export function mxcRuntimeRootPath(host: MxcRuntimeHost = currentMxcRuntimeHost()): string {
  posixUid(host);
  if (!posixPath.isAbsolute(host.cacheHome)) refuse("The account's cache directory is not an absolute path");
  // The root's own name is not resolved: a link there is refused when the root is established, never followed.
  return posixPath.join(canonicalWhereItExists(posixPath.join(host.cacheHome, AVE_APP_ID)), "mxc-runtime");
}

/**
 * The one directory everything a container needs lives under on macOS and Linux: `<cache home>/<app id>/mxc-runtime`,
 * mode 0700, owned by this account, never a link, and neither inside nor above the Ave home. The Ave home is a denied
 * directory, and the macOS sandbox lets a deny override every allow, so a grant nested inside it cannot work there.
 * The root itself is host-only: a container is granted its own run directory beneath it and nothing above that.
 * Every call re-verifies. A failure throws `MxcRuntimeRootError`, before anything is created when the placement
 * itself is refused; no caller may place staging elsewhere instead.
 */
export function ensureMxcRuntimeRoot(host: MxcRuntimeHost = currentMxcRuntimeHost()): string {
  const uid = posixUid(host);
  const root = mxcRuntimeRootPath(host);
  const home = posixPath.resolve(host.aveHome);
  let canonicalHome = home;
  try {
    canonicalHome = realpathSync.native(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse("The Ave home could not be resolved", error);
  }
  // macOS volumes fold case by default; folding refuses more, never less.
  const fold = (path: string): string => host.platform === "darwin" ? path.toLowerCase() : path;
  if ([home, canonicalHome].map(fold).some((path) => atOrUnder(fold(root), path) || atOrUnder(path, fold(root)))) {
    refuse("Container runtime root overlaps the Ave home");
  }
  const appDirectory = posixPath.dirname(root);
  let entry: Stats;
  try {
    mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    entry = lstatSync(appDirectory);
  } catch (error) {
    return refuse("The app's cache directory could not be created", error);
  }
  // Created just now through a link, or held by another account: the planned path is no longer where the root would be.
  if (!entry.isDirectory() || entry.uid !== uid || realpathSync.native(appDirectory) !== appDirectory) {
    refuse("The app's cache directory is a link, not a directory, or not this account's");
  }
  return ensurePrivateDirectory(root, uid, "Container runtime root");
}

/**
 * Where holder staging directories are created, per platform. This is the only place that decides it.
 *
 * - macOS, Linux: `<runtime root>/staging`, outside the Ave home.
 * - Windows: `<AVE_HOME>\mxc-staging`, unchanged. Windows honours a write grant nested under a denied directory, and its
 *   move to a runtime root (with the ACL placement that needs) is a separate change. This is that platform's current
 *   placement, not a fallback: no other platform ever resolves to it.
 */
export function mxcStagingParent(platform: NodeJS.Platform = process.platform, host?: MxcRuntimeHost): string {
  if (platform === "win32") return winPath.join(host?.aveHome ?? aveHome(), "mxc-staging");
  const current = host ?? currentMxcRuntimeHost();
  if (current.platform !== platform) refuse("Container staging is resolved on the platform it runs on");
  return ensurePrivateDirectory(posixPath.join(ensureMxcRuntimeRoot(current), "staging"), posixUid(current), "Container staging parent");
}

/** One run's directories on macOS and Linux. `root` is the run's only write grant; `home` and `temp` lie inside it. */
export interface MxcRunStaging {
  readonly root: string;
  readonly home: string;
  readonly temp: string;
  /** A directory for the run's unix sockets, created on first use. It sits outside `root` on a short path, because a
   * socket address holds about a hundred bytes. Granting it is the caller's decision. */
  socketDirectory(): string;
}

interface RunOwner { readonly pid: number; readonly start: string }

const OWNER_SUFFIX = ".owner";
const RETIRED_SUFFIX = ".retired";
const OWNER_MAX_BYTES = 256;
const RUN_ID = /^[0-9a-f]{32}$/u;
/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminator. */
const SOCKET_PATH_MAX_BYTES: Partial<Record<NodeJS.Platform, number>> = { darwin: 103, linux: 107 };

/** Run roots this process created and has not yet been told to remove. A sweep never touches them. */
const liveRuns = new Set<string>();
const sweptParents = new Set<string>();

function selfOwner(host: MxcRuntimeHost): RunOwner {
  const start = host.processStart(host.pid);
  // Without it a crash would leave a tree no later run could prove abandoned.
  if (start === null) refuse("This process's start identity is unavailable, so its container directories could not be marked as owned");
  return { pid: host.pid, start };
}

const socketDirectoryOf = (runRoot: string): string =>
  posixPath.join(posixPath.dirname(posixPath.dirname(runRoot)), "s", posixPath.basename(runRoot).slice(0, 8));

/**
 * Create one run's staging: `<runtime root>/staging/<32 hex>/{home,temp}`, each 0700. A sibling `<id>.owner` records
 * this process (pid and start identity) before the directory exists, so a crash never leaves an unmarked tree. The
 * marker sits in the staging parent, which no container is granted, so a container cannot forge or remove it.
 */
export function createMxcRunStaging(host: MxcRuntimeHost = currentMxcRuntimeHost()): MxcRunStaging {
  const uid = posixUid(host);
  const parent = mxcStagingParent(host.platform, host);
  const owner = selfOwner(host);
  if (!sweptParents.has(parent)) {
    sweptParents.add(parent);
    sweepMxcRunStaging(host);
  }
  const root = posixPath.join(parent, randomBytes(16).toString("hex"));
  const home = posixPath.join(root, "home");
  const temp = posixPath.join(root, "temp");
  assertMxcHolderStaging({ stagingParent: parent, home, temp });
  writeFileSync(`${root}${OWNER_SUFFIX}`, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  liveRuns.add(root);
  try {
    // Exclusive: an existing entry under a fresh random name is not this run's.
    for (const directory of [root, home, temp]) mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    liveRuns.delete(root);
    try { removeRunTree(root); } catch { /* the marked remainder is left for a sweep */ }
    return refuse("Container run staging could not be created", error);
  }
  let sockets: string | undefined;
  return Object.freeze({
    root, home, temp,
    socketDirectory: (): string => {
      if (sockets !== undefined) return sockets;
      if (!liveRuns.has(root)) throw new MxcProcessContractError("Container run staging was already removed");
      const directory = socketDirectoryOf(root);
      ensurePrivateDirectory(posixPath.dirname(directory), uid, "Container socket parent");
      try {
        // Exclusive: an existing entry is another run's.
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        return refuse("Container socket directory could not be created", error);
      }
      sockets = directory;
      return directory;
    },
  });
}

/** A socket path inside the run's socket directory, refused when the platform could not bind it. */
export function mxcRunSocketPath(run: MxcRunStaging, name: string, platform: NodeJS.Platform = process.platform): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(name)) throw new MxcProcessContractError("Container socket name must be one plain file name");
  const path = posixPath.join(run.socketDirectory(), name);
  const limit = SOCKET_PATH_MAX_BYTES[platform];
  if (limit === undefined) refuse(`Container sockets have no placement on ${platform}`);
  if (Buffer.byteLength(path, "utf8") > limit) {
    refuse(`Container socket path is ${Buffer.byteLength(path, "utf8")} bytes, over the ${limit}-byte limit of a socket address`);
  }
  return path;
}

/** Delete a tree without following links: a confined process may have planted one, and a recursive removal through it
 * would delete its target. A link is unlinked itself. A directory the process closed to its owner is reopened first. */
function removeTreeWithoutFollowingLinks(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  if ((entry.mode & 0o700) !== 0o700) chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeTreeWithoutFollowingLinks(posixPath.join(path, name));
  rmdirSync(path);
}

function removeIfPresent(path: string): void {
  try {
    removeTreeWithoutFollowingLinks(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Retire, then delete, one run's tree, its socket directory and, last, its owner marker. The rename comes first so
 * nothing reaches the tree by its granted name mid-removal; the marker goes last so an interrupted removal stays
 * provably this owner's for a later sweep. */
function removeRunTree(root: string): void {
  const retired = `${root}${RETIRED_SUFFIX}`;
  try {
    renameSync(root, retired);
  } catch (error) {
    // Already retired by an interrupted removal, or never created.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    removeIfPresent(root);
  }
  removeIfPresent(retired);
  removeIfPresent(socketDirectoryOf(root));
  try {
    unlinkSync(`${root}${OWNER_SUFFIX}`);
  } catch (error) {
    // Already removed by an earlier, interrupted pass.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Remove a run's directories. Call it only after the container's exit is confirmed, or for a start that never reached
 * creation. It accepts only a run this process created and has not removed; anything else is a contract violation.
 * A partial failure warns and leaves the marked remainder for a later sweep.
 */
export function removeMxcRunStaging(run: MxcRunStaging): void {
  if (!liveRuns.delete(run.root)) throw new MxcProcessContractError("Container run staging is not a live run of this process");
  try {
    removeRunTree(run.root);
  } catch (error) {
    log.warn(`container run staging removal incomplete: ${(error as Error).message}`);
  }
}

function readOwner(markerPath: string, uid: number): RunOwner | null {
  try {
    const entry = lstatSync(markerPath);
    if (!entry.isFile() || entry.uid !== uid || entry.nlink !== 1 || entry.size > OWNER_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, start } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string" || start === "") return null;
    return { pid, start };
  } catch {
    return null;
  }
}

/** Whether the process that wrote a marker is provably gone. Anything undetermined counts as still running. */
function ownerIsGone(owner: RunOwner, host: MxcRuntimeHost): boolean {
  if (!host.processExists(owner.pid)) return true;
  const start = host.processStart(owner.pid);
  // A different start identity under the same pid is another process: the owner exited and its pid was reused.
  return start !== null && start !== owner.start;
}

/**
 * Remove what crashed or interrupted runs left under this account's and this Ave home's staging parent. A tree is
 * removed only when its sibling marker is a plain file of this account naming a process that is provably gone, or
 * naming this process for a run it already released. Entries with no marker, an unreadable marker, a live or
 * undetermined owner, or another account's ownership are kept: nothing unproven to be this owner's is deleted.
 * Failure only warns; a leftover never blocks a start.
 */
export function sweepMxcRunStaging(host: MxcRuntimeHost = currentMxcRuntimeHost()): void {
  const uid = posixUid(host);
  const parent = mxcStagingParent(host.platform, host);
  let self: RunOwner | null = null;
  try { self = selfOwner(host); } catch { /* without it, this process's own released runs are kept too */ }
  let names: string[];
  try {
    names = readdirSync(parent).filter((name) => name.endsWith(OWNER_SUFFIX) && RUN_ID.test(name.slice(0, -OWNER_SUFFIX.length)));
  } catch (error) {
    log.warn(`container run staging sweep skipped: ${(error as Error).message}`);
    return;
  }
  for (const name of names) {
    const root = posixPath.join(parent, name.slice(0, -OWNER_SUFFIX.length));
    if (liveRuns.has(root)) continue;
    const owner = readOwner(`${root}${OWNER_SUFFIX}`, uid);
    if (owner === null) continue;
    const own = self !== null && owner.pid === self.pid && owner.start === self.start;
    if (!own && !ownerIsGone(owner, host)) continue;
    try {
      for (const tree of [root, `${root}${RETIRED_SUFFIX}`]) {
        const entry = lstatSync(tree, { throwIfNoEntry: false });
        if (entry !== undefined && !(entry.isDirectory() && entry.uid === uid)) throw new Error("the marked entry is not this account's directory");
      }
      removeRunTree(root);
    } catch (error) {
      log.warn(`abandoned container run staging not removed: ${(error as Error).message}`);
    }
  }
}
