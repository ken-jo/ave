import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const native = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromWebContents: vi.fn(),
  getDisplayMatching: vi.fn(),
  getPrimaryDisplay: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromId: native.fromId, fromWebContents: native.fromWebContents },
  screen: { getDisplayMatching: native.getDisplayMatching, getPrimaryDisplay: native.getPrimaryDisplay },
}));

import { browserTabRegistry } from "../browser-tab-registry.js";
import { browserGuestOwnerWindow } from "../browser-guest-owner.js";
import { browserCapturePixelRatio } from "../browser-capture-desktop.js";

beforeEach(() => {
  vi.resetAllMocks();
  browserTabRegistry.__reset();
});
afterEach(() => browserTabRegistry.__reset());

describe("browser page owner window", () => {
  it("uses logical ownership and its display density while a native view is detached", () => {
    const bounds = { x: 1600, y: 0, width: 1000, height: 700 };
    const owner = { id: 7, getBounds: () => bounds };
    const page = { id: 81, isDestroyed: () => false } as WebContents;
    browserTabRegistry.guestAttached(page, owner.id, { kind: "native-view" });
    native.fromId.mockReturnValue(owner);
    native.fromWebContents.mockReturnValue(null);
    native.getDisplayMatching.mockReturnValue({ scaleFactor: 2 });
    native.getPrimaryDisplay.mockReturnValue({ scaleFactor: 1 });

    expect(browserGuestOwnerWindow(page)).toBe(owner);
    expect(browserCapturePixelRatio(page)).toBe(2);
    expect(native.fromId).toHaveBeenCalledWith(7);
    expect(native.getDisplayMatching).toHaveBeenCalledWith(bounds);
    expect(native.fromWebContents).not.toHaveBeenCalled();
    expect(native.getPrimaryDisplay).not.toHaveBeenCalled();
  });

  it("does not replace a retired logical owner with a stale native association", () => {
    const page = { id: 82, isDestroyed: () => false } as WebContents;
    browserTabRegistry.guestAttached(page, 8, { kind: "native-view" });
    native.fromId.mockReturnValue(null);
    native.fromWebContents.mockReturnValue({ id: 9 });
    expect(browserGuestOwnerWindow(page)).toBeNull();
    expect(native.fromWebContents).not.toHaveBeenCalled();
  });

  it("resolves an unmanaged embedded page through its host", () => {
    const host = { id: 90 };
    const page = { id: 83, hostWebContents: host } as WebContents;
    const owner = { id: 9 };
    native.fromWebContents.mockReturnValue(owner);
    expect(browserGuestOwnerWindow(page)).toBe(owner);
    expect(native.fromWebContents).toHaveBeenCalledWith(host);
  });
});
