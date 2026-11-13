import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { BROWSER_CAPTURE_LIMITS, parseBrowserScreenshotOptions, type BrowserCaptureClip, type BrowserCaptureScroll, type BrowserScreenshot, type BrowserScreenshotOptions, type BrowserViewportImage } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import type { WebContents } from "electron";
import { captureBrowserTiles } from "./browser-capture-tiles.js";
import { captureScrollContext, captureScrollParameters, scrollBrowserCapture } from "./browser-capture-scroll.js";
import { runBrowserCapture, type BrowserCaptureOperation } from "./browser-capture-operation.js";

const activeCaptures = new WeakSet<object>();
const CAPTURE_VIEWPORT_FIELDS = ["pageX", "pageY", "clientWidth", "clientHeight", "zoom", "scale"] as const;
export interface CaptureViewport {
  pageX: number; pageY: number; clientWidth: number; clientHeight: number;
  zoom?: number; scale?: number;
}

export function assertCaptureViewport(viewport: CaptureViewport | undefined, expected?: CaptureViewport): asserts viewport is CaptureViewport {
  if (!viewport || ![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite)
    || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
    throw new BrowserActionError("screenshot-unavailable", "the page has no valid viewport");
  }
  if (expected && CAPTURE_VIEWPORT_FIELDS.some((field) => viewport[field] !== expected[field])) {
    throw new BrowserActionError("screenshot-unavailable", "the viewport changed during capture");
  }
}

/** Read a redraw-bound viewport without changing its host slot or focus; the caller owns wake activity. */
export async function captureBrowserViewport(guest: Pick<WebContents, "getZoomFactor">, assertCurrent: () => void, pixelRatio: number, cdp: CdpSession): Promise<BrowserViewportImage> {
  assertCurrent();
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new BrowserActionError("screenshot-unavailable", "the view has no valid pixel density");
  const zoom = guest.getZoomFactor();
  const image = await cdp.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false, fromSurface: true,
  }) as { data?: unknown };
  assertCurrent();
  if (guest.getZoomFactor() !== zoom) throw new BrowserActionError("screenshot-unavailable", "the viewport changed during capture");
  if (typeof image.data !== "string" || image.data.length === 0) throw new BrowserActionError("screenshot-failed", "the tab returned no image");
  if (Buffer.byteLength(image.data, "base64") > BROWSER_CAPTURE_LIMITS.bytes) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture byte limit");
  const png = Buffer.from(image.data, "base64");
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new BrowserActionError("screenshot-failed", "the tab returned an invalid image");
  const pixelWidth = png.readUInt32BE(16), pixelHeight = png.readUInt32BE(20);
  if (pixelWidth < 1 || pixelHeight < 1 || pixelWidth * pixelHeight > BROWSER_CAPTURE_LIMITS.pixels) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture pixel limit");
  return { data: image.data, cssScale: zoom * pixelRatio };
}

/** Full pages retain the current CSS width and truncate their bottom at the pixel limit. */
export async function captureBrowserPage(
  cdp: CdpSession, signal: AbortSignal, options: BrowserScreenshotOptions = {},
  pixelRatio = 1, maxMs: number = TOOL_TIMEOUT_POLICY.browserCaptureMs, captureViewport?: () => Promise<BrowserViewportImage>,
  operation?: BrowserCaptureOperation,
  expectedViewport?: CaptureViewport,
): Promise<BrowserScreenshot> {
  return operation ? capturePage(cdp, operation, options, pixelRatio, captureViewport, expectedViewport)
    : runBrowserCapture(signal, maxMs, (active) => capturePage(cdp, active, options, pixelRatio, captureViewport, expectedViewport));
}

