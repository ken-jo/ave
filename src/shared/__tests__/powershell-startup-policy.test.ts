import { describe, expect, it } from "vitest";
import { isPowerShellStartupPinned } from "../powershell-startup-policy.js";

describe("managed shell startup capabilities", () => {
  it.each(["darwin", "linux"] as const)("supports isolated startup on %s", (platform) => {
    expect(isPowerShellStartupPinned(platform)).toBe(true);
  });
  it.each(["win32", "freebsd", "aix"] as const)("refuses an unproved startup path on %s", (platform) => {
    expect(isPowerShellStartupPinned(platform)).toBe(false);
  });
});
