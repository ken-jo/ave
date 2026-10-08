/**
 * Boot step — shared audit logger, notification service, and plugin
 * auth-partition tracker seeding (§4.2, extracted from boot.ts C18).
 *
 * The AuditLogger built here is the SINGLE instance shared by the plugin
 * runtime, hooks, and approval gate. The NotificationService is constructed
 * up-front so every lifecycle cue (turn-end / routine / ask-user / approval /
 * plugin / system) can fire against a live mainWindow getter, and the OS
 * notification presenter is created with it. Finally the
 * in-memory plugin-auth-partition tracker is seeded from disk (#748) with
 * persistence callbacks wired so later observations flush to disk.
 */
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

/**
 * Create the OS notification presenter at boot rather than at the first cue.
 * On Windows this is when Electron registers the per-user Start Menu shortcut
 * and the toast activator CLSID, so both exist before any notification and
 * the uninstaller can remove what the app registered
 * (`scripts/smoke-windows-nsis-installer.mjs` asserts each step). Until
 * 0.13.0 this happened only as a side effect of the retired manifest
 * `notificationEvents` wiring. A host without a desktop surface has no
 * presenter.
 */
function initializeOsNotificationPresenter(
  desktop: Pick<DesktopHostCapabilities, "initializeNotificationPresenter"> | undefined,
): void {
  if (!desktop) return;
  const supported = desktop.initializeNotificationPresenter();
  log.info("boot: OS notification presenter initialised (supported=%s)", supported);
}

export async function setupAuditAndNotification(ctx: BootContext): Promise<void> {
  const { getMainWindow, aveHomeDocUpgradeMarkers } = ctx;

  // Shared AuditLogger instance (plugin runtime + hooks + gate).
  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { ensureAuditSecret } = await import("../../audit/hmac-chain.js");
  const { createHostSecretStore } = await import("../../audit/host-secret-store.js");
  const bootAuditLogger = new AuditLogger();
  const permissionAuditSecretStore = createHostSecretStore(ctx.host.encryption);
  await bootAuditLogger.setupPermissionAuditChain(
    ensureAuditSecret(permissionAuditSecretStore),
    permissionAuditSecretStore,
  );

  // §14.2 Audit rotation must share the runtime writer instance. A separate
  // maintenance logger cannot drain records queued by the host/plugin paths.
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

  // Issue #260 — system notification service. Constructed up-front so
  // turn-end, routine, ask-user, approval, plugin, and system cues can call .fire().
  // Live mainWindow getter avoids a stale handle after Electron close+reopen.
  const notificationService = new NotificationService({
    getMainWindow,
    auditLogger: bootAuditLogger,
    ...(ctx.host.desktop?.notificationOptions ?? {
      isReady: () => false,
      isAnyWindowFocused: () => false,
      notificationActivationRegistration: null,
    }),
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
  // Routine delivery sites pass `notificationService` explicitly per-call so
  // there's no module-level singleton to reset between tests/processes.

  // Issue #748 — seed the in-memory plugin-auth-partition tracker from disk so
  // uninstall can wipe partitions created in prior app sessions (not just the
  // current runtime). Wire persistence callbacks so every new observation is
  // immediately flushed to `~/.ave/plugins/auth-partitions.json`.
  //
  // Sweep crashed-write tombstones from prior session before reading current state.
  // Non-fatal — continue boot if sweep fails.
  await cleanupStaleTmpFiles().catch((err: unknown) => {
    log.warn(
      "boot: cleanupStaleTmpFiles failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  //
  // Corrupt file → throws loudly with an audit entry instead of silently
  // using an empty set (CLAUDE.md "No Fallback Code" rule).
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
