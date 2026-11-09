import type { BrowserScreenshotOptions } from "../../../../src/shared/browser-capture.js";

export interface CaptureNativeResult {
  readonly data: string;
  readonly dimensions: { width: number; height: number };
  readonly viewport: { width: number; height: number };
  readonly content: { width: number; height: number };
  readonly element: { width: number; height: number };
  readonly bottomPixelRGB: readonly number[];
  readonly bandPixelsRGB: readonly (readonly number[])[];
  readonly elementPixelsRGB: readonly (readonly number[])[];
  readonly truncated: boolean;
}

export interface CaptureNativeFixture {
  readonly ready: true;
  readonly pageUrl: string;
  readonly targetId: number;
  readonly windowId: number;
  capture(options: BrowserScreenshotOptions, zoom?: number): Promise<CaptureNativeResult>;
  close(): Promise<void>;
}
