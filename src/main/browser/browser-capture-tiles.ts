import { crc32 } from "node:zlib";
import { BROWSER_CAPTURE_LIMITS, type BrowserCaptureScroll, type BrowserViewportImage } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import { captureScrollContext, scrollBrowserCapture } from "./browser-capture-scroll.js";
import { CAPTURE_DECODE_PIXELS } from "./browser-capture-stitch-protocol.js";
import type { CaptureStitcher } from "./browser-capture-stitch-process.js";

const PNG_COLOR_CHUNKS = new Set(["cHRM", "cICP", "gAMA", "iCCP", "sRGB"]);
const PNG_HEADER_BYTES = 33;

function captureColorChunks(png: Buffer, keepPrefix = false): { color: Buffer; prefix: Buffer[]; imageOffset: number } {
  const color: Buffer[] = [];
  const seen = new Set<string>();
  const prefix = [png.subarray(0, PNG_HEADER_BYTES)];
  for (let offset = PNG_HEADER_BYTES; offset + 12 <= png.length;) {
    const end = offset + png.readUInt32BE(offset) + 12;
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (end > png.length) break;
    if (kind === "IDAT") return { color: Buffer.concat(color), prefix, imageOffset: offset };
    if (PNG_COLOR_CHUNKS.has(kind)) {
      if (seen.has(kind) || crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) break;
      seen.add(kind);
      color.push(png.subarray(offset, end));
    } else if (keepPrefix) {
      prefix.push(png.subarray(offset, end));
    }
    offset = end;
  }
  throw new BrowserActionError("screenshot-unavailable", "the capture tile has invalid PNG metadata");
}

/** Compose only the requested snapshot height. Sticky content is intentionally kept in every tile where it paints. */
export async function captureBrowserTiles(
  cdp: CdpSession, signal: AbortSignal, height: number,
  original: { pageX: number; pageY: number; clientWidth: number; clientHeight: number },
  captureViewport: () => Promise<BrowserViewportImage>,
  onRestore: (position: BrowserCaptureScroll) => void,
  stitcher: CaptureStitcher,
  trackDecode: <T>(decode: Promise<T>) => Promise<T>,
): Promise<{ data: string }> {
  const executionContextId = await captureScrollContext(cdp);
  throwIfAborted(signal);
  onRestore({ executionContextId, x: original.pageX, y: original.pageY });
  let copied = 0;
  let pendingDecode: Promise<void> | undefined;
  let initialScale: number | undefined;
  let colorProfile: Buffer | undefined;
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
    if (bytes.length < PNG_HEADER_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new BrowserActionError("screenshot-limit", "a capture tile has invalid dimensions");
    }
    const pixelWidth = bytes.readUInt32BE(16), pixelHeight = bytes.readUInt32BE(20);
    if (pixelWidth < 1 || pixelHeight < 1 || pixelWidth * pixelHeight > BROWSER_CAPTURE_LIMITS.pixels) {
      throw new BrowserActionError("screenshot-limit", "a capture tile has invalid dimensions");
    }
    const scale = tile.cssScale ?? pixelHeight / viewport.clientHeight;
    if (initialScale !== undefined && scale !== initialScale) throw new BrowserActionError("screenshot-unavailable", "the viewport changed during capture");
    initialScale = scale;
    const rows = Math.min(height - copied, Math.floor(viewport.clientHeight - skip));
    if (!Number.isFinite(scale) || scale <= 0 || rows < 1 || pixelHeight <= skip * scale) throw new BrowserActionError("screenshot-unavailable", "the tile has no valid capture scale");
    const { color } = captureColorChunks(bytes);
    if (colorProfile && !colorProfile.equals(color)) throw new BrowserActionError("screenshot-unavailable", "the tile color profile changed during capture");
    colorProfile ??= color;
    const decode = () => {
      throwIfAborted(signal);
      return trackDecode(stitcher.decode(bytes, { pixelWidth, pixelHeight, scale, skip, copied, rows }));
    };
    // Two small fractional tiles can decode concurrently within the raw-pixel budget.
    if (!Number.isInteger(scale) && pixelWidth * pixelHeight <= CAPTURE_DECODE_PIXELS / 2) {
      const previousDecode = pendingDecode;
      pendingDecode = decode();
      await previousDecode;
    } else {
      await pendingDecode;
      pendingDecode = undefined;
      await decode();
    }
    copied += rows;
  }
  await pendingDecode;
  throwIfAborted(signal);
  // The stitcher resampled the encoded color values; restore their color tags here.
  const bytes = await trackDecode(stitcher.encode());
  throwIfAborted(signal);
  const { prefix, imageOffset } = captureColorChunks(bytes, true);
  const png = Buffer.concat([...prefix, colorProfile ?? Buffer.alloc(0), bytes.subarray(imageOffset)]);
  return { data: png.toString("base64") };
}
