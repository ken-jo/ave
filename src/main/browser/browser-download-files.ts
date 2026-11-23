import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, type BigIntStats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { replaceStagedFile } from "../../lib/atomic-file.js";
import { createLogger } from "../../lib/logger.js";
import { renameFile, renameFileOnce } from "../../lib/transient-fs-lock-retry.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { forceKillManagedChildProcess, spawnManaged } from "../managed-child-processes.js";
import { windowsPathKindHelperIn } from "../windows-path-kind-launcher.js";

const log = createLogger("browser-download-files");

/** A directory a file operation acts in: its canonical path and the identity it was verified to have. */
export interface HeldDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Where an operation is, with its directories held: `ready` before it changes anything, `copied` before a copy's commit rename. */
type HeldStep = "ready" | "copied";

/** Asked at each step while the directories are held; false stops the operation there, removing anything it made. */
type Proceed = (step: HeldStep) => boolean;

/**
 * What refused an operation before it acted: `from` or `to` is not the verified directory (gone, unreadable, a link, or another
 * directory now at its path), the `source` entry is not an ordinary file, or the `target` name holds something other than an ordinary file.
 */
export type HeldRefusal = "from" | "to" | "source" | "target";

export class HeldDirectoryRefusedError extends Error {
  constructor(readonly refusal: HeldRefusal) {
    super(`a file operation in a held directory was refused: ${refusal}`);
  }
}

/**
 * The native helper that performs these operations on macOS and Windows is not where the install puts it, does not start, or does not keep
 * to its protocol: it crashed, ended with a status or a line it never gives, or stopped answering and was killed.
 */
export class HeldFileHelperUnavailableError extends Error {
  /**
   * The last step the helper was let past (`ready` before it acts, `copied` before a copy's commit) when it ended without a trustworthy
   * outcome, or null: after a step it may have changed files, and the operation's disposition is unknown.
   */
  passed: "ready" | "copied" | null = null;
  /** For a copy that ended after `ready` without its outcome: what removing its temporary file through the newly held chosen folder found. */
  partialCopy: "removed" | "absent" | "left" | null = null;
  /** For such a copy: the identity its temporary file had while the helper wrote it, or null when it was never seen. */
  partFile: FileIdentity | null = null;
  /** For such a copy whose temporary file was left: where it can still be found, or null. */
  partLeftAt: LeftPart | null = null;
  constructor(readonly helper: string, readonly why = "it is missing", message?: string) {
    super(message ?? `the download file helper ${helper} cannot be used: ${why}. Reinstall Ave; in a development checkout, build it (${HELPER_BUILD[process.platform] ?? "no build for this platform"}).`);
  }
}

/** What became of a failed copy's temporary file, and where one that was left can still be found. */
export interface StoppedCopy { readonly partialCopy: "removed" | "absent" | "left"; readonly partLeftAt: LeftPart | null }
const stoppedCopies = new WeakMap<Error, StoppedCopy>();

/** For the error a copy failed with after it may have written its temporary file: what became of that file, or null. */
export function stoppedCopyOf(error: unknown): StoppedCopy | null {
  if (error instanceof HeldFileHelperUnavailableError) {
    return error.partialCopy === null ? null : { partialCopy: error.partialCopy, partLeftAt: error.partLeftAt };
  }
  return error instanceof Error ? stoppedCopies.get(error) ?? null : null;
}

function markStoppedCopy(error: unknown, result: OwnFileResult): void {
  const stopped: StoppedCopy = { partialCopy: result.outcome, partLeftAt: result.outcome === "left" ? result.at : null };
  if (error instanceof HeldFileHelperUnavailableError) {
    error.partialCopy = stopped.partialCopy;
    error.partLeftAt = stopped.partLeftAt;
  } else if (error instanceof Error) {
    stoppedCopies.set(error, stopped);
  }
}

/** The helper stopped answering, or did not end once stopped, within the stall bound, and was killed. */
export class HeldFileHelperStalledError extends HeldFileHelperUnavailableError {
  /** When `stillRunning`: settles once the helper is seen to end after its run was given up. */
  exited: Promise<void> | null = null;
  constructor(helper: string, why: string, readonly stillRunning: boolean) {
    super(helper, why, `the download file helper ${helper} ${why}; it was killed${stillRunning ? ", and has not been seen to end" : ""}`);
  }
}

/** A file's identity: a file put at its name since (even one moved over it) has another. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

/** A file's content: its size, its last change, and digests of its first and last 64 KiB. */
interface Fingerprint {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly head: string;
  readonly tail: string;
}

/**
 * How a temporary file is known: by its file id, or by its content in a folder without hard links (FAT, exFAT), where a rename gives the
 * file another id.
 */
export type PartIdentity = { readonly kind: "fileId"; readonly file: FileIdentity } | { readonly kind: "fingerprint"; readonly content: Fingerprint };

/** A temporary file a cleanup left: the name it has now in its folder, and how it is known there. */
export interface LeftPart { readonly name: string; readonly identity: PartIdentity }

/** What a cleanup did. A file it left can still be found at `at`, or is null when what it found there is not the file that was written. */
export type OwnFileResult = { readonly outcome: "removed" | "absent" } | { readonly outcome: "left"; readonly at: LeftPart | null };

