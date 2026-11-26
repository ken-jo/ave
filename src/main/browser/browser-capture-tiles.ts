import { crc32 } from "node:zlib";
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { Sharp } from "sharp";
import { BROWSER_CAPTURE_LIMITS, type BrowserCaptureScroll, type BrowserViewportImage } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import { captureScrollContext, scrollBrowserCapture } from "./browser-capture-scroll.js";

const PNG_COLOR_CHUNKS = new Set(["cHRM", "cICP", "gAMA", "iCCP", "sRGB"]);
const PNG_HEADER_BYTES = 33;
const CAPTURE_STRIP_BYTES = 1024 * 1024;
const CAPTURE_DECODE_PIXELS = BROWSER_CAPTURE_LIMITS.pixels / 2;

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

/** Sample source pixel centers once, and write a strip at a time without retaining tile rasters in the canvas. */
function copyCaptureTile(
  context: SKRSContext2D, pixels: Buffer, pixelWidth: number, pixelHeight: number, channels: 3 | 4,
  sourceTop: number, stepX: number, stepY: number, width: number, copied: number, rows: number,
): void {
  const strip = context.createImageData(width, Math.min(rows, Math.max(1, Math.floor(CAPTURE_STRIP_BYTES / (width * 4)))));
  const target = strip.data;
  const hasAlpha = channels === 4;
  for (let start = 0; start < rows; start += strip.height) {
    const count = Math.min(rows - start, strip.height);
    for (let y = 0; y < count; y += 1) {
      const sourceY = Math.max(0, sourceTop + (start + y + 0.5) * stepY - 0.5);
      const y0 = Math.floor(sourceY), y1 = Math.min(y0 + 1, pixelHeight - 1);
      const yWeight = sourceY - y0;
      if (stepX === 1 && yWeight === 0) {
        const left = y0 * pixelWidth * channels;
        const out = y * width * 4;
        if (hasAlpha) target.set(pixels.subarray(left, left + width * channels), out);
        else {
          for (let x = 0; x < width; x += 1) {
            const source = left + x * 3;
            const dest = out + x * 4;
            target[dest] = pixels[source] ?? 0;
            target[dest + 1] = pixels[source + 1] ?? 0;
            target[dest + 2] = pixels[source + 2] ?? 0;
            target[dest + 3] = 255;
          }
        }
        continue;
      }
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.max(0, (x + 0.5) * stepX - 0.5);
        const x0 = Math.floor(sourceX), x1 = Math.min(x0 + 1, pixelWidth - 1);
        const xWeight = sourceX - x0;
        const topLeft = (y0 * pixelWidth + x0) * channels, topRight = (y0 * pixelWidth + x1) * channels;
        const bottomLeft = (y1 * pixelWidth + x0) * channels, bottomRight = (y1 * pixelWidth + x1) * channels;
        const a = (hasAlpha ? (pixels[topLeft + 3] ?? 0) : 1) * (1 - xWeight) * (1 - yWeight);
        const b = (hasAlpha ? (pixels[topRight + 3] ?? 0) : 1) * xWeight * (1 - yWeight);
        const c = (hasAlpha ? (pixels[bottomLeft + 3] ?? 0) : 1) * (1 - xWeight) * yWeight;
        const d = (hasAlpha ? (pixels[bottomRight + 3] ?? 0) : 1) * xWeight * yWeight;
        const alpha = hasAlpha ? a + b + c + d : 1;
        const out = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          target[out + channel] = alpha === 0 ? 0 : Math.round(
            ((pixels[topLeft + channel] ?? 0) * a + (pixels[topRight + channel] ?? 0) * b
              + (pixels[bottomLeft + channel] ?? 0) * c + (pixels[bottomRight + channel] ?? 0) * d) / alpha,
          );
        }
        target[out + 3] = hasAlpha ? alpha : 255;
      }
    }
    context.putImageData(strip, 0, copied + start, 0, 0, width, count);
  }
}

async function decodeCaptureTile(
  input: Sharp, context: SKRSContext2D, signal: AbortSignal, pixelWidth: number, pixelHeight: number,
  scale: number, skip: number, width: number, copied: number, rows: number,
): Promise<void> {
  const sourceTop = skip * scale;
  const stepX = Math.min(pixelWidth, width * scale) / width;
  const stepY = Math.min(pixelHeight - sourceTop, rows * scale) / rows;
  // Large viewports are read in sections with one neighboring sample at each edge.
  const rowsPerDecode = Math.max(1, Math.floor((CAPTURE_DECODE_PIXELS / pixelWidth - 2) / stepY));
  for (let start = 0; start < rows; start += rowsPerDecode) {
    const count = Math.min(rowsPerDecode, rows - start);
    const sectionTop = sourceTop + start * stepY;
    const top = Math.max(0, Math.floor(sectionTop + 0.5 * stepY - 0.5));
    const bottom = Math.min(pixelHeight, Math.floor(sectionTop + (count - 0.5) * stepY - 0.5) + 2);
    const height = bottom - top;
    const { data, info } = await input.clone().extract({ left: 0, top, width: pixelWidth, height })
      .raw().toBuffer({ resolveWithObject: true });
    throwIfAborted(signal);
    if (info.width !== pixelWidth || info.height !== height || (info.channels !== 3 && info.channels !== 4)) {
      throw new BrowserActionError("screenshot-unavailable", "the tile has an unsupported pixel format");
    }
    copyCaptureTile(context, data, pixelWidth, height, info.channels, sectionTop - top, stepX, stepY, width, copied + start, count);
  }
}

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
  const [{ createCanvas }, { default: sharp }] = await Promise.all([import("@napi-rs/canvas"), import("sharp")]);
  throwIfAborted(signal);
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  let copied = 0;
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
    // Keep the encoded color values through resampling and restore their color tags after encoding.
    const input = sharp(bytes, { ignoreIcc: true, limitInputPixels: BROWSER_CAPTURE_LIMITS.pixels });
    await decodeCaptureTile(input, context, signal, pixelWidth, pixelHeight, scale, skip, width, copied, rows);
    copied += rows;
  }
  const bytes = await canvas.encode("png");
  throwIfAborted(signal);
  const { prefix, imageOffset } = captureColorChunks(bytes, true);
  const png = Buffer.concat([...prefix, colorProfile ?? Buffer.alloc(0), bytes.subarray(imageOffset)]);
  return { data: png.toString("base64") };
}