async function capturePage(
  cdp: CdpSession, operation: BrowserCaptureOperation, options: BrowserScreenshotOptions,
  pixelRatio: number, captureViewport?: () => Promise<BrowserViewportImage>,
  expectedViewport?: CaptureViewport,
): Promise<BrowserScreenshot> {
  const key = cdp.captureKey ?? cdp;
  if (activeCaptures.has(key)) throw new BrowserActionError("screenshot-busy", "another capture is using this tab");
  activeCaptures.add(key);
  let metricsOverridden = false;
  let scrollRestore: BrowserCaptureScroll | undefined;
  const tiled = options.fullPage === true && cdp.fullPageTiling === true;
  const captureSignal = operation.signal;
  const capture = async (): Promise<BrowserScreenshot> => {
    throwIfAborted(captureSignal);
    if (!parseBrowserScreenshotOptions(options) || options.ref !== undefined) throw new BrowserActionError("invalid-capture", "use one capture mode with valid CSS capture bounds");
    const metrics = await cdp.send("Page.getLayoutMetrics") as {
      cssContentSize: BrowserCaptureClip;
      cssVisualViewport: CaptureViewport;
    };
    throwIfAborted(captureSignal);
    assertCaptureViewport(metrics.cssVisualViewport, expectedViewport);
    const viewport = expectedViewport ?? metrics.cssVisualViewport;
    const clip = options.clip ?? (options.fullPage ? { ...metrics.cssContentSize, width: viewport.clientWidth } : {
      x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight,
    });
    if (!clip || ![clip.x, clip.y, clip.width, clip.height, pixelRatio].every(Number.isFinite)
      || clip.width <= 0 || clip.height <= 0 || pixelRatio <= 0) {
      throw new BrowserActionError("screenshot-unavailable", "the page has no valid capture bounds");
    }
    const originalWidth = Math.ceil(clip.width), originalHeight = Math.ceil(clip.height);
    const scale = options.fullPage ? 1 : Math.min(1, Math.sqrt(BROWSER_CAPTURE_LIMITS.pixels / (originalWidth * originalHeight)));
    const renderScale = tiled ? 1 : pixelRatio;
    const captureHeight = options.fullPage
      ? Math.min(originalHeight, Math.floor(Math.floor(BROWSER_CAPTURE_LIMITS.pixels / Math.ceil(originalWidth * renderScale)) / renderScale))
      : originalHeight;
    if (captureHeight < 1) throw new BrowserActionError("screenshot-limit", "the viewport width exceeds the capture pixel limit");
    if (!options.fullPage && (![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite)
      || viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || clip.x < viewport.pageX || clip.y < viewport.pageY
      || clip.x + clip.width > viewport.pageX + viewport.clientWidth
      || clip.y + clip.height > viewport.pageY + viewport.clientHeight)) {
      throw new BrowserActionError("screenshot-unavailable", "the capture region is outside the viewport; scroll it into view and take a new snapshot");
    }
    if (options.fullPage && !tiled) {
      const executionContextId = await captureScrollContext(cdp);
      throwIfAborted(captureSignal);
      scrollRestore = { executionContextId, x: viewport.pageX, y: viewport.pageY };
      metricsOverridden = true;
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: originalWidth, height: captureHeight, deviceScaleFactor: pixelRatio, mobile: false,
      });
      throwIfAborted(captureSignal);
      await scrollBrowserCapture(cdp, { executionContextId, x: 0, y: 0 });
      throwIfAborted(captureSignal);
    }
    let result: { data?: string; cssScale?: number };
    if (tiled) {
      if (!captureViewport) throw new BrowserActionError("screenshot-unavailable", "the tab has no native viewport readback");
      result = await captureBrowserTiles(cdp, captureSignal, originalWidth, captureHeight, viewport, captureViewport, (position) => { scrollRestore = position; });
    } else if (!options.fullPage && captureViewport) {
      result = await operation.wait(captureViewport());
    } else {
      result = await cdp.send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false, fromSurface: true,
      }) as { data?: string };
    }
    throwIfAborted(captureSignal);
    if (!options.fullPage) {
      const after = await cdp.send("Page.getLayoutMetrics") as typeof metrics;
      throwIfAborted(captureSignal);
      assertCaptureViewport(after.cssVisualViewport, viewport);
    }
    if (typeof result.data !== "string" || result.data.length === 0) throw new BrowserActionError("screenshot-failed", "the tab returned no image");
    let data = result.data;
    let bytes = Buffer.byteLength(data, "base64");
    if (bytes > BROWSER_CAPTURE_LIMITS.bytes) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture byte limit; capture a smaller region");
    const header = Buffer.from(data.slice(0, 32), "base64");
    if (header.length < 24 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new BrowserActionError("screenshot-failed", "the tab returned an invalid image");
    let width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (width < 1 || height < 1 || width * height > BROWSER_CAPTURE_LIMITS.pixels) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture pixel limit");
    if (options.fullPage) {
      if (Math.abs(width - originalWidth * renderScale) > 1 || Math.abs(height - captureHeight * renderScale) > 1) {
        throw new BrowserActionError("screenshot-unavailable", "the tab did not render the full capture viewport");
      }
      if (width !== originalWidth || height !== captureHeight) {
        const { default: sharp } = await import("sharp");
        throwIfAborted(captureSignal);
        const encoded = await sharp(Buffer.from(data, "base64"), { limitInputPixels: BROWSER_CAPTURE_LIMITS.pixels })
          .resize({ width: originalWidth, height: captureHeight, fit: "fill" }).png().toBuffer({ resolveWithObject: true });
        throwIfAborted(captureSignal);
        data = encoded.data.toString("base64"); bytes = encoded.data.byteLength;
        width = encoded.info.width; height = encoded.info.height;
      }
    } else {
      // Crop the already painted viewport: a first protocol clip can return pixels from the wrong origin.
      const xScale = result.cssScale ?? width / viewport.clientWidth, yScale = result.cssScale ?? height / viewport.clientHeight;
      const left = Math.max(0, Math.floor((clip.x - viewport.pageX) * xScale));
      const top = Math.max(0, Math.floor((clip.y - viewport.pageY) * yScale));
      const right = Math.min(width, Math.ceil((clip.x + clip.width - viewport.pageX) * xScale));
      const bottom = Math.min(height, Math.ceil((clip.y + clip.height - viewport.pageY) * yScale));
      const { default: sharp } = await import("sharp");
      throwIfAborted(captureSignal);
      const encoded = await sharp(Buffer.from(data, "base64"), { limitInputPixels: BROWSER_CAPTURE_LIMITS.pixels })
        .extract({ left, top, width: right - left, height: bottom - top })
        .resize({ width: Math.max(1, Math.floor(originalWidth * scale)), height: Math.max(1, Math.floor(originalHeight * scale)), fit: "fill" })
        .png().toBuffer({ resolveWithObject: true });
      throwIfAborted(captureSignal);
      data = encoded.data.toString("base64"); bytes = encoded.data.byteLength;
      width = encoded.info.width; height = encoded.info.height;
      if (bytes > BROWSER_CAPTURE_LIMITS.bytes) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture byte limit; capture a smaller region");
    }
    if (bytes > BROWSER_CAPTURE_LIMITS.bytes) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture byte limit; capture a smaller region");
    return { data, mimeType: "image/png", bytes, width, height, originalWidth, originalHeight, scale, truncated: captureHeight < originalHeight,
      ...(tiled ? { captureMethod: "scroll-and-stitch" as const, stickyHeadersDeduplicated: false as const } : {}) };
  };
  return operation.wait(capture()).finally(async () => {
    let releaseCapture = true;
    try {
      if (metricsOverridden || scrollRestore) {
        const restore = async () => {
          try {
            if (metricsOverridden) await (cdp.clearDeviceMetrics ? cdp.clearDeviceMetrics() : cdp.send("Emulation.clearDeviceMetricsOverride"));
          } finally {
            if (scrollRestore) await (cdp.restoreCaptureScroll ? cdp.restoreCaptureScroll(scrollRestore) : cdp.send("Runtime.callFunctionOn", captureScrollParameters(scrollRestore)));
          }
        };
        releaseCapture = false;
        const restored = restore().finally(() => { activeCaptures.delete(key); });
        await operation.wait(restored);
      }
    } finally { if (releaseCapture) activeCaptures.delete(key); }
  });
}
