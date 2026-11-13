import { EventEmitter } from "node:events";
import type { MainWindow } from "../../main-window-host.js";
import type { BrowserNativeInput } from "../../../shared/browser-native-input.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
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
  sendInputEvent: ReturnType<typeof vi.fn>;
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
    sendInputEvent = vi.fn(() => { native.trace.push("input"); });
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

vi.mock("../../main-window-host.js", () => ({
  attachMainWindowPage: (window: { contentView: NativeView }, view: NativeView) => window.contentView.addChildView(view),
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
let nextInputSequence = 0;

beforeEach(() => {
  nextInputSequence = 0;
  native.pages = []; native.views = []; native.preferences = []; native.trace = []; native.pendingLoads = [];
  native.deferredLoad = false; native.background = false; native.emulated = true; native.nextId = 10;
  owner = new Window(1);
  secondOwner = new Window(2);
  windows = new Map([[owner.id, owner], [secondOwner.id, secondOwner]]);
  deps = {
    windowForId: id => windows.get(id) as unknown as MainWindow | undefined,
    authorizeCreate: vi.fn(() => true),
    attach: vi.fn(),
    bind: vi.fn((_windowId, request): BrowserTabBindResult => { native.trace.push(`bind:${request.parked}`); return { ok: true }; }),
    changed: vi.fn(), inputStateChanged: vi.fn(), userFocus: vi.fn(), userNavigate: vi.fn(),
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

function requiredValue<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing ${description}`);
  return value;
}

function nativePage(index = 0): Page {
  return requiredValue(native.pages[index], `native page ${index}`);
}

function pendingLoad(index = 0) {
  return requiredValue(native.pendingLoads[index], `pending load ${index}`);
}

function pageView(index = 0): NativeView {
  const page = nativePage(index);
  return requiredValue(native.views.find(view => view.webContents === page), `native page view ${index}`);
}

function ownerChildren(window = owner): NativeView[] {
  return (window.contentView as unknown as NativeView).children;
}

function expectParkedPage(width = 800, height = 600): void {
  const container = requiredValue(ownerChildren()[0], "native parking container");
  expect(ownerChildren()).toHaveLength(1);
  expect(container.children).toEqual([pageView()]);
  expect(container.getBounds()).toEqual({ x: -width, y: 0, width, height });
  expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width, height });
}

function pointer(surface: BrowserNativeSurfaceState, overrides: Partial<BrowserNativeInput> = {}): BrowserNativeInput {
  return { tabId: surface.tabId, webContentsId: surface.webContentsId, epoch: surface.epoch, sequence: ++nextInputSequence,
    type: "mouseDown", x: 100, y: 120, button: "left", clickCount: 1, modifiers: [], ...overrides };
}

async function customCursorImage(width = 16, height = 16) {
  const png = await sharp({ create: { width, height, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } } }).png().toBuffer();
  const toPNG = vi.fn(() => png);
  return { png, toPNG, isEmpty: vi.fn(() => false), getSize: vi.fn(() => ({ width: width * 2, height: height * 2 })),
    resize: vi.fn((_options: unknown) => ({ toPNG })) };
}

describe("native browser trusted user pointer routing", () => {
  it("rejects stale, foreign, malformed and parked input without native delivery", async () => {
    const state = await create();
    expect(host.input(1, pointer(state))).toBe(false);
    await present(state);
    expect(host.input(2, pointer(state))).toBe(false);
    expect(host.input(1, pointer(state, { epoch: state.epoch + 1 }))).toBe(false);
    expect(host.input(1, pointer(state, { webContentsId: state.webContentsId + 1 }))).toBe(false);
    expect(host.input(1, pointer(state, { x: Number.NaN }))).toBe(false);
    owner.visible = false;
    expect(host.input(1, pointer(state))).toBe(false);
    expect(nativePage().sendInputEvent).not.toHaveBeenCalled();
    expect(deps.userFocus).not.toHaveBeenCalled();
  });

  it("translates host coordinates through UI zoom and records takeover before native input", async () => {
    owner.zoom = 1.5;
    const state = await create();
    await present(state);
    native.trace = [];
    vi.mocked(deps.userFocus).mockImplementation(() => { native.trace.push("takeover"); });
    nativePage().focus.mockImplementation(() => { native.trace.push("focus"); });
    expect(host.input(1, pointer(state, { x: 100.5, y: 121.5, modifiers: ["shift"] }))).toBe(true);
    expect(nativePage().sendInputEvent).toHaveBeenCalledExactlyOnceWith({
      type: "mouseDown", x: 76, y: 62, button: "left", clickCount: 1, modifiers: ["shift"],
    });
    expect(deps.userFocus).toHaveBeenCalledExactlyOnceWith(state.webContentsId, true);
    expect(native.trace).toEqual(["takeover", "focus", "input"]);
  });

  it("rejects a down outside the authoritative page clip", async () => {
    const state = await create();
    await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch,
      sequence: 1, bounds: { x: 50, y: 80, width: 800, height: 600 }, clipBounds: { x: 100, y: 100, width: 100, height: 100 } });
    expect(host.input(1, pointer(state, { x: 99 }))).toBe(false);
    expect(host.input(1, pointer(state, { x: 200 }))).toBe(false);
    expect(host.input(1, pointer(state, { x: 100 }))).toBe(true);
    expect(nativePage().sendInputEvent).toHaveBeenCalledTimes(1);
  });

  it("uses the actual native geometry while a UI zoom update awaits presentation", async () => {
    const state = await create();
    await present(state);
    owner.zoom = 2;
    expect(host.input(1, pointer(state))).toBe(true);
    expect(nativePage().sendInputEvent).toHaveBeenCalledExactlyOnceWith({
      type: "mouseDown", x: 150, y: 160, button: "left", clickCount: 1, modifiers: [],
    });
  });

  it("retains a captured drag through an outside release and ends it once", async () => {
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state))).toBe(true);
    expect(vi.mocked(deps.userFocus).mock.calls).toEqual([[state.webContentsId, true], [state.webContentsId]]);
    expect(host.input(1, pointer(state, { type: "mouseMove", x: -20, y: 900, modifiers: ["leftbuttondown"] }))).toBe(true);
    expect(host.input(1, pointer(state, { type: "mouseUp", x: -20, y: 900 }))).toBe(true);
    expect(nativePage().sendInputEvent).toHaveBeenLastCalledWith({ type: "mouseUp", x: -70, y: 820, button: "left", clickCount: 1, modifiers: [] });
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(false);
    expect(host.input(1, pointer(state, { type: "mouseMove", x: -20 }))).toBe(false);
    expect(vi.mocked(deps.userFocus).mock.calls).toEqual([[state.webContentsId, true], [state.webContentsId]]);
  });

  it("delivers left-down, right-down, right-up and left-up to the same page", async () => {
    const state = await create();
    await present(state);
    const inputs = [
      pointer(state, { button: "left", modifiers: ["leftbuttondown"] }),
      pointer(state, { button: "right", modifiers: ["leftbuttondown", "rightbuttondown"] }),
      pointer(state, { type: "mouseUp", button: "right", modifiers: ["leftbuttondown"] }),
      pointer(state, { type: "mouseUp", button: "left" }),
    ];

    expect(inputs.map(input => host.input(1, input))).toEqual([true, true, true, true]);
    expect(nativePage().sendInputEvent.mock.calls.map(([event]) => [event.type, event.button])).toEqual([
      ["mouseDown", "left"],
      ["mouseDown", "right"],
      ["mouseUp", "right"],
      ["mouseUp", "left"],
    ]);
    expect(deps.inputStateChanged).not.toHaveBeenCalled();
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(false);
  });

  it.each(["blur", "park"] as const)("cancels all held buttons on %s with the latest press sequence", async reason => {
    const state = await create();
    await present(state);
    const first = pointer(state, { modifiers: ["leftbuttondown"] });
    const second = pointer(state, { button: "right", modifiers: ["leftbuttondown", "rightbuttondown"] });
    expect(host.input(1, first)).toBe(true);
    expect(host.input(1, second)).toBe(true);

    if (reason === "blur") owner.emit("blur");
    else {
      await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId,
        epoch: state.epoch, sequence: 2, bounds: null });
      await present(state, 3);
    }

    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cancel", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, sequence: second.sequence });
    expect(host.input(1, pointer(state, { type: "mouseUp", button: "right", modifiers: ["leftbuttondown"] }))).toBe(false);
    expect(host.input(1, pointer(state, { type: "mouseUp", button: "left" }))).toBe(false);
    expect(nativePage().sendInputEvent).toHaveBeenCalledTimes(2);

    expect(host.input(1, pointer(state))).toBe(true);
    expect(host.input(1, { ...first, type: "mouseUp" })).toBe(false);
    expect(host.input(1, pointer(state, { type: "mouseUp", epoch: state.epoch + 1 }))).toBe(false);
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(true);
  });

  it("clears capture when parking and rejects a release after reacquisition", async () => {
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state))).toBe(true);
    await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null });
    await present(state, 3);
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(false);
    expect(host.input(1, pointer(state))).toBe(true);
    const retained = await create();
    await present(retained);
    expect(host.input(1, pointer(retained, { type: "mouseUp" }))).toBe(false);
  });

  it("keeps captured releases on their page and replaces a missed release on a new down", async () => {
    const first = await create();
    const second = await create("browser:second");
    await present(first);
    await present(second);
    expect(host.input(1, pointer(first))).toBe(true);
    expect(host.input(1, pointer(second, { type: "mouseMove", modifiers: ["leftbuttondown"] }))).toBe(false);
    expect(host.input(1, pointer(second, { type: "mouseUp" }))).toBe(false);
    expect(host.input(1, pointer(second))).toBe(true);
    expect(host.input(1, pointer(first, { type: "mouseUp" }))).toBe(false);
    expect(host.input(1, pointer(second, { type: "mouseUp" }))).toBe(true);
  });

  it("clears a captured gesture when its native window loses focus", async () => {
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state))).toBe(true);
    owner.emit("blur");
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(false);
    expect(host.input(1, pointer(state, { type: "mouseMove", x: -20 }))).toBe(false);
    expect(host.input(1, pointer(state))).toBe(true);
  });

  it("keeps hover passive while wheel input takes over and uses native delta direction", async () => {
    owner.zoom = 2;
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state, { type: "mouseMove" }))).toBe(true);
    expect(deps.userFocus).not.toHaveBeenCalled();
    expect(nativePage().focus).not.toHaveBeenCalled();
    expect(host.input(1, pointer(state, { type: "mouseWheel", deltaX: 2, deltaY: -35 }))).toBe(true);
    expect(nativePage().sendInputEvent).toHaveBeenLastCalledWith({ type: "mouseWheel", x: 100, y: 80, button: "left",
      clickCount: 1, modifiers: [], deltaX: 4, deltaY: -70, hasPreciseScrollingDeltas: true, canScroll: true });
    expect(vi.mocked(deps.userFocus).mock.calls).toEqual([[state.webContentsId, true]]);
    expect(nativePage().focus).not.toHaveBeenCalled();
  });

  it("does not activate an inactive owner and preserves background test focus isolation", async () => {
    const state = await create();
    await present(state);
    owner.focused = false;
    expect(host.input(1, pointer(state))).toBe(false);
    expect(nativePage().sendInputEvent).not.toHaveBeenCalled();
    native.background = true;
    expect(host.input(1, pointer(state))).toBe(true);
    expect(nativePage().focus).not.toHaveBeenCalled();
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("fails closed and drops capture when native delivery throws", async () => {
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state))).toBe(true);
    nativePage().sendInputEvent.mockImplementationOnce(() => { throw new Error("Native page unavailable"); });
    expect(host.input(1, pointer(state, { type: "mouseMove" }))).toBe(false);
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(false);
  });

  it("sends leave outside the pane without pausing or focusing", async () => {
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state, { type: "mouseLeave", x: -10, y: -10 }))).toBe(true);
    expect(nativePage().sendInputEvent).toHaveBeenCalledExactlyOnceWith({ type: "mouseLeave", x: -60, y: -90,
      button: "left", clickCount: 1, modifiers: [] });
    expect(deps.userFocus).not.toHaveBeenCalled();
    expect(nativePage().focus).not.toHaveBeenCalled();
  });

  it("cancels the exact down sequence on blur without cancelling a newer gesture", async () => {
    const state = await create();
    await present(state);
    const first = pointer(state);
    expect(host.input(1, first)).toBe(true);
    owner.emit("blur");
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cancel", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, sequence: first.sequence });
    const second = pointer(state);
    expect(host.input(1, second)).toBe(true);
    expect(host.input(1, { ...first, type: "mouseUp" })).toBe(false);
    expect(deps.inputStateChanged).toHaveBeenCalledTimes(1);
    expect(host.input(1, pointer(state, { type: "mouseUp" }))).toBe(true);
  });

  it("releases a missed up before passive hover enters another page and rejects host-owned drags", async () => {
    const first = await create();
    const second = await create("browser:second");
    await present(first);
    await present(second);
    const down = pointer(first);
    expect(host.input(1, down)).toBe(true);
    expect(host.input(1, pointer(second, { type: "mouseMove" }))).toBe(true);
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cancel", tabId: first.tabId,
      webContentsId: first.webContentsId, epoch: first.epoch, sequence: down.sequence });
    expect(host.input(1, pointer(second, { type: "mouseMove", modifiers: ["leftbuttondown"] }))).toBe(false);
    expect(nativePage(1).sendInputEvent).toHaveBeenCalledTimes(1);
  });

  it.each(["park", "reacquire", "delivery", "reject", "new-down", "reload", "close"] as const)("cancels the captured down on %s", async reason => {
    const state = await create();
    await present(state);
    const down = pointer(state);
    expect(host.input(1, down)).toBe(true);
    if (reason === "park") await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null });
    if (reason === "reacquire") await create();
    if (reason === "delivery") {
      nativePage().sendInputEvent.mockImplementationOnce(() => { throw new Error("Native page unavailable"); });
      expect(host.input(1, pointer(state, { type: "mouseMove" }))).toBe(false);
    }
    if (reason === "reject") expect(host.input(1, pointer(state, { type: "mouseUp", button: "right" }))).toBe(false);
    if (reason === "new-down") expect(host.input(1, pointer(state))).toBe(true);
    if (reason === "reload") owner.contents.emit("did-start-navigation", {}, "http://localhost/", false, true);
    if (reason === "close") await host.request(1, { action: "close", tabId: state.tabId, webContentsId: state.webContentsId });
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cancel", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, sequence: down.sequence });
  });

  it("cancels a down whose first native delivery fails", async () => {
    const state = await create();
    await present(state);
    const down = pointer(state);
    nativePage().sendInputEvent.mockImplementationOnce(() => { throw new Error("Native page unavailable"); });
    expect(host.input(1, down)).toBe(false);
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cancel", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, sequence: down.sequence });
  });

  it("cancels a rejected initial down so the private sender drops its local capture", async () => {
    const state = await create();
    await present(state);
    const down = pointer(state, { x: -20 });
    expect(host.input(1, down)).toBe(false);
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cancel", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, sequence: down.sequence });
  });

  it("accepts the restarted UI sequence after all earlier pages have closed", async () => {
    const state = await create();
    await present(state);
    expect(host.input(1, pointer(state, { sequence: 50 }))).toBe(true);
    await host.request(1, { action: "close", tabId: state.tabId, webContentsId: state.webContentsId });
    const replacement = await create();
    await present(replacement);
    expect(host.input(1, pointer(replacement, { sequence: 1 }))).toBe(true);
  });

  it.each([["pointer", "default"], ["hand", "pointer"], ["text", "text"], ["nodrop", "no-drop"], ["e-panning", "e-resize"],
    ["m-panning", "all-scroll"], ["drag-drop-link", "alias"], ["ns-no-resize", "not-allowed"], ["custom", "auto"], ["unrecognized", "auto"]])("maps native cursor %s to CSS %s only while attached", async (type, cursor) => {
    const state = await create();
    nativePage().emit("cursor-changed", {}, type);
    expect(deps.inputStateChanged).not.toHaveBeenCalled();
    await present(state);
    nativePage().emit("cursor-changed", {}, type);
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cursor", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, cursor });
    await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null });
    nativePage().emit("cursor-changed", {}, type);
    expect(deps.inputStateChanged).toHaveBeenCalledTimes(1);
  });

  it("resizes custom bitmap cursors to logical size and floors the scaled hotspot", async () => {
    const state = await create();
    await present(state);
    const image = await customCursorImage();
    nativePage().emit("cursor-changed", {}, "custom", image, 2, { width: 32, height: 32 }, { x: 7, y: 11 });
    expect(image.resize).toHaveBeenCalledExactlyOnceWith({ width: 16, height: 16, quality: "best" });
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "custom-cursor", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, dataUrl: `data:image/png;base64,${image.png.toString("base64")}`,
      width: 16, height: 16, hotspot: { x: 3, y: 5 } });
    expect(deps.userFocus).not.toHaveBeenCalled();
    expect(nativePage().focus).not.toHaveBeenCalled();
  });

  it("rounds logical dimensions while preserving an in-bounds fractional-scale hotspot", async () => {
    const state = await create();
    await present(state);
    const image = await customCursorImage(21, 13);
    image.getSize.mockReturnValue({ width: 31, height: 19 });
    nativePage().emit("cursor-changed", {}, "custom", image, 1.5, { width: 31, height: 19 }, { x: 30, y: 18 });
    expect(image.resize).toHaveBeenCalledExactlyOnceWith({ width: 21, height: 13, quality: "best" });
    expect(deps.inputStateChanged).toHaveBeenLastCalledWith(1, expect.objectContaining({ type: "custom-cursor", width: 21,
      height: 13, hotspot: { x: 20, y: 12 } }));
  });

  it("admits the bounded maximum bitmap scale and logical cursor size", async () => {
    const state = await create();
    await present(state);
    const image = await customCursorImage(128, 128);
    image.getSize.mockReturnValue({ width: 1024, height: 1024 });
    nativePage().emit("cursor-changed", {}, "custom", image, 8, { width: 1024, height: 1024 }, { x: 1023, y: 1023 });
    expect(image.resize).toHaveBeenCalledExactlyOnceWith({ width: 128, height: 128, quality: "best" });
    expect(deps.inputStateChanged).toHaveBeenLastCalledWith(1, expect.objectContaining({ type: "custom-cursor", width: 128,
      height: 128, hotspot: { x: 127, y: 127 } }));
  });

  it.each([0, -1, 9, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid custom cursor scale %s before image encoding", async scale => {
    const state = await create();
    await present(state);
    const image = await customCursorImage();
    nativePage().emit("cursor-changed", {}, "custom", image, scale, { width: 32, height: 32 }, { x: 0, y: 0 });
    expect(image.resize).not.toHaveBeenCalled();
    expect(deps.inputStateChanged).toHaveBeenCalledExactlyOnceWith(1, { type: "cursor", tabId: state.tabId,
      webContentsId: state.webContentsId, epoch: state.epoch, cursor: "auto" });
  });

  it.each(["raw-size", "logical-size", "fractional-size", "negative-hotspot", "outside-hotspot", "fractional-hotspot", "image-size", "empty-image"] as const)("rejects custom cursor %s before image encoding", async invalid => {
    const state = await create();
    await present(state);
    const image = await customCursorImage();
    const size = { width: 32, height: 32 };
    const hotspot = { x: 0, y: 0 };
    let scale = 2;
    if (invalid === "raw-size") size.width = 1025;
    if (invalid === "logical-size") scale = 0.1;
    if (invalid === "fractional-size") size.width = 32.5;
    if (invalid === "negative-hotspot") hotspot.x = -1;
    if (invalid === "outside-hotspot") hotspot.y = 32;
    if (invalid === "fractional-hotspot") hotspot.x = 0.5;
    if (invalid === "image-size") image.getSize.mockReturnValue({ width: 31, height: 32 });
    if (invalid === "empty-image") image.isEmpty.mockReturnValue(true);
    nativePage().emit("cursor-changed", {}, "custom", image, scale, size, hotspot);
    expect(image.resize).not.toHaveBeenCalled();
    expect(deps.inputStateChanged).toHaveBeenLastCalledWith(1, expect.objectContaining({ type: "cursor", cursor: "auto" }));
  });

  it.each(["oversized", "invalid-png", "wrong-dimensions", "encode-error"] as const)("rejects %s custom cursor output", async invalid => {
    const state = await create();
    await present(state);
    const image = await customCursorImage();
    if (invalid === "oversized") image.toPNG.mockReturnValue(Buffer.alloc(262145));
    if (invalid === "invalid-png") image.toPNG.mockReturnValue(Buffer.from("invalid"));
    if (invalid === "wrong-dimensions") image.toPNG.mockReturnValue((await customCursorImage(15, 15)).png);
    if (invalid === "encode-error") image.toPNG.mockImplementation(() => { throw new Error("Cursor encoding failed"); });
    nativePage().emit("cursor-changed", {}, "custom", image, 2, { width: 32, height: 32 }, { x: 0, y: 0 });
    expect(deps.inputStateChanged).toHaveBeenLastCalledWith(1, expect.objectContaining({ type: "cursor", cursor: "auto" }));
  });
});

describe("native browser page creation", () => {
  it("creates an isolated page outside the window while retaining its native root and binds only its blank bootstrap", async () => {
    const state = await create();
    const page = nativePage();
    expect(native.preferences[0]).toMatchObject({
      partition: "persist:ave-side-browser", focusOnNavigation: false, backgroundThrottling: false,
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, javascript: true, webviewTag: false,
    });
    expect(native.preferences[0]).not.toHaveProperty("preload");
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
    expect(page.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    expectParkedPage(1024, 768);
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
    pendingLoad().resolve();
    expect(await first).toEqual({ ok: false, error: "stale-surface" });
    expect(await second).toMatchObject({ ok: true, initialNavigation: true, surface: { epoch: 2, webContentsId: nativePage().id } });
    expect(deps.attach).toHaveBeenCalledTimes(1);
    expect(deps.bind).toHaveBeenCalledTimes(1);
  });

  it("reacquires an existing page with a new epoch without reloading its document", async () => {
    const first = await create();
    await present(first);
    nativePage().focused = true;
    const second = await create();
    expect(second.webContentsId).toBe(first.webContentsId);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(second.visible).toBe(false);
    expect(nativePage().loadURL).toHaveBeenCalledTimes(1);
    expectParkedPage();
    expect(owner.contents.focus).not.toHaveBeenCalled();
    expect(await present(first, 2)).toEqual({ ok: false, error: "stale-surface" });
    expect(await present(second)).toMatchObject({ ok: true, surface: { visible: true } });
  });

  it.each(["https://b.example/current", "about:blank"])("preserves completed initial navigation when reacquiring %s", async (url) => {
    const first = await host.request(1, { action: "create", tabId: "browser:agent", requestId: "browser-op-1" });
    expect(first).toMatchObject({ ok: true, initialNavigation: true });
    const page = nativePage();
    page.emit("did-start-navigation", {}, url, false, true);
    page.url = url;
    const retained = await host.request(1, { action: "create", tabId: "browser:agent" });
    expect(retained).toMatchObject({ ok: true, initialNavigation: false, surface: { url, webContentsId: page.id } });
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
  });

  it("closes a page whose bootstrap binding is refused", async () => {
    vi.mocked(deps.bind).mockReturnValue({ ok: false, error: "guest-not-hosted" });
    expect(await host.request(1, { action: "create", tabId: "browser:agent" })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(nativePage().close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(deps.changed).toHaveBeenLastCalledWith(1, null, "browser:agent");
  });

  it("closes a page when the policy installer fails", async () => {
    vi.mocked(deps.attach).mockImplementation(() => { throw new Error("Policy unavailable"); });
    expect(await host.request(1, { action: "create", tabId: "browser:agent" })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(nativePage().close).toHaveBeenCalledTimes(1);
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("ends an unresolved bootstrap when its owner closes", async () => {
    native.deferredLoad = true;
    const pending = host.request(1, { action: "create", tabId: "browser:agent" });
    owner.destroyed = true;
    owner.emit("closed");
    expect(await pending).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(nativePage().close).toHaveBeenCalledTimes(1);
    pendingLoad().resolve();
    await Promise.resolve();
    expect(deps.bind).not.toHaveBeenCalled();
    expect(owner.listenerCount("hide")).toBe(0);
  });
});

describe("native browser pane presentation", () => {
  it("attaches only for a visible pane and never focuses or pauses on presentation", async () => {
    const state = await create();
    expect(await present(state)).toMatchObject({ ok: true, surface: { visible: true } });
    const container = requiredValue(ownerChildren()[0], "native presentation container");
    expect(container.children).toEqual([pageView()]);
    expect(container.getBounds()).toEqual({ x: 50, y: 80, width: 800, height: 600 });
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(deps.bind).toHaveBeenLastCalledWith(1, { tabId: state.tabId, webContentsId: state.webContentsId, parked: false });
    expect(deps.userFocus).not.toHaveBeenCalled();
    expect(nativePage().focus).not.toHaveBeenCalled();
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("acknowledges parking before moving the page outside the window and retains its native root", async () => {
    const state = await create();
    await present(state);
    native.trace = [];
    const parked = await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null });
    expect(parked).toMatchObject({ ok: true, surface: { visible: false } });
    expect(native.trace).toEqual(["bind:true"]);
    expectParkedPage();
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(nativePage().close).not.toHaveBeenCalled();
    expect(owner.contents.focus).not.toHaveBeenCalled();
    expect(await present(state, 3)).toMatchObject({ ok: true, surface: { webContentsId: state.webContentsId, visible: true } });
  });

  it("keeps the old placement when parking acknowledgement fails", async () => {
    const state = await create();
    await present(state);
    nativePage().focused = true;
    vi.mocked(deps.bind).mockImplementation(() => { native.trace.push("bind:true"); return { ok: false, error: "guest-not-hosted" }; });
    native.trace = [];
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(native.trace).toEqual(["bind:true"]);
    expect(ownerChildren()).toHaveLength(1);
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("returns actual user-owned native focus only after parking acknowledgement", async () => {
    const state = await create();
    await present(state);
    nativePage().focused = true;
    owner.contents.focus.mockImplementation(() => { native.trace.push("host-focus"); });
    native.trace = [];
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toMatchObject({ ok: true });
    expect(native.trace).toEqual(["bind:true", "host-focus"]);
    expect(owner.contents.focus).toHaveBeenCalledTimes(1);
  });

  it("does not reactivate an inactive owning window when parking a focused page", async () => {
    const state = await create();
    await present(state);
    nativePage().focused = true;
    owner.focused = false;
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toMatchObject({ ok: true });
    expect(owner.contents.focus).not.toHaveBeenCalled();
    expectParkedPage();
  });

  it("rechecks native window focus after the parking acknowledgement", async () => {
    const state = await create();
    await present(state);
    nativePage().focused = true;
    vi.mocked(deps.bind).mockImplementation(() => { owner.focused = false; return { ok: true }; });
    expect(await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 2, bounds: null })).toMatchObject({ ok: true });
    expect(owner.contents.focus).not.toHaveBeenCalled();
  });

  it("parks a placement whose unpark acknowledgement fails", async () => {
    const state = await create();
    vi.mocked(deps.bind).mockReturnValue({ ok: false, error: "guest-not-hosted" });
    expect(await present(state)).toEqual({ ok: false, error: "native-surface-unavailable" });
    expectParkedPage();
    expect(nativePage().close).not.toHaveBeenCalled();
  });

  it("converts the visible clip and full page viewport using the host zoom", async () => {
    owner.zoom = 1.5;
    const state = await create();
    await host.request(1, { action: "present", tabId: state.tabId, webContentsId: state.webContentsId, epoch: state.epoch, sequence: 1,
      bounds: { x: -10, y: 20, width: 800, height: 600 }, clipBounds: { x: 30, y: 50, width: 400, height: 300 }, borderRadius: 8 });
    const container = requiredValue(ownerChildren()[0], "native presentation container");
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

  it("does not reconnect a page retired during its presentation binding", async () => {
    const state = await create();
    vi.mocked(deps.bind).mockImplementation(() => { host.dispose(); return { ok: true }; });
    expect(await present(state)).toEqual({ ok: false, error: "native-surface-unavailable" });
    expect(ownerChildren()).toEqual([]);
    expect(nativePage().close).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed geometry before touching native views", async () => {
    const state = await create();
    for (const bounds of [{ x: 0, y: 0, width: 0, height: 30 }, { x: Infinity, y: 0, width: 30, height: 30 }, { x: 0, y: 0, width: 32769, height: 30 }]) {
      expect(await present(state, 1, bounds)).toEqual({ ok: false, error: "bad-request" });
    }
    expectParkedPage(1024, 768);
  });

  it("refuses a foreign window or replaced page identifier", async () => {
    const state = await create();
    expect(await host.request(2, { action: "close", tabId: state.tabId, webContentsId: state.webContentsId })).toEqual({ ok: false, error: "stale-surface" });
    expect(await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId + 1 })).toEqual({ ok: false, error: "stale-surface" });
    expect(nativePage().close).not.toHaveBeenCalled();
  });

  it("parks on hide and restores only the latest placement when shown", async () => {
    const state = await create();
    await present(state);
    owner.visible = false;
    owner.emit("hide");
    expectParkedPage();
    expect(await present(state, 2, { x: 90, y: 120, width: 700, height: 500 })).toMatchObject({ ok: true, surface: { visible: false } });
    owner.visible = true;
    owner.emit("show");
    expect(requiredValue(ownerChildren()[0], "native presentation container").getBounds()).toEqual({ x: 90, y: 120, width: 700, height: 500 });
    expect(nativePage().close).not.toHaveBeenCalled();
  });

  it("parks on minimize and preserves the page through restore", async () => {
    const state = await create();
    await present(state);
    owner.minimized = true;
    owner.emit("minimize");
    expectParkedPage();
    owner.minimized = false;
    owner.emit("restore");
    expect(ownerChildren()).toHaveLength(1);
    expect(nativePage().loadURL).toHaveBeenCalledTimes(1);
  });

  it("retains native presentation and epoch through subframe loading and same-document UI navigation", async () => {
    const state = await create();
    await present(state);
    const children = [...ownerChildren()];
    const bounds = pageView().getBounds();
    vi.mocked(deps.changed).mockClear();
    owner.contents.emit("did-start-loading");
    owner.contents.emit("did-start-navigation", {}, "http://localhost/frame", false, false);
    owner.contents.emit("did-start-navigation", {}, "http://localhost/#panel", true, true);
    expect(ownerChildren()).toEqual(children);
    expect(pageView().getBounds()).toEqual(bounds);
    expect(deps.changed).not.toHaveBeenCalled();
    expect(await present(state, 2)).toMatchObject({ ok: true, surface: { epoch: state.epoch, visible: true } });
  });

  it("retains a hidden page's latest placement through subframe loading until its owner is shown", async () => {
    const state = await create();
    await present(state);
    owner.visible = false;
    owner.emit("hide");
    owner.contents.emit("did-start-loading");
    owner.contents.emit("did-start-navigation", {}, "http://localhost/frame", false, false);
    owner.visible = true;
    owner.emit("show");
    expect(ownerChildren()).toHaveLength(1);
    expect(pageView().getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(await present(state, 2)).toMatchObject({ ok: true, surface: { epoch: state.epoch, visible: true } });
  });

  it.each(["render-process-gone", "main-frame-navigation"])("invalidates old placements after host %s", async event => {
    const state = await create();
    await present(state);
    if (event === "main-frame-navigation") owner.contents.emit("did-start-navigation", {}, "http://localhost/", false, true);
    else owner.contents.emit(event);
    expectParkedPage();
    expect(await present(state, 2)).toEqual({ ok: false, error: "stale-surface" });
    owner.emit("show");
    expectParkedPage();
    const refreshed = await create();
    expect(refreshed.webContentsId).toBe(state.webContentsId);
    expect(await present(refreshed)).toMatchObject({ ok: true, surface: { visible: true } });
  });
});

describe("native browser user commands and state", () => {
  it("returns accidental parked native focus to the visible host without pausing agent control", async () => {
    await create();
    nativePage().focused = true;
    nativePage().emit("focus");
    expect(owner.contents.focus).toHaveBeenCalledTimes(1);
    expect(deps.userFocus).not.toHaveBeenCalled();
  });

  it("returns retained parked focus when its native owner becomes active", async () => {
    await create();
    owner.focused = false;
    nativePage().focused = true;
    nativePage().emit("focus");
    expect(owner.contents.focus).not.toHaveBeenCalled();
    owner.focused = true;
    owner.emit("focus");
    expect(owner.contents.focus).toHaveBeenCalledTimes(1);
    expect(deps.userFocus).not.toHaveBeenCalled();
  });

  it("returns native focus from a presented page when the host document reloads", async () => {
    await present(await create());
    nativePage().focused = true;
    owner.contents.emit("did-start-navigation", {}, "http://localhost/", false, true);
    expectParkedPage();
    expect(owner.contents.focus).toHaveBeenCalledTimes(1);
  });
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
    expect(nativePage().focus).not.toHaveBeenCalled();
  });

  it("marks explicit user focus before routing focus to a presented page", async () => {
    const state = await create();
    await present(state);
    await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId });
    expect(deps.userFocus).toHaveBeenCalledWith(state.webContentsId, true);
    expect(vi.mocked(deps.userFocus).mock.invocationCallOrder[0]).toBeLessThan(requiredValue(nativePage().focus.mock.invocationCallOrder[0], "page focus invocation"));
    expect(nativePage().focus).toHaveBeenCalledTimes(1);
  });

  it("reports actual focus only for the presented focused page in its focused owner", async () => {
    const state = await create();
    const page = nativePage();
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
    expect(nativePage().focus).not.toHaveBeenCalled();
    native.emulated = false;
    expect(await host.request(1, { action: "focus", tabId: state.tabId, webContentsId: state.webContentsId })).toEqual({ ok: false, error: "native-surface-unavailable" });
  });

  it("invalidates user control before allowed navigation and rejects unsafe URLs", async () => {
    const state = await create();
    const page = nativePage();
    expect(await host.request(1, { action: "navigate", tabId: state.tabId, webContentsId: state.webContentsId, url: "https://site.example/path" })).toMatchObject({ ok: true, surface: { url: "https://site.example/path" } });
    expect(deps.userNavigate).toHaveBeenCalledExactlyOnceWith(1, state.tabId);
    expect(vi.mocked(deps.userNavigate).mock.invocationCallOrder[0]).toBeLessThan(requiredValue(page.loadURL.mock.invocationCallOrder[1], "page navigation invocation"));
    for (const url of ["javascript:alert(1)", "file:///tmp/private", "https://user:secret@site.example/", "about:blank#script"]) {
      expect(await host.request(1, { action: "navigate", tabId: state.tabId, webContentsId: state.webContentsId, url })).toEqual({ ok: false, error: "bad-request" });
    }
    expect(deps.userNavigate).toHaveBeenCalledTimes(1);
    expect(page.loadURL).toHaveBeenCalledTimes(2);
  });

  it("handles navigation history, reload and explicit developer tools over the same page", async () => {
    const state = await create();
    const page = nativePage();
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
    const page = nativePage();
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
    const page = nativePage();
    expect(state.favicon).toBeNull();
    page.emit("page-favicon-updated", {}, ["https://site.example/icon.png", "data:image/png;base64,YQ=="]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: "data:image/png;base64,YQ==" }), state.tabId);
    page.emit("page-favicon-updated", {}, [`data:image/png;base64,${"A".repeat(BROWSER_NATIVE_FAVICON_MAX_LENGTH)}`, "data:image/png;base64,Yg=="]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: "data:image/png;base64,Yg==" }), state.tabId);
    page.emit("page-favicon-updated", {}, ["https://site.example/icon.png", "javascript:alert(1)", " data:image/png;base64,YQ=="]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, expect.objectContaining({ favicon: null }), state.tabId);
  });

  it("clears the old favicon when its main document starts navigating", async () => {
    const state = await create();
    const page = nativePage();
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
    expect(nativePage().close).toHaveBeenCalledTimes(1);
    expect(nativePage(1).close).not.toHaveBeenCalled();
    expect(vi.mocked(deps.changed).mock.calls.filter(([, surface, tabId]) => surface === null && tabId === state.tabId)).toHaveLength(1);
    expect(await present(state, 2)).toEqual({ ok: false, error: "stale-surface" });
  });

  it("retires unexpected page destruction and removes its listeners", async () => {
    const state = await create();
    await present(state);
    const page = nativePage();
    page.destroyed = true;
    page.emit("destroyed");
    expect(ownerChildren()).toEqual([]);
    expect(deps.changed).toHaveBeenLastCalledWith(1, null, state.tabId);
    expect(page.listenerCount("focus")).toBe(0);
    expect(page.listenerCount("cursor-changed")).toBe(0);
    expect(page.listenerCount("did-navigate")).toBe(0);
    expect(page.close).not.toHaveBeenCalled();
  });

  it("disposes every page of one owner while preserving another window", async () => {
    await create();
    await create("browser:other");
    const other = await create("browser:second-window", 2);
    host.disposeWindow(1);
    expect(nativePage().close).toHaveBeenCalledTimes(1);
    expect(nativePage(1).close).toHaveBeenCalledTimes(1);
    expect(nativePage(2).close).not.toHaveBeenCalled();
    expect(owner.listenerCount("show")).toBe(0);
    expect(await host.request(2, { action: "reload", tabId: other.tabId, webContentsId: other.webContentsId })).toMatchObject({ ok: true });
    host.dispose();
    expect(nativePage(2).close).toHaveBeenCalledTimes(1);
    expect(await host.request(2, { action: "create", tabId: "browser:late" })).toEqual({ ok: false, error: "native-surface-unavailable" });
  });
});
