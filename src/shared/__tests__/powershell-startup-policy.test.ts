import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTrustedPowerShellExecutable } from "../powershell-executable.js";
import { isPowerShellStartupPinned } from "../powershell-startup-policy.js";

vi.mock("../powershell-executable.js", () => ({ resolveTrustedPowerShellExecutable: vi.fn() }));

beforeEach(() => { vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue(null); });

describe("managed shell startup capabilities", () => {
  it.each(["darwin", "linux", "win32"] as const)("refuses an unverified executable on %s", (platform) => {
    expect(isPowerShellStartupPinned(platform)).toBe(false);
  });
  it.each(["darwin", "linux"] as const)("supports isolated startup only with a protected installation on %s", (platform) => {
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue({ executable: "/opt/microsoft/powershell/7/pwsh", kind: "pwsh" });
    expect(isPowerShellStartupPinned(platform)).toBe(true);
    expect(resolveTrustedPowerShellExecutable).toHaveBeenLastCalledWith(platform);
  });
  it("refuses the protected system edition while user registry startup remains unproved", () => {
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue({ executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", kind: "windows-powershell" });
    expect(isPowerShellStartupPinned("win32")).toBe(false);
  });
  it("does not transfer that proof to a modern Windows installation with user JSON startup", () => {
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue({ executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", kind: "pwsh" });
    expect(isPowerShellStartupPinned("win32")).toBe(false);
  });
  it.each(["freebsd", "aix"] as const)("refuses an unsupported startup path on %s", (platform) => {
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue({ executable: "/opt/microsoft/powershell/7/pwsh", kind: "pwsh" });
    expect(isPowerShellStartupPinned(platform)).toBe(false);
  });
});
