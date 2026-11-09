import { describe, expect, it } from "vitest";
import { parseBrowserCaptureClip, parseBrowserScreenshotOptions } from "../browser-capture.js";

describe("browser capture arguments", () => {
  const clip = { x: 10.5, y: 20.25, width: 145, height: 56 };
  it.each([{}, { fullPage: false }, { fullPage: true }, { ref: "e12" }, { clip }, { fullPage: false, clip }])("accepts the capture mode %j", (options) => {
    expect(parseBrowserScreenshotOptions(options)).toEqual(options);
  });
  it.each([
    null, [], "full", { fullPage: "true" }, { fullPage: null }, { ref: "Save" }, { ref: "e" }, { ref: 12 }, { ref: `e${"1".repeat(100)}` },
    { fullPage: true, ref: "e1" }, { fullPage: true, clip }, { ref: "e1", clip }, { clip: null }, { clip: [] }, { extra: true },
  ])("rejects ambiguous or invalid modes %j", (options) => {
    expect(parseBrowserScreenshotOptions(options)).toBeNull();
  });
  it.each([
    { x: -1 }, { y: -0.5 }, { width: 0 }, { height: -1 }, { x: NaN }, { y: Infinity }, { width: Infinity },
    { height: "56" }, { scale: 1 }, { x: Number.MAX_SAFE_INTEGER }, { y: Number.MAX_SAFE_INTEGER },
  ])("rejects invalid CSS geometry %j", (fields) => {
    expect(parseBrowserCaptureClip({ ...clip, ...fields })).toBeNull();
  });
  it("requires every rectangle field", () => {
    expect(parseBrowserCaptureClip({ x: 0, y: 0, width: 1 })).toBeNull();
  });
});
