import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserNativeSurfaceState } from "../../../shared/browser-native-surface.js";
import { BROWSER_NATIVE_FAVICON_MAX_LENGTH } from "../../../shared/browser-native-surface.js";
import type { BrowserTabBindResult } from "../../../shared/browser-surface.js";

interface Page extends EventEmitter {
  id: number;
  destroyed: boolean;
  focused: boolean;
  url: string;
  title: string;
  loading: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  navigationHistory: {
    canGoBack: ReturnType<typeof vi.fn>;
    canGoForward: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
  };
}
interface NativeView {
  children: NativeView[];
  bounds: { x: number; y: number; width: number; height: number };
  borderRadius: number;
  webContents?: Page;
  addChildView(view: NativeView): void;
  removeChildView(view: NativeView): void;
  getBounds(): NativeView["bounds"];
}

const native = vi.hoisted(() => ({
  pages: [] as Page[], views: [] as NativeView[], preferences: [] as Record<string, unknown>[], trace: [] as string[],
  pendingLoads: [] as { resolve(): void; reject(error: Error): void }[], deferredLoad: false,
  background: false, emulated: true, nextId: 10,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class PageContents extends EventEmitter {
    id = ++native.nextId;
    destroyed = false;
    focused = false;
    url = "";
    title = "Browser page";
    loading = false;
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    isLoading() { return this.loading; }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    setBackgroundThrottling = vi.fn();
    loadURL = vi.fn((url: string) => {
      this.url = url;
      if (native.deferredLoad) return new Promise<void>((resolve, reject) => { native.pendingLoads.push({ resolve, reject }); });
      return Promise.resolve();
    });
    close = vi.fn(() => { this.destroyed = true; this.emit("destroyed"); });
    focus = vi.fn(() => { this.focused = true; this.emit("focus"); });
    reload = vi.fn();
    openDevTools = vi.fn();
    navigationHistory = {
      canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false), goBack: vi.fn(), goForward: vi.fn(),
    };
  }
  class NativeContainer {
    children: NativeContainer[] = [];
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    borderRadius = 0;
    constructor() { native.views.push(this); }
    addChildView(view: NativeContainer) {
      native.trace.push("attach");
      this.children = this.children.filter(child => child !== view);
      this.children.push(view);
    }
    removeChildView(view: NativeContainer) {
      native.trace.push("detach");
      this.children = this.children.filter(child => child !== view);
    }
    setBounds(bounds: NativeContainer["bounds"]) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    setBorderRadius(radius: number) { this.borderRadius = radius; }
  }
  class NativePage extends NativeContainer {
    webContents = new PageContents();
    constructor(options: { webPreferences: Record<string, unknown> }) {
      super();
      native.preferences.push(options.webPreferences);
      native.pages.push(this.webContents);
    }
  }
  return { View: NativeContainer, WebContentsView: NativePage };
});
vi.mock("../../e2e-window-presentation.js", () => ({
  isBackgroundE2eRuntime: () => native.background,
  whenFocusEmulated: vi.fn(async () => native.emulated),
}));

import { View as NativeContainer } from "electron";
import { BrowserNativeSurfaceHost, type BrowserNativeSurfaceDependencies } from "../browser-native-surfaces.js";

