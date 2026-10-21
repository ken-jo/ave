import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  guestAttached: vi.fn(), guestDestroyed: vi.fn(), userInput: vi.fn(), documentChanged: vi.fn(), navigationStarted: vi.fn(),
}));
vi.mock("../browser-tab-registry.js", () => ({
  browserTabRegistry: registry,
  isUserActionInputType: (type: string) => ["keyDown", "rawKeyDown", "char", "mouseDown", "mouseWheel"].includes(type),
}));
import { trackBrowserGuest } from "../browser-guest-tracking.js";

function guest() {
  return Object.assign(new EventEmitter(), { id: 71, debugger: new EventEmitter() });
}

beforeEach(() => vi.clearAllMocks());

describe("native browser guest tracking", () => {
  it("forwards press provenance and release delivery while ignoring passive movement", () => {
    const contents = guest();
    trackBrowserGuest(contents as unknown as WebContents, 3);
    expect(registry.guestAttached).toHaveBeenCalledWith(contents, 3);
    const input = { type: "keyDown", _modifiers: 1 << 23 };
    contents.emit("before-input-event", {}, input);
    contents.emit("before-mouse-event", {}, { type: "mouseMove", _modifiers: 0 });
    const released = { type: "mouseUp", _modifiers: 1 << 23 };
    contents.emit("before-mouse-event", {}, released);
    const touch = { type: "touchStart", _modifiers: 1 << 23 };
    contents.emit("input-event", {}, touch);
    expect(registry.userInput.mock.calls).toEqual([[71, input], [71, released], [71, touch]]);
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
