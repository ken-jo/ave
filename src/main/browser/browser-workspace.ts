import type { DownloadItem, WebContents } from "electron";
import { BROWSER_WORKSPACE_LIMITS, browserWorkspaceUrl, parseBrowserWorkspaceRequest, type BrowserBookmarkRequest, type BrowserDownload, type BrowserFindRequest, type BrowserSitePermissionRequest, type BrowserWorkspaceState, type BrowserWorkspaceTarget, type BrowserWorkspaceTab, type BrowserZoomRequest } from "../../shared/browser-workspace.js";
import { BrowserWorkspacePreview } from "./browser-workspace-preview.js";
import { BrowserWorkspaceStore } from "./browser-workspace-store.js";
import { BrowserSitePermissionPolicy, type BrowserPermissionDetails, type BrowserPermissionPrompt } from "./browser-site-permissions.js";

export interface BrowserWorkspaceLiveTab { readonly guest: WebContents; readonly documentGeneration: number }
export interface BrowserWorkspaceServiceDeps {
  liveTab(windowId: number, tabId: string): BrowserWorkspaceLiveTab | null;
  listTabs(windowId: number): readonly Omit<BrowserWorkspaceTab, "zoomFactor">[];
  isWindowVisible(windowId: number): boolean;
  promptPermission(request: BrowserPermissionPrompt): Promise<boolean>;
  fullscreenAvailable(windowId: number): boolean;
  onError(error: unknown): void;
  readonly store?: BrowserWorkspaceStore;
  readonly now?: () => number;
}

