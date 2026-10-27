/**
 * Preview file-read domain IPC handlers.
 * Covers: ave:preview:read-file, ave:preview:read-document
 *
 * Renderer reaches these via window.ave.preview.readFile(path) and
 * window.ave.preview.readDocument(path, sheetIndex). readDocument runs the SAME
 * guard and returns a bounded sheet or page (never source document bytes).
 *
 * Preview reads always use the allowed-root guard, independently of the
 * native agent read policy's optional directory fencing. Text windows share
 * readTextFileWindow; this IPC does not widen either caller's read authority.
 *
 * Not in PUBLIC_CHANNELS → external surfaces (local-api / cli / sdk) can never
 * reach it (fail-closed). Restricted to registered app-window main frames.
 */
import { ipcMain, type WebContents, type WebFrameMain } from "electron";
import { registerDocumentOpenHandlers } from "../../main/document-open.js";
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { auditUnauthorized } from "../gated.js";
import { validateAppWindowMainFrameSender } from "../app-window-sender.js";
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
import { installDocumentObservation } from "../../main/document-observation.js";
import { parseObservedTextDocument } from "../../observation/text-document.js";
import { recordPreviewFileAccess } from "../../main/preview-file-access.js";
import { OBSERVATION_LIMITS, type DocumentObservationBinding, type PreviewObservedTextDocument } from "../../shared/agent-observation.js";
import { acquireParseSlot } from "../../tools/preview-document-process.js";
import { DOCUMENT_PARSE_MESSAGES } from "../../tools/preview-document-protocol.js";
import { previewPageFormatOf } from "../../shared/preview-page-document.js";
import { sniffComposerImageFormat } from "../../shared/composer-image-input.js";
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
  lineCount?: number;
  observation?: DocumentObservationBinding;
  document?: PreviewObservedTextDocument;
  /** Signature-verified passive image bytes; line-window requests remain text-only. */
  image?: { dataUrl: string; mimeType: string };
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

interface TextPreviewRequest {
  controller: AbortController;
  stop: () => void;
}

