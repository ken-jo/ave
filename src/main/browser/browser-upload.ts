import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join } from "node:path";
import { sameFileIdentity, type FileIdentity } from "../../lib/file-identity.js";
import { openFeatureNamespace } from "../storage/feature-namespace.js";
import { DENY_EXTENSIONS } from "../../shared/attachments-deny-list.js";
import { sensitiveFilePattern } from "../../tools/file-access-policy.js";
import { BrowserActionError, throwIfAborted } from "./browser-action-guard.js";

/** Main-only picker operands; none of these are model-supplied file authority. */
export interface BrowserUploadPickerRequest {
  readonly windowId: number;
  readonly sessionId: string;
  readonly tabId: string;
  readonly origin: string;
  readonly documentId: number;
  readonly controlGeneration: number;
  readonly ref: string;
  readonly signal: AbortSignal;
}

export interface BrowserUploadResult {
  readonly status: "selected" | "cancelled";
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  readonly count: number;
  readonly bytes: number;
}

export const BROWSER_UPLOAD_LIMITS = Object.freeze({ files: 8, fileBytes: 20 * 1024 * 1024, selectionBytes: 40 * 1024 * 1024, processBytes: 100 * 1024 * 1024 });
const namespace = openFeatureNamespace("browser-uploads");
const liveSelections = new Set<BrowserUploadSelection>();
let reservedBytes = 0;
let disposed = false;
interface StagedFile extends Readonly<FileIdentity> { readonly path: string; readonly size: bigint }

async function removeOwnedFile(file: StagedFile): Promise<void> {
  let current;
  try { current = await fs.lstat(file.path, { bigint: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw new BrowserActionError("upload-cleanup-failed", "upload staging cleanup could not be completed"); }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, file) || current.nlink !== 1n) {
    throw new BrowserActionError("upload-cleanup-failed", "upload staging was replaced; its replacement was preserved");
  }
  // Descriptor-based chmod never follows a replaced file link. Recheck the
  // name before unlinking. Processes able to replace private namespace entries
  // concurrently remain outside this pathname cleanup guarantee.
  try {
    const handle = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFileIdentity(opened, file) || opened.nlink !== 1n) throw new Error("staging replaced");
      await handle.chmod(0o600);
    } finally { await handle.close(); }
    const named = await fs.lstat(file.path, { bigint: true });
    if (!named.isFile() || !sameFileIdentity(named, file) || named.nlink !== 1n) throw new Error("staging replaced");
    await fs.unlink(file.path);
  }
  catch { throw new BrowserActionError("upload-cleanup-failed", "upload staging cleanup could not be completed"); }
}

function assertUploadActive(signal: AbortSignal): void {
  throwIfAborted(signal);
  if (disposed) throw new BrowserActionError("upload-revoked", "browser uploads are shutting down");
}

function refused(): never {
  throw new BrowserActionError("upload-refused", "the selected files cannot be uploaded; choose ordinary non-sensitive files within the upload limits");
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameFileIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

// Read only through the descriptor whose identity and size the caller verified.
async function readBoundedFile(handle: FileHandle, size: bigint, assertCurrent: () => void): Promise<Buffer> {
  if (size < 0n || size > BigInt(BROWSER_UPLOAD_LIMITS.fileBytes)) refused();
  const buffer = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < buffer.length) {
    const read = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset);
    assertCurrent();
    if (read.bytesRead === 0) refused();
    offset += read.bytesRead;
  }
  const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
  assertCurrent();
  if (extra.bytesRead !== 0) refused();
  return buffer;
}

function sameDestination(a: BrowserUploadPickerRequest, b: BrowserUploadPickerRequest): boolean {
  return a.windowId === b.windowId && a.sessionId === b.sessionId && a.tabId === b.tabId && a.origin === b.origin
    && a.documentId === b.documentId && a.controlGeneration === b.controlGeneration && a.ref === b.ref;
}

/** A private byte snapshot. Its paths never enter tool inputs, output, or logs. */
export class BrowserUploadSelection {
  private used = false;
  private released = false;
  private releasePromise: Promise<void> | undefined;
  private stopLifetime: (() => void) | undefined;
  private retaining = false;
  private dispatched = false;
  private inFlight: Promise<void> | undefined;
  private readonly dispatchFiles: StagedFile[] = [];
  private dispatchBytes = 0;
  private dispatchDir: string | undefined;
  constructor(
    private readonly destination: BrowserUploadPickerRequest,
    private readonly dir: string,
    private readonly files: readonly StagedFile[],
    readonly result: BrowserUploadResult,
  ) {}

