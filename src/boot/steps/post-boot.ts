import type { BootHost } from "../host-runtime.js";
import type { TelemetryService } from "../../main/telemetry.js";
import type { PluginTelemetryClient } from "../../telemetry/client.js";
/**
 * Boot §4.2 Step 8 — Post-boot hooks (release prep + announcements).
 *
 * Wires anonymous telemetry, crash reporter, auto-updater, plugin lifecycle
 * telemetry, first-boot consent prompt, and the announcement poller. The
 * marketplace's update notices start with the window (design §7.3).
 * All init is best-effort (try/catch around release prep; non-fatal).
 */
import type { BrowserWindow } from "electron";
import type { SettingsService } from "../../data/settings-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { MarketplaceAnnouncement } from "../../shared/marketplace-announcements.js";
import { MARKETPLACE } from "../../shared/ipc-channels.js";
import {
  normalizeDismissedAnnouncementIds,
  type MarketplaceAnnouncementPayload,
} from "../../shared/marketplace-announcements.js";
import { resolveUpdateCheckEnabled } from "../../plugins/update-detector.js";
import { registerShutdownHook } from "../../main/app-shutdown.js";
import { sendToWindow } from "../../ipc/safe-send.js";
import { createLogger } from "../../lib/logger.js";
import type { ServiceClient } from "../../marketplace/service/client.js";
import type { TracingHandle } from "../../engine/telemetry/tracing.js";
const log = createLogger("ave");

export interface ReleasePrepOutput {
  telemetry?: TelemetryService;
  pluginTelemetry?: PluginTelemetryClient;
  autoUpdaterStop?: () => void;
}

export interface ReleasePrepInput {
  mainWindow: BrowserWindow | null;
  settingsService: SettingsService;
  bootAuditLogger: AuditLogger;
  /** The host's outbound transport — both telemetry uploads run on it. */
  networkFetch: typeof fetch;
  /** Boot-configured tracing; its batched spans are flushed on quit. */
  tracing: TracingHandle;
  /**
   * The service endpoint: telemetry posts to the endpoint its document names
   * (design §11). The document is read for telemetry only once the user opted in.
   */
  serviceClient: Pick<ServiceClient, "ensureResolved" | "telemetryEndpoint">;
  /**
   * Whether this launch may open the connections in here that nothing forces
   * it to open: the release check, the two telemetry uploaders, and crash
   * reporting off the machine. A headless one-shot run passes `false` — no
   * operator can act on an update prompt or a consent prompt, and a run asked
   * for one turn should not report on itself. Local crash minidumps are still
   * collected either way; only their upload is discretionary.
   *
   * Every one of these is ALSO settings-driven, and this never widens that:
   * `true` leaves each of them deciding exactly as before.
   */
  discretionaryEgress: boolean;
}

/**
 * Start crash reporter, anonymous telemetry, plugin-lifecycle telemetry, and
 * the auto-updater. All default-off or settings-driven. Non-fatal on error.
 *
 * A launch without discretionary egress keeps only the local half: crash
 * minidumps still land in the Ave-owned dump directory, and nothing else in
 * here is constructed at all.
 */
export function wireReleasePrep(input: ReleasePrepInput, host: BootHost): ReleasePrepOutput {
  if (host.desktop) return host.desktop.prepareRelease(input);
  return {};
}

export interface AnnouncementCheckInput {
  getMainWindow: () => BrowserWindow | null;
  settingsService: SettingsService;
  /** The service endpoint's active announcements (design §11). */
  listAnnouncements: () => Promise<MarketplaceAnnouncement[]>;
  /** Poll interval; the design's 6 hours unless a test passes another. */
  intervalMs?: number;
}

/** Announcements are fetched after boot and every 6 hours (design §11). */
const ANNOUNCEMENT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Announcement polling. Fetches the service endpoint's active announcement
 * set, drops the ids the user has already dismissed (persisted in
 * `settings.marketplace.dismissedAnnouncementIds`), and pushes the remainder
 * to the renderer via `MARKETPLACE.announcements`. Runs once after the real
 * renderer load and then every {@link ANNOUNCEMENT_INTERVAL_MS}, while the
 * update-check switch is on.
 *
 * The dedup key folds in the target webContents, full visible payload, and
 * dismissed id set so a dismiss clears the banner, server-side corrections to
 * an existing announcement id rebroadcast, and a replaced main window receives
 * the current payload at least once.
 */
