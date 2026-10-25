import { afterEach, beforeEach } from "vitest";

export function useVerifiedAveHomePrivacy(): void {
  beforeEach(async () => {
    const { aveHome, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: aveHome(), sid: "S-1-5-21-100-200-300-1001" });
  });
  afterEach(async () => {
    const { _resetAveHomePrivacyForTest } = await import("../../shared/ave-home.js");
    _resetAveHomePrivacyForTest();
  });
}
