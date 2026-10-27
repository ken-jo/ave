import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import {
  DocumentEngineInstallError,
  getDocumentEngineInstallationState,
  initializeDocumentEngineInstallationNetwork,
  installDocumentEngine,
  uninstallDocumentEngine,
} from "../../main/document-engine-installation.js";
import { cleanupStaleDocumentEngineRuntimes, stopHostDocumentEngineSessions } from "../../observation/document-engine-host.js";
import type { DocumentEngineInstallationError, DocumentEngineInstallationState } from "../../shared/document-engine.js";
import type { DocumentEngineActionResult, DocumentEngineStatusResult } from "../../shared/document-engine-api.js";
import { errorMessage } from "../../shared/error-message.js";
import { createLogger } from "../../lib/logger.js";
import { validateAppWindowMainFrameSender } from "../app-window-sender.js";
import { auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("document-engine");

interface InstallationOperation {
  kind: "install" | "uninstall";
  controller: AbortController;
  completion: Promise<void>;
}

/** Installation has one local owner; preview/observation never authorizes an install. */
export function registerDocumentEngineHandlers(deps: IpcDeps): void {
  initializeDocumentEngineInstallationNetwork(deps.singleHopNetworkFetch);
  // Boot hygiene only: a failed sweep leaves stale private directories behind but never blocks the engine.
  void cleanupStaleDocumentEngineRuntimes().then(
    (removed) => { if (removed > 0) log.info("removed %d stale document engine runtime directories", removed); },
    (error: unknown) => { log.warn("stale document engine runtime cleanup failed: %s", errorMessage(error)); });
  let operation: InstallationOperation | undefined;
  let state: DocumentEngineInstallationState | undefined;

  const authorize = (event: IpcMainInvokeEvent, channel: string, args: readonly unknown[]): DocumentEngineActionResult | undefined => {
    if (!validateAppWindowMainFrameSender(event, deps)) {
      auditUnauthorized(deps.auditLogger, channel, event);
      return { ok: false, error: "unauthorized" };
    }
    if (args.length !== 0) return { ok: false, error: "bad-request" };
    return undefined;
  };
  const failure = (error: unknown): DocumentEngineInstallationError => {
    const code = error instanceof DocumentEngineInstallError ? error.code : "install-failed";
    deps.auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "document-engine-installation",
      type: "error", output: errorMessage(error) });
    return code;
  };
  const refresh = async (): Promise<DocumentEngineInstallationState> => {
    const current = await getDocumentEngineInstallationState();
    state = current;
    return current;
  };

  ipcMain.handle(CHANNELS.documentEngine.status, async (event, ...args: unknown[]): Promise<DocumentEngineStatusResult> => {
    const denied = authorize(event, CHANNELS.documentEngine.status, args);
    if (denied && !denied.ok) return denied;
    try {
      return { ok: true, state: state && (operation || state.phase === "error") ? state : await refresh() };
    } catch (error) {
      return { ok: false, error: failure(error) };
    }
  });

  ipcMain.handle(CHANNELS.documentEngine.install, async (event, ...args: unknown[]): Promise<DocumentEngineActionResult> => {
    const denied = authorize(event, CHANNELS.documentEngine.install, args);
    if (denied) return denied;
    if (operation) return { ok: false, error: "busy" };
    const controller = new AbortController();
    const current: InstallationOperation = { kind: "install", controller, completion: Promise.resolve() };
    operation = current;
    let initial: DocumentEngineInstallationState;
    try {
      initial = await refresh();
      controller.signal.throwIfAborted();
    } catch (error) {
      if (operation === current) operation = undefined;
      return { ok: false, error: controller.signal.aborted ? "cancelled" : failure(error) };
    }
    if (initial.phase === "ready") {
      operation = undefined;
      return { ok: true };
    }
    // A platform that cannot confine the engine is never offered a download it could not run.
    if (initial.phase === "unsupported") {
      operation = undefined;
      return { ok: false, error: "unsupported-platform" };
    }
    state = { ...initial, phase: "downloading", error: undefined };
    current.completion = (async () => {
      try {
        controller.signal.throwIfAborted();
        await installDocumentEngine((next) => { state = next; }, controller.signal);
        await refresh();
      } catch (error) {
        const code = controller.signal.aborted ? "cancelled" : failure(error);
        state = { ...state!, phase: "error", error: code };
      } finally {
        if (operation === current) operation = undefined;
      }
    })();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.documentEngine.cancel, async (event, ...args: unknown[]): Promise<DocumentEngineActionResult> => {
    const denied = authorize(event, CHANNELS.documentEngine.cancel, args);
    if (denied) return denied;
    const current = operation;
    if (!current) return { ok: true };
    if (current.kind !== "install") return { ok: false, error: "busy" };
    if (state) state = { ...state, phase: "cancelling" };
    current.controller.abort();
    await current.completion;
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.documentEngine.uninstall, async (event, ...args: unknown[]): Promise<DocumentEngineActionResult> => {
    const denied = authorize(event, CHANNELS.documentEngine.uninstall, args);
    if (denied) return denied;
    if (operation) return { ok: false, error: "busy" };
    const current: InstallationOperation = { kind: "uninstall", controller: new AbortController(), completion: Promise.resolve() };
    operation = current;
    try {
      current.completion = (async () => {
        await uninstallDocumentEngine(stopHostDocumentEngineSessions);
        await refresh();
      })();
      await current.completion;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: failure(error) };
    } finally {
      if (operation === current) operation = undefined;
    }
  });
}
