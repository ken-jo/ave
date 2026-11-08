import { describe, expect, it } from "vitest";
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, nextZoomLevel, zoomLevelToZoomFactor } from "../app-zoom.js";

describe("app zoom levels", () => {
 it("uses exponential factors at every integer level", () => {
  expect(MIN_ZOOM_LEVEL).toBe(-8);
  expect(MAX_ZOOM_LEVEL).toBe(8);
  for (let level = -8; level <= 8; level++) {
   const factor = zoomLevelToZoomFactor(level);
   expect(factor).toBeCloseTo(1.2 ** level, 12);
   expect(Math.log(factor) / Math.log(1.2)).toBeCloseTo(level, 12);
  }
 });
 it("clamps commands at both ends and resets to zero", () => {
  expect(nextZoomLevel(8, "in")).toBe(8);
  expect(nextZoomLevel(-8, "out")).toBe(-8);
  expect(nextZoomLevel(0, "in")).toBe(1);
  expect(nextZoomLevel(0, "out")).toBe(-1);
  expect(nextZoomLevel(8, "reset")).toBe(0);
 });
});
