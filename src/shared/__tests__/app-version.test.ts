/**
 * Unit tests for getAveAppVersion.
 *
 * Guards the regression that produced the Settings → 일반 → 앱 버전
 * `vunknown` display in dev mode (PR #1011 used `app.getAppPath()` which
 * pointed at the Electron binary's directory).
 *
 * The helper walks candidate paths relative to its own bundled location
 * so the same resolution works for the dev launcher
 * (`electron dist/src/main/main.js`) and the packaged
 * (`app.asar/dist/src/main/main.js`) layouts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getAveAppVersion,
  __resetAveAppVersionCacheForTest,
} from "../app-version.js";

describe("getAveAppVersion", () => {
  beforeEach(() => {
    __resetAveAppVersionCacheForTest();
  });

  it("returns a non-empty semver-shaped string from the Ave package.json", () => {
    const v = getAveAppVersion();
    expect(v).not.toBe("unknown");
    expect(v).not.toBe("");
    // Loose semver shape — accepts pre-release / build metadata.
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("memoises the result across calls", () => {
    const first = getAveAppVersion();
    const second = getAveAppVersion();
    expect(second).toBe(first);
  });
});
