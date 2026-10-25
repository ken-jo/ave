import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { app, shell } from "electron";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { AuditLogger } from "../audit/audit-logger.js";
import { auditUnauthorized, validateHostRendererSender } from "../ipc/gated.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
import type { UpdateState } from "../shared/update-state.js";
import { getAveAppVersion } from "../shared/app-version.js";
import { compareSemver, SEMVER_CORE_PATTERN } from "../shared/semver-compare.js";
import {
  beginAppUpdateInstallRequest,
  clearAppUpdateInstallRequested,
} from "./app-update-install-intent.js";
import { hasPluginInstallInFlight } from "../plugins/install-lifecycle.js";
export type { UpdateState };
const log = createLogger("auto-updater");

const _require = createRequire(import.meta.url);

export interface AutoUpdaterDeps {
  // Read all live main windows per broadcast; the boot window may close while others remain.
  getWindows: () => BrowserWindow[];
  // The window the install confirmation is parented to — the one in use — or null.
  getDialogParent: () => BrowserWindow | null;
  auditLogger: AuditLogger;
  // Settings accessor — re-read on every tick so user can toggle at runtime.
  isEnabled: () => boolean;
  // Injectable updater (test seam). In production we dynamically require `electron-updater` so unit tests don't need the native dep.
  updaterFactory?: () => UpdaterLike;
  // Test seam for the native destructive-action confirmation dialog.
  confirmInstallForTest?: () => Promise<boolean>;
  // Production self-install capability requires a signing probe; tests inject the result across unsigned platforms.
  canSelfInstall?: () => boolean;
  // Test seam for opening the manual-update guide. Defaults to shell.openExternal.
  openExternal?: (url: string) => void;
  // Persisted app-update skip state. Exact-version only; a newer version surfaces again.
  getSkippedVersion?: () => string | undefined;
  setSkippedVersion?: (version: string) => Promise<void> | void;
  // Use the shared running-version source; injection lets tests offer an older feed version.
  getRunningVersion?: () => string;
}

// Minimal surface of electron-updater.autoUpdater we rely on.
export interface UpdaterLike {
  on(event: "update-available", cb: (info: { version: string }) => void): void;
  on(event: "update-not-available", cb: (info: { version: string }) => void): void;
  on(event: "download-progress", cb: (p: { percent: number; transferred: number; total: number }) => void): void;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  // Hardening: explicit anti-downgrade + channel pin + manual-download flag. Optional on the type so tests can pass minimal fakes.
  allowDowngrade?: boolean;
  channel?: string;
  // When false (our choice), `checkForUpdates` only detects — caller must invoke `downloadUpdate()` explicitly. Default in electron-updater is `true`,
  // which would silently fetch ~100MB on every app start.
  autoDownload?: boolean;
}

// Keep the last good state on transient feed or download errors; log failures without inventing a renderer state.

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// macOS self-install requires matching developer signing; unsigned builds need manual installation. Cache the immutable running signature.
let _canSelfInstall: boolean | null = null;
function canSelfInstall(): boolean {
  if (_canSelfInstall !== null) return _canSelfInstall;
  if (process.platform !== "darwin") {
    _canSelfInstall = true;
    return _canSelfInstall;
  }
  try {
    // `codesign -dv` writes its report to stderr; the Developer ID authority line is present only for a properly signed bundle (absent for adhoc).
    const r = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", app.getPath("exe")], {
      encoding: "utf8",
    });
    const report = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    _canSelfInstall = /Authority=Developer ID Application/.test(report);
  } catch {
    _canSelfInstall = false;
  }
  return _canSelfInstall;
}

// Ave homepage — hosts the manual update guide (download + replace steps). Opening it is the unsigned-build fallback for "apply update": the user
// finishes their work, quits, and follows the guide there since the app can't self-install an unsigned macOS build.
const UPDATE_GUIDE_URL = "https://ave.agent-connector.ai";

