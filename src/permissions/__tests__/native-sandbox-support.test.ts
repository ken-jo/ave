import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ initialize: vi.fn(), active: false }));
vi.mock("../asrt-sandbox.js", () => ({
  initializeAsrtSandbox: runtime.initialize,
  isAsrtSandboxActive: () => runtime.active,
}));
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";

describe("native sandbox enforcement prerequisites", () => {
  it.each(["darwin", "linux"] as const)("requires %s enforcement by default and in CI", (platform) => {
    expect(shouldSkipNativeSandboxTests(platform, {})).toBe(false);
    expect(shouldSkipNativeSandboxTests(platform, { AVE_SKIP_NATIVE_SANDBOX_TESTS: "1" })).toBe(true);
    expect(shouldSkipNativeSandboxTests(platform, { CI: "true", AVE_SKIP_NATIVE_SANDBOX_TESTS: "1" })).toBe(false);
    expect(shouldSkipNativeSandboxTests(platform, { CI: "false", AVE_SKIP_NATIVE_SANDBOX_TESTS: "1" })).toBe(false);
    expect(shouldSkipNativeSandboxTests(platform, { GITHUB_ACTIONS: "true", AVE_SKIP_NATIVE_SANDBOX_TESTS: "1" })).toBe(false);
  });

  it("skips the unsupported desktop platform explicitly", () => {
    expect(shouldSkipNativeSandboxTests("win32", { CI: "true" })).toBe(true);
  });

  it("fails instead of reporting enforcement after initialization stays inactive", async () => {
    runtime.active = false;
    await expect(initializeRequiredSandbox({ allowedDomains: [] })).rejects.toThrow("enforcement is required");
  });

  it("retains an actual initialization failure", async () => {
    runtime.initialize.mockRejectedValueOnce(new Error("backend launch refused"));
    await expect(initializeRequiredSandbox({ allowedDomains: [] })).rejects.toThrow("backend launch refused");
  });

  it("accepts initialized confinement", async () => {
    runtime.active = true;
    await expect(initializeRequiredSandbox({ allowedDomains: [] })).resolves.toBeUndefined();
    runtime.active = false;
  });
});