export class BrowserWorkspaceService {
  readonly store: BrowserWorkspaceStore;
  private readonly previews: BrowserWorkspacePreview;
  private readonly permissions: BrowserSitePermissionPolicy;
  private readonly guests = new Map<number, { guest: WebContents; windowId: number; generation: number; dispose: () => void }>();
  private readonly downloads = new Map<number, BrowserDownload[]>();
  private readonly downloadDisposers = new Map<number, Set<() => void>>();
  private readonly listeners = new Set<(windowId: number, state: BrowserWorkspaceState) => void>();
  private readonly windows = new Set<number>();
  private revision = 0;
  private nextDownload = 1;
  constructor(private readonly deps: BrowserWorkspaceServiceDeps) {
    this.store = deps.store ?? new BrowserWorkspaceStore();
    this.previews = new BrowserWorkspacePreview(deps);
    this.permissions = new BrowserSitePermissionPolicy({ store: this.store, prompt: deps.promptPermission, fullscreenAvailable: deps.fullscreenAvailable, currentContext: (guestId) => {
      const entry = this.guests.get(guestId);
      return entry && !entry.guest.isDestroyed() ? { guestId, windowId: entry.windowId, documentGeneration: entry.generation, url: entry.guest.getURL() } : null;
    } });
  }
  onChanged(handler: (windowId: number, state: BrowserWorkspaceState) => void): () => void { this.listeners.add(handler); return () => this.listeners.delete(handler); }
  private async changed(): Promise<void> {
    for (const windowId of this.windows) {
      const state = await this.getState(windowId);
      for (const listener of this.listeners) listener(windowId, state);
    }
  }
  private notify(): void { void this.changed().catch(this.deps.onError); }
  async getState(windowId: number): Promise<BrowserWorkspaceState> {
    this.windows.add(windowId);
    const revision = ++this.revision;
    const snapshot = await this.store.snapshot();
    const tabs = this.deps.listTabs(windowId).flatMap((tab) => {
      const live = this.deps.liveTab(windowId, tab.tabId);
      if (!live || live.guest.isDestroyed() || live.documentGeneration !== tab.documentGeneration) return [];
      return [{ ...tab, title: tab.title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), zoomFactor: live.guest.getZoomFactor() }];
    });
    return { ...snapshot, revision, tabs, downloads: structuredClone(this.downloads.get(windowId) ?? []), capabilities: { fullscreen: this.deps.fullscreenAvailable(windowId) } };
  }
  private target(windowId: number, request: BrowserWorkspaceTarget): BrowserWorkspaceLiveTab {
    if (!parseBrowserWorkspaceRequest("preview", { tabId: request.tabId, documentGeneration: request.documentGeneration })) throw new Error("bad-request");
    const target = this.deps.liveTab(windowId, request.tabId);
    if (!target || target.guest.isDestroyed()) throw new Error("no-such-tab");
    if (target.documentGeneration !== request.documentGeneration) throw new Error("stale-document");
    return target;
  }
  async setBookmark(windowId: number, request: BrowserBookmarkRequest): Promise<BrowserWorkspaceState> { await this.store.setBookmark(request); await this.changed(); return this.getState(windowId); }
  async clearHistory(windowId: number): Promise<BrowserWorkspaceState> { await this.store.clearHistory(); await this.changed(); return this.getState(windowId); }
  async setSitePermission(windowId: number, request: BrowserSitePermissionRequest): Promise<BrowserWorkspaceState> {
    if (!parseBrowserWorkspaceRequest("setSitePermission", request)) throw new Error("bad-request");
    if (request.permission === "fullscreen" && request.decision === "allow" && !this.deps.fullscreenAvailable(windowId)) throw new Error("operation-failed");
    const target = this.target(windowId, request);
    const url = browserWorkspaceUrl(target.guest.getURL());
    if (!url || new URL(url).origin !== request.origin) throw new Error("origin-mismatch");
    await this.store.setSitePermission({ origin: request.origin, permission: request.permission, decision: request.decision });
    this.permissions.invalidateAll();
    await this.changed();
    return this.getState(windowId);
  }
  find(windowId: number, request: BrowserFindRequest): { requestId: number } {
    if (!parseBrowserWorkspaceRequest("find", request)) throw new Error("bad-request");
    return { requestId: this.target(windowId, request).guest.findInPage(request.text, { forward: request.forward, findNext: request.findNext }) };
  }
  stopFind(windowId: number, request: BrowserWorkspaceTarget): null { this.target(windowId, request).guest.stopFindInPage("clearSelection"); return null; }
  zoom(windowId: number, request: BrowserZoomRequest): { factor: number } {
    if (!parseBrowserWorkspaceRequest("zoom", request)) throw new Error("bad-request");
    const guest = this.target(windowId, request).guest;
    guest.setZoomFactor(request.factor);
    this.notify();
    return { factor: guest.getZoomFactor() };
  }
  preview(windowId: number, request: BrowserWorkspaceTarget) { this.target(windowId, request); return this.previews.capture(windowId, request); }
  requestPermission(guestId: number, permission: string, details: BrowserPermissionDetails): Promise<boolean> { return this.permissions.request(guestId, permission, details); }
  checkPermission(guestId: number, permission: string, details: BrowserPermissionDetails): boolean { return this.permissions.check(guestId, permission, details); }
  observeGuest(windowId: number, guest: WebContents): () => void {
    const guestId = guest.id;
    const existing = this.guests.get(guestId);
    if (existing && existing.windowId !== windowId) throw new Error("guest-owner-mismatch");
    if (existing) return existing.dispose;
    const invalidate = () => { const entry = this.guests.get(guestId); if (entry) entry.generation++; this.permissions.invalidateGuest(guestId); this.previews.invalidateGuest(guestId); this.notify(); };
    const visit = () => { if (!guest.isDestroyed()) void this.store.recordVisit(guest.getURL(), guest.getTitle()).then(() => this.changed()).catch(this.deps.onError); };
    const started = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) invalidate(); };
    const navigatedInPage = (_event: unknown, _url: string, mainFrame: boolean) => { if (mainFrame) { invalidate(); visit(); } };
    const dispose = () => { guest.removeListener("did-start-navigation", started); guest.removeListener("did-navigate", visit); guest.removeListener("did-navigate-in-page", navigatedInPage); guest.removeListener("page-title-updated", titleChanged); guest.removeListener("destroyed", dispose); this.guests.delete(guestId); this.permissions.invalidateGuest(guestId); this.previews.invalidateGuest(guestId); this.notify(); };
    const titleChanged = () => { if (!guest.isDestroyed()) void this.store.updateHistoryTitle(guest.getURL(), guest.getTitle()).then(() => this.changed()).catch(this.deps.onError); };
    this.guests.set(guestId, { guest, windowId, generation: 1, dispose });
    guest.on("did-start-navigation", started); guest.on("did-navigate", visit); guest.on("did-navigate-in-page", navigatedInPage); guest.on("page-title-updated", titleChanged); guest.once("destroyed", dispose);
    return dispose;
  }
  observeDownload(windowId: number, item: DownloadItem): void {
    const id = `download-${this.nextDownload++}`;
    const at = (this.deps.now ?? Date.now)();
    const update = (state: BrowserDownload["state"]) => {
      const entry: BrowserDownload = { id, name: item.getFilename().slice(0, 300), receivedBytes: Math.max(0, item.getReceivedBytes()), totalBytes: Math.max(0, item.getTotalBytes()), state, at };
      this.downloads.set(windowId, [entry, ...(this.downloads.get(windowId) ?? []).filter((candidate) => candidate.id !== id)].slice(0, BROWSER_WORKSPACE_LIMITS.downloads));
      this.notify();
    };
    const updated = (_event: unknown, state: "progressing" | "interrupted") => update(state);
    const dispose = () => { item.removeListener("updated", updated); item.removeListener("done", done); this.downloadDisposers.get(windowId)?.delete(dispose); };
    const done = (_event: unknown, state: "completed" | "cancelled" | "interrupted") => { dispose(); update(state); };
    const disposers = this.downloadDisposers.get(windowId) ?? new Set<() => void>();
    disposers.add(dispose);
    this.downloadDisposers.set(windowId, disposers);
    item.on("updated", updated);
    item.once("done", done);
    update("progressing");
  }
  invalidateWindow(windowId: number): void { this.previews.invalidateWindow(windowId); }
  disposeWindow(windowId: number): void {
    this.windows.delete(windowId); this.downloads.delete(windowId); this.previews.disposeWindow(windowId);
    for (const dispose of this.downloadDisposers.get(windowId) ?? []) dispose();
    this.downloadDisposers.delete(windowId);
    for (const entry of this.guests.values()) if (entry.windowId === windowId) entry.dispose();
  }
  dispose(): void { for (const windowId of [...this.windows]) this.disposeWindow(windowId); for (const entry of this.guests.values()) entry.dispose(); this.listeners.clear(); }
}
export function createBrowserWorkspaceService(deps: BrowserWorkspaceServiceDeps): BrowserWorkspaceService { return new BrowserWorkspaceService(deps); }
