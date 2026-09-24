/**
 * The update-notice switch: the setting, with the environment able only to turn it off.
 */
import { describe, expect, it } from "vitest";
import { resolveUpdateCheckEnabled } from "../update-detector.js";
import { isNewerPluginVersion } from "../update-condition.js";

// ─── isNewerPluginVersion ───────────────────────────────────────────────────

describe("isNewerPluginVersion", () => {
  it("returns true when candidate has higher patch", () => {
    expect(isNewerPluginVersion("1.0.1", "1.0.0")).toBe(true);
  });
  it("returns true when candidate has higher minor", () => {
    expect(isNewerPluginVersion("1.1.0", "1.0.9")).toBe(true);
  });
  it("returns true when candidate has higher major", () => {
    expect(isNewerPluginVersion("2.0.0", "1.9.9")).toBe(true);
  });
  it("returns false when versions are equal", () => {
    expect(isNewerPluginVersion("1.0.0", "1.0.0")).toBe(false);
  });
  it("returns false when candidate is older", () => {
    expect(isNewerPluginVersion("1.0.0", "1.0.1")).toBe(false);
  });
  it("handles v-prefix", () => {
    expect(isNewerPluginVersion("v1.1.0", "v1.0.0")).toBe(true);
  });
  // S8 FU1 — semver pre-release precedence (semver.org §11)
  it("treats stable as newer than same-version prerelease (1.0.0 > 1.0.0-beta.1)", () => {
    expect(isNewerPluginVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
  });
  it("treats prerelease as older than same-version stable (1.0.0-beta.1 < 1.0.0)", () => {
    expect(isNewerPluginVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
  });
  it("compares prerelease numeric identifiers numerically (1.0.0-beta.2 > 1.0.0-beta.1)", () => {
    expect(isNewerPluginVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
    expect(isNewerPluginVersion("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
  });
  it("orders alpha < beta lexically when non-numeric", () => {
    expect(isNewerPluginVersion("1.0.0-beta.1", "1.0.0-alpha.1")).toBe(true);
    expect(isNewerPluginVersion("1.0.0-alpha.1", "1.0.0-beta.1")).toBe(false);
  });
  it("shorter prerelease chain has lower precedence (1.0.0-alpha.1 > 1.0.0-alpha)", () => {
    expect(isNewerPluginVersion("1.0.0-alpha.1", "1.0.0-alpha")).toBe(true);
  });
  it("numeric identifiers have lower precedence than non-numeric", () => {
    expect(isNewerPluginVersion("1.0.0-beta", "1.0.0-1")).toBe(true);
    expect(isNewerPluginVersion("1.0.0-1", "1.0.0-beta")).toBe(false);
  });
});

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
