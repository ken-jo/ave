import { View, WebContentsView, type MouseInputEvent, type NativeImage, type Point, type Size, type WebContents } from "electron";
import { EventEmitter } from "node:events";
import { BROWSER_NATIVE_CURSORS, BROWSER_NATIVE_CURSOR_MAX_BYTES, BROWSER_NATIVE_CURSOR_MAX_SIZE, BROWSER_NATIVE_CURSOR_MAX_SOURCE_SIZE,
  parseBrowserNativeInput, parseBrowserNativeInputState, type BrowserNativeCursor, type BrowserNativeInput, type BrowserNativeInputState } from "../../shared/browser-native-input.js";
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
import { attachMainWindowPage, type MainWindow } from "../main-window-host.js";
import { subscribeBrowserGuestDestroyed } from "./browser-guest-lifecycle.js";

export interface BrowserNativeSurfaceDependencies {
  windowForId(windowId: number): MainWindow | undefined;
  authorizeCreate(windowId: number, tabId: string, requestId?: string): boolean;
  attach(contents: WebContents, owner: MainWindow): void;
  bind(windowId: number, request: BrowserTabBindRequest): BrowserTabBindResult;
  changed(windowId: number, state: BrowserNativeSurfaceState | null, tabId: string): void;
  inputStateChanged(windowId: number, state: BrowserNativeInputState): void;
  userFocus(guestId: number, explicit?: boolean): void;
  userNavigate(windowId: number, tabId: string): void;
}

type Placement = Extract<BrowserNativeSurfaceRequest, { action: "present" }>;

interface Surface {
  readonly key: string;
  readonly owner: MainWindow;
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

function pageCursor(type: string): BrowserNativeCursor {
  if (type === "pointer" || type === "null") return "default";
  if (type === "hand") return "pointer";
  if (type === "nodrop" || type === "drag-drop-none") return "no-drop";
  if (type === "drag-drop-move") return "move";
  if (type === "drag-drop-copy") return "copy";
  if (type === "drag-drop-link") return "alias";
  if (/^(?:ns|ew|nesw|nwse)-no-resize$/.test(type)) return "not-allowed";
  if (type.startsWith("m-panning")) return "all-scroll";
  if (/^(?:e|n|ne|nw|s|se|sw|w)-panning$/.test(type)) return BROWSER_NATIVE_CURSORS.find(cursor => cursor === type.replace("panning", "resize")) ?? "auto";
  return BROWSER_NATIVE_CURSORS.find(cursor => cursor === type) ?? "auto";
}

function customPageCursor(entry: Surface, image?: NativeImage, scale?: number, size?: Size, hotspot?: Point): BrowserNativeInputState | null {
  if (!image || scale === undefined || !Number.isFinite(scale) || scale <= 0 || scale > 8 || !size || !hotspot
    || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0
    || size.width > BROWSER_NATIVE_CURSOR_MAX_SOURCE_SIZE || size.height > BROWSER_NATIVE_CURSOR_MAX_SOURCE_SIZE
    || !Number.isInteger(hotspot.x) || !Number.isInteger(hotspot.y) || hotspot.x < 0 || hotspot.y < 0
    || hotspot.x >= size.width || hotspot.y >= size.height) return null;
  const width = Math.round(size.width / scale);
  const height = Math.round(size.height / scale);
  if (width <= 0 || height <= 0 || width > BROWSER_NATIVE_CURSOR_MAX_SIZE || height > BROWSER_NATIVE_CURSOR_MAX_SIZE) return null;
  try {
    if (image.isEmpty()) return null;
    const imageSize = image.getSize();
    if (imageSize.width !== size.width || imageSize.height !== size.height) return null;
    const png = image.resize({ width, height, quality: "best" }).toPNG();
    if (png.byteLength > BROWSER_NATIVE_CURSOR_MAX_BYTES) return null;
    return parseBrowserNativeInputState({ type: "custom-cursor", tabId: entry.tabId, webContentsId: entry.contentsId,
      epoch: entry.epoch, dataUrl: `data:image/png;base64,${png.toString("base64")}`, width, height,
      hotspot: { x: Math.floor(hotspot.x / scale), y: Math.floor(hotspot.y / scale) } });
  } catch {
    return null;
  }
}

/** Owns independent pages throughout creation, native presentation and parked rendering. */
export class BrowserNativeSurfaceHost {
  private readonly surfaces = new Map<string, Surface>();
  private readonly owners = new Map<number, () => void>();
  private readonly gestures = new Map<number, { entry: Surface; epoch: number; sequence: number; button: BrowserNativeInput["button"] }>();
  private readonly inputSequences = new Map<number, number>();
  private nextEpoch = 0;
  private nextRevision = 0;
  private disposed = false;

