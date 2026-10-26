import { resolveTrustedPowerShellExecutable } from "./powershell-executable.js";

// Startup proof includes the image and its installation, not merely the OS.
// The selected system edition has no user JSON endpoint selection; a modern
// POSIX host additionally receives isolated configuration before startup.
export function isPowerShellStartupPinned(platform: NodeJS.Platform = process.platform): boolean {
  const installation = resolveTrustedPowerShellExecutable(platform);
  if (installation === null) return false;
  return platform === "win32"
    ? installation.kind === "windows-powershell"
    : (platform === "darwin" || platform === "linux") && installation.kind === "pwsh";
}

export const POWERSHELL_STARTUP_UNPROVEN_REASON = "PowerShell startup configuration is not pinned on this launch path";
