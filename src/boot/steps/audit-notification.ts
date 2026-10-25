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
import type { DesktopHostCapabilities } from "../host-runtime.js";

const log = createLogger("ave");

/** Initialize the presenter at boot so Windows toast activation is registered before any notification. */
function initializeOsNotificationPresenter(
  desktop: Pick<DesktopHostCapabilities, "initializeNotificationPresenter"> | undefined,
): void {
  if (!desktop) return;
  const supported = desktop.initializeNotificationPresenter();
  log.info("boot: OS notification presenter initialised (supported=%s)", supported);
}

export async function setupAuditAndNotification(ctx: BootContext): Promise<void> {
  const { getMainWindow, aveHomeDocUpgradeMarkers } = ctx;

  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { ensureAuditSecret } = await import("../../audit/hmac-chain.js");
  const { createHostSecretStore } = await import("../../audit/host-secret-store.js");
  const bootAuditLogger = new AuditLogger();
  const permissionAuditSecretStore = createHostSecretStore(ctx.host.encryption);
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
    isTurnCompletionSoundEnabled: () => ctx.settingsService.get("system").turnCompletionSoundEnabled ?? true,
    isOsNotificationsEnabled: () => ctx.settingsService.get("alerts").osNotificationsEnabled,
  });
  initializeOsNotificationPresenter(ctx.host.desktop);
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
      const msg = (err as Error).message;
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        input: "plugin-auth-partition-store: load failed at boot",
        output: msg,
      });
      await bootAuditLogger.flush();
      throw err;
    });
  wirePluginAuthPartitionPersistence({
    write: writePersistedPluginAuthPartitions,
    delete: deletePersistedPluginAuthPartitions,
    onError: (msg) => {
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        input: "plugin-auth-partition-store: async write/delete failed",
        output: msg,
      });
    },
  });

  ctx.bootAuditLogger = bootAuditLogger;
  ctx.notificationService = notificationService;
}
