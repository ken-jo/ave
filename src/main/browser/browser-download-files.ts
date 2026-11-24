import { type BigIntStats, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { getSystemErrorName } from "node:util";
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
export type HeldRefusal = "from" | "to" | "source" | "target" | "volume" | "volume-unknown";

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

/**
 * For the error a copy failed with after it may have written its temporary file: what became of that file, or null. An error that wraps
 * the copy's own (a refusal reported as a staging error) answers with the copy's.
 */
export function stoppedCopyOf(error: unknown): StoppedCopy | null {
  if (error instanceof HeldFileHelperUnavailableError) {
    return error.partialCopy === null ? null : { partialCopy: error.partialCopy, partLeftAt: error.partLeftAt };
  }
  if (!(error instanceof Error)) return null;
  return stoppedCopies.get(error) ?? (error.cause instanceof Error ? stoppedCopies.get(error.cause) ?? null : null);
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

/**
 * A file's identity: its volume, its file number and the evidence that it is still that file, so a file put at its name since (even one
 * moved over it) has another. The evidence class names what backs it: `creation` (a Windows creation time), `birth` (a birth time) or
 * `fingerprint` (`<size>:<mtime-ns>:<head>:<tail>` of the same file number). Null evidence is unresolved (a legacy record without any,
 * or a class this host does not know), and an unresolved identity matches nothing. native/windows-path-kind/README.md says what each
 * class proves.
 */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly evidence: Evidence | null;
}

type EvidenceClass = "creation" | "birth" | "fingerprint";
interface Evidence { readonly class: EvidenceClass; readonly value: string }

const EVIDENCE_VALUE: Readonly<Record<EvidenceClass, RegExp>> = {
  creation: /^[1-9][0-9]{0,19}$/u,
  birth: /^[1-9][0-9]{0,19}$/u,
  fingerprint: /^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):[0-9a-f]{64}:[0-9a-f]{64}$/u,
};

/** `<class>:<value>`, or null for unresolved evidence. */
export function evidenceText(evidence: Evidence | null): string | null {
  return evidence === null ? null : `${evidence.class}:${evidence.value}`;
}

