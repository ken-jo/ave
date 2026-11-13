import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import sharp from "sharp";
import { BrowserWorkspaceCapture } from "../browser-workspace-capture.js";
import { ownsPageSession } from "../browser-action-guard.js";
import { startBrowserPreview } from "../../browser-observation-preview.js";
import { deferred } from "../../../__tests__/support/deferred.js";

const { writeImage, display } = vi.hoisted(() => ({ writeImage: vi.fn(async () => {}), display: { scaleFactor: 1 } }));
vi.mock("electron", () => ({
  clipboard: { write: writeImage },
  ClipboardItem: class { constructor(readonly items: unknown) {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
  BrowserWindow: { fromWebContents: () => null },
  screen: { getPrimaryDisplay: () => display },
}));

const TARGET = { tabId: "browser:capture", documentGeneration: 1 };
function fixture() {
  writeImage.mockClear();
  display.scaleFactor = 1;
  let generation = 1, zoom = 1;
  let visible = true, live = true;
  const sendCommand = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: 800, height: 4000 }, cssVisualViewport: { pageX: 10, pageY: 500, clientWidth: 800, clientHeight: 600 } };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
    if (method === "Runtime.callFunctionOn") return {};
    throw new Error(`Unexpected capture command: ${method}`);
  });
  const capturePage = vi.fn(async () => {
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 40, g: 160, b: 80 } } }).png().toBuffer();
    return { getSize: () => ({ width: 800, height: 600 }), isEmpty: () => false, toPNG: () => image };
  });
  const attach = vi.fn(), detach = vi.fn();
  const guest = { id: 7, isDestroyed: () => false, getZoomFactor: () => zoom, capturePage, debugger: { isAttached: () => true, attach, detach, sendCommand } } as unknown as WebContents;
  const capture = new BrowserWorkspaceCapture({
    liveTab: (windowId, tabId) => live && windowId === 1 && tabId === TARGET.tabId ? { guest, documentGeneration: generation } : null,
    isWindowVisible: () => visible,
  });
  return { capture, guest, sendCommand, capturePage, attach, detach, setGeneration: (value: number) => { generation = value; }, setZoom: (value: number) => { zoom = value; }, setVisible: (value: boolean) => { visible = value; }, setLive: (value: boolean) => { live = value; } };
}

