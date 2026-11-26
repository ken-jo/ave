import { crc32 } from "node:zlib";
import type { Sharp } from "sharp";
import { BROWSER_CAPTURE_LIMITS, type BrowserCaptureScroll, type BrowserViewportImage } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import { captureScrollContext, scrollBrowserCapture } from "./browser-capture-scroll.js";

const PNG_COLOR_CHUNKS = new Set(["cHRM", "cICP", "gAMA", "iCCP", "sRGB"]);
const PNG_HEADER_BYTES = 33;
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

function footprintStart(origin: number, step: number, index: number, size: number): number {
  if (step >= 1) return origin + index * step;
  return Math.max(0, Math.min(size - 1, origin + (index + 0.5) * step - 0.5));
}

function footprintEnd(origin: number, step: number, index: number, size: number, start: number): number {
  return step >= 1 ? Math.min(size, origin + (index + 1) * step) : start + 1;
}

function repeatedSourceRow(pixels: Buffer, start: number, end: number, stride: number): Buffer | undefined {
  const row = pixels.subarray(start, start + stride);
  for (let offset = start + stride; offset < end; offset += stride) {
    if (row.compare(pixels, offset, offset + stride) !== 0) return undefined;
  }
  return row;
}

function copyCaptureTile(
  target: Buffer, pixels: Buffer, pixelWidth: number, channels: 3 | 4,
  sourceTop: number, stepX: number, stepY: number, width: number, copied: number, rows: number,
  tileHeight: number, sectionTop: number, sectionStart: number,
): void {
  const hasAlpha = channels === 4;
  const stride = pixelWidth * channels;
  const outputStride = width * 4;
  let previousRepeat: Buffer | undefined;
  let previousOutput = 0;
  for (let y = 0; y < rows; y += 1) {
    const row = sectionStart + y;
    const outputRow = (copied + y) * outputStride;
    const top = footprintStart(sourceTop, stepY, row, tileHeight);
    const bottom = footprintEnd(sourceTop, stepY, row, tileHeight, top);
    if (stepX === 1 && Number.isInteger(top) && bottom - top === 1) {
      const left = (top - sectionTop) * stride;
      if (hasAlpha) pixels.copy(target, outputRow, left, left + width * channels);
      else {
        for (let x = 0; x < width; x += 1) {
          const source = left + x * 3;
          const dest = outputRow + x * 4;
          target[dest] = pixels[source] ?? 0;
          target[dest + 1] = pixels[source + 1] ?? 0;
          target[dest + 2] = pixels[source + 2] ?? 0;
          target[dest + 3] = 255;
        }
      }
      continue;
    }
    const firstY = Math.floor(top), endY = Math.ceil(bottom);
    // When the source rows are identical, the vertical weights cancel.
    const repeat = repeatedSourceRow(pixels, (firstY - sectionTop) * stride, (endY - sectionTop) * stride, stride);
    if (repeat && previousRepeat?.equals(repeat)) {
      target.copy(target, outputRow, previousOutput, previousOutput + outputStride);
      continue;
    }
    previousRepeat = repeat;
    previousOutput = outputRow;
    const sampleEndY = repeat ? firstY + 1 : endY;
    const spanY = repeat ? 1 : bottom - top;
    for (let x = 0; x < width; x += 1) {
      const left = footprintStart(0, stepX, x, pixelWidth);
      const right = footprintEnd(0, stepX, x, pixelWidth, left);
      const firstX = Math.floor(left), endX = Math.ceil(right);
      let red = 0, green = 0, blue = 0, opacity = 0;
      for (let sy = firstY; sy < sampleEndY; sy += 1) {
        const yCoverage = repeat ? 1 : Math.min(sy + 1, bottom) - Math.max(sy, top);
        let source = ((sy - sectionTop) * pixelWidth + firstX) * channels;
        for (let sx = firstX; sx < endX; sx += 1, source += channels) {
          const coverage = (Math.min(sx + 1, right) - Math.max(sx, left)) * yCoverage;
          const weight = hasAlpha ? coverage * (pixels[source + 3] ?? 0) : coverage;
          opacity += weight;
          red += (pixels[source] ?? 0) * weight;
          green += (pixels[source + 1] ?? 0) * weight;
          blue += (pixels[source + 2] ?? 0) * weight;
        }
      }
      const out = outputRow + x * 4;
      target[out] = opacity === 0 ? 0 : Math.round(red / opacity);
      target[out + 1] = opacity === 0 ? 0 : Math.round(green / opacity);
      target[out + 2] = opacity === 0 ? 0 : Math.round(blue / opacity);
      target[out + 3] = hasAlpha ? Math.round(opacity / ((right - left) * spanY)) : 255;
    }
  }
}

async function decodeCaptureTile(
  input: Sharp, target: Buffer, signal: AbortSignal, pixelWidth: number, pixelHeight: number,
  scale: number, skip: number, width: number, copied: number, rows: number,
): Promise<void> {
  const sourceTop = skip * scale;
  const stepX = Math.min(pixelWidth, width * scale) / width;
  const stepY = Math.min(pixelHeight - sourceTop, rows * scale) / rows;
  // Include every source row touched by the section's first and last footprints.
  const rowsPerDecode = Math.max(1, Math.floor((CAPTURE_DECODE_PIXELS / pixelWidth - 2) / stepY));
  for (let start = 0; start < rows; start += rowsPerDecode) {
    const count = Math.min(rowsPerDecode, rows - start);
    const top = Math.floor(footprintStart(sourceTop, stepY, start, pixelHeight));
    const last = start + count - 1;
    const bottom = Math.ceil(footprintEnd(sourceTop, stepY, last, pixelHeight, footprintStart(sourceTop, stepY, last, pixelHeight)));
    const height = bottom - top;
    const { data, info } = await input.clone().extract({ left: 0, top, width: pixelWidth, height })
      .raw().toBuffer({ resolveWithObject: true });
    throwIfAborted(signal);
    if (info.width !== pixelWidth || info.height !== height || (info.channels !== 3 && info.channels !== 4)) {
      throw new BrowserActionError("screenshot-unavailable", "the tile has an unsupported pixel format");
    }
    copyCaptureTile(target, data, pixelWidth, info.channels, sourceTop, stepX, stepY, width, copied + start, count, pixelHeight, top, start);
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
  const { default: sharp } = await import("sharp");
  throwIfAborted(signal);
  const pixels = Buffer.alloc(width * height * 4);
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
    await decodeCaptureTile(input, pixels, signal, pixelWidth, pixelHeight, scale, skip, width, copied, rows);
    copied += rows;
  }
  // The PNG encoder reads straight RGBA, including low-alpha channel values.
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ adaptiveFiltering: true }).toBuffer();
  throwIfAborted(signal);
  const { prefix, imageOffset } = captureColorChunks(bytes, true);
  const png = Buffer.concat([...prefix, colorProfile ?? Buffer.alloc(0), bytes.subarray(imageOffset)]);
  return { data: png.toString("base64") };
}