  async dispatch(destination: BrowserUploadPickerRequest, send: (paths: readonly string[]) => Promise<void>): Promise<void> {
    if (this.used || this.released) {
      throw new BrowserActionError("upload-revoked", "the upload selection is no longer valid; choose files again");
    }
    this.used = true;
    if (!sameDestination(this.destination, destination)) throw new BrowserActionError("upload-revoked", "the upload destination changed; choose files again");
    assertUploadActive(this.destination.signal);
    assertUploadActive(destination.signal);
    this.inFlight = this.sendVerifiedFiles(destination, send);
    try { await this.inFlight; this.dispatched = true; }
    finally { this.inFlight = undefined; }
  }

  private async sendVerifiedFiles(destination: BrowserUploadPickerRequest, send: (paths: readonly string[]) => Promise<void>): Promise<void> {
    const assertCurrent = () => {
      if (this.released) throw new BrowserActionError("upload-revoked", "the upload selection is no longer valid; choose files again");
      assertUploadActive(this.destination.signal);
      assertUploadActive(destination.signal);
    };
    // Browser file assignment consumes paths, so deliver fresh private copies
    // read from verified descriptors. Account for both retained generations.
    if (reservedBytes + this.result.bytes > BROWSER_UPLOAD_LIMITS.processBytes) refused();
    this.dispatchBytes = this.result.bytes;
    reservedBytes += this.dispatchBytes;
    try {
      for (const file of this.files) {
        assertCurrent();
        const source = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => refused());
        try {
          assertCurrent();
          const opened = await source.stat({ bigint: true }).catch(() => refused());
          if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(opened, file) || opened.size !== file.size) refused();
          const buffer = await readBoundedFile(source, opened.size, assertCurrent);
          const after = await source.stat({ bigint: true }).catch(() => refused());
          assertCurrent();
          if (!sameFile(opened, after)) refused();
          this.dispatchDir ??= await namespace.childDir(join(basename(this.dir), `dispatch-${randomUUID()}`));
          assertCurrent();
          const path = join(this.dispatchDir, basename(file.path));
          const copy = await fs.open(path, "wx", 0o600);
          try {
            const identity = await copy.stat({ bigint: true });
            this.dispatchFiles.push({ path, dev: identity.dev, ino: identity.ino, size: file.size });
            await copy.writeFile(buffer);
            await copy.chmod(0o400);
            const written = await copy.stat({ bigint: true });
            if (!sameFileIdentity(identity, written) || written.size !== file.size || written.nlink !== 1n) refused();
          } finally { await copy.close(); }
        } finally { await source.close(); }
      }
    } catch (error) {
      if (error instanceof BrowserActionError) throw error;
      throw new BrowserActionError("upload-failed", "the selected files could not be staged for this destination");
    }
    assertCurrent();
    await send(this.dispatchFiles.map((file) => file.path));
  }

  retainUntil(stop: (revoke: () => void) => () => void): void {
    if (!this.dispatched || this.released || this.retaining) throw new BrowserActionError("upload-revoked", "the upload selection is no longer valid");
    this.retaining = true;
    const stopLifetime = stop(() => { void this.release().catch(() => { /* Retain accounting when cleanup cannot prove ownership. */ }); });
    if (this.released) stopLifetime(); else this.stopLifetime = stopLifetime;
  }

  release(): Promise<void> {
    this.releasePromise ??= this.remove();
    return this.releasePromise;
  }

  private async remove(): Promise<void> {
    this.released = true;
    this.stopLifetime?.();
    this.stopLifetime = undefined;
    await this.inFlight?.catch(() => undefined);
    // Only these exclusively-created files belong to this selection. Never
    // recursively remove a directory, follow links or remove selected originals.
    for (const file of [...this.dispatchFiles, ...this.files]) await removeOwnedFile(file);
    try {
      if (this.dispatchDir) await fs.rmdir(this.dispatchDir);
      await fs.rmdir(this.dir);
    }
    catch { throw new BrowserActionError("upload-cleanup-failed", "upload staging cleanup could not be completed"); }
    reservedBytes -= this.result.bytes + this.dispatchBytes;
    liveSelections.delete(this);
  }
}

/**
 * Select once and copy bytes from verified descriptors into private readonly
 * files. A later edit/replacement of an original cannot change browser bytes.
 * Retention ends at input replacement, document replacement, guest destruction
 * or host shutdown; completing the tool does not end the browser's read lifetime.
 */
