import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { installBrowserNativeInput } from "../browser-native-input.js";
import { CURSOR_IMAGE_DATA_URL } from "../../__tests__/support/cursor-image.js";

const { send, states } = vi.hoisted(() => ({ send: vi.fn(), states: new Map<string, (event: unknown, value: unknown) => void>() }));
vi.mock("electron", () => ({ ipcRenderer: { send,
  on: (channel: string, handler: (event: unknown, value: unknown) => void) => states.set(channel, handler),
  removeListener: (channel: string) => states.delete(channel),
} }));
const IDENTITY = { tabId: "browser:one", webContentsId: 9, epoch: 3 };

function hostDocument() {
  const handlers = new Map<string, (event: MouseEvent | WheelEvent) => void>();
  let hit: string | null = JSON.stringify(IDENTITY);
  const cursor = { style: { cursor: "default" }, getAttribute: () => JSON.stringify(IDENTITY) };
  const document = {
    elementFromPoint: vi.fn(() => hit === null ? null : ({ closest: () => ({ getAttribute: () => hit }) })),
    documentElement: { clientHeight: 800 },
    querySelectorAll: () => [cursor],
    addEventListener: (name: string, handler: (event: MouseEvent | WheelEvent) => void) => handlers.set(name, handler),
    removeEventListener: (name: string) => handlers.delete(name),
  };
  const stop = installBrowserNativeInput(document as unknown as Document);
  const event = (type: string, patch: Record<string, unknown> = {}) => {
    const value = { type, isTrusted: true, clientX: 200, clientY: 250, button: 0, buttons: type === "mouseup" ? 0 : 1,
      detail: 1, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...patch };
    handlers.get(type)?.(value as unknown as MouseEvent);
    return value;
  };
  return { event, handlers, stop, cursor, hit: (value: string | null) => { hit = value; } };
}

beforeEach(() => { send.mockReset(); states.clear(); });

