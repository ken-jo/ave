import type { WindowsAclHostLaunch } from "../../main/windows-acl-host.js";
export { windowsCommandLineLength } from "../../shared/windows-command-line.js";

const BOOTSTRAP_PREFIX = "& { $ErrorActionPreference = 'Stop'; $hostRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace(); try { $hostRunspace.ThreadOptions = 'UseCurrentThread'; $hostRunspace.Open(); $hostShell = [PowerShell]::Create(); try { $hostShell.Runspace = $hostRunspace; [void]$hostShell.AddScript([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
const BOOTSTRAP_SUFFIX = "'))); try { $hostShell.Invoke() } catch { throw $hostShell.InvocationStateInfo.Reason.ErrorRecord } } finally { $hostShell.Dispose() } } finally { $hostRunspace.Dispose() } }";

export function decodeWindowsAclScript(args: readonly string[]): string {
  const bootstrap = args[4] ?? "";
  if (args.length !== 5 || args[3] !== "-Command"
    || !bootstrap.startsWith(BOOTSTRAP_PREFIX) || !bootstrap.endsWith(BOOTSTRAP_SUFFIX)) {
    throw new Error("Unexpected access host bootstrap");
  }
  const payload = bootstrap.slice(BOOTSTRAP_PREFIX.length, -BOOTSTRAP_SUFFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error("Invalid access host payload");
  return Buffer.from(payload, "base64").toString("utf8");
}

export function withWindowsAclScript(launch: WindowsAclHostLaunch, script: string): WindowsAclHostLaunch {
  decodeWindowsAclScript(launch.args);
  return { ...launch, args: [...launch.args.slice(0, 4),
    BOOTSTRAP_PREFIX + Buffer.from(script, "utf8").toString("base64") + BOOTSTRAP_SUFFIX] };
}
