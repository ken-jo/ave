import { vi } from "vitest";

// Static permission fixtures supply a protected host installation explicitly.
// Executable admission tests use the real resolver instead of this fixture.
vi.mock("../../shared/powershell-executable.js", () => ({
  resolveTrustedPowerShellExecutable: vi.fn((platform: NodeJS.Platform = process.platform) =>
    platform === "darwin" || platform === "linux"
      ? { executable: "/opt/microsoft/powershell/7/pwsh", kind: "pwsh" }
      : null),
}));
