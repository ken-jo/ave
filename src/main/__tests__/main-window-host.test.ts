import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class Contents extends EventEmitter {
    destroyed = false;
    readonly loadURL = vi.fn(async () => {});
    readonly loadFile = vi.fn(async () => {});
    readonly close = vi.fn((_options?: unknown) => {});
    zoomFactor = 1.2;
    readonly getZoomFactor = vi.fn(() => this.zoomFactor);
    styleId = 0;
    readonly insertCSS = vi.fn(async (_css: string): Promise<string> => `style-${++this.styleId}`);
    readonly removeInsertedCSS = vi.fn(async (_key: string) => {});
    isDestroyed() { return this.destroyed; }
  }
  class View {
    readonly children: View[] = [];
    nativeClosed = false;
    closeNativeView() { this.nativeClosed = true; for (const child of this.children) child.closeNativeView(); }
    readonly setBackgroundColor = vi.fn();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    readonly setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
    getBounds() { return this.bounds; }
    addChildView(view: View) {
      const old = this.children.indexOf(view);
      if (old >= 0) this.children.splice(old, 1);
      this.children.push(view);
    }
  }
  class Window extends EventEmitter {
    readonly contentView = new View();
    destroyed = false;
    bounds = { width: 1360, height: 800 };
    constructor(readonly options: unknown) { super(); }
    getContentBounds() { return this.bounds; }
    fullscreen = false;
    isFullScreen() { return this.fullscreen; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.contentView.closeNativeView(); this.emit("closed"); }
  }
  class ContentsView extends View {
    private readonly contents = new Contents();
    get webContents(): Contents { return this.nativeClosed ? undefined as unknown as Contents : this.contents; }
    constructor(readonly options: unknown) { super(); }
  }
  return { Window, View, ContentsView };
});
vi.mock("../webview-attach.js", () => ({ configureMainWindowWebviewAttach: vi.fn(() => ({ owner: null, result: "refused" })) }));
vi.mock("electron", () => ({ BaseWindow: native.Window, WebContentsView: native.ContentsView }));

import { attachMainWindowPage, closeMainWindowDocuments, closeMainWindowUi, createMainWindowHost, mainWindowFromNativeWindow, mainWindowUiOrigin, refreshMainWindowUiLayout } from "../main-window-host.js";
import { computeMainWindowUiBounds } from "../main-window-bounds.js";

function create() { return createMainWindowHost({ show: false, focusable: false }, { zoomFactor: 1.2 }); }
function ui(window: ReturnType<typeof create>) { return window.contentView.children.at(-1) as unknown as InstanceType<typeof native.ContentsView>; }

