import type { BrowserWindow, Session, WebContents } from "electron";
import type { SecretEncryption } from "../data/secret-document-store.js";
import type { AudioCaptureSurface } from "../main/audio-capture.js";
import type { FloatingDockSurface } from "../main/floating-dock.js";
import type { PowerMonitorLike } from "../main/idle-scheduler.js";
import type { NotificationServiceOptions } from "../main/notification-service.js";
import type { InitPluginRuntimeInput } from "./steps/plugin-runtime.js";
import type { ReleasePrepInput, ReleasePrepOutput } from "./steps/post-boot.js";
import type { HostFetchTransport } from "../main/host-fetch-guard.js";
import type { BrowserUploadPickerRequest } from "../main/browser/browser-upload.js";

/** Desktop-owned capabilities. The server has no presentation surface. */
export interface DesktopHostCapabilities extends Pick<InitPluginRuntimeInput,
  "openAuthWindowService" | "openLinkWindowService" | "openAuthPartitionViewerService"
  | "clearAuthPartitionService" | "shellOpenExternal"> {
  getAppWindows(): BrowserWindow[];
  getFocusedWindow(): BrowserWindow | null;
  /**
   * The open main window renderer whose tile shows `sessionId`, or null. A
   * prompt about a session (approval, ask-user question) is drawn there first;
   * boot falls back to the window in use (`promptSurfaceResolver`).
   */
  findSessionSurface(sessionId: string | undefined): WebContents | null;
  getAuthPartition(partition: string): Session;
  installPluginPartition(pluginId: string, pluginRoot: string | undefined): void;
  revokePluginWebviews(pluginId: string, revokeSession: (sessionId: string) => void): void;
  onBootShutdown(run: () => Promise<void>, needed: () => boolean): void;
  /**
   * Initialise the OS notification presenter and report whether OS
   * notifications are supported. Boot calls it once (`setupAuditAndNotification`)
   * so the presenter exists before the first cue: on Windows, Electron
   * registers the per-user Start Menu shortcut and the toast activator CLSID
   * pinned in `early-boot-env.ts` when the presenter is created, and Action
   * Center activation of a persisted or cold-start toast relies on both.
   */
  initializeNotificationPresenter(): boolean;
  notificationOptions: Partial<NotificationServiceOptions>;
  powerMonitor: PowerMonitorLike;
  createAudioCaptureSurface(): AudioCaptureSurface;
  createFloatingDockSurface(): FloatingDockSurface;
  pickFolders(pluginId: string, parent: () => BrowserWindow | null): Promise<{ canceled: boolean; folders: readonly string[] }>;
  pickBrowserUploadFiles(request: BrowserUploadPickerRequest): Promise<readonly string[] | null>;
  browserGuestContentOrigin(guest: WebContents): { x: number; y: number; windowId: number } | null;
  prepareRelease(input: ReleasePrepInput): ReleasePrepOutput;
  beforeShutdown(): void;
}

/** Runtime services required before any host state or outbound connection exists. */
export interface BootHost {
  readonly userDataPath: string;
  readonly resourcePath: string;
  readonly systemLocale: string;
  readonly isPackaged: boolean;
  readonly encryption: SecretEncryption;
  readonly networkFetch: typeof fetch;
  readonly singleHopNetworkFetch: HostFetchTransport;
  readonly llmFetch: typeof fetch;
  resolveProxy?: (url: string) => Promise<string>;
  readonly desktop?: DesktopHostCapabilities;
  exit(code: number): never | void;
  close(): Promise<void>;
}

export function requireDesktopHost(host: Pick<BootHost, "desktop">): DesktopHostCapabilities {
  if (!host.desktop) throw new Error("desktop-surface-unavailable");
  return host.desktop;
}

/**
 * Where an approval card or ask-user question about `sessionId` is drawn,
 * resolved each time one is raised (never bound at boot — the window open at
 * boot may be closed while another main window stays open): the open window
 * whose tile shows the session, else the main window in use. Null when no main
 * window is open (a headless run, or every window closed).
 */
export function promptSurfaceResolver(
  host: Pick<BootHost, "desktop">,
  getMainWindow: () => Pick<BrowserWindow, "webContents"> | null,
): (sessionId: string | undefined) => WebContents | null {
  return (sessionId) => {
    const holder = host.desktop?.findSessionSurface(sessionId) ?? null;
    if (holder) return holder;
    // `getMainWindow` answers only live windows (`app-state.ts`).
    return getMainWindow()?.webContents ?? null;
  };
}
