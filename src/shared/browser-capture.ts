/** Capture geometry is in document CSS pixels; output dimensions are PNG pixels. */
export interface BrowserCaptureClip { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface BrowserScreenshotOptions { readonly fullPage?: boolean; readonly ref?: string; readonly clip?: BrowserCaptureClip }
export interface BrowserViewportImage { readonly data: string; readonly cssScale?: number }
export interface BrowserCaptureScroll { readonly executionContextId: number; readonly x: number; readonly y: number }
export interface BrowserScreenshot {
  readonly data: string; readonly mimeType: "image/png"; readonly bytes: number;
  readonly width: number; readonly height: number;
  readonly originalWidth: number; readonly originalHeight: number;
  readonly scale: number; readonly truncated: boolean;
  readonly captureMethod?: "scroll-and-stitch";
  readonly stickyHeadersDeduplicated?: false;
}
export const BROWSER_CAPTURE_LIMITS = { pixels: 32_000_000, bytes: 10 * 1024 * 1024 } as const;

export function parseBrowserCaptureClip(value: unknown): BrowserCaptureClip | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const clip = value as Record<string, unknown>;
  if (Object.keys(clip).length !== 4 || !["x", "y", "width", "height"].every((key) => typeof clip[key] === "number" && Number.isFinite(clip[key]))) return null;
  const { x, y, width, height } = clip as unknown as BrowserCaptureClip;
  return x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= Number.MAX_SAFE_INTEGER && y + height <= Number.MAX_SAFE_INTEGER
    ? { x, y, width, height } : null;
}

export function parseBrowserScreenshotOptions(value: unknown): BrowserScreenshotOptions | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some((key) => !["fullPage", "ref", "clip"].includes(key))
    || options.fullPage !== undefined && typeof options.fullPage !== "boolean"
    || options.ref !== undefined && (typeof options.ref !== "string" || options.ref.length > 100 || !/^e\d+$/.test(options.ref))) return null;
  const clip = options.clip === undefined ? undefined : parseBrowserCaptureClip(options.clip);
  if (clip === null || options.ref !== undefined && clip !== undefined
    || options.fullPage === true && (options.ref !== undefined || clip !== undefined)) return null;
  return {
    ...(options.fullPage !== undefined ? { fullPage: options.fullPage as boolean } : {}),
    ...(options.ref !== undefined ? { ref: options.ref as string } : {}),
    ...(clip ? { clip } : {}),
  };
}