export function createAutoUpdater(deps: AutoUpdaterDeps): {
  start: () => void;
  stop: () => void;
  triggerCheck: () => Promise<void>;
  // Expose private updater operations and IPC wrappers only for gate tests; registered handlers remain runtime authority.
  _testOnly: {
    downloadNow: () => Promise<{ ok: boolean; reason?: string }>;
    installNow: () => Promise<{ ok: boolean; reason?: string }>;
    ipcDownloadNow: (event: IpcMainInvokeEvent) => Promise<{ ok: boolean; reason?: string }>;
    ipcInstallNow: (event: IpcMainInvokeEvent) => Promise<{ ok: boolean; reason?: string }>;
    ipcSkipVersion: (event: IpcMainInvokeEvent) => Promise<{ ok: boolean; reason?: string }>;
    skipVersion: () => Promise<{ ok: boolean; reason?: string }>;
    confirmInstall: () => Promise<{ confirmed: boolean }>;
    getState: () => UpdateState;
  };
} {
  let timer: NodeJS.Timeout | undefined;
  let updater: UpdaterLike | null = null;
  let wired = false;
  let lastState: UpdateState = { kind: "idle" };
  let installInProgress = false;

  const loadUpdater = (): UpdaterLike | null => {
    if (updater) return updater;
    try {
      updater = deps.updaterFactory
        ? deps.updaterFactory()
        : (_require("electron-updater").autoUpdater as UpdaterLike);
      return updater;
    } catch (err) {
      log.warn("electron-updater unavailable: %s", (err as Error).message);
      return null;
    }
  };

  const broadcast = (state: UpdateState): void => {
    lastState = state;
    for (const win of deps.getWindows()) {
      try {
        if (win.isDestroyed()) continue;
        win.webContents.send("ave:update:state", state);
      } catch (err) {
        log.warn("state broadcast failed: %s", (err as Error).message);
      }
    }
  };

  const skippedVersion = (): string | undefined => {
    const value = deps.getSkippedVersion?.()?.trim();
    return value ? value : undefined;
  };

  const isSkippedVersion = (version: string): boolean => skippedVersion() === version.trim();

  const runningVersion = (): string => deps.getRunningVersion?.() ?? getAveAppVersion();

  // Require a provably newer version against the app’s version authority; feed labels and allowDowngrade alone do not prevent stale offers.
  // An unparseable running version refuses the offer.
  const isNewerThanRunning = (version: string): boolean => {
    const running = runningVersion();
    if (!SEMVER_CORE_PATTERN.test(running)) {
      log.warn(
        "update v%s refused: the running version (%s) is not a version this host can compare",
        version,
        running,
      );
      return false;
    }
    return compareSemver(version.trim(), running) > 0;
  };

  const broadcastOrSkip = (state: UpdateState): void => {
    if (state.kind === "available" || state.kind === "downloaded") {
      if (!isNewerThanRunning(state.version)) {
        log.warn(
          "update v%s refused: not newer than the running v%s",
          state.version,
          runningVersion(),
        );
        broadcast({ kind: "idle" });
        return;
      }
      if (isSkippedVersion(state.version)) {
        log.info("update v%s hidden because the user skipped this version", state.version);
        broadcast({ kind: "idle" });
        return;
      }
    }
    broadcast(state);
  };

  const wire = (u: UpdaterLike) => {
    if (wired) return;
    wired = true;
    // Reject downgrades and pin the stable channel: feed integrity alone cannot prevent forged older metadata or channel redirection.
    u.allowDowngrade = false;
    u.channel = "latest";
    // 사용자 명시 클릭 전엔 다운로드 금지 — electron-updater의 default (autoDownload=true) 를 끄지 않으면 checkForUpdates 가 새 버전을 감지한 즉시 ~100MB 를 백그라운드로 받아버린다.
    u.autoDownload = false;
    u.on("update-available", (info) => {
      log.info("update-available: v%s", info.version);
      broadcastOrSkip({ kind: "available", version: info.version });
    });
    u.on("update-not-available", (info) => {
      log.info("update-not-available: at v%s", info.version);
      // No state change — keep whatever the user last saw (e.g. a previously-detected available update across reconnects).
    });
    u.on("download-progress", (p) => {
      // Broadcast progress only during a user-gated download; updater probe events otherwise have no version to display.
      if (lastState.kind !== "downloading" && lastState.kind !== "available") {
        return;
      }
      const version = (lastState as { version: string }).version;
      broadcast({ kind: "downloading", version, percent: Math.round(p.percent) });
    });
    u.on("update-downloaded", (info) => {
      log.info("update-downloaded: v%s", info.version);
      broadcastOrSkip({ kind: "downloaded", version: info.version });
    });
    u.on("error", (err) => {
      log.warn("error (non-fatal): %s", err.message);
      installInProgress = false;
      clearAppUpdateInstallRequested();
    });
  };

  const triggerCheck = async (): Promise<void> => {
    if (!deps.isEnabled()) return;
    const u = loadUpdater();
    if (!u) return;
    wire(u);
    try {
      await u.checkForUpdates();
    } catch (err) {
      log.warn("checkForUpdates failed: %s", (err as Error).message);
    }
  };

  // Remove IPC handlers on stop to avoid duplicate registration after restart; commands are inert when the updater is unavailable.
  const rejectUnauthorizedIpc = (
    channel: "ave:update:download-now" | "ave:update:install-now" | "ave:update:skip-version",
    event: IpcMainInvokeEvent,
  ): { ok: false; reason: "unauthorized-frame" } => {
    auditUnauthorized(deps.auditLogger, channel, event);
    return { ok: false, reason: "unauthorized-frame" };
  };

  const isAuthorizedHostRenderer = (
    event: IpcMainInvokeEvent,
  ): boolean => {
    return validateHostRendererSender(event);
  };

  const downloadAvailableUpdate = async (): Promise<{ ok: boolean; reason?: string }> => {
    const u = loadUpdater();
    if (!u) return { ok: false, reason: "updater-unavailable" };
    if (lastState.kind !== "available") {
      return { ok: false, reason: `not-available (state=${lastState.kind})` };
    }
    if (isSkippedVersion(lastState.version)) {
      broadcast({ kind: "idle" });
      return { ok: false, reason: "update-skipped" };
    }
    log.info("user-initiated download for v%s", lastState.version);
    // Promote state immediately so the badge flips to "다운로드 중…" even before electron-updater emits the first progress event.
    const version = lastState.version;
    broadcast({ kind: "downloading", version, percent: 0 });
    try {
      await u.downloadUpdate();
      return { ok: true };
    } catch (err) {
      log.warn("downloadUpdate failed: %s", (err as Error).message);
      // Revert badge to "available" so the user can retry instead of being stuck on a spinning "downloading…" state with no progress events.
      broadcast({ kind: "available", version });
      return { ok: false, reason: (err as Error).message };
    }
  };

  const installDownloadedUpdate = async (): Promise<{ ok: boolean; reason?: string }> => {
    const u = loadUpdater();
    if (!u) return { ok: false, reason: "updater-unavailable" };
    if (installInProgress) {
      return { ok: false, reason: "install-in-progress" };
    }
    if (lastState.kind !== "downloaded") {
      return { ok: false, reason: `not-downloaded (state=${lastState.kind})` };
    }
    if (hasPluginInstallInFlight()) {
      return { ok: false, reason: "plugin-install-in-progress" };
    }
    if (isSkippedVersion(lastState.version)) {
      broadcast({ kind: "idle" });
      return { ok: false, reason: "update-skipped" };
    }
    const version = lastState.version;
    log.info("user-initiated install for v%s", version);
    // Open the Ave homepage update guide (test-seamed). Wrapped so a missing shell binding can never turn the fallback into an unhandled throw.
    const openUpdateGuide = (): void => {
      try {
        (deps.openExternal ?? ((url: string) => void shell.openExternal(url)))(UPDATE_GUIDE_URL);
      } catch (err) {
        log.warn("failed to open update guide: %s", (err as Error).message);
      }
    };
    // Unsigned macOS builds cannot self-install; return manual-install-required and open the update guide.
    const selfInstallable = deps.canSelfInstall ? deps.canSelfInstall() : canSelfInstall();
    if (!selfInstallable) {
      log.info("self-install unsupported (unsigned build) — opening update guide for v%s", version);
      openUpdateGuide();
      return { ok: false, reason: "manual-install-required" };
    }
    try {
      // After native confirmation, let the updater close windows, intercept its first quit for bounded cleanup, then resume the prepared quit.
      installInProgress = true;
      beginAppUpdateInstallRequest();
      u.quitAndInstall();
      return { ok: true };
    } catch (err) {
      installInProgress = false;
      clearAppUpdateInstallRequested();
      // Reactive safety net: if quitAndInstall throws despite the signature check passing (e.g. a partially-signed bundle), still hand the user a working
      // install path instead of swallowing the failure silently.
      log.warn("quitAndInstall failed: %s — opening update guide", (err as Error).message);
      openUpdateGuide();
      return { ok: false, reason: "manual-install-required" };
    }
  };

  const onDownloadNow = async (
    event: IpcMainInvokeEvent,
  ): Promise<{ ok: boolean; reason?: string }> => {
    if (!isAuthorizedHostRenderer(event)) {
      return rejectUnauthorizedIpc("ave:update:download-now", event);
    }
    return downloadAvailableUpdate();
  };

  // Use a main-process native dialog to avoid renderer blocking and focus problems; only an explicit restart click confirms.
  const onConfirmInstall = async (): Promise<{ confirmed: boolean }> => {
    if (lastState.kind !== "downloaded") {
      return { confirmed: false };
    }
    if (deps.confirmInstallForTest) {
      return { confirmed: await deps.confirmInstallForTest() };
    }
    try {
      const electron = _require("electron") as {
        dialog?: { showMessageBox?: (window: BrowserWindow | undefined, opts: unknown) => Promise<{ response: number }> };
      };
      if (typeof electron.dialog?.showMessageBox !== "function") {
        return { confirmed: false };
      }
      const parent = deps.getDialogParent();
      const result = await electron.dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
        type: "question",
        buttons: [t("common.cancel"), t("mainDialog.restart")],
        defaultId: 1,
        cancelId: 0,
        title: t("mainDialog.updateApplyTitle"),
        message: t("mainDialog.updateRestartMessage", { version: lastState.version }),
        detail: t("mainDialog.updateRestartDetail"),
      });
      return { confirmed: result.response === 1 };
    } catch (err) {
      log.warn("confirm-install dialog failed: %s", (err as Error).message);
      return { confirmed: false };
    }
  };

  const onInstallNow = async (
    event: IpcMainInvokeEvent,
  ): Promise<{ ok: boolean; reason?: string }> => {
    if (!isAuthorizedHostRenderer(event)) {
      return rejectUnauthorizedIpc("ave:update:install-now", event);
    }
    if (lastState.kind !== "downloaded") {
      return { ok: false, reason: `not-downloaded (state=${lastState.kind})` };
    }
    if (hasPluginInstallInFlight()) {
      return { ok: false, reason: "plugin-install-in-progress" };
    }
    const confirmation = await onConfirmInstall();
    if (!confirmation.confirmed) {
      return { ok: false, reason: "not-confirmed" };
    }
    return installDownloadedUpdate();
  };

  const skipCurrentVersion = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (lastState.kind !== "available" && lastState.kind !== "downloaded") {
      return { ok: false, reason: `no-skippable-update (state=${lastState.kind})` };
    }
    const version = lastState.version;
    try {
      await deps.setSkippedVersion?.(version);
      broadcast({ kind: "idle" });
      return { ok: true };
    } catch (err) {
      log.warn("skip update v%s failed: %s", version, (err as Error).message);
      return { ok: false, reason: (err as Error).message };
    }
  };

  const onSkipVersion = async (
    event: IpcMainInvokeEvent,
  ): Promise<{ ok: boolean; reason?: string }> => {
    if (!isAuthorizedHostRenderer(event)) {
      return rejectUnauthorizedIpc("ave:update:skip-version", event);
    }
    return skipCurrentVersion();
  };

  const onGetState = (): UpdateState => lastState;

  // Load IPC at start and skip absent APIs so unit tests can use the updater outside the desktop runtime.
  let ipcRegistered = false;
  const loadIpcMain = (): IpcMain | null => {
    try {
      const m = _require("electron") as { ipcMain?: IpcMain };
      return typeof m.ipcMain?.handle === "function" ? m.ipcMain : null;
    } catch {
      return null;
    }
  };
  const registerIpc = () => {
    if (ipcRegistered) return;
    const ipc = loadIpcMain();
    if (!ipc) return;
    ipcRegistered = true;
    ipc.handle("ave:update:download-now", onDownloadNow);
    ipc.handle("ave:update:install-now", onInstallNow);
    ipc.handle("ave:update:skip-version", onSkipVersion);
    ipc.handle("ave:update:get-state", onGetState);
  };
  const unregisterIpc = () => {
    // Always clear the flag, even if loadIpcMain returns null — otherwise a future start() would skip re-registration because the gate would stay stuck on `true`.
    if (!ipcRegistered) return;
    ipcRegistered = false;
    const ipc = loadIpcMain();
    if (!ipc) return;
    ipc.removeHandler("ave:update:download-now");
    ipc.removeHandler("ave:update:install-now");
    ipc.removeHandler("ave:update:skip-version");
    ipc.removeHandler("ave:update:get-state");
  };

  return {
    start() {
      if (timer) return;
      registerIpc();
      void triggerCheck();
      timer = setInterval(() => void triggerCheck(), CHECK_INTERVAL_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      unregisterIpc();
    },
    triggerCheck,
    _testOnly: {
      downloadNow: downloadAvailableUpdate,
      installNow: installDownloadedUpdate,
      ipcDownloadNow: onDownloadNow,
      ipcInstallNow: onInstallNow,
      ipcSkipVersion: onSkipVersion,
      skipVersion: skipCurrentVersion,
      confirmInstall: onConfirmInstall,
      getState: onGetState,
    },
  };
}
