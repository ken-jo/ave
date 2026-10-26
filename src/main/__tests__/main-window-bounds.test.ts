import { describe, expect, it } from "vitest";
import { computeInitialMainWindowBounds } from "../main-window-bounds.js";

describe("computeInitialMainWindowBounds", () => {
  it("centers the default window in the primary work area", () => {
    expect(computeInitialMainWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }))
      .toEqual({ x: 339, y: 156, width: 1243, height: 768 });
  });

  it("centers within an offset work area", () => {
    expect(computeInitialMainWindowBounds({ x: -1600, y: 50, width: 1600, height: 900 }))
      .toEqual({ x: -1421, y: 116, width: 1243, height: 768 });
  });

  it("clamps the preferred size to a smaller work area", () => {
    expect(computeInitialMainWindowBounds({ x: 100, y: 50, width: 600, height: 650 }))
      .toEqual({ x: 100, y: 50, width: 600, height: 650 });
  });

  it("allows a 360px work area without horizontal overflow", () => {
    expect(computeInitialMainWindowBounds({ x: 0, y: 0, width: 360, height: 768 }))
      .toEqual({ x: 0, y: 0, width: 360, height: 768 });
  });
});
