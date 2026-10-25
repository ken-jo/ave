import { describe, expect, it } from "vitest";
import { resolveUpdateCheckEnabled } from "../update-detector.js";

describe("resolveUpdateCheckEnabled", () => {
  it("lets the setting decide when the variable is unset", () => {
    expect(resolveUpdateCheckEnabled(false, {})).toBe(false);
    expect(resolveUpdateCheckEnabled(true, {})).toBe(true);
    expect(resolveUpdateCheckEnabled(undefined, {})).toBe(true);
  });

  it("lets the environment turn the check off, but never back on", () => {
    expect(resolveUpdateCheckEnabled(true, { AVE_MARKETPLACE_UPDATE_CHECK: "0" })).toBe(false);
    // An environment switch may disable update checks but must never override a disabled profile setting.
    expect(resolveUpdateCheckEnabled(false, { AVE_MARKETPLACE_UPDATE_CHECK: "1" })).toBe(false);
  });
});
