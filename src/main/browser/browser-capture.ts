import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { BROWSER_CAPTURE_LIMITS, parseBrowserScreenshotOptions, type BrowserCaptureClip, type BrowserScreenshot, type BrowserScreenshotOptions } from "../../shared/browser-capture.js";
import { BrowserActionError, throwIfAborted, type CdpSession } from "./browser-action-guard.js";
import type { WebContents } from "electron";

/** Read the native viewport without changing its host slot or focus; the caller owns wake activity. */
export async function captureBrowserViewport(guest: Pick<WebContents, "capturePage">, assertCurrent: () => void): Promise<{ data: string }> {
  assertCurrent();
  const image = await guest.capturePage(undefined, { stayHidden: true, stayAwake: false });
  assertCurrent();
  const { width, height } = image.getSize();
  if (image.isEmpty() || width < 1 || height < 1) throw new BrowserActionError("screenshot-failed", "the tab returned no image");
  if (width * height > BROWSER_CAPTURE_LIMITS.pixels) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture pixel limit");
  return { data: image.toPNG({ scaleFactor: 1 }).toString("base64") };
}

/** Capture one surface without scrolling it. Oversized content is proportionally reduced, never cropped. */
export async function captureBrowserPage(
  cdp: CdpSession, signal: AbortSignal, options: BrowserScreenshotOptions = {},
  pixelRatio = 1, maxMs: number = TOOL_TIMEOUT_POLICY.browserCaptureMs, captureViewport?: () => Promise<{ data: string }>,
): Promise<BrowserScreenshot> {
  const lifetime = new AbortController();
  const captureSignal = AbortSignal.any([signal, lifetime.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const capture = async (): Promise<BrowserScreenshot> => {
    throwIfAborted(captureSignal);
    if (!parseBrowserScreenshotOptions(options) || options.ref !== undefined) throw new BrowserActionError("invalid-capture", "use one capture mode with valid CSS capture bounds");
    const metrics = await cdp.send("Page.getLayoutMetrics") as {
      cssContentSize: BrowserCaptureClip;
      cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
    };
    throwIfAborted(captureSignal);
    const viewport = metrics.cssVisualViewport;
    const clip = options.clip ?? (options.fullPage ? metrics.cssContentSize : {
      x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight,
    });
    if (!clip || ![clip.x, clip.y, clip.width, clip.height, pixelRatio].every(Number.isFinite)
      || clip.width <= 0 || clip.height <= 0 || pixelRatio <= 0) {
      throw new BrowserActionError("screenshot-unavailable", "the page has no valid capture bounds");
    }
    const originalWidth = Math.ceil(clip.width), originalHeight = Math.ceil(clip.height);
    const scale = Math.min(1, Math.sqrt(BROWSER_CAPTURE_LIMITS.pixels / (originalWidth * originalHeight)));
    if (!options.fullPage && (![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite)
      || viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || clip.x < viewport.pageX || clip.y < viewport.pageY
      || clip.x + clip.width > viewport.pageX + viewport.clientWidth
      || clip.y + clip.height > viewport.pageY + viewport.clientHeight)) {
      throw new BrowserActionError("screenshot-unavailable", "the capture region is outside the viewport; scroll it into view and take a new snapshot");
    }
    const result = options.fullPage || !captureViewport ? await cdp.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: options.fullPage === true, fromSurface: true,
      ...(options.fullPage ? { clip: { ...clip, scale: scale / pixelRatio } } : {}),
    }) as { data?: string } : await captureViewport();
    throwIfAborted(captureSignal);
    if (typeof result.data !== "string" || result.data.length === 0) throw new BrowserActionError("screenshot-failed", "the tab returned no image");
    let data = result.data;
    let bytes = Buffer.byteLength(data, "base64");
    if (bytes > BROWSER_CAPTURE_LIMITS.bytes) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture byte limit; capture a smaller region");
    const header = Buffer.from(data.slice(0, 32), "base64");
    if (header.length < 24 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new BrowserActionError("screenshot-failed", "the tab returned an invalid image");
    let width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (width < 1 || height < 1 || width * height > BROWSER_CAPTURE_LIMITS.pixels) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture pixel limit");
    if (!options.fullPage) {
      // Crop the already painted viewport: a first protocol clip can return pixels from the wrong origin.
      const xScale = width / viewport.clientWidth, yScale = height / viewport.clientHeight;
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
    return { data, mimeType: "image/png", bytes, width, height, originalWidth, originalHeight, scale, truncated: false };
  };
  return Promise.race([capture(), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BrowserActionError("screenshot-timeout", "the tab did not return an image within the capture deadline");
      reject(error); lifetime.abort(error);
    }, maxMs);
    onAbort = () => { try { throwIfAborted(signal); } catch (error) { reject(error); } };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  })]).finally(() => { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); });
}
