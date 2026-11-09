import { app } from "electron";
import { isBackgroundE2eRuntime } from "./e2e-window-presentation.js";

/** Install once before readiness in each test app entrypoint. Foreground fixtures use their own window presentation. */
export function configureE2eWindowPolicy(): void {
  if (app.isPackaged || !isBackgroundE2eRuntime()) return;
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.on("browser-window-created", (_event, window) => {
    window.setFocusable(false);
  });
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window" && contents.getType() !== "webview") return;
    contents.on("dom-ready", () => {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      void contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch((error: unknown) => {
        if (contents.isDestroyed()) return;
        console.error("Test page focus emulation failed", error);
        app.exit(1);
      });
    });
  });
}
