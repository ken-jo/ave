// Use the shared app version; the runtime's version API reports the binary version in unpackaged runs.
// The host-renderer guard is the disclosure boundary for this unprojected response.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import type { AppRelaunchResult } from "../../shared/app-relaunch.js";
import { hasPluginInstallInFlight } from "../../plugins/install-lifecycle.js";
import { isAppUpdateInstallRequested } from "../../main/app-update-install-intent.js";

export function registerAppHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  ipcMain.handle(CHANNELS.app.relaunch, (event, payload: unknown): AppRelaunchResult => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.app.relaunch, event);
      return { ok: false, error: "unauthorized-frame" };
    }
    const intent = payload && typeof payload === "object" && "intent" in payload ? payload.intent : undefined;
    if (!hasUserKeyboardIntent(intent)) return { ok: false, error: "user-keyboard-required" };
    if (hasPluginInstallInFlight()) return { ok: false, error: "plugin-install-in-progress" };
    if (isAppUpdateInstallRequested()) return { ok: false, error: "update-install-in-progress" };
    if (!deps.relaunchApp) return { ok: false, error: "relaunch-unsupported" };
    try {
      deps.relaunchApp();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message === "relaunch-unsupported"
        ? "relaunch-unsupported" : "relaunch-failed" };
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
