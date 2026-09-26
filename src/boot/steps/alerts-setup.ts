/**
 * Boot step — the plugin alerts pipeline.
 *
 * Built after the marketplace and before plugins start: every plugin start
 * registers its declared kinds with the service, and a boot-time cleanup
 * replay that finishes an uninstall must already find the service listening
 * for `plugin.uninstalled`. The expiry sweep is started later by main.ts via
 * `services.startAlerts` and stopped in `shutdown()`.
 */
import { AlertsService } from "../../alerts/service.js";
import { predecessorBlocks } from "../../alerts/gate.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import { OVERLAY_V1 } from "../../shared/ipc-channels.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { getLocale } from "../../i18n/index.js";
import { emitEvent, onEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";
import type { BootContext } from "../context.js";
import { AsyncResource } from "node:async_hooks";
import { inheritedConfig } from "../../alerts/migration.js";
import { PluginUninstallCleanupJournal, pluginUninstallCleanupJournalPath } from "../../plugins/plugin-uninstall-cleanup-journal.js";
import { withPluginInstallLock } from "../../plugins/install-lifecycle.js";
import { shouldRestartAfterPluginConfigWrite } from "../../plugins/config-restart-policy.js";
import { emitPluginConfigChange } from "../../plugins/config-change-bus.js";

const log = createLogger("alerts");

/**
 * Build the service onto `ctx.alertsService`. Returns the `plugin.uninstalled`
 * unsubscribe: the app listens for its whole life, a test host lets go.
 */
export async function setupAlerts(ctx: BootContext): Promise<() => void> {
  const { settingsService, pluginMarketplace, bootAuditLogger, notificationService } = ctx;
  const liveWindow = () => {
    const win = ctx.getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  // Capture the host boot context, outside any plugin lifecycle hook. A
  // registration may migrate config while start holds its lifecycle lock;
  // its restart must queue behind that start rather than re-enter it.
  const restartMigratedPlugin = AsyncResource.bind((pluginId: string) => {
    if (!shouldRestartAfterPluginConfigWrite({ mutatedCleartextConfig: true, restartUnsafe: false })) return;
    void ctx.pluginRuntime.restartPlugin(pluginId, { skipPreparation: true }).then((result) => {
      if (result !== "started") log.warn(`alert config migration restart for '${pluginId}' returned ${result}`);
    }).catch((err: unknown) => log.warn(`alert config migration restart failed: ${errorMessage(err)}`));
  });
  const service = new AlertsService({
    migration: {
      records: {
        get: () => settingsService.get("retiredPluginConfigs"),
        set: (records) => settingsService.set("retiredPluginConfigs", records),
      },
      installed: async () => (await pluginMarketplace.listInstalledPackages()).map((row) => ({ pluginId: row.name, sourceId: row.sourceId })),
      hasPendingCleanup: (pluginId) => new PluginUninstallCleanupJournal(pluginUninstallCleanupJournalPath(ctx.pluginPaths.cacheRoot)).has(pluginId),
      applyConfig: (pluginId, entries, source) => withPluginInstallLock(pluginId, async () => {
        const current = settingsService.getPluginConfig(pluginId);
        const next = inheritedConfig(current, entries, source);
        if (!next) return false;
        await settingsService.setPluginConfig(pluginId, next);
        ctx.pluginRuntime.setConfigOverride(pluginId, next);
        for (const key of Object.keys(next)) {
          if (!Object.hasOwn(current, key)) emitPluginConfigChange(pluginId, key, next[key]);
        }
        return true;
      }),
      configApplied: (pluginId) => { setImmediate(() => restartMigratedPlugin(pluginId)); },
      warn: (message) => log.warn(message),
    },
    dir: () => openFeatureNamespace("alerts").dir,
    settings: {
      get: () => settingsService.get("alerts"),
      set: (next) => settingsService.set("alerts", next),
    },
    installedPluginIds: async () => (await pluginMarketplace.listInstalledPackages()).map((row) => row.name),
    appVersion: getAveAppVersion(),
    locale: getLocale,
    predecessorBlocks: async (name, sourceHint) => {
      const row = (await pluginMarketplace.listInstalledPackages()).find((entry) => entry.name === name) ?? null;
      // A package whose manifest cannot be read has no version to judge, so it
      // is not revoked: it keeps blocking rather than let two plugins alert.
      const revoked = row?.version != null
        && revocationRegistry.evaluate("plugin", name, row.version).kind === "block";
      return predecessorBlocks({
        installed: row === null ? null : { sourceId: row.sourceId, revoked },
        loaded: ctx.pluginRuntime.listPluginIds().includes(name),
        sourceHint,
      });
    },
    overlay: {
      show: (card) => liveWindow()?.webContents.send(OVERLAY_V1.show, card),
      dismiss: (cardId) => liveWindow()?.webContents.send(OVERLAY_V1.dismiss, cardId),
    },
    notifications: notificationService,
    emit: emitEvent,
    audit: (entry) => bootAuditLogger.log(entry),
  });
  await service.load();
  const handleMigrationChanged = () => {
    void service.reconcileMigration().catch((err: unknown) => log.warn(`alert inheritance failed: ${errorMessage(err)}`));
  };
  const unsubscribeRecords = settingsService.onChanged("retiredPluginConfigs", handleMigrationChanged);
  const unsubscribeChoices = settingsService.onChanged("alerts", handleMigrationChanged);
  await service.reconcileMigration();
  let disposed = false;
  let revision = 0;
  const reconcileRevocations = async () => {
    const current = ++revision;
    const rows = await pluginMarketplace.listInstalledPackages();
    if (disposed || current !== revision) return;
    service.setRevokedPlugins(rows.filter((row) => row.version !== null
      && revocationRegistry.evaluate("plugin", row.name, row.version).kind === "block").map((row) => row.name));
    handleMigrationChanged();
  };
  const handleRevocationsUpdated = () => {
    void reconcileRevocations().catch((err: unknown) => {
      log.warn(`alert revocation reconciliation failed: ${errorMessage(err)}`);
    });
  };
  const unsubscribeRevocations = revocationRegistry.onUpdated(handleRevocationsUpdated);
  const unsubscribeInstalled = onEvent("plugin.installed", handleRevocationsUpdated);
  await reconcileRevocations();
  const unsubscribe = onEvent("plugin.uninstalled", (data) => {
    const pluginId = (data as { pluginId?: unknown } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    service.pluginUninstalled(pluginId).catch((err: unknown) => {
      log.warn(`alerts cleanup for uninstalled plugin '${pluginId}' failed: ${errorMessage(err)}`);
    });
    handleRevocationsUpdated();
  });
  ctx.alertsService = service;
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeInstalled();
    unsubscribeRevocations();
    unsubscribeRecords();
    unsubscribeChoices();
  };
}
