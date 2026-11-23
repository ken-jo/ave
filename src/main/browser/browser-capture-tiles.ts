import { BROWSER_CAPTURE_LIMITS, type BrowserCaptureScroll, type BrowserViewportImage } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import { captureScrollContext, scrollBrowserCapture } from "./browser-capture-scroll.js";

/** Compose only the requested snapshot height. Sticky content is intentionally kept in every tile where it paints. */
export async function captureBrowserTiles(
  cdp: CdpSession, signal: AbortSignal, width: number, height: number,
  original: { pageX: number; pageY: number; clientWidth: number; clientHeight: number },
  captureViewport: () => Promise<BrowserViewportImage>,
  onRestore: (position: BrowserCaptureScroll) => void,
): Promise<{ data: string }> {
  const executionContextId = await captureScrollContext(cdp);
  throwIfAborted(signal);
  onRestore({ executionContextId, x: original.pageX, y: original.pageY });
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  throwIfAborted(signal);
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  let copied = 0;
  let initialScale: number | undefined;
  while (copied < height) {
    throwIfAborted(signal);
    await scrollBrowserCapture(cdp, { executionContextId, x: 0, y: copied });
    throwIfAborted(signal);
    const metrics = await cdp.send("Page.getLayoutMetrics") as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
    const viewport = metrics.cssVisualViewport;
    if (viewport.pageX !== 0 || viewport.clientWidth !== original.clientWidth || viewport.clientHeight !== original.clientHeight) throw new BrowserActionError("screenshot-unavailable", "the viewport changed during capture");
    const skip = copied - viewport.pageY;
    if (!Number.isFinite(skip) || !Number.isFinite(viewport.clientHeight) || skip < 0 || skip >= viewport.clientHeight) {
      throw new BrowserActionError("screenshot-unavailable", "the page did not scroll to the next capture area");
    }
    const tile = await captureViewport();
    throwIfAborted(signal);
    const current = await cdp.send("Page.getLayoutMetrics") as typeof metrics;
    throwIfAborted(signal);
    if (current.cssVisualViewport.pageX !== 0 || current.cssVisualViewport.clientWidth !== original.clientWidth || current.cssVisualViewport.clientHeight !== original.clientHeight
      || current.cssVisualViewport.pageY !== viewport.pageY) throw new BrowserActionError("screenshot-unavailable", "the viewport changed during capture");
    if (Buffer.byteLength(tile.data, "base64") > BROWSER_CAPTURE_LIMITS.bytes) throw new BrowserActionError("screenshot-limit", "a capture tile exceeds the byte limit");
    const bytes = Buffer.from(tile.data, "base64");
    if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1
      || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > BROWSER_CAPTURE_LIMITS.pixels) {
      throw new BrowserActionError("screenshot-limit", "a capture tile has invalid dimensions");
    }
    const image = await loadImage(bytes);
    throwIfAborted(signal);
    const scale = tile.cssScale ?? image.height / viewport.clientHeight;
    if (initialScale !== undefined && scale !== initialScale) throw new BrowserActionError("screenshot-unavailable", "the viewport changed during capture");
    initialScale = scale;
    const rows = Math.min(height - copied, Math.floor(viewport.clientHeight - skip));
    if (!Number.isFinite(scale) || scale <= 0 || rows < 1 || image.height <= skip * scale) throw new BrowserActionError("screenshot-unavailable", "the tile has no valid capture scale");
    context.drawImage(image, 0, skip * scale, Math.min(image.width, width * scale), Math.min(image.height - skip * scale, rows * scale), 0, copied, width, rows);
    copied += rows;
  }
  const bytes = await canvas.encode("png");
  throwIfAborted(signal);
  return { data: bytes.toString("base64") };
}
