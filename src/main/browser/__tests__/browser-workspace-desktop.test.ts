import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceServiceDeps } from "../browser-workspace.js";

const native = vi.hoisted(() => ({
  windows: [] as unknown[], session: {}, deps: null as BrowserWorkspaceServiceDeps | null,
  template: [] as Array<{ label?: string; enabled?: boolean; click?: () => void }>,
  showMessageBox: vi.fn(async (_window: unknown, _options: unknown) => ({ response: 1 })),
  popup: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  observeGuest: vi.fn((_windowId: number, _guest: unknown) => vi.fn()), observeDownload: vi.fn(),
  invalidateWindow: vi.fn(), disposeWindow: vi.fn(), dispose: vi.fn(),
}));
const observeAgentDownload = vi.hoisted(() => vi.fn());
vi.mock("../../browser-observation.js", () => ({ observeAgentBrowserDownload: observeAgentDownload }));
vi.mock("electron", () => ({
  dialog: { showMessageBox: native.showMessageBox },
  session: { fromPartition: () => native.session },
  Menu: { buildFromTemplate: (template: typeof native.template) => { native.template = template; return { popup: native.popup }; } },
}));
vi.mock("../../app-state.js", () => ({ getMainWindows: () => native.windows }));
vi.mock("../../../i18n/index.js", () => ({ t: (key: string) => key }));
vi.mock("../browser-workspace.js", () => ({
  createBrowserWorkspaceService: (deps: BrowserWorkspaceServiceDeps) => { native.deps = deps; return workspace; },
}));

import { browserTabRegistry } from "../browser-tab-registry.js";
import {
  browserWorkspaceGuestWindowId, disposeBrowserWorkspaceService, getBrowserWorkspaceService,
  observeBrowserWorkspaceDownload, observeBrowserWorkspaceGuest, refreshBrowserPopupControl, registerBrowserWorkspacePopup,
} from "../browser-workspace-desktop.js";

class Guest extends EventEmitter {
  readonly session = native.session;
  readonly debugger = new EventEmitter();
  destroyed = false;
  focused = false;
  constructor(private readonly guestId: number, public url = "https://site.example/", public title = "Site") { super(); }
  get id() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.guestId;
  }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isFocused() { return this.focused; }
  focus() { this.focused = true; this.emit("focus"); }
}
class Window extends EventEmitter {
  destroyed = false;
  visible = true;
  minimized = false;
  focused = false;
  readonly setTitle = vi.fn();
  constructor(private readonly windowId: number, private readonly contents: Guest) { super(); }
  get id() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.windowId;
  }
  get webContents(): Guest {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.contents;
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isFocused() { return this.focused; }
  restore() { this.minimized = false; }
  show() { this.visible = true; }
  focus() { this.focused = true; this.emit("focus"); }
  close() { this.contents.destroyed = true; this.contents.emit("destroyed"); this.destroyed = true; this.emit("closed"); }
}
const asGuest = (guest: Guest) => guest as unknown as WebContents;
const asWindow = (window: Window) => window as unknown as BrowserWindow;

beforeEach(() => { vi.clearAllMocks(); native.windows = []; native.deps = null; native.template = []; });
afterEach(() => { disposeBrowserWorkspaceService(); browserTabRegistry.__reset(); vi.useRealTimers(); });

function owner() {
  const window = new Window(1, new Guest(1));
  native.windows.push(window);
  return window;
}
async function ownedPage(window: Window) {
  let requestId = "";
  browserTabRegistry.setRendererLink({ sendTabOp: (_id, request) => { requestId = request.requestId; return true; }, sendControl: refreshBrowserPopupControl });
  const pending = browserTabRegistry.requestTabOp(window.id, { op: "new", url: "https://site.example/", actor: { sessionId: "parent" } });
  const guest = new Guest(71, "about:blank");
  browserTabRegistry.guestAttached(asGuest(guest), window.id);
  browserTabRegistry.bindTab(window.id, { tabId: "page", webContentsId: guest.id, requestId });
  await pending;
  guest.url = "https://site.example/";
  observeBrowserWorkspaceGuest(asGuest(guest), asWindow(window));
  return guest;
}

