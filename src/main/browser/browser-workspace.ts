import { matchesAccelerator, type ShortcutPlatform } from "../../shared/shortcuts.js";
import { setBrowserGuestZoomFactor } from "./browser-guest-tracking.js";
import { subscribeBrowserGuestDestroyed } from "./browser-guest-lifecycle.js";
import type { WebContents } from "electron";
import type { DoneState, ObservedDownload } from "./browser-download-staging.js";
import { describeLoadFailure, describePageCrash } from "./browser-load-failure.js";
import { dismissedPageDialogs } from "./browser-page-dialogs.js";
import { BrowserPagePrompts } from "./browser-page-prompts.js";

/** The runtime's request to show a page dialog: (details, respond). */
const RUN_DIALOG = "-run-dialog";
import { BROWSER_DIALOG_DOCUMENT_LIMIT, BROWSER_PAGE_DIALOG_TYPES, browserDialogText, BROWSER_EXTERNAL_SCHEMES, BROWSER_EXTERNAL_TARGET_LIMIT, BROWSER_REALM_LIMIT, browserPlainText, BROWSER_WORKSPACE_LIMITS, browserWorkspaceUrl, parseBrowserWorkspaceRequest, type BrowserClearDataRequest, type BrowserClearSiteDataRequest, BROWSER_PAGE_SHORTCUT_ACTIONS, type BrowserDownloadBlockReason, type BrowserDownloadNotice, type BrowserFindResult, type BrowserPageShortcut, type BrowserPageShortcutAction, type BrowserPageShortcuts, type BrowserHistoryTarget, type BrowserDownloadTarget, type BrowserLoadError, type BrowserOpenTab, type BrowserLoadRequest, type BrowserPageStatus, type BrowserPromptAnswerRequest, type BrowserBookmarkRequest, type BrowserCaptureRequest, type BrowserDownload, type BrowserPreview, type BrowserFindRequest, type BrowserSitePermissionRequest, type BrowserWorkspaceState, type BrowserWorkspaceTarget, type BrowserWorkspaceTab, type BrowserZoomRequest } from "../../shared/browser-workspace.js";
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
  /** Clears cookies and stored site data of the browser profile: of one origin, or of every site when null. */
  clearSiteData(origin: string | null): Promise<void>;
  clearCache(): Promise<void>;
  /** Lifts the site's download limit after the user asked for that in the tab. */
  allowDownloads(origin: string): void;
  showItemInFolder(path: string): void;
  /** The platform whose key names the registry's accelerators are read with. */
  platform: ShortcutPlatform;
  /** The conversation whose agent owns the tab, or null when no agent does. */
  agentSessionOf(windowId: number, tabId: string): string | null;
  /** Whether the agent is driving this page right now: its dialogs are dismissed and reported, never shown. */
  agentDrives(guestId: number): boolean;
  /** Hands a link to the system's own app for it. Called only for a scheme in BROWSER_EXTERNAL_SCHEMES the user agreed to. */
  openExternal(url: string): Promise<void>;
  onError(error: unknown): void;
  readonly store?: BrowserWorkspaceStore;
  readonly now?: () => number;
}

interface PageDialogFrame { readonly origin: string; readonly detached: boolean; readonly top: { readonly frameTreeNodeId: number } | null }

/** The web origin of the frame that called a dialog, or null when the frame is not this page's or its origin is opaque. */
function pageDialogOrigin(guest: WebContents, frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const { origin, detached, top } = frame as Partial<PageDialogFrame>;
  if (typeof origin !== "string" || detached !== false || !top || top.frameTreeNodeId !== guest.mainFrame.frameTreeNodeId) return null;
  const url = browserWorkspaceUrl(origin);
  return url !== null && new URL(url).origin === origin ? origin : null;
}

