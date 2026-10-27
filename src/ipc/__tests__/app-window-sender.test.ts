import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateAppWindowMainFrameSender } from "../app-window-sender.js";
import { validateHostRendererSender } from "../gated.js";

const nativeSession = vi.hoisted(() => ({ defaultSession: {} }));
vi.mock("electron", () => ({ session: nativeSession }));

beforeEach(() => {
  Object.defineProperty(nativeSession, "defaultSession", { value: {}, writable: true, configurable: true });
});

function appWindow() {
  const frame = { url: "file:///app/index.html", detached: false, isDestroyed: vi.fn(() => false) };
  const sender = { id: 7, isDestroyed: vi.fn(() => false), getType: vi.fn(() => "window"),
    session: nativeSession.defaultSession, mainFrame: frame };
  const window = { id: 11, isDestroyed: vi.fn(() => false), webContents: sender };
  const windows = [window];
  const deps = {
    getMainWindow: vi.fn(() => window as never),
    getAppWindows: vi.fn(() => windows as never),
  };
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { frame, sender, window, windows, deps, event };
}

describe("registered app window sender identity", () => {
  it("accepts the live registered default-session main frame", () => {
    const fixture = appWindow();
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(true);
  });

  it("accepts the registered main window through the single-window dependency", () => {
    const fixture = appWindow();
    expect(validateAppWindowMainFrameSender(fixture.event, { getMainWindow: fixture.deps.getMainWindow })).toBe(true);
  });

  it("keeps a registered plugin webview refused after its URL changes from shell HTML to script", () => {
    const fixture = appWindow();
    fixture.sender.getType.mockReturnValue("webview");
    fixture.frame.url = "file:///app/plugin-ui-shell.html";
    expect(validateHostRendererSender(fixture.event)).toBe(false);
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
    fixture.frame.url = "file:///app/plugin-ui-shell.js";
    expect(validateHostRendererSender(fixture.event)).toBe(true);
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it("refuses a registered window in a nondefault plugin session", () => {
    const fixture = appWindow();
    fixture.sender.session = { partition: "persist:plugin-example" };
    expect(validateHostRendererSender(fixture.event)).toBe(true);
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it("refuses a trusted-URL subframe of a registered window", () => {
    const fixture = appWindow();
    const event = { sender: fixture.sender, senderFrame: { ...fixture.frame } } as unknown as IpcMainInvokeEvent;
    expect(validateHostRendererSender(event)).toBe(true);
    expect(validateAppWindowMainFrameSender(event, fixture.deps)).toBe(false);
  });

  it("refuses an unregistered window even when getMainWindow names it", () => {
    const fixture = appWindow();
    fixture.windows.length = 0;
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it("does not mistake matching numeric identities for the registered contents object", () => {
    const fixture = appWindow();
    const stranger = { ...fixture.sender, mainFrame: { ...fixture.frame } };
    const event = { sender: stranger, senderFrame: stranger.mainFrame } as unknown as IpcMainInvokeEvent;
    expect(stranger.id).toBe(7);
    expect(fixture.window.webContents.id).toBe(7);
    expect(validateAppWindowMainFrameSender(event, fixture.deps)).toBe(false);
  });

  it.each(["window", "contents", "frame"] as const)("refuses a destroyed %s", (kind) => {
    const fixture = appWindow();
    const target = kind === "window" ? fixture.window : kind === "contents" ? fixture.sender : fixture.frame;
    target.isDestroyed.mockReturnValue(true);
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it("refuses a detached main frame", () => {
    const fixture = appWindow();
    fixture.frame.detached = true;
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it.each([null, undefined])("refuses an absent event: %s", (event) => {
    const fixture = appWindow();
    expect(validateAppWindowMainFrameSender(event, fixture.deps)).toBe(false);
  });

  it("retains the supplemental URL restriction for a registered main frame", () => {
    const fixture = appWindow();
    fixture.frame.url = "https://untrusted.example/index.html";
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it.each(["senderFrame", "mainFrame", "session", "defaultSession", "webContents", "detached"] as const)(
    "refuses uncertainty when the native %s getter throws", (property) => {
      const fixture = appWindow();
      const target = property === "senderFrame" ? fixture.event : property === "defaultSession" ? nativeSession
        : property === "webContents" ? fixture.window : property === "detached" ? fixture.frame : fixture.sender;
      Object.defineProperty(target, property, { configurable: true, get() { throw new Error("Native identity unavailable"); } });
      expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
    },
  );

  it("refuses uncertainty when the native contents type cannot be read", () => {
    const fixture = appWindow();
    fixture.sender.getType.mockImplementation(() => { throw new Error("Contents unavailable"); });
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
  });

  it("checks current window registration on every call", () => {
    const fixture = appWindow();
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(true);
    fixture.windows.length = 0;
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
    fixture.windows.push(fixture.window);
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(true);
  });

  it("checks the current default session rather than retaining its first identity", () => {
    const fixture = appWindow();
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(true);
    nativeSession.defaultSession = {};
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(false);
    fixture.sender.session = nativeSession.defaultSession;
    expect(validateAppWindowMainFrameSender(fixture.event, fixture.deps)).toBe(true);
  });
});