class Window extends EventEmitter {
  destroyed = false;
  visible = true;
  minimized = false;
  focused = true;
  zoom = 1;
  readonly contentView = new NativeContainer();
  readonly contents = Object.assign(new EventEmitter(), { isDestroyed: () => this.destroyed, getZoomFactor: () => this.zoom, focus: vi.fn() });
  constructor(readonly id: number) { super(); }
  get webContents() {
    if (this.destroyed) throw new Error("Window was destroyed");
    return this.contents;
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isFocused() { return this.focused; }
}

let host: BrowserNativeSurfaceHost;
let owner: Window;
let secondOwner: Window;
let deps: BrowserNativeSurfaceDependencies;
let windows: Map<number, Window>;

beforeEach(() => {
  native.pages = []; native.views = []; native.preferences = []; native.trace = []; native.pendingLoads = [];
  native.deferredLoad = false; native.background = false; native.emulated = true; native.nextId = 10;
  owner = new Window(1);
  secondOwner = new Window(2);
  windows = new Map([[owner.id, owner], [secondOwner.id, secondOwner]]);
  deps = {
    windowForId: id => windows.get(id) as unknown as BrowserWindow | undefined,
    authorizeCreate: vi.fn(() => true),
    attach: vi.fn(),
    bind: vi.fn((_windowId, request): BrowserTabBindResult => { native.trace.push(`bind:${request.parked}`); return { ok: true }; }),
    changed: vi.fn(), userFocus: vi.fn(), userNavigate: vi.fn(),
  };
  host = new BrowserNativeSurfaceHost(deps);
});
afterEach(() => host.dispose());

async function create(tabId = "browser:agent", windowId = owner.id): Promise<BrowserNativeSurfaceState> {
  const result = await host.request(windowId, { action: "create", tabId, requestId: "browser-op-1" });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.surface) throw new Error("Native surface unavailable");
  return result.surface;
}

function present(surface: BrowserNativeSurfaceState, sequence = 1, bounds = { x: 50, y: 80, width: 800, height: 600 }) {
  return host.request(owner.id, { action: "present", tabId: surface.tabId, webContentsId: surface.webContentsId, epoch: surface.epoch, sequence, bounds });
}

function pageView(index = 0): NativeView {
  return native.views.find(view => view.webContents === native.pages[index])!;
}

function ownerChildren(window = owner): NativeView[] {
  return (window.contentView as unknown as NativeView).children;
}

