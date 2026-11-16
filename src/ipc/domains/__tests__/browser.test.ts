import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../../contract/app-contract.js";
import { hostFrameEvent, isolatedAppFrameEvent } from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("../../../main/browser/browser-workspace-desktop.js", () => ({
  getBrowserWorkspaceService: () => ({ onChanged: vi.fn(), tabsChanged: vi.fn() }),
  refreshBrowserPopupControl: vi.fn(),
  disposeBrowserWorkspaceService: vi.fn(),
}));

const liveContents = new Map<number, unknown>();
const browserProfile = vi.hoisted(() => ({ profile: "browser" }));
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => liveContents.get(id) },
  session: { fromPartition: () => browserProfile },
  ipcMain: {
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const windowFrame = { url: "file:///Applications/Ave.app/dist/index.html" };
const windowSender = { id: 500, mainFrame: windowFrame };
vi.mock("../../../main/app-state.js", () => ({
  getMainWindows: () => [],
  getPrimaryMainWindow: () => null,
  mainWindowForContents: (contents: unknown) => (contents === windowSender ? { id: 7 } : null),
}));

const { registerBrowserHandlers, parseActiveSurface } = await import("../browser.js");
const { browserTabRegistry } = await import("../../../main/browser/browser-tab-registry.js");
const { BrowserNativeSurfaceHost } = await import("../../../main/browser/browser-native-surfaces.js");

function fromWindow(): IpcMainInvokeEvent {
  return { ...hostFrameEvent(), sender: windowSender, senderFrame: windowFrame } as unknown as IpcMainInvokeEvent;
}

function invoke(channel: string, event: IpcMainInvokeEvent, payload: unknown): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn(event, payload);
}

const auditLogger = { log: vi.fn() };

beforeEach(() => {
  handlers.clear();
  browserTabRegistry.__reset();
  registerBrowserHandlers({ auditLogger } as never);
});

afterEach(() => {
  browserTabRegistry.__reset();
  liveContents.clear();
  vi.useRealTimers();
});

/** A page guest of the sender window that main may not have registered yet. */
function hostedGuest(id: number, url: string) {
  const guest = Object.assign(new EventEmitter(), { id, url, destroyed: false, hostWebContents: windowSender, session: browserProfile, getType: () => "webview",
    isDestroyed() { return this.destroyed; }, getURL() { return this.url; }, getTitle: () => "Page" });
  liveContents.set(id, guest);
  return guest;
}

