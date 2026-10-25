/**
 * Preview file-read domain IPC handlers.
 * Covers: ave:preview:read-file, ave:preview:read-document
 *
 * Renderer reaches these via window.ave.preview.readFile(path) and
 * window.ave.preview.readDocument(path, sheetIndex). readDocument runs the SAME
 * guard and returns a bounded sheet or page (never source document bytes).
 *
 * SECURITY INVARIANT: the set of files this handler will read for preview is
 * EXACTLY the set the builtin `read_file` tool reads without approval — the
 * guard ({@link assertReadableFilePath}) and text-window core
 * ({@link readTextFileWindow}) are the SAME functions the tool uses
 * (`src/tools/file-read-core.ts`). This IPC adds ZERO new read authority.
 *
 * Not in PUBLIC_CHANNELS → external surfaces (local-api / cli / sdk) can never
 * reach it (fail-closed). Frame-guarded via validateHostRendererSender.
 */
import { ipcMain, type WebContents, type WebFrameMain } from "electron";
import { promises as fs } from "node:fs";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { redactFsPath } from "../../audit/dlp-filter.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import {
  MAX_TEXT_FILE_BYTES,
  assertReadableFilePath,
  isBinaryFile,
  readTextFileWindow,
} from "../../tools/file-read-core.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { buildRuntimeAllowedDirectories } from "../../permissions/allowed-directories.js";
import { errorMessage } from "../../shared/error-message.js";
import { TableDocumentError } from "../../tools/table-document-error.js";
import { readPreviewDocumentInput } from "../../tools/preview-document-input.js";
import { acquireParseSlot } from "../../tools/preview-document-process.js";
import { DOCUMENT_PARSE_MESSAGES } from "../../tools/preview-document-protocol.js";
import { previewPageFormatOf } from "../../shared/preview-page-document.js";
import {
  PREVIEW_DOCUMENT_LIMITS,
  previewDocumentFormatOf,
  type PreviewReadDocumentResult,
} from "../../shared/preview-document.js";

/** Line window read per preview request — matches read_file's default cap. */
const PREVIEW_LINE_LIMIT = 5_000;

export interface PreviewReadFileResult {
  ok: boolean;
  /** UTF-8 text (line-window + byte cap applied). */
  content?: string;
  /** Canonical resolved path (renderer uses the extension to pick a renderer). */
  path?: string;
  /** Original file size in bytes. */
  bytes?: number;
  /** Text was truncated by the line window. */
  truncated?: boolean;
  error?:
    | "unauthorized"
    | "path-not-allowed"
    | "sensitive-path"
    | "not-a-file"
    | "binary-file"
    | "too-large"
    | "read-failed";
  /** English dev detail (IPC Error Language Convention — renderer maps code→Korean). */
  message?: string;
}

/**
 * The runtime allow-list this preview shares with native tool execution.
 * cwd = process.cwd() (anchored to ~/.ave/workspace by ensureWorkspaceCwd);
 * extras = the user's Settings `additionalDirectories` (the same SOT
 * `read_file` consumes). Read fresh each call so a just-added project folder
 * is immediately previewable without a restart.
 */
function currentReadScope(): { cwd: string; extraAllowed: string[] } {
  const cwd = process.cwd();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  return { cwd, extraAllowed: buildRuntimeAllowedDirectories(additional) };
}

function observeDocumentOwner(sender: WebContents, frame: WebFrameMain, abort: () => void): () => void {
  const hasLostFrame = (): boolean => sender.isDestroyed() || frame.isDestroyed() || frame.detached;
  const checkFrame = (): void => { if (hasLostFrame()) abort(); };
  const handleNavigation = (
    _event: unknown, _url: string, _status: number, _statusText: string,
    isMainFrame: boolean, processId: number, routingId: number,
  ): void => {
    if (hasLostFrame() || (isMainFrame && sender.mainFrame === frame)
      || (frame.processId === processId && frame.routingId === routingId)) abort();
  };
  sender.on("destroyed", abort);
  sender.on("render-process-gone", abort);
  sender.on("did-frame-navigate", handleNavigation);
  // Detached frames expose state without a corresponding lifecycle event.
  const timer = setInterval(checkFrame, PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    sender.removeListener("destroyed", abort);
    sender.removeListener("render-process-gone", abort);
    sender.removeListener("did-frame-navigate", handleNavigation);
  };
}

