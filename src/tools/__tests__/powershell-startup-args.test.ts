import { afterEach, expect, it, vi } from "vitest";
import { preparePowerShellLaunch } from "../powershell-launch.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("../../shared/powershell-startup-policy.js", async original => ({
  ...await original<typeof import("../../shared/powershell-startup-policy.js")>(),
  MXC_POWERSHELL_STARTUP_ARGS: ["-fixture-startup", "-fixture-policy"],
}));
const originalPlatform = process.platform;
afterEach(() => { setProcessPlatform(originalPlatform); });

it("takes the complete Windows startup argv from the shared table", () => {
  setProcessPlatform("win32");
  const launch = preparePowerShellLaunch("Get-Date", {});
  try { expect(launch.args.slice(0, -2)).toEqual(["-fixture-startup", "-fixture-policy"]); }
  finally { launch.cleanup(); }
});
