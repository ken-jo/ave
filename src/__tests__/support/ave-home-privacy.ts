import { afterEach, beforeEach, expect } from "vitest";
import { resolve } from "node:path";

export async function initializeAveHomeFixture(home: string): Promise<void> {
  const { configureHostResources } = await import("../../main/host-resources.js");
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const { ensureAveHomePrivate } = await import("../../shared/ave-home.js");
  const privacy = ensureAveHomePrivate(home);
  expect(privacy, JSON.stringify(privacy)).not.toMatchObject({ enforcement: "none" });
}

export function useVerifiedAveHomePrivacy(): void {
  beforeEach(async () => {
    const { configureHostResources } = await import("../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const { aveHome, setAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: aveHome(), sid: "S-1-5-21-100-200-300-1001" });
  });
  afterEach(async () => {
    const { _resetAveHomePrivacyForTest } = await import("../../shared/ave-home.js");
    _resetAveHomePrivacyForTest();
  });
}