export function wireAnnouncementCheck(input: AnnouncementCheckInput): void {
  const { getMainWindow, settingsService, listAnnouncements } = input;
  const marketplaceSettings = settingsService.get("marketplace");
  const announcementCheckEnabled = resolveUpdateCheckEnabled(
    marketplaceSettings?.updateCheckEnabled,
  );
  if (!announcementCheckEnabled) return;

  let lastBroadcastKey = "";
  let nextWebContentsId = 0;
  const webContentsIds = new WeakMap<object, number>();
  const sortNewestFirst = (items: MarketplaceAnnouncement[]) =>
    [...items].sort((a, b) => {
      const aCreatedAt = Date.parse(a.createdAt);
      const bCreatedAt = Date.parse(b.createdAt);
      const aTime = Number.isFinite(aCreatedAt) ? aCreatedAt : 0;
      const bTime = Number.isFinite(bCreatedAt) ? bCreatedAt : 0;
      if (aTime !== bTime) return bTime - aTime;
      return b.id - a.id;
    });
  const broadcastAnnouncements = (
    visible: MarketplaceAnnouncement[],
    dismissed: number[],
  ) => {
    const targetWindow = getMainWindow();
    const webContents = targetWindow?.webContents;
    let targetKey = "none";
    if (webContents && typeof webContents === "object") {
      let id = webContentsIds.get(webContents);
      if (id === undefined) {
        id = ++nextWebContentsId;
        webContentsIds.set(webContents, id);
      }
      targetKey = `webContents:${id}`;
    }
    const key = JSON.stringify({
      target: targetKey,
      visible: visible.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        level: a.level,
        createdAt: a.createdAt,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        // In the key so that re-pointing a live announcement's button
        // rebroadcasts, the same way a corrected title does.
        actions: a.actions,
      })),
      dismissed: normalizeDismissedAnnouncementIds(dismissed),
    });
    if (key === lastBroadcastKey) return false;
    const sent = sendToWindow(
      targetWindow,
      MARKETPLACE.announcements,
      visible satisfies MarketplaceAnnouncementPayload,
      log,
    );
    if (!sent) return false;
    lastBroadcastKey = key;
    return true;
  };

  const runAnnouncementCheck = async () => {
    try {
      const announcements = await listAnnouncements();
      const dismissedIds = normalizeDismissedAnnouncementIds(
        settingsService.get("marketplace")?.dismissedAnnouncementIds,
      );
      const dismissed = new Set(dismissedIds);
      const visible = sortNewestFirst(
        announcements.filter((a) => !dismissed.has(a.id)),
      );
      if (!broadcastAnnouncements(visible, dismissedIds)) {
        log.debug("announcement-check: no change (%d)", visible.length);
        return;
      }
      log.info("announcement-check: %d announcement(s) active", visible.length);
    } catch (err) {
      if (broadcastAnnouncements([], [])) {
        log.warn(
          "announcement-check: error; cleared announcements: %s",
          (err as Error).message,
        );
        return;
      }
      log.debug(
        "announcement-check: still unavailable: %s",
        (err as Error).message,
      );
    }
  };

  const runAfterRendererLoad = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      void runAnnouncementCheck();
      return;
    }
    const webContents = win.webContents as BrowserWindow["webContents"] & {
      getURL?: () => string;
      isLoading?: () => boolean;
      once?: (event: "did-finish-load", listener: () => void) => void;
    };
    const url = typeof webContents.getURL === "function" ? webContents.getURL() : "";
    const loading = typeof webContents.isLoading === "function" && webContents.isLoading();
    if (
      typeof webContents.once === "function" &&
      (loading || url.startsWith("data:"))
    ) {
      webContents.once("did-finish-load", () => void runAnnouncementCheck());
      return;
    }
    void runAnnouncementCheck();
  };

  runAfterRendererLoad();

  const intervalMs = input.intervalMs ?? ANNOUNCEMENT_INTERVAL_MS;
  let announcementTimer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    announcementTimer = setInterval(() => void runAnnouncementCheck(), intervalMs);
    announcementTimer.unref?.();
  }

  registerShutdownHook("marketplace-announcement-timer", () => {
    if (announcementTimer) clearInterval(announcementTimer);
  });
}
