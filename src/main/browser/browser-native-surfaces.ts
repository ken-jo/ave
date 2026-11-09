import { View, WebContentsView, type BrowserWindow, type WebContents } from "electron";
import { EventEmitter } from "node:events";
import {
  BROWSER_NATIVE_FAVICON_MAX_LENGTH,
  parseBrowserNativeSurfaceRequest,
  type BrowserNativeBounds,
  type BrowserNativeSurfaceRequest,
  type BrowserNativeSurfaceResult,
  type BrowserNativeSurfaceState,
} from "../../shared/browser-native-surface.js";
import { guestFaviconSource } from "../../shared/browser-favicon.js";
import type { BrowserTabBindRequest, BrowserTabBindResult } from "../../shared/browser-surface.js";
import { validateExternalUrl } from "../../shared/external-url.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";
import { isBackgroundE2eRuntime, whenFocusEmulated } from "../e2e-window-presentation.js";
import { subscribeBrowserGuestDestroyed } from "./browser-guest-lifecycle.js";

export interface BrowserNativeSurfaceDependencies {
  windowForId(windowId: number): BrowserWindow | undefined;
  authorizeCreate(windowId: number, tabId: string, requestId?: string): boolean;
  attach(contents: WebContents, owner: BrowserWindow): void;
  bind(windowId: number, request: BrowserTabBindRequest): BrowserTabBindResult;
  changed(windowId: number, state: BrowserNativeSurfaceState | null, tabId: string): void;
  userFocus(guestId: number, explicit?: boolean): void;
  userNavigate(windowId: number, tabId: string): void;
}

type Placement = Extract<BrowserNativeSurfaceRequest, { action: "present" }>;

interface Surface {
  readonly key: string;
  readonly owner: BrowserWindow;
  readonly windowId: number;
  readonly tabId: string;
  readonly view: WebContentsView;
  readonly container: View;
  readonly contents: WebContents;
  readonly contentsId: number;
  readonly abort: AbortController;
  ready: Promise<void>;
  unsubscribe(): void;
  epoch: number;
  revision: number;
  sequence: number;
  bound: boolean;
  attached: boolean;
  retired: boolean;
  initialNavigation: boolean;
  favicon: string | null;
  viewport: { width: number; height: number };
  placement: Placement | null;
}

function surfaceKey(windowId: number, tabId: string): string {
  return `${windowId}\0${tabId}`;
}

/** Owns independent pages throughout creation, native presentation and parked rendering. */
export class BrowserNativeSurfaceHost {
  private readonly surfaces = new Map<string, Surface>();
  private readonly owners = new Map<number, () => void>();
  private nextEpoch = 0;
  private nextRevision = 0;
  private disposed = false;

  constructor(private readonly deps: BrowserNativeSurfaceDependencies) {}

