import { endianness } from "node:os";
import { crc32 } from "node:zlib";
import type { Sharp } from "sharp";
import { BROWSER_CAPTURE_LIMITS, type BrowserCaptureScroll, type BrowserViewportImage } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import { captureScrollContext, scrollBrowserCapture } from "./browser-capture-scroll.js";

const PNG_COLOR_CHUNKS = new Set(["cHRM", "cICP", "gAMA", "iCCP", "sRGB"]);
const PNG_HEADER_BYTES = 33;
const CAPTURE_DECODE_PIXELS = BROWSER_CAPTURE_LIMITS.pixels / 2;
const LITTLE_ENDIAN = endianness() === "LE";
const AREA_FILTER_COLUMNS = 4096;

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

function repeatedSourceRow(pixels: Buffer, start: number, end: number, stride: number, rowBytes: number): Buffer | undefined {
  const row = pixels.subarray(start, start + rowBytes);
  for (let offset = start + stride; offset < end; offset += stride) {
    if (row.compare(pixels, offset, offset + rowBytes) !== 0) return undefined;
  }
  return row;
}

function copyAlignedAreaRow(
  target: Buffer, output: number, pixels: Uint32Array, firstRow: number, stride: number,
  width: number, columns: number, rows: number,
): void {
  const area = columns * rows;
  const endRow = firstRow + rows * stride;
  for (let x = 0; x < width; x += 1, output += 4) {
    let red = 0, green = 0, blue = 0, opacity = 0;
    const left = x * columns;
    for (let row = firstRow; row < endRow; row += stride) {
      let source = row + left;
      const end = source + columns;
      for (; source < end; source += 1) {
        const rgba = pixels[source];
        if (rgba === undefined) continue;
        const alpha = rgba >>> 24;
        red += (rgba & 255) * alpha;
        green += ((rgba >>> 8) & 255) * alpha;
        blue += ((rgba >>> 16) & 255) * alpha;
        opacity += alpha;
      }
    }
    const divisor = opacity || 1;
    target[output] = Math.round(red / divisor);
    target[output + 1] = Math.round(green / divisor);
    target[output + 2] = Math.round(blue / divisor);
    target[output + 3] = Math.round(opacity / area);
  }
}

interface AreaRange {
  start: number;
  first: number;
  end: number;
  leading: number;
  trailing: number;
  span: number;
}

function areaRange(start: number, stop: number): AreaRange {
  const first = Math.floor(start), end = Math.ceil(stop);
  return { start, first, end, leading: Math.min(first + 1, stop) - start, trailing: stop - (end - 1), span: stop - start };
}

function filterAreaSourceRow(
  pixels: Buffer, offset: number, channels: 3 | 4, columns: AreaRange[], sums: Float64Array,
): void {
  const hasAlpha = channels === 4;
  let out = 0;
  for (const { first, end, leading, trailing } of columns) {
    let red = 0, green = 0, blue = 0, opacity = 0;
    let source = offset + first * channels;
    for (let x = first; x < end; x += 1, source += channels) {
      const coverage = x === first ? leading : x === end - 1 ? trailing : 1;
      const weight = hasAlpha ? pixels[source + 3] * coverage : coverage;
      red += pixels[source] * weight;
      green += pixels[source + 1] * weight;
      blue += pixels[source + 2] * weight;
      opacity += weight;
    }
    sums[out++] = red;
    sums[out++] = green;
    sums[out++] = blue;
    sums[out++] = opacity;
  }
}

function createAreaFilter(firstColumn: number, width: number, step: number, pixelWidth: number) {
  const columns = Array.from({ length: width }, (_, index) => {
    const x = firstColumn + index;
    const left = footprintStart(0, step, x, pixelWidth);
    return areaRange(left, footprintEnd(0, step, x, pixelWidth, left));
  });
  // Adjacent footprints can share source rows, including two rows when enlarging.
  const even = { source: -1, sums: new Float64Array(width * 4) };
  const odd = { source: -1, sums: new Float64Array(width * 4) };
  return { columns, even, odd, sums: new Float64Array(width * 4) };
}

function copyFilteredAreaRow(
  target: Buffer, output: number, pixels: Buffer, channels: 3 | 4, stride: number,
  sectionTop: number, vertical: AreaRange, repeat: boolean, filter: ReturnType<typeof createAreaFilter>,
): void {
  const { columns, even, odd, sums } = filter;
  sums.fill(0);
  const end = repeat ? vertical.first + 1 : vertical.end;
  for (let y = vertical.first; y < end; y += 1) {
    const row = y % 2 === 0 ? even : odd;
    if (row.source !== y) {
      filterAreaSourceRow(pixels, (y - sectionTop) * stride, channels, columns, row.sums);
      row.source = y;
    }
    const coverage = repeat ? 1 : y === vertical.first ? vertical.leading : y === end - 1 ? vertical.trailing : 1;
    for (let i = 0; i < sums.length; i += 1) sums[i] += row.sums[i] * coverage;
  }

  const spanY = repeat ? 1 : vertical.span;
  let i = 0;
  for (const { span } of columns) {
    const opacity = sums[i + 3];
    const divisor = opacity || 1;
    target[output++] = Math.round(sums[i++] / divisor);
    target[output++] = Math.round(sums[i++] / divisor);
    target[output++] = Math.round(sums[i++] / divisor);
    target[output++] = channels === 4 ? Math.round(opacity / (span * spanY)) : 255;
    i += 1;
  }
}

interface CaptureSection {
  sourceTop: number;
  stepX: number;
  stepY: number;
  width: number;
  copied: number;
  rows: number;
  tileHeight: number;
  sectionTop: number;
  sectionStart: number;
}

