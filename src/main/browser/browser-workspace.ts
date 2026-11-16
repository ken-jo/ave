import { setBrowserGuestZoomFactor } from "./browser-guest-tracking.js";
import { subscribeBrowserGuestDestroyed } from "./browser-guest-lifecycle.js";
import type { DownloadItem, WebContents } from "electron";
import { describeLoadFailure, describePageCrash } from "./browser-load-failure.js";
import { BrowserPagePrompts } from "./browser-page-prompts.js";
import { BROWSER_WORKSPACE_LIMITS, browserWorkspaceUrl, parseBrowserWorkspaceRequest, type BrowserLoadError, type BrowserLoadRequest, type BrowserPageStatus, type BrowserPromptAnswerRequest, type BrowserBookmarkRequest, type BrowserCaptureRequest, type BrowserDownload, type BrowserPreview, type BrowserFindRequest, type BrowserSitePermissionRequest, type BrowserWorkspaceState, type BrowserWorkspaceTarget, type BrowserWorkspaceTab, type BrowserZoomRequest } from "../../shared/browser-workspace.js";
import { BrowserWorkspacePreview } from "./browser-workspace-preview.js";
import { BrowserWorkspaceCapture } from "./browser-workspace-capture.js";
import { BrowserWorkspaceStore } from "./browser-workspace-store.js";
import { BrowserSitePermissionPolicy, type BrowserPermissionDetails, type BrowserPermissionPrompt } from "./browser-site-permissions.js";

export interface BrowserPageRequest { readonly webContentsId?: number; readonly resourceType: string; readonly url: string }
export type BrowserPageRequestHold = (request: BrowserPageRequest, answer: (send: boolean) => void) => void;
export interface BrowserWorkspaceLiveTab { readonly guest: WebContents; readonly documentGeneration: number }
export interface BrowserWorkspaceServiceDeps {
  liveTab(windowId: number, tabId: string): BrowserWorkspaceLiveTab | null;
  listTabs(windowId: number): readonly Omit<BrowserWorkspaceTab, "zoomFactor">[];
  isWindowVisible(windowId: number): boolean;
  /**
   * Routes the browser profile's requests through `hold` until called again with null. `hold` answers every request it
   * is given: true sends it as the page made it, false cancels it.
   */
  holdPageRequests(hold: BrowserPageRequestHold | null): void;
  /** Asks in a native dialog, for a guest that has no tab panel to ask in (a popup window). */
  promptPermission(request: BrowserPermissionPrompt): Promise<boolean>;
  fullscreenAvailable(windowId: number): boolean;
  onError(error: unknown): void;
  readonly store?: BrowserWorkspaceStore;
  readonly now?: () => number;
}

