/** Resolve package metadata relative to the bundle so development and archive layouts both work. */
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
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("memoises the result across calls", () => {
    const first = getAveAppVersion();
    const second = getAveAppVersion();
    expect(second).toBe(first);
  });
});
