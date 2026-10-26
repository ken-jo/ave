// A command prelude cannot neutralize an endpoint selected before it runs.
// Supported POSIX launches isolate both configuration scopes before startup.
export function isPowerShellStartupPinned(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export const POWERSHELL_STARTUP_UNPROVEN_REASON = "PowerShell startup configuration is not pinned on this launch path";