export class BrowserWorkspaceService {
  readonly store: BrowserWorkspaceStore;
  private readonly previews: BrowserWorkspacePreview;
  private readonly captures: BrowserWorkspaceCapture;
  private readonly permissions: BrowserSitePermissionPolicy;
  private readonly prompts = new BrowserPagePrompts(() => this.notify());
  private readonly guests = new Map<number, { guest: WebContents; windowId: number; generation: number; loading: boolean; loadError: BrowserLoadError | null; userNavigation: "none" | "marked" | "loading"; unloadHeld: boolean; dispose: () => void }>();
  private readonly downloads = new Map<number, BrowserDownload[]>();
  private readonly downloadDisposers = new Map<number, Set<() => void>>();
  private readonly listeners = new Set<(windowId: number, state: BrowserWorkspaceState) => void>();
  private readonly windows = new Set<number>();
  private readonly publishedTabs = new Map<number, string>();
  /** Page-started navigations whose unload asked to stay, by guest: their request waits unsent for the user's answer. */
  private readonly heldLeaves = new Map<number, { readonly url: string; readonly origin: string }>();
  private leaveQuestions = 0;
  private holdingRequests = false;
  private revision = 0;
  private nextDownload = 1;
  constructor(private readonly deps: BrowserWorkspaceServiceDeps) {
    this.store = deps.store ?? new BrowserWorkspaceStore();
    this.previews = new BrowserWorkspacePreview(deps);
    this.captures = new BrowserWorkspaceCapture(deps);
    this.permissions = new BrowserSitePermissionPolicy({ store: this.store, prompt: async (request) => {
      if (!deps.isWindowVisible(request.windowId)) return null;
      // A tab asks in its own panel. A popup window has no panel, so it keeps the native question.
      if (this.tabIdForGuest(request.windowId, request.guestId) === null) return await deps.promptPermission(request) ? "allow-once" : null;
      const answer = await this.prompts.ask(request.guestId, "permission", { origin: request.origin, permissions: request.permissions });
      if (answer?.choice === "always-block") this.notify();
      return answer?.choice ?? null;
    }, fullscreenAvailable: deps.fullscreenAvailable, currentContext: (guestId) => {
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
  private syncRequestHold(): void {
    const hold = this.heldLeaves.size > 0 || this.leaveQuestions > 0;
    if (hold === this.holdingRequests) return;
    this.holdingRequests = hold;
    this.deps.holdPageRequests(hold ? this.holdRequest : null);
  }
  private releaseLeave(guestId: number): void {
    if (this.heldLeaves.delete(guestId)) this.syncRequestHold();
  }
  /**
   * The held navigation's own request, exactly as the page made it (a form keeps its method and body), waits here
   * unsent. Leave sends it; Stay stops the navigation before anything is sent, so the document stays as it was.
   */
  private readonly holdRequest: BrowserPageRequestHold = (request, answer) => {
    const guestId = request.webContentsId;
    const held = guestId === undefined ? undefined : this.heldLeaves.get(guestId);
    if (guestId === undefined || !held || request.resourceType !== "mainFrame" || browserWorkspaceUrl(request.url) !== held.url) { answer(true); return; }
    this.leaveQuestions++;
    this.releaseLeave(guestId);
    void this.prompts.ask(guestId, "leave", { origin: held.origin }).then((choice) => {
      const guest = this.guests.get(guestId)?.guest;
      // Stay stops the navigation. A question that ended without an answer ended because the page or the user moved on,
      // and that navigation is already gone: it is only cancelled, never stopped, so a newer navigation goes on.
      if (choice && !choice.leave && guest && !guest.isDestroyed()) guest.stop();
      answer(choice?.leave === true);
      this.leaveQuestions--;
      this.syncRequestHold();
    });
  };
  private tabIdForGuest(windowId: number, guestId: number): string | null {
    for (const tab of this.deps.listTabs(windowId)) {
      const live = this.deps.liveTab(windowId, tab.tabId);
      if (live && !live.guest.isDestroyed() && live.guest.id === guestId) return tab.tabId;
    }
    return null;
  }
  /**
   * The tab list is owned elsewhere: a guest is bound to its tab after it attaches, and a page can fail before that. Page
   * status is keyed by tab, so a window whose listed tabs differ from the last snapshot it was sent gets a new one.
   */
  tabsChanged(windowId: number): void {
    if (!this.windows.has(windowId)) return;
    const listed = this.deps.listTabs(windowId).filter((tab) => {
      const live = this.deps.liveTab(windowId, tab.tabId);
      return live && !live.guest.isDestroyed() && live.documentGeneration === tab.documentGeneration;
    }).map((tab) => `${tab.tabId}:${tab.documentGeneration}`).join("\n");
    if (this.publishedTabs.get(windowId) !== listed) this.notify();
  }
  async getState(windowId: number): Promise<BrowserWorkspaceState> {
    this.windows.add(windowId);
    const revision = ++this.revision;
    const snapshot = await this.store.snapshot();
    const pages: BrowserPageStatus[] = [];
    const tabs = this.deps.listTabs(windowId).flatMap((tab) => {
      const live = this.deps.liveTab(windowId, tab.tabId);
      if (!live || live.guest.isDestroyed() || live.documentGeneration !== tab.documentGeneration) return [];
      const page = this.guests.get(live.guest.id);
      pages.push({ tabId: tab.tabId, loading: page?.loading ?? false, loadError: page?.loadError ?? null, prompts: this.prompts.list(live.guest.id) });
      return [{ ...tab, title: tab.title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), zoomFactor: live.guest.getZoomFactor() }];
    });
    this.publishedTabs.set(windowId, tabs.map((tab) => `${tab.tabId}:${tab.documentGeneration}`).join("\n"));
    return { ...snapshot, revision, tabs, pages, downloads: structuredClone(this.downloads.get(windowId) ?? []), capabilities: { fullscreen: this.deps.fullscreenAvailable(windowId) } };
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
    setBrowserGuestZoomFactor(guest, request.factor);
    this.notify();
    return { factor: guest.getZoomFactor() };
  }
  /** The failed address is loaded again as it was recorded; a crashed page is reloaded where it was. */
  retryLoad(windowId: number, request: BrowserWorkspaceTarget): null {
    const guest = this.target(windowId, request).guest;
    const failure = this.guests.get(guest.id)?.loadError;
    if (!failure) throw new Error("operation-failed");
    if (failure.reason === "crashed") { guest.reload(); return null; }
    if (!failure.url) throw new Error("operation-failed");
    // A load that fails again rejects here and is reported once more through the guest's own failure event.
    void guest.loadURL(failure.url).catch(this.deps.onError);
    return null;
  }
  load(windowId: number, request: BrowserLoadRequest): null {
    const parsed = parseBrowserWorkspaceRequest("load", request);
    if (!parsed) throw new Error("bad-request");
    // A load that fails rejects here and is reported through the guest's own failure event.
    void this.target(windowId, parsed).guest.loadURL(parsed.url).catch(this.deps.onError);
    return null;
  }
  /** Marks the tab's next unload as the user's own, started from the app's controls. Consumed by that unload or navigation. */
  userNavigation(windowId: number, request: BrowserWorkspaceTarget): null {
    const entry = this.guests.get(this.target(windowId, request).guest.id);
    if (!entry) throw new Error("no-such-tab");
    entry.userNavigation = "marked";
    this.releaseLeave(entry.guest.id);
    return null;
  }
  answerPrompt(windowId: number, request: BrowserPromptAnswerRequest): null {
    const parsed = parseBrowserWorkspaceRequest("answerPrompt", request);
    if (!parsed) throw new Error("bad-request");
    const live = this.deps.liveTab(windowId, parsed.tabId);
    if (!live || live.guest.isDestroyed()) throw new Error("no-such-tab");
    // The prompt id proves which question is answered; a question whose document left is already gone.
    if (!this.prompts.answer(live.guest.id, parsed.promptId, parsed.answer)) throw new Error("stale-document");
    return null;
  }
  stopLoad(windowId: number, request: BrowserWorkspaceTarget): null { this.target(windowId, request).guest.stop(); return null; }
  preview(windowId: number, request: BrowserWorkspaceTarget) { this.target(windowId, request); return this.previews.capture(windowId, request); }
  capture(windowId: number, request: BrowserCaptureRequest) { this.target(windowId, request); return this.captures.capture(windowId, request); }
  recordAgentCapture(windowId: number, preview: BrowserPreview): void { this.previews.remember(windowId, preview); }
  requestPermission(guestId: number, permission: string, details: BrowserPermissionDetails): Promise<boolean> { return this.permissions.request(guestId, permission, details); }
  checkPermission(guestId: number, permission: string, details: BrowserPermissionDetails): boolean { return this.permissions.check(guestId, permission, details); }
  observeGuest(windowId: number, guest: WebContents): () => void {
    const guestId = guest.id;
    const existing = this.guests.get(guestId);
    if (existing && existing.windowId !== windowId) throw new Error("guest-owner-mismatch");
    if (existing) return existing.dispose;
    const invalidate = () => { const entry = this.guests.get(guestId); if (entry) entry.generation++; this.prompts.dismissGuest(guestId); this.permissions.invalidateGuest(guestId); this.previews.invalidateGuest(guestId); this.captures.invalidateGuest(guestId); this.notify(); };
    const visit = () => { if (!guest.isDestroyed()) void this.store.recordVisit(guest.getURL(), guest.getTitle()).then(() => this.changed()).catch(this.deps.onError); };
    const started = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
      if (!mainFrame) return;
      // The browser commits its own internal error document after a failure; that is not the user leaving the failed page.
      const entry = this.guests.get(guestId);
      if (entry && !inPlace && !url.startsWith("chrome-error:")) entry.loadError = null;
      invalidate();
    };
    // The page's unload handler asked to hold a navigation back. That decision is synchronous and names no destination,
    // so the unload is always let through here (preventing the event's default lets the page unload) and the question
    // is asked one step later, where a navigation the page itself started announces its address and can still be
    // cancelled with the document intact. The user's own navigation from the app's controls is never questioned.
    const preventUnload = (event: { preventDefault(): void }) => {
      const entry = this.guests.get(guestId);
      if (!entry) return;
      entry.unloadHeld = entry.userNavigation === "none" && this.tabIdForGuest(windowId, guestId) !== null;
      entry.userNavigation = "none";
      event.preventDefault();
    };
    const pageNavigation = (event: { preventDefault(): void; url?: string; isMainFrame?: boolean }, legacyUrl?: string) => {
      const entry = this.guests.get(guestId);
      if (!entry?.unloadHeld || event.isMainFrame === false) return;
      entry.unloadHeld = false;
      const destination = browserWorkspaceUrl(typeof event.url === "string" ? event.url : legacyUrl);
      const origin = browserWorkspaceUrl(guest.getURL());
      // A destination that sends no web request cannot be held unsent, so the page is not let leave for it.
      if (destination === null || origin === null || this.prompts.list(guestId).some((prompt) => prompt.kind === "leave")) { event.preventDefault(); return; }
      this.heldLeaves.set(guestId, { url: destination, origin: new URL(origin).origin });
      this.syncRequestHold();
    };
    const failed = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
      // -3 is a load the user or a newer navigation aborted, not a failure to show.
      const entry = this.guests.get(guestId);
      if (mainFrame) this.releaseLeave(guestId);
      if (!entry || !mainFrame || code === -3) return;
      entry.loadError = describeLoadFailure(code, description, url);
      this.notify();
    };
    const loading = (value: boolean) => () => {
      const entry = this.guests.get(guestId);
      if (!entry || entry.loading === value) return;
      entry.loading = value;
      this.notify();
    };
    // The user's mark is spent by the unload question it was made for. A navigation that asks nothing still ends it:
    // when the page commits, or when a load that began after the mark stops. A load already running when the mark was
    // made is not that load, so its end leaves the mark alone.
    const markLoading = loading(true);
    const stopped = loading(false);
    const loadStarted = () => {
      const entry = this.guests.get(guestId);
      if (entry?.userNavigation === "marked") entry.userNavigation = "loading";
      markLoading();
    };
    const loadStopped = () => {
      const entry = this.guests.get(guestId);
      if (entry?.userNavigation === "loading") entry.userNavigation = "none";
      stopped();
    };
    const committed = () => { const entry = this.guests.get(guestId); if (entry) { entry.userNavigation = "none"; entry.unloadHeld = false; } this.releaseLeave(guestId); };
    const gone = (_event: unknown, details: { reason: string }) => {
      const entry = this.guests.get(guestId);
      if (!entry || details.reason === "clean-exit" || guest.isDestroyed()) return;
      entry.loadError = describePageCrash(details.reason, guest.getURL());
      this.notify();
    };
    const navigatedInPage = (_event: unknown, _url: string, mainFrame: boolean) => { if (mainFrame) { invalidate(); visit(); } };
    let unsubscribe = () => {};
    const dispose = () => { guest.removeListener("did-start-navigation", started); guest.removeListener("did-fail-load", failed); guest.removeListener("render-process-gone", gone); guest.removeListener("will-navigate", pageNavigation); guest.removeListener("did-navigate", committed); guest.removeListener("will-prevent-unload", preventUnload); guest.removeListener("did-start-loading", loadStarted); guest.removeListener("did-stop-loading", loadStopped); guest.removeListener("did-navigate", visit); guest.removeListener("did-navigate-in-page", navigatedInPage); guest.removeListener("page-title-updated", titleChanged); unsubscribe(); this.guests.delete(guestId); this.releaseLeave(guestId); this.prompts.dismissGuest(guestId); this.permissions.invalidateGuest(guestId); this.previews.invalidateGuest(guestId); this.captures.invalidateGuest(guestId); this.notify(); };
    const titleChanged = () => { if (!guest.isDestroyed()) void this.store.updateHistoryTitle(guest.getURL(), guest.getTitle()).then(() => this.changed()).catch(this.deps.onError); };
    this.guests.set(guestId, { guest, windowId, generation: 1, loading: guest.isLoadingMainFrame(), loadError: null, userNavigation: "none", unloadHeld: false, dispose });
    guest.on("will-navigate", pageNavigation); guest.on("did-navigate", committed); guest.on("will-prevent-unload", preventUnload);
    guest.on("did-fail-load", failed); guest.on("render-process-gone", gone);
    guest.on("did-start-loading", loadStarted); guest.on("did-stop-loading", loadStopped);
    guest.on("did-start-navigation", started); guest.on("did-navigate", visit); guest.on("did-navigate-in-page", navigatedInPage); guest.on("page-title-updated", titleChanged);
    unsubscribe = subscribeBrowserGuestDestroyed(guest, dispose);
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
  invalidateWindow(windowId: number): void { this.previews.invalidateWindow(windowId); this.captures.invalidateWindow(windowId); }
  disposeWindow(windowId: number): void {
    this.windows.delete(windowId); this.publishedTabs.delete(windowId); this.downloads.delete(windowId); this.previews.disposeWindow(windowId);
    this.captures.invalidateWindow(windowId);
    for (const dispose of this.downloadDisposers.get(windowId) ?? []) dispose();
    this.downloadDisposers.delete(windowId);
    for (const entry of this.guests.values()) if (entry.windowId === windowId) entry.dispose();
  }
  dispose(): void { for (const windowId of [...this.windows]) this.disposeWindow(windowId); for (const entry of this.guests.values()) entry.dispose(); this.listeners.clear(); }
}
export function createBrowserWorkspaceService(deps: BrowserWorkspaceServiceDeps): BrowserWorkspaceService { return new BrowserWorkspaceService(deps); }