/** Evidence from `<class>:<value>`: undefined when malformed, null when the class is not one this host knows. */
export function parseEvidence(text: string): Evidence | null | undefined {
  const match = /^([a-z]+):([^\s/]+)$/u.exec(text);
  if (match === null) return undefined;
  const [, kind = "", value = ""] = match;
  if (!Object.hasOwn(EVIDENCE_VALUE, kind)) return null;
  return EVIDENCE_VALUE[kind as EvidenceClass].test(value) ? { class: kind as EvidenceClass, value } : undefined;
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

interface PartSnapshot { readonly file: FileIdentity; readonly content: Fingerprint }

/** The writing descriptor's identity and a snapshot of the entry the helper left at its hidden name. */
export interface HelperPartIdentity {
  readonly kind: "helper";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly evidence: Evidence | null;
  readonly verdict: "mismatch" | "remove-failed";
  readonly observed: PartSnapshot | null;
}

/** A temporary file a cleanup left: the name it has now in its folder, and how it is known there. */
export interface LeftPart { readonly name: string; readonly identity: PartIdentity | HelperPartIdentity }

/** What a cleanup did. A file it left can still be tried again at `at`, or `at` is null when cleanup has no retry location. */
type OwnFileResult = { readonly outcome: "removed" | "absent" } | { readonly outcome: "left"; readonly at: LeftPart | null };

/** The hidden name a temporary file is moved to before it is checked and removed. */
export const MOVED_ASIDE_NAME = /^\.[0-9a-f]{32}\.removing$/u;
const FINGERPRINT_SPAN = 64 * 1024;
const RECORD_NAME = /^[0-9a-f]{32}\.cleanup\.json$/u;
const RECORDS_LINE = /^records(?: [0-9a-f]{32}\.cleanup\.json)*$/u;
const RECORD_LINE = /^record (?:[0-9a-f]{2})*$/u;
const MAX_RECORD_BYTES = 8192;
const MAX_HELPER_LINE_BYTES = 1024 * 1024;

interface DownloadTargetJournal {
  readonly hidden: string;
  write(file: FileIdentity, writer: FileIdentity): Promise<void>;
  /** The committed file as it is at the target after the commit rename, recorded before the record is resolved. */
  published(file: FileIdentity): Promise<void>;
  resolved(): void;
  left?(at: LeftPart): void;
}

interface RecordSweep {
  reject(bytes: Buffer, stamp: RecordStamp): boolean;
  removed(): void;
}

export interface RecordStamp {
  readonly file: FileIdentity;
  readonly length: number;
  readonly digest: string;
}

function recordStamp(file: FileIdentity, bytes: Buffer): RecordStamp {
  return { file, length: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * File operations that act inside held directories. Each one opens its directories, checks each is the plain directory with the given
 * identity, and names every file relative to that open directory, so a directory moved or replaced by a link after the check changes
 * nothing it does. Linux reaches files through the open descriptor's /proc/self/fd entry; macOS and Windows have no such path, so a
 * native helper holds the directories and performs the whole operation (native/macos-dir-ops, native/windows-path-kind dir-ops.h).
 */
export interface HeldFileOperations {
  /**
   * Rename `name` in `from` to `target` in `to` while `name` is still the `staged` file; `cross-volume` when nothing moved because they
   * are on different volumes, `replace` when `target` is taken. `stop` aborting before the rename is let go ends it `cancelled`.
   */
  move(from: HeldDirectory, name: string, to: HeldDirectory, target: string, proceed: Proceed, stop: AbortSignal,
    staged: FileIdentity): Promise<"committed" | "cancelled" | "cross-volume" | "replace">;
  /**
   * Copy `name` from `from` into the exclusive new file `part` in `to`, then rename it to `target`. The rename is the commit point: before it,
   * a stop (`proceed` answering false, or `stop` aborting while bytes are copied) removes `part` and reports `cancelled`.
   */
  copy(from: HeldDirectory, name: string, to: HeldDirectory, target: string, part: string, proceed: Proceed, stop: AbortSignal,
    journal?: DownloadTargetJournal): Promise<"committed" | "cancelled">;
  /**
   * Remove `name`, a file or a link, from `directory` while it is still the `staged` file; another file there is refused as `source`.
   * `stop` aborting before the removal is let go ends it `cancelled`.
   */
  remove(directory: HeldDirectory, name: string, proceed: Proceed, stop: AbortSignal, staged: FileIdentity): Promise<"removed" | "absent" | "cancelled">;
  /** The identity of the file `name` in `directory`, or null when nothing is there; anything but a file is refused as `source`. */
  stamp(directory: HeldDirectory, name: string): Promise<FileIdentity | null>;
  /** Remove files and links directly in `directory`. The boot sweep preserves records for held recovery. */
  sweep(directory: HeldDirectory, keepRecords?: boolean): Promise<number>;
  listRecords(directory: HeldDirectory): Promise<string[]>;
  readRecord(directory: HeldDirectory, name: string, max: number, sweep?: RecordSweep): Promise<Buffer | null>;
  writeRecord(directory: HeldDirectory, name: string, body: Buffer): Promise<RecordStamp>;
  removeRecord(directory: HeldDirectory, name: string, stamp: RecordStamp): Promise<boolean>;
  recover(directory: HeldDirectory, name: string, original: string, identity: PartIdentity | HelperPartIdentity): Promise<OwnFileResult | { outcome: "restored" }>;
  recoverTarget(directory: HeldDirectory, hidden: string, target: string, file: FileIdentity, content?: Fingerprint,
    replacement?: TargetReplacement): Promise<"resolved" | "left">;
}

/**
 * What took the target's place: the writer as published (a full match); `renamed`, the writer as it was before its commit rename, known
 * by its file ID and volume alone, since that rename may have changed its creation time; or `retire` when the target is known committed.
 */
type TargetReplacement = FileIdentity | { readonly renamed: FileIdentity } | "retire";

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
  return helperFileOperations(helper, platform === "win32");
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
const requireNative = createRequire(import.meta.url);
const RENAME_NOREPLACE = 1;
// Linux's O_PATH holds the directory entry itself, including a symlink with O_NOFOLLOW.
const LINUX_O_PATH = 0o10000000;
let linuxRename: ((fromDirectory: number, from: string, toDirectory: number, to: string) => void) | undefined;

type Observed = FileIdentity | BigIntStats;

// A Linux file is backed by its birth time where the filesystem keeps one; without it the file is unresolved.
function identityOf(file: Observed): FileIdentity {
  if ("evidence" in file) return file;
  return { dev: file.dev, ino: file.ino, evidence: file.birthtimeNs > 0n ? { class: "birth", value: String(file.birthtimeNs) } : null };
}

// Exact match only: the same volume and number, and evidence of the same class with the same value on both sides.
function sameFile(found: Observed, expected: Observed): boolean {
  const actual = identityOf(found);
  const wanted = identityOf(expected);
  return actual.dev === wanted.dev && actual.ino === wanted.ino && actual.evidence !== null && wanted.evidence !== null &&
    actual.evidence.class === wanted.evidence.class && actual.evidence.value === wanted.evidence.value;
}

function fingerprintKey(content: Fingerprint): string {
  return `${content.size}:${content.mtimeNs}:${content.head}:${content.tail}`;
}

// Same-volume moves check the final entry type. Copies hold any existing target through exclusive isolation and commit.
function assertReplaceable(fd: number, name: string): void {
  try {
    if (!lstatSync(inHeld(fd, name)).isFile()) throw new HeldDirectoryRefusedError("target");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
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

function finishStoppedCopy(result: OwnFileResult, failure: { readonly error: unknown } | null): void {
  if (failure !== null) {
    markStoppedCopy(failure.error, result);
    return;
  }
  if (result.outcome !== "left") return;
  const left = new Error("a stopped download copy's temporary file is left in the chosen folder");
  markStoppedCopy(left, result);
  throw left;
}

export function _descriptorFileOperationsForTest(beforeRename: (from: string, to: string) => void): HeldFileOperations {
  return descriptorFileOperations(beforeRename);
}

type EntryMutation =
  | { readonly mode: "rename-away" | "restore"; readonly directory: number; readonly name: string }
  | { readonly mode: "remove" | "retire-hidden" | "record-remove" | "record-sweep"; readonly content?: Fingerprint; readonly symlink?: boolean }
  | { readonly mode: "record-write"; readonly body: Buffer };

function descriptorFileOperations(beforeRename?: (from: string, to: string) => void): HeldFileOperations {
  function entryMatches(directory: number, name: string, expected: Observed, symlink = false): boolean {
    try {
      const info = lstatSync(inHeld(directory, name), { bigint: true });
      return (symlink ? info.isSymbolicLink() : info.isFile()) && sameFile(info, expected);
    } catch {
      return false;
    }
  }

  function entryAbsent(directory: number, name: string): boolean {
    return lstatSync(inHeld(directory, name), { throwIfNoEntry: false }) === undefined;
  }

  function fingerprintOf(fd: number): Fingerprint | null {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const size = Number(info.size);
    const span = Math.min(size, FINGERPRINT_SPAN);
    const digest = (position: number): string => {
      const buffer = Buffer.alloc(span);
      for (let offset = 0; offset < span;) {
        const count = readSync(fd, buffer, offset, span - offset, position + offset);
        if (count === 0) throw new Error("the download file ended during verification");
        offset += count;
      }
      return createHash("sha256").update(buffer).digest("hex");
    };
    const head = digest(0);
    const tail = digest(size - span);
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) return null;
    return { size: info.size, mtimeNs: info.mtimeNs, head, tail };
  }

  function verifyFingerprint(fd: number, expected: Fingerprint): boolean {
    const actual = fingerprintOf(fd);
    return actual !== null && fingerprintKey(actual) === fingerprintKey(expected);
  }

  function boundOpen(fd: number, name: string): number | null {
    try {
      return openSync(inHeld(fd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
  }

  function mutateEntry(directory: number, name: string, expected: Observed | null, mutation: EntryMutation,
    reading?: number): OwnFileResult | { outcome: "renamed" } | { outcome: "written"; stamp: RecordStamp } {
    const renameExclusive = (fromDirectory: number, from: string, toDirectory: number, to: string): void => {
      if (linuxRename === undefined) {
        const ffi = requireNative("koffi") as typeof import("koffi");
        const renameAt2 = ffi.load(null).func("int renameat2(int, const char *, int, const char *, unsigned int)");
        linuxRename = (sourceDirectory, source, targetDirectory, target) => {
          if (renameAt2(sourceDirectory, source, targetDirectory, target, RENAME_NOREPLACE) === 0) return;
          throw Object.assign(new Error("the exclusive download rename failed"), { code: getSystemErrorName(-ffi.errno()) });
        };
      }
      linuxRename(fromDirectory, from, toDirectory, to);
    };
    if (mutation.mode === "record-write") {
      const record = openSync(inHeld(directory, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let created: BigIntStats;
      try {
        writeFileSync(record, mutation.body);
        fsyncSync(record);
        const stamp = fstatSync(record, { bigint: true });
        const readback = fingerprintOf(record);
        if (!stamp.birthtimeNs || readback?.size !== BigInt(mutation.body.length) ||
            readback.head !== createHash("sha256").update(mutation.body).digest("hex")) {
          throw new Error("the download cleanup record could not be verified");
        }
        created = stamp;
      } finally {
        closeSync(record);
      }
      fsyncSync(directory);
      if (!entryMatches(directory, name, created)) throw new Error("the download cleanup record changed after writing");
      return { outcome: "written", stamp: recordStamp(identityOf(created), mutation.body) };
    }
    const renaming = mutation.mode === "rename-away" || mutation.mode === "restore";
    const removing = !renaming;
    const symlink = "symlink" in mutation && mutation.symlink === true;
    const content = "content" in mutation ? mutation.content : undefined;
    const at: LeftPart | null = expected === null ? null : { name, identity: { kind: "fileId", file: identityOf(expected) } };
    if (expected === null || identityOf(expected).evidence === null) {
      if (reading !== undefined) closeSync(reading);
      return { outcome: "left", at };
    }
    const destination = renaming ? mutation.directory : directory;
    const isolated = mutation.mode === "retire-hidden";
    const target = renaming ? mutation.name : isolated ? name : `.${randomBytes(16).toString("hex")}.removing`;
    let fd: number;
    try {
      fd = reading ?? openSync(inHeld(directory, name),
        content === undefined ? LINUX_O_PATH | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return { outcome: "absent" };
      throw error;
    }
    let moved = false;
    let verified = false;
    try {
      const held = fstatSync(fd, { bigint: true });
      if (!sameFile(held, expected) || !entryMatches(directory, name, expected, symlink) ||
          (content !== undefined && !verifyFingerprint(fd, content))) return { outcome: "left", at };
      if (!isolated) {
        beforeRename?.(name, target);
        renameExclusive(directory, name, destination, target);
        moved = true;
      }
      const found = lstatSync(inHeld(destination, target), { bigint: true, throwIfNoEntry: false });
      verified = found !== undefined && (symlink ? found.isSymbolicLink() : found.isFile()) && sameFile(found, expected) &&
        (content === undefined || verifyFingerprint(fd, content));
      if (!verified) {
        if (moved && found !== undefined && identityOf(found).evidence !== null && (found.isFile() || found.isSymbolicLink())) {
          const rollback = openSync(inHeld(destination, target), LINUX_O_PATH | constants.O_NOFOLLOW);
          try {
            const heldRollback = fstatSync(rollback, { bigint: true });
            beforeRename?.(target, name);
            if (sameFile(heldRollback, found) && entryMatches(destination, target, found, found.isSymbolicLink())) {
              renameExclusive(destination, target, directory, name);
              moved = !entryMatches(directory, name, found, found.isSymbolicLink());
            }
          } finally {
            closeSync(rollback);
          }
        }
      } else if (removing) {
        unlinkSync(inHeld(destination, target));
      }
    } catch (error) {
      if (renaming && !moved) throw error;
    } finally {
      closeSync(fd);
    }
    if (verified && renaming && entryMatches(destination, target, expected, symlink)) return { outcome: "renamed" };
    if (verified && removing && entryAbsent(destination, target) &&
        (isolated || entryAbsent(directory, name))) return { outcome: "removed" };
    if (!moved) return { outcome: "left", at };
    const observed = boundSnapshot(destination, target);
    return { outcome: "left", at: { name: target, identity: {
      kind: "helper", dev: expected.dev, ino: expected.ino, evidence: identityOf(expected).evidence, verdict: verified ? "remove-failed" : "mismatch", observed,
    } } };
  }

  function retireBound(directory: number, name: string, expected: Observed, content?: Fingerprint, symlink = false): OwnFileResult {
    const result = mutateEntry(directory, name, expected, { mode: "remove", content, symlink });
    if (result.outcome === "renamed" || result.outcome === "written") throw new Error("the download removal returned an unexpected outcome");
    return result;
  }

  function boundSnapshot(directory: number, name: string): PartSnapshot | null {
    try {
      const fd = boundOpen(directory, name);
      if (fd === null) return null;
      try {
        const file = fstatSync(fd, { bigint: true });
        const content = fingerprintOf(fd);
        return content !== null && entryMatches(directory, name, file) ? { file: identityOf(file), content } : null;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  function recoverBound(directory: number, name: string, original: string, identity: PartIdentity | HelperPartIdentity): OwnFileResult | { outcome: "restored" } {
    const left: OwnFileResult = { outcome: "left", at: { name, identity } };
    if (identity.kind === "fingerprint") return left;
    const observed = identity.kind === "helper" ? identity.observed : null;
    const expected = identity.kind === "fileId" ? identity.file : observed?.file;
    const content = observed?.content;
    const restore = identity.kind === "helper" && identity.verdict === "mismatch";
    if (!expected?.evidence || (identity.kind === "helper" && (observed === null || (!restore && !sameFile(observed.file, identity))))) return left;
    try {
      const fd = boundOpen(directory, name);
      if (fd === null) return { outcome: "absent" };
      try {
        const info = fstatSync(fd, { bigint: true });
        if (!info.isFile() || (expected !== undefined && !sameFile(info, expected)) ||
            (content !== undefined && !verifyFingerprint(fd, content))) return left;
        if (restore) {
          const target = openSync(inHeld(directory, original), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, Number(info.mode) & 0o777);
          try {
            const buffer = Buffer.alloc(COPY_CHUNK);
            for (;;) {
              const count = readSync(fd, buffer, 0, buffer.length, null);
              if (count === 0) break;
              for (let offset = 0; offset < count;) {
                const written = writeSync(target, buffer, offset, count - offset);
                if (written === 0) return left;
                offset += written;
              }
            }
            fsyncSync(target);
            if (!entryMatches(directory, original, fstatSync(target, { bigint: true }))) return left;
          } finally {
            closeSync(target);
          }
        }
        const result = retireBound(directory, name, expected, content);
        if (restore && result.outcome !== "left") return { outcome: "restored" };
        if (result.outcome === "left" && result.at?.name === name) return left;
        return result;
      } finally {
        closeSync(fd);
      }
    } catch {
      return left;
    }
  }

  function recoverTarget(directory: number, hidden: string, target: string, file: FileIdentity, content?: Fingerprint,
    replaced?: TargetReplacement): "resolved" | "left" {
    // A rename here keeps the file's creation time, so the writer before its commit rename is matched in full.
    const replacement = typeof replaced === "object" && "renamed" in replaced ? replaced.renamed : replaced;
    if (file.evidence === null || (typeof replacement === "object" && replacement.evidence === null)) return "left";
    try {
      const openEntry = (name: string): number | null => {
        if (content !== undefined) return boundOpen(directory, name);
        try {
          return openSync(inHeld(directory, name), LINUX_O_PATH | constants.O_NOFOLLOW);
        } catch (error) {
          if (codeOf(error) === "ENOENT") return null;
          throw error;
        }
      };
      const targetFd = replacement === "retire" ? null : openEntry(target);
      try {
        const current = targetFd === null ? null : fstatSync(targetFd, { bigint: true });
        const targetMatches = (identity: FileIdentity): boolean =>
          current?.isFile() === true && sameFile(current, identity) && entryMatches(directory, target, current);
        const committed = replacement === "retire" || (replacement !== undefined && targetMatches(replacement));
        const fd = openEntry(hidden);
        if (fd === null) {
          return committed || (targetMatches(file) &&
            (content === undefined || (targetFd !== null && verifyFingerprint(targetFd, content)))) ? "resolved" : "left";
        }
        try {
          const info = fstatSync(fd, { bigint: true });
          if (!info.isFile() || !sameFile(info, file) || (content !== undefined && !verifyFingerprint(fd, content)) ||
              !entryMatches(directory, hidden, info)) return "left";
          if (committed) return mutateEntry(directory, hidden, file, { mode: "retire-hidden", content }).outcome === "removed" ? "resolved" : "left";
          if (targetFd !== null) return "left";
          return mutateEntry(directory, hidden, file, { mode: "restore", directory, name: target }).outcome === "renamed" ? "resolved" : "left";
        } finally {
          closeSync(fd);
        }
      } finally {
        if (targetFd !== null) closeSync(targetFd);
      }
    } catch {
      return "left";
    }
    return "left";
  }

  function purgeStaged(fd: number, name: string, staged?: FileIdentity): "absent" | "removed" {
    let entry: number;
    try {
      entry = openSync(inHeld(fd, name), LINUX_O_PATH | constants.O_NOFOLLOW);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return "absent";
      throw error;
    }
    try {
      const identity = fstatSync(entry, { bigint: true });
      if (!identity.isFile() && !identity.isSymbolicLink()) throw new Error("the staged download entry is not a file or link");
      if (staged !== undefined && !sameFile(identity, staged)) throw new HeldDirectoryRefusedError("source");
      const removed = retireBound(fd, name, staged ?? identity, undefined, identity.isSymbolicLink());
      if (removed.outcome === "left") throw new Error("the staged download entry could not be removed");
      return removed.outcome;
    } finally {
      closeSync(entry);
    }
  }

  return {
    move: (from, name, to, target, proceed, stop, staged) => holding(from, to, (fromFd, toFd) => {
      if (stop.aborted || !proceed("ready")) return "cancelled";
      const source = lstatSync(inHeld(fromFd, name), { bigint: true, throwIfNoEntry: false });
      if (!source?.isFile() || !sameFile(source, staged)) throw new HeldDirectoryRefusedError("source");
      assertReplaceable(toFd, target);
      if (!entryAbsent(toFd, target)) return "replace";
      try {
        if (mutateEntry(fromFd, name, staged, { mode: "rename-away", directory: toFd, name: target }).outcome !== "renamed") {
          throw new HeldDirectoryRefusedError("source");
        }
      } catch (error) {
        if (codeOf(error) === "EXDEV") return "cross-volume";
        if (codeOf(error) === "EEXIST") throw new HeldDirectoryRefusedError("target");
        throw error;
      }
      return "committed";
    }),
    copy: (from, name, to, target, part, proceed, stop, journal) => holding(from, to, async (fromFd, toFd) => {
      let source: FileHandle;
      try {
        source = await open(inHeld(fromFd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (codeOf(error) === "ENOENT" || codeOf(error) === "ELOOP") throw new HeldDirectoryRefusedError("source");
        throw error;
      }
      let copy: FileHandle | null = null;
      let oldFd: number | null = null;
      let committed = false;
      // The temporary file as the copy created it, taken through its own handle.
      let written: FileIdentity | null = null;
      let failure: { readonly error: unknown } | null = null;
      try {
        const sourceInfo = await source.stat();
        if (!sourceInfo.isFile()) throw new HeldDirectoryRefusedError("source");
        try {
          oldFd = openSync(inHeld(toFd, target), LINUX_O_PATH | constants.O_NOFOLLOW);
        } catch (error) {
          if (codeOf(error) !== "ENOENT") throw error;
        }
        const old = oldFd === null ? null : fstatSync(oldFd, { bigint: true });
        if (old !== null && (!old.isFile() || old.dev !== to.dev)) throw new HeldDirectoryRefusedError("target");
        if (!proceed("ready")) return "cancelled";
        // The temporary file is created exclusively, never through a link, in the held folder.
        copy = await open(inHeld(toFd, part), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, sourceInfo.mode & 0o777);
        const info = await copy.stat({ bigint: true });
        if (info.dev !== to.dev || old?.ino === info.ino) throw new HeldDirectoryRefusedError("target");
        written = identityOf(info);
        const buffer = Buffer.alloc(COPY_CHUNK);
        for (let position = 0; ;) {
          if (stop.aborted) return "cancelled";
          const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          await writeFully(copy, buffer, bytesRead);
          position += bytesRead;
        }
        await copy.sync();
        if (!proceed("copied") || stop.aborted) return "cancelled";
        const current = await copy.stat({ bigint: true });
        if (current.dev !== to.dev || old?.ino === current.ino || current.birthtimeNs === 0n) throw new HeldDirectoryRefusedError("target");
        written = identityOf(current);
        if (old !== null) {
          if (old.birthtimeNs === 0n || journal === undefined || !MOVED_ASIDE_NAME.test(journal.hidden)) throw new HeldDirectoryRefusedError("target");
          await journal.write(identityOf(old), written);
          if (stop.aborted) return "cancelled";
        }
        if (!entryMatches(toFd, part, current)) throw new HeldDirectoryRefusedError("target");
        const aside = journal?.hidden;
        const reportTarget = (name: string, expected: Observed, verdict: HelperPartIdentity["verdict"]): void => {
          if (journal?.left === undefined) return;
          const snapshot = boundSnapshot(toFd, name);
          journal.left({ name, identity: {
            kind: "helper", dev: expected.dev, ino: expected.ino, evidence: identityOf(expected).evidence, verdict,
            observed: snapshot !== null && sameFile(snapshot.file, expected) ? snapshot : null,
          } });
        };
        if (old !== null && aside !== undefined) {
          if (mutateEntry(toFd, target, old, { mode: "rename-away", directory: toFd, name: aside }).outcome !== "renamed") {
            reportTarget(aside, old, "mismatch");
            throw new HeldDirectoryRefusedError("target");
          }
        }
        try {
          if (mutateEntry(toFd, part, current, { mode: "rename-away", directory: toFd, name: target }).outcome !== "renamed") {
            throw new HeldDirectoryRefusedError("target");
          }
        } catch (error) {
          if (old !== null && aside !== undefined) {
            try {
              if (mutateEntry(toFd, aside, old, { mode: "restore", directory: toFd, name: target }).outcome !== "renamed") {
                throw new HeldDirectoryRefusedError("target");
              }
              journal?.resolved();
            } catch {
              reportTarget(aside, old, "mismatch");
            }
          }
          if (["EEXIST", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes(codeOf(error) ?? "")) throw new HeldDirectoryRefusedError("target");
          throw error;
        }
        committed = true;
        if (old !== null) {
          try {
            await journal?.published(identityOf(await copy.stat({ bigint: true })));
          } catch (error) {
            // The record still names the writer, which recovery matches in full here: a rename keeps its birth time.
            log.warn({ error: String(error) }, "the published download could not be recorded");
          }
        }
        if (old !== null && aside !== undefined) {
          try {
            if (mutateEntry(toFd, aside, old, { mode: "retire-hidden" }).outcome === "removed") journal?.resolved();
            else reportTarget(aside, old, "remove-failed");
          } catch {
            reportTarget(aside, old, "remove-failed");
          }
        }
        return "committed";
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        try {
          if (copy !== null && !committed) {
            const result: OwnFileResult = written === null ? { outcome: "left", at: null }
              : retireBound(toFd, part, written);
            finishStoppedCopy(result, failure);
          }
        } finally {
          try {
            await copy?.close();
          } finally {
            try {
              if (oldFd !== null) closeSync(oldFd);
            } finally {
              await source.close();
            }
          }
        }
      }
    }),
    remove: (directory, name, proceed, stop, staged) => holding(directory, null, (fd) => {
      if (stop.aborted || !proceed("ready")) return "cancelled";
      if (RECORD_NAME.test(name)) throw new Error("cleanup records require a verified stamp");
      return purgeStaged(fd, name, staged);
    }),
    stamp: async (directory, name) => holdingSync(directory, (fd) => {
      const info = lstatSync(inHeld(fd, name), { bigint: true, throwIfNoEntry: false });
      if (info === undefined) return null;
      if (!info.isFile()) throw new HeldDirectoryRefusedError("source");
      return identityOf(info);
    }),
    recover: async (directory, name, original, identity) => {
      try {
        return await holding(directory, null, (fd) => recoverBound(fd, name, original, identity));
      } catch (error) {
        log.warn({ path: join(directory.path, original), leftAs: name, error: (error as Error).message }, "the stopped download folder could not be held");
        return { outcome: "left", at: { name, identity } };
      }
    },
    recoverTarget: async (directory, hidden, target, file, content, replacement) =>
      holdingSync(directory, (fd) => recoverTarget(fd, hidden, target, file, content, replacement)),
    listRecords: async (directory) => holdingSync(directory, (fd) => readdirSync(inHeld(fd, ".")).filter((name) => RECORD_NAME.test(name))),
    readRecord: async (directory, name, max, sweep) => holdingSync(directory, (fd) => {
      let record = boundOpen(fd, name);
      if (record === null) return null;
      try {
        const info = fstatSync(record, { bigint: true });
        if (!info.isFile()) return null;
        if (max < 1 || max > MAX_RECORD_BYTES || info.size > BigInt(max)) throw new Error("the download cleanup record exceeds its limit");
        const bytes = Buffer.alloc(max + 1);
        let used = 0;
        while (used < bytes.length) {
          const count = readSync(record, bytes, used, bytes.length - used, used);
          if (count === 0) break;
          used += count;
        }
        if (used > max) throw new Error("the download cleanup record exceeds its limit");
        const body = bytes.subarray(0, used);
        if (sweep !== undefined) {
          const content = fingerprintOf(record);
          const stamp = recordStamp(identityOf(info), body);
          if (info.birthtimeNs === 0n || content === null || content.size !== BigInt(used) || content.head !== stamp.digest ||
              !entryMatches(fd, name, info)) return null;
          if (sweep.reject(body, stamp)) {
            const observed = record;
            record = null;
            if (mutateEntry(fd, name, info, { mode: "record-sweep", content }, observed).outcome === "removed") sweep.removed();
          }
        }
        return body;
      } finally {
        if (record !== null) closeSync(record);
      }
    }),
    writeRecord: async (directory, name, body) => holdingSync(directory, (fd) => {
      if (body.length > MAX_RECORD_BYTES) throw new Error("the download cleanup record exceeds its limit");
      const written = mutateEntry(fd, name, null, { mode: "record-write", body });
      if (written.outcome !== "written") throw new Error("the cleanup record could not be written");
      return written.stamp;
    }),
    removeRecord: async (directory, name, stamp) => holdingSync(directory, (fd) => {
      let record = boundOpen(fd, name);
      if (record === null) return false;
      try {
        const content = fingerprintOf(record);
        if (content?.size !== BigInt(stamp.length) || content.head !== stamp.digest) return false;
        const verified = record;
        record = null;
        return mutateEntry(fd, name, stamp.file, { mode: "record-remove", content }, verified).outcome === "removed";
      } finally {
        if (record !== null) closeSync(record);
      }
    }),
    sweep: async (directory) => holdingSync(directory, (fd) => {
      let removed = 0;
      for (const entry of readdirSync(inHeld(fd, "."), { withFileTypes: true })) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || RECORD_NAME.test(entry.name)) continue;
        if (purgeStaged(fd, entry.name) === "removed") removed += 1;
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
const REFUSALS: ReadonlySet<string> = new Set<HeldRefusal>(["from", "to", "source", "target", "volume", "volume-unknown"]);
const PROGRESS = /^progress (\d+)$/u;
// Every identity a frame carries is one evidence token, `<dev>:<id>:<class>:<value>`.
const TARGET_ID = /^target-id (\S+)$/u;
const DESTINATION_ID = /^destination-id (\S+)$/u;
const WRITING = /^(writing|copy-id) (\S+)$/u;
const STAMP_LINE = /^stamp (\S+)$/u;
const PUBLISHED = /^published (\S+)$/u;
const RECORD_SWEEP_FRAME = /^record (\S+) ((?:[0-9a-f]{2})*)$/u;
const RECORD_WRITTEN_FRAME = /^written (\S+)$/u;
const FAILURE_DIAGNOSTIC = /^Windows error \d+(?: \(NTSTATUS 0x[0-9A-F]{8}, (?:NtCreateFile|NtSetInformationFile)\))?\r?\n$/u;
// A stopped copy may add ` left`, or ` left <hidden name> <token> <verdict> <snapshot>` when a file stays at the moved-aside name.
const PART_LEFT = /(?:^| )left(?: (?:remove-failed|(\.[0-9a-f]{32}\.removing) ([^ ]+) (mismatch|remove-failed) ([^ ]+)( part-left)?))?$/u;
const MAX_HELPER_FILE_ID = (1n << 64n) - 1n;
interface HelperLeftPart {
  readonly name: string;
  readonly identity: HelperPartIdentity;
}
const helperLeftParts = new WeakMap<Error, NonNullable<ReturnType<typeof parsePartLeft>>>();

function parseUnsigned(text: string | undefined): bigint | null {
  if (text === undefined || !/^(0|[1-9][0-9]{0,19})$/u.test(text)) return null;
  const value = BigInt(text);
  return value <= MAX_HELPER_FILE_ID ? value : null;
}

function parseWindowsInode(text: string | undefined): bigint | null {
  return text !== undefined && /^[0-9a-f]{32}$/u.test(text) ? BigInt(`0x${text}`) : null;
}

// An evidence token; a well-formed token of a class this host does not know parses with unresolved (null) evidence.
function parseToken(text: string, parseInode: typeof parseUnsigned): FileIdentity | null {
  const match = /^([^:]*):([^:]*):(.*)$/u.exec(text);
  if (match === null) return null;
  const [, devText, inoText, evidenceText = ""] = match;
  const dev = parseUnsigned(devText);
  const ino = parseInode(inoText);
  const evidence = parseEvidence(evidenceText);
  return dev === null || ino === null || evidence === undefined ? null : { dev, ino, evidence };
}

// A token the helper vouches for: it must carry evidence this host can compare.
function parseRecordFile(text: string, parseInode: typeof parseUnsigned): FileIdentity | null {
  const file = parseToken(text, parseInode);
  return file?.evidence ? file : null;
}

function tokenText(file: FileIdentity, windowsFileIds: boolean): string | null {
  const evidence = evidenceText(file.evidence);
  return evidence === null ? null : `${file.dev}:${windowsFileIds ? file.ino.toString(16).padStart(32, "0") : file.ino}:${evidence}`;
}

// `<token>/<size>:<mtime-ns>:<head>:<tail>`.
function parseSnapshot(text: string, parseInode: typeof parseUnsigned): PartSnapshot | null {
  const [token = "", body = "", extra] = text.split("/");
  const file = parseRecordFile(token, parseInode);
  const [sizeText, mtimeText, head, tail, more] = body.split(":");
  const size = parseUnsigned(sizeText);
  const mtimeNs = parseUnsigned(mtimeText);
  if (extra !== undefined || more !== undefined || file === null || size === null || mtimeNs === null ||
      head === undefined || tail === undefined || !/^[0-9a-f]{64}$/u.test(head) || !/^[0-9a-f]{64}$/u.test(tail)) return null;
  return { file, content: { size, mtimeNs, head, tail } };
}

function parsePartLeft(line: string, parseInode: typeof parseUnsigned): { readonly answer: string; readonly at: HelperLeftPart | null; readonly partLeft: boolean } | null {
  const match = PART_LEFT.exec(line);
  if (match === null) return null;
  const answer = line.slice(0, match.index);
  const [, name, token, verdict, snapshot, partLeft] = match;
  if (name === undefined) return { answer, at: null, partLeft: true };
  const file = parseRecordFile(token ?? "", parseInode);
  if (file === null || (verdict !== "mismatch" && verdict !== "remove-failed") || snapshot === undefined) return null;
  const observed = snapshot === "-" ? null : parseSnapshot(snapshot, parseInode);
  if (snapshot !== "-" && observed === null) return null;
  return { answer, at: { name, identity: { kind: "helper", ...file, verdict, observed } }, partLeft: partLeft !== undefined };
}

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
function helperOutcome(helper: string, status: number | null, signal: NodeJS.Signals | null, last: string, stderr: string, parseInode: typeof parseUnsigned): string | Error {
  const left = parsePartLeft(last, parseInode);
  const answer = left?.answer ?? last;
  if (status === EXIT_DONE && (left === null ? /^(?:committed|cancelled|cross-volume|replace|removed|absent|restored|resolved|kept|swept \d+)$/u.test(last) || STAMP_LINE.test(last) || RECORDS_LINE.test(last) || RECORD_LINE.test(last) || RECORD_WRITTEN_FRAME.test(last) : answer === "cancelled" || answer === "")) {
    return last;
  }
  const leaving = (error: Error): Error => {
    if (left !== null) helperLeftParts.set(error, left);
    return error;
  };
  const refused = /^refused (\w+(?:-\w+)?)(?: (?:removed|changed))?$/u.exec(answer);
  const refusal = refused?.[1];
  if (status === EXIT_REFUSED && refusal !== undefined && REFUSALS.has(refusal)) {
    const error = new HeldDirectoryRefusedError(refusal as HeldRefusal);
    if (answer === "refused target removed") markStoppedCopy(error, { outcome: "removed" });
    if (answer === "refused target changed") markStoppedCopy(error, { outcome: "left", at: null });
    return leaving(error);
  }
  const failed = /^failed (E[A-Z0-9_]+)$/u.exec(answer);
  if (status === EXIT_FAILED && failed !== null) {
    return leaving(Object.assign(new Error(`the download file helper failed (${failed[1]})`), { code: failed[1] }));
  }
  const why = signal !== null ? `signal ${signal}` : `exit ${status ?? "unknown"}`;
  const diagnostic = last.startsWith("record ") ? "record [redacted]" : last;
  return new HeldFileHelperUnavailableError(helper, `it ended unexpectedly (${why}, ${JSON.stringify(diagnostic)}${stderr.trim() ? `: ${stderr.trim()}` : ""})`);
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
function runHelper(helper: string, args: readonly string[], proceed: Proceed, stop: AbortSignal, bounds: HelperBounds, parseInode: typeof parseUnsigned, onWriting?: (file: FileIdentity) => void, journal?: DownloadTargetJournal, onRecord?: (bytes: Buffer, file: FileIdentity) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnManaged(helper, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: {} }, { label: "browser-download-files" });
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) throw new Error("the download file helper was started without pipes");
    let pending = "";
    let outcome: string | null = null;
    let targetLeft: HelperLeftPart | null = null;
    let oldTarget: FileIdentity | null = null;
    let targetResolution: "restored" | "retired" | null = null;
    let phase: "holding" | "copying" | "acting" | "copied" = "holding";
    let copiedBytes = 0n;
    let writing: FileIdentity | null = null;
    let writingRefreshed = false;
    let published: FileIdentity | null = null;
    let persisting: Promise<void> | null = null;
    let recordDecision: boolean | null = null;
    let protocolFailure: string | null = null;
    const mode = args[0];
    const needsDestinationStamp = mode === "--dir-copy" && parseInode === parseWindowsInode;
    // The helper says what it published before it commits; a rename's moved file is the one `--expect` names.
    const publishes = mode === "--dir-copy" || mode === "--dir-rename";
    const expectAt = args.indexOf("--expect");
    const renamedFile = mode === "--dir-rename" && expectAt > 0 ? parseRecordFile(args[expectAt + 1] ?? "", parseInode) : null;
    let destinationDev = mode === "--dir-copy" && !needsDestinationStamp ? BigInt(args[6] ?? "-1") : null;
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
    const settleAnswer = (answer: string | Error): void => {
      if (answer instanceof HeldFileHelperUnavailableError) {
        fail(answer);
        return;
      }
      const answered = (): void => {
        if (targetLeft !== null) journal?.left?.(targetLeft);
        if (targetResolution !== null) journal?.resolved();
        if (answer instanceof Error) reject(answer);
        else resolve(answer);
      };
      // The published identity is recorded before the record can be resolved.
      if (persisting === null) answered();
      else void persisting.then(answered);
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
          settleAnswer(helperOutcome(helper, statusOf(outcome), null, outcome, errors, parseInode));
          return;
        }
        const stalled = new HeldFileHelperStalledError(helper, killed, stillRunning);
        stalled.exited = lateExit;
        fail(stalled);
        return;
      }
      const answered = pending === "" ? helperOutcome(helper, status, signal, last, errors, parseInode)
        : new HeldFileHelperUnavailableError(helper, "it ended with an incomplete protocol line");
      settleAnswer(answered);
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
    const allow = (step: HeldStep): void => {
      if (settled || killed !== null || outcome !== null || !inputOpen || stopping || stop.aborted) return;
      passed = step;
      stdin.write("c");
      awaitLine(`after ${step}`);
    };
    const isOutcome = (line: string): boolean => {
      const left = parsePartLeft(line, parseInode);
      if (left !== null) {
        if (mode === "--dir-restore-target") return passed === "ready" && line === "left";
        if (mode === "--dir-remove-id" || mode === "--dir-restore") return passed === "ready" && left.answer === "";
        // Only a copy let past `ready`, which may have created its temporary file, says what became of it.
        if (mode !== "--dir-copy" || passed === null) return false;
        if (left.at !== null) {
          const { name, identity } = left.at;
          if (writing === null || !sameFile(identity, writing) ||
              (oldTarget !== null && name === journal?.hidden) ||
              (identity.verdict === "remove-failed" && identity.observed !== null && !sameFile(identity.observed.file, writing))) return false;
        }
        const { answer } = left;
        if (answer === "cancelled") return stopping;
        if (answer === "refused target") return passed === "copied";
        return /^failed E[A-Z0-9_]+$/u.test(answer);
      }
      if (/^refused (from|to|source|target)$/u.test(line)) return mode !== "--dir-copy" || phase === "holding";
      if (line === "refused volume" || line === "refused volume-unknown") return mode === "--dir-copy" && phase === "holding";
      if (line === "refused target removed" || line === "refused target changed") return mode === "--dir-copy" && passed === "copied";
      if (/^failed E[A-Z0-9_]+$/u.test(line)) return true;
      if (line === "cancelled") return phase !== "holding" && stopping;
      if (mode === "--dir-copy") return line === "committed" && passed === "copied";
      if (passed !== "ready") return false;
      if (mode === "--dir-rename") return line === "committed" || line === "cross-volume" || line === "replace";
      if (mode === "--dir-remove" || mode === "--dir-remove-id") return line === "removed" || line === "absent";
      if (mode === "--dir-restore") return line === "restored" || line === "absent";
      if (mode === "--dir-restore-target") return line === "resolved" || line === "left";
      if (mode === "--dir-list-records") return RECORDS_LINE.test(line);
      if (mode === "--dir-read") return line === "absent" || (line.length <= 7 + 2 * Number(args[5]) && RECORD_LINE.test(line));
      if (mode === "--dir-sweep-record") return recordDecision === null ? line === "absent"
        : line === "kept" || (recordDecision && line === "removed");
      if (mode === "--dir-write-record") {
        const written = RECORD_WRITTEN_FRAME.exec(line)?.[1];
        return written !== undefined && parseRecordFile(written, parseInode) !== null;
      }
      if (mode === "--dir-remove-record") return line === "removed" || line === "kept" || line === "absent";
      if (mode === "--dir-stamp") return line === "absent" || parseRecordFile(STAMP_LINE.exec(line)?.[1] ?? "", parseInode) !== null;
      const swept = /^swept (\d+)$/u.exec(line);
      return mode === "--dir-sweep" && swept !== null && Number.isSafeInteger(Number(swept[1]));
    };
    stdout.on("data", (chunk: Buffer) => {
      if (settled || chunk.length === 0) return;
      if (outcome !== null) { violate(); return; }
      if (killed !== null) return;
      pending += chunk.toString("utf8");
      if (pending.length > MAX_HELPER_LINE_BYTES) { violate(); return; }
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        const inspected = mode === "--dir-sweep-record" ? RECORD_SWEEP_FRAME.exec(line) : null;
        if (inspected !== null) {
          const [, token = "", hex = ""] = inspected;
          const file = parseRecordFile(token, parseInode);
          if (passed !== "ready" || recordDecision !== null || hex.length > 2 * Number(args[5]) || file === null ||
              onRecord === undefined || !inputOpen || pending !== "") { violate(); return; }
          try {
            recordDecision = onRecord(Buffer.from(hex, "hex"), file);
          } catch (error) {
            thrown = error;
            beginStopping();
            return;
          }
          if (recordDecision) stdin.write("c");
          endInput();
          awaitLine("after reading the record");
          continue;
        }
        const destination = DESTINATION_ID.exec(line);
        if (destination !== null) {
          const directory = parseRecordFile(destination[1] ?? "", parseInode);
          if (!needsDestinationStamp || phase !== "holding" || destinationDev !== null || directory === null || !directory.ino) { violate(); return; }
          destinationDev = directory.dev;
          continue;
        }
        const targetId = TARGET_ID.exec(line);
        if (targetId !== null) {
          const old = parseRecordFile(targetId[1] ?? "", parseInode);
          if (mode !== "--dir-copy" || phase !== "holding" || oldTarget !== null || old === null || old.dev !== destinationDev) { violate(); return; }
          oldTarget = old;
          continue;
        }
        if (line === "target-restored" || line === "target-retired") {
          if (mode !== "--dir-copy" || passed !== "copied" || oldTarget === null || targetResolution !== null || targetLeft !== null ||
              (line === "target-restored" && published !== null)) { violate(); return; }
          targetResolution = line === "target-restored" ? "restored" : "retired";
          continue;
        }
        const publishedToken = PUBLISHED.exec(line)?.[1];
        if (publishedToken !== undefined) {
          const file = parseRecordFile(publishedToken, parseInode);
          const moved = mode === "--dir-copy" ? writing : mode === "--dir-rename" ? renamedFile : null;
          if (published !== null || file === null || moved === null || file.dev !== moved.dev || file.ino !== moved.ino ||
              passed !== (mode === "--dir-copy" ? "copied" : "ready") || targetResolution !== null || targetLeft !== null) { violate(); return; }
          published = file;
          if (journal !== undefined && oldTarget !== null) {
            persisting = Promise.resolve().then(() => journal.published(file)).catch((error: unknown) => {
              // The record still names the writer as it was before the rename, which recovery matches by file ID and volume.
              log.warn({ error: String(error) }, "the published download could not be recorded");
            });
          }
          awaitLine("after publishing");
          continue;
        }
        const identity = WRITING.exec(line);
        if (identity !== null) {
          const file = parseRecordFile(identity[2] ?? "", parseInode);
          const refresh = identity[1] === "copy-id";
          const invalidPhase = refresh ? writing === null || writingRefreshed || oldTarget === null : writing !== null || copiedBytes !== 0n;
          if (mode !== "--dir-copy" || phase !== "copying" || passed !== "ready" || invalidPhase || file === null ||
              file.dev !== destinationDev || (oldTarget !== null && (oldTarget.dev !== file.dev || oldTarget.ino === file.ino))) { violate(); return; }
          writingRefreshed = refresh;
          // The writer must still be the file the copy opened: another number or evidence is refused, and the first identity stays the
          // one its cleanup is bound to.
          if (refresh && writing !== null && !sameFile(file, writing)) {
            thrown = new HeldDirectoryRefusedError("target");
            beginStopping();
            continue;
          }
          writing = file;
          onWriting?.(writing);
          awaitLine("after opening the part");
          continue;
        }
        const progress = PROGRESS.exec(line)?.[1];
        if (progress !== undefined) {
          const bytes = BigInt(progress);
          if (mode !== "--dir-copy" || phase !== "copying" || passed !== "ready" || bytes <= copiedBytes) { violate(); return; }
          copiedBytes = bytes;
          awaitLine("while copying");
          continue;
        }
        if (line.startsWith("target-left ")) {
          const left = parsePartLeft(line, parseInode);
          if (mode !== "--dir-copy" || passed !== "copied" || writing === null || oldTarget === null || targetLeft !== null ||
              targetResolution !== null || !left?.at || left.partLeft || left.answer !== "target-left" ||
              left.at.name !== journal?.hidden || (published !== null && left.at.identity.verdict !== "remove-failed")) { violate(); return; }
          const { observed } = left.at.identity;
          if (!sameFile(left.at.identity, oldTarget) || (observed !== null && !sameFile(observed.file, oldTarget))) { violate(); return; }
          targetLeft = left.at;
          continue;
        }
        if (line !== "ready" && line !== "copied") {
          if (!isOutcome(line) ||
              (line === "committed" && oldTarget !== null && targetResolution === null && targetLeft === null) ||
              (line === "committed" && publishes && published === null) ||
              (published !== null && line !== "committed") ||
              (targetResolution === "retired" && line !== "committed") ||
              (targetResolution === "restored" && !/^(?:refused target|failed E)/u.test(line)) ||
              (targetLeft?.identity.verdict === "remove-failed" && line !== "committed") ||
              (targetLeft?.identity.verdict === "mismatch" && !/^(?:refused target|failed E)/u.test(line))) { violate(); return; }
          awaitLine("after its outcome");
          outcome = line;
          endInput();
          if (pending !== "" || errors !== "" && !line.startsWith("failed ")) violate();
          return;
        }
        if (line === "ready" ? phase !== "holding" : mode !== "--dir-copy" || phase !== "copying" || passed !== "ready") { violate(); return; }
        if (line === "ready" && needsDestinationStamp && destinationDev === null) { violate(); return; }
        if (line === "copied" && oldTarget !== null && !writingRefreshed) { violate(); return; }
        phase = line === "copied" ? "copied" : mode === "--dir-copy" ? "copying" : "acting";
        let go = false;
        try {
          go = inputOpen && !stopping && !stop.aborted && proceed(line as HeldStep);
        } catch (error) {
          thrown = error;
        }
        if (go && line === "copied" && oldTarget !== null && writing !== null) {
          if (journal === undefined) {
            thrown = new HeldDirectoryRefusedError("target");
            beginStopping();
          } else {
            const file = oldTarget;
            const writer = writing;
            void Promise.resolve().then(() => journal.write(file, writer)).then(() => allow("copied"), (error: unknown) => {
              if (settled) return;
              thrown = error;
              beginStopping();
            });
          }
        } else if (go) {
          allow(line);
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
export function _helperFileOperationsForTest(helper: string, bounds?: HelperBounds, windowsFileIds = false): HeldFileOperations {
  return helperFileOperations(helper, windowsFileIds, bounds);
}

function helperFileOperations(helper: string, windowsFileIds: boolean, bounds: HelperBounds = POLICY_BOUNDS): HeldFileOperations {
  const parseInode = windowsFileIds ? parseWindowsInode : parseUnsigned;
  const run = (args: readonly string[], proceed: Proceed, stop: AbortSignal, onWriting?: (file: FileIdentity) => void,
    journal?: DownloadTargetJournal): Promise<string> =>
    runHelper(helper, args, proceed, stop, bounds, parseInode, onWriting, journal);
  const go = (): boolean => true;
  const recover: HeldFileOperations["recover"] = async (folder, name, original, identity) => {
    const left: OwnFileResult = { outcome: "left", at: { name, identity } };
    const observed = identity.kind === "helper" ? identity.observed : null;
    const restore = identity.kind === "helper" && identity.verdict === "mismatch";
    const file = identity.kind === "fileId" ? identity.file : observed?.file;
    const expect = file === undefined ? null : tokenText(file, windowsFileIds);
    if (file === undefined || expect === null || (identity.kind === "helper" && !restore && !sameFile(file, identity))) return left;
    const args = restore ? ["--dir-restore", ...directoryArguments(folder), name, original]
      : ["--dir-remove-id", ...directoryArguments(folder), name];
    args.push("--expect", expect, ...(observed === null ? [] : ["--content", fingerprintKey(observed.content)]));
    try {
      const outcome = await run(args, go, UNSTOPPED);
      if (outcome === "absent" || outcome === "removed" || outcome === "restored") return { outcome };
      const at = parsePartLeft(outcome, parseInode)?.at;
      // Keep the original snapshot if the same source stayed in place.
      return at && at.name !== name ? { outcome: "left", at } : left;
    } catch (error) {
      if (error instanceof HeldFileHelperStalledError && error.stillRunning) throw error;
      log.warn({ path: join(folder.path, original), leftAs: name, error: (error as Error).message }, "the stopped download could not be recovered");
      return left;
    }
  };
  const removePartialCopy = async (folder: HeldDirectory, part: string, file: FileIdentity | null): Promise<OwnFileResult> => {
    if (file === null) {
      log.warn({ path: join(folder.path, part) }, "a stopped download copy's temporary file is left: it was never seen while the copy wrote it");
      return { outcome: "left", at: null };
    }
    const result = await recover(folder, part, part, { kind: "fileId", file });
    if (result.outcome === "restored") throw new Error("a download removal unexpectedly restored a file");
    return result;
  };
  return {
    move: async (from, name, to, target, proceed, stop, staged) => {
      const expect = tokenText(staged, windowsFileIds);
      if (expect === null) throw new HeldDirectoryRefusedError("source");
      return oneOf(helper, await run(["--dir-rename", ...directoryArguments(from), name, ...directoryArguments(to), target, "--expect", expect],
        proceed, stop), ["committed", "cancelled", "cross-volume", "replace"] as const);
    },
    copy: async (from, name, to, target, part, proceed, stop, journal) => {
      // The temporary file's identity, taken once the helper says it is writing it, so a later cleanup removes only that file.
      let partFile: FileIdentity | null = null;
      let authorized = false;
      try {
        const hidden = journal?.hidden ?? `.${randomBytes(16).toString("hex")}.removing`;
        if (!MOVED_ASIDE_NAME.test(hidden)) throw new HeldDirectoryRefusedError("target");
        const answer = await run(["--dir-copy", ...directoryArguments(from), name, ...directoryArguments(to), target, part, hidden], (step) => {
          const allowed = proceed(step);
          if (step === "ready") authorized = allowed;
          return allowed;
        }, stop, (file) => { partFile = file; }, journal);
        const left = parsePartLeft(answer, parseInode);
        if (left !== null) {
          // Cancelled with its temporary file left: reported as a failure, as a cancelled Linux copy whose file is left is.
          const error = new Error("a stopped download copy's temporary file is left in the chosen folder");
          helperLeftParts.set(error, left);
          throw error;
        }
        return oneOf(helper, answer, ["committed", "cancelled"] as const);
      } catch (error) {
        if (error instanceof Error && helperLeftParts.has(error)) {
          const left = helperLeftParts.get(error);
          const at = left?.at ?? (partFile !== null
            ? { name: part, identity: { kind: "fileId" as const, file: partFile } }
            : null);
          log.warn({ path: join(to.path, part), leftAs: at?.name, partLeft: left?.partLeft }, "a stopped download copy's temporary file is left");
          markStoppedCopy(error, { outcome: "left", at });
        } else if (error instanceof HeldFileHelperUnavailableError && error.passed !== null) {
          error.partFile = partFile;
          // A helper that may still be running is not raced: its file is left for a cleanup once it ends.
          if (error instanceof HeldFileHelperStalledError && error.stillRunning) error.partialCopy = "left";
          else markStoppedCopy(error, await removePartialCopy(to, part, partFile));
        } else if (authorized && !(error instanceof HeldDirectoryRefusedError)) {
          const code = codeOf(error);
          if (code !== "EEXIST" && (code !== "EPERM" || partFile !== null)) {
            markStoppedCopy(error, await removePartialCopy(to, part, partFile));
          }
        }
        throw error;
      }
    },
    remove: async (directory, name, proceed, stop, staged) => {
      const expect = tokenText(staged, windowsFileIds);
      if (expect === null) throw new HeldDirectoryRefusedError("source");
      return oneOf(helper, await run(["--dir-remove", ...directoryArguments(directory), name, "--expect", expect], proceed, stop),
        ["removed", "absent", "cancelled"] as const);
    },
    stamp: async (directory, name) => {
      const answer = await run(["--dir-stamp", ...directoryArguments(directory), name], go, UNSTOPPED);
      if (answer === "absent") return null;
      const file = parseRecordFile(STAMP_LINE.exec(answer)?.[1] ?? "", parseInode);
      if (file === null) throw new HeldFileHelperUnavailableError(helper, `it answered ${JSON.stringify(answer)}, not a stamp`);
      return file;
    },
    recover,
    recoverTarget: async (folder, hidden, target, file, content, replacement) => {
      const expect = tokenText(file, windowsFileIds);
      const renamed = typeof replacement === "object" && "renamed" in replacement;
      const writerFile = typeof replacement === "object" ? "renamed" in replacement ? replacement.renamed : replacement : undefined;
      const writer = writerFile === undefined ? undefined : tokenText(writerFile, windowsFileIds);
      if (expect === null || writer === null || (writerFile !== undefined && writerFile.dev !== file.dev)) return "left";
      // The macOS helper matches a renamed writer in full, since a rename there keeps the birth time; Windows by file ID and volume.
      const writerOption = renamed ? "--renamed-writer" : "--writer";
      return oneOf(helper, await run(["--dir-restore-target", ...directoryArguments(folder), hidden, target, "--expect", expect,
        ...(content === undefined ? [] : ["--content", fingerprintKey(content)]),
        ...(replacement === "retire" ? ["--retire"] : writer === undefined ? [] : [writerOption, writer])], go, UNSTOPPED), ["resolved", "left"] as const);
    },
    listRecords: async (directory) => {
      const answer = await run(["--dir-list-records", ...directoryArguments(directory)], go, UNSTOPPED);
      return answer === "records" ? [] : answer.slice(8).split(" ");
    },
    readRecord: async (directory, name, max, sweep) => {
      if (sweep !== undefined) {
        let bytes: Buffer | null = null;
        const answer = await runHelper(helper, ["--dir-sweep-record", ...directoryArguments(directory), name, String(max)],
          go, UNSTOPPED, bounds, parseInode, undefined, undefined, (body, file) => {
            bytes = body;
            return sweep.reject(body, recordStamp(file, body));
          });
        if (answer === "removed") sweep.removed();
        return bytes;
      }
      const answer = await run(["--dir-read", ...directoryArguments(directory), name, String(max)], go, UNSTOPPED);
      return answer === "absent" ? null : Buffer.from(answer.slice(7), "hex");
    },
    writeRecord: async (directory, name, body) => {
      if (body.length > MAX_RECORD_BYTES) throw new Error("the download cleanup record exceeds its limit");
      const answer = await run(["--dir-write-record", ...directoryArguments(directory), name, body.toString("hex")], go, UNSTOPPED);
      const file = parseRecordFile(answer.slice("written ".length), parseInode);
      if (file === null) throw new HeldFileHelperUnavailableError(helper, "it did not return a cleanup record stamp");
      return recordStamp(file, body);
    },
    removeRecord: async (directory, name, stamp) => {
      const expect = tokenText(stamp.file, windowsFileIds);
      if (expect === null) return false;
      return await run(["--dir-remove-record", ...directoryArguments(directory), name, "--expect", expect,
        "--length", String(stamp.length), "--digest", stamp.digest], go, UNSTOPPED) === "removed";
    },
    sweep: async (directory, keepRecords) => Number((await run(["--dir-sweep", ...directoryArguments(directory),
      ...(keepRecords ? ["--keep-records"] : [])], go, UNSTOPPED)).slice("swept ".length)),
  };
}