describe("user browser capture boundary", () => {
  it("does not turn a user capture's attached debugger into an agent preview session", async () => {
    const { capture, guest, sendCommand, capturePage, attach, detach } = fixture();
    expect(guest.debugger.isAttached()).toBe(true);
    expect(ownsPageSession(guest)).toBe(false);
    await expect(capture.capture(1, TARGET)).resolves.toMatchObject({ ...TARGET, width: 800, height: 600 });
    expect(capturePage).toHaveBeenCalledOnce();
    expect(writeImage).toHaveBeenCalledOnce();
    expect(ownsPageSession(guest)).toBe(false);
    expect(() => startBrowserPreview(guest, { frame: vi.fn(), updating: vi.fn(), ended: vi.fn(), isBlank: () => false }))
      .toThrow("agent's page session");
    expect(sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Page.getLayoutMetrics", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.callFunctionOn", "Page.getLayoutMetrics",
    ]);
    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("maps a user area to device-scaled bitmap rows without trusting the 1x image tag", async () => {
    const { capture, capturePage } = fixture();
    display.scaleFactor = 2;
    const pixels = Buffer.alloc(1600 * 1200 * 3);
    for (let row = 0; row < 1200; row += 1) for (let column = 0; column < 1600; column += 1) {
      const offset = (row * 1600 + column) * 3;
      const color = row < 160 ? [51, 85, 170] : [0, 166, 90];
      pixels[offset] = color[0] ?? 0; pixels[offset + 1] = color[1] ?? 0; pixels[offset + 2] = color[2] ?? 0;
    }
    const png = await sharp(pixels, { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer();
    capturePage.mockImplementation(async () => ({ getSize: () => ({ width: 1600, height: 1200 }), isEmpty: () => false, toPNG: () => png }));
    const result = await capture.capture(1, { ...TARGET, clip: { x: 30, y: 100, width: 160, height: 100 } });
    const decoded = await sharp(Buffer.from(result.dataUrl.split(",")[1] ?? "", "base64")).raw().toBuffer();
    expect(result).toMatchObject({ width: 160, height: 100 });
    expect([...decoded.subarray(0, 3)]).toEqual([0, 166, 90]);
    expect(writeImage).toHaveBeenCalledTimes(1);
  });

  it("rejects a display-density change during readback without writing the clipboard", async () => {
    const { capture, capturePage } = fixture();
    const original = capturePage.getMockImplementation();
    if (!original) throw new Error("Missing capture implementation");
    capturePage.mockImplementation(async () => {
      const image = await original();
      display.scaleFactor = 2;
      return image;
    });
    await expect(capture.capture(1, TARGET)).rejects.toThrow("stale-document");
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("converts viewport clips to document CSS coordinates and copies only the revalidated image", async () => {
    const { capture, sendCommand, capturePage, attach, detach } = fixture();
    const result = await capture.capture(1, { ...TARGET, clip: { x: 20, y: 30, width: 200, height: 100 } });
    expect(capturePage).toHaveBeenCalledExactlyOnceWith(undefined, { stayHidden: true, stayAwake: false });
    expect(sendCommand.mock.calls.map(([method]) => method)).not.toContain("Page.captureScreenshot");
    expect(result).toMatchObject({ ...TARGET, width: 200, height: 100, truncated: false });
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    const image = await sharp(Buffer.from(result.dataUrl.split(",")[1] ?? "", "base64")).metadata();
    expect(image).toMatchObject({ width: 200, height: 100 });
    expect(writeImage).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled(); expect(detach).not.toHaveBeenCalled();
  });

  it("rejects a wrong window, stale generation, hidden window and out-of-viewport selection", async () => {
    const { capture, sendCommand, setVisible } = fixture();
    await expect(capture.capture(2, TARGET)).rejects.toThrow("no-such-tab");
    await expect(capture.capture(1, { ...TARGET, documentGeneration: 2 })).rejects.toThrow("stale-document");
    setVisible(false);
    await expect(capture.capture(1, TARGET)).rejects.toThrow("window-hidden");
    expect(sendCommand).not.toHaveBeenCalled();
    setVisible(true);
    await expect(capture.capture(1, { ...TARGET, clip: { x: 750, y: 0, width: 100, height: 100 } })).rejects.toThrow("bad-request");
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("rechecks document identity after layout and does not dispatch screenshot after navigation", async () => {
    const { capture, sendCommand, setGeneration } = fixture();
    sendCommand.mockImplementationOnce(async () => { setGeneration(2); return {}; });
    await expect(capture.capture(1, TARGET)).rejects.toThrow("stale-document");
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("rejects a zoom change after capture before writing the clipboard", async () => {
    const { capture, capturePage, setZoom } = fixture();
    const original = capturePage.getMockImplementation();
    if (!original) throw new Error("Missing capture implementation");
    capturePage.mockImplementation(async () => {
      const result = await original();
      setZoom(1.25);
      return result;
    });
    await expect(capture.capture(1, TARGET)).rejects.toThrow("stale-document");
    expect(writeImage).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores capture-owned scroll after zoom changes only on the same document (replacement=%s)", async (replacement) => {
    const { capture, guest, sendCommand, setZoom, setGeneration } = fixture();
    let pageY = 2;
    sendCommand.mockImplementation(async (method, params) => {
      if (method === "Page.getLayoutMetrics") return {
        cssContentSize: { x: 0, y: 0, width: 4, height: 10 },
        cssVisualViewport: { pageX: 0, pageY, clientWidth: 4, clientHeight: 4 },
      };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
      if (method === "Runtime.callFunctionOn") {
        const values = (params as { arguments: Array<{ value: unknown }> }).arguments;
        pageY = Number(values[1]?.value);
        if (pageY === 4) {
          setZoom(1.25);
          if (replacement) setGeneration(2);
        }
        return {};
      }
      throw new Error(`Unexpected capture command: ${method}`);
    });
    await expect(capture.capture(1, { ...TARGET, fullPage: true })).rejects.toThrow("stale-document");
    expect(pageY).toBe(replacement ? 4 : 2);
    expect(guest.getZoomFactor()).toBe(1.25);
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("keeps one capture per window and aborts it when the window is invalidated", async () => {
    const { capture, sendCommand } = fixture();
    let finish!: (value: unknown) => void;
    sendCommand.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = capture.capture(1, TARGET);
    await expect(capture.capture(1, TARGET)).rejects.toThrow("capture-busy");
    capture.invalidateWindow(1);
    await expect(pending).rejects.toThrow("stale-document");
    finish({});
    expect(writeImage).not.toHaveBeenCalled();
  });

  it.each([false, true])("bounds user-area preparation and stops late readback (cancelled=%s)", async (cancelled) => {
    const { capture, sendCommand, capturePage } = fixture();
    const entered = deferred<void>(), response = deferred<unknown>();
    sendCommand.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    vi.useFakeTimers();
    try {
      const pending = capture.capture(1, { ...TARGET, clip: { x: 0, y: 0, width: 10, height: 10 } }, 20);
      const rejected = expect(pending).rejects.toThrow(cancelled ? "stale-document" : "capture-unavailable");
      await entered.promise;
      expect(vi.getTimerCount()).toBe(1);
      if (cancelled) capture.invalidateWindow(1); else await vi.advanceTimersByTimeAsync(21);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      response.resolve({});
      await vi.advanceTimersByTimeAsync(1);
      expect(capturePage).not.toHaveBeenCalled();
      expect(writeImage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
