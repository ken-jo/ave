import { logPermissionEvent, permissionLogId } from "../../lib/permission-log.js";
/** Share one audit writer across plugins, hooks, and approvals; seed auth partitions before uninstall can run. */
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

export async function setupAuditAndNotification(ctx: BootContext): Promise<void> {
  const { getMainWindow, aveHomeDocUpgradeMarkers } = ctx;

  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { ensureAuditSecret } = await import("../../audit/hmac-chain.js");
  const { createHostSecretStore } = await import("../../audit/host-secret-store.js");
  const bootAuditLogger = new AuditLogger();
  const permissionAuditSecretStore = await createHostSecretStore(ctx.host.encryption, undefined, () => true);
  await bootAuditLogger.setupPermissionAuditChain(
    ensureAuditSecret(permissionAuditSecretStore),
    permissionAuditSecretStore,
  );

  // Rotation must drain the runtime writer’s queue, not a separate maintenance logger.
  const runAuditMaintenance = () => {
    const auditCfg = ctx.settingsService.get("audit");
    void bootAuditLogger.rotateAndPrune({
      maxBytes: auditCfg.auditRotationMaxBytes,
      retentionDays: auditCfg.auditRetentionDays,
    }).catch((err: unknown) => {
      log.warn({ err }, "rotateAndPrune failed");
    });
  };
  runAuditMaintenance();
  const auditMaintenanceTimer = setInterval(runAuditMaintenance, 60 * 60 * 1000);
  auditMaintenanceTimer.unref?.();

  // Resolve the live main window after close and reopen.
  const notificationService = new NotificationService({
    getMainWindow,
    auditLogger: bootAuditLogger,
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
  // Corrupt partition state must throw with an audit record rather than become an empty set.
  await readPersistedPluginAuthPartitions()
    .then((persisted) => {
      if (persisted !== null) seedPluginAuthPartitions(persisted);
    })
    .catch(async (err) => {
      logPermissionEvent("plugin_auth_partition_load_failed", { sessionId: permissionLogId("boot") }, "warn");
      throw err;
    });
  wirePluginAuthPartitionPersistence({
    write: writePersistedPluginAuthPartitions,
    delete: deletePersistedPluginAuthPartitions,
    onError: (_msg) => {
      logPermissionEvent("plugin_auth_partition_write_failed", { sessionId: permissionLogId("boot") }, "warn");
    },
  });

  ctx.bootAuditLogger = bootAuditLogger;
  ctx.notificationService = notificationService;
}