/** The hidden name a temporary file is moved to before it is checked and removed. */
export const MOVED_ASIDE_NAME = /^\.[0-9a-f]{32}\.removing$/u;
const FINGERPRINT_SPAN = 64 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// What is at a name, against what is expected there. `unheld`: the folder is no longer the held one (moved, replaced or unmounted);
// `unreadable`: what is there could not be read.
type Found = "same" | "absent" | "other" | "unheld" | "unreadable";

function compareFile(folder: HeldDirectory, name: string, expected: FileIdentity): Found {
  let info: BigIntStats | null;
  try {
    info = entryIn(folder, name);
  } catch (error) {
    return error instanceof HeldDirectoryRefusedError ? "unheld" : "unreadable";
  }
  if (info === null) return "absent";
  return info.isFile() && sameFile(info, expected) ? "same" : "other";
}

function sameFile(info: FileIdentity, expected: FileIdentity): boolean {
  return info.dev === expected.dev && info.ino === expected.ino && info.birthtimeNs === expected.birthtimeNs;
}

function sameContent(found: Fingerprint, expected: Fingerprint): boolean {
  return found.size === expected.size && found.mtimeNs === expected.mtimeNs && found.head === expected.head && found.tail === expected.tail;
}

// The ordinary file at `name` in `folder`, read through one open descriptor: its identity and its content.
function contentAt(folder: HeldDirectory, name: string): Exclude<Found, "same"> | { readonly file: FileIdentity; readonly content: Fingerprint } {
  try {
    heldFolder(folder);
  } catch {
    return "unheld";
  }
  let fd: number;
  try {
    fd = openSync(join(folder.path, name), constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    return codeOf(error) === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile()) return "other";
    const digest = (position: number, length: number): string => {
      const buffer = Buffer.alloc(length);
      for (let done = 0; done < length;) {
        const read = readSync(fd, buffer, done, length - done, position + done);
        if (read === 0) break;
        done += read;
      }
      return createHash("sha256").update(buffer).digest("hex");
    };
    const size = Number(info.size);
    const span = Math.min(size, FINGERPRINT_SPAN);
    return {
      file: { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs },
      content: { size: info.size, mtimeNs: info.mtimeNs, head: digest(0, span), tail: digest(size - span, span) },
    };
  } catch {
    return "unreadable";
  } finally {
    closeSync(fd);
  }
}

// Whether a volume keeps a file's id across a rename and can link a file back, probed once per volume in this process by linking the
// file at `name` to a fresh hidden name and checking it there. A failed probe is read as no hard links: the content check still holds.
const linkSupport = new Map<bigint, boolean>();
function linksIn(folder: HeldDirectory, name: string): boolean {
  const known = linkSupport.get(folder.dev);
  if (known !== undefined) return known;
  const path = join(folder.path, name);
  const probe = join(folder.path, `.${randomBytes(16).toString("hex")}.probe`);
  let supported = false;
  try {
    linkSync(path, probe);
    try {
      const linked = lstatSync(probe, { bigint: true });
      supported = linked.nlink >= 2n && sameFile(linked, lstatSync(path, { bigint: true }));
    } finally {
      try {
        unlinkSync(probe);
      } catch (error) {
        log.warn({ path, alsoAt: probe, code: codeOf(error) }, "a temporary download file is also left under a hard-link probe's name");
      }
    }
  } catch {
    supported = false;
  }
  linkSupport.set(folder.dev, supported);
  return supported;
}

/** Forget every volume's probed hard-link support. */
export function _forgetLinkSupportForTest(): void {
  linkSupport.clear();
}

/**
 * Remove a temporary file, now at `at` in `folder` and first written as `original`, only while it is the file `identity` names, never a
 * file put at either name. It is moved to a fresh hidden name in the same folder, checked there, and only then removed under that name by
 * `remove`, so a file put at its name meanwhile is not touched. A file that turns out not to be that file, or that `remove` does not
 * remove, goes back to `original` if that is still free, or stays at the hidden name; the result says where a file that may be the
 * temporary file is left, so it can be tried again. Every step that cannot be done is logged with its own reason. Never throws.
 */
export async function removeOwnFile(
  folder: HeldDirectory, original: string, at: string, identity: PartIdentity,
  remove: (folder: HeldDirectory, name: string) => Promise<"removed" | "absent" | "cancelled">,
): Promise<OwnFileResult> {
  const path = join(folder.path, at);
  if (identity.kind === "fingerprint") return removeByContent(folder, original, at, identity.content, remove);
  const found = compareFile(folder, at, identity.file);
  if (found !== "same") return notMoved(found, path, { name: at, identity });
  if (linksIn(folder, at)) return removeByFileId(folder, original, at, identity, remove);
  // No hard links: a rename may give the file another id, so it is known by its content from here on.
  const now = contentAt(folder, at);
  if (typeof now === "string") return notMoved(now, path, { name: at, identity });
  if (!sameFile(now.file, identity.file)) return notMoved("other", path, { name: at, identity });
  return removeByContent(folder, original, at, now.content, remove);
}