describe("main window composition", () => {
  const realPlatform = process.platform;
  beforeEach(() => Object.defineProperty(process, "platform", { value: "darwin", configurable: true }));
  afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }));
  it("creates a transparent UI view and exposes only its explicit document", async () => {
    const window = create();
    expect(window).toBeInstanceOf(native.Window);
    expect(ui(window).setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(ui(window).options).toMatchObject({ webPreferences: { contextIsolation: true, zoomFactor: 1.2, sandbox: false, preload: expect.stringMatching(/preload\.cjs$/) } });
    expect((window as unknown as InstanceType<typeof native.Window>).options).toEqual({ show: false, focusable: false });
    expect(window.webContents).toBe(ui(window).webContents);
    await window.loadURL("about:blank");
    await window.loadFile("index.html", { query: { role: "secondary" } });
    expect(ui(window).webContents.loadURL).toHaveBeenCalledWith("about:blank");
    expect(ui(window).webContents.loadFile).toHaveBeenCalledWith("index.html", { query: { role: "secondary" } });
  });
  it("keeps the UI above every page when pages are attached or reattached", () => {
    const window = create(), overlay = ui(window);
    const a = new native.View(), b = new native.View();
    attachMainWindowPage(window, a as never);
    attachMainWindowPage(window, b as never);
    attachMainWindowPage(window, a as never);
    expect(window.contentView.children).toEqual([b, a, overlay]);
    expect(mainWindowFromNativeWindow(window)).toBe(window);
    expect(mainWindowFromNativeWindow(new native.Window({}) as never)).toBeNull();
    expect(() => attachMainWindowPage(new native.Window({}) as never, a as never)).toThrow("Main window UI view unavailable");
  });
  it("resizes the inset UI without changing page placement", () => {
    const window = create(), overlay = ui(window);
    expect(overlay.setBounds).toHaveBeenLastCalledWith(computeMainWindowUiBounds({ width: 1360, height: 800 }, process.platform, false));
    (window as unknown as InstanceType<typeof native.Window>).bounds = { width: 900, height: 800 };
    window.emit("resize");
    expect(overlay.setBounds).toHaveBeenLastCalledWith(computeMainWindowUiBounds({ width: 900, height: 800 }, process.platform, false));
  });
  it("updates bounds and document compensation on every native state transition", async () => {
    const window = create(), overlay = ui(window);
    const nativeWindow = window as unknown as InstanceType<typeof native.Window>;
    for (const [event, width, height, fullscreen] of [
      ["resize", 950, 734, false], ["maximize", 1920, 1080, false], ["unmaximize", 950, 734, false],
      ["restore", 950, 734, false],
      ["enter-full-screen", 1920, 1080, true], ["leave-full-screen", 950, 734, false],
    ] as const) {
      nativeWindow.bounds = { width, height };
      nativeWindow.fullscreen = fullscreen;
      window.emit(event);
      const expected = computeMainWindowUiBounds({ width, height }, process.platform, fullscreen);
      expect(overlay.getBounds()).toEqual(expected);
      expect(mainWindowUiOrigin(window)).toEqual({ x: expected.x, y: expected.y });
      expect(overlay.webContents.insertCSS).toHaveBeenLastCalledWith(`:root { --native-window-inset: ${expected.x / 1.2}px; }`);
    }
    await Promise.resolve();
  });
  it("reinstalls compensation on navigation and keeps the strip fixed when zoom changes", async () => {
    const window = create(), contents = ui(window).webContents;
    await Promise.resolve();
    const calls = contents.insertCSS.mock.calls.length;
    contents.emit("dom-ready");
    expect(contents.insertCSS).toHaveBeenCalledTimes(calls + 1);
    contents.zoomFactor = 2;
    refreshMainWindowUiLayout(window);
    const origin = mainWindowUiOrigin(window);
    expect(contents.insertCSS).toHaveBeenLastCalledWith(`:root { --native-window-inset: ${origin.x / 2}px; }`);
    expect(mainWindowUiOrigin(new native.Window({}) as never)).toEqual({ x: 0, y: 0 });
    await Promise.resolve();
  });
  it("removes a stale stylesheet when zoom updates finish out of order", async () => {
    const window = create(), contents = ui(window).webContents;
    await Promise.resolve();
    let finishStyle = (_key: string): void => { throw new Error("Missing stylesheet insertion"); };
    contents.insertCSS.mockImplementationOnce(() => new Promise<string>((resolve) => { finishStyle = resolve; }));
    contents.zoomFactor = 2;
    refreshMainWindowUiLayout(window);
    contents.zoomFactor = 3;
    refreshMainWindowUiLayout(window);
    await Promise.resolve();
    finishStyle("stale-style");
    await vi.waitFor(() => expect(contents.removeInsertedCSS).toHaveBeenCalledWith("stale-style"));
    expect(contents.insertCSS).toHaveBeenLastCalledWith(`:root { --native-window-inset: ${mainWindowUiOrigin(window).x / 3}px; }`);
  });
  it("waits for document unload and destroys the native window only after it closes", () => {
    const window = create(), contents = ui(window).webContents;
    closeMainWindowUi(window);
    expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: true });
    expect(window.isDestroyed()).toBe(false);
    contents.destroyed = true;
    contents.emit("destroyed");
    expect(window.isDestroyed()).toBe(true);
    expect(contents.close).toHaveBeenCalledTimes(1);
    expect(mainWindowFromNativeWindow(window)).toBeNull();
  });
  it("awaits UI unload before the shutdown stage completes", async () => {
    const window = create(), contents = ui(window).webContents;
    let completed = false;
    const closing = closeMainWindowDocuments([window], new AbortController().signal).then(() => { completed = true; });
    expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    const preventDefault = vi.fn();
    contents.emit("will-prevent-unload", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    contents.destroyed = true;
    contents.emit("destroyed");
    await closing;
    expect(completed).toBe(true);
    expect(contents.listenerCount("will-prevent-unload")).toBe(0);
  });
  it("releases shutdown waiters when its bounded stage aborts", async () => {
    const window = create(), contents = ui(window).webContents;
    const controller = new AbortController();
    const closing = closeMainWindowDocuments([window], controller.signal);
    controller.abort();
    await expect(closing).rejects.toThrow("Main window document close aborted");
    expect(contents.listenerCount("will-prevent-unload")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(1);
  });
  it("disposes its document on forced native teardown", () => {
    const window = create(), view = ui(window), contents = view.webContents;
    window.destroy();
    expect(view.webContents).toBeUndefined();
    expect(contents.close).toHaveBeenCalledWith();
    expect(() => closeMainWindowUi(window)).toThrow("Main window UI view unavailable");
  });
});
