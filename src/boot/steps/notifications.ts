import { logPermissionEvent, permissionLogId } from "../../lib/permission-log.js";
/** Seed authentication partitions before plugin uninstall can run. */
import { NotificationService } from "../../main/notification-service.js";
import {
  readPersistedPluginAuthPartitions,
  writePersistedPluginAuthPartitions,
  deletePersistedPluginAuthPartitions,
  cleanupStaleTmpFiles,
} from "../../main/plugin-auth-partition-store.js";
import {
  wirePluginAuthPartitionPersistence,
  seedPluginAuthPartitions,
} from "../../main/plugin-auth-partition-tracker.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

export async function setupNotifications(ctx: BootContext): Promise<void> {
  const { getMainWindow, aveHomeDocUpgradeMarkers } = ctx;

  // Resolve the live main window after close and reopen.
  const notificationService = new NotificationService({
    getMainWindow,
    ...(ctx.host.desktop?.notificationOptions ?? {
      isReady: () => false,
      isAnyWindowFocused: () => false,
      notificationActivationRegistration: null,
    }),
    isOsNotificationsEnabled: () => ctx.settingsService.get("alerts").osNotificationsEnabled,
  });
  if (aveHomeDocUpgradeMarkers.length > 0) {
    const markerSummary =
      aveHomeDocUpgradeMarkers.length === 1
        ? `~/.ave/${aveHomeDocUpgradeMarkers[0].markerPath}`
        : t("be_boot.upgradeMarkersPlural", { count: String(aveHomeDocUpgradeMarkers.length) });
    notificationService.fire({
      kind: "system",
      title: t("be_boot.upgradeNotificationTitle"),
      body: t("be_boot.upgradeNotificationBody", { markerSummary }),
    });
  }
  // Pass notification service per call rather than retaining a process-global singleton.

  // Persist observed auth partitions so uninstall also wipes partitions from earlier sessions.
  // Sweep interrupted-write tombstones before loading state; sweep failure is non-fatal.
  await cleanupStaleTmpFiles().catch((err: unknown) => {
    log.warn(
      "boot: cleanupStaleTmpFiles failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  // Corrupt partition state aborts startup and reports a warning.
  await readPersistedPluginAuthPartitions()
    .then((persisted) => {
      if (persisted !== null) seedPluginAuthPartitions(persisted);
    })
    .catch((err) => {
      logPermissionEvent("plugin_auth_partition_load_failed", { sessionId: permissionLogId("boot") }, "warn");
      throw err;
    });
  wirePluginAuthPartitionPersistence({
    write: writePersistedPluginAuthPartitions,
    delete: deletePersistedPluginAuthPartitions,
    onError: () => {
      logPermissionEvent("plugin_auth_partition_write_failed", { sessionId: permissionLogId("boot") }, "warn");
    },
  });

  ctx.notificationService = notificationService;
}
