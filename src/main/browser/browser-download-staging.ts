import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DownloadItem } from "electron";
import { aveHome } from "../../shared/ave-home.js";
import { createLogger } from "../../lib/logger.js";
import { retryOnFileLock } from "../../lib/transient-fs-lock-retry.js";
import { openFeatureNamespace } from "../storage/feature-namespace.js";
import {
  heldFileOperations,
  HeldDirectoryRefusedError,
  HeldFileHelperUnavailableError,
  type HeldDirectory,
  type HeldFileOperations,
  type HeldRefusal,
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

type DoneState = "completed" | "cancelled" | "interrupted";

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
  once(event: "done", listener: (event: unknown, state: DoneState) => void): unknown;
  removeListener(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  removeListener(event: "done", listener: (event: unknown, state: DoneState) => void): unknown;
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
  to: "the chosen folder was replaced",
  source: "the staged file was replaced",
  target: "the chosen path is not an ordinary file",
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
  try {
    return await root.files.sweep(root);
  } catch (error) {
    if (error instanceof HeldDirectoryRefusedError) throw new BrowserDownloadStagingError(STAGING_REFUSALS[error.refusal], { cause: error });
    if (error instanceof HeldFileHelperUnavailableError) throw new BrowserDownloadStagingError(error.message, { cause: error });
    throw error;
  }
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
// is (the next start sweeps the verified folder) rather than removing whatever the old path now names.
async function removeStaged(root: BrowserDownloadStagingRoot, name: string): Promise<void> {
  try {
    // Cleanup runs to its end; a helper that stalls is killed within the stall bound, so `done` is never held up for longer.
    await root.files.remove(root, name, proceedAlways, UNSTOPPED);
  } catch (error) {
    if (error instanceof HeldDirectoryRefusedError) {
      log.warn({ error: error.message }, "a staged browser download was left in place: its folder cannot be verified");
      return;
    }
    log.warn({ error: (error as Error).message }, "a staged browser download could not be removed; the next start removes it");
  }
}

/** The staged file reached the chosen path (`committed`), or publication stopped before that point because the user cancelled. */
type Published = "committed" | "cancelled";

// Move the staged file to the destination. The rename into place is the commit point: a cancel before it removes every partial copy this
// call made and the staged file; after it, the file is saved. A cross-volume copy goes through an exclusive temporary file in the folder.
// Each step holds the verified staging folder and the bound folder open for its whole length and names every file relative to them, so a
// folder moved or replaced after it was checked is never written through; a step whose folder is no longer the verified or bound one is
// refused before it acts. A rename held up by another program's brief lock on Windows is tried again. A helper that stalls, or does not end
// once cancelled, is killed within the stall bound and publication fails; what it may have left is logged, never assumed cleaned.
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
  if (moved !== "cross-volume") return moved;
  if (cancel.aborted) return "cancelled";
  const part = `.${randomBytes(16).toString("hex")}.part`;
  let copied: Published;
  try {
    copied = await refusingAsStaging(() => root.files.copy(root, name, destination.folder, destination.name, part, proceed, cancel));
  } catch (error) {
    if (error instanceof HeldFileHelperUnavailableError && error.passed !== null) reportStoppedCopy(error, destination, part);
    throw error;
  }
  if (copied === "committed") await removeStaged(root, name);
  return copied;
}

// A copy whose helper ended without its outcome: say whether it may have been saved, and what became of its temporary file.
function reportStoppedCopy(error: HeldFileHelperUnavailableError, destination: Destination, part: string): void {
  const temporary = join(destination.folder.path, part);
  if (error.passed === "copied") log.warn({ path: destination.path }, "a browser download's copy ended after its commit was allowed: the file may be at the chosen path");
  if (error.partialCopy === "left") {
    log.warn({ path: temporary }, "a browser download's copy was stopped and its temporary file may remain in the chosen folder");
  } else {
    log.info({ path: temporary, partialCopy: error.partialCopy }, "a stopped browser download copy left no temporary file");
  }
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
  // Ends the download once; `done` is reported after a staged file that was not saved has been removed.
  finish(state: DoneState, savedTo?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (savedTo !== undefined) {
      this.savedPath = savedTo;
      this.emit("done", {}, state);
      return;
    }
    void removeStaged(this.root, this.name).then(() => { this.emit("done", {}, state); });
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
      download.finish("interrupted");
      return;
    }
    if (outcome === "cancelled") download.finish("cancelled");
    else download.finish("completed", destination.path);
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