export function registerPreviewHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    CHANNELS.preview.readFile,
    async (e, rawPath: string): Promise<PreviewReadFileResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.preview.readFile, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-file", message: "path must be a non-empty string" };
      }

      const { cwd, extraAllowed } = currentReadScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        // "not-a-file" here means glob/argument, never a concrete file.
        return { ok: false, error: verdict.error, message: `read guard rejected: ${verdict.error}` };
      }
      const resolved = verdict.resolved;

      try {
        // Stat first — refuse to buffer a multi-GB file before opening it.
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          return { ok: false, error: "not-a-file", path: resolved, message: "not a regular file" };
        }
        if (stat.size > MAX_TEXT_FILE_BYTES) {
          return {
            ok: false,
            error: "too-large",
            path: resolved,
            bytes: stat.size,
            message: `file ${stat.size} bytes exceeds ${MAX_TEXT_FILE_BYTES}`,
          };
        }
        if (await isBinaryFile(resolved)) {
          return { ok: false, error: "binary-file", path: resolved, bytes: stat.size, message: "binary file" };
        }
        const window = await readTextFileWindow(resolved, 0, PREVIEW_LINE_LIMIT);
        // Audit the preview read the same way a `read_file` tool call is audited
        // — a file left the sandbox boundary for display. The path is redacted
        // (username stripped) via the shared DLP filter, consistent with the
        // frame-guard audit above.
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "preview-read",
          type: "info",
          input: JSON.stringify({
            channel: CHANNELS.preview.readFile,
            path: redactFsPath(resolved),
            bytes: stat.size,
          }),
        });
        return {
          ok: true,
          content: window.content,
          path: resolved,
          bytes: stat.size,
          truncated: window.truncated,
        };
      } catch (err) {
        return {
          ok: false,
          error: "read-failed",
          path: resolved,
          message: errorMessage(err),
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.preview.readDocument,
    async (e, rawPath: unknown, sheetIndex: unknown): Promise<PreviewReadDocumentResult> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.preview.readDocument, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-file", message: "path must be a non-empty string" };
      }
      if (typeof sheetIndex !== "number" || !Number.isSafeInteger(sheetIndex) || sheetIndex < 0) {
        return { ok: false, error: "invalid-index", message: "sheetIndex must be a non-negative integer" };
      }

      const { cwd, extraAllowed } = currentReadScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        return { ok: false, error: verdict.error, message: `read guard rejected: ${verdict.error}` };
      }
      const resolved = verdict.resolved;
      const format = previewDocumentFormatOf(resolved) ?? previewPageFormatOf(resolved);
      if (!format) {
        return { ok: false, error: "unsupported-format", path: resolved, message: "Unsupported preview document format." };
      }

      try {
        const frame = e.senderFrame;
        if (!frame || !Number.isSafeInteger(e.sender?.id)
          || !Number.isSafeInteger(frame.processId) || !Number.isSafeInteger(frame.routingId)) {
          throw new TableDocumentError("read-failed", "Document sender identity is unavailable.");
        }
        const ownerKey = `${e.sender.id}:${frame.processId}:${frame.routingId}`;
        const controller = new AbortController();
        const abort = (): void => controller.abort(new TableDocumentError("superseded", DOCUMENT_PARSE_MESSAGES.superseded));
        const stopObserving = observeDocumentOwner(e.sender, frame, abort);
        controller.signal.addEventListener("abort", stopObserving, { once: true });
        try {
          if (e.sender.isDestroyed() || frame.isDestroyed() || frame.detached) abort();
          const slot = await acquireParseSlot(ownerKey, controller);
          let inputBytes: number | undefined;
          try {
            if (e.sender.isDestroyed() || frame.isDestroyed() || frame.detached) abort();
            slot.signal.throwIfAborted();
            const bytes = await readPreviewDocumentInput(resolved, slot.signal);
            inputBytes = bytes.length;
            const document = await slot.parse(bytes, format, sheetIndex);
            auditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "preview-read",
              type: "info",
              input: JSON.stringify({
                channel: CHANNELS.preview.readDocument,
                path: redactFsPath(resolved),
                bytes: bytes.length,
                sheetIndex,
              }),
            });
            return { ok: true, path: resolved, bytes: bytes.length, document };
          } catch (err) {
            slot.signal.throwIfAborted();
            if (err instanceof TableDocumentError) {
              return { ok: false, error: err.code, path: resolved, bytes: err.bytes ?? inputBytes, message: err.message };
            }
            throw err;
          } finally {
            slot.release();
          }
        } finally {
          controller.signal.removeEventListener("abort", stopObserving);
          stopObserving();
        }
      } catch (err) {
        if (err instanceof TableDocumentError) {
          return { ok: false, error: err.code, path: resolved, bytes: err.bytes, message: err.message };
        }
        return { ok: false, error: "read-failed", path: resolved, message: errorMessage(err) };
      }
    },
  );
}
