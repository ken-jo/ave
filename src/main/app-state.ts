// Shared runtime accessors return live values, never snapshots.
import type { BrowserWindow, Tray, WebContents } from "electron";
import type { AppServices } from "../boot.js";
import { terminalOwnerWindowId } from "./terminal/pty-manager.js";
import { bootInstallNoticeIsEmpty, type BootInstallNoticeView, type GitMarketplaceDeepLink } from "../shared/git-marketplace.js";

// Broadcast only to live main windows, never all windows, which includes remote-content viewers.
// Target the last-focused window for point sends; primary closure never re-roles existing secondary windows.
export type MainWindowRole = "primary" | "secondary";

const mainWindows: BrowserWindow[] = [];
let focusedMainWindowId: number | null = null;
let primaryMainWindowId: number | null = null;
// Main window ids, least to most recently focused (opening counts as focus).
const focusHistory: number[] = [];

function recordFocus(id: number): void {
  const index = focusHistory.indexOf(id);
  if (index >= 0) focusHistory.splice(index, 1);
  focusHistory.push(id);
  focusedMainWindowId = id;
}

function liveMainWindows(): BrowserWindow[] {
  return mainWindows.filter((win) => !win.isDestroyed());
}

export function getMainWindows(): BrowserWindow[] {
  return liveMainWindows();
}

export function getMainWindow(): BrowserWindow | null {
  const live = liveMainWindows();
  return live.find((win) => win.id === focusedMainWindowId) ?? live.at(-1) ?? null;
}

export function getPrimaryMainWindow(): BrowserWindow | null {
  return liveMainWindows().find((win) => win.id === primaryMainWindowId) ?? null;
}

// The role the next opened main window gets.
export function nextMainWindowRole(): MainWindowRole {
  return getPrimaryMainWindow() === null ? "primary" : "secondary";
}

export function registerMainWindow(win: BrowserWindow, role: MainWindowRole): void {
  if (mainWindows.includes(win)) throw new Error("main-window-already-registered");
  if (role === "primary") {
    if (getPrimaryMainWindow() !== null) throw new Error("main-window-primary-already-claimed");
    primaryMainWindowId = win.id;
  }
  mainWindows.push(win);
  recordFocus(win.id);
}

export function unregisterMainWindow(win: BrowserWindow): void {
  const index = mainWindows.indexOf(win);
  if (index >= 0) mainWindows.splice(index, 1);
  const historyIndex = focusHistory.indexOf(win.id);
  if (historyIndex >= 0) focusHistory.splice(historyIndex, 1);
  if (focusedMainWindowId === win.id) {
    // Back to the window the user was in before this one.
    const liveIds = new Set(liveMainWindows().map((live) => live.id));
    focusedMainWindowId = [...focusHistory].reverse().find((id) => liveIds.has(id)) ?? null;
  }
  if (primaryMainWindowId === win.id) primaryMainWindowId = null;
}

export function markMainWindowFocused(win: BrowserWindow): void {
  if (mainWindows.includes(win)) recordFocus(win.id);
}

// The live main window whose renderer is `contents`, or null.
export function mainWindowForContents(contents: unknown): BrowserWindow | null {
  return liveMainWindows().find((win) => win.webContents === contents) ?? null;
}

// Whether `contents` is the renderer of a secondary main window. Chat groups from such a renderer are scoped to that window; every other sender (the
// primary window, auxiliary host surfaces) keeps the global ids.
export function isSecondaryMainWindowContents(contents: unknown): boolean {
  return liveMainWindows().some((win) => win.id !== primaryMainWindowId && win.webContents === contents);
}

// Which renderer shows a conversation. Installed by the chat IPC domain, which owns the chat groups; it answers the renderer whose tile holds
// `sessionId`, or null when no tile holds it.
type SessionContentsLookup = (sessionId: string) => WebContents | null;
let sessionContentsLookup: SessionContentsLookup | null = null;
export function setSessionContentsLookup(value: SessionContentsLookup | null): void {
  sessionContentsLookup = value;
}

// The live main window renderer whose tile shows `sessionId`, or null when no open window shows it. Prompts about a session (approvals, ask-user
// questions) go here first; boot falls back to the window in use.
export function findSessionMainWindowContents(sessionId: string | undefined): WebContents | null {
  if (sessionId === undefined) return null;
  const holder = sessionContentsLookup?.(sessionId) ?? null;
  return holder && !holder.isDestroyed() && mainWindowForContents(holder) ? holder : null;
}

// The live main window renderer that owns workspace terminal `tabId`, or null when no shell runs under it or its window is gone. A terminal tab's egress
// ask is drawn there, in the tab's banner, and nowhere else.
export function findTerminalMainWindowContents(tabId: string): WebContents | null {
  const ownerWindowId = terminalOwnerWindowId(tabId);
  if (ownerWindowId === undefined || ownerWindowId === null) return null;
  const owner = liveMainWindows().find((win) => win.id === ownerWindowId);
  return owner && !owner.webContents.isDestroyed() ? owner.webContents : null;
}

// The renderer that last sent the side chat a turn. The side chat is one conversation drawn in whichever window's panel the user typed it in; its
// workspace tools (terminal_read, the browser tools) reach that window.
let sideChatOwnerContents: WebContents | null = null;
export function setSideChatOwnerContents(contents: WebContents | null): void {
  sideChatOwnerContents = contents;
}

// The live main window the side chat was last driven from, or null.
export function sideChatOwnerWindow(): BrowserWindow | null {
  const owner = sideChatOwnerContents;
  return owner && !owner.isDestroyed() ? mainWindowForContents(owner) : null;
}

// @internal test-only reset for isolated module-state tests.
export function resetMainWindowsForTests(): void {
  mainWindows.length = 0;
  focusHistory.length = 0;
  focusedMainWindowId = null;
  primaryMainWindowId = null;
  sessionContentsLookup = null;
  sideChatOwnerContents = null;
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

// Hold deep links and boot-install notices until the Marketplace tab opens.
let pendingGitMarketplaceLink: GitMarketplaceDeepLink | null = null;
export function setPendingGitMarketplaceLink(value: GitMarketplaceDeepLink): void {
  pendingGitMarketplaceLink = value;
}
export function takePendingGitMarketplaceLink(): GitMarketplaceDeepLink | null {
  const link = pendingGitMarketplaceLink;
  pendingGitMarketplaceLink = null;
  return link;
}

// One abortable lifetime covers marketplace IPC, progress, and deep links; shutdown stops publication after current work finishes.
const marketplaceLifetime = new AbortController();
export function getMarketplaceLifetime(): AbortController {
  return marketplaceLifetime;
}

let bootInstallNotice: BootInstallNoticeView | null = null;
// Set by the boot-install step; an empty notice clears it.
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
