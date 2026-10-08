import type { BrowserWindow, Session } from "electron";
import type { SecretEncryption } from "../data/secret-document-store.js";
import type { AudioCaptureSurface } from "../main/audio-capture.js";
import type { FloatingDockSurface } from "../main/floating-dock.js";
import type { PowerMonitorLike } from "../main/idle-scheduler.js";
import type { NotificationServiceOptions } from "../main/notification-service.js";
import type { InitPluginRuntimeInput } from "./steps/plugin-runtime.js";
import type { ReleasePrepInput, ReleasePrepOutput } from "./steps/post-boot.js";
import type { HostFetchTransport } from "../main/host-fetch-guard.js";

/** Desktop-owned capabilities. The server has no presentation surface. */
export interface DesktopHostCapabilities extends Pick<InitPluginRuntimeInput,
  "openAuthWindowService" | "openLinkWindowService" | "openAuthPartitionViewerService"
  | "clearAuthPartitionService" | "shellOpenExternal"> {
  getAppWindows(): BrowserWindow[];
  getFocusedWindow(): BrowserWindow | null;
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