describe("trusted native page holes", () => {
  it("forwards a trusted hit and suppresses the host pointer default", () => {
    const host = hostDocument();
    const event = host.event("mousedown", { shiftKey: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(CHANNELS.browser.nativeInput, {
      ...IDENTITY, sequence: 1, type: "mouseDown", x: 200, y: 250, button: "left", clickCount: 1, modifiers: ["shift", "leftbuttondown"],
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    host.stop();
    expect(host.handlers.size).toBe(0);
  });

  it("does not forward synthetic events, UI hits, or malformed hole identities", () => {
    const host = hostDocument();
    expect(host.event("mousedown", { isTrusted: false }).preventDefault).not.toHaveBeenCalled();
    host.hit(null);
    expect(host.event("mousedown").preventDefault).not.toHaveBeenCalled();
    host.hit(JSON.stringify({ ...IDENTITY, privileged: true }));
    host.event("mousedown");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a page gesture through release over UI, then restores UI handling", () => {
    const host = hostDocument();
    host.event("mousedown");
    host.hit(null);
    host.event("mousemove", { clientX: 10 });
    host.event("mouseup", { clientX: 10 });
    expect(send.mock.calls.map(call => call[1].type)).toEqual(["mouseDown", "mouseMove", "mouseUp"]);
    expect(host.event("mousemove").preventDefault).not.toHaveBeenCalled();
    expect(send.mock.calls.map(call => call[1].type)).toEqual(["mouseDown", "mouseMove", "mouseUp", "mouseLeave"]);
  });

  it("clears an abandoned gesture before the next UI press", () => {
    const host = hostDocument();
    host.event("mousedown");
    host.hit(null);
    expect(host.event("mousedown").preventDefault).not.toHaveBeenCalled();
    host.event("mousemove");
    expect(send.mock.calls.map(call => call[1].type)).toEqual(["mouseDown", "mouseLeave"]);
  });

  it.each([[0, 1], [1, 16], [2, 800]])("converts DOM wheel unit %s into native direction", (deltaMode, unit) => {
    const host = hostDocument();
    const event = host.event("wheel", { deltaMode, deltaX: 2, deltaY: 3, buttons: 0 });
    expect(send).toHaveBeenLastCalledWith(CHANNELS.browser.nativeInput, expect.objectContaining({ type: "mouseWheel", deltaX: -2 * unit, deltaY: -3 * unit }));
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("leaves keyboard, composition, drag and host context menus in their native route", () => {
    const host = hostDocument();
    for (const type of ["keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "dragstart", "drop"]) {
      expect(host.handlers.has(type)).toBe(false);
    }
    host.hit(null);
    expect(host.event("contextmenu").preventDefault).not.toHaveBeenCalled();
    host.hit(JSON.stringify(IDENTITY));
    expect(host.event("contextmenu").preventDefault).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("releases host UI input immediately when native capture is cancelled", () => {
    const host = hostDocument();
    host.event("mousedown");
    const state = states.get(CHANNELS.browser.nativeInputState);
    expect(state).toBeDefined();
    state?.({}, { ...IDENTITY, type: "cancel", sequence: 1 });
    host.hit(null);
    expect(host.event("mousemove").preventDefault).not.toHaveBeenCalled();
    expect(host.event("mouseup").preventDefault).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not cancel a newer press when an old native cancellation arrives", () => {
    const host = hostDocument();
    host.event("mousedown");
    host.event("mousedown");
    states.get(CHANNELS.browser.nativeInputState)?.({}, { ...IDENTITY, type: "cancel", sequence: 1 });
    host.hit(null);
    expect(host.event("mousemove").preventDefault).toHaveBeenCalledOnce();
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ type: "mouseMove", sequence: 3 });
  });

  it("sends a passive leave when a menu covers the previously hovered page", () => {
    const host = hostDocument();
    host.event("mousemove", { buttons: 0 });
    host.hit(null);
    expect(host.event("mousemove", { buttons: 0 }).preventDefault).not.toHaveBeenCalled();
    expect(send.mock.calls.map(call => call[1].type)).toEqual(["mouseMove", "mouseLeave"]);
  });

  it("never acquires a host tab or resize drag after it crosses the page", () => {
    const host = hostDocument();
    host.hit(null);
    host.event("mousedown");
    host.hit(JSON.stringify(IDENTITY));
    expect(host.event("mousemove", { buttons: 1 }).preventDefault).not.toHaveBeenCalled();
    expect(host.event("mouseup").preventDefault).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    host.event("mousemove", { buttons: 0 });
    expect(send).toHaveBeenCalledExactlyOnceWith(CHANNELS.browser.nativeInput, expect.objectContaining({ type: "mouseMove", modifiers: [] }));
  });

  it("clears page hover when the pointer leaves the host window", () => {
    const host = hostDocument();
    host.event("mousemove", { buttons: 0 });
    host.event("mouseleave", { buttons: 0 });
    expect(send.mock.calls.map(call => call[1].type)).toEqual(["mouseMove", "mouseLeave"]);
  });

  it("mirrors only validated cursors for the current native identity", () => {
    const host = hostDocument();
    const state = states.get(CHANNELS.browser.nativeInputState);
    state?.({}, { ...IDENTITY, type: "cursor", cursor: "text" });
    expect(host.cursor.style.cursor).toBe("text");
    state?.({}, { ...IDENTITY, epoch: 1, type: "cursor", cursor: "pointer" });
    expect(host.cursor.style.cursor).toBe("text");
    expect(() => state?.({}, { ...IDENTITY, type: "cursor", cursor: "url(file:///private/cursor.png)" })).toThrow("invalid-native-browser-input-state");
    state?.({}, { ...IDENTITY, type: "custom-cursor", dataUrl: CURSOR_IMAGE_DATA_URL, width: 1, height: 1, hotspot: { x: 0, y: 0 } });
    expect(host.cursor.style.cursor).toBe(`url("${CURSOR_IMAGE_DATA_URL}") 0 0, auto`);
  });
});