  async request(windowId: number, value: BrowserNativeSurfaceRequest): Promise<BrowserNativeSurfaceResult> {
    const request = parseBrowserNativeSurfaceRequest(value);
    if (!request) return { ok: false, error: "bad-request" };
    if (this.disposed) return { ok: false, error: "native-surface-unavailable" };
    try {
      if (request.action === "create") return await this.create(windowId, request);
      const entry = this.surfaces.get(surfaceKey(windowId, request.tabId));
      if (!entry || !this.current(entry) || entry.contentsId !== request.webContentsId) return { ok: false, error: "stale-surface" };
      if (request.action === "close") {
        this.retire(entry);
        return { ok: true, surface: null };
      }
      await entry.ready;
      if (!this.current(entry)) return { ok: false, error: "stale-surface" };
      if (request.action === "present") {
        if (request.epoch !== entry.epoch || request.sequence <= entry.sequence) return { ok: false, error: "stale-surface" };
        if (!this.place(entry, request)) return { ok: false, error: "native-surface-unavailable" };
        entry.sequence = request.sequence;
      } else if (request.action === "focus") {
        if (!entry.attached || !this.ownerVisible(entry.owner)) return { ok: false, error: "native-surface-unavailable" };
        if (isBackgroundE2eRuntime()) {
          if (!await whenFocusEmulated(entry.contents) || !this.current(entry) || !entry.attached) return { ok: false, error: "native-surface-unavailable" };
          this.deps.userFocus(entry.contentsId, true);
        } else {
          if (!entry.owner.isFocused()) return { ok: false, error: "native-surface-unavailable" };
          this.deps.userFocus(entry.contentsId, true);
          entry.contents.focus();
        }
      } else if (request.action === "devtools") {
        this.deps.userFocus(entry.contentsId, true);
        entry.contents.openDevTools({ mode: "detach" });
      } else {
        if (request.action === "navigate") {
          const url = request.url === "about:blank" ? request.url : validateExternalUrl(request.url);
          if (typeof url !== "string" && !url.ok) return { ok: false, error: "bad-request" };
          this.deps.userNavigate(windowId, entry.tabId);
          await entry.contents.loadURL(typeof url === "string" ? url : url.url);
        } else if (request.action === "reload") {
          this.deps.userNavigate(windowId, entry.tabId);
          entry.contents.reload();
        } else if (request.action === "back" && entry.contents.navigationHistory.canGoBack()) {
          this.deps.userNavigate(windowId, entry.tabId);
          entry.contents.navigationHistory.goBack();
        } else if (request.action === "forward" && entry.contents.navigationHistory.canGoForward()) {
          this.deps.userNavigate(windowId, entry.tabId);
          entry.contents.navigationHistory.goForward();
        }
        if (!this.current(entry)) return { ok: false, error: "stale-surface" };
        this.publish(entry);
      }
      if (!this.current(entry)) return { ok: false, error: "stale-surface" };
      return { ok: true, surface: this.state(entry) };
    } catch {
      return { ok: false, error: "native-surface-unavailable" };
    }
  }

  disposeWindow(windowId: number): void {
    for (const entry of [...this.surfaces.values()]) if (entry.windowId === windowId) this.retire(entry);
    this.owners.get(windowId)?.();
    this.owners.delete(windowId);
  }

  dispose(): void {
    this.disposed = true;
    for (const windowId of [...this.owners.keys()]) this.disposeWindow(windowId);
  }

  private current(entry: Surface): boolean {
    return !entry.retired && this.surfaces.get(entry.key) === entry && !entry.contents.isDestroyed()
      && !entry.owner.isDestroyed() && this.deps.windowForId(entry.windowId) === entry.owner;
  }

  private ownerVisible(owner: BrowserWindow): boolean {
    return !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized();
  }

  private state(entry: Surface): BrowserNativeSurfaceState {
    return {
      tabId: entry.tabId, webContentsId: entry.contentsId, epoch: entry.epoch, revision: entry.revision,
      url: entry.contents.getURL(), title: entry.contents.getTitle(), favicon: entry.favicon, loading: entry.contents.isLoading(),
      canGoBack: entry.contents.navigationHistory.canGoBack(), canGoForward: entry.contents.navigationHistory.canGoForward(),
      visible: entry.attached,
    };
  }

  private publish(entry: Surface): void {
    if (!entry.bound || !this.current(entry)) return;
    entry.revision = ++this.nextRevision;
    this.deps.changed(entry.windowId, this.state(entry), entry.tabId);
  }

