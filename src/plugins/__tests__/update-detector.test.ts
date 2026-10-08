/**
 * The update-notice switch: the setting, with the environment able only to turn it off.
 */
import { describe, expect, it } from "vitest";
import { resolveUpdateCheckEnabled } from "../update-detector.js";

// ─── resolveUpdateCheckEnabled ───────────────────────────────────────────────

describe("resolveUpdateCheckEnabled", () => {
  it("lets the setting decide when the variable is unset", () => {
    expect(resolveUpdateCheckEnabled(false, {})).toBe(false);
    expect(resolveUpdateCheckEnabled(true, {})).toBe(true);
    expect(resolveUpdateCheckEnabled(undefined, {})).toBe(true);
  });

  it("lets the environment turn the check off, but never back on", () => {
    expect(resolveUpdateCheckEnabled(true, { AVE_MARKETPLACE_UPDATE_CHECK: "0" })).toBe(false);
    // The pre-existing host rule was `(setting ?? true) && env`: an ON value
    // never resurrected a check the profile had turned off, and a launcher
    // script must not gain that power by way of the new setting.
    expect(resolveUpdateCheckEnabled(false, { AVE_MARKETPLACE_UPDATE_CHECK: "1" })).toBe(false);
  });
});
