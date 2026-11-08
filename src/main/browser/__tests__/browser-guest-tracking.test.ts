import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  guestAttached: vi.fn(), guestDestroyed: vi.fn(), userInput: vi.fn(), documentChanged: vi.fn(), navigationStarted: vi.fn(), metadataChanged: vi.fn(),
}));
vi.mock("../browser-tab-registry.js", () => ({
  browserTabRegistry: registry,
  isUserActionInputType: (type: string) => ["keyDown", "rawKeyDown", "char", "mouseDown", "mouseWheel"].includes(type),
}));
import { preserveBrowserGuestZoom, setBrowserGuestZoomFactor, trackBrowserGuest } from "../browser-guest-tracking.js";

function guest() {
  return Object.assign(new EventEmitter(), { id: 71, debugger: new EventEmitter(), session: {}, getURL: (): string => "https://a.example/", isDestroyed: () => false, getZoomFactor: vi.fn(() => 1), setZoomFactor: vi.fn() });
}

beforeEach(() => vi.clearAllMocks());

describe("native browser guest tracking", () => {
  it("publishes committed navigation and title changes, excluding subframe routes", () => {
    const contents = guest();
    trackBrowserGuest(contents as unknown as WebContents, 3);
    contents.emit("did-navigate", {}, "https://example.com/");
    contents.emit("page-title-updated", {}, "Example");
    contents.emit("did-navigate-in-page", {}, "https://example.com/#route", true);
    contents.emit("did-navigate-in-page", {}, "https://frame.example/", false);
    expect(registry.metadataChanged.mock.calls).toEqual([[71], [71], [71]]);
  });
  it("forwards raw mouse receipts once with original coordinates while ignoring their normalized copies", () => {
    const contents = guest();
    trackBrowserGuest(contents as unknown as WebContents, 3);
    expect(registry.guestAttached).toHaveBeenCalledWith(contents, 3);
    const input = { type: "keyDown", _modifiers: 1 << 23 };
    contents.emit("before-input-event", {}, input);
    contents.emit("before-mouse-event", {}, { type: "mouseMove", _modifiers: 0 });
    const pressed = { type: "mouseDown", x: 93, y: 197, button: "left", clickCount: 1 };
    contents.emit("before-mouse-event", {}, pressed);
    contents.emit("input-event", {}, pressed);
    const released = { ...pressed, type: "mouseUp" };
    contents.emit("before-mouse-event", {}, released);
    contents.emit("input-event", {}, released);
    const wheel = { type: "mouseWheel", _modifiers: 1 << 23 };
    contents.emit("input-event", {}, wheel);
    const touch = { type: "touchStart", _modifiers: 1 << 23 };
    contents.emit("input-event", {}, touch);
    expect(registry.userInput.mock.calls).toEqual([[71, input], [71, pressed], [71, released], [71, wheel], [71, touch]]);
  });

  it("invalidates only new main documents and observes native destruction once", () => {
    const contents = guest();
    trackBrowserGuest(contents as unknown as WebContents, 3);
    contents.emit("did-start-navigation", {}, "https://a.example/subframe", false, false);
    contents.emit("did-start-navigation", {}, "https://a.example/#fragment", true, true);
    contents.emit("did-start-navigation", {}, "https://a.example/next", false, true);
    expect(registry.navigationStarted.mock.calls).toEqual([[71, "https://a.example/next"]]);
    contents.debugger.emit("message", {}, "Page.loadEventFired");
    contents.debugger.emit("message", {}, "DOM.documentUpdated");
    expect(registry.documentChanged.mock.calls).toEqual([[71]]);
    contents.emit("destroyed");
    contents.emit("destroyed");
    expect(registry.guestDestroyed.mock.calls).toEqual([[71]]);
  });
});

it("restores browser site zoom on attach, app zoom changes, and site navigation", () => {
 const contents = guest();
 let factor = 0.58;
 let url = "https://a.example/";
 contents.getURL = () => url;
 contents.getZoomFactor.mockImplementation(() => factor);
 contents.setZoomFactor.mockImplementation((next: number) => { factor = next; });
 const native = contents as unknown as WebContents;
 trackBrowserGuest(native, 3);
 expect(factor).toBe(1);
 setBrowserGuestZoomFactor(native, 1.25);
 preserveBrowserGuestZoom(() => { factor = 1.728; });
 expect(factor).toBe(1.25);
 url = "https://b.example/";
 contents.emit("did-navigate");
 expect(factor).toBe(1);
 setBrowserGuestZoomFactor(native, 1.5);
 url = "https://a.example/back";
 factor = 0.58;
 contents.emit("did-finish-load");
 expect(factor).toBe(1.25);
 const appFrame = { setZoomFactor: vi.fn() };
 preserveBrowserGuestZoom(() => {});
 expect(appFrame.setZoomFactor).not.toHaveBeenCalled();
 contents.emit("destroyed");
 contents.setZoomFactor.mockClear();
 preserveBrowserGuestZoom(() => {});
 expect(contents.setZoomFactor).not.toHaveBeenCalled();
});
