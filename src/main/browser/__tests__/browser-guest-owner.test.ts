import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const native = vi.hoisted(() => ({
  windows: [] as unknown[],
  mainWindowForContents: vi.fn(),
  fromWebContents: vi.fn(),
  getDisplayMatching: vi.fn(),
  getPrimaryDisplay: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: native.fromWebContents },
  screen: { getDisplayMatching: native.getDisplayMatching, getPrimaryDisplay: native.getPrimaryDisplay },
}));

vi.mock("../../app-state.js", () => ({
  getMainWindows: () => native.windows, mainWindowForContents: native.mainWindowForContents,
}));

import { browserTabRegistry } from "../browser-tab-registry.js";
import { browserGuestOwnerWindow } from "../browser-guest-owner.js";
import { browserCapturePixelRatio } from "../browser-capture-desktop.js";

beforeEach(() => {
  vi.resetAllMocks();
  native.windows = [];
  browserTabRegistry.__reset();
});
afterEach(() => browserTabRegistry.__reset());

describe("browser page owner window", () => {
  it("uses logical ownership and its display density while a native view is detached", () => {
    const bounds = { x: 1600, y: 0, width: 1000, height: 700 };
    const owner = { id: 7, getBounds: () => bounds };
    const page = { id: 81, isDestroyed: () => false } as WebContents;
    browserTabRegistry.guestAttached(page, owner.id, { kind: "native-view" });
    native.windows = [owner];
    native.fromWebContents.mockReturnValue(null);
    native.getDisplayMatching.mockReturnValue({ scaleFactor: 2 });
    native.getPrimaryDisplay.mockReturnValue({ scaleFactor: 1 });

    expect(browserGuestOwnerWindow(page)).toBe(owner);
    expect(browserCapturePixelRatio(page)).toBe(2);
    expect(native.getDisplayMatching).toHaveBeenCalledWith(bounds);
    expect(native.fromWebContents).not.toHaveBeenCalled();
    expect(native.getPrimaryDisplay).not.toHaveBeenCalled();
  });

  it("does not replace a retired logical owner with a stale native association", () => {
    const page = { id: 82, isDestroyed: () => false } as WebContents;
    browserTabRegistry.guestAttached(page, 8, { kind: "native-view" });
    native.windows = [];
    native.fromWebContents.mockReturnValue({ id: 9 });
    expect(browserGuestOwnerWindow(page)).toBeNull();
    expect(native.fromWebContents).not.toHaveBeenCalled();
  });

  it("uses a registered popup's own 1x display while its parent remains on a 2x display", () => {
    const parentBounds = { x: 1600, y: 0, width: 1000, height: 700 };
    const popupBounds = { x: 0, y: 0, width: 600, height: 500 };
    const parentWindow = { id: 7, getBounds: () => parentBounds };
    const popupWindow = { id: 8, getBounds: () => popupBounds };
    const parent = {
      id: 85, isDestroyed: () => false, getURL: () => "https://parent.example/", getTitle: () => "Parent",
    } as WebContents;
    const popup = { id: 86, isDestroyed: () => false } as WebContents;
    browserTabRegistry.guestAttached(parent, parentWindow.id, { kind: "native-view" });
    expect(browserTabRegistry.bindTab(parentWindow.id, { tabId: "browser:parent", webContentsId: parent.id })).toEqual({ ok: true });
    expect(browserTabRegistry.registerPopup(parent.id, popup, { select: () => true, close: () => {} })).toBe("tab-2");
    expect(browserTabRegistry.guestWindowId(popup.id)).toBe(parentWindow.id);
    native.windows = [parentWindow];
    native.fromWebContents.mockImplementation(contents => contents === popup ? popupWindow : null);
    native.getDisplayMatching.mockImplementation(bounds => ({ scaleFactor: bounds === parentBounds ? 2 : 1 }));

    expect.soft(browserGuestOwnerWindow(popup)).toBe(popupWindow);
    expect.soft(browserCapturePixelRatio(popup)).toBe(1);
    expect(native.getDisplayMatching).toHaveBeenCalledWith(popupBounds);
    expect(browserCapturePixelRatio(parent)).toBe(2);
    expect(native.getDisplayMatching).toHaveBeenLastCalledWith(parentBounds);
    expect(native.getPrimaryDisplay).not.toHaveBeenCalled();
  });

  it("resolves an unmanaged embedded page through its host", () => {
    const host = { id: 90 };
    const page = { id: 83, hostWebContents: host } as WebContents;
    const owner = { id: 9 };
    native.fromWebContents.mockReturnValue(owner);
    expect(browserGuestOwnerWindow(page)).toBe(owner);
    expect(native.fromWebContents).toHaveBeenCalledWith(host);
  });

  it("resolves a legacy embedded page through its registered main UI", () => {
    const host = { id: 91 };
    const page = { id: 84, hostWebContents: host } as WebContents;
    const owner = { id: 10 };
    native.mainWindowForContents.mockReturnValue(owner);
    expect(browserGuestOwnerWindow(page)).toBe(owner);
    expect(native.mainWindowForContents).toHaveBeenCalledWith(host);
    expect(native.fromWebContents).not.toHaveBeenCalled();
  });
});
