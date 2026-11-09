import { app } from "electron";
import { isBackgroundE2eRuntime } from "./e2e-window-presentation.js";

/** Install once before readiness in each test app entrypoint. Foreground fixtures use their own window presentation. */
export function configureE2eWindowPolicy(): void {
  if (app.isPackaged || !isBackgroundE2eRuntime()) return;
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.on("browser-window-created", (_event, window) => {
    window.setFocusable(false);
  });

}
