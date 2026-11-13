import { app } from "electron";
import { beginFocusEmulation, isBackgroundE2eRuntime } from "./e2e-window-presentation.js";
import { isAppQuitRequested } from "./app-quit-intent.js";

/**
 * Install once before readiness in each test app entrypoint. Foreground fixtures use their own window presentation.
 * macOS may hand activation to an accessory app whose window is ordered front when another app quits or deactivates, so
 * the owner's keystrokes would land in a test window. A prohibited app cannot be activated by anyone; its windows still
 * render, report visible, and take page input through the protocol.
 */
export function configureE2eWindowPolicy(): void {
  if (app.isPackaged || !isBackgroundE2eRuntime()) return;
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  app.on("browser-window-created", (_event, window) => {
    window.setFocusable(false);
  });
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window" && contents.getType() !== "webview") return;
    contents.on("dom-ready", () => {
      if (isAppQuitRequested() || contents.isDestroyed()) return;
      contents.setBackgroundThrottling(false);
      const confirmFocusEmulated = beginFocusEmulation(contents);
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      void contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).then(confirmFocusEmulated).catch((error: unknown) => {
        if (isAppQuitRequested() || contents.isDestroyed()) return;
        console.error("Test page focus emulation failed", error);
        app.exit(1);
      });
    });
  });
}
