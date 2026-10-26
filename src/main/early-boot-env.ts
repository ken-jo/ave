// Run before app.whenReady(): protocol privileges and command-line switches must precede network-service startup.
import { app, protocol } from "electron";
import { createLogger } from "../lib/logger.js";
import { ensureWorkspaceCwd } from "./ensure-workspace-cwd.js";
import { PLUGIN_ASSET_CUSTOM_SCHEME } from "./plugin-asset-protocol.js";
import { MCP_APP_CUSTOM_SCHEME } from "./mcp-app-protocol.js";
import { CONTENT_ASSET_CUSTOM_SCHEME } from "./content-asset-protocol.js";
import { scrubPackagedProcessEnv } from "./packaged-env-scrub.js";
import { applyAppUserAgentFallback } from "./browser-user-agent.js";
import { resolveAppIconPath } from "./app-icon.js";
import {
  readPersistedHardwareAccelerationSync,
  resolveHardwareAcceleration,
} from "./persisted-hardware-acceleration.js";

const log = createLogger("ave");
const WINDOWS_TOAST_ACTIVATOR_CLSID =
  "{62FD3EFB-B3D2-4235-9402-6979F52C0286}";

export function applyRuntimeAppIcon() {
  const iconPath = resolveAppIconPath();
  if (iconPath && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
}

export function runEarlyBootEnv(): void {
  const workspaceCwd = ensureWorkspaceCwd();
  log.info({ workspaceCwd }, "main: cwd anchored to ~/.ave/workspace");

  // Electron takes the privileged schemes in a single call before `app.ready`. The MCP-app sandbox-proxy document needs `standard: true` for a real
  // origin; installed fonts and theme previews load from `ave-content:`.
  protocol.registerSchemesAsPrivileged([PLUGIN_ASSET_CUSTOM_SCHEME, MCP_APP_CUSTOM_SCHEME, CONTENT_ASSET_CUSTOM_SCHEME]);

  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
    if (process.env.WAYLAND_DISPLAY) {
      app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
    } else if (process.env.DISPLAY) {
      app.commandLine.appendSwitch("ozone-platform-hint", "x11");
    }
  }
  // Set the app name before any userData read, including GPU preferences, so settings resolve to the correct profile.
  app.setName("Ave");
  // Before any session or net.request exists, so the default session never carries the Electron token.
  applyAppUserAgentFallback();

  // Apply acceleration before readiness; software rendering still has a compositor child and requires packaged graphics libraries.
  if (
    !resolveHardwareAcceleration({
      setting: readPersistedHardwareAccelerationSync(app.getPath("userData")),
      env: process.env,
      platform: process.platform,
    })
  ) {
    app.disableHardwareAcceleration();
  }

  // Windows notifications require an AppUserModelId to appear under the app identity; other platforms treat this as a no-op.
  app.setAppUserModelId("ai.agent-connector.ave");
  // Electron 43 otherwise creates a fresh random toast activator CLSID when the current-user notification shortcut is absent. Pin a product-owned ID
  // before any Notification presenter can initialize so reinstall/repair does not accumulate orphaned HKCU CLSID registrations.
  if (process.platform === "win32") {
    app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID);
  }

  // Scrub development and test flags before packaged children inherit them so diagnostic signals reflect shipped behavior.
  if (app.isPackaged) {
    scrubPackagedProcessEnv(process.env);
    // Force production mode in packaged builds; the runtime does not set it and inherited development values enable dev affordances.
    process.env.NODE_ENV = "production";
  }
}
