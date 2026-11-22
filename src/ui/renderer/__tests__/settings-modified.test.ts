import { describe, expect, it } from "vitest";
import { effectiveSettingValue, settingPatch, settingValuesEqual, SECTION_SETTING_CONTROLS } from "../settings-modified.js";
import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";

describe("modified settings", () => {
  it("compares object values independently of insertion order and preserves array order", () => {
    expect(settingValuesEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(settingValuesEqual([1, 2], [2, 1])).toBe(false);
    expect(settingValuesEqual(null, {})).toBe(false);
  });
  it("resets one setting without widening a patch to its siblings", () => {
    expect(settingPatch("appearance.terminalFont.size", 12)).toEqual({ appearance: { terminalFont: { size: 12 } } });
    expect(settingPatch("features.osToolSandbox", true)).toEqual({ features: { osToolSandbox: true } });
    expect(() => settingPatch("appearance.__proto__.x", true)).toThrow();
  });
  it("uses canonical defaults and resolves optional overrides from their owning policy", () => {
    expect(effectiveSettingValue(DEFAULT_SETTINGS, "chat.subAgentMaxRounds")).toBe(DEFAULT_SETTINGS.chat.subAgentMaxRounds);
    expect(effectiveSettingValue(DEFAULT_SETTINGS, "appearance.font.family")).toBe("system");
    for (const controls of Object.values(SECTION_SETTING_CONTROLS)) {
      for (const control of controls) expect(effectiveSettingValue(DEFAULT_SETTINGS, control.path), control.path).not.toBeUndefined();
    }
  });
});
