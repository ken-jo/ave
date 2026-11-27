import { describe, expect, it } from "vitest";
import { DEFAULT_TAILNET_OBSERVER_PORT } from "../tailnet-observer-config.js";

describe("the Tailnet observer default port", () => {
  it("is unprivileged and outside the platform and worker port ranges", () => {
    expect(DEFAULT_TAILNET_OBSERVER_PORT).toBeGreaterThanOrEqual(1024);
    expect(DEFAULT_TAILNET_OBSERVER_PORT).toBeLessThan(32_768);
    const reservedRanges = [
      [44_620, 48_715],
      [49_152, 65_535],
      [32_768, 60_999],
      [60_080, 60_109],
    ] as const;
    for (const [start, end] of reservedRanges) {
      expect(DEFAULT_TAILNET_OBSERVER_PORT >= start && DEFAULT_TAILNET_OBSERVER_PORT <= end).toBe(false);
    }
  });
});
