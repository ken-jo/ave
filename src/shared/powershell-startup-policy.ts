import { resolveTrustedPowerShellExecutable } from "./powershell-executable.js";

// Startup proof includes the image and its installation, not merely the OS.
// Protected image admission alone does not prove registry-selected startup.
// Only supported POSIX hosts also isolate configuration before startup.
export function isPowerShellStartupPinned(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin" && platform !== "linux") return false;
  const installation = resolveTrustedPowerShellExecutable(platform);
  return installation?.kind === "pwsh";
}

export const POWERSHELL_STARTUP_UNPROVEN_REASON = "PowerShell startup configuration is not pinned on this launch path";