export async function stageBrowserUpload(
  destination: BrowserUploadPickerRequest,
  pickFiles: (request: BrowserUploadPickerRequest) => Promise<readonly string[] | null>,
  assertDestination: () => void,
): Promise<BrowserUploadSelection | null> {
  assertUploadActive(destination.signal);
  assertDestination();
  let chosen: readonly string[] | null;
  try { chosen = await pickFiles(Object.freeze({ ...destination })); }
  catch { throw new BrowserActionError("upload-picker-failed", "the file picker could not complete"); }
  assertUploadActive(destination.signal);
  assertDestination();
  if (chosen === null || chosen.length === 0) return null;
  if (disposed || chosen.length > BROWSER_UPLOAD_LIMITS.files || new Set(chosen).size !== chosen.length) refused();
  // Reserve the whole selection ceiling before the first staging await. Two
  // concurrent pickers cannot each spend the remaining process storage budget.
  if (reservedBytes + BROWSER_UPLOAD_LIMITS.selectionBytes > BROWSER_UPLOAD_LIMITS.processBytes) refused();
  reservedBytes += BROWSER_UPLOAD_LIMITS.selectionBytes;
  let dir: string | undefined;
  const paths: StagedFile[] = [];
  const files: { name: string; bytes: number }[] = [];
  let bytes = 0;
  try {
    dir = await namespace.childDir(`selection-${process.pid}-${randomUUID()}`);
    assertUploadActive(destination.signal);
    assertDestination();
    for (const original of chosen) {
      if (typeof original !== "string" || !isAbsolute(original) || sensitiveFilePattern(original)
        || DENY_EXTENSIONS.some((extension) => extname(original).toLowerCase() === `.${extension}`)) refused();
      const real = await fs.realpath(original);
      assertUploadActive(destination.signal); assertDestination();
      if (real !== original || sensitiveFilePattern(real)) refused();
      const before = await fs.lstat(original, { bigint: true });
      assertUploadActive(destination.signal); assertDestination();
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(BROWSER_UPLOAD_LIMITS.fileBytes)
        || BigInt(bytes) + before.size > BigInt(BROWSER_UPLOAD_LIMITS.selectionBytes)) refused();
      const source = await fs.open(original, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        assertUploadActive(destination.signal); assertDestination();
        const opened = await source.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened)) refused();
        const buffer = await readBoundedFile(source, opened.size, () => { assertUploadActive(destination.signal); assertDestination(); });
        const after = await source.stat({ bigint: true });
        const current = await fs.lstat(original, { bigint: true });
        assertUploadActive(destination.signal); assertDestination();
        if (!sameFile(opened, after) || !sameFile(opened, current) || await fs.realpath(original) !== real) refused();
        assertUploadActive(destination.signal); assertDestination();
        const name = basename(original).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 200) || "file";
        const path = join(dir, `${paths.length}-${name}`);
        const staged = await fs.open(path, "wx", 0o600);
        try {
          const identity = await staged.stat({ bigint: true });
          paths.push({ path, dev: identity.dev, ino: identity.ino, size: BigInt(buffer.length) });
          await staged.writeFile(buffer);
          await staged.chmod(0o400);
        } finally { await staged.close(); }
        assertUploadActive(destination.signal); assertDestination();
        bytes += buffer.length;
        files.push(Object.freeze({ name, bytes: buffer.length }));
      } finally { await source.close(); }
    }
    assertUploadActive(destination.signal); assertDestination();
    reservedBytes -= BROWSER_UPLOAD_LIMITS.selectionBytes - bytes;
    const selection = new BrowserUploadSelection(Object.freeze({ ...destination }), dir, Object.freeze(paths), Object.freeze({ status: "selected", files: Object.freeze(files), count: files.length, bytes }));
    liveSelections.add(selection);
    return selection;
  } catch (err) {
    for (const path of paths) await removeOwnedFile(path);
    if (dir) {
      try { await fs.rmdir(dir); }
      catch { throw new BrowserActionError("upload-cleanup-failed", "upload staging cleanup could not be completed"); }
    }
    reservedBytes -= BROWSER_UPLOAD_LIMITS.selectionBytes;
    if (err instanceof BrowserActionError) throw err;
    throw new BrowserActionError("upload-failed", "the selected files could not be staged for this destination");
  }
}

/** App shutdown owns this call; unknown crash remnants are never adopted/deleted. */
export async function disposeBrowserUploads(): Promise<void> {
  disposed = true;
  await Promise.all([...liveSelections].map((selection) => selection.release()));
}
