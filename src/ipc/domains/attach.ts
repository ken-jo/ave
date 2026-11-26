import { pickNativeFiles } from "../../permissions/approval-presentation.js";
import { app, ipcMain, nativeImage } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { validateAppWindowMainFrameSender } from "../app-window-sender.js";
import { previewFileReadAuthorizes } from "../../main/preview-file-access.js";
import { openVerifiedExternalFile, resolveExternalOpenTarget } from "../../main/external-open-target.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { DENY_EXTENSIONS as DENY_LIST } from "../../shared/attachments-deny-list.js";
import {
  type ComposerImageFormat,
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_COMPOSER_IMAGE_BYTES,
  sniffComposerImageFormat,
} from "../../shared/composer-image-input.js";
import { errorMessage } from "../../shared/error-message.js";
import type { AttachFileRejectReason } from "../../shared/attachment-rejection.js";
import {
  allowKeyMaterialInspection,
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitiveContent,
  isSensitivePath,
  judgedPathNamesOpenedFile,
} from "../../permissions/sensitive-paths.js";
import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { createLogger } from "../../lib/logger.js";
import { writeUtf8FileAtomic } from "../../lib/atomic-file.js";
import { renameFile } from "../../lib/transient-fs-lock-retry.js";
import type { IpcMainInvokeEvent } from "electron";

const DENY_EXTENSIONS = new Set<string>(DENY_LIST);
const log = createLogger("attach");

// Require picker, drop or clipboard authorization before reading or opening a path. The value counts the attachments that
// hold the path: each picker selection, redeemed drop or saved clipboard image adds one, and `attach.release` gives one back
// when its attachment is removed or sent. A file attached twice stays readable until both are gone. The size bound covers
// holders that never release (a renderer that crashed).
const ATTACH_ALLOWLIST_MAX = 10_000;
const ATTACH_PATH_ALLOWLIST = new Map<string, number>();
/** Most paths one `attach.release` call may name; a composer holds at most a handful. */
const ATTACH_RELEASE_MAX = 64;

/** A clipboard image file exactly as this process wrote it. Compared before deletion, so a file put at the same path later
 * is never deleted in its place. */
interface OwnedFile {
  dev: bigint;
  ino: bigint;
}
const CLIPBOARD_TEMP_IMAGES = new Map<string, OwnedFile>();

/** The files the person picked, dropped or pasted, by canonical case-folded path: the ones a key-extension name may be
 * opened for (see `allowKeyMaterialInspection`). Kept in step with the allow-list; `BEING_CHOSEN` covers a file while it
 * is being judged, before it is on the list. */
const CHOSEN_FILES = new Map<string, string>();
const BEING_CHOSEN = new Set<string>();
const chosenFileKey = (p: string): string => caseFoldForMatch(canonicalizePathForMatch(p));
function personChoseFile(canonicalPath: string): boolean {
  if (BEING_CHOSEN.has(canonicalPath)) return true;
  for (const chosen of CHOSEN_FILES.values()) if (chosen === canonicalPath) return true;
  return false;
}
let withdrawChosenFileInspection: (() => void) | undefined;

function unauthorizePath(p: string): void {
  ATTACH_PATH_ALLOWLIST.delete(p);
  CHOSEN_FILES.delete(p);
}

function authorizePath(p: string): void {
  const held = ATTACH_PATH_ALLOWLIST.get(p) ?? 0;
  // Re-inserted so the map's order stays oldest-authorization-first for the bound below.
  ATTACH_PATH_ALLOWLIST.delete(p);
  ATTACH_PATH_ALLOWLIST.set(p, held + 1);
  CHOSEN_FILES.set(p, chosenFileKey(p));
  while (ATTACH_PATH_ALLOWLIST.size > ATTACH_ALLOWLIST_MAX) {
    const oldest = ATTACH_PATH_ALLOWLIST.keys().next().value;
    if (oldest === undefined) break;
    unauthorizePath(oldest);
    // Its file, if this app wrote one, is left for the sweep at the next start.
    CLIPBOARD_TEMP_IMAGES.delete(oldest);
  }
}

function authorizeClipboardTempImage(filePath: string, owned: OwnedFile): void {
  authorizePath(filePath);
  CLIPBOARD_TEMP_IMAGES.set(filePath, owned);
}

