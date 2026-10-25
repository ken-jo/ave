import type { BootHost } from "../host-runtime.js";
import type { TelemetryService } from "../../main/telemetry.js";
import type { PluginTelemetryClient } from "../../telemetry/client.js";
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
  /** Read the service document for telemetry only after opt-in. */
  serviceClient: Pick<ServiceClient, "ensureResolved" | "telemetryEndpoint">;
  /** Headless runs disable discretionary egress; local minidumps remain and settings still govern allowed uploads. */
  discretionaryEgress: boolean;
}

/** Initialize release services best-effort; without discretionary egress, construct only local crash collection. */
export function wireReleasePrep(input: ReleasePrepInput, host: BootHost): ReleasePrepOutput {
  if (host.desktop) return host.desktop.prepareRelease(input);
  return {};
}

export interface AnnouncementCheckInput {
  getMainWindow: () => BrowserWindow | null;
  settingsService: SettingsService;
  listAnnouncements: () => Promise<MarketplaceAnnouncement[]>;
  intervalMs?: number;
}

const ANNOUNCEMENT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Poll only while updates are enabled; dedupe by target window, visible payload, and dismissed ids. */
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
        // Include button targets so link corrections rebroadcast even when the title is unchanged.
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
