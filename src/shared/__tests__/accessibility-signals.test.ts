import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESSIBILITY_SIGNAL_MODES,
  isAccessibilitySignalMode,
  resolveAccessibilitySignalModes,
  shouldPlayAccessibilitySignal,
} from "../accessibility-signals.js";

describe("accessibility signal modes", () => {
  it.each([
    ["on", true, true],
    ["on", false, true],
    ["unfocused", true, false],
    ["unfocused", false, true],
    ["off", true, false],
    ["off", false, false],
  ] as const)("mode %s with window focused=%s plays=%s", (mode, focused, plays) => {
    expect(shouldPlayAccessibilitySignal(mode, focused)).toBe(plays);
  });

  it("ships the owner defaults: attention cues in the background only, failure off", () => {
    expect(DEFAULT_ACCESSIBILITY_SIGNAL_MODES).toEqual({ turnFinished: "unfocused", approvalNeeded: "unfocused", turnFailed: "off" });
  });

  it("resolves stored modes over the defaults", () => {
    expect(resolveAccessibilitySignalModes(undefined)).toEqual(DEFAULT_ACCESSIBILITY_SIGNAL_MODES);
    expect(resolveAccessibilitySignalModes({ signalTurnFinished: "on", signalTurnFailed: "unfocused" })).toEqual({
      turnFinished: "on", approvalNeeded: "unfocused", turnFailed: "unfocused",
    });
  });

  it("accepts only the three modes", () => {
    for (const mode of ["off", "unfocused", "on"]) expect(isAccessibilitySignalMode(mode)).toBe(true);
    for (const value of ["always", "", true, null, undefined, 1]) expect(isAccessibilitySignalMode(value)).toBe(false);
  });
});