describe("browser workspace desktop composition", () => {
  it("creates one lazy service and resolves only same-window embedded renderer tabs", async () => {
    expect(native.deps).toBeNull();
    const window = owner();
    const guest = await ownedPage(window);
    const first = getBrowserWorkspaceService();
    expect(getBrowserWorkspaceService()).toBe(first);
    expect(native.deps!.liveTab(1, "page")).toMatchObject({ guest, documentGeneration: browserTabRegistry.liveRendererTab(1, "page")!.documentId });
    expect(native.deps!.liveTab(2, "page")).toBeNull();
    expect(native.deps!.liveTab(1, "tab-1")).toBeNull();
    expect(native.deps!.listTabs(1)[0]).toMatchObject({ tabId: "page", url: "https://site.example/" });
    expect(native.deps!.fullscreenAvailable(1)).toBe(false);
    window.minimized = true;
    expect(native.deps!.isWindowVisible(1)).toBe(false);
  });

  it("adds lifecycle observation once and disposes hidden/closed window resources", () => {
    const window = owner();
    const guest = new Guest(71);
    const existing = vi.fn(); guest.on("did-navigate", existing);
    observeBrowserWorkspaceGuest(asGuest(guest), asWindow(window));
    observeBrowserWorkspaceGuest(asGuest(guest), asWindow(window));
    expect(workspace.observeGuest).toHaveBeenCalledTimes(1);
    guest.emit("did-navigate");
    expect(existing).toHaveBeenCalledOnce();
    expect(browserWorkspaceGuestWindowId(asGuest(guest))).toBe(1);
    const item = {} as Parameters<typeof observeBrowserWorkspaceDownload>[1];
    observeBrowserWorkspaceDownload(asGuest(guest), item);
    expect(workspace.observeDownload).toHaveBeenCalledWith(1, item);
    expect(observeAgentDownload).toHaveBeenCalledWith(guest, item);
    window.emit("hide"); window.emit("minimize");
    expect(workspace.invalidateWindow.mock.calls).toEqual([[1], [1]]);
    expect(() => window.close()).not.toThrow();
    expect(workspace.disposeWindow).toHaveBeenCalledWith(1);
    expect(browserWorkspaceGuestWindowId(asGuest(guest))).toBeNull();
    expect(window.listenerCount("hide")).toBe(0);
    expect(workspace.observeGuest.mock.results[0]!.value).toHaveBeenCalledOnce();
  });

  it("does not forward downloads from guests outside the owned browser workspace", () => {
    const guest = new Guest(72);
    const item = {} as Parameters<typeof observeBrowserWorkspaceDownload>[1];
    observeBrowserWorkspaceDownload(asGuest(guest), item);
    expect(workspace.observeDownload).not.toHaveBeenCalled();
    expect(observeAgentDownload).not.toHaveBeenCalled();
  });

  it("disposes a destroyed guest by its captured identity and permits a replacement", () => {
    const window = owner();
    const guest = new Guest(71);
    observeBrowserWorkspaceGuest(asGuest(guest), asWindow(window));
    const stopObserving = workspace.observeGuest.mock.results[0]!.value;
    guest.destroyed = true;
    expect(() => guest.id).toThrow(TypeError);
    expect(() => guest.emit("destroyed")).not.toThrow();
    expect(stopObserving).toHaveBeenCalledOnce();
    const replacement = new Guest(71);
    observeBrowserWorkspaceGuest(asGuest(replacement), asWindow(window));
    expect(workspace.observeGuest).toHaveBeenCalledTimes(2);
    expect(browserWorkspaceGuestWindowId(asGuest(replacement))).toBe(1);
  });

  it("uses a trusted owning-window dialog and rejects a hidden or replaced owner after its await", async () => {
    const window = owner();
    getBrowserWorkspaceService();
    const request = { windowId: 1, origin: "https://site.example", permissions: ["camera" as const] };
    expect(await native.deps!.promptPermission(request)).toBe(true);
    expect(native.showMessageBox.mock.calls[0]![0]).toBe(window);
    expect(native.showMessageBox.mock.calls[0]![1]).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    let finish!: (result: { response: number }) => void;
    native.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = native.deps!.promptPermission(request);
    window.visible = false;
    finish({ response: 1 });
    expect(await pending).toBe(false);
    expect(await native.deps!.promptPermission(request)).toBe(false);
  });

  it("rejects unowned guests and fully disposes before any workspace snapshot was requested", () => {
    const window = owner();
    const guest = new Guest(71);
    expect(() => observeBrowserWorkspaceGuest(asGuest(guest), asWindow(new Window(2, new Guest(2))))).toThrow("browser-guest-owner-mismatch");
    observeBrowserWorkspaceGuest(asGuest(guest), asWindow(window));
    disposeBrowserWorkspaceService();
    expect(workspace.disposeWindow).toHaveBeenCalledWith(1);
    expect(workspace.dispose).toHaveBeenCalledOnce();
    expect(browserWorkspaceGuestWindowId(asGuest(guest))).toBeNull();
  });
});

