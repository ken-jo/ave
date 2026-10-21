import type { NativeImage, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspacePreview } from "../browser-workspace-preview.js";

function image(bytes = 100): NativeImage {
  const value = { getSize: () => ({ width: 1920, height: 1080 }), isEmpty: () => false, resize: vi.fn(() => value), toJPEG: () => Buffer.alloc(bytes) };
  return value as unknown as NativeImage;
}
function setup() {
  let visible = true;
  let generation = 1;
  let live = true;
  let at = 1000;
  const capturePage = vi.fn(async () => image());
  const focus = vi.fn(); const loadURL = vi.fn();
  const guest = { id: 7, capturePage, focus, loadURL, isDestroyed: () => false } as unknown as WebContents;
  const preview = new BrowserWorkspacePreview({ liveTab: (windowId, tabId) => live && windowId === 1 && tabId.startsWith("browser:") ? { guest, documentGeneration: generation } : null, isWindowVisible: () => visible, now: () => at });
  return { preview, guest, capturePage, focus, loadURL, setVisible: (value: boolean) => { visible = value; }, setGeneration: (value: number) => { generation = value; }, setLive: (value: boolean) => { live = value; }, advance: (ms: number) => { at += ms; } };
}
const TARGET = { tabId: "browser:one", documentGeneration: 1 };

describe("browser preview capture", () => {
  it("captures a compressed bounded thumbnail without showing, focusing or navigating its guest", async () => {
    const { preview, capturePage, focus, loadURL } = setup();
    const result = await preview.capture(1, TARGET);
    expect(capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true, stayAwake: false });
    expect(result.width).toBe(320); expect(result.height).toBe(180);
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(focus).not.toHaveBeenCalled(); expect(loadURL).not.toHaveBeenCalled();
    await preview.capture(1, TARGET);
    expect(capturePage).toHaveBeenCalledTimes(1);
  });
  it("does no native capture for hidden, stale, missing or cross-window requests", async () => {
    const { preview, capturePage, setVisible } = setup();
    setVisible(false);
    await expect(preview.capture(1, TARGET)).rejects.toThrow("window-hidden");
    setVisible(true);
    await expect(preview.capture(2, TARGET)).rejects.toThrow("no-such-tab");
    await expect(preview.capture(1, { ...TARGET, documentGeneration: 2 })).rejects.toThrow("stale-document");
    expect(capturePage).not.toHaveBeenCalled();
  });
  it("allows only one in-flight capture per window and throttles a different card", async () => {
    const { preview, capturePage, advance } = setup();
    let finish!: (value: NativeImage) => void;
    capturePage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = preview.capture(1, TARGET);
    await expect(preview.capture(1, { ...TARGET, tabId: "browser:two" })).rejects.toThrow("capture-busy");
    finish(image()); await pending;
    await expect(preview.capture(1, { ...TARGET, tabId: "browser:two" })).rejects.toThrow("capture-throttled");
    advance(1500);
    await preview.capture(1, { ...TARGET, tabId: "browser:two" });
    expect(capturePage).toHaveBeenCalledTimes(2);
  });
  it("discards late bytes after a hide followed by show, navigation, or close", async () => {
    for (const change of ["hide", "navigation", "close"] as const) {
      const { preview, capturePage, setVisible, setGeneration, setLive } = setup();
      let finish!: (value: NativeImage) => void;
      capturePage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const pending = preview.capture(1, TARGET);
      if (change === "hide") { setVisible(false); preview.invalidateWindow(1); setVisible(true); }
      if (change === "navigation") setGeneration(2);
      if (change === "close") setLive(false);
      finish(image());
      await expect(pending).rejects.toThrow("stale-document");
    }
  });
  it("rejects over-limit image bytes and evicts the bounded document cache", async () => {
    const { preview, capturePage, advance } = setup();
    capturePage.mockResolvedValueOnce(image(256_001));
    await expect(preview.capture(1, TARGET)).rejects.toThrow("capture-unavailable");
    for (let i = 0; i < 17; i++) { advance(1500); await preview.capture(1, { ...TARGET, tabId: `browser:${i}` }); }
    advance(1500);
    await preview.capture(1, { ...TARGET, tabId: "browser:0" });
    expect(capturePage).toHaveBeenCalledTimes(19);
  });
});