// A file not moved aside, because of what was found at its name.
function notMoved(found: Exclude<Found, "same">, path: string, keep: LeftPart): OwnFileResult {
  if (found === "absent") return { outcome: "absent" };
  if (found === "other") {
    log.warn({ path }, "a temporary download file is left: what is at its name is not the file that was written");
    return { outcome: "left", at: null };
  }
  if (found === "unheld") log.warn({ path }, "a temporary download file is left: its folder is no longer the chosen one (moved, replaced or unmounted)");
  else log.warn({ path }, "a temporary download file is left: what is at its name could not be read");
  return { outcome: "left", at: keep };
}

async function moveAside(folder: HeldDirectory, at: string, keep: LeftPart): Promise<string | OwnFileResult> {
  const hidden = `.${randomBytes(16).toString("hex")}.removing`;
  const path = join(folder.path, at);
  try {
    // A brief lock by another program is waited out: the file is checked again after the move, so the wait ages no judgment.
    await renameFile(path, join(folder.path, hidden));
  } catch (error) {
    log.warn({ path, code: codeOf(error) }, "a temporary download file is left: it could not be moved aside to be checked");
    return { outcome: "left", at: keep };
  }
  return hidden;
}

async function removeMoved(folder: HeldDirectory, hidden: string, remove: (folder: HeldDirectory, name: string) => Promise<"removed" | "absent" | "cancelled">): Promise<"removed" | "absent" | string> {
  try {
    const removed = await remove(folder, hidden);
    return removed === "cancelled" ? "its removal was cancelled" : removed;
  } catch (error) {
    return `it could not be removed: ${(error as Error).message}`;
  }
}

// A folder whose renames keep file ids: the file is checked by id at the hidden name, and put back by a hard link, which never replaces.
async function removeByFileId(
  folder: HeldDirectory, original: string, at: string, identity: Extract<PartIdentity, { kind: "fileId" }>,
  remove: (folder: HeldDirectory, name: string) => Promise<"removed" | "absent" | "cancelled">,
): Promise<OwnFileResult> {
  const hidden = await moveAside(folder, at, { name: at, identity });
  if (typeof hidden !== "string") return hidden;
  const hiddenPath = join(folder.path, hidden);
  const path = join(folder.path, original);
  const moved = compareFile(folder, hidden, identity.file);
  if (moved === "absent") return { outcome: "absent" };
  if (moved === "same") {
    const removed = await removeMoved(folder, hidden, remove);
    if (removed === "removed" || removed === "absent") return { outcome: removed };
    return { outcome: "left", at: { name: linkBack(hiddenPath, path, removed) ? original : hidden, identity } };
  }
  const why = moved === "other" ? "it is not the file that was written" : moved === "unheld" ? "its folder is no longer the chosen one" : "it could not be read";
  const back = linkBack(hiddenPath, path, why);
  if (moved === "other") return { outcome: "left", at: back ? null : { name: hidden, identity } };
  return { outcome: "left", at: { name: back ? original : hidden, identity } };
}

// Link a file moved aside back to its own name unless something is at that name now; true once it is there. Logs where it is left.
function linkBack(hiddenPath: string, path: string, why: string): boolean {
  try {
    linkSync(hiddenPath, path);
  } catch (error) {
    log.warn({ path, movedTo: hiddenPath, why, code: codeOf(error) }, "a temporary download file is left under another name, and could not be put back");
    return false;
  }
  try {
    unlinkSync(hiddenPath);
  } catch (error) {
    log.warn({ path, alsoAt: hiddenPath, why, code: codeOf(error) }, "a temporary download file is left, put back, but also still under another name");
    return true;
  }
  log.warn({ path, why }, "a temporary download file is left, put back at its name");
  return true;
}

// A folder without hard links: the file is checked by content at the hidden name, read through a new descriptor, and put back by a rename
// only while nothing is at its name. Between that check and the rename a file put there could be replaced; only such folders take that.
async function removeByContent(
  folder: HeldDirectory, original: string, at: string, content: Fingerprint,
  remove: (folder: HeldDirectory, name: string) => Promise<"removed" | "absent" | "cancelled">,
): Promise<OwnFileResult> {
  const identity: PartIdentity = { kind: "fingerprint", content };
  let hidden = at;
  if (!MOVED_ASIDE_NAME.test(at)) {
    const moved = await moveAside(folder, at, { name: at, identity });
    if (typeof moved !== "string") return moved;
    hidden = moved;
  }
  const hiddenPath = join(folder.path, hidden);
  const path = join(folder.path, original);
  const there = contentAt(folder, hidden);
  if (there === "absent") return { outcome: "absent" };
  if (typeof there !== "string" && sameContent(there.content, content)) {
    const removed = await removeMoved(folder, hidden, remove);
    if (removed === "removed" || removed === "absent") return { outcome: removed };
    return { outcome: "left", at: { name: await renameBack(hiddenPath, path, removed) ? original : hidden, identity } };
  }
  const why = typeof there !== "string" || there === "other" ? "it is not the file that was written"
    : there === "unheld" ? "its folder is no longer the chosen one" : "it could not be read";
  const back = await renameBack(hiddenPath, path, why);
  if (typeof there !== "string" || there === "other") return { outcome: "left", at: back ? null : { name: hidden, identity } };
  return { outcome: "left", at: { name: back ? original : hidden, identity } };
}

