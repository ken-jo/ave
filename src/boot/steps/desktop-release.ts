/** Release initialization is best-effort and must not prevent boot. */
import { resolve } from "node:path";
import { app } from "electron";
import { createAutoUpdater } from "../../main/auto-updater.js";
import { getMainWindow, getMainWindows } from "../../main/app-state.js";
import { startCrashReporter } from "../../main/crash-reporter.js";
import { TelemetryService } from "../../main/telemetry.js";
import { PluginTelemetryClient, relocateDeviceUuid } from "../../telemetry/client.js";
import { consentedTelemetryEndpoint } from "./service-endpoint.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { registerShutdownHook } from "../../main/app-shutdown.js";
import { onEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { CHANNELS } from "../../contract/app-contract.js";
const log = createLogger("ave");

import type { ReleasePrepInput, ReleasePrepOutput } from "./post-boot.js";
export function prepareDesktopRelease(input: ReleasePrepInput): ReleasePrepOutput {
  const { mainWindow, settingsService, bootAuditLogger, networkFetch } = input;
  let telemetry: TelemetryService | undefined;
  let pluginTelemetry: PluginTelemetryClient | undefined;
  let autoUpdaterStop: (() => void) | undefined;

  try {
    // Collect minidumps locally; remoteReporting alone controls whether they leave the machine.
    startCrashReporter({
      userDataPath: app.getPath("userData"),
      telemetry: settingsService.get("telemetry"),
      remoteReporting: input.discretionaryEgress,
    });
    if (!input.discretionaryEgress) {
      log.info("boot: release prep wired (local crash dumps only)");
      return { telemetry, pluginTelemetry, autoUpdaterStop };
    }
    if (!mainWindow) throw new Error("Interactive release services require a main window");
    telemetry = new TelemetryService({
      settings: () => settingsService.get("telemetry"),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      auditLogger: bootAuditLogger,
      fetchImpl: networkFetch,
    });
    telemetry.start();
    telemetry.track("app_start");

    const telemetrySettings = settingsService.get("telemetry");
    if (!telemetrySettings.telemetryPromptAnswered) {
      setTimeout(() => {
        try {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(CHANNELS.telemetry.consentPrompt);
          }
        } catch (e) {
          log.warn("boot: telemetry consent prompt send failed: %s", (e as Error).message);
        }
      }, 500);
    }

    // Preserve device identity while moving telemetry into its feature namespace.
    const deviceUuidPath = resolve(openFeatureNamespace("telemetry").dir, "device-uuid");
    relocateDeviceUuid(resolve(app.getPath("userData"), ".ave", "device-uuid"), deviceUuidPath);
    // Resolve the telemetry endpoint only for opted-in users; announcements have separate consent.
    const ptClient = new PluginTelemetryClient({
      settings: () => settingsService.get("telemetry"),
      endpoint: consentedTelemetryEndpoint(() => settingsService.get("telemetry"), input.serviceClient),
      deviceUuidPath,
      fetchImpl: networkFetch,
    });
    pluginTelemetry = ptClient;
    ptClient.start();

    onEvent("plugin.installed", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_install", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.uninstalled", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_uninstall", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.updated", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_update", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.error", (data) => {
      const d = data as { pluginId?: string; version?: string; errorClass?: string } | undefined;
      ptClient.track("plugin_error", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
        errorClass: d?.errorClass,
      });
    });

    registerShutdownHook("plugin-telemetry-flush", () => {
      try {
        ptClient.stop();
        void ptClient.flush();
      } catch (err) {
        log.warn("shutdown: plugin telemetry final flush failed: %s", (err as Error).message);
      }
    });

    const updater = createAutoUpdater({
      // Live, not the boot window: that one may be closed while others stay open.
      getWindows: getMainWindows,
      getDialogParent: getMainWindow,
      auditLogger: bootAuditLogger,
      isEnabled: () => settingsService.get("updates")?.autoCheckEnabled ?? true,
      getSkippedVersion: () => settingsService.get("updates")?.skippedVersion,
      setSkippedVersion: async (version) => {
        await settingsService.patch({
          updates: {
            ...settingsService.get("updates"),
            skippedVersion: version,
          },
        });
      },
    });
    updater.start();
    autoUpdaterStop = updater.stop;
    const retainedTelemetry = telemetry;
    registerShutdownHook("auto-updater-and-telemetry-flush", () => {
      try { autoUpdaterStop?.(); } catch { /* noop */ }
      try {
        retainedTelemetry.stop();
        void retainedTelemetry.flush();
      } catch (err) {
        log.warn("shutdown: telemetry final flush failed: %s", (err as Error).message);
      }
    });
    log.info("boot: release prep wired (updater/crash/telemetry)");
  } catch (err) {
    log.warn("boot: release prep init failed (non-fatal): %s", (err as Error).message);
  }

  return { telemetry, pluginTelemetry, autoUpdaterStop };
}
