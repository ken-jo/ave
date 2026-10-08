/**
 * Main-process shared mutable state.
 *
 * `src/main.ts` (the Electron entry) historically held ~9 mutable
 * module-level bindings — the main/settings windows, the tray, the
 * `WindowManager`, the resolved `AppServices`, and a handful of boot/shutdown
 * flags — that were read and written across many top-level functions. When
 * those functions moved into cohesive `src/main/*` modules (commit C17) they
 * could no longer close over `main.ts` locals, so the shared bindings live
 * here behind small get/set accessors instead. This is a single source of
 * truth for cross-module runtime state; behaviour is identical to the previous
 * closed-over module locals.
 *
 * Accessors return live values (no snapshotting), matching the semantics of
 * reading the module-level `let` binding directly.
 */
import type { BrowserWindow, Tray } from "electron";
import type { WindowManager } from "./window-manager.js";
import type { AppServices } from "../boot.js";
import { bootInstallNoticeIsEmpty, type BootInstallNoticeView, type GitMarketplaceDeepLink } from "../shared/git-marketplace.js";

// Main-window identity and mode-driven bounds manager. Created before
// createWindow() so it is ready when the main window is registered.
let windowManager: WindowManager | null = null;
export function getWindowManager(): WindowManager | null {
  return windowManager;
}
export function setWindowManager(value: WindowManager | null): void {
  windowManager = value;
}

let mainWindow: BrowserWindow | null = null;
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
export function setMainWindow(value: BrowserWindow | null): void {
  mainWindow = value;
}

let tray: Tray | null = null;
export function getTray(): Tray | null {
  return tray;
}
export function setTray(value: Tray | null): void {
  tray = value;
}

let services: AppServices | null = null;
export function getServices(): AppServices | null {
  return services;
}
export function setServices(value: AppServices | null): void {
  services = value;
}

// Git marketplace deep link and boot-install notice (design §15.1):
// held here until the Marketplace tab reads them, since either can arrive
// before the tab is open.
let pendingGitMarketplaceLink: GitMarketplaceDeepLink | null = null;
export function setPendingGitMarketplaceLink(value: GitMarketplaceDeepLink): void {
  pendingGitMarketplaceLink = value;
}
export function takePendingGitMarketplaceLink(): GitMarketplaceDeepLink | null {
  const link = pendingGitMarketplaceLink;
  pendingGitMarketplaceLink = null;
  return link;
}

/**
 * The git marketplace's lifetime (design §7.3), shared by everything of it
 * that reaches the renderer or starts work: the marketplace IPC domain, its
 * git runtime's progress and its deep links. Aborted once, by the
 * `git-marketplace-events` shutdown hook the marketplace domain registers;
 * the work in progress then finishes, and nothing after it is sent.
 */
const marketplaceLifetime = new AbortController();
export function getMarketplaceLifetime(): AbortController {
  return marketplaceLifetime;
}

let bootInstallNotice: BootInstallNoticeView | null = null;
/** Set by the boot-install step; an empty notice clears it. */
export function setBootInstallNotice(value: BootInstallNoticeView | null): void {
  bootInstallNotice = value && !bootInstallNoticeIsEmpty(value) ? value : null;
}
export function getBootInstallNotice(): BootInstallNoticeView | null {
  return bootInstallNotice;
}

let pendingAveUri: string | null = null;
export function getPendingAveUri(): string | null {
  return pendingAveUri;
}
export function setPendingAveUri(value: string | null): void {
  pendingAveUri = value;
}

let lastRendererReloadAt = 0;
export function getLastRendererReloadAt(): number {
  return lastRendererReloadAt;
}
export function setLastRendererReloadAt(value: number): void {
  lastRendererReloadAt = value;
}

let rendererReloadReady = false;
export function isRendererReloadReady(): boolean {
  return rendererReloadReady;
}
export function setRendererReloadReady(value: boolean): void {
  rendererReloadReady = value;
}

let pendingRendererReload = false;
export function isPendingRendererReload(): boolean {
  return pendingRendererReload;
}
export function setPendingRendererReload(value: boolean): void {
  pendingRendererReload = value;
}

let appShutdownStarted = false;
export function isAppShutdownStarted(): boolean {
  return appShutdownStarted;
}
export function setAppShutdownStarted(value: boolean): void {
  appShutdownStarted = value;
}

let appShutdownCompleted = false;
export function isAppShutdownCompleted(): boolean {
  return appShutdownCompleted;
}
export function setAppShutdownCompleted(value: boolean): void {
  appShutdownCompleted = value;
}