export function registerPreviewHandlers(deps: IpcDeps): void {
  registerDocumentOpenHandlers(deps);
  const { auditLogger } = deps;
  const observation = installDocumentObservation(deps);
  const textRequests = new Map<string, TextPreviewRequest>();
  ipcMain.handle(CHANNELS.preview.observationAck, (e, request: unknown) => {
    if (!validateAppWindowMainFrameSender(e, deps)) {
      auditUnauthorized(auditLogger, CHANNELS.preview.observationAck, e);
      return { ok: false, error: "unauthorized" };
    }
    return observation.acknowledge(e, request);
  });

  ipcMain.handle(
    CHANNELS.preview.readFile,
    async (e, rawPath: string, rawWindow?: unknown): Promise<PreviewReadFileResult> => {
      if (!validateAppWindowMainFrameSender(e, deps)) {
        auditUnauthorized(auditLogger, CHANNELS.preview.readFile, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-file", message: "path must be a non-empty string" };
      }

      let offset = 0;
      let limit = PREVIEW_LINE_LIMIT;
      let workspaceRoot: string | undefined;
      let sessionId: string | undefined;
      let hasLineWindow = false;
      if (rawWindow !== undefined) {
        if (!rawWindow || typeof rawWindow !== "object" || Array.isArray(rawWindow)
          || Object.keys(rawWindow).some((key) => !["offset", "limit", "workspaceRoot", "sessionId"].includes(key))) {
          return { ok: false, error: "read-failed", message: "Invalid preview window" };
        }
        const window = rawWindow as Record<string, unknown>;
        if ((window.offset !== undefined && (!Number.isSafeInteger(window.offset) || (window.offset as number) < 0))
          || (window.limit !== undefined && (!Number.isSafeInteger(window.limit) || (window.limit as number) < 1))
          || (window.workspaceRoot !== undefined && (typeof window.workspaceRoot !== "string"
            || window.workspaceRoot.length > 2_048 || !isAbsolute(window.workspaceRoot)))
          || (window.sessionId !== undefined && (typeof window.sessionId !== "string"
            || window.sessionId.length === 0 || window.sessionId.length > 256))) {
          return { ok: false, error: "read-failed", message: "Invalid preview window" };
        }
        offset = window.offset as number | undefined ?? 0;
        limit = Math.min(window.limit as number | undefined ?? PREVIEW_LINE_LIMIT, PREVIEW_LINE_LIMIT);
        workspaceRoot = window.workspaceRoot as string | undefined;
        sessionId = window.sessionId as string | undefined;
        hasLineWindow = window.offset !== undefined || window.limit !== undefined;
      }

      const { cwd, extraAllowed } = currentReadScope();
      const requestedPath = workspaceRoot === undefined ? rawPath : resolve(workspaceRoot, rawPath);
      const verdict = assertReadableFilePath(requestedPath, cwd, extraAllowed);
      if (!verdict.ok) {
        // "not-a-file" here means glob/argument, never a concrete file.
        return { ok: false, error: verdict.error, message: `read guard rejected: ${verdict.error}` };
      }
      const resolved = verdict.resolved;
      let request: TextPreviewRequest | undefined;
      let ownerKey: string | undefined;
      if (!hasLineWindow && sessionId !== undefined) {
        const frame = e.senderFrame;
        if (!frame || !Number.isSafeInteger(e.sender.id) || !Number.isSafeInteger(frame.processId)
          || !Number.isSafeInteger(frame.routingId)) {
          return { ok: false, error: "read-failed", message: "Preview sender identity is unavailable." };
        }
        ownerKey = JSON.stringify([e.sender.id, frame.processId, frame.routingId, resolved]);
        const previous = textRequests.get(ownerKey);
        if (!previous && textRequests.size >= OBSERVATION_LIMITS.maxViews) {
          return { ok: false, error: "read-failed", message: "Preview request limit exceeded." };
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort(new TableDocumentError("superseded", "Preview read was superseded."));
        const stop = observeDocumentOwner(e.sender, frame, abort);
        controller.signal.addEventListener("abort", stop, { once: true });
        request = { controller, stop };
        textRequests.set(ownerKey, request);
        previous?.controller.abort(new TableDocumentError("superseded", "Preview read was superseded."));
      }

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
        request?.controller.signal.throwIfAborted();
        const input = hasLineWindow ? undefined : await readPreviewDocumentInput(resolved, request?.controller.signal, MAX_TEXT_FILE_BYTES);
        request?.controller.signal.throwIfAborted();
        const imageFormat = input ? sniffComposerImageFormat(input) : null;
        if (!imageFormat && await isBinaryFile(resolved)) {
          return { ok: false, error: "binary-file", path: resolved, bytes: stat.size, message: "binary file" };
        }
        const textDocument = !imageFormat && input && sessionId !== undefined ? parseObservedTextDocument(input) : undefined;
        const window = imageFormat ? undefined : textDocument
          ? { content: textDocument.content, lines: textDocument.lines, truncated: textDocument.truncated }
          : await readTextFileWindow(resolved, offset, limit);
        const liveScope = currentReadScope();
        const currentVerdict = assertReadableFilePath(requestedPath, liveScope.cwd, liveScope.extraAllowed);
        if (!currentVerdict.ok || currentVerdict.resolved !== resolved) {
          return { ok: false, error: currentVerdict.ok ? "read-failed" : currentVerdict.error, message: "Preview read scope changed" };
        }
        if (!validateAppWindowMainFrameSender(e, deps)) return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
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
            bytes: input?.length ?? stat.size,
          }),
        });
        if (request && (request.controller.signal.aborted || textRequests.get(ownerKey!) !== request)) {
          return { ok: false, error: "read-failed", message: "Preview read was superseded." };
        }
        const binding = textDocument && input ? observation.registerView(e, sessionId, resolved, input, textDocument) : undefined;
        if (!hasLineWindow) recordPreviewFileAccess(e, deps, resolved, sessionId);
        return {
          ok: true,
          ...(imageFormat && input ? { image: { dataUrl: `data:${imageFormat.mimeType};base64,${input.toString("base64")}`, mimeType: imageFormat.mimeType } }
            : { content: window!.content, truncated: window!.truncated, lineCount: window!.lines.length }),
          path: resolved,
          bytes: input?.length ?? stat.size,
          ...(binding ? { observation: binding, document: textDocument } : {}),
        };
      } catch (err) {
        if (err instanceof TableDocumentError) return { ok: false, error: err.code === "too-large" ? "too-large" : err.code === "not-a-file" ? "not-a-file" : "read-failed", path: resolved, message: err.message };
        return {
          ok: false,
          error: "read-failed",
          path: resolved,
          message: errorMessage(err),
        };
      } finally {
        request?.stop();
        if (request && textRequests.get(ownerKey!) === request) textRequests.delete(ownerKey!);
      }
    },
  );
  ipcMain.handle(
    CHANNELS.preview.readDocument,
    async (e, rawPath: unknown, sheetIndex: unknown, sessionId?: unknown): Promise<PreviewReadDocumentResult> => {
      if (!validateAppWindowMainFrameSender(e, deps)) {
        auditUnauthorized(auditLogger, CHANNELS.preview.readDocument, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      const frame = e.senderFrame;
      if (!frame || !Number.isSafeInteger(e.sender?.id)
        || !Number.isSafeInteger(frame.processId) || !Number.isSafeInteger(frame.routingId)) {
        return { ok: false, error: "read-failed", message: "Document sender identity is unavailable." };
      }
      const ownerKey = `${e.sender.id}:${frame.processId}:${frame.routingId}`;
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
        const controller = new AbortController();
        const abort = (): void => controller.abort(new TableDocumentError("superseded", DOCUMENT_PARSE_MESSAGES.superseded));
        const stopObserving = observeDocumentOwner(e.sender, frame, abort);
        controller.signal.addEventListener("abort", stopObserving, { once: true });
        try {
          if (e.sender.isDestroyed() || frame.isDestroyed() || frame.detached) abort();
          const slot = await acquireParseSlot(ownerKey, controller);
          let engine: ReturnType<typeof observation.acquirePreviewEngine> | undefined;
          let inputBytes: number | undefined;
          try {
            if (e.sender.isDestroyed() || frame.isDestroyed() || frame.detached) abort();
            slot.signal.throwIfAborted();
            if (!validateAppWindowMainFrameSender(e, deps)) {
              return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
            }
            const bytes = await readPreviewDocumentInput(resolved, slot.signal);
            inputBytes = bytes.length;
            if (!validateAppWindowMainFrameSender(e, deps)) {
              auditUnauthorized(auditLogger, CHANNELS.preview.readDocument, e);
              return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
            }
            engine = observation.acquirePreviewEngine(e, sessionId, resolved, async (input, inputFormat, index, signal) => {
              const handleAbort = (): void => controller.abort(signal.reason);
              signal.addEventListener("abort", handleAbort, { once: true });
              if (signal.aborted) handleAbort();
              try { return await slot.parse(input, inputFormat, index); }
              finally { signal.removeEventListener("abort", handleAbort); }
            });
            const document = await engine.parse(bytes, format, sheetIndex, slot.signal);
            if (!validateAppWindowMainFrameSender(e, deps)) {
              auditUnauthorized(auditLogger, CHANNELS.preview.readDocument, e);
              return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
            }
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
            const scope = currentReadScope();
            const currentVerdict = assertReadableFilePath(resolved, scope.cwd, scope.extraAllowed);
            if (!currentVerdict.ok || currentVerdict.resolved !== resolved) {
              return { ok: false, error: "path-not-allowed", message: "Preview read scope changed" };
            }
            const binding = observation.registerView(e, sessionId, resolved, bytes, document);
            recordPreviewFileAccess(e, deps, resolved, sessionId);
            return { ok: true, path: resolved, bytes: bytes.length, document, ...(binding ? { observation: binding } : {}) };
          } catch (err) {
            slot.signal.throwIfAborted();
            if (err instanceof TableDocumentError) {
              return { ok: false, error: err.code, path: resolved, bytes: err.bytes ?? inputBytes, message: err.message };
            }
            throw err;
          } finally {
            engine?.release();
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