function captureRowRange(section: CaptureSection, index: number): AreaRange {
  const row = section.sectionStart + index;
  const { sourceTop, stepY, tileHeight } = section;
  const top = footprintStart(sourceTop, stepY, row, tileHeight);
  return areaRange(top, footprintEnd(sourceTop, stepY, row, tileHeight, top));
}

function copyCaptureColumns(
  target: Buffer, pixels: Buffer, channels: 3 | 4, pixelWidth: number,
  section: CaptureSection, firstColumn: number, columnCount: number, alignedRgba: Uint32Array | undefined,
  rowRanges: AreaRange[] | undefined,
): void {
  const { stepX, width, copied, rows, sectionTop } = section;
  const stride = pixelWidth * channels;
  const outputBytes = columnCount * 4;
  const firstSource = Math.floor(footprintStart(0, stepX, firstColumn, pixelWidth)) * channels;
  const lastColumn = firstColumn + columnCount - 1;
  const lastStart = footprintStart(0, stepX, lastColumn, pixelWidth);
  const rowBytes = firstColumn === 0 && columnCount === width ? stride
    : Math.ceil(footprintEnd(0, stepX, lastColumn, pixelWidth, lastStart)) * channels - firstSource;
  let filter: ReturnType<typeof createAreaFilter> | undefined;
  let previousRepeat: Buffer | undefined;
  let previousOutput = 0;
  for (let y = 0; y < rows; y += 1) {
    const outputRow = ((copied + y) * width + firstColumn) * 4;
    const vertical = rowRanges?.[y] ?? captureRowRange(section, y);
    if (stepX === 1 && Number.isInteger(vertical.start) && vertical.span === 1) {
      const left = (vertical.first - sectionTop) * stride + firstSource;
      if (channels === 4) pixels.copy(target, outputRow, left, left + outputBytes);
      else {
        for (let x = 0; x < columnCount; x += 1) {
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
    const { first: firstY, end: endY } = vertical;
    const start = (firstY - sectionTop) * stride + firstSource;
    const end = (endY - sectionTop) * stride + firstSource;
    // When the source rows are identical, the vertical weights cancel.
    const repeat = repeatedSourceRow(pixels, start, end, stride, rowBytes);
    if (repeat && previousRepeat?.equals(repeat)) {
      target.copy(target, outputRow, previousOutput, previousOutput + outputBytes);
      continue;
    }
    previousRepeat = repeat;
    previousOutput = outputRow;
    if (alignedRgba) {
      copyAlignedAreaRow(target, outputRow, alignedRgba, (firstY - sectionTop) * pixelWidth, pixelWidth, width, stepX, repeat ? 1 : vertical.span);
      continue;
    }
    filter ??= createAreaFilter(firstColumn, columnCount, stepX, pixelWidth);
    copyFilteredAreaRow(target, outputRow, pixels, channels, stride, sectionTop, vertical, repeat !== undefined, filter);
  }
}

function copyCaptureTile(
  target: Buffer, pixels: Buffer, pixelWidth: number, channels: 3 | 4,
  sourceTop: number, stepX: number, stepY: number, width: number, copied: number, rows: number,
  tileHeight: number, sectionTop: number, sectionStart: number,
): void {
  const alignedRgba = channels === 4 && LITTLE_ENDIAN && pixels.byteOffset % 4 === 0
    && stepX >= 1 && stepY >= 1 && Number.isInteger(stepX) && Number.isInteger(stepY) && Number.isInteger(sourceTop)
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4)
    : undefined;
  const section = { sourceTop, stepX, stepY, width, copied, rows, tileHeight, sectionTop, sectionStart };
  const columnsPerPass = alignedRgba ? width : AREA_FILTER_COLUMNS;
  // Wide captures use bounded column bands. The pixel limit bounds their row table.
  const rowRanges = width > columnsPerPass ? Array.from({ length: rows }, (_, y) => captureRowRange(section, y)) : undefined;
  for (let first = 0; first < width; first += columnsPerPass) {
    copyCaptureColumns(target, pixels, channels, pixelWidth, section, first, Math.min(columnsPerPass, width - first), alignedRgba, rowRanges);
  }
}

async function decodeCaptureTile(
  input: Sharp, target: Buffer, signal: AbortSignal, pixelWidth: number, pixelHeight: number,
  scale: number, skip: number, width: number, copied: number, rows: number,
): Promise<void> {
  throwIfAborted(signal);
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
    const decoded = await input.clone().extract({ left: 0, top, width: pixelWidth, height })
      .raw().toBuffer({ resolveWithObject: true });
    throwIfAborted(signal);
    const { data, info } = decoded;
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
  trackDecode: (decode: Promise<void>) => Promise<void>,
): Promise<{ data: string }> {
  const executionContextId = await captureScrollContext(cdp);
  throwIfAborted(signal);
  onRestore({ executionContextId, x: original.pageX, y: original.pageY });
  const { default: sharp } = await import("sharp");
  throwIfAborted(signal);
  const pixels = Buffer.alloc(width * height * 4);
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
    // Keep the encoded color values through resampling and restore their color tags after encoding.
    const input = sharp(bytes, { ignoreIcc: true, limitInputPixels: BROWSER_CAPTURE_LIMITS.pixels });
    const decode = () => trackDecode(decodeCaptureTile(input, pixels, signal, pixelWidth, pixelHeight, scale, skip, width, copied, rows));
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
  // The PNG encoder reads straight RGBA, including low-alpha channel values.
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ adaptiveFiltering: true }).toBuffer();
  throwIfAborted(signal);
  const { prefix, imageOffset } = captureColorChunks(bytes, true);
  const png = Buffer.concat([...prefix, colorProfile ?? Buffer.alloc(0), bytes.subarray(imageOffset)]);
  return { data: png.toString("base64") };
}