// Rename a file moved aside back to its own name only while nothing is at that name; true once it is there. Logs where it is left.
async function renameBack(hiddenPath: string, path: string, why: string): Promise<boolean> {
  try {
    lstatSync(path);
    log.warn({ path, movedTo: hiddenPath, why }, "a temporary download file is left under another name: something is at its own name");
    return false;
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      log.warn({ path, movedTo: hiddenPath, why, code: codeOf(error) }, "a temporary download file is left under another name: its own name could not be checked");
      return false;
    }
  }
  try {
    await renameFileOnce(hiddenPath, path);
  } catch (error) {
    log.warn({ path, movedTo: hiddenPath, why, code: codeOf(error) }, "a temporary download file is left under another name, and could not be put back");
    return false;
  }
  log.warn({ path, why }, "a temporary download file is left, put back at its name");
  return true;
}

// The identity of the ordinary file `name` in `folder` while `folder` is still the held one, or null.
function identityOf(folder: HeldDirectory, name: string): FileIdentity | null {
  try {
    const info = entryIn(folder, name);
    return info?.isFile() ? { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs } : null;
  } catch {
    return null;
  }
}

// Throws a refusal unless `folder` is still the held one; one that cannot be checked (unmounted, say) is not.
function heldFolder(folder: HeldDirectory): void {
  let held: BigIntStats;
  try {
    held = lstatSync(folder.path, { bigint: true });
  } catch {
    throw new HeldDirectoryRefusedError("to");
  }
  if (!held.isDirectory() || held.isSymbolicLink() || held.dev !== folder.dev || held.ino !== folder.ino) throw new HeldDirectoryRefusedError("to");
}