describe("native popup desktop controls", () => {
  it("keeps explicit native handle, focus proof, trusted title and user-only pause/resume menu", async () => {
    const window = owner();
    const opener = await ownedPage(window);
    const popup = new Window(2, new Guest(72));
    const handle = registerBrowserWorkspacePopup(opener.id, asWindow(popup), asWindow(window))!;
    observeBrowserWorkspaceGuest(asGuest(popup.webContents), asWindow(window));
    expect(browserTabRegistry.liveTab(handle)).toMatchObject({ rendererTabId: null, windowId: 1, targetKind: "popup" });
    await expect(browserTabRegistry.requestTabOp(1, { op: "select", tabId: handle, actor: { sessionId: "parent" } })).resolves.toEqual({ ok: true, tabId: handle });
    expect(popup.isFocused() && popup.webContents.isFocused()).toBe(true);
    const titleEvent = { preventDefault: vi.fn() };
    popup.emit("page-title-updated", titleEvent, "Unsafe\n\u202eTitle", true);
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce();
    expect(popup.setTitle).toHaveBeenLastCalledWith("Ave · browserWorkspace.mode.human · UnsafeTitle");
    const tab = browserTabRegistry.liveTab(handle)!;
    browserTabRegistry.acquireControl(tab, { sessionId: "parent" });
    popup.webContents.emit("context-menu", { preventDefault: vi.fn() }, { x: 3, y: 4 });
    expect(native.template[0]).toMatchObject({ label: "agentBrowser.stop", enabled: true });
    native.template[0]!.click!();
    expect(tab.controlMode).toBe("human-paused");
    expect(popup.setTitle.mock.calls.at(-1)![0]).toContain("browserWorkspace.mode.human-paused");
    popup.webContents.emit("context-menu", { preventDefault: vi.fn() }, { x: 3, y: 4 });
    expect(native.template[0]!.label).toBe("agentBrowser.resume");
    native.template[0]!.click!();
    expect(tab.controlMode).toBe("agent-active");
    expect(native.popup).toHaveBeenCalledWith({ window: popup, x: 3, y: 4 });
    const popupGuest = popup.webContents;
    popup.close();
    expect(popup.listenerCount("page-title-updated")).toBe(0);
    expect(popupGuest.listenerCount("context-menu")).toBe(0);
  });

  it("completes registered native close without reading a destroyed window's guest getter", async () => {
    const window = owner();
    const opener = await ownedPage(window);
    const popupGuest = new Guest(72);
    const popup = new Window(2, popupGuest);
    const handle = registerBrowserWorkspacePopup(opener.id, asWindow(popup), asWindow(window))!;
    await expect(browserTabRegistry.requestTabOp(window.id, { op: "close", tabId: handle })).resolves.toEqual({ ok: true, tabId: handle });
    expect(() => popup.webContents).toThrow("Object has been destroyed");
    expect(browserTabRegistry.liveTab(handle)).toBeUndefined();
    expect(popupGuest.listenerCount("context-menu")).toBe(0);
    expect(popup.listenerCount("page-title-updated")).toBe(0);
    expect(window.isDestroyed()).toBe(false);
    expect(() => disposeBrowserWorkspaceService()).not.toThrow();
  });

  it("rejects pending focus and removes its listeners when the native window is already destroyed", async () => {
    const window = owner();
    const opener = await ownedPage(window);
    const popupGuest = new Guest(72);
    popupGuest.focus = () => undefined;
    const popup = new Window(2, popupGuest);
    const handle = registerBrowserWorkspacePopup(opener.id, asWindow(popup), asWindow(window))!;
    const selected = browserTabRegistry.requestTabOp(window.id, { op: "select", tabId: handle });
    popup.destroyed = true;
    expect(() => popup.emit("closed")).not.toThrow();
    await expect(selected).resolves.toEqual({ ok: false, error: "native-operation-failed" });
    expect(popupGuest.listenerCount("focus")).toBe(0);
    expect(popupGuest.listenerCount("destroyed")).toBe(1);
  });

  it("fails native selection when window focus does not reach the popup's own guest", async () => {
    vi.useFakeTimers();
    const window = owner();
    const opener = await ownedPage(window);
    const popup = new Window(2, new Guest(72));
    popup.webContents.focus = () => undefined;
    const handle = registerBrowserWorkspacePopup(opener.id, asWindow(popup), asWindow(window))!;
    const selected = browserTabRegistry.requestTabOp(1, { op: "select", tabId: handle });
    await vi.advanceTimersByTimeAsync(750);
    await expect(selected).resolves.toEqual({ ok: false, error: "native-operation-failed" });
  });
});
