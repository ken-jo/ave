// Use the shared app version; the runtime's version API reports the binary version in unpackaged runs.
// The host-renderer guard is the disclosure boundary for this unprojected response.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import type { AppRelaunchError, AppRelaunchResult } from "../../shared/app-relaunch.js";
import { hasMarketplaceInstallInFlight } from "../../marketplace/app/install-lifecycle.js";
import { isAppUpdateInstallRequested } from "../../main/app-update-install-intent.js";
import { isAppRelaunchRequested, setAppRelaunchRequested } from "../../main/app-relaunch-state.js";

export function registerAppHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  ipcMain.handle(CHANNELS.app.relaunch, (event, payload: unknown): AppRelaunchResult => {
    const refuse = (error: AppRelaunchError): AppRelaunchResult => {
      auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "ipc-guard", type: "warn",
        input: JSON.stringify({ channel: CHANNELS.app.relaunch, error }) });
      return { ok: false, error };
    };
    const window = deps.getMainWindow();
    const mainFrame = event.senderFrame !== null && event.senderFrame === event.sender?.mainFrame;
    if (!validateHostRendererSender(event) || !mainFrame || !window || window.isDestroyed() || window.webContents !== event.sender) {
      auditUnauthorized(auditLogger, CHANNELS.app.relaunch, event);
      return { ok: false, error: "unauthorized-frame" };
    }
    const intent = payload && typeof payload === "object" && "intent" in payload ? payload.intent : undefined;
    if (!hasUserKeyboardIntent(intent)) return refuse("user-keyboard-required");
    if (isAppRelaunchRequested()) return refuse("relaunch-in-progress");
    if (hasMarketplaceInstallInFlight()) return refuse("plugin-install-in-progress");
    if (isAppUpdateInstallRequested()) return refuse("update-install-in-progress");
    if (!deps.relaunchApp) return refuse("relaunch-unsupported");
    setAppRelaunchRequested(true);
    try {
      deps.relaunchApp();
      return { ok: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code !== "relaunch-in-progress") setAppRelaunchRequested(false);
      return refuse(code === "relaunch-unsupported" || code === "relaunch-in-progress" ? code : "relaunch-failed");
    }
  });
  ipcMain.handle(CHANNELS.app.info, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.app.info, e);
      return UNAUTHORIZED_FRAME;
    }
    const { app } = await import("electron");
    return {
      version: getAveAppVersion(),
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node ?? "",
      chromeVersion: process.versions.chrome ?? "",
      v8Version: process.versions.v8 ?? "",
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath("userData"),
    };
  });
}