// The entry `name` in `folder`, or null when there is none; throws a refusal when `folder` is no longer the held one, and the error when
// the entry cannot be read.
function entryIn(folder: HeldDirectory, name: string): BigIntStats | null {
  heldFolder(folder);
  try {
    return lstatSync(join(folder.path, name), { bigint: true });
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * File operations that act inside held directories. Each one opens its directories, checks each is the plain directory with the given
 * identity, and names every file relative to that open directory, so a directory moved or replaced by a link after the check changes
 * nothing it does. Linux reaches files through the open descriptor's /proc/self/fd entry; macOS and Windows have no such path, so a
 * native helper holds the directories and performs the whole operation (native/macos-dir-ops, native/windows-path-kind dir-ops.h).
 */
export interface HeldFileOperations {
  /**
   * Rename `name` in `from` to `target` in `to`, replacing an ordinary file there; `cross-volume` when nothing moved because they are on
   * different volumes. `stop` aborting before the rename is let go ends it `cancelled`.
   */
  move(from: HeldDirectory, name: string, to: HeldDirectory, target: string, proceed: Proceed, stop: AbortSignal): Promise<"committed" | "cancelled" | "cross-volume">;
  /**
   * Copy `name` from `from` into the exclusive new file `part` in `to`, then rename it to `target`. The rename is the commit point: before it,
   * a stop (`proceed` answering false, or `stop` aborting while bytes are copied) removes `part` and reports `cancelled`.
   */
  copy(from: HeldDirectory, name: string, to: HeldDirectory, target: string, part: string, proceed: Proceed, stop: AbortSignal): Promise<"committed" | "cancelled">;
  /** Remove `name`, a file or a link, from `directory`; `stop` aborting before the removal is let go ends it `cancelled`. */
  remove(directory: HeldDirectory, name: string, proceed: Proceed, stop: AbortSignal): Promise<"removed" | "absent" | "cancelled">;
  /** Remove every file and link directly in `directory`, and nothing else; await it before anything is staged. */
  sweep(directory: HeldDirectory): Promise<number>;
}

const HELPER_BUILD: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "node scripts/build-macos-dir-ops.mjs",
  win32: "scripts/build-windows-job.ps1 -Helper path-kind",
};

/** The held-directory operations for this platform; `resourcePath` is the host resources folder the native helper ships in. */
export function heldFileOperations(resourcePath: string, platform: NodeJS.Platform = process.platform): HeldFileOperations {
  if (platform === "linux") return descriptorFileOperations();
  if (platform !== "darwin" && platform !== "win32") throw new Error(`held directory file operations are not available on ${platform}`);
  const helper = platform === "win32" ? windowsPathKindHelperIn(resourcePath) : join(resourcePath, "macos-dir-ops", process.arch, "ave-dir-ops");
  if (!existsSync(helper)) throw new HeldFileHelperUnavailableError(helper);
  return helperFileOperations(helper);
}

// The answers a directory check can get when the directory is missing, unreadable, not a directory, or a link: it cannot be verified.
const UNVERIFIABLE = new Set(["ELOOP", "ENOENT", "EACCES", "ENOTDIR", "EPERM"]);

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Linux: every name goes through the held descriptor's /proc/self/fd entry, which the kernel resolves to the open directory itself.

const COPY_CHUNK = 1024 * 1024;

function holdDescriptor(directory: HeldDirectory, refusal: "from" | "to"): number {
  let fd: number;
  try {
    fd = openSync(directory.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (UNVERIFIABLE.has(codeOf(error) ?? "")) throw new HeldDirectoryRefusedError(refusal);
    throw error;
  }
  const info = fstatSync(fd, { bigint: true });
  if (!info.isDirectory() || info.dev !== directory.dev || info.ino !== directory.ino) {
    closeSync(fd);
    throw new HeldDirectoryRefusedError(refusal);
  }
  return fd;
}

// Hold `directory` (and `also`, refused as `to`) for the length of `use`; every descriptor is closed afterwards.
async function holding<T>(directory: HeldDirectory, also: HeldDirectory | null, use: (fd: number, alsoFd: number) => Promise<T> | T): Promise<T> {
  const fd = holdDescriptor(directory, "from");
  try {
    const alsoFd = also === null ? -1 : holdDescriptor(also, "to");
    try {
      return await use(fd, alsoFd);
    } finally {
      if (alsoFd >= 0) closeSync(alsoFd);
    }
  } finally {
    closeSync(fd);
  }
}

function holdingSync<T>(directory: HeldDirectory, use: (fd: number) => T): T {
  const fd = holdDescriptor(directory, "from");
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

const inHeld = (fd: number, name: string): string => `/proc/self/fd/${fd}/${name}`;

// The chosen name may hold nothing yet, or an ordinary file the user agreed to replace; never a link or anything else.
function assertReplaceable(path: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new HeldDirectoryRefusedError("target");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
}

function assertOrdinarySource(path: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new HeldDirectoryRefusedError("source");
  } catch (error) {
    if (codeOf(error) === "ENOENT") throw new HeldDirectoryRefusedError("source");
    throw error;
  }
}

// Write all of `length` bytes from `buffer`, however many each write takes; a write that makes no progress is a failure.
async function writeFully(target: FileHandle, buffer: Buffer, length: number): Promise<void> {
  for (let offset = 0; offset < length;) {
    const { bytesWritten } = await target.write(buffer, offset, length - offset);
    if (bytesWritten <= 0) throw Object.assign(new Error("the copy of a browser download stopped making progress"), { code: "EIO" });
    offset += bytesWritten;
  }
}

// A stopped copy's temporary file, removed from the held folder; one that cannot be removed is reported left on the error that says so.
function removeStoppedPart(path: string, part: string): void {
  try {
    removeIfPresent(path);
  } catch (error) {
    log.warn({ part, code: codeOf(error) }, "a stopped download copy's temporary file is left: it could not be removed");
    markStoppedCopy(error, { outcome: "left", at: null });
    throw error;
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

function descriptorFileOperations(): HeldFileOperations {
  return {
    move: (from, name, to, target, proceed, stop) => holding(from, to, (fromFd, toFd) => {
      if (stop.aborted || !proceed("ready")) return "cancelled";
      assertOrdinarySource(inHeld(fromFd, name));
      assertReplaceable(inHeld(toFd, target));
      try {
        replaceStagedFile(inHeld(fromFd, name), inHeld(toFd, target));
      } catch (error) {
        if (codeOf(error) === "EXDEV") return "cross-volume";
        throw error;
      }
      return "committed";
    }),
    copy: (from, name, to, target, part, proceed, stop) => holding(from, to, async (fromFd, toFd) => {
      let source: FileHandle;
      try {
        source = await open(inHeld(fromFd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (codeOf(error) === "ENOENT" || codeOf(error) === "ELOOP") throw new HeldDirectoryRefusedError("source");
        throw error;
      }
      let created = false;
      try {
        const sourceInfo = await source.stat();
        if (!sourceInfo.isFile()) throw new HeldDirectoryRefusedError("source");
        if (!proceed("ready")) return "cancelled";
        assertReplaceable(inHeld(toFd, target));
        // The temporary file is created exclusively, never through a link, in the held folder.
        const copy = await open(inHeld(toFd, part), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, sourceInfo.mode & 0o777);
        created = true;
        try {
          const buffer = Buffer.alloc(COPY_CHUNK);
          for (let position = 0; ;) {
            if (stop.aborted) return "cancelled";
            const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            await writeFully(copy, buffer, bytesRead);
            position += bytesRead;
          }
          await copy.sync();
        } finally {
          await copy.close();
        }
        if (!proceed("copied")) return "cancelled";
        assertReplaceable(inHeld(toFd, target));
        replaceStagedFile(inHeld(toFd, part), inHeld(toFd, target));
        created = false;
        return "committed";
      } finally {
        await source.close();
        // A copy that did not reach its commit leaves nothing behind, and is removed only from the held folder.
        if (created) removeStoppedPart(inHeld(toFd, part), part);
      }
    }),
    remove: (directory, name, proceed, stop) => holding(directory, null, (fd) => {
      if (stop.aborted || !proceed("ready")) return "cancelled";
      try {
        unlinkSync(inHeld(fd, name));
      } catch (error) {
        if (codeOf(error) === "ENOENT") return "absent";
        throw error;
      }
      return "removed";
    }),
    sweep: async (directory) => holdingSync(directory, (fd) => {
      let removed = 0;
      for (const entry of readdirSync(inHeld(fd, "."), { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        unlinkSync(inHeld(fd, entry.name));
        removed += 1;
      }
      return removed;
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// macOS and Windows: the native helper holds the directories for the whole operation (protocol: native/macos-dir-ops/README.md).

// Exit statuses the helper ends with; anything else means the helper itself is broken.
const EXIT_DONE = 0;
const EXIT_REFUSED = 3;
const EXIT_FAILED = 4;
const REFUSALS: ReadonlySet<string> = new Set<HeldRefusal>(["from", "to", "source", "target"]);
const PROGRESS = /^progress (\d+)$/u;
const FAILURE_DIAGNOSTIC = /^Windows error \d+(?: \(NTSTATUS 0x[0-9A-F]{8}, (?:NtCreateFile|NtSetInformationFile)\))?\r?\n$/u;

/** How long a helper may say nothing (`stallMs`), and how long its exit may take to be seen once it is killed (`killMs`). */
interface HelperBounds { readonly stallMs: number; readonly killMs: number }
const POLICY_BOUNDS: HelperBounds = {
  stallMs: TOOL_TIMEOUT_POLICY.browserDownloadHelperStallMs,
  // The same bound as every other owned process tree's termination on this platform.
  killMs: process.platform === "win32" ? TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs : TOOL_TIMEOUT_POLICY.processTreeKillMs,
};
// A stop that nothing aborts: cleanup steps that run to their end, within the stall bound.
const UNSTOPPED = new AbortController().signal;

function directoryArguments(directory: HeldDirectory): string[] {
  return [directory.path, directory.dev.toString(), directory.ino.toString()];
}

// Turn the helper's last line and exit status into the operation's outcome, or the error it ended with. A refusal and a filesystem failure
// the helper reports are answers about the operation; any other ending, an unknown status or line among them, means the helper is broken.
function helperOutcome(helper: string, status: number | null, signal: NodeJS.Signals | null, last: string, stderr: string): string | Error {
  if (status === EXIT_DONE && /^(?:committed|cancelled|cross-volume|removed|absent|swept \d+)$/u.test(last)) return last;
  const refused = /^refused (\w+)$/u.exec(last);
  const refusal = refused?.[1];
  if (status === EXIT_REFUSED && refusal !== undefined && REFUSALS.has(refusal)) {
    return new HeldDirectoryRefusedError(refusal as HeldRefusal);
  }
  const failed = /^failed (E[A-Z0-9_]+)$/u.exec(last);
  if (status === EXIT_FAILED && failed !== null) {
    return Object.assign(new Error(`the download file helper failed (${failed[1]})`), { code: failed[1] });
  }
  const why = signal !== null ? `signal ${signal}` : `exit ${status ?? "unknown"}`;
  return new HeldFileHelperUnavailableError(helper, `it ended unexpectedly (${why}, ${JSON.stringify(last)}${stderr.trim() ? `: ${stderr.trim()}` : ""})`);
}

// The status a helper that printed `last` and then exited would have ended with: a kill that lands after the outcome line does not change it.
function statusOf(last: string): number {
  if (last.startsWith("refused ")) return EXIT_REFUSED;
  if (last.startsWith("failed ")) return EXIT_FAILED;
  return EXIT_DONE;
}

/**
 * Run one mode in protocol order. Only an authorized step or advancing copy progress renews liveness. A stop or outcome fixes the exit
 * deadline; any stdout byte after the outcome invalidates the run. A failure may carry its one native diagnostic on stderr, whose
 * delivery order is independent of stdout. Killing and confirming exit share one independent `killMs` ceiling, including
 * when the platform's kill request does not finish. A valid outcome before a confirmed kill is retained only if the protocol stayed valid.
 */
function runHelper(helper: string, args: readonly string[], proceed: Proceed, stop: AbortSignal, bounds: HelperBounds, onProgress?: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnManaged(helper, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: {} }, { label: "browser-download-files" });
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) throw new Error("the download file helper was started without pipes");
    let pending = "";
    let outcome: string | null = null;
    let phase: "holding" | "copying" | "acting" | "copied" = "holding";
    let copiedBytes = 0n;
    let protocolFailure: string | null = null;
    const mode = args[0];
    let errors = "";
    let inputOpen = true;
    let thrown: unknown;
    let passed: HeldStep | null = null;
    let stopping = false;
    let killed: string | null = null;
    let settled = false;
    let startFailure: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    let lateExit: Promise<void> | null = null;
    const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const endInput = (): void => {
      if (!inputOpen) return;
      inputOpen = false;
      stdin.end();
    };
    const fail = (error: HeldFileHelperUnavailableError): void => {
      // An unavailable run has no trustworthy disposition, even if it printed an outcome before violating the protocol.
      error.passed = passed;
      reject(error);
    };
    const settle = (status: number | null, signal: NodeJS.Signals | null, stillRunning: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop.removeEventListener("abort", onStop);
      const last = outcome ?? "";
      if (thrown !== undefined) {
        reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
        return;
      }
      if (startFailure !== null) {
        fail(new HeldFileHelperUnavailableError(helper, startFailure));
        return;
      }
      // Match the entire diagnostic stream, including its final newline: extra lines or partial diagnostics are not an answer.
      if (errors !== "" && (!last.startsWith("failed ") || FAILURE_DIAGNOSTIC.exec(errors)?.[0] !== errors)) {
        protocolFailure ??= "it wrote an invalid failure diagnostic";
      }
      if (protocolFailure !== null && !stillRunning) {
        fail(new HeldFileHelperUnavailableError(helper, protocolFailure));
        return;
      }
      if (killed !== null) {
        if (!stillRunning && outcome !== null && pending === "") {
          const answered = helperOutcome(helper, statusOf(outcome), null, outcome, errors);
          if (answered instanceof HeldFileHelperUnavailableError) fail(answered);
          else if (answered instanceof Error) reject(answered);
          else resolve(answered);
          return;
        }
        const stalled = new HeldFileHelperStalledError(helper, killed, stillRunning);
        stalled.exited = lateExit;
        fail(stalled);
        return;
      }
      const answered = pending === "" ? helperOutcome(helper, status, signal, last, errors)
        : new HeldFileHelperUnavailableError(helper, "it ended with an incomplete protocol line");
      if (answered instanceof HeldFileHelperUnavailableError) fail(answered);
      else if (answered instanceof Error) reject(answered);
      else resolve(answered);
    };
    // Kill the helper and wait for its exit; only an exit seen ends the run as stopped.
    const kill = (why: string): void => {
      if (killed !== null || settled) return;
      killed = why;
      clearTimeout(timer);
      endInput();
      // Start confirmation before requesting termination: a pending platform kill cannot defer this ceiling.
      timer = setTimeout(() => {
        if (exited()) settle(child.exitCode, child.signalCode, false);
        else {
          log.error({ helper, pid: child.pid ?? null }, "the download file helper did not end when killed");
          lateExit = new Promise((resolve) => {
            child.once("exit", () => { log.warn({ helper }, "the download file helper ended after its run was given up"); resolve(); });
          });
          settle(null, null, true);
        }
      }, bounds.killMs);
      try {
        void Promise.resolve(forceKillManagedChildProcess(child, "browser download file helper stalled")).catch((error: unknown) => {
          log.warn({ error: String(error) }, "the download file helper could not be killed");
        });
      } catch (error) {
        log.warn({ error: (error as Error).message }, "the download file helper could not be killed");
      }
    };
    const awaitLine = (phase: string): void => {
      if (stopping || killed !== null) return;
      clearTimeout(timer);
      timer = setTimeout(() => kill(`said nothing for ${bounds.stallMs} ms ${phase}`), bounds.stallMs);
    };
    // Once stopped, the deadline to end is fixed: progress the helper still writes does not extend it.
    const beginStopping = (): void => {
      endInput();
      if (stopping || killed !== null || outcome !== null) return;
      stopping = true;
      clearTimeout(timer);
      timer = setTimeout(() => kill(`did not end within ${bounds.stallMs} ms of being stopped`), bounds.stallMs);
    };
    // A helper that has already ended (refused, or failed) closes its input; its exit status is the outcome, not this write error.
    stdin.on("error", () => { inputOpen = false; });
    const onStop = (): void => beginStopping();
    stop.addEventListener("abort", onStop, { once: true });
    const violate = (): void => {
      protocolFailure ??= "it wrote output outside its mode or phase";
      kill(protocolFailure);
    };
    const isOutcome = (line: string): boolean => {
      if (/^refused (from|to|source|target)$/u.test(line) || /^failed E[A-Z0-9_]+$/u.test(line)) return true;
      if (line === "cancelled") return phase !== "holding" && stopping;
      if (mode === "--dir-copy") return line === "committed" && passed === "copied";
      if (passed !== "ready") return false;
      if (mode === "--dir-rename") return line === "committed" || line === "cross-volume";
      if (mode === "--dir-remove") return line === "removed" || line === "absent";
      const swept = /^swept (\d+)$/u.exec(line);
      return mode === "--dir-sweep" && swept !== null && Number.isSafeInteger(Number(swept[1]));
    };
    stdout.on("data", (chunk: Buffer) => {
      if (settled || chunk.length === 0) return;
      if (outcome !== null) { violate(); return; }
      if (killed !== null) return;
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        const progress = PROGRESS.exec(line)?.[1];
        if (progress !== undefined) {
          const bytes = BigInt(progress);
          if (mode !== "--dir-copy" || phase !== "copying" || passed !== "ready" || bytes <= copiedBytes) { violate(); return; }
          copiedBytes = bytes;
          onProgress?.();
          awaitLine("while copying");
          continue;
        }
        if (line !== "ready" && line !== "copied") {
          if (!isOutcome(line)) { violate(); return; }
          awaitLine("after its outcome");
          outcome = line;
          endInput();
          if (pending !== "" || errors !== "" && !line.startsWith("failed ")) violate();
          return;
        }
        if (line === "ready" ? phase !== "holding" : mode !== "--dir-copy" || phase !== "copying" || passed !== "ready") { violate(); return; }
        phase = line === "copied" ? "copied" : mode === "--dir-copy" ? "copying" : "acting";
        let go = false;
        try {
          go = inputOpen && !stopping && !stop.aborted && proceed(line as HeldStep);
        } catch (error) {
          thrown = error;
        }
        if (go) {
          passed = line as HeldStep;
          stdin.write("c");
          awaitLine(`after ${line}`);
        } else {
          beginStopping();
        }
      }
    });
    stderr.on("data", (chunk: Buffer) => {
      if (settled || chunk.length === 0) return;
      if (killed !== null && outcome === null) return;
      errors += chunk.toString("utf8");
      if (outcome !== null && !outcome.startsWith("failed ")) violate();
    });
    // The helper did not start (it cannot be executed); a helper that started reports through its exit status instead.
    child.once("error", (error) => {
      if (child.pid !== undefined) return;
      startFailure = error.message;
      settle(null, null, false);
    });
    child.once("close", (status, signal) => settle(status, signal, false));
    if (stop.aborted) beginStopping();
    else awaitLine("while holding its folders");
  });
}

function oneOf<T extends string>(helper: string, outcome: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(outcome)) return outcome as T;
  throw new HeldFileHelperUnavailableError(helper, `it answered ${JSON.stringify(outcome)}, not one of ${allowed.join(", ")}`);
}

/**
 * The helper operations through a given build of the helper and, optionally, shorter bounds: tests run its fault-injecting builds
 * (scripts/build-macos-dir-ops.mjs) and stand-ins for a helper that hangs.
 */
export function _helperFileOperationsForTest(helper: string, bounds?: HelperBounds): HeldFileOperations {
  return helperFileOperations(helper, bounds);
}

function helperFileOperations(helper: string, bounds: HelperBounds = POLICY_BOUNDS): HeldFileOperations {
  const run = (args: readonly string[], proceed: Proceed, stop: AbortSignal, onProgress?: () => void): Promise<string> =>
    runHelper(helper, args, proceed, stop, bounds, onProgress);
  const removeNamed = async (folder: HeldDirectory, name: string): Promise<"removed" | "absent"> =>
    oneOf(helper, await run(["--dir-remove", ...directoryArguments(folder), name], () => true, UNSTOPPED), ["removed", "absent"] as const);
  // A copy that ended after it may have written its temporary file, with the helper seen to end: the file is removed through the chosen
  // folder, held anew, only while it is the file the copy wrote. One never seen while it was written is never removed by name: when
  // something is at its name it is left, and so is whatever a folder that can no longer be checked holds, when `unknownIsLeft`.
  const removePartialCopy = async (to: HeldDirectory, part: string, partFile: FileIdentity | null, unknownIsLeft: boolean): Promise<OwnFileResult | null> => {
    if (partFile !== null) return removeOwnFile(to, part, part, { kind: "fileId", file: partFile }, removeNamed);
    let found: "absent" | "present" | "unknown" = "unknown";
    try {
      found = entryIn(to, part) === null ? "absent" : "present";
    } catch {
      // The folder cannot be told to be the held one.
    }
    if (found === "absent") return { outcome: "absent" };
    if (found === "unknown" && !unknownIsLeft) return null;
    log.warn({ path: join(to.path, part) }, "a stopped download copy's temporary file is left: it was never seen while the copy wrote it");
    return { outcome: "left", at: null };
  };
  return {
    move: async (from, name, to, target, proceed, stop) => oneOf(helper,
      await run(["--dir-rename", ...directoryArguments(from), name, ...directoryArguments(to), target], proceed, stop),
      ["committed", "cancelled", "cross-volume"] as const),
    copy: async (from, name, to, target, part, proceed, stop) => {
      // The temporary file's identity, taken once the helper says it is writing it, so a later cleanup removes only that file.
      let partFile: FileIdentity | null = null;
      const seen = (): void => { partFile ??= identityOf(to, part); };
      const proceedSeeing: Proceed = (step) => {
        if (step === "copied") seen();
        return proceed(step);
      };
      try {
        return oneOf(helper, await run(["--dir-copy", ...directoryArguments(from), name, ...directoryArguments(to), target, part], proceedSeeing, stop, seen),
          ["committed", "cancelled"] as const);
      } catch (error) {
        if (error instanceof HeldFileHelperUnavailableError && error.passed !== null) {
          error.partFile = partFile;
          // A helper that may still be running is not raced: its file is left for a cleanup once it ends.
          if (error instanceof HeldFileHelperStalledError && error.stillRunning) error.partialCopy = "left";
          else markStoppedCopy(error, await removePartialCopy(to, part, partFile, true) ?? { outcome: "left", at: null });
        } else if (!(error instanceof HeldFileHelperUnavailableError) && !(error instanceof HeldDirectoryRefusedError)) {
          // The helper answered that the copy failed, and has ended. A temporary file it wrote and did not remove is cleaned the same way.
          const result = await removePartialCopy(to, part, partFile, false);
          if (result !== null) markStoppedCopy(error, result);
        }
        throw error;
      }
    },
    remove: async (directory, name, proceed, stop) => oneOf(helper,
      await run(["--dir-remove", ...directoryArguments(directory), name], proceed, stop),
      ["removed", "absent", "cancelled"] as const),
    sweep: async (directory) => Number((await run(["--dir-sweep", ...directoryArguments(directory)], () => true, UNSTOPPED)).slice("swept ".length)),
  };
}
