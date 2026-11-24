import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { DownloadItem } from "electron";
import { aveHome } from "../../shared/ave-home.js";
import { createLogger } from "../../lib/logger.js";
import { retryOnFileLock } from "../../lib/transient-fs-lock-retry.js";
import { openFeatureNamespace } from "../storage/feature-namespace.js";
import {
  MOVED_ASIDE_NAME,
  stoppedCopyOf,
  heldFileOperations,
  HeldDirectoryRefusedError,
  HeldFileHelperStalledError,
  HeldFileHelperUnavailableError,
  type FileIdentity,
  type HelperPartIdentity,
  type LeftPart,
  type PartIdentity,
  type HeldDirectory,
  type HeldFileOperations,
  type HeldRefusal,
  type RecordStamp,
} from "./browser-download-files.js";

const log = createLogger("browser-download-staging");

/**
 * The Ave home child that holds downloads until the user picks where to save them. Host-only: the host-mediated file tools and every
 * confined lane (confined plugin workers, sandboxed agent shells and children, and MCP servers or A2A agents while they run confined) are
 * denied it, by the admission row and the sandbox projections of the Ave home. A process the user already gave their own file authority (an
 * MCP server or plugin worker started with plugin worker confinement off, or a host command the user approved outside the sandbox) can read
 * it, as it can read the saved file the moment Save completes; staging adds nothing such a process lacks, so it is not isolated from them.
 */
export const BROWSER_DOWNLOAD_STAGING_DIRECTORY = "browser-downloads";

// Only this user may enter the staging directory; an existing one with wider access is narrowed when it is verified.
const PRIVATE_MODE = 0o700;
const posix = process.platform !== "win32";
const NOFOLLOW = posix ? constants.O_NOFOLLOW : 0;
const DIRECTORY = posix ? constants.O_DIRECTORY : 0;

/** Bytes a download may write before the user has answered its Save dialog; it is paused, so only what was already in flight lands. */
export const UNANSWERED_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export type DoneState = "completed" | "cancelled" | "interrupted";

/**
 * What became of the files a download staged by the time `done` is reported: `removed` (moved to the chosen path, or deleted),
 * `remove-failed` (the staged file may still be in the staging folder), `helper-still-running` (the removal's helper was killed but not seen
 * to end), or `part-left` (a stopped cross-volume copy's temporary file may remain in the chosen folder; it outranks the others). The next
 * start's sweep removes what was left in the staging folder and retries recorded cleanup in the chosen folder.
 */
export type StagedCleanup = "removed" | "remove-failed" | "helper-still-running" | "part-left";

type DoneListener = (event: unknown, state: DoneState, cleanup: StagedCleanup) => void;

