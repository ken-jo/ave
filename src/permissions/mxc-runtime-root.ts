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

/** Under the test runner the root lives in the run's own directory, never in the account's cache. */
function currentCacheHome(): string {
  return AVE_HOME_ISOLATION_GUARD_ACTIVE
    ? posixPath.join(process.env.AVE_TEST_SANDBOX_BASE ?? tmpdir(), "mxc-cache")
    : mxcCacheHome(process.platform, process.env, homedir());
}

export function currentMxcRuntimeHost(): MxcRuntimeHost {
  const platform = process.platform;
  return {
    platform,
    cacheHome: currentCacheHome(),
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

/** `path` with its deepest existing ancestor resolved, so the result is canonical wherever it can be. Throws what the
 * filesystem raised for anything but an absent entry. */
function canonicalWhereItExists(path: string): string {
  const missing: string[] = [];
  for (let current = path; ; current = posixPath.dirname(current)) {
    try {
      return posixPath.join(realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || posixPath.dirname(current) === current) throw error;
      missing.unshift(posixPath.basename(current));
    }
  }
}

const rootUnder = (cacheHome: string): string => posixPath.join(cacheHome, AVE_APP_ID, "mxc-runtime");

/**
 * The path the sandbox read floor denies (`appOwnedSandboxPrivateRoots`): the runtime root, `<cache home>/<app id>/
 * mxc-runtime`, whether or not it exists. The run directories are Ave-private data, as they were under the Ave home,
 * so every confined process that is not granted its own run directory is denied the whole root. It never throws: the
 * floor of every sandboxed process is composed from it, and a cache directory that cannot be resolved must refuse
 * container starts only. With the cache directory resolved the path is canonical, as the macOS sandbox matches real
 * paths; otherwise it is the path as spelled, and a deny on a path nothing can be created under costs nothing.
 */
export function mxcRuntimeRootFloorPath(cacheHome: string = currentCacheHome()): string {
  try {
    return rootUnder(canonicalWhereItExists(cacheHome));
  } catch {
    return rootUnder(cacheHome);
  }
}

/** The runtime root's planned path, with the cache directory resolved. The app's directory and the root's own name
 * are never resolved: a link at either is refused when the root is established, not followed. */
function plannedRuntimeRoot(host: MxcRuntimeHost): string {
  posixUid(host);
  if (!posixPath.isAbsolute(host.cacheHome)) refuse("The account's cache directory is not an absolute path");
  try {
    return rootUnder(canonicalWhereItExists(host.cacheHome));
  } catch (error) {
    return refuse("The account's cache directory could not be resolved", error);
  }
}

function assertOutsideAveHome(root: string, host: MxcRuntimeHost): void {
  const home = posixPath.resolve(host.aveHome);
  let canonicalHome: string;
  try {
    // Resolved as far as it exists: a home that is not there yet is still compared through its real ancestors.
    canonicalHome = canonicalWhereItExists(home);
  } catch (error) {
    refuse("The Ave home could not be resolved", error);
  }
  // macOS volumes fold case by default; folding refuses more, never less.
  const fold = (path: string): string => host.platform === "darwin" ? path.toLowerCase() : path;
  if ([home, canonicalHome].map(fold).some((path) => atOrUnder(fold(root), path) || atOrUnder(path, fold(root)))) {
    refuse("Container runtime root overlaps the Ave home");
  }
}

/** Every directory from the cache directory up to the filesystem root must be root's or this account's, and writable
 * by no one else unless it is sticky: otherwise another account could replace a directory on the way to the root. */
function assertAncestorsHeld(cacheHome: string, uid: number): void {
  for (let current = cacheHome; ; current = posixPath.dirname(current)) {
    let entry: Stats;
    try {
      entry = lstatSync(current);
    } catch (error) {
      refuse("A directory above the container runtime root could not be inspected", error);
    }
    if (!entry.isDirectory() || (entry.uid !== 0 && entry.uid !== uid) || ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)) {
      refuse(`A directory above the container runtime root is not held by this account or the system: ${current}`);
    }
    if (posixPath.dirname(current) === current) return;
  }
}

interface EstablishedRoot { readonly root: string; readonly dev: number; readonly ino: number }

/** One entry per cache directory this process tried to establish a root under: the root, or null when it failed. */
const established = new Map<string, EstablishedRoot | null>();

function createRuntimeRoot(host: MxcRuntimeHost): EstablishedRoot {
  const uid = posixUid(host);
  const planned = plannedRuntimeRoot(host);
  // Before anything is created.
  assertOutsideAveHome(planned, host);
  let cacheHome: string;
  try {
    mkdirSync(host.cacheHome, { recursive: true, mode: 0o700 });
    cacheHome = realpathSync.native(host.cacheHome);
  } catch (error) {
    return refuse("The account's cache directory could not be created or resolved", error);
  }
  assertAncestorsHeld(cacheHome, uid);
  const appDirectory = posixPath.join(cacheHome, AVE_APP_ID);
  let entry: Stats;
  try {
    try {
      mkdirSync(appDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    entry = lstatSync(appDirectory);
  } catch (error) {
    return refuse("The app's cache directory could not be created", error);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o022) !== 0) {
    refuse("The app's cache directory is a link, not a directory, not this account's, or writable by other accounts");
  }
  const root = ensurePrivateDirectory(posixPath.join(appDirectory, "mxc-runtime"), uid, "Container runtime root");
  // The cache directory was created or replaced between planning and creation: the checked placement is not this one.
  if (root !== planned) refuse("The account's cache directory changed while the container runtime root was established");
  try {
    const identity = lstatSync(root);
    return { root, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    return refuse("Container runtime root could not be inspected", error);
  }
}

/**
 * Establish the one directory everything a container needs lives under on macOS and Linux: `<cache home>/<app id>/
 * mxc-runtime`, mode 0700, owned by this account, never a link or below one in the app's own directory, below only
 * directories held by this account or the system, and neither inside nor above the Ave home. The Ave home is a denied
 * directory, and the macOS sandbox lets a deny override every allow, so a grant nested inside it cannot work there.
 * The root itself is host-only: a container is granted its own run directory beneath it and nothing above that.
 *
 * Sandbox start-up calls this once, before the first wrap, and the outcome is kept for the life of the process. A
 * sandboxed process started while the root was absent may carry no deny for it (Linux omits a read deny for a path
 * that does not exist), so a root that was not established then is never created later: a second call returns the
 * established root or refuses again. A failure throws `MxcRuntimeRootError`, before anything is created when the
 * placement itself is refused; no caller may place staging elsewhere instead.
 */
export function establishMxcRuntimeRoot(host: MxcRuntimeHost = currentMxcRuntimeHost()): string {
  if (established.has(host.cacheHome)) return requireMxcRuntimeRoot(host);
  established.set(host.cacheHome, null);
  const root = createRuntimeRoot(host);
  established.set(host.cacheHome, root);
  return root.root;
}

/** A test stands in for a new process: it forgets what start-up recorded for one cache directory. */
export function _forgetMxcRuntimeRootForTest(cacheHome: string): void {
  established.delete(cacheHome);
}

/**
 * The runtime root a run may be created under: the one sandbox start-up established, still the same directory. It
 * creates nothing. A root that was not established at start-up, was removed or replaced since, or is no longer this
 * account's private directory refuses the run.
 */
export function requireMxcRuntimeRoot(host: MxcRuntimeHost = currentMxcRuntimeHost()): string {
  const uid = posixUid(host);
  const known = established.get(host.cacheHome);
  if (known === undefined || known === null) refuse("Container runtime root was not established when the sandbox started");
  let entry: Stats;
  try {
    entry = lstatSync(known.root);
  } catch (error) {
    return refuse("Container runtime root is no longer there", error);
  }
  if (!privateTo(entry, uid) || entry.dev !== known.dev || entry.ino !== known.ino) {
    refuse("Container runtime root is no longer the directory established when the sandbox started");
  }
  assertOutsideAveHome(known.root, host);
  return known.root;
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
  return ensurePrivateDirectory(posixPath.join(requireMxcRuntimeRoot(current), "staging"), posixUid(current), "Container staging parent");
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

/** `instance` tells two copies of this module in one process apart: each copy knows only its own live runs. */
interface RunOwner { readonly pid: number; readonly start: string; readonly instance: string }

const INSTANCE = randomBytes(8).toString("hex");

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
  return { pid: host.pid, start, instance: INSTANCE };
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
        // Exclusive: an existing entry is another run's with the same leading digits, and that run alone removes it.
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        return refuse("Container socket directory could not be created", error);
      }
      try {
        // The marker names the run the directory belongs to; only a directory so marked is ever removed with a run.
        writeFileSync(`${directory}${OWNER_SUFFIX}`, posixPath.basename(root), { flag: "wx", mode: 0o600 });
      } catch (error) {
        try { rmdirSync(directory); } catch { /* left unmarked, which nothing ever removes */ }
        return refuse("Container socket directory could not be marked as this run's", error);
      }
      sockets = directory;
      return directory;
    },
  });
}