  constructor(private readonly deps: BrowserNativeSurfaceDependencies) {}

  input(windowId: number, value: BrowserNativeInput): boolean {
    const input = parseBrowserNativeInput(value);
    if (!input || this.disposed) return false;
    if (input.sequence <= (this.inputSequences.get(windowId) ?? 0)) return false;
    this.inputSequences.set(windowId, input.sequence);
    const heldButton = input.modifiers.some(modifier => modifier === "leftbuttondown" || modifier === "middlebuttondown" || modifier === "rightbuttondown");
    if (input.type === "mouseDown" || input.type === "mouseMove" && !heldButton) this.clearGesture(windowId);
    const entry = this.surfaces.get(surfaceKey(windowId, input.tabId));
    if (!entry || !this.current(entry) || !entry.bound || !entry.attached || !this.ownerVisible(entry.owner)
      || entry.contentsId !== input.webContentsId || entry.epoch !== input.epoch || !entry.placement?.bounds) return this.rejectInput(windowId, input);
    const gesture = this.gestures.get(windowId);
    if (gesture && (gesture.entry !== entry || gesture.epoch !== entry.epoch)) return this.rejectInput(windowId, input);
    if (input.type === "mouseMove" && heldButton && !gesture) return this.rejectInput(windowId, input);
    const zoom = entry.owner.webContents.getZoomFactor();
    if (!Number.isFinite(zoom) || zoom <= 0) return this.rejectInput(windowId, input);
    const x = Math.round(input.x * zoom);
    const y = Math.round(input.y * zoom);
    const clip = entry.container.getBounds();
    const page = entry.view.getBounds();
    const origin = { x: clip.x + page.x, y: clip.y + page.y };
    const contains = (rectangle: BrowserNativeBounds) => x >= rectangle.x && y >= rectangle.y
      && x < rectangle.x + rectangle.width && y < rectangle.y + rectangle.height;
    const inside = contains(clip) && contains({ ...origin, width: page.width, height: page.height });
    if (input.type === "mouseDown" || input.type === "mouseWheel") {
      if (!inside) return this.rejectInput(windowId, input);
    } else if (input.type === "mouseUp") {
      if (gesture?.button !== input.button) return this.rejectInput(windowId, input);
    } else if (input.type !== "mouseLeave" && !inside && !gesture) return this.rejectInput(windowId, input);
    const event: MouseInputEvent = {
      type: input.type, x: x - origin.x, y: y - origin.y, button: input.button,
      clickCount: input.clickCount, modifiers: input.modifiers,
    };
    try {
      if (input.type === "mouseDown") this.gestures.set(windowId, { entry, epoch: entry.epoch, sequence: input.sequence, button: input.button });
      if (input.type === "mouseDown" || input.type === "mouseWheel") {
        if (!entry.owner.isFocused() && !isBackgroundE2eRuntime()) return this.rejectInput(windowId, input);
        this.deps.userFocus(entry.contentsId, true);
        if (input.type === "mouseDown" && !isBackgroundE2eRuntime()) entry.contents.focus();
      }
      if (!this.current(entry) || !entry.attached) return this.rejectInput(windowId, input);
      if (input.type === "mouseWheel") {
        entry.contents.sendInputEvent({ ...event, type: "mouseWheel", deltaX: (input.deltaX ?? 0) * zoom,
          deltaY: (input.deltaY ?? 0) * zoom, hasPreciseScrollingDeltas: true, canScroll: true });
      } else {
        entry.contents.sendInputEvent(event);
      }
      if (input.type === "mouseUp") this.gestures.delete(windowId);
      return true;
    } catch {
      this.clearGesture(windowId);
      return false;
    }
  }

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
    this.inputSequences.delete(windowId);
  }

