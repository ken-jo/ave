import { dialog, ipcMain, nativeImage, shell } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { validateAppWindowMainFrameSender } from "../app-window-sender.js";
import { previewFileReadAuthorizes } from "../../main/preview-file-access.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { DENY_EXTENSIONS as DENY_LIST } from "../../shared/attachments-deny-list.js";
import {
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_COMPOSER_IMAGE_BYTES,
  sniffComposerImageFormat,
} from "../../shared/composer-image-input.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../../permissions/sensitive-paths.js";
import { randomBytes } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";

const DENY_EXTENSIONS = new Set<string>(DENY_LIST);

// Require picker or clipboard authorization before reading or opening paths; bound the app-lifetime allowlist.
const ATTACH_ALLOWLIST_MAX = 10_000;
const ATTACH_PATH_ALLOWLIST = new Set<string>();
// Revoke generated-file capabilities without pathname deletion; replacement races could unlink a user-managed file.
const CLIPBOARD_TEMP_IMAGE_PATHS = new Set<string>();

function authorizePath(p: string): void {
  if (ATTACH_PATH_ALLOWLIST.has(p)) ATTACH_PATH_ALLOWLIST.delete(p);
  ATTACH_PATH_ALLOWLIST.add(p);
  while (ATTACH_PATH_ALLOWLIST.size > ATTACH_ALLOWLIST_MAX) {
    const oldest = ATTACH_PATH_ALLOWLIST.values().next().value;
    if (oldest === undefined) break;
    ATTACH_PATH_ALLOWLIST.delete(oldest);
    CLIPBOARD_TEMP_IMAGE_PATHS.delete(oldest);
  }
}

function authorizeClipboardTempImage(
  filePath: string,
): void {
  authorizePath(filePath);
  CLIPBOARD_TEMP_IMAGE_PATHS.add(filePath);
}

export const DROP_TOKEN_TTL_MS = 60_000;
const DROP_TOKEN_MAX_PENDING = 32;

type DropRejectReason =
  | "denied-extension"
  | "sensitive-path"
  | "not-a-file"
  | "not-found"
  | "too-many";

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

function sensitiveForRead(p: string): boolean {
  return isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(p)), "read") !== null;
}

// Re-resolve authorized spellings on every use; a symlink may have been retargeted.
async function resolveAuthorizedTarget(
  filePath: string,
): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
  let real: string;
  try {
    real = await fs.realpath(filePath);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (sensitiveForRead(real)) return { ok: false, error: "sensitive-path" };
  if (DENY_EXTENSIONS.has(getExt(real))) return { ok: false, error: "denied_extension" };
  return { ok: true, real };
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
  rejected: string[]; // paths rejected by deny-list
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

export interface DiscardClipboardImageResult {
  ok: boolean;
  retained?: true;
  error?: "unauthorized" | "clipboard-image-not-owned";
}

export function registerAttachHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.attach.openFile, async (e): Promise<OpenFileResult> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.attach.openFile, e);
      return { canceled: true, files: [], rejected: [] };
    }
    const win = getMainWindow();
    if (!win) return { canceled: true, files: [], rejected: [] };

    const result = await dialog.showOpenDialog(win, {
      title: t("mainDialog.attachTitle"),
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [], rejected: [] };
    }

    const files: OpenFileResult["files"] = [];
    const rejected: string[] = [];
    for (const p of result.filePaths) {
      const ext = getExt(p);
      if (DENY_EXTENSIONS.has(ext)) {
        rejected.push(p);
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
        rejected.push(p);
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
        const target = await resolveAuthorizedTarget(filePath);
        if (!target.ok) return { ok: false, error: target.error };
        // Stat before buffering so multi-gigabyte files cannot exhaust memory.
        const stat = await fs.stat(target.real);
        if (stat.size > MAX_COMPOSER_IMAGE_BYTES) {
          return {
            ok: false,
            error: `image_too_large: ${stat.size} > ${MAX_COMPOSER_IMAGE_BYTES}`,
          };
        }
        if (!await sniffImageFilePrefix(target.real)) {
          return { ok: false, error: "not_image" };
        }
        const buf = await fs.readFile(target.real);
        if (buf.length > MAX_COMPOSER_IMAGE_BYTES) {
          return {
            ok: false,
            error: `image_too_large: ${buf.length} > ${MAX_COMPOSER_IMAGE_BYTES}`,
          };
        }
        // Re-sniff after the full read so a file replacement race cannot make
        // a claimed image MIME disagree with the bytes sent to a provider.
        const imageFormat = sniffComposerImageFormat(buf);
        if (!imageFormat) {
          return { ok: false, error: "not_image" };
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
          return {
            ok: false,
            error: `clipboard_too_large: ${input.base64.length} > ${MAX_CLIPBOARD_BASE64_INPUT_CHARS}`,
          };
        }
        const buf = Buffer.from(input.base64, "base64");
        if (buf.length > MAX_COMPOSER_IMAGE_BYTES) {
          return {
            ok: false,
            error: `clipboard_too_large: ${buf.length} > ${MAX_COMPOSER_IMAGE_BYTES}`,
          };
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
        // Atomically reserve a private temp directory; random basenames in shared temp still permit races.
        const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "ave-clip-"));
        const target = path.join(targetDir, "image." + detected.extension);
        // wx binds the capability to the exact file this process created.
        await fs.writeFile(target, buf, { flag: "wx", mode: 0o600 });
        authorizeClipboardTempImage(target);
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
    CHANNELS.attach.discardClipboardImage,
    async (e, filePath: unknown): Promise<DiscardClipboardImageResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.attach.discardClipboardImage, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof filePath !== "string") {
        return { ok: false, error: "clipboard-image-not-owned" };
      }
      if (!CLIPBOARD_TEMP_IMAGE_PATHS.has(filePath)) {
        return { ok: false, error: "clipboard-image-not-owned" };
      }

      // Revoke instead of unlinking; no cross-platform compare-and-unlink protects against pathname replacement.
      ATTACH_PATH_ALLOWLIST.delete(filePath);
      CLIPBOARD_TEMP_IMAGE_PATHS.delete(filePath);
      return { ok: true, retained: true };
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
        if (DENY_EXTENSIONS.has(getExt(filePath))) {
          return { ok: false, error: "denied_extension" };
        }
        const target = await resolveAuthorizedTarget(filePath);
        if (!target.ok) return { ok: false, error: target.error };
        const stat = await fs.stat(target.real);
        if (!stat.isFile()) return { ok: false, error: "not-a-file" };
        const current = await resolveAuthorizedTarget(filePath);
        if (!current.ok) return { ok: false, error: current.error };
        if (!validateAppWindowMainFrameSender(e, deps)) return { ok: false, error: "unauthorized" };
        if (current.real !== target.real || (!ATTACH_PATH_ALLOWLIST.has(filePath)
          && !previewFileReadAuthorizes(e, deps, target.real))) return { ok: false, error: "path_not_authorized" };
        const result = await shell.openPath(target.real);
        if (result) return { ok: false, error: result };
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
        };
      }
    },
  );
}
