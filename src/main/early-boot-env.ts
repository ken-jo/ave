/**
 * Early boot environment setup — the top-level side effects that MUST run at
 * module load, before `app.whenReady()`:
 *   - workspace cwd anchoring
 *   - privileged custom protocol scheme registration (plugin assets, MCP apps, installed content)
 *   - WSL / GPU command-line switches
 *   - app name + AppUserModelId
 *   - packaged env scrub
 *
 * `src/main.ts` calls `runEarlyBootEnv()` once, near the top of its module
 * body, so the ordering relative to protocol registration and the whenReady
 * gate is identical to the previous inline sequence.
 */
import { app, protocol } from "electron";
import { createLogger } from "../lib/logger.js";
import { ensureWorkspaceCwd } from "./ensure-workspace-cwd.js";
import { PLUGIN_ASSET_CUSTOM_SCHEME } from "./plugin-asset-protocol.js";
import { MCP_APP_CUSTOM_SCHEME } from "./mcp-app-protocol.js";
import { CONTENT_ASSET_CUSTOM_SCHEME } from "./content-asset-protocol.js";
import { scrubPackagedProcessEnv } from "./packaged-env-scrub.js";
import { resolveAppIconPath } from "./app-icon.js";
import {
  readPersistedHardwareAccelerationSync,
  resolveHardwareAcceleration,
} from "./persisted-hardware-acceleration.js";

const log = createLogger("ave");
export const WINDOWS_TOAST_ACTIVATOR_CLSID =
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

  // Electron takes the privileged schemes in a single call before `app.ready`.
  // The MCP-app sandbox-proxy document needs `standard: true` for a real
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
  // `setName` decides where `getPath("userData")` points, so it has to happen
  // before anything reads the profile. The GPU block below reads the settings
  // file out of that directory; with the old ordering it would have read the
  // package-name directory instead and never seen the user's choice.
  app.setName("Ave");

  // Apply the launch preference before readiness. Software rendering still
  // uses a separate display-compositor process; disabling acceleration does
  // not remove that child or protect the app from repeated child failures.
  // Keep the packaged graphics libraries so an enabled preference and native
  // fallback paths remain available.
  if (
    !resolveHardwareAcceleration({
      setting: readPersistedHardwareAccelerationSync(app.getPath("userData")),
      env: process.env,
      platform: process.platform,
    })
  ) {
    app.disableHardwareAcceleration();
  }

  // Windows 10/11 OS notifications require an AppUserModelId — without this,
  // `new Notification(...)` toasts are silently dropped or grouped under the
  // generic "Electron" identity. Issue #260 NotificationService relies on this.
  // Safe to call on all platforms; non-Windows treats it as a no-op.
  app.setAppUserModelId("ai.agent-connector.ave");
  // Electron 43 otherwise creates a fresh random toast activator CLSID when
  // the current-user notification shortcut is absent. Pin a product-owned ID
  // before any Notification presenter can initialize so reinstall/repair does
  // not accumulate orphaned HKCU CLSID registrations.
  if (process.platform === "win32") {
    app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID);
  }

  // Trust-hardening — strip dev/test-only Ave flags from process.env in packaged
  // builds before any preload, renderer, or worker inherits it. Without this
  // scrub, a packaged binary launched with AVE_DEV=1 in the user environment
  // would expose `env.isDev=true` to the renderer (via preload's
  // contextBridge) and let UI code enable dev affordances. Renderer-side flags
  // are advisory rather than load-bearing for trust decisions, but allowing
  // them to flip in packaged builds creates a confusing forensic signal.
  //
  // The prefix scrub catches `AVE_DEV_CONSOLE` (renamed from
  // `AVE_ENABLE_DEV_CONSOLE`) automatically. `AVE_WIN_NO_SANDBOX` is the
  // Windows-only sandbox bypass — it was previously named
  // `AVE_DEV_NO_SANDBOX`, which made it incorrectly look like a dev flag;
  // the rename moves it out of the dev mask but it's still hard-gated on
  // `!app.isPackaged` by `dev-flags.ts:devNoSandboxAllowed()`.
  if (app.isPackaged) {
    scrubPackagedProcessEnv(process.env);
    // Force NODE_ENV=production in packaged builds so downstream gates
    // (preload `__aveDevMode`, dev IPC, auto-compact runtime override) read
    // a reliable signal. Electron itself does not set NODE_ENV, so without
    // this an internal QA build with `NODE_ENV=development` leaking into the
    // env would expose dev affordances in shipped product.
    process.env.NODE_ENV = "production";
  }
}
