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
import type { OpenOAuthLogin } from "../main/oauth-login.js";

/** Desktop-owned capabilities. The server has no presentation surface. */
export interface DesktopHostCapabilities extends Pick<InitPluginRuntimeInput,
  "openAuthWindowService" | "openLinkWindowService" | "openAuthPartitionViewerService"
  | "clearAuthPartitionService" | "shellOpenExternal"> {
  hasSingleInstanceLock(): boolean;
  getAppWindows(): BrowserWindow[];
  openOAuthLogin: OpenOAuthLogin;
  getFocusedWindow(): BrowserWindow | null;
  /** The live renderer hosting this exact session, or null when it is unhosted. */
  findSessionSurface(sessionId: string | undefined): WebContents | null;
  /** The live terminal tab owner's renderer, or null; never fall back to another window. */
  findTerminalSurface(tabId: string): WebContents | null;
  getAuthPartition(partition: string): Session;
  installPluginPartition(pluginId: string, pluginRoot: string | undefined): void;
  revokePluginWebviews(pluginId: string, revokeSession: (sessionId: string) => void): void;
  onBootShutdown(run: () => Promise<void>, needed: () => boolean): void;
  /** Initialize once before cues; Windows persisted-toast activation requires the shortcut and activator registration. */
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
  relaunch(): void;
  close(): Promise<void>;
}

export function requireDesktopHost(host: Pick<BootHost, "desktop">): DesktopHostCapabilities {
  if (!host.desktop) throw new Error("desktop-surface-unavailable");
  return host.desktop;
}

/** Resolve each prompt against live windows: session owner, then active main window, or null when headless. */
export function promptSurfaceResolver(
  host: Pick<BootHost, "desktop">,
  getMainWindow: () => Pick<BrowserWindow, "webContents"> | null,
): (sessionId: string | undefined, terminalTabId?: string) => WebContents | null {
  return (sessionId, terminalTabId) => {
    if (terminalTabId !== undefined) return host.desktop?.findTerminalSurface(terminalTabId) ?? null;
    const holder = host.desktop?.findSessionSurface(sessionId) ?? null;
    if (holder) return holder;
    return getMainWindow()?.webContents ?? null;
  };
}
