import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.js";
import { __resetSandboxHomesUnavailableForTest, getSandboxHomesUnavailable } from "../sandbox-capability.js";
import { createSandboxProcessHome, isSandboxHomeUnavailable } from "../sandbox-process-home.js";

describe("a Windows sandbox HOME without a proved container runtime root", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSandboxHomesUnavailableForTest();
  });

  it.runIf(process.platform === "win32")("is refused with the named reason, which Settings then shows", () => {
    // Nothing established in this file, and no root published by the run's set-up.
    vi.stubEnv("AVE_TEST_MXC_RUNTIME_ROOT", "null");
    let refusal: unknown;
    try {
      createSandboxProcessHome("win32").cleanup();
    } catch (error) {
      refusal = error;
    }
    expect(isSandboxHomeUnavailable(refusal)).toBe(true);
    expect((refusal as Error).message).toBe(t("sandboxPolicy.homesUnavailable"));
    expect(getSandboxHomesUnavailable()).toBe(true);
  });
});