describe("native browser page creation", () => {
  it("creates a detached isolated page in the browser session and binds only its blank bootstrap", async () => {
    const state = await create();
    const page = native.pages[0]!;
    expect(native.preferences[0]).toMatchObject({
      partition: "persist:ave-side-browser", focusOnNavigation: false, backgroundThrottling: false,
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, javascript: true, webviewTag: false,
    });
    expect(native.preferences[0]).not.toHaveProperty("preload");
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
    expect(page.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    expect(ownerChildren()).toEqual([]);
    expect(deps.attach).toHaveBeenCalledExactlyOnceWith(page, owner);
    expect(deps.bind).toHaveBeenCalledExactlyOnceWith(1, {
      tabId: state.tabId, webContentsId: page.id, parked: true, requestId: "browser-op-1",
    });
    expect(state).toMatchObject({ url: "about:blank", title: "Browser page", visible: false, revision: 1 });
  });

  it("refuses an unauthorized or missing owner before creating a page", async () => {
    vi.mocked(deps.authorizeCreate).mockReturnValue(false);
    expect(await host.request(1, { action: "create", tabId: "browser:agent" })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(await host.request(9, { action: "create", tabId: "browser:agent" })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(native.pages).toHaveLength(0);
  });

  it("shares pending creation while refusing the superseded mount epoch", async () => {
    native.deferredLoad = true;
    const first = host.request(1, { action: "create", tabId: "browser:agent", requestId: "browser-op-1" });
    const second = host.request(1, { action: "create", tabId: "browser:agent", requestId: "browser-op-1" });
    expect(native.pages).toHaveLength(1);
    native.pendingLoads[0]!.resolve();
    expect(await first).toEqual({ ok: false, error: "stale-surface" });
    expect(await second).toMatchObject({ ok: true, initialNavigation: true, surface: { epoch: 2, webContentsId: native.pages[0]!.id } });
    expect(deps.attach).toHaveBeenCalledTimes(1);
    expect(deps.bind).toHaveBeenCalledTimes(1);
  });

  it("reacquires an existing page with a new epoch without reloading its document", async () => {
    const first = await create();
    await present(first);
    native.pages[0]!.focused = true;
    const second = await create();
    expect(second.webContentsId).toBe(first.webContentsId);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(second.visible).toBe(false);
    expect(native.pages[0]!.loadURL).toHaveBeenCalledTimes(1);
    expect(ownerChildren()).toEqual([]);
    expect(owner.contents.focus).not.toHaveBeenCalled();
    expect(await present(first, 2)).toEqual({ ok: false, error: "stale-surface" });
    expect(await present(second)).toMatchObject({ ok: true, surface: { visible: true } });
  });

  it.each(["https://b.example/current", "about:blank"])("preserves completed initial navigation when reacquiring %s", async (url) => {
    const first = await host.request(1, { action: "create", tabId: "browser:agent", requestId: "browser-op-1" });
    expect(first).toMatchObject({ ok: true, initialNavigation: true });
    const page = native.pages[0]!;
    page.emit("did-start-navigation", {}, url, false, true);
    page.url = url;
    const retained = await host.request(1, { action: "create", tabId: "browser:agent" });
    expect(retained).toMatchObject({ ok: true, initialNavigation: false, surface: { url, webContentsId: page.id } });
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
  });

  it("closes a page whose bootstrap binding is refused", async () => {
    vi.mocked(deps.bind).mockReturnValue({ ok: false, error: "guest-not-hosted" });
    expect(await host.request(1, { action: "create", tabId: "browser:agent" })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(native.pages[0]!.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(deps.changed).toHaveBeenLastCalledWith(1, null, "browser:agent");
  });

  it("closes a page when the policy installer fails", async () => {
    vi.mocked(deps.attach).mockImplementation(() => { throw new Error("Policy unavailable"); });
    expect(await host.request(1, { action: "create", tabId: "browser:agent" })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(native.pages[0]!.close).toHaveBeenCalledTimes(1);
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("ends an unresolved bootstrap when its owner closes", async () => {
    native.deferredLoad = true;
    const pending = host.request(1, { action: "create", tabId: "browser:agent" });
    owner.destroyed = true;
    owner.emit("closed");
    expect(await pending).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(native.pages[0]!.close).toHaveBeenCalledTimes(1);
    native.pendingLoads[0]!.resolve();
    await Promise.resolve();
    expect(deps.bind).not.toHaveBeenCalled();
    expect(owner.listenerCount("hide")).toBe(0);
  });
});

describe("native browser pane presentation", () => {
  it("attaches only for a visible pane and never focuses or pauses on presentation", async () => {
    const state = await create();
    expect(await present(state)).toMatchObject({ ok: true, surface: { visible: true } });
    const container = ownerChildren()[0]!;
    expect(container.children).toEqual([pageView()]);
    expect(container.getBounds()).toEqual({ x: 50, y: 80, width: 800, height: 600 });
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(deps.bind).toHaveBeenLastCalledWith(1, { tabId: state.tabId, webContentsId: state.webContentsId, parked: false });
    expect(deps.userFocus).not.toHaveBeenCalled();
    expect(native.pages[0]!.focus).not.toHaveBeenCalled();
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("acknowledges parking before detaching and retains the page viewport", async () => {
    const state = await create();
    await present(state);
    native.trace = [];
    const parked = await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null });
    expect(parked).toMatchObject({ ok: true, surface: { visible: false } });
    expect(native.trace).toEqual(["bind:true", "detach", "detach"]);
    expect(ownerChildren()).toEqual([]);
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(native.pages[0]!.close).not.toHaveBeenCalled();
    expect(owner.contents.focus).not.toHaveBeenCalled();
    expect(await present(state, 3)).toMatchObject({ ok: true, surface: { webContentsId: state.webContentsId, visible: true } });
  });

  it("keeps the old placement when parking acknowledgement fails", async () => {
    const state = await create();
    await present(state);
    native.pages[0]!.focused = true;
    vi.mocked(deps.bind).mockImplementation(() => { native.trace.push("bind:true"); return { ok: false, error: "guest-not-hosted" }; });
    native.trace = [];
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(native.trace).toEqual(["bind:true"]);
    expect(ownerChildren()).toHaveLength(1);
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("returns actual user-owned native focus only after parking acknowledgement and detachment", async () => {
    const state = await create();
    await present(state);
    native.pages[0]!.focused = true;
    owner.contents.focus.mockImplementation(() => { native.trace.push("host-focus"); });
    native.trace = [];
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toMatchObject({ ok: true });
    expect(native.trace).toEqual(["bind:true", "detach", "detach", "host-focus"]);
    expect(owner.contents.focus).toHaveBeenCalledTimes(1);
  });

  it("does not reactivate an inactive owning window when parking a focused page", async () => {
    const state = await create();
    await present(state);
    native.pages[0]!.focused = true;
    owner.focused = false;
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toMatchObject({ ok: true });
    expect(owner.contents.focus).not.toHaveBeenCalled();
    expect(ownerChildren()).toEqual([]);
  });

  it("rechecks native window focus after the parking acknowledgement", async () => {
    const state = await create();
    await present(state);
    native.pages[0]!.focused = true;
    vi.mocked(deps.bind).mockImplementation(() => { owner.focused = false; return { ok: true }; });
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toMatchObject({ ok: true });
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("detaches a placement whose unpark acknowledgement fails", async () => {
    const state = await create();
    vi.mocked(deps.bind).mockReturnValue({ ok: false, error: "guest-not-hosted" });
    expect(await present(state)).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(ownerChildren()).toEqual([]);
    expect(native.pages[0]!.close).not.toHaveBeenCalled();
  });

  it("converts the visible clip and full page viewport using the host zoom", async () => {
    owner.zoom = 1.5;
    const state = await create();
    await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 1,
      bounds: { x: -10, y: 20, width: 800, height: 600 }, clipBounds: { x: 30, y: 50, width: 400, height: 300 }, borderRadius: 8 });
    const container = ownerChildren()[0]!;
    expect(container.getBounds()).toEqual({ x: 45, y: 75, width: 600, height: 450 });
    expect(container.borderRadius).toBe(12);
    expect(pageView().getBounds()).toEqual({ x: -60, y: -45, width: 1200, height: 900 });
  });

  it("rejects old or duplicate placement sequences", async () => {
    const state = await create();
    await present(state, 4);
    expect(await present(state, 4)).toEqual({ ok: false, error: "stale-surface" });
    expect(await present(state, 3)).toEqual({ ok: false, error: "stale-surface" });
    expect(await present(state, 5)).toMatchObject({ ok: true });
  });

  it("rejects malformed geometry before touching native views", async () => {
    const state = await create();
    for (const bounds of [{ x: 0, y: 0, width: 0, height: 30 }, { x: Infinity, y: 0, width: 30, height: 30 }, { x: 0, y: 0, width: 32769, height: 30 }]) {
      expect(await present(state, 1, bounds)).toEqual({ ok: false, error: "bad-request" });
    }
    expect(ownerChildren()).toEqual([]);
  });

  it("refuses a foreign window or replaced page identifier", async () => {
    const state = await create();
    expect(await host.request(2, { action: "close", tabId: state.tabId, webContentsId: state.webContentsId })).toEqual({ ok: false, error: "stale-surface" });
    expect(await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId + 1 })).toEqual({ ok: false, error: "stale-surface" });
    expect(native.pages[0]!.close).not.toHaveBeenCalled();
  });

  it("parks on hide and restores only the latest placement when shown", async () => {
    const state = await create();
    await present(state);
    owner.visible = false;
    owner.emit("hide");
    expect(ownerChildren()).toEqual([]);
    expect(await present(state, 2, { x: 90, y: 120, width: 700, height: 500 })).toMatchObject({ ok: true, surface: { visible: false } });
    owner.visible = true;
    owner.emit("show");
    expect(ownerChildren()[0]!.getBounds()).toEqual({ x: 90, y: 120, width: 700, height: 500 });
    expect(native.pages[0]!.close).not.toHaveBeenCalled();
  });

  it("parks on minimize and preserves the page through restore", async () => {
    const state = await create();
    await present(state);
    owner.minimized = true;
    owner.emit("minimize");
    expect(ownerChildren()).toEqual([]);
    owner.minimized = false;
    owner.emit("restore");
    expect(ownerChildren()).toHaveLength(1);
    expect(native.pages[0]!.loadURL).toHaveBeenCalledTimes(1);
  });

  it.each(["render-process-gone", "did-start-loading"])("invalidates old placements after host %s", async event => {
    const state = await create();
    await present(state);
    owner.contents.emit(event);
    expect(ownerChildren()).toEqual([]);
    expect(await present(state, 2)).toEqual({ ok: false, error: "stale-surface" });
    owner.emit("show");
    expect(ownerChildren()).toEqual([]);
    const refreshed = await create();
    expect(refreshed.webContentsId).toBe(state.webContentsId);
    expect(await present(refreshed)).toMatchObject({ ok: true, surface: { visible: true } });
  });
});

describe("native browser user commands and state", () => {
  it("refuses focus while parked, hidden or owned by an inactive native window", async () => {
    const state = await create();
    const focus = () => host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId });
    expect(await focus()).toEqual({ ok: false, error: "native-surface-unavailable" });
    await present(state);
    owner.focused = false;
    expect(await focus()).toEqual({ ok: false, error: "native-surface-unavailable" });
    owner.visible = false;
    expect(await focus()).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(deps.userFocus).not.toHaveBeenCalled();
    expect(native.pages[0]!.focus).not.toHaveBeenCalled();
  });

  it("marks explicit user focus before routing focus to a presented page", async () => {
    const state = await create();
    await present(state);
    await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId });
    expect(deps.userFocus).toHaveBeenCalledWith(state.webContentsId, true);
    expect(vi.mocked(deps.userFocus).mock.invocationCallOrder[0]).toBeLessThan(native.pages[0]!.focus.mock.invocationCallOrder[0]!);
    expect(native.pages[0]!.focus).toHaveBeenCalledTimes(1);
  });

  it("reports actual focus only for the presented focused page in its focused owner", async () => {
    const state = await create();
    const page = native.pages[0]!;
    page.focused = true;
    page.emit("focus");
    expect(deps.userFocus).not.toHaveBeenCalled();
    await present(state);
    page.focused = false;
    page.emit("focus");
    owner.focused = false;
    page.focused = true;
    page.emit("focus");
    expect(deps.userFocus).not.toHaveBeenCalled();
    owner.focused = true;
    page.emit("focus");
    expect(deps.userFocus).toHaveBeenCalledExactlyOnceWith(state.webContentsId);
  });

  it("uses confirmed page emulation in background without native focus", async () => {
    native.background = true;
    owner.focused = false;
    const state = await create();
    await present(state);
    expect(await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId })).toMatchObject({ ok: true });
    expect(deps.userFocus).toHaveBeenCalledExactlyOnceWith(state.webContentsId, true);
    expect(native.pages[0]!.focus).not.toHaveBeenCalled();
    native.emulated = false;
    expect(await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId })).toEqual({ ok: false, error: "native-surface-unavailable" });
  });

  it("invalidates user control before allowed navigation and rejects unsafe URLs", async () => {
    const state = await create();
    const page = native.pages[0]!;
    expect(await host.request(1, { action: "navigate", tabId: state.tabId, webContentsId: state.webContentsId, url: "https://site.example/path" })).toMatchObject({ ok: true, surface: { url: "https://site.example/path" } });
    expect(deps.userNavigate).toHaveBeenCalledExactlyOnceWith(1, state.tabId);
    expect(vi.mocked(deps.userNavigate).mock.invocationCallOrder[0]).toBeLessThan(page.loadURL.mock.invocationCallOrder[1]!);
    for (const url of ["javascript:alert(1)", "file:///tmp/private", "https://user:secret@site.example/", "about:blank#script"]) {
      expect(await host.request(1, { action: "navigate", tabId: state.tabId, webContentsId: state.webContentsId, url })).toEqual({ ok: false, error: "bad-request" });
    }
    expect(deps.userNavigate).toHaveBeenCalledTimes(1);
    expect(page.loadURL).toHaveBeenCalledTimes(2);
  });

  it("handles navigation history, reload and explicit developer tools over the same page", async () => {
    const state = await create();
    const page = native.pages[0]!;
    page.navigationHistory.canGoBack.mockReturnValue(true);
    page.navigationHistory.canGoForward.mockReturnValue(true);
    for (const action of ["back", "forward", "reload", "devtools"] as const) {
      expect(await host.request(1, { action, tabId: state.tabId, webContentsId: state.webContentsId })).toMatchObject({ ok: true });
    }
    expect(deps.userNavigate).toHaveBeenCalledTimes(3);
    expect(page.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(page.navigationHistory.goForward).toHaveBeenCalledTimes(1);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(deps.userFocus).toHaveBeenCalledWith(state.webContentsId, true);
    expect(page.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: "detach" });
  });

  it("publishes increasing revisions for page navigation, title and loading events", async () => {
    const state = await create();
    const page = native.pages[0]!;
    page.url = "https://site.example/";
    page.title = "Current title";
    page.loading = true;
    for (const event of ["did-start-loading", "did-navigate", "did-navigate-in-page", "page-title-updated", "did-stop-loading"]) page.emit(event);
    const published = vi.mocked(deps.changed).mock.calls.flatMap(([_windowId, surface]) => surface ? [surface] : []);
    expect(published).toHaveLength(6);
    expect(published.map(surface => surface.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(published.at(-1)).toMatchObject({ webContentsId: state.webContentsId, url: "https://site.example/", title: "Current title", loading: true });
  });

  it("publishes only bounded image-data favicons from the page", async () => {
    const state = await create();
    const page = native.pages[0]!;
    expect(state.favicon).toBeNull();
    page.emit("page-favicon-updated", {}, ["https://site.example/icon.png", "data:image/png;base64,YQ=="]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: "data:image/png;base64,YQ==" }), state.tabId);
    page.emit("page-favicon-updated", {}, ["data:image/png;base64," + "A".repeat(BROWSER_NATIVE_FAVICON_MAX_LENGTH), "data:image/png;base64,Yg=="]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: "data:image/png;base64,Yg==" }), state.tabId);
    page.emit("page-favicon-updated", {}, ["https://site.example/icon.png", "javascript:alert(1)", " data:image/png;base64,YQ=="]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: null }), state.tabId);
  });

  it("clears the old favicon when its main document starts navigating", async () => {
    const state = await create();
    const page = native.pages[0]!;
    page.emit("page-favicon-updated", {}, ["data:image/png;base64,YQ=="]);
    page.emit("did-start-navigation", {}, "https://frame.example/", false, false);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: "data:image/png;base64,YQ==" }), state.tabId);
    page.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: null }), state.tabId);
  });

  it("destroys only the explicit page and emits its removal once", async () => {
    const state = await create();
    await create("browser:other");
    await present(state);
    expect(await host.request(1, { action: "close", tabId: state.tabId, webContentsId: state.webContentsId })).toEqual({ ok: true, surface: null });
    expect(native.pages[0]!.close).toHaveBeenCalledTimes(1);
    expect(native.pages[1]!.close).not.toHaveBeenCalled();
    expect(vi.mocked(deps.changed).mock.calls.filter(([, surface, tabId]) => surface === null && tabId === state.tabId)).toHaveLength(1);
    expect(await present(state, 2)).toEqual({ ok: false, error: "stale-surface" });
  });

  it("retires unexpected page destruction and removes its listeners", async () => {
    const state = await create();
    await present(state);
    const page = native.pages[0]!;
    page.destroyed = true;
    page.emit("destroyed");
    expect(ownerChildren()).toEqual([]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, null, state.tabId);
    expect(page.listenerCount("focus")).toBe(0);
    expect(page.listenerCount("did-navigate")).toBe(0);
    expect(page.close).not.toHaveBeenCalled();
  });

  it("disposes every page of one owner while preserving another window", async () => {
    await create();
    await create("browser:other");
    const other = await create("browser:second-window", 2);
    host.disposeWindow(1);
    expect(native.pages[0]!.close).toHaveBeenCalledTimes(1);
    expect(native.pages[1]!.close).toHaveBeenCalledTimes(1);
    expect(native.pages[2]!.close).not.toHaveBeenCalled();
    expect(owner.listenerCount("show")).toBe(0);
    expect(await host.request(2, { action: "reload", tabId: other.tabId, webContentsId: other.webContentsId })).toMatchObject({ ok: true });
    host.dispose();
    expect(native.pages[2]!.close).toHaveBeenCalledTimes(1);
    expect(await host.request(2, { action: "create", tabId: "browser:late" })).toEqual({ ok: false, error: "native-surface-unavailable" });
  });
});