const CLIPBOARD_DIR_PREFIX = "ave-clip-";
/** `fs.mkdtemp` appends six characters to the prefix. */
const CLIPBOARD_DIR_NAME = /^ave-clip-[A-Za-z0-9]{6}$/;
/** The one file name a clipboard image is written under: `image.` and the sniffed format's extension. */
const CLIPBOARD_FILE_NAME = /^image\.[a-z0-9]{1,5}$/;

/**
 * Where this profile's clipboard images live: one directory of its own under the OS temp directory, named after the
 * profile. A profile is used by one running Ave process at a time (the single-instance lock), so whatever the directory
 * holds at start was left by an earlier run of this same profile, and nothing outside it is ever swept.
 */
export function clipboardImageRoot(): string {
  const profile = createHash("sha256").update(app.getPath("userData")).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `ave-clipboard-${profile}`);
}

/** A real directory (`lstat`: a link or junction is not one) that only this account can enter. Windows has no owner or mode
 * to read here; its temp directory is already per account. */
function isOwnPrivateDirectory(stat: Stats): boolean {
  if (!stat.isDirectory()) return false;
  if (typeof process.getuid !== "function") return true;
  return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

async function ensureClipboardImageRoot(): Promise<string> {
  const root = clipboardImageRoot();
  try {
    await fs.mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // The name is predictable, and a shared temp directory lets another account create it first: refuse one this account does
  // not own privately instead of writing a clipboard image into it.
  if (!isOwnPrivateDirectory(await fs.lstat(root))) {
    throw new Error("clipboard image directory is not a private directory of this account");
  }
  return root;
}

async function lstatIfPresent(target: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The record of which clipboard images this app wrote, kept in the profile's clipboard directory so it outlives the
 * process: the start sweep deletes only what a receipt names, by the identity the file had when it was written. */
const CLIPBOARD_RECEIPTS_NAME = "written.json";
type ClipboardReceipts = Map<string, { file: string; owned: OwnedFile }>;

async function readClipboardReceipts(root: string): Promise<ClipboardReceipts> {
  const receipts: ClipboardReceipts = new Map();
  let parsed: unknown;
  try {
    const handle = await fs.open(path.join(root, CLIPBOARD_RECEIPTS_NAME), nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) return receipts;
      parsed = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    // No record, or one that cannot be read: nothing is known to be this app's, so nothing will be deleted.
    if (error instanceof SyntaxError || ["ENOENT", "ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return receipts;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return receipts;
  for (const [directory, value] of Object.entries(parsed)) {
    const { file, dev, ino } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if (!CLIPBOARD_DIR_NAME.test(directory) || typeof file !== "string" || !CLIPBOARD_FILE_NAME.test(file)
      || typeof dev !== "string" || typeof ino !== "string" || !/^\d+$/u.test(dev) || !/^\d+$/u.test(ino)) continue;
    receipts.set(directory, { file, owned: { dev: BigInt(dev), ino: BigInt(ino) } });
  }
  return receipts;
}

async function writeClipboardReceipts(root: string, receipts: ClipboardReceipts): Promise<void> {
  const target = path.join(root, CLIPBOARD_RECEIPTS_NAME);
  if (receipts.size === 0) {
    await fs.unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  const body = JSON.stringify(Object.fromEntries([...receipts].map(([directory, { file, owned }]) =>
    [directory, { file, dev: owned.dev.toString(), ino: owned.ino.toString() }])));
  await writeUtf8FileAtomic(target, body);
}

/** Add or drop one directory's receipt. Called inside the clipboard-store queue. */
async function recordClipboardReceipt(root: string, directory: string, receipt: { file: string; owned: OwnedFile } | null): Promise<void> {
  const receipts = await readClipboardReceipts(root);
  if (receipt === null) receipts.delete(directory);
  else receipts.set(directory, receipt);
  await writeClipboardReceipts(root, receipts);
}

/**
 * Delete one clipboard image this app wrote, and its directory. Returns false, deleting nothing, when what is there is not
 * exactly that: the directory is a link, it holds anything but the one image, or the file is not the one that was written.
 *
 * The image is first moved, inside its directory, to a fresh random name. A move takes whichever object is at the name at
 * that instant, so the identity is then read from the object that was taken, not from a name another process can still
 * re-point; only an object with the recorded identity is unlinked, and anything else is kept: given its name back by a
 * hard link, or else left whole under the random name. The platform
 * has no way to unlink through an open file, so one gap remains and is not hidden: between reading the identity under the
 * random name and unlinking that name. It is a name nothing else was told. Never recursive: one file is unlinked and the
 * directory is removed only if it is then empty.
 */
async function removeClipboardImageDirectory(directory: string, file: string, owned: OwnedFile): Promise<boolean> {
  const directoryStat = await lstatIfPresent(directory);
  if (directoryStat === null) return true;
  if (!directoryStat.isDirectory()) return false;
  const names = await fs.readdir(directory);
  if (names.length === 0) {
    await fs.rmdir(directory);
    return true;
  }
  if (names.length !== 1 || names[0] !== file) return false;
  const original = path.join(directory, file);
  const taken = path.join(directory, `.reclaim-${randomBytes(12).toString("hex")}`);
  await renameFile(original, taken);
  const takenStat = await fs.lstat(taken, { bigint: true });
  if (!takenStat.isFile() || takenStat.dev !== owned.dev || takenStat.ino !== owned.ino) {
    // Not the file this app wrote. It goes back under its name unless something is there by now; it is never unlinked.
    // A hard link gives the name back without replacing anything that arrived there meanwhile; it is the only way back
    // that cannot overwrite. Where no link can be made (the name is taken again, the object is a directory, the volume
    // has no hard links) the object stays, whole, under the random name, and the log says where. It is never moved back
    // over a name that was only seen to be free a moment earlier.
    const linkFailure = takenStat.isDirectory()
      ? "a directory"
      : await fs.link(taken, original).then(() => null, (error: NodeJS.ErrnoException) => error.code ?? error.message);
    if (linkFailure === null) await fs.unlink(taken);
    else log.warn("a file found in place of a clipboard image was kept as %s (no link back: %s)", taken, linkFailure);
    return false;
  }
  await fs.unlink(taken);
  try {
    await fs.rmdir(directory);
  } catch (error) {
    // Something else arrived in the directory meanwhile; it stays, with the directory.
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" || (error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  return true;
}

/** Remove `root` once it holds nothing, so a profile that has no clipboard image leaves no directory behind. */
async function removeClipboardImageRootIfEmpty(root: string): Promise<void> {
  try {
    await fs.rmdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}

/**
 * Remove the clipboard images an earlier run of this profile wrote and did not get to delete. Only `root` is read, and a
 * directory is removed only when a receipt from that run names it and the file in it still has the identity the receipt
 * recorded (see `removeClipboardImageDirectory`). A directory with no receipt, or with another file in it, is left exactly
 * as it is: its name alone never shows that this app wrote it. A `root` that is missing, a link, or not private to this
 * account is left untouched.
 */
export async function sweepLeftoverClipboardImages(root: string): Promise<{ removed: number; kept: number }> {
  const counts = { removed: 0, kept: 0 };
  let rootStat: Stats;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return counts;
    throw error;
  }
  if (!isOwnPrivateDirectory(rootStat)) return counts;
  const receipts = await readClipboardReceipts(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !CLIPBOARD_DIR_NAME.test(entry.name)) continue;
    const receipt = receipts.get(entry.name);
    if (receipt !== undefined && await removeClipboardImageDirectory(path.join(root, entry.name), receipt.file, receipt.owned)) {
      counts.removed += 1;
      receipts.delete(entry.name);
    } else {
      counts.kept += 1;
    }
  }
  // A receipt whose directory is gone describes nothing any more.
  for (const directory of [...receipts.keys()]) {
    if (await lstatIfPresent(path.join(root, directory)) === null) receipts.delete(directory);
  }
  await writeClipboardReceipts(root, receipts);
  await removeClipboardImageRootIfEmpty(root);
  return counts;
}

// One clipboard-store operation at a time: a save creates the root and a directory in it while a release or the start sweep
// may be removing the root because it just became empty.
let clipboardStoreTail: Promise<unknown> = Promise.resolve();
function inClipboardStore<T>(work: () => Promise<T>): Promise<T> {
  const run = clipboardStoreTail.then(work, work);
  // The tail only orders the work; each caller gets its own result or error from `run`.
  clipboardStoreTail = run.then(() => undefined, () => undefined);
  return run;
}

export const DROP_TOKEN_TTL_MS = 60_000;
const DROP_TOKEN_MAX_PENDING = 32;

type DropRejectReason = AttachFileRejectReason;

type DroppedFile = OpenFileResult["files"][number];

// Drop registration validates and binds but grants no access; redemption consumes a sender-bound, expiring token.
const pendingDrops = new Map<string, { senderId: number; files: DroppedFile[]; expires: number }>();

function prunePendingDrops(now: number): void {
  for (const [token, pending] of pendingDrops) {
    if (now > pending.expires) pendingDrops.delete(token);
  }
  while (pendingDrops.size >= DROP_TOKEN_MAX_PENDING) {
    const oldest = pendingDrops.keys().next().value;
    if (oldest === undefined) break;
    pendingDrops.delete(oldest);
  }
}

function senderIdOf(e: IpcMainInvokeEvent): number | null {
  const id = (e.sender as { id?: unknown } | undefined)?.id;
  return typeof id === "number" ? id : null;
}

/** Judge a file the person is bringing in right now. Dropping it is what lets a `.pem` or `.key` name be opened to see
 * whether it holds a private key; without that, a presentation document from the desktop could not be attached. */
function sensitiveForRead(p: string): boolean {
  const key = chosenFileKey(p);
  const added = !BEING_CHOSEN.has(key);
  if (added) BEING_CHOSEN.add(key);
  try {
    // The person's own drop: a key-extension file is refused only when it holds a key.
    return isSensitivePath(p, "read", "person") !== null;
  } finally {
    if (added) BEING_CHOSEN.delete(key);
  }
}

async function validateDroppedPath(
  p: string,
): Promise<{ ok: true; file: DroppedFile } | { ok: false; reason: DropRejectReason }> {
  const ext = getExt(p);
  if (DENY_EXTENSIONS.has(ext)) return { ok: false, reason: "denied-extension" };
  // Both the dropped spelling and its real target: a harmless-looking name may
  // be a symlink to a credential file.
  if (sensitiveForRead(p)) return { ok: false, reason: "sensitive-path" };
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (sensitiveForRead(real)) return { ok: false, reason: "sensitive-path" };
  if (DENY_EXTENSIONS.has(getExt(real))) return { ok: false, reason: "denied-extension" };
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { ok: false, reason: "not-a-file" };
    const imageFormat = await sniffImageFilePrefix(real);
    return {
      ok: true,
      file: {
        path: p,
        name: path.basename(p),
        ext,
        bytes: stat.size,
        isImage: imageFormat !== null && imageFormat !== undefined,
        mimeType: imageFormat?.mimeType,
      },
    };
  } catch {
    return { ok: false, reason: "not-found" };
  }
}

// Keep the permissive pre-decode size guard separate from the shared decoded-image cap.
const MAX_CLIPBOARD_BASE64_INPUT_CHARS = MAX_COMPOSER_IMAGE_BYTES * 2;

function getExt(p: string): string {
  const name = path.basename(p);
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

// Read only magic-sniffer bytes; never buffer generic files merely to classify picker metadata.
async function sniffImageFilePrefix(filePath: string) {
  const handle = await fs.open(filePath, "r");
  try {
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return sniffComposerImageFormat(prefix.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}


export interface OpenFileResult {
  canceled: boolean;
  files: Array<{
    path: string;
    name: string;
    ext: string;
    bytes: number;
    isImage: boolean;
    mimeType?: string;
  }>;
  /** Selected files that were not returned, each with the reason the composer shows. */
  rejected: Array<{ name: string; reason: AttachFileRejectReason }>;
}

export type RegisterDropResult =
  | { ok: true; token: string; rejected: Array<{ name: string; reason: DropRejectReason }> }
  | { ok: false; error: "unauthorized" | "invalid-payload" | "nothing-attachable"; rejected?: Array<{ name: string; reason: DropRejectReason }> };

export type RedeemDropResult =
  | { ok: true; files: OpenFileResult["files"] }
  | { ok: false; error: "unauthorized" | "drop-token-invalid" | "drop-token-expired" };

export interface ReadImageResult {
  ok: boolean;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
  error?: string;
}

export interface SaveClipboardImageInput {
  // Raw base64 has no data prefix; determine the image format from magic bytes.
  base64: string;
}

export interface SaveClipboardImageResult {
  ok: boolean;
  path?: string;
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
  dataUrl?: string;
  error?: string;
}

export type ReleaseAttachmentsResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "invalid-payload" };

export function registerAttachHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;

  withdrawChosenFileInspection?.();
  withdrawChosenFileInspection = allowKeyMaterialInspection(personChoseFile);

  // Start-of-run cleanup of this profile's own clipboard image directory. It runs through the store queue, so a paste that
  // arrives first waits for it instead of having its new directory swept.
  void inClipboardStore(async () => sweepLeftoverClipboardImages(clipboardImageRoot())).then(
    ({ removed, kept }) => {
      if (removed > 0 || kept > 0) log.info("removed %d leftover clipboard image(s), kept %d unrecognized", removed, kept);
    },
    (error: unknown) => {
      log.warn("leftover clipboard images were not removed (%s)", (error as NodeJS.ErrnoException).code ?? errorMessage(error));
    },
  );

  ipcMain.handle(CHANNELS.attach.openFile, async (e): Promise<OpenFileResult> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.attach.openFile, e);
      return { canceled: true, files: [], rejected: [] };
    }
    const win = getMainWindow();
    if (!win) return { canceled: true, files: [], rejected: [] };

    const result = await pickNativeFiles(win, {
      title: t("mainDialog.attachTitle"),
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [], rejected: [] };
    }

    const files: OpenFileResult["files"] = [];
    const rejected: OpenFileResult["rejected"] = [];
    for (const p of result.filePaths) {
      const ext = getExt(p);
      if (DENY_EXTENSIONS.has(ext)) {
        rejected.push({ name: path.basename(p), reason: "denied-extension" });
        continue;
      }
      try {
        const stat = await fs.stat(p);
        const imageFormat = await sniffImageFilePrefix(p);
        const isImage = imageFormat !== null && imageFormat !== undefined;
        files.push({
          path: p,
          name: path.basename(p),
          ext,
          bytes: stat.size,
          isImage,
          mimeType: imageFormat?.mimeType,
        });
        // The native picker authorizes this exact path for later reads and opens.
        authorizePath(p);
      } catch {
        rejected.push({ name: path.basename(p), reason: "not-found" });
      }
    }
    return { canceled: false, files, rejected };
  });

  ipcMain.handle(
    CHANNELS.attach.registerDrop,
    async (e, rawPaths: unknown): Promise<RegisterDropResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.registerDrop, e);
        return { ok: false, error: "unauthorized" };
      }
      const senderId = senderIdOf(e);
      if (senderId === null) return { ok: false, error: "unauthorized" };
      if (
        !Array.isArray(rawPaths)
        || rawPaths.length === 0
        || !rawPaths.every((p): p is string => typeof p === "string" && p.length > 0 && path.isAbsolute(p))
      ) {
        return { ok: false, error: "invalid-payload" };
      }
      const files: DroppedFile[] = [];
      const rejected: Array<{ name: string; reason: DropRejectReason }> = [];
      for (const p of rawPaths) {
        if (files.length >= MAX_COMPOSER_ATTACHMENT_COUNT) {
          rejected.push({ name: path.basename(p), reason: "too-many" });
          continue;
        }
        const verdict = await validateDroppedPath(p);
        if (verdict.ok) files.push(verdict.file);
        else rejected.push({ name: path.basename(p), reason: verdict.reason });
      }
      if (files.length === 0) return { ok: false, error: "nothing-attachable", rejected };
      const now = Date.now();
      prunePendingDrops(now);
      const token = randomBytes(32).toString("base64url");
      pendingDrops.set(token, { senderId, files, expires: now + DROP_TOKEN_TTL_MS });
      return { ok: true, token, rejected };
    },
  );

  ipcMain.handle(
    CHANNELS.attach.redeemDrop,
    async (e, rawToken: unknown): Promise<RedeemDropResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.redeemDrop, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof rawToken !== "string" || rawToken.length === 0) {
        return { ok: false, error: "drop-token-invalid" };
      }
      const pending = pendingDrops.get(rawToken);
      // Consume on first lookup, including failed redemption from another sender.
      if (pending) pendingDrops.delete(rawToken);
      if (!pending || pending.senderId !== senderIdOf(e)) {
        return { ok: false, error: "drop-token-invalid" };
      }
      if (Date.now() > pending.expires) return { ok: false, error: "drop-token-expired" };
      for (const file of pending.files) authorizePath(file.path);
      return { ok: true, files: pending.files };
    },
  );

  ipcMain.handle(
    CHANNELS.attach.readImage,
    async (e, filePath: string): Promise<ReadImageResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.readImage, e);
        return { ok: false, error: "unauthorized" };
      }
      try {
        // Renderer path strings grant no read authority; require prior user authorization.
        if (!ATTACH_PATH_ALLOWLIST.has(filePath)) {
          return { ok: false, error: "path_not_authorized" };
        }
        // These bytes become an image part of the message the model reads, so they are judged as the agent's read: a
        // key-extension file not shown to hold no key is refused here even though the person could attach it.
        const target = await resolveExternalOpenTarget(filePath, "agent");
        if (!target.ok) return { ok: false, error: target.error };
        // Stat before buffering so multi-gigabyte files cannot exhaust memory.
        const stat = await fs.stat(target.real);
        if (stat.size > MAX_COMPOSER_IMAGE_BYTES) {
          return { ok: false, error: "image_too_large" };
        }
        if (!await sniffImageFilePrefix(target.real)) {
          return { ok: false, error: "not_image" };
        }
        // Read through one handle, opened without following a link in its last name where the platform can refuse one
        // (Windows cannot). It stays open until the last check, so its file's identity cannot pass to another file first.
        const handle = await fs.open(target.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let buf: Buffer;
        let imageFormat: ComposerImageFormat;
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile()) return { ok: false, error: "not-a-file" };
          buf = await handle.readFile();
          if (buf.length > MAX_COMPOSER_IMAGE_BYTES) {
            return { ok: false, error: "image_too_large" };
          }
          // Re-sniff after the full read so a file replacement race cannot make
          // a claimed image MIME disagree with the bytes sent to a provider.
          const sniffed = sniffComposerImageFormat(buf);
          if (!sniffed) {
            return { ok: false, error: "not_image" };
          }
          imageFormat = sniffed;
          // The bytes that become the image part are judged themselves, as the agent's read: what the path holds by now,
          // or held when it was checked above, says nothing about a buffer read in between.
          if (isSensitiveContent(target.real, buf) !== null) {
            return { ok: false, error: "sensitive-path" };
          }
          // The name and location rules were judged on `target.real`. They hold for these bytes only if that path, looked
          // up again now, still names the very file they were read from: a folder or last name that led into a protected
          // folder during the open and was put back leaves another file there, and one still leading there resolves to
          // another path. A path switched back and forth between those two lookups is not seen.
          if (!judgedPathNamesOpenedFile(target.real, opened)) return { ok: false, error: "changed" };
        } finally {
          await handle.close();
        }
        const mimeType = imageFormat.mimeType;
        const img = nativeImage.createFromBuffer(buf);
        const { width, height } = img.getSize();
        const dataUrl = `data:${mimeType};base64,${buf.toString("base64")}`;
        return {
          ok: true,
          dataUrl,
          mimeType,
          width,
          height,
          bytes: buf.length,
        };
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.attach.saveClipboardImage,
    async (e, input: SaveClipboardImageInput): Promise<SaveClipboardImageResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.saveClipboardImage, e);
        return { ok: false, error: "unauthorized" };
      }
      try {
        // Cap encoded input before decoding to bound temp writes and native decoder exposure.
        if (typeof input?.base64 !== "string") {
          return { ok: false, error: "invalid_payload" };
        }
        if (input.base64.length > MAX_CLIPBOARD_BASE64_INPUT_CHARS) {
          // Allow base64 expansion while rejecting pathological strings before allocation.
          return { ok: false, error: "clipboard_too_large" };
        }
        const buf = Buffer.from(input.base64, "base64");
        if (buf.length > MAX_COMPOSER_IMAGE_BYTES) {
          return { ok: false, error: "clipboard_too_large" };
        }
        // Clipboard extensions are untrusted; verify magic bytes before provider delivery or temp storage.
        const detected = sniffComposerImageFormat(buf);
        if (!detected) {
          return { ok: false, error: "not_image" };
        }
        // Canonicalize permissive base64 spellings for downstream validators.
        const canonicalBase64 = buf.toString("base64");
        const img = nativeImage.createFromBuffer(buf);
        const { width, height } = img.getSize();
        const saved = await inClipboardStore(async () => {
          const root = await ensureClipboardImageRoot();
          // Atomically reserve a private directory for this one image.
          const targetDir = await fs.mkdtemp(path.join(root, CLIPBOARD_DIR_PREFIX));
          const filePath = path.join(targetDir, "image." + detected.extension);
          // wx binds the capability to the exact file this process created; its identity is read from the same handle.
          const handle = await fs.open(filePath, "wx", 0o600);
          try {
            await handle.writeFile(buf);
            const stat = await handle.stat({ bigint: true });
            const owned = { dev: stat.dev, ino: stat.ino };
            // The receipt is what lets a later run delete this file; without one the file would be left alone.
            await recordClipboardReceipt(root, path.basename(targetDir), { file: path.basename(filePath), owned });
            return { filePath, owned };
          } finally {
            await handle.close();
          }
        });
        const target = saved.filePath;
        authorizeClipboardTempImage(target, saved.owned);
        const dataUrl = `data:${detected.mimeType};base64,${canonicalBase64}`;
        return {
          ok: true,
          path: target,
          width,
          height,
          bytes: buf.length,
          mimeType: detected.mimeType,
          dataUrl,
        };
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.attach.release,
    async (e, rawPaths: unknown): Promise<ReleaseAttachmentsResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.release, e);
        return { ok: false, error: "unauthorized" };
      }
      if (
        !Array.isArray(rawPaths)
        || rawPaths.length > ATTACH_RELEASE_MAX
        || !rawPaths.every((p): p is string => typeof p === "string")
      ) {
        return { ok: false, error: "invalid-payload" };
      }
      for (const filePath of rawPaths) {
        const held = ATTACH_PATH_ALLOWLIST.get(filePath);
        // Never authorized, or already given back: nothing to do, and nothing a caller can learn from it.
        if (held === undefined) continue;
        if (held > 1) {
          ATTACH_PATH_ALLOWLIST.set(filePath, held - 1);
          continue;
        }
        unauthorizePath(filePath);
        const owned = CLIPBOARD_TEMP_IMAGES.get(filePath);
        if (owned === undefined) continue;
        CLIPBOARD_TEMP_IMAGES.delete(filePath);
        // The authorization is gone either way. A file that cannot be deleted now is left for the sweep at the next start.
        try {
          await inClipboardStore(async () => {
            const directory = path.dirname(filePath);
            const root = path.dirname(directory);
            if (await removeClipboardImageDirectory(directory, path.basename(filePath), owned)) {
              await recordClipboardReceipt(root, path.basename(directory), null);
            }
            await removeClipboardImageRootIfEmpty(root);
          });
        } catch (error) {
          log.warn("clipboard image was not deleted on release (%s)", (error as NodeJS.ErrnoException).code ?? errorMessage(error));
        }
      }
      return { ok: true };
    },
  );
  ipcMain.handle(
    CHANNELS.attach.openExternal,
    async (e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
      if (!validateAppWindowMainFrameSender(e, deps)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.openExternal, e);
        return { ok: false, error: "unauthorized" };
      }
      try {
        // Picker authority and frame-bound preview receipts remain separate.
        if (typeof filePath !== "string" || (!ATTACH_PATH_ALLOWLIST.has(filePath) && !previewFileReadAuthorizes(e, deps, filePath))) {
          return { ok: false, error: "path_not_authorized" };
        }
        const opened = await openVerifiedExternalFile(filePath, (real, pass) => {
          // The entry check above covers the first pass; the frame is re-checked once, just before the open.
          if (pass === "final" && !validateAppWindowMainFrameSender(e, deps)) return "unauthorized";
          return ATTACH_PATH_ALLOWLIST.has(filePath) || previewFileReadAuthorizes(e, deps, real) ? null : "path_not_authorized";
        });
        return opened.ok ? { ok: true } : { ok: false, error: opened.error };
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
        };
      }
    },
  );
}
