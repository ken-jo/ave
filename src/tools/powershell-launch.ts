import { WIN32_POWERSHELL_STARTUP_ARGS, POWERSHELL_STARTUP_ARGS } from "../shared/powershell-startup-policy.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { createSandboxProcessHome, type SandboxProcessHome } from "../permissions/sandbox-process-home.js";

export interface PowerShellLaunch {
  readonly args: string[];
  readonly env: Record<string, string>;
  cleanup(): void;
}

export function retainPowerShellLaunchUntilExit(launch: PowerShellLaunch, child: ChildProcess): void {
  const handleError = (): void => {
    // A failed signal or IPC operation can emit an error while startup is live.
    // Keep its configuration until exit, not merely until an operation fails.
    if (child.pid === undefined || typeof child.exitCode === "number" || typeof child.signalCode === "string") launch.cleanup();
  };
  child.on("error", handleError);
  child.once("close", () => {
    child.off("error", handleError);
    launch.cleanup();
  });
}

// Import by absolute installation path before any caller command can run.
// Setting only the inherited module path does not control startup augmentation.
export const POWERSHELL_MODULE_PRELUDE = [
  "try {",
  "$PSModuleAutoLoadingPreference = 'None';",
  "$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules');",
  "Microsoft.PowerShell.Core\\Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -Global -ErrorAction Stop;",
  "Microsoft.PowerShell.Core\\Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')) -Global -ErrorAction Stop;",
  "} catch { [System.Console]::Error.WriteLine('Shell module initialization failed'); exit 197 };\n",
].join(" ");

// Windows PowerShell's web cmdlets and WebClient take the system proxy, never HTTPS_PROXY, and a sandboxed command reaches the
// network only through the egress proxy that variable names. Route them through it; with no proxy named nothing changes.
export const POWERSHELL_EGRESS_PROXY_PRELUDE =
  "& { $proxy = $env:HTTPS_PROXY; if (-not $proxy) { $proxy = $env:HTTP_PROXY }; if ($proxy) { [System.Net.WebRequest]::DefaultWebProxy = [System.Net.WebProxy]::new($proxy) } };\n";

export function preparePowerShellLaunch(
  command: string,
  baseEnv: Readonly<Record<string, string>>,
  profile?: SandboxProcessHome,
  options: { sandboxEgressProxy?: boolean } = {},
): PowerShellLaunch {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const args = [...(process.platform === "win32" ? WIN32_POWERSHELL_STARTUP_ARGS : POWERSHELL_STARTUP_ARGS)];
  let ownedProfile: SandboxProcessHome | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    ownedProfile?.cleanup();
  };
  try {
    if (process.platform === "win32") {
      // Owner decision (2026-11-06) accepts the legacy registry session-configuration
      // gap as equivalent to the reference no-profile launch; absence is not proven.
      // Windows host execution independently requires per-invocation consent;
      // installation admission still supplies image and module integrity.
      env.PSModulePath = "";
    } else {
      const configurationProfile = profile ?? (ownedProfile = createSandboxProcessHome());
      const configurationRoot = mkdtempSync(join(configurationProfile.path, "powershell-config-"));
      const moduleSeed = join(configurationRoot, "modules");
      mkdirSync(moduleSeed, { mode: 0o700 });
      const settingsFile = join(configurationRoot, "settings.json");
      writeFileSync(settingsFile, "{}\n", { flag: "wx", mode: 0o600 });
      env.XDG_CONFIG_HOME = configurationRoot;
      env.PSModulePath = moduleSeed;
      args.push("-SettingsFile", settingsFile);
    }
    const egressProxyPrelude = options.sandboxEgressProxy === true && process.platform === "win32" ? POWERSHELL_EGRESS_PROXY_PRELUDE : "";
    args.push("-Command", POWERSHELL_MODULE_PRELUDE + egressProxyPrelude + command);
    return { args, env, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