  private async create(windowId: number, request: Extract<BrowserNativeSurfaceRequest, { action: "create" }>): Promise<BrowserNativeSurfaceResult> {
    const owner = this.deps.windowForId(windowId);
    if (!owner || owner.isDestroyed() || !this.deps.authorizeCreate(windowId, request.tabId, request.requestId)) return { ok: false, error: "native-surface-unavailable" };
    const key = surfaceKey(windowId, request.tabId);
    let entry = this.surfaces.get(key);
    if (entry && !this.current(entry)) { this.retire(entry); entry = undefined; }
    const epoch = ++this.nextEpoch;
    if (entry) {
      entry.epoch = epoch;
      entry.sequence = 0;
      if (entry.bound && !this.place(entry, null, false)) return { ok: false, error: "native-surface-unavailable" };
    } else {
      const view = new WebContentsView({ webPreferences: {
        partition: AVE_SIDE_BROWSER_PARTITION, focusOnNavigation: false, backgroundThrottling: false,
        sandbox: true, contextIsolation: true, webSecurity: true, javascript: true, webviewTag: false,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      } });
      const contents = view.webContents;
      entry = {
        key, owner, windowId, tabId: request.tabId, view, container: new View(), contents, contentsId: contents.id,
        abort: new AbortController(), ready: Promise.resolve(), unsubscribe: () => {}, epoch, revision: 0,
        sequence: 0, bound: false, attached: false, retired: false, initialNavigation: true, favicon: null, viewport: { width: 1024, height: 768 }, placement: null,
      };
      this.surfaces.set(key, entry);
      this.observeOwner(owner);
      view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
      contents.setBackgroundThrottling(false);
      entry.ready = this.initialize(entry, request.requestId);
    }
    await entry.ready;
    if (!this.current(entry) || entry.epoch !== epoch) return { ok: false, error: "stale-surface" };
    this.publish(entry);
    return { ok: true, surface: this.state(entry), initialNavigation: entry.initialNavigation };
  }

