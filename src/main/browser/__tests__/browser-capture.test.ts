import { describe, expect, it, vi } from "vitest";
import { captureBrowserPage } from "../browser-capture.js";
import type { CdpSession } from "../browser-action-guard.js";

function image(width: number, height: number): string {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header);
  header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header.toString("base64");
}
function fixture(width = 800, height = 2400) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Runtime.evaluate") return {};
    if (method === "Page.getLayoutMetrics") return {
      cssContentSize: { x: 0, y: 0, width, height },
      cssVisualViewport: { pageX: 10, pageY: 20, clientWidth: 800, clientHeight: 600 },
    };
    const clip = params?.clip as { width: number; height: number; scale: number } | undefined;
    if (!clip) {
      const { default: sharp } = await import("sharp");
      return { data: (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64") };
    }
    return { data: image(Math.floor(clip.width * clip.scale), Math.floor(clip.height * clip.scale)) };
  });
  const cdp: CdpSession = { send, onEvent: () => () => {} };
  return { cdp, send, signal: new AbortController().signal };
}

describe("browser capture", () => {
  it("captures the full content without scrolling and reports its dimensions", async () => {
    const { cdp, send, signal } = fixture();
    expect(await captureBrowserPage(cdp, signal, { fullPage: true })).toMatchObject({
      width: 800, height: 2400, originalWidth: 800, originalHeight: 2400, scale: 1, truncated: false,
    });
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width: 800, height: 2400, scale: 1 },
    });
  });
  it("captures the scrolled viewport by default", async () => {
    const { cdp, send, signal } = fixture();
    expect(await captureBrowserPage(cdp, signal)).toMatchObject({ width: 800, height: 600 });
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  });
  it("uses native viewport readback without waiting for absent animation frames", async () => {
    const { cdp, send, signal } = fixture();
    const { default: sharp } = await import("sharp");
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64");
    await captureBrowserPage(cdp, signal, {}, 1, 1000, async () => ({ data }));
    expect(send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
    expect(send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
  });
  it("reduces oversized pages proportionally under the pixel limit", async () => {
    const { cdp, signal } = fixture(8000, 16000);
    expect(await captureBrowserPage(cdp, signal, { fullPage: true })).toMatchObject({
      width: 4000, height: 8000, originalWidth: 8000, originalHeight: 16000, scale: 0.5, truncated: false,
    });
  });
  it("normalizes the capture scale for native pixel density", async () => {
    const { cdp, send, signal } = fixture();
    await captureBrowserPage(cdp, signal, { fullPage: true }, 2.5);
    expect(send.mock.lastCall?.[1]?.clip).toMatchObject({ scale: 0.4 });
  });
  it("bounds layout waits as well as PNG encoding", async () => {
    const { cdp, signal } = fixture();
    vi.spyOn(cdp, "send").mockImplementation(() => new Promise(() => {}));
    await expect(captureBrowserPage(cdp, signal, {}, 1, 20)).rejects.toMatchObject({ code: "screenshot-timeout" });
  });
  it("cancels a pending capture without waiting for its deadline", async () => {
    const { cdp } = fixture();
    vi.spyOn(cdp, "send").mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = captureBrowserPage(cdp, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
  it.each([[0, 200], [100, 0], [Infinity, 20], [NaN, 20]])("rejects invalid layout %s by %s", async (width, height) => {
    const { cdp, signal } = fixture(width, height);
    await expect(captureBrowserPage(cdp, signal, { fullPage: true })).rejects.toMatchObject({ code: "screenshot-unavailable" });
  });
  it("rejects an invalid PNG before returning it", async () => {
    const { cdp, signal, send } = fixture();
    send.mockImplementation(async (method) => method === "Page.getLayoutMetrics"
      ? { cssContentSize: { x: 0, y: 0, width: 800, height: 2400 } }
      : { data: "invalid" });
    await expect(captureBrowserPage(cdp, signal, { fullPage: true })).rejects.toMatchObject({ code: "screenshot-failed" });
  });
});
