import { resolveTrustedPowerShellExecutable } from "./powershell-executable.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";

export const POWERSHELL_STARTUP_ARGS = Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive"]);
export const MXC_POWERSHELL_STARTUP_ARGS = Object.freeze([...POWERSHELL_STARTUP_ARGS, "-ExecutionPolicy", "RemoteSigned"]);

// The container route uses the fixed startup argv above. Other Windows paths
// remain unproven; supported POSIX hosts also isolate configuration at startup.
export function isPowerShellStartupPinned(platform: NodeJS.Platform = process.platform, plan?: HostShellExecutionPlan): boolean {
  if (platform === "win32") return plan?.platform === "win32" && plan.requestedSandbox
    && plan.executionRequest === "default" && plan.mode === "asrt" && plan.sandboxed && plan.substrate === "mxc";
  if (platform !== "darwin" && platform !== "linux") return false;
  const installation = resolveTrustedPowerShellExecutable(platform);
  return installation?.kind === "pwsh";
}

export const POWERSHELL_STARTUP_UNPROVEN_REASON = "PowerShell startup configuration is not pinned on this launch path";
