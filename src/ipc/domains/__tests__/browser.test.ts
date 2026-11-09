import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../../contract/app-contract.js";
import { hostFrameEvent, isolatedAppFrameEvent } from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("../../../main/browser/browser-workspace-desktop.js", () => ({
  getBrowserWorkspaceService: () => ({ onChanged: vi.fn() }),
  refreshBrowserPopupControl: vi.fn(),
  disposeBrowserWorkspaceService: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const windowSender = { id: 500 };
vi.mock("../../../main/app-state.js", () => ({
  getMainWindows: () => [],
  getPrimaryMainWindow: () => null,
  mainWindowForContents: (contents: unknown) => (contents === windowSender ? { id: 7 } : null),
}));

const { registerBrowserHandlers, parseActiveSurface } = await import("../browser.js");
const { browserTabRegistry } = await import("../../../main/browser/browser-tab-registry.js");

function fromWindow(): IpcMainInvokeEvent {
  return { ...hostFrameEvent(), sender: windowSender } as unknown as IpcMainInvokeEvent;
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
});

describe("browser IPC", () => {
  it("refuses a non-host frame on every invoke", () => {
    for (const channel of [CHANNELS.browser.bindTab, CHANNELS.browser.stop, CHANNELS.browser.pause, CHANNELS.browser.resume, CHANNELS.browser.getState,
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