  private async initialize(entry: Surface, requestId?: string): Promise<void> {
    let cancel: (() => void) | undefined;
    try {
      this.deps.attach(entry.contents, entry.owner);
      if (!this.current(entry)) throw new Error("Native page creation ended");
      const changed = () => this.publish(entry);
      const focused = () => {
        if (this.current(entry) && entry.attached && this.ownerVisible(entry.owner)
          && entry.owner.isFocused() && entry.contents.isFocused()) this.deps.userFocus(entry.contentsId);
      };
      const faviconUpdated = (_event: unknown, favicons: unknown) => {
        const favicon = Array.isArray(favicons)
          ? favicons.find(value => typeof value === "string" && value.length <= BROWSER_NATIVE_FAVICON_MAX_LENGTH && guestFaviconSource(value) !== null)
          : undefined;
        entry.favicon = guestFaviconSource(favicon);
        this.publish(entry);
      };
      const navigating = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
        if (!mainFrame) return;
        if (entry.bound) entry.initialNavigation = false;
        entry.favicon = null;
        this.publish(entry);
      };
      const events = ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const;
      for (const event of events) EventEmitter.prototype.on.call(entry.contents, event, changed);
      entry.contents.on("focus", focused);
      entry.contents.on("page-favicon-updated", faviconUpdated);
      entry.contents.on("did-start-navigation", navigating);
      const stopDestroyed = subscribeBrowserGuestDestroyed(entry.contents, () => this.retire(entry, false));
      entry.unsubscribe = () => {
        for (const event of events) EventEmitter.prototype.removeListener.call(entry.contents, event, changed);
        entry.contents.removeListener("focus", focused);
        entry.contents.removeListener("page-favicon-updated", faviconUpdated);
        entry.contents.removeListener("did-start-navigation", navigating);
        stopDestroyed();
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error("Native page creation ended"));
        entry.abort.signal.addEventListener("abort", cancel, { once: true });
      });
      await Promise.race([entry.contents.loadURL("about:blank"), cancelled]);
      if (!this.current(entry)) throw new Error("Native page creation ended");
      const bound = this.deps.bind(entry.windowId, {
        tabId: entry.tabId, webContentsId: entry.contentsId, parked: true,
        ...(requestId === undefined ? {} : { requestId }),
      });
      if (!bound.ok) throw new Error("Native page binding failed");
      entry.bound = true;
    } catch (error) {
      this.retire(entry);
      throw error;
    } finally {
      if (cancel) entry.abort.signal.removeEventListener("abort", cancel);
    }
  }

  private place(entry: Surface, placement: Placement | null, handBackFocus = true): boolean {
    if (!placement?.bounds || !this.ownerVisible(entry.owner)) {
      const returnUserFocus = handBackFocus && entry.attached && entry.contents.isFocused() && entry.owner.isFocused();
      const bound = this.deps.bind(entry.windowId, { tabId: entry.tabId, webContentsId: entry.contentsId, parked: true });
      if (!bound.ok || !this.current(entry)) return false;
      this.detach(entry);
      if (returnUserFocus && this.current(entry) && entry.owner.isFocused()) entry.owner.webContents.focus();
    } else {
      const zoom = entry.owner.webContents.getZoomFactor();
      if (!Number.isFinite(zoom) || zoom <= 0) return false;
      const toDip = (bounds: BrowserNativeBounds) => ({
        x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom),
        width: Math.max(1, Math.round(bounds.width * zoom)), height: Math.max(1, Math.round(bounds.height * zoom)),
      });
      const bounds = toDip(placement.bounds);
      const clip = toDip(placement.clipBounds ?? placement.bounds);
      entry.viewport = { width: bounds.width, height: bounds.height };
      entry.container.setBounds(clip);
      entry.container.setBorderRadius(Math.round((placement.borderRadius ?? 0) * zoom));
      entry.view.setBounds({ x: bounds.x - clip.x, y: bounds.y - clip.y, width: bounds.width, height: bounds.height });
      if (!entry.attached) {
        entry.container.addChildView(entry.view);
        entry.owner.contentView.addChildView(entry.container);
        entry.attached = true;
      }
      const bound = this.deps.bind(entry.windowId, { tabId: entry.tabId, webContentsId: entry.contentsId, parked: false });
      if (!bound.ok || !this.current(entry)) { this.detach(entry); return false; }
    }
    entry.placement = placement;
    this.publish(entry);
    return true;
  }

  private detach(entry: Surface): void {
    if (!entry.attached) return;
    entry.attached = false;
    try { entry.container.removeChildView(entry.view); }
    finally { if (!entry.owner.isDestroyed()) entry.owner.contentView.removeChildView(entry.container); }
    if (!entry.contents.isDestroyed()) entry.view.setBounds({ x: 0, y: 0, ...entry.viewport });
  }

  private observeOwner(owner: BrowserWindow): void {
    if (this.owners.has(owner.id)) return;
    const windowId = owner.id;
    const ownerContents = owner.webContents;
    const park = (invalidate: boolean) => {
      for (const entry of this.surfaces.values()) {
        if (entry.owner !== owner) continue;
        if (invalidate) { entry.epoch = ++this.nextEpoch; entry.sequence = 0; entry.placement = null; }
        if (entry.bound) this.deps.bind(windowId, { tabId: entry.tabId, webContentsId: entry.contentsId, parked: true });
        this.detach(entry);
        this.publish(entry);
      }
    };
    const hidden = () => park(false);
    const reloaded = () => park(true);
    const shown = () => {
      for (const entry of this.surfaces.values()) if (entry.owner === owner && entry.bound && entry.placement) this.place(entry, entry.placement);
    };
    const closed = () => this.disposeWindow(windowId);
    owner.on("hide", hidden);
    owner.on("minimize", hidden);
    owner.on("show", shown);
    owner.on("restore", shown);
    owner.once("closed", closed);
    ownerContents.on("render-process-gone", reloaded);
    ownerContents.on("did-start-loading", reloaded);
    this.owners.set(windowId, () => {
      owner.removeListener("hide", hidden);
      owner.removeListener("minimize", hidden);
      owner.removeListener("show", shown);
      owner.removeListener("restore", shown);
      owner.removeListener("closed", closed);
      ownerContents.removeListener("render-process-gone", reloaded);
      ownerContents.removeListener("did-start-loading", reloaded);
    });
  }

  private retire(entry: Surface, close = true): void {
    if (entry.retired) return;
    entry.retired = true;
    entry.abort.abort();
    this.surfaces.delete(entry.key);
    try { this.detach(entry); }
    finally {
      entry.unsubscribe();
      if (close && !entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false });
      this.deps.changed(entry.windowId, null, entry.tabId);
      if (![...this.surfaces.values()].some(surface => surface.windowId === entry.windowId)) {
        this.owners.get(entry.windowId)?.();
        this.owners.delete(entry.windowId);
      }
    }
  }
}
