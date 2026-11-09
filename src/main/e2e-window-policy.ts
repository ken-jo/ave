import { app } from "electron";
import { isBackgroundE2eRuntime, markFocusEmulated } from "./e2e-window-presentation.js";

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
      contents.setBackgroundThrottling(false);
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      void contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).then(() => { markFocusEmulated(contents); }).catch((error: unknown) => {
        if (contents.isDestroyed()) return;
        console.error("Test page focus emulation failed", error);
        app.exit(1);
      });
    });
  });
}