/** A socket path inside the run's socket directory, refused when the platform could not bind it. On macOS the path
 * is `<home>/Library/Caches/<app id>/mxc-runtime/s/<8 hex>/<name>` within 103 bytes: 62 of them are fixed, so a name
 * may be as long as 41 bytes less the home directory's length (31 for `/Users/abc`, 15 for a 20-character account
 * name). A longer one is refused here, by name and byte count, before anything tries to bind it. */
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

/**
 * Delete a tree without following links: a confined process may have planted one, and a recursive removal through it
 * would delete its target. A link is unlinked itself. A directory the process closed to its owner is reopened first.
 *
 * It never descends into another filesystem: a directory whose device differs from the run directory's is a mount
 * point, and the removal stops there and keeps the tree. Each directory is also checked to be the same one after it is
 * listed. A bind mount of the same filesystem has the same device and cannot be told apart this way; a backend that
 * binds host directories must do so inside the container's own mount namespace, where this process never sees them.
 * An entry another remover already took is skipped.
 */
function removeTreeWithoutFollowingLinks(path: string, device: number): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  if (entry.dev !== device) throw new Error(`another filesystem is mounted at ${path}`);
  if ((entry.mode & 0o700) !== 0o700) chmodSync(path, 0o700);
  const names = readdirSync(path);
  const listed = lstatSync(path);
  if (!listed.isDirectory() || listed.dev !== entry.dev || listed.ino !== entry.ino) throw new Error(`${path} was replaced while it was being removed`);
  for (const name of names) {
    try {
      removeTreeWithoutFollowingLinks(posixPath.join(path, name), device);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  rmdirSync(path);
}

function removeIfPresent(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return;
  removeTreeWithoutFollowingLinks(path, entry.dev);
}

/** Remove the run's socket directory, only when its marker names this run: a directory with the same leading digits
 * that another run created is that run's. */
function removeRunSockets(root: string): void {
  const directory = socketDirectoryOf(root);
  const marker = `${directory}${OWNER_SUFFIX}`;
  const entry = lstatSync(marker, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isFile() || entry.size > OWNER_MAX_BYTES) return;
  if (readFileSync(marker, "utf8") !== posixPath.basename(root)) return;
  removeIfPresent(directory);
  unlinkSync(marker);
}

/** Retire, then delete, one run's tree, its socket directory and, last, its owner marker. The rename comes first so
 * nothing reaches the tree by its granted name mid-removal. The marker goes last, and only once neither tree is left:
 * an interrupted removal, or one that raced another remover, stays provably this owner's for a later sweep. */
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
  removeRunSockets(root);
  for (const tree of [root, retired]) {
    if (lstatSync(tree, { throwIfNoEntry: false }) !== undefined) throw new Error(`${tree} is still there`);
  }
  try {
    unlinkSync(`${root}${OWNER_SUFFIX}`);
  } catch (error) {
    // Already removed by another remover of the same tree.
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
    const { pid, start, instance } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string" || start === ""
        || typeof instance !== "string" || instance === "") return null;
    return { pid, start, instance };
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
 * Remove what crashed or interrupted runs left under the staging parent. The runtime root is per account, so every Ave
 * home and every running instance of this account shares it; a tree is another instance's until its marker proves
 * otherwise. A tree is removed only when its sibling marker is a plain file of this account naming a process that is
 * provably gone, or naming this copy of this module in this process for a run it already released. Entries with no
 * marker, an unreadable marker, a live or undetermined owner (another copy of this module in this process included),
 * or another account's ownership are kept: nothing unproven to be abandoned is deleted. An owner that is gone does not
 * prove its container is; the removal's own guards (no link followed, no other filesystem entered) hold either way.
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
    const own = self !== null && owner.pid === self.pid && owner.start === self.start && owner.instance === self.instance;
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
