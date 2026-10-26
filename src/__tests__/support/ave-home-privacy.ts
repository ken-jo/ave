import { afterEach, beforeEach } from "vitest";
import { resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";

export function useVerifiedAveHomePrivacy(): void {
  beforeEach(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const { aveHome, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: aveHome(), sid: "S-1-5-21-100-200-300-1001" });
  });
  afterEach(async () => {
    const { _resetAveHomePrivacyForTest } = await import("../../shared/ave-home.js");
    _resetAveHomePrivacyForTest();
  });
}