  dispose(): void {
    this.disposed = true;
    for (const windowId of [...this.owners.keys()]) this.disposeWindow(windowId);
  }

  private current(entry: Surface): boolean {
    return !entry.retired && this.surfaces.get(entry.key) === entry && !entry.contents.isDestroyed()
      && !entry.owner.isDestroyed() && this.deps.windowForId(entry.windowId) === entry.owner;
  }

  private clearGesture(windowId: number): void {
    const gesture = this.gestures.get(windowId);
    if (!gesture) return;
    this.gestures.delete(windowId);
    this.deps.inputStateChanged(windowId, { type: "cancel", tabId: gesture.entry.tabId,
      webContentsId: gesture.entry.contentsId, epoch: gesture.epoch, sequence: gesture.sequence });
  }

  private rejectInput(windowId: number, input: BrowserNativeInput): false {
    const gesture = this.gestures.get(windowId);
    if (gesture && gesture.entry.tabId === input.tabId && gesture.entry.contentsId === input.webContentsId
      && gesture.epoch === input.epoch && input.sequence >= gesture.sequence) this.clearGesture(windowId);
    else if (input.type === "mouseDown") this.deps.inputStateChanged(windowId, { type: "cancel", tabId: input.tabId,
      webContentsId: input.webContentsId, epoch: input.epoch, sequence: input.sequence });
    return false;
  }

  private ownerVisible(owner: MainWindow): boolean {
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
      const cursorChanged = (_event: unknown, type: string, image?: NativeImage, scale?: number, size?: Size, hotspot?: Point) => {
        if (!this.current(entry) || !entry.attached || !this.ownerVisible(entry.owner)) return;
        const custom = type === "custom" ? customPageCursor(entry, image, scale, size, hotspot) : null;
        this.deps.inputStateChanged(entry.windowId, custom ?? { type: "cursor", tabId: entry.tabId,
          webContentsId: entry.contentsId, epoch: entry.epoch, cursor: pageCursor(type) });
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
      entry.contents.on("cursor-changed", cursorChanged);
      entry.contents.on("page-favicon-updated", faviconUpdated);
      entry.contents.on("did-start-navigation", navigating);
      const stopDestroyed = subscribeBrowserGuestDestroyed(entry.contents, () => this.retire(entry, false));
      entry.unsubscribe = () => {
        for (const event of events) EventEmitter.prototype.removeListener.call(entry.contents, event, changed);
        entry.contents.removeListener("focus", focused);
        entry.contents.removeListener("cursor-changed", cursorChanged);
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
        attachMainWindowPage(entry.owner, entry.container);
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
    if (this.gestures.get(entry.windowId)?.entry === entry) this.clearGesture(entry.windowId);
    if (!entry.attached) return;
    entry.attached = false;
    try { entry.container.removeChildView(entry.view); }
    finally { if (!entry.owner.isDestroyed()) entry.owner.contentView.removeChildView(entry.container); }
    if (!entry.contents.isDestroyed()) entry.view.setBounds({ x: 0, y: 0, ...entry.viewport });
  }

  private observeOwner(owner: MainWindow): void {
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
    const blurred = () => { this.clearGesture(windowId); };
    const reloaded = () => { this.inputSequences.delete(windowId); park(true); };
    const shown = () => {
      for (const entry of this.surfaces.values()) if (entry.owner === owner && entry.bound && entry.placement) this.place(entry, entry.placement);
    };
    const closed = () => this.disposeWindow(windowId);
    owner.on("hide", hidden);
    owner.on("blur", blurred);
    owner.on("minimize", hidden);
    owner.on("show", shown);
    owner.on("restore", shown);
    owner.once("closed", closed);
    ownerContents.on("render-process-gone", reloaded);
    ownerContents.on("did-start-loading", reloaded);
    this.owners.set(windowId, () => {
      owner.removeListener("hide", hidden);
      owner.removeListener("blur", blurred);
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
        this.inputSequences.delete(entry.windowId);
      }
    }
  }
}
