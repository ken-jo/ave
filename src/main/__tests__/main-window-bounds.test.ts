import { describe, expect, it } from "vitest";
import { computeInitialMainWindowBounds, computeMainWindowUiBounds } from "../main-window-bounds.js";
import { MAIN_WINDOW_RESIZE_INSET } from "../../shared/shell-geometry.js";

describe("main document resize strip", () => {
  it.each([
    ["normal", 950, 734, false],
    ["resized", 1440, 900, false],
    ["maximized", 1920, 1080, false],
    ["restored", 950, 734, false],
    ["fullscreen", 1920, 1080, true],
    ["left fullscreen", 950, 734, false],
  ] as const)("computes native bounds when %s", (_state, width, height, fullscreen) => {
    const inset = fullscreen ? 0 : MAIN_WINDOW_RESIZE_INSET;
    expect(computeMainWindowUiBounds({ width, height }, "darwin", fullscreen))
      .toEqual({ x: inset, y: inset, width: width - inset * 2, height: height - inset * 2 });
  });
  it.each(["win32", "linux"] as const)("preserves full document bounds on %s", (platform) => {
    for (const fullscreen of [false, true]) {
      expect(computeMainWindowUiBounds({ width: 950, height: 734 }, platform, fullscreen))
        .toEqual({ x: 0, y: 0, width: 950, height: 734 });
    }
  });
});

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