describe("browser IPC", () => {
  it("routes private pointer input only from the owning top-level UI with a validated envelope", () => {
    const input = vi.spyOn(BrowserNativeSurfaceHost.prototype, "input").mockReturnValue(true);
    const payload = { tabId: "native", webContentsId: 43, epoch: 2, sequence: 1, type: "mouseDown", x: 100, y: 150,
      button: "left", clickCount: 1, modifiers: [] };
    try {
      invoke(CHANNELS.browser.nativeInput, isolatedAppFrameEvent(), payload);
      invoke(CHANNELS.browser.nativeInput, hostFrameEvent(), payload);
      invoke(CHANNELS.browser.nativeInput, { ...fromWindow(), senderFrame: { url: windowFrame.url } } as unknown as IpcMainInvokeEvent, payload);
      invoke(CHANNELS.browser.nativeInput, fromWindow(), { ...payload, ownerWindowId: 8 });
      invoke(CHANNELS.browser.nativeInput, fromWindow(), { ...payload, type: "keyDown" });
      expect(input).not.toHaveBeenCalled();
      invoke(CHANNELS.browser.nativeInput, fromWindow(), payload);
      expect(input).toHaveBeenCalledExactlyOnceWith(7, payload);
    } finally { input.mockRestore(); }
  });

  it("refuses a non-host frame on every invoke", () => {
    for (const channel of [CHANNELS.browser.nativeSurface, CHANNELS.browser.bindTab, CHANNELS.browser.stop, CHANNELS.browser.pause, CHANNELS.browser.resume, CHANNELS.browser.getState,
      CHANNELS.browser.getSessionBindings, CHANNELS.surface.setActive]) {
      expect(invoke(channel, isolatedAppFrameEvent(), {})).toMatchObject({ ok: false, error: "unauthorized-frame" });
    }
  });

  it("reads only the sender window state and keeps popup handles out of embedded controls", () => {
    browserTabRegistry.guestAttached({ id: 41, isDestroyed: () => false, getURL: () => "https://a.example/", getTitle: () => "A" } as never, 7);
    invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:1", webContentsId: 41 });
    expect(invoke(CHANNELS.browser.getState, fromWindow(), undefined)).toMatchObject({ tabs: [expect.objectContaining({ rendererTabId: "browser:1" })] });
    expect(invoke(CHANNELS.browser.getState, fromWindow(), {})).toEqual({ ok: false, error: "bad-request" });
  });

  it("rejects malformed native requests and renderer rebinding of an independent page", () => {
    expect(invoke(CHANNELS.browser.nativeSurface, fromWindow(), { action: "create", tabId: "native", windowId: 8 }))
      .toEqual({ ok: false, error: "bad-request" });
    expect(invoke(CHANNELS.browser.nativeSurface, hostFrameEvent(), { action: "create", tabId: "native" }))
      .toEqual({ ok: false, error: "bad-request" });
    browserTabRegistry.guestAttached({ id: 43, isDestroyed: () => false, getURL: () => "about:blank", getTitle: () => "" } as never, 7, { kind: "native-view" });
    expect(invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "native", webContentsId: 43, parked: false }))
      .toEqual({ ok: false, error: "guest-not-hosted" });
    expect(browserTabRegistry.listTabs(7)).toEqual([]);
  });

  it("queries only session bindings of the sender window", () => {
    browserTabRegistry.bindConversationSurface("own", { windowId: 7, surface: { kind: "terminal", tabId: "terminal:one" } });
    browserTabRegistry.bindConversationSurface("other", { windowId: 8, surface: { kind: "terminal", tabId: "terminal:two" } });
    expect(invoke(CHANNELS.browser.getSessionBindings, fromWindow(), undefined)).toMatchObject({
      bindings: [{ sessionId: "own", browserTabIds: [], terminalTabIds: ["terminal:one"] }],
    });
    expect(invoke(CHANNELS.browser.getSessionBindings, fromWindow(), {})).toEqual({ ok: false, error: "bad-request" });
    expect(invoke(CHANNELS.browser.getSessionBindings, hostFrameEvent(), undefined)).toEqual({ ok: false, error: "bad-request" });
  });

  it("binds a tab to a guest attached to the sender's window only", () => {
    browserTabRegistry.guestAttached({ id: 41, isDestroyed: () => false, getURL: () => "https://a.example/", getTitle: () => "A" } as never, 7);
    browserTabRegistry.guestAttached({ id: 42, isDestroyed: () => false, getURL: () => "https://b.example/", getTitle: () => "B" } as never, 8);
    expect(invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:1", webContentsId: 41 })).toEqual({ ok: true });
    expect(invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:2", webContentsId: 42 }))
      .toEqual({ ok: false, error: "guest-not-hosted" });
    expect(invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "", webContentsId: 41 }))
      .toEqual({ ok: false, error: "bad-request" });
    expect(invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:1", webContentsId: 41, parked: "false" }))
      .toEqual({ ok: false, error: "bad-request" });
    expect(invoke(CHANNELS.browser.bindTab, hostFrameEvent(), { tabId: "browser:1", webContentsId: 41 }))
      .toEqual({ ok: false, error: "bad-request" });
    expect(browserTabRegistry.listTabs(7).map((tab) => tab.url)).toEqual(["https://a.example/"]);
  });

  it("answers a bind for a guest main has not yet seen attach once it attaches, with no timer", async () => {
    vi.useFakeTimers();
    const guest = hostedGuest(51, "https://a.example/");
    const bound = invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:early", webContentsId: 51 });
    expect(bound).toBeInstanceOf(Promise);
    expect(vi.getTimerCount()).toBe(0);
    browserTabRegistry.guestAttached(guest as never, 7);
    await expect(bound).resolves.toEqual({ ok: true });
    expect(browserTabRegistry.listTabs(7).map((tab) => tab.url)).toEqual(["https://a.example/"]);
    // A guest that ends before it attaches is answered as not live.
    const gone = hostedGuest(52, "https://b.example/");
    const refused = invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:gone", webContentsId: 52 });
    gone.destroyed = true;
    gone.emit("destroyed");
    await expect(refused).resolves.toEqual({ ok: false, error: "guest-not-live" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers at once for a guest main never registers: another profile's page or a guest that is not a page", () => {
    const otherProfile = Object.assign(hostedGuest(54, "https://a.example/"), { session: { profile: "other" } });
    const notPage = Object.assign(hostedGuest(55, "https://a.example/"), { getType: () => "window" });
    for (const guest of [otherProfile, notPage]) {
      expect(invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:x", webContentsId: guest.id })).toEqual({ ok: false, error: "guest-not-live" });
    }
  });

  it("answers a bind refused while the guest has no page yet once it commits its first page", async () => {
    vi.useFakeTimers();
    const guest = hostedGuest(53, "");
    browserTabRegistry.guestAttached(guest as never, 7);
    const bindTab = vi.spyOn(browserTabRegistry, "bindTab").mockReturnValueOnce({ ok: false, error: "guest-not-live" }).mockReturnValueOnce({ ok: true });
    try {
      const bound = invoke(CHANNELS.browser.bindTab, fromWindow(), { tabId: "browser:new", webContentsId: 53, requestId: "browser-op-1" });
      expect(bound).toBeInstanceOf(Promise);
      // A subframe's failure is not the page committing.
      guest.emit("did-fail-load", {}, -2, "FAILED", "https://frame.example/", false);
      expect(bindTab).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      guest.url = "about:blank";
      guest.emit("did-navigate", {}, "about:blank");
      await expect(bound).resolves.toEqual({ ok: true });
      expect(bindTab).toHaveBeenCalledTimes(2);
      expect(guest.listenerCount("did-navigate")).toBe(0);
    } finally {
      bindTab.mockRestore();
    }
  });

  it("accepts focus receipts only from the matching host window", () => {
    const payload = { requestId: "receipt", restored: true };
    expect(invoke(CHANNELS.browser.completeFocus, isolatedAppFrameEvent(), payload)).toEqual({ ok: false });
    expect(invoke(CHANNELS.browser.completeFocus, hostFrameEvent(), payload)).toEqual({ ok: false });
    expect(invoke(CHANNELS.browser.completeFocus, fromWindow(), { requestId: "receipt", restored: "true" })).toEqual({ ok: false });
    expect(invoke(CHANNELS.browser.completeFocus, fromWindow(), payload)).toEqual({ ok: false });
    const complete = vi.spyOn(browserTabRegistry, "completeFocus").mockReturnValue(true);
    expect(invoke(CHANNELS.browser.completeFocus, fromWindow(), payload)).toEqual({ ok: true });
    expect(complete).toHaveBeenCalledWith(7, "receipt", true);
    complete.mockRestore();
  });

  it("takes a renderer's refusal only from the host frame, for a request id it names", () => {
    expect(invoke(CHANNELS.browser.refuseTabOp, isolatedAppFrameEvent(), { requestId: "browser-op-1" })).toEqual({ ok: false });
    expect(invoke(CHANNELS.browser.refuseTabOp, fromWindow(), { requestId: "" })).toEqual({ ok: false });
    expect(invoke(CHANNELS.browser.refuseTabOp, fromWindow(), {})).toEqual({ ok: false });
    expect(invoke(CHANNELS.browser.refuseTabOp, hostFrameEvent(), { requestId: "browser-op-1" })).toEqual({ ok: false });
    const refuse = vi.spyOn(browserTabRegistry, "refuseTabOp").mockReturnValue(true);
    expect(invoke(CHANNELS.browser.refuseTabOp, fromWindow(), { requestId: "browser-op-1" })).toEqual({ ok: true });
    expect(refuse).toHaveBeenCalledWith(7, "browser-op-1");
    refuse.mockRestore();
  });

  it("sets and clears the window's active surface, refusing malformed payloads", () => {
    expect(invoke(CHANNELS.surface.setActive, fromWindow(), { kind: "terminal", tabId: "terminal:1" })).toEqual({ ok: true });
    expect(browserTabRegistry.getActiveSurface(7)).toEqual({ kind: "terminal", tabId: "terminal:1" });
    expect(invoke(CHANNELS.surface.setActive, fromWindow(), null)).toEqual({ ok: true });
    expect(browserTabRegistry.getActiveSurface(7)).toBeUndefined();
    expect(invoke(CHANNELS.surface.setActive, fromWindow(), { kind: "chat", tabId: "x" })).toEqual({ ok: false, error: "bad-request" });
  });

  it("parses the active-surface payload strictly", () => {
    expect(parseActiveSurface({ kind: "browser", tabId: "browser:1" })).toEqual({ kind: "browser", tabId: "browser:1" });
    expect(parseActiveSurface(null)).toBeNull();
    expect(parseActiveSurface({ kind: "browser" })).toBeUndefined();
    expect(parseActiveSurface("browser:1")).toBeUndefined();
  });
});