/** What the download list and the agent reports read of a download: a staged one that ends once the user chose and the file is in place. */
export interface ObservedDownload {
  getFilename(): string;
  getURL(): string;
  getURLChain(): string[];
  hasUserGesture(): boolean;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  /** Where the file was saved; empty until it has been. */
  getSavePath(): string;
  cancel(): void;
  on(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  once(event: "done", listener: DoneListener): unknown;
  removeListener(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  removeListener(event: "done", listener: DoneListener): unknown;
}

export type StageableDownloadItem = Pick<DownloadItem, "setSavePath" | "getFilename" | "getURL" | "getURLChain" | "hasUserGesture"
  | "getReceivedBytes" | "getTotalBytes" | "getState" | "cancel" | "pause" | "resume"> & {
  on(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  once(event: "done", listener: (event: unknown, state: DoneState) => void): unknown;
};

/**
 * The verified staging directory: its canonical path, the identity every later operation checks it still has, and the operations that
 * move, copy and remove files in it while holding it open (see {@link HeldFileOperations}); no step names a file by a path of its own.
 */
export interface BrowserDownloadStagingRoot extends HeldDirectory {
  readonly files: HeldFileOperations;
}

export interface BrowserDownloadStagingDeps {
  root: BrowserDownloadStagingRoot;
  /** Ask the user where to save `name` with the system Save dialog; null when it was closed without a path. */
  askSavePath(name: string): Promise<string | null>;
  /** The download wrote more than {@link UNANSWERED_DOWNLOAD_BYTES} before its dialog was answered and was stopped. */
  onOverLimit?(): void;
}

export interface StagedBrowserDownload {
  readonly download: ObservedDownload;
  /** Settles once this download's Save dialog has been answered, or skipped because the download already ended; true when a path was chosen. */
  readonly answered: Promise<boolean>;
}

export class BrowserDownloadStagingError extends Error {}

// The filesystem answers a check of the staging folder can get when the folder is missing, unreadable, or a link: each means it cannot be
// verified, so downloads are refused. Any other error is not a verification result and propagates.
const UNVERIFIABLE = new Set(["ELOOP", "ENOENT", "EACCES", "ENOTDIR", "EPERM"]);

function verifying<T>(what: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && UNVERIFIABLE.has(code)) throw new BrowserDownloadStagingError(`${what} (${code})`, { cause: error });
    throw error;
  }
}

function plainDirectory(info: BigIntStats): boolean {
  return info.isDirectory() && !info.isSymbolicLink();
}

/**
 * Create or verify the staging directory: a plain directory (no link or junction at it), owned by this user, whose canonical path is the
 * staging child of the canonical Ave home, so no ancestor was substituted. `resourcePath` is the host resources folder, where the native
 * helper that performs the file operations on macOS and Windows ships. Throws when any of that does not hold, the helper included;
 * downloads are then refused.
 */
export function prepareBrowserDownloadStaging(resourcePath: string): BrowserDownloadStagingRoot {
  const namespace = openFeatureNamespace(BROWSER_DOWNLOAD_STAGING_DIRECTORY).dir;
  const expected = join(verifying("the app's home cannot be resolved", () => realpathSync(aveHome())), BROWSER_DOWNLOAD_STAGING_DIRECTORY);
  verifying("the download staging folder cannot be created", () => {
    try {
      mkdirSync(namespace, { mode: PRIVATE_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  });
  const info = verifying("the download staging folder cannot be read", () => lstatSync(namespace, { bigint: true }));
  if (!plainDirectory(info)) throw new BrowserDownloadStagingError("the download staging folder is not a plain directory");
  const resolved = verifying("the download staging folder cannot be resolved", () => realpathSync(namespace));
  if (resolved !== expected) throw new BrowserDownloadStagingError("the download staging folder does not resolve inside the app's home");
  if (posix && info.uid !== BigInt(process.getuid?.() ?? -1)) throw new BrowserDownloadStagingError("the download staging folder belongs to another user");
  const folder: HeldDirectory = { path: expected, dev: info.dev, ino: info.ino };
  withVerifiedRoot(folder, (fd) => { if (fd !== undefined) fchmodSync(fd, PRIVATE_MODE); });
  // The folder is made private whether or not the helper is there, so what confined lanes are denied does not depend on it.
  let files: HeldFileOperations;
  try {
    files = heldFileOperations(resourcePath);
  } catch (error) {
    if (error instanceof HeldFileHelperUnavailableError) throw new BrowserDownloadStagingError(error.message, { cause: error });
    throw error;
  }
  return { ...folder, files };
}

// Open the staging directory without following a link at it and check it is still the verified one, for the length of `use`. A folder that
// is gone, unreadable or a link is a BrowserDownloadStagingError; errors from `use` itself pass through unchanged.
function withVerifiedRoot<T>(root: HeldDirectory, use: (fd: number | undefined) => T): T {
  const fd = posix ? verifying("the download staging folder cannot be opened", () => openSync(root.path, constants.O_RDONLY | DIRECTORY | NOFOLLOW)) : undefined;
  try {
    const info = verifying("the download staging folder cannot be read", () => (fd === undefined ? lstatSync(root.path, { bigint: true }) : fstatSync(fd, { bigint: true })));
    if (!info.isDirectory() || info.dev !== root.dev || info.ino !== root.ino || (fd === undefined && info.isSymbolicLink())) {
      throw new BrowserDownloadStagingError(ROOT_REPLACED);
    }
    return use(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const ROOT_REPLACED = "the download staging folder was replaced";
const STAGING_REFUSALS: Readonly<Record<HeldRefusal, string>> = {
  from: ROOT_REPLACED,
  to: "the chosen folder could not be verified, or its volume does not provide file IDs",
  source: "the staged file was replaced",
  target: "the chosen file could not be safely replaced",
};

// A held directory operation's refusal is a staging refusal; every other error passes through unchanged.
async function refusingAsStaging<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HeldDirectoryRefusedError) throw new BrowserDownloadStagingError(STAGING_REFUSALS[error.refusal], { cause: error });
    throw error;
  }
}

const proceedAlways = (): boolean => true;
// A stop that nothing aborts, for cleanup that runs to its end.
const UNSTOPPED = new AbortController().signal;

/**
 * Remove the staged files a previous run left behind (a crash before the user chose). Run at boot, before any download starts. A folder
 * that is no longer the verified one, or a helper that does not run, is a staging refusal; downloads are then refused.
 */
export async function sweepBrowserDownloadStaging(root: BrowserDownloadStagingRoot): Promise<number> {
  return refusingAsStaging(async () => {
    try {
      const resolved = await removeRecordedParts(root);
      return resolved + await root.files.sweep(root, true);
    } catch (error) {
      if (error instanceof HeldFileHelperUnavailableError) throw new BrowserDownloadStagingError(error.message, { cause: error });
      throw error;
    }
  });
}

// Where the user chose to save, bound when the dialog answers: the canonical folder and its identity, and the final name in it.
interface Destination { readonly folder: HeldDirectory; readonly path: string; readonly name: string }

function bindDestination(chosen: string): Destination {
  const path = realpathSync(dirname(chosen));
  const info = lstatSync(path, { bigint: true });
  if (!plainDirectory(info)) throw new BrowserDownloadStagingError("the chosen folder is not a plain directory");
  const name = basename(chosen);
  const destination = { folder: { path, dev: info.dev, ino: info.ino }, path: join(path, name), name };
  // An early answer for a link at the chosen name; the operation that saves checks it again in the held folder.
  const existing = lstatEntry(destination.path);
  if (existing !== null && !existing.isFile()) throw new BrowserDownloadStagingError(STAGING_REFUSALS.target);
  return destination;
}

function lstatEntry(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Remove a staged file, only from inside the verified staging folder. When the folder can no longer be verified the file is left where it
// is (the next start sweeps the verified folder) rather than removing whatever the old path now names. Only a removal the operation
// confirmed is `removed`.
async function removeStaged(root: BrowserDownloadStagingRoot, name: string): Promise<StagedCleanup> {
  try {
    // Cleanup runs to its end; a helper that stalls is killed within the stall bound, so `done` is never held up for longer.
    const removed = await root.files.remove(root, name, proceedAlways, UNSTOPPED);
    if (removed !== "cancelled") return "removed";
    log.warn("a staged browser download's removal was cancelled; the next start removes it");
    return "remove-failed";
  } catch (error) {
    if (error instanceof HeldDirectoryRefusedError) {
      log.warn({ error: error.message }, "a staged browser download was left in place: its folder cannot be verified");
      return "remove-failed";
    }
    log.warn({ error: (error as Error).message }, "a staged browser download could not be removed; the next start removes it");
    return error instanceof HeldFileHelperStalledError && error.stillRunning ? "helper-still-running" : "remove-failed";
  }
}

/**
 * The staged file reached the chosen path (`committed`, with what became of the staged file: a move takes it, a copy removes it), or
 * publication stopped before that point because the user cancelled.
 */
type Published = { readonly committed: true; readonly cleanup: StagedCleanup } | "cancelled";

// Move the staged file to the destination. The rename into place is the commit point: a cancel before it removes every partial copy this
// call made and the staged file; after it, the file is saved. A cross-volume copy goes through an exclusive temporary file in the folder.
// Each step holds the verified staging folder and the bound folder open for its whole length and names every file relative to them, so a
// folder moved or replaced after it was checked is never written through; a step whose folder is no longer the verified or bound one is
// refused before it acts. A rename held up by another program's brief lock on Windows is tried again. A helper that stalls, or does not end
// once cancelled, is killed within the stall bound and publication fails; what it may have left is logged, never assumed cleaned, and a
// temporary file a helper not seen to end may still write is removed once it ends or at the next start, while it is still that file.
async function publish(root: BrowserDownloadStagingRoot, name: string, destination: Destination, cancel: AbortSignal): Promise<Published> {
  const proceed = (): boolean => !cancel.aborted;
  const moved = await refusingAsStaging(() => retryOnFileLock(async () => {
    try {
      return await root.files.move(root, name, destination.folder, destination.name, proceed, cancel);
    } catch (error) {
      if (error instanceof HeldFileHelperUnavailableError && error.passed !== null) {
        log.warn({ path: destination.path }, "a browser download's rename ended without its outcome: the file may be at the chosen path");
      }
      throw error;
    }
  }));
  if (moved === "committed") return { committed: true, cleanup: "removed" };
  if (moved === "cancelled" || cancel.aborted) return "cancelled";
  const session = randomBytes(16).toString("hex");
  const part = `.${session}.part`;
  const hidden = `.${session}.removing`;
  let copied: "committed" | "cancelled";
  let record: RecordedFile | null = null;
  let resolved = false;
  let partResolved = false;
  let targetVerdict: HelperPartIdentity["verdict"] | undefined;
  try {
    copied = await refusingAsStaging(() => root.files.copy(root, name, destination.folder, destination.name, part, proceed, cancel, {
      hidden,
      write: async (file, writer) => {
        record = await writePartRecord(root, {
          folder: destination.folder, part, target: destination.name, session, writer,
          at: { name: hidden, identity: { kind: "fileId", file } },
        });
      },
      resolved: () => { resolved = true; },
      left: ({ identity }) => {
        if (identity.kind === "helper") targetVerdict = identity.verdict;
      },
    }));
    partResolved = true;
  } catch (error) {
    const stopped = stoppedCopyOf(error);
    partResolved = stopped?.partialCopy === "removed" || stopped?.partialCopy === "absent";
    await reportStoppedCopy(root, error, destination, part);
    throw error;
  } finally {
    if (record !== null) {
      if (resolved && partResolved) await finishRecord(root, record);
      else log.warn({ path: destination.path, leftAs: hidden, targetResolved: resolved, partResolved, verdict: targetVerdict },
        "a browser download's replacement needs recovery");
    }
  }
  if (copied === "cancelled") return "cancelled";
  return { committed: true, cleanup: await removeStaged(root, name) };
}

// A copy that failed after it may have written its temporary file: say whether it may have been saved, and what became of that file.
async function reportStoppedCopy(root: BrowserDownloadStagingRoot, error: unknown, destination: Destination, part: string): Promise<void> {
  const temporary = join(destination.folder.path, part);
  if (error instanceof HeldFileHelperUnavailableError && error.passed === "copied") {
    log.warn({ path: destination.path }, "a browser download's copy ended after its commit was allowed: the file may be at the chosen path");
  }
  const stopped = stoppedCopyOf(error);
  if (stopped === null) return;
  if (stopped.partialCopy !== "left") {
    log.info({ path: temporary, partialCopy: stopped.partialCopy }, "a stopped browser download copy left no temporary file");
    return;
  }
  log.warn({ path: temporary, leftAs: stopped.partLeftAt?.name }, "a browser download's copy was stopped and its temporary file may remain in the chosen folder");
  if (error instanceof HeldFileHelperStalledError && error.stillRunning) {
    await deferPartCleanup(root, destination.folder, part, error.partFile, error.exited);
  } else if (stopped.partLeftAt !== null) {
    // Left where it can still be found: the next start tries again.
    await tryWritePartRecord(root, { folder: destination.folder, part, at: stopped.partLeftAt });
  }
}

// A leftover in the chosen folder, identified at its current name, with the copy's part name and any displaced target name.
interface PartRecord {
  readonly folder: HeldDirectory;
  readonly part: string;
  readonly at: LeftPart;
  readonly target?: string;
  readonly session?: string;
  readonly writer?: FileIdentity;
}

const PART_RECORD = /^[0-9a-f]{32}\.cleanup\.json$/u;
const PART_NAME = /^\.[0-9a-f]{32}\.part$/u;
const DECIMAL = /^\d{1,20}$/u;
const WINDOWS_FILE_ID = /^(0|[1-9][0-9]{0,38})$/u;
const MAX_WINDOWS_FILE_ID = (1n << 128n) - 1n;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_PART_RECORD_BYTES = 8192;

// A copy whose helper was given up while it may still write: once the helper is seen to end, its temporary file is removed if it is still
// the one the copy wrote. Until then it is recorded in the staging folder, so the next start's sweep does the same if this run cannot. A
// temporary file never seen while the copy wrote it has no identity to check and is left.
async function deferPartCleanup(root: BrowserDownloadStagingRoot, folder: HeldDirectory, part: string, file: FileIdentity | null, exited: Promise<void> | null): Promise<void> {
  const path = join(folder.path, part);
  if (file === null || exited === null) {
    log.warn({ path }, "a stopped browser download copy's temporary file is left: it was never seen while the copy wrote it");
    return;
  }
  const record: PartRecord = { folder, part, at: { name: part, identity: { kind: "fileId", file } } };
  const recorded = await tryWritePartRecord(root, record);
  void exited.then(async () => {
    const result = await removeRecordedPart(root, record);
    log.info({ path, partialCopy: result.outcome, leftAs: result.outcome === "left" ? result.at?.name : undefined },
      "the helper of a stopped browser download copy ended late, and its temporary file was checked again");
    // A file left where it is no longer known as recorded is recorded anew; one that is not the copy's keeps its record.
    if (result.outcome === "left") {
      if (result.at === null || sameLeftPart(result.at, record.at)) return;
      if (await tryWritePartRecord(root, { ...record, at: result.at }) === null) return;
    }
    if (recorded === null) return;
    await finishRecord(root, recorded);
  }).catch((error: unknown) => {
    log.warn({ path, error: (error as Error).message }, "a stopped browser download could not be checked after its helper ended");
  });
}

function sameLeftPart(a: LeftPart, b: LeftPart): boolean {
  return a.name === b.name && a.identity.kind === b.identity.kind;
}

interface RecordedFile {
  readonly name: string;
  readonly stamp: RecordStamp;
}

async function tryWritePartRecord(root: BrowserDownloadStagingRoot, record: PartRecord): Promise<RecordedFile | null> {
  try {
    return await writePartRecord(root, record);
  } catch (error) {
    log.warn({ path: join(record.folder.path, record.at.name), error: (error as Error).message },
      "a browser download leftover could not be recorded for the next start");
    return null;
  }
}

// Write the record as a new private file in the verified staging folder, never through a link.
async function writePartRecord(root: BrowserDownloadStagingRoot, record: PartRecord): Promise<RecordedFile> {
  const name = `${record.session ?? randomBytes(16).toString("hex")}.cleanup.json`;
  const { identity } = record.at;
  const known = identity.kind === "fileId" ? { kind: identity.kind, ...identity.file }
    : identity.kind === "fingerprint" ? { kind: identity.kind, ...identity.content }
    : identity;
  const body = JSON.stringify({
    folder: { path: record.folder.path, dev: record.folder.dev, ino: record.folder.ino },
    part: record.part,
    target: record.target,
    session: record.session,
    writer: record.writer,
    at: record.at.name,
    identity: known,
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  return { name, stamp: await root.files.writeRecord(root, name, Buffer.from(body)) };
}

// A record exactly as {@link writePartRecord} writes it, or null.
function readPartRecord(text: string, name: string): PartRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const exactly = (candidate: unknown, keys: readonly string[]): candidate is Record<string, unknown> => typeof candidate === "object"
    && candidate !== null && !Array.isArray(candidate) && Object.keys(candidate).sort().join() === [...keys].sort().join();
  const decimal = (candidate: unknown): candidate is string => typeof candidate === "string" && DECIMAL.test(candidate);
  const fileInode = (candidate: unknown): candidate is string => decimal(candidate) ||
    (process.platform === "win32" && typeof candidate === "string" && WINDOWS_FILE_ID.test(candidate) && BigInt(candidate) <= MAX_WINDOWS_FILE_ID);
  const digest = (candidate: unknown): candidate is string => typeof candidate === "string" && DIGEST.test(candidate);
  const fileId = ({ dev, ino, birthtimeNs }: Record<string, unknown>): FileIdentity | null =>
    decimal(dev) && fileInode(ino) && decimal(birthtimeNs) ? { dev: BigInt(dev), ino: BigInt(ino), birthtimeNs: BigInt(birthtimeNs) } : null;
  const fingerprint = ({ size, mtimeNs, head, tail }: Record<string, unknown>) =>
    decimal(size) && decimal(mtimeNs) && digest(head) && digest(tail) ? { size: BigInt(size), mtimeNs: BigInt(mtimeNs), head, tail } : null;
  if ((!exactly(value, ["folder", "part", "at", "identity"]) &&
       !exactly(value, ["folder", "part", "at", "identity", "target"]) &&
       !exactly(value, ["folder", "part", "at", "identity", "target", "session"]) &&
       !exactly(value, ["folder", "part", "at", "identity", "target", "session", "writer"])) || !exactly(value.folder, ["path", "dev", "ino"])) return null;
  const { folder, part, at, identity, target, session } = value;
  if (typeof folder.path !== "string" || !isAbsolute(folder.path) || !decimal(folder.dev) || !decimal(folder.ino)) return null;
  if (typeof part !== "string" || !PART_NAME.test(part) || typeof at !== "string" || (at !== part && !MOVED_ASIDE_NAME.test(at))) return null;
  let known: PartIdentity | HelperPartIdentity;
  if ((exactly(identity, ["kind", "dev", "ino", "birthtimeNs"]) || exactly(identity, ["kind", "dev", "ino"])) && identity.kind === "fileId") {
    const file = !("birthtimeNs" in identity) && decimal(identity.dev) && fileInode(identity.ino)
      ? { dev: BigInt(identity.dev), ino: BigInt(identity.ino) } : fileId(identity);
    if (file === null) return null;
    known = { kind: "fileId", file };
  } else if (exactly(identity, ["kind", "size", "mtimeNs", "head", "tail"]) && identity.kind === "fingerprint") {
    const content = fingerprint(identity);
    if (content === null) return null;
    known = { kind: "fingerprint", content };
  } else if (exactly(identity, ["kind", "dev", "ino", "verdict", "observed"]) && identity.kind === "helper") {
    const { dev, ino, verdict, observed } = identity;
    if (!MOVED_ASIDE_NAME.test(at) || !decimal(dev) || !fileInode(ino) || (verdict !== "remove-failed" && verdict !== "mismatch")) return null;
    let snapshot: HelperPartIdentity["observed"] = null;
    if (observed !== null) {
      if (!exactly(observed, ["file", "content"]) || !exactly(observed.file, ["dev", "ino", "birthtimeNs"]) ||
          !exactly(observed.content, ["size", "mtimeNs", "head", "tail"])) return null;
      const file = fileId(observed.file);
      const content = fingerprint(observed.content);
      if (file === null || content === null) return null;
      snapshot = { file, content };
    }
    known = { kind: "helper", dev: BigInt(dev), ino: BigInt(ino), verdict, observed: snapshot };
  } else {
    return null;
  }
  if (target !== undefined && (typeof target !== "string" || target === "" || target === "." || target === ".." ||
      target === at || target === part || basename(target) !== target || target.includes("\0") ||
      (process.platform === "win32" && target.includes(":")) || !MOVED_ASIDE_NAME.test(at))) return null;
  if (session !== undefined) {
    if (target === undefined || typeof session !== "string" || !/^[0-9a-f]{32}$/u.test(session) ||
        name !== `${session}.cleanup.json` || part !== `.${session}.part` || at !== `.${session}.removing` ||
        known.kind !== "fileId" || known.file.birthtimeNs === undefined) return null;
  } else if (target !== undefined && (known.kind !== "helper" ||
      (known.observed !== null && (known.observed.file.dev !== known.dev || known.observed.file.ino !== known.ino)))) return null;
  let writer: FileIdentity | undefined;
  if ("writer" in value) {
    const raw = value.writer;
    if (session === undefined || known.kind !== "fileId" ||
        (!exactly(raw, ["dev", "ino"]) && !exactly(raw, ["dev", "ino", "birthtimeNs"])) ||
        !decimal(raw.dev) || !fileInode(raw.ino) || ("birthtimeNs" in raw && !decimal(raw.birthtimeNs))) return null;
    writer = { dev: BigInt(raw.dev), ino: BigInt(raw.ino), ...(decimal(raw.birthtimeNs) ? { birthtimeNs: BigInt(raw.birthtimeNs) } : {}) };
    if (writer.dev !== known.file.dev || writer.ino === known.file.ino) return null;
  }
  return { folder: { path: folder.path, dev: BigInt(folder.dev), ino: BigInt(folder.ino) }, part, at: { name: at, identity: known }, target, session, writer };
}

// Retry through the file backend. The decoded record never gives the host authority to open an entry by path.
async function removeRecordedPart(root: BrowserDownloadStagingRoot, { folder, part, at, target, session, writer }: PartRecord) {
  if (session !== undefined && !writer?.birthtimeNs) return { outcome: "left" as const, at };
  if (target === undefined) return root.files.recover(folder, at.name, part, at.identity);
  const observed = at.identity.kind === "helper" ? at.identity.observed : null;
  const file = at.identity.kind === "fileId" ? at.identity.file : observed?.file;
  const replacement = at.identity.kind === "helper" && at.identity.verdict === "remove-failed" ? "retire" : writer;
  if (file !== undefined) {
    try {
      if (await root.files.recoverTarget(folder, at.name, target, file, observed?.content, replacement) === "resolved") {
        if (writer !== undefined) {
          const result = await root.files.recover(folder, part, part, { kind: "fileId", file: writer });
          if (result.outcome === "left") {
            if (result.at !== null && result.at.name !== part) {
              await tryWritePartRecord(root, { folder, part, at: result.at });
            }
            return result;
          }
        }
        return { outcome: "resolved" as const };
      }
    } catch (error) {
      if (error instanceof HeldFileHelperStalledError && error.stillRunning) throw error;
      log.warn({ path: join(folder.path, target), error: (error as Error).message }, "the previous download target could not be recovered");
    }
  }
  return { outcome: "left" as const, at };
}

async function finishRecord(root: BrowserDownloadStagingRoot, { name, stamp }: RecordedFile): Promise<boolean> {
  try {
    return await root.files.removeRecord(root, name, stamp);
  } catch (error) {
    log.warn({ path: join(root.path, name), error: (error as Error).message }, "a browser download cleanup record could not be removed");
    return false;
  }
}

async function removeRecordedParts(root: BrowserDownloadStagingRoot): Promise<number> {
  const records: (RecordedFile & { record: PartRecord })[] = [];
  let removed = 0;
  for (const name of await root.files.listRecords(root)) {
    if (!PART_RECORD.test(name)) continue;
    const recordPath = join(root.path, name);
    try {
      let stamp: RecordStamp | undefined;
      const bytes = await root.files.readRecord(root, name, MAX_PART_RECORD_BYTES, {
        reject: (body, observed) => {
          stamp = observed;
          return readPartRecord(body.toString("utf8"), name) === null;
        },
        removed: () => { removed += 1; },
      });
      const record = bytes === null ? null : readPartRecord(bytes.toString("utf8"), name);
      if (record === null || stamp === undefined) {
        log.warn({ path: recordPath }, "a browser download cleanup record could not be verified");
        continue;
      }
      records.push({ name, record, stamp });
    } catch (error) {
      if (error instanceof HeldFileHelperStalledError && error.stillRunning) throw error;
      log.warn({ path: recordPath, error: (error as Error).message }, "a browser download cleanup record could not be read");
    }
  }
  records.sort((a, b) => Number(b.record.target !== undefined) - Number(a.record.target !== undefined));
  for (const { name, record, stamp } of records) {
    try {
      const result = await removeRecordedPart(root, record);
      const path = join(record.folder.path, record.target ?? record.part);
      if (result.outcome === "left") {
        const at = result.at ?? record.at;
        log.warn({ path, leftAs: join(record.folder.path, at.name) }, "a previous run's stopped download entry was left in place");
        if (record.target !== undefined || sameLeftPart(at, record.at) ||
            await tryWritePartRecord(root, { ...record, at }) === null) continue;
      } else {
        log.info({ path, partialCopy: result.outcome }, "a previous run's browser download leftover was checked");
      }
      if (await finishRecord(root, { name, stamp })) removed += 1;
    } catch (error) {
      if (error instanceof HeldFileHelperStalledError && error.stillRunning) throw error;
      log.warn({ path: join(root.path, name), error: (error as Error).message }, "a browser download cleanup record could not be acted on");
    }
  }
  return removed;
}

class StagedDownload extends EventEmitter implements ObservedDownload {
  private savedPath = "";
  private ended = false;
  private publishing = false;
  private readonly cancellation = new AbortController();
  constructor(private readonly item: StageableDownloadItem, private readonly root: BrowserDownloadStagingRoot, private readonly name: string) { super(); }
  getFilename(): string { return this.item.getFilename(); }
  getURL(): string { return this.item.getURL(); }
  getURLChain(): string[] { return this.item.getURLChain(); }
  hasUserGesture(): boolean { return this.item.hasUserGesture(); }
  getReceivedBytes(): number { return this.item.getReceivedBytes(); }
  getTotalBytes(): number { return this.item.getTotalBytes(); }
  getSavePath(): string { return this.savedPath; }
  get isEnded(): boolean { return this.ended; }
  /** Aborts once the user cancels; publication stops at its next step before the commit point. */
  get cancelSignal(): AbortSignal { return this.cancellation.signal; }
  // A cancel while the file is being put in place is answered by publication, once it knows whether the file was saved.
  cancel(): void {
    if (this.ended) return;
    this.cancellation.abort();
    if (this.publishing) return;
    if (this.item.getState() === "progressing") this.item.cancel();
    this.finish("cancelled");
  }
  beginPublishing(): boolean {
    if (this.ended || this.cancellation.signal.aborted) return false;
    this.publishing = true;
    return true;
  }
  // Ends the download once; `done` is reported, with what became of the staged file, after one that was not saved has been removed.
  finish(state: DoneState, saved?: { readonly path: string; readonly cleanup: StagedCleanup }, partLeft = false): void {
    if (this.ended) return;
    this.ended = true;
    if (saved !== undefined) {
      this.savedPath = saved.path;
      this.emit("done", {}, state, saved.cleanup);
      return;
    }
    void removeStaged(this.root, this.name).then((cleanup) => { this.emit("done", {}, state, partLeft ? "part-left" : cleanup); });
  }
}

/**
 * Write a download to a private staging file and pause it until the user answers its Save dialog, which is shown once `turn` settles so a
 * page's dialogs show one at a time. A chosen path resumes it; the file moves there once the download is done. A closed dialog, a cancelled
 * or failed download, a failed move, or more than {@link UNANSWERED_DOWNLOAD_BYTES} before an answer removes the staged file. Ave never picks
 * the final path itself. Call while handling `will-download`: the staging path must be set before the handler returns.
 */
export function stageBrowserDownload(item: StageableDownloadItem, deps: BrowserDownloadStagingDeps, turn: Promise<void>): StagedBrowserDownload {
  const name = randomBytes(16).toString("hex");
  const staged = withVerifiedRoot(deps.root, () => join(deps.root.path, name));
  item.setSavePath(staged);
  item.pause();
  const download = new StagedDownload(item, deps.root, name);
  let answered = false;
  const received = new Promise<DoneState>((resolve) => { item.once("done", (_event, state) => resolve(state)); });
  item.on("updated", (event, state) => {
    if (download.isEnded) return;
    if (!answered && item.getReceivedBytes() > UNANSWERED_DOWNLOAD_BYTES) {
      item.cancel();
      deps.onOverLimit?.();
      download.finish("interrupted");
      return;
    }
    download.emit("updated", event, state);
  });
  // A download that ends without completing ends at once; its dialog, if not yet shown, is skipped.
  void received.then((state) => { if (state !== "completed") download.finish(state); });
  const save = async (destination: Destination): Promise<void> => {
    const state = await received;
    if (download.isEnded) return;
    if (state !== "completed") { download.finish(state); return; }
    if (!download.beginPublishing()) { download.finish("cancelled"); return; }
    let outcome: Published;
    try {
      outcome = await publish(deps.root, name, destination, download.cancelSignal);
    } catch (error) {
      log.warn({ error: (error as Error).message }, "a browser download could not be put where the user chose");
      download.finish("interrupted", undefined, stoppedCopyOf(error)?.partialCopy === "left");
      return;
    }
    if (outcome === "cancelled") download.finish("cancelled");
    else download.finish("completed", { path: destination.path, cleanup: outcome.cleanup });
  };
  const answer = turn.then(async () => {
    if (download.isEnded) return false;
    let chosen: string | null;
    try {
      chosen = await deps.askSavePath(item.getFilename());
    } catch (error) {
      log.warn({ error: (error as Error).message }, "the Save dialog for a browser download failed");
      if (item.getState() === "progressing") item.cancel();
      download.finish("interrupted");
      return false;
    }
    answered = true;
    if (download.isEnded) return false;
    if (chosen === null) {
      download.cancel();
      return false;
    }
    let destination: Destination;
    try {
      destination = bindDestination(chosen);
    } catch (error) {
      log.warn({ error: (error as Error).message }, "the chosen path for a browser download cannot be written safely");
      if (item.getState() === "progressing") item.cancel();
      download.finish("interrupted");
      return true;
    }
    if (item.getState() === "progressing") item.resume();
    void save(destination);
    return true;
  });
  return { download, answered: answer };
}
