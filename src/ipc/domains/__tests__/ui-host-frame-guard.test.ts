// Native context menus must use the shared host-renderer sender guard.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeRegisteredHandlerWithEvent } from "../../../__tests__/test-helpers.js";

const DYNAMIC_CHANNEL = "ave:ui:dynamic-menu";
const NATIVE_CHANNEL = "ave:ui:native-context-menu";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const popup = vi.fn();
const fakeWindow = { isDestroyed: () => false };
const registeredUiContents = new Set<unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup })) },
}));

vi.mock("../../../main/app-state.js", () => ({
  mainWindowForContents: (contents: unknown) => registeredUiContents.has(contents) ? fakeWindow : null,
}));

vi.mock("../../../i18n/index.js", () => ({ t: (key: string) => key }));

function uiEvent(frameUrl: string) {
  const sender = { getURL: () => frameUrl, isDestroyed: () => false, send: vi.fn() };
  registeredUiContents.add(sender);
  return {
    senderFrame: { url: frameUrl },
    sender,
  };
}

const dynamicPayload = {
  requestId: "req-1",
  x: 10,
  y: 20,
  sections: [{ items: [{ id: "persona:default", label: "Default", checked: true }] }],
};

const nativePayload = {
  requestId: "req-2",
  x: 10,
  y: 20,
  kind: "message",
  commands: ["message.copy"],
};

async function setup() {
  handlers.clear();
  registeredUiContents.clear();
  vi.clearAllMocks();
  const { registerUiHandlers } = await import("../ui.js");
  registerUiHandlers({ auditLogger: { log: vi.fn() } } as never);
}

type Reply = { ok: boolean; error?: string };

function invoke(channel: string, frameUrl: string, payload: unknown): Reply {
  return invokeRegisteredHandlerWithEvent<Reply>(handlers, channel, uiEvent(frameUrl), payload);
}

describe("UI context-menu channels — host renderer frames only", () => {
  beforeEach(async () => {
    await setup();
  });

  it("refuses a isolated app-resource frame on both channels", () => {
    const shell = "ave-mcp-app://s-66697874757265/proxy.html?t=fixture";
    expect(invoke(DYNAMIC_CHANNEL, shell, dynamicPayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(invoke(NATIVE_CHANNEL, shell, nativePayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(popup).not.toHaveBeenCalled();
  });

  it("serves the host renderer even when its URL mentions the shell filename", () => {
    const hostLookalike = "file:///dist/src/index.html?next=plugin-ui-shell.html";
    expect(invoke(DYNAMIC_CHANNEL, hostLookalike, dynamicPayload)).toEqual({ ok: true });
    expect(invoke(NATIVE_CHANNEL, hostLookalike, nativePayload)).toEqual({ ok: true });
    expect(popup).toHaveBeenCalledTimes(2);
  });

  it("serves the ordinary host renderer", () => {
    const host = "file:///dist/src/index.html";
    expect(invoke(DYNAMIC_CHANNEL, host, dynamicPayload)).toEqual({ ok: true });
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it("refuses an unregistered renderer even when its document URL matches the host", () => {
    const event = uiEvent("file:///dist/src/index.html");
    registeredUiContents.delete(event.sender);
    expect(invokeRegisteredHandlerWithEvent(handlers, DYNAMIC_CHANNEL, event, dynamicPayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(invokeRegisteredHandlerWithEvent(handlers, NATIVE_CHANNEL, event, nativePayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(popup).not.toHaveBeenCalled();
  });

  it("refuses a remote origin frame", () => {
    expect(invoke(DYNAMIC_CHANNEL, "https://evil.example.com/", dynamicPayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(popup).not.toHaveBeenCalled();
  });
});
