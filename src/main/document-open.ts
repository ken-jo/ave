import { ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/types.js";
import type { IpcDeps } from "../ipc/types.js";
import { CHANNELS } from "../contract/app-contract.js";
import { auditUnauthorized } from "../ipc/gated.js";
import { validateAppWindowMainFrameSender } from "../ipc/app-window-sender.js";
import { findSessionMainWindowContents, mainWindowForContents } from "./app-state.js";
import { assertReadableFilePath } from "../tools/file-read-core.js";
import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import { buildRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { setDocumentPanelOpener } from "../tools/document-panel-access.js";
import { parseDocumentOpenAck, type DocumentOpenRequest } from "../shared/document-open.js";

interface PendingOpen {
  sender: WebContents;
  frame: WebContents["mainFrame"];
  sessionId: string;
  expiresAt: number;
  finish: (opened: boolean) => void;
}
const pending = new Map<string, PendingOpen>();
let settings: IpcDeps["settingsService"] | undefined;

function unavailable(): ToolExecutionResult {
  return { isError: true, output: JSON.stringify({ ok: false, opened: false, retryable: false, error: "ui-unavailable", message: "The originating document panel is unavailable." }) };
}

function visibleSession(sessionId: string): WebContents | null {
  const sender = findSessionMainWindowContents(sessionId);
  if (!sender || sender.isDestroyed()) return null;
  const window = mainWindowForContents(sender);
  return window?.isVisible() && !window.isMinimized() ? sender : null;
}

/** Install the desktop request receipt. A receipt is bound to one live main frame and conversation. */
export function registerDocumentOpenHandlers(deps: IpcDeps): void {
  settings = deps.settingsService;
  setDocumentPanelOpener(openDocumentForSession);
  ipcMain.handle(CHANNELS.preview.documentOpenAck, (event, raw: unknown) => {
    if (!validateAppWindowMainFrameSender(event, deps)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.preview.documentOpenAck, event);
      return { ok: false, error: "unauthorized" };
    }
    const ack = parseDocumentOpenAck(raw);
    if (!ack) return { ok: false, error: "bad-request" };
    const entry = pending.get(ack.requestId);
    if (!entry) return { ok: false, error: "stale-request" };
    if (entry.sender !== event.sender || entry.frame !== event.senderFrame || entry.sessionId !== ack.sessionId) {
      auditUnauthorized(deps.auditLogger, CHANNELS.preview.documentOpenAck, event);
      return { ok: false, error: "unauthorized" };
    }
    if (Date.now() >= entry.expiresAt || visibleSession(entry.sessionId) !== entry.sender) {
      entry.finish(false);
      return { ok: false, error: "stale-request" };
    }
    entry.finish(ack.opened);
    return { ok: true };
  });
}

/** The caller has authorized a canonical local document. Preview scope is deliberately a separate, narrower preflight. */
export async function openDocumentForSession(path: string, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (context.headless || context.abortSignal?.aborted || !settings) return unavailable();
  const sessionId = context.metadata.sessionId;
  const sender = sessionId ? visibleSession(sessionId) : null;
  if (!sender || !sessionId) return unavailable();
  const scope = readPermissionSettings().permissions.additionalDirectories;
  const verdict = assertReadableFilePath(path, process.cwd(), buildRuntimeAllowedDirectories(scope));
  if (!verdict.ok) return { isError: true, output: JSON.stringify({ ok: false, opened: false, retryable: false, error: verdict.error, message: "Document is outside the panel preview scope." }) };
  const mode = settings.get("documents").openMode;
  if (mode === "link") {
    return { isError: false, output: JSON.stringify({ ok: true, path, mode, opened: false, fileLink: pathToFileURL(path).href }) };
  }
  const requestId = randomUUID();
  const request: DocumentOpenRequest = { requestId, sessionId, path, expiresAt: Date.now() + TOOL_TIMEOUT_POLICY.documentPanelAckMs };
  const opened = await new Promise<boolean>((resolve) => {
    const finish = (success: boolean): void => {
      if (!pending.delete(requestId)) return;
      clearTimeout(timer);
      sender.removeListener("destroyed", cancel);
      sender.removeListener("render-process-gone", cancel);
      sender.removeListener("did-start-navigation", cancel);
      context.abortSignal?.removeEventListener("abort", cancel);
      resolve(success);
    };
    const cancel = (): void => finish(false);
    const timer = setTimeout(cancel, TOOL_TIMEOUT_POLICY.documentPanelAckMs);
    timer.unref?.();
    pending.set(requestId, { sender, frame: sender.mainFrame, sessionId, expiresAt: request.expiresAt, finish });
    sender.once("destroyed", cancel);
    sender.once("render-process-gone", cancel);
    sender.once("did-start-navigation", cancel);
    context.abortSignal?.addEventListener("abort", cancel, { once: true });
    try { sender.send(CHANNELS.preview.documentOpenRequest, request); }
    catch { cancel(); }
  });
  return opened ? { isError: false, output: JSON.stringify({ ok: true, path, mode: "direct", opened: true }) } : unavailable();
}