export class BrowserWorkspaceService {
  readonly store: BrowserWorkspaceStore;
  private readonly previews: BrowserWorkspacePreview;
  private readonly captures: BrowserWorkspaceCapture;
  private readonly permissions: BrowserSitePermissionPolicy;
  private readonly prompts = new BrowserPagePrompts(() => this.notify());
  private readonly guests = new Map<number, { guest: WebContents; windowId: number; generation: number; loading: boolean; loadError: BrowserLoadError | null; userNavigation: "none" | "marked" | "loading"; unloadHeld: boolean; dialogs: number; dialogsBlocked: boolean; dispose: () => void }>();
  private readonly downloads = new Map<number, BrowserDownload[]>();
  private readonly downloadDisposers = new Map<number, Set<() => void>>();
  private readonly listeners = new Set<(windowId: number, state: BrowserWorkspaceState) => void>();
  private readonly activeDownloads = new Map<string, ObservedDownload>();
  private readonly downloadPaths = new Map<string, string>();
  private readonly pageShortcutListeners = new Set<(windowId: number, shortcut: BrowserPageShortcut) => void>();
  private readonly pageShortcuts = new Map<number, BrowserPageShortcuts>();
  private readonly findResultListeners = new Set<(windowId: number, result: BrowserFindResult) => void>();
  private readonly openTabListeners = new Set<(windowId: number, request: BrowserOpenTab) => void>();
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
      // A tab asks in its own panel, also while it is not yet bound to its tab: the question waits there until it is.
      // Only a popup window has no panel, so it keeps the native question.
      if (this.isPopupGuest(request.windowId, request.guestId)) return await deps.promptPermission(request) ? "allow-once" : null;
      const answer = await this.prompts.ask(request.guestId, "permission", { origin: request.origin, permissions: request.permissions });
      if (answer?.choice === "always-block") this.notify();
      return answer?.choice ?? null;
    }, fullscreenAvailable: deps.fullscreenAvailable, currentContext: (guestId) => {
      const entry = this.guests.get(guestId);
      return entry && !entry.guest.isDestroyed() ? { guestId, windowId: entry.windowId, documentGeneration: entry.generation, url: entry.guest.getURL() } : null;
    } });
  }
  onPageShortcut(handler: (windowId: number, shortcut: BrowserPageShortcut) => void): () => void { this.pageShortcutListeners.add(handler); return () => this.pageShortcutListeners.delete(handler); }
  /** The keys a window's pages answer to. Until the window says, its pages take no key from the app. */
  setPageShortcuts(windowId: number, request: BrowserPageShortcuts): null {
    const parsed = parseBrowserWorkspaceRequest("setPageShortcuts", request);
    if (!parsed) throw new Error("bad-request");
    this.pageShortcuts.set(windowId, parsed);
    return null;
  }
  /** The action a key pressed in a tab's page asks for, or null when the key is the page's own. */
  private pageShortcutFor(windowId: number, input: { type: string; key: string; code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }): BrowserPageShortcutAction | null {
    const shortcuts = this.pageShortcuts.get(windowId);
    if (!shortcuts || input.type !== "keyDown") return null;
    const event = { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
    return BROWSER_PAGE_SHORTCUT_ACTIONS.find((action) => matchesAccelerator(shortcuts[action], event, this.deps.platform)) ?? null;
  }
  onFindResult(handler: (windowId: number, result: BrowserFindResult) => void): () => void { this.findResultListeners.add(handler); return () => this.findResultListeners.delete(handler); }
  onOpenTab(handler: (windowId: number, request: BrowserOpenTab) => void): () => void { this.openTabListeners.add(handler); return () => this.openTabListeners.delete(handler); }
  /**
   * A page asked for a link in a new tab. The tab opens in the panel beside the tab that asked, with the same address
   * row and controls as any other tab, instead of a bare window. False when the asking guest is not a listed tab or the
   * address is not a web page: the caller then decides as it did before.
   */
  openLinkTab(windowId: number, guestId: number, url: string, active: boolean): boolean {
    const openerTabId = this.tabIdForGuest(windowId, guestId);
    const target = browserWorkspaceUrl(url);
    if (openerTabId === null || target === null || this.openTabListeners.size === 0) return false;
    for (const listener of this.openTabListeners) listener(windowId, { openerTabId, url: target, active });
    return true;
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
  /** A page with no tab to ask in. An embedded page can run before its tab is bound; that does not make it a popup. */
  private isPopupGuest(windowId: number, guestId: number): boolean {
    const guest = this.guests.get(guestId)?.guest;
    return guest !== undefined && !guest.isDestroyed() && guest.getType() !== "webview" && this.tabIdForGuest(windowId, guestId) === null;
  }
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
      // A tab whose first load has not committed has no address yet. It is listed as the blank document it shows, so its
      // page status (a load in progress, a question from the server) reaches the tab instead of voiding the snapshot.
      return [{ ...tab, url: tab.url === "" ? "about:blank" : tab.url, title: tab.title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), zoomFactor: live.guest.getZoomFactor() }];
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
  /** The conversation whose agent owns this tab, once the request is shown to name the site the tab is on; null for a tab no agent owns. */
  agentSessionForSite(windowId: number, request: BrowserClearSiteDataRequest): string | null {
    const parsed = parseBrowserWorkspaceRequest("agentSiteGrant", request);
    if (!parsed) throw new Error("bad-request");
    const url = browserWorkspaceUrl(this.target(windowId, parsed).guest.getURL());
    if (!url || new URL(url).origin !== parsed.origin) throw new Error("origin-mismatch");
    return this.deps.agentSessionOf(windowId, parsed.tabId);
  }
  async deleteHistory(windowId: number, request: BrowserHistoryTarget): Promise<BrowserWorkspaceState> { await this.store.deleteHistory(request); await this.changed(); return this.getState(windowId); }
  /** Clears what the user chose from the profile every tab shares. Site data ends sign-ins; the pages stay open. */
  async clearData(windowId: number, request: BrowserClearDataRequest): Promise<BrowserWorkspaceState> {
    const parsed = parseBrowserWorkspaceRequest("clearData", request);
    if (!parsed) throw new Error("bad-request");
    if (parsed.history) await this.store.clearHistory();
    if (parsed.siteData) await this.deps.clearSiteData(null);
    if (parsed.cache) await this.deps.clearCache();
    await this.changed();
    return this.getState(windowId);
  }
  /** Clears the cookies and stored data of the one site the tab shows; the request must name that site. */
  async clearSiteData(windowId: number, request: BrowserClearSiteDataRequest): Promise<null> {
    const parsed = parseBrowserWorkspaceRequest("clearSiteData", request);
    if (!parsed) throw new Error("bad-request");
    const url = browserWorkspaceUrl(this.target(windowId, parsed).guest.getURL());
    if (!url || new URL(url).origin !== parsed.origin) throw new Error("origin-mismatch");
    await this.deps.clearSiteData(parsed.origin);
    return null;
  }
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
  /** The same mark for a navigation the user starts from the host's own page menu, which knows the guest, not the tab. */
  userNavigatesGuest(guestId: number): void {
    const entry = this.guests.get(guestId);
    if (entry) entry.userNavigation = "marked";
    this.releaseLeave(guestId);
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
    // A picture of the page goes stale with every navigation, and a page that starts leaving drops its open questions.
    // What belongs to the document (its generation, which keys its permission answers, and its dialog count and Block)
    // ends only when another document commits: a fragment or history change, or a navigation that never commits
    // (a download, an empty response, a cancelled load), keeps them.
    const invalidateView = () => { this.previews.invalidateGuest(guestId); this.captures.invalidateGuest(guestId); this.notify(); };
    const leaving = () => { this.prompts.dismissGuest(guestId); invalidateView(); };
    const replaced = () => { const entry = this.guests.get(guestId); if (entry) { entry.generation++; entry.dialogs = 0; entry.dialogsBlocked = false; } this.prompts.dismissGuest(guestId); this.permissions.invalidateGuest(guestId); invalidateView(); };
    const visit = () => { if (!guest.isDestroyed()) void this.store.recordVisit(guest.getURL(), guest.getTitle(), this.deps.agentDrives(guestId) ? "agent" : "user").then(() => this.changed()).catch(this.deps.onError); };
    const started = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
      if (!mainFrame) return;
      // The browser commits its own internal error document after a failure; that is not the user leaving the failed page.
      const entry = this.guests.get(guestId);
      if (entry && !inPlace && !url.startsWith("chrome-error:")) entry.loadError = null;
      if (inPlace) invalidateView(); else leaving();
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
    // A link that is not a web page never loads in the tab. Instead of failing silently the tab says so, and offers to
    // hand a mail or phone link to the system's own app. The address shown is the link's own text, bounded, as plain text.
    const externalLink = (url: string) => {
      const scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(url)?.[1]?.toLowerCase();
      const origin = browserWorkspaceUrl(guest.getURL());
      if (!scheme || scheme === "http" || scheme === "https" || origin === null || this.tabIdForGuest(windowId, guestId) === null) return;
      if (this.prompts.list(guestId).some((prompt) => prompt.kind === "external")) return;
      const openable = BROWSER_EXTERNAL_SCHEMES.includes(scheme) && url.length <= 2_000;
      const target = openable ? browserPlainText(url.slice(scheme.length + 1).split("?")[0] ?? "").slice(0, BROWSER_EXTERNAL_TARGET_LIMIT) : "";
      void this.prompts.ask(guestId, "external", { origin: new URL(origin).origin, scheme, target, openable }).then((answer) => {
        if (answer?.open && openable) void this.deps.openExternal(url).catch(this.deps.onError);
      });
    };
    // alert and confirm. The runtime's own handler shows a window-blocking message box that names no site, so
    // this guest's dialogs are answered here instead, through the runtime's dialog request event (it carries the type,
    // the text and the callback that resumes the page). Exactly one handler is expected there; anything else means the
    // runtime changed and must fail loudly, not fall back to the unlabelled box.
    const runtimeDialogs = guest.listeners(RUN_DIALOG as never) as ((...args: unknown[]) => void)[];
    if (runtimeDialogs.length !== 1) throw new Error("page-dialog-handler-missing");
    const pageDialog = (info: { dialogType?: unknown; messageText?: unknown; frame?: unknown }, respond: (accepted: boolean, value: string) => void) => {
      const entry = this.guests.get(guestId);
      const type = BROWSER_PAGE_DIALOG_TYPES.find((item) => item === info.dialogType);
      // The dialog is titled with the site of the frame that called it, which an embedded frame may not share with the
      // page. A frame that is not this page's, or whose origin names no web site, gets no dialog.
      const origin = pageDialogOrigin(guest, info.frame);
      if (!entry || !type || origin === null) { respond(false, ""); return; }
      const message = typeof info.messageText === "string" ? info.messageText : "";
      // The agent's turn never waits on a page: the dialog ends unanswered and its text goes back with the tool result.
      if (this.deps.agentDrives(guestId)) { dismissedPageDialogs.note(guestId, type, message); respond(false, ""); return; }
      // A popup window has no tab, so no panel to ask in, and keeps the runtime's own dialog. Every tab, whether the
      // user or the agent opened it and whether or not it is bound yet, has the prompt row.
      if (this.isPopupGuest(windowId, guestId)) { runtimeDialogs[0]?.(info, respond); return; }
      entry.dialogs++;
      if (entry.dialogsBlocked || entry.dialogs > BROWSER_DIALOG_DOCUMENT_LIMIT) { respond(false, ""); return; }
      void this.prompts.ask(guestId, "dialog", {
        origin, dialog: type, message: browserDialogText(message), canBlock: entry.dialogs > 1,
      }).then((answer) => {
        const current = this.guests.get(guestId);
        if (answer?.block && current) current.dialogsBlocked = true;
        respond(answer?.accept ?? false, "");
      });
    };
    const cancelDialogs = () => this.prompts.dismissGuest(guestId, (prompt) => prompt.kind === "dialog");
    guest.removeAllListeners(RUN_DIALOG as never);
    guest.on(RUN_DIALOG as never, pageDialog as never); guest.on("-cancel-dialogs" as never, cancelDialogs as never);
    // The server asks for a user name and password. Unhandled, the request is cancelled and the page just fails. A user's
    // own tab asks in its panel, naming the origin of the request as main computed it; the answer goes to that one
    // request and is kept nowhere. A proxy, and a page the agent is driving in its own view, are refused as before.
    // A new tab's first request can arrive before the tab is listed; the question waits in the queue and shows once it is.
    const signIn = (event: { preventDefault(): void }, details: { url?: string }, auth: { isProxy?: boolean; realm?: string }, respond: (username?: string, password?: string) => void) => {
      const origin = browserWorkspaceUrl(details.url);
      if (auth.isProxy || origin === null || guest.getType() !== "webview") return;
      if (this.prompts.list(guestId).some((prompt) => prompt.kind === "signIn")) return;
      event.preventDefault();
      const realm = browserPlainText(typeof auth.realm === "string" ? auth.realm : "").slice(0, BROWSER_REALM_LIMIT);
      void this.prompts.ask(guestId, "signIn", { origin: new URL(origin).origin, realm }).then((answer) => {
        if (answer?.credentials) respond(answer.credentials.username, answer.credentials.password);
        else respond();
      });
    };
    const pageNavigation = (event: { preventDefault(): void; url?: string; isMainFrame?: boolean }, legacyUrl?: string) => {
      const entry = this.guests.get(guestId);
      const requested = typeof event.url === "string" ? event.url : legacyUrl;
      if (entry && event.isMainFrame !== false && typeof requested === "string") externalLink(requested);
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
    const committed = () => { const entry = this.guests.get(guestId); if (entry) { entry.userNavigation = "none"; entry.unloadHeld = false; } replaced(); this.releaseLeave(guestId); };
    const gone = (_event: unknown, details: { reason: string }) => {
      const entry = this.guests.get(guestId);
      if (!entry || details.reason === "clean-exit" || guest.isDestroyed()) return;
      entry.loadError = describePageCrash(details.reason, guest.getURL());
      this.notify();
    };
    const navigatedInPage = (_event: unknown, _url: string, mainFrame: boolean) => { if (mainFrame) { invalidateView(); visit(); } };
    let unsubscribe = () => {};
    // The page reports a find's count as it scans; only the final report is the answer.
    const found = (_event: unknown, result: { requestId: number; matches: number; activeMatchOrdinal: number; finalUpdate: boolean }) => {
      const tabId = this.tabIdForGuest(windowId, guestId);
      if (!result.finalUpdate || tabId === null) return;
      for (const listener of this.findResultListeners) listener(windowId, { tabId, requestId: result.requestId, matches: result.matches, activeMatch: result.activeMatchOrdinal });
    };
    // A browser key pressed in a page the user is using goes to the tab, not to the page and not to the app's own
    // meaning of that key.
    const pageKey = (event: { preventDefault(): void }, input: Parameters<BrowserWorkspaceService["pageShortcutFor"]>[1]) => {
      const tabId = this.tabIdForGuest(windowId, guestId);
      if (tabId === null || this.deps.agentDrives(guestId)) return;
      const action = this.pageShortcutFor(windowId, input);
      if (action === null) return;
      event.preventDefault();
      for (const listener of this.pageShortcutListeners) listener(windowId, { tabId, action });
    };
    guest.on("before-input-event", pageKey);
    guest.on("found-in-page", found);
    const dispose = () => { guest.removeListener("before-input-event", pageKey); guest.removeListener("found-in-page", found); guest.removeListener("did-start-navigation", started); guest.removeListener("did-fail-load", failed); guest.removeListener("render-process-gone", gone); guest.removeListener(RUN_DIALOG as never, pageDialog as never); guest.removeListener("-cancel-dialogs" as never, cancelDialogs as never); for (const listener of runtimeDialogs) guest.on(RUN_DIALOG as never, listener as never); dismissedPageDialogs.forget(guestId); guest.removeListener("login", signIn); guest.removeListener("will-navigate", pageNavigation); guest.removeListener("did-navigate", committed); guest.removeListener("will-prevent-unload", preventUnload); guest.removeListener("did-start-loading", loadStarted); guest.removeListener("did-stop-loading", loadStopped); guest.removeListener("did-navigate", visit); guest.removeListener("did-navigate-in-page", navigatedInPage); guest.removeListener("page-title-updated", titleChanged); unsubscribe(); this.guests.delete(guestId); this.releaseLeave(guestId); this.prompts.dismissGuest(guestId); this.permissions.invalidateGuest(guestId); this.previews.invalidateGuest(guestId); this.captures.invalidateGuest(guestId); this.notify(); };
    const titleChanged = () => { if (!guest.isDestroyed()) void this.store.updateHistoryTitle(guest.getURL(), guest.getTitle(), this.deps.agentDrives(guestId) ? "agent" : "user").then(() => this.changed()).catch(this.deps.onError); };
    this.guests.set(guestId, { guest, windowId, generation: 1, loading: guest.isLoadingMainFrame(), loadError: null, userNavigation: "none", unloadHeld: false, dialogs: 0, dialogsBlocked: false, dispose });
    guest.on("login", signIn); guest.on("will-navigate", pageNavigation); guest.on("did-navigate", committed); guest.on("will-prevent-unload", preventUnload);
    guest.on("did-fail-load", failed); guest.on("render-process-gone", gone);
    guest.on("did-start-loading", loadStarted); guest.on("did-stop-loading", loadStopped);
    guest.on("did-start-navigation", started); guest.on("did-navigate", visit); guest.on("did-navigate-in-page", navigatedInPage); guest.on("page-title-updated", titleChanged);
    unsubscribe = subscribeBrowserGuestDestroyed(guest, dispose);
    return dispose;
  }
  /**
   * A download was refused before it started. It is listed as blocked, and a tab says so with the reason and an offer
   * to lift the site's limit, instead of the click doing nothing.
   */
  blockedDownload(windowId: number, guestId: number, rawName: string, reason: BrowserDownloadBlockReason): void {
    const name = browserPlainText(rawName).slice(0, 300);
    const entry: BrowserDownload = { id: `download-${this.nextDownload++}`, name, receivedBytes: 0, totalBytes: 0, state: "blocked", at: (this.deps.now ?? Date.now)() };
    this.downloads.set(windowId, [entry, ...(this.downloads.get(windowId) ?? [])].slice(0, BROWSER_WORKSPACE_LIMITS.downloads));
    const guest = this.guests.get(guestId)?.guest;
    const url = guest && !guest.isDestroyed() ? browserWorkspaceUrl(guest.getURL()) : null;
    if (url === null || this.tabIdForGuest(windowId, guestId) === null || this.prompts.list(guestId).some((prompt) => prompt.kind === "downloadBlocked")) { this.notify(); return; }
    const origin = new URL(url).origin;
    void this.prompts.ask(guestId, "downloadBlocked", { origin, name, reason }).then((answer) => { if (answer?.allow) this.deps.allowDownloads(origin); });
  }
  showDownload(windowId: number, request: BrowserDownloadTarget): null {
    const path = this.downloadPaths.get(`${windowId}:${request.id}`);
    if (path === undefined) throw new Error("bad-request");
    this.deps.showItemInFolder(path);
    return null;
  }
  cancelDownload(windowId: number, request: BrowserDownloadTarget): null {
    const item = this.activeDownloads.get(`${windowId}:${request.id}`);
    if (item === undefined) throw new Error("bad-request");
    item.cancel();
    return null;
  }
  observeDownload(windowId: number, item: ObservedDownload): void {
    const id = `download-${this.nextDownload++}`;
    const key = `${windowId}:${id}`;
    this.activeDownloads.set(key, item);
    const at = (this.deps.now ?? Date.now)();
    const update = (state: BrowserDownload["state"], notice: BrowserDownloadNotice | null = null) => {
      const entry: BrowserDownload = { id, name: item.getFilename().slice(0, 300), receivedBytes: Math.max(0, item.getReceivedBytes()), totalBytes: Math.max(0, item.getTotalBytes()), state, at, ...(notice === null ? {} : { notice }) };
      this.downloads.set(windowId, [entry, ...(this.downloads.get(windowId) ?? []).filter((candidate) => candidate.id !== id)].slice(0, BROWSER_WORKSPACE_LIMITS.downloads));
      this.notify();
    };
    const updated = (_event: unknown, state: "progressing" | "interrupted") => update(state);
    const dispose = () => { item.removeListener("updated", updated); item.removeListener("done", done); this.downloadDisposers.get(windowId)?.delete(dispose); };
    const done = (_event: unknown, state: DoneState) => {
      dispose();
      this.activeDownloads.delete(key);
      // Where the file was saved stays in main; the renderer names a download only by its id.
      const path = state === "completed" ? item.getSavePath() : "";
      if (path) this.downloadPaths.set(key, path);
      update(state, state === "interrupted" ? item.getNotice() : null);
    };
    const disposers = this.downloadDisposers.get(windowId) ?? new Set<() => void>();
    disposers.add(dispose);
    this.downloadDisposers.set(windowId, disposers);
    item.on("updated", updated);
    item.once("done", done);
    update("progressing");
  }
  invalidateWindow(windowId: number): void { this.previews.invalidateWindow(windowId); this.captures.invalidateWindow(windowId); }
  disposeWindow(windowId: number): void {
    this.windows.delete(windowId); this.publishedTabs.delete(windowId); this.downloads.delete(windowId);
    for (const map of [this.activeDownloads, this.downloadPaths]) for (const key of [...map.keys()]) if (key.startsWith(`${windowId}:`)) map.delete(key); this.previews.disposeWindow(windowId);
    this.captures.invalidateWindow(windowId);
    for (const dispose of this.downloadDisposers.get(windowId) ?? []) dispose();
    this.downloadDisposers.delete(windowId);
    for (const entry of this.guests.values()) if (entry.windowId === windowId) entry.dispose();
  }
  dispose(): void { for (const windowId of [...this.windows]) this.disposeWindow(windowId); for (const entry of this.guests.values()) entry.dispose(); this.listeners.clear(); this.openTabListeners.clear(); this.findResultListeners.clear(); this.pageShortcutListeners.clear(); this.pageShortcuts.clear(); }
}
export function createBrowserWorkspaceService(deps: BrowserWorkspaceServiceDeps): BrowserWorkspaceService { return new BrowserWorkspaceService(deps); }
