import type { ShellWorkingDirectoryIdentity } from "../permissions/shell-working-directory-identity.js";
import { shellQuote } from "../lib/shell-resolver.js";

export const HOST_SHELL_CWD_REVOKED_EXIT_CODE = 197;

/** Inspect the inherited cwd, then await the host's final policy grant on fd 3. */
export function hostShellWorkingDirectoryPrelude(
  identity: ShellWorkingDirectoryIdentity,
  dialect: "bash" | "powershell",
  platform: NodeJS.Platform,
): string | undefined {
  // Windows binds physical cwd but lacks a matching child-side inode check; rename/replacement after host validation remains possible.
  if (platform !== "darwin" && platform !== "linux") return undefined;
  const statArgs = platform === "darwin" ? ["-f", "%d:%i", "."] : ["-L", "-c", "%d:%i", "--", "."];
  const expected = `${identity.dev}:${identity.ino}`;
  if (dialect === "bash") {
    // A suffix preserves trailing newlines that command substitution would strip.
    return `if [ "$(/bin/pwd -P; printf .)" != ${shellQuote(identity.realpath + "\n.")} ] || ` +
      `[ "$(/usr/bin/stat ${statArgs.map(shellQuote).join(" ")} 2>/dev/null)" != ${shellQuote(expected)} ]; ` +
      `then printf C >&3; exec 3>&- 3<&-; exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; ` +
      `if ! printf R >&3; then exec 3>&- 3<&-; exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; ` +
      `IFS= read -r -n 1 aveHostHandoff <&3; exec 3>&- 3<&-; ` +
      `if [ "$aveHostHandoff" != G ]; then unset aveHostHandoff; exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; ` +
      `unset aveHostHandoff; `;
  }
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return `$aveHostControl = $null; try { ` +
    `$aveHostHandle = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new([IntPtr]3, $true); ` +
    `$aveHostControl = [System.IO.FileStream]::new($aveHostHandle, [System.IO.FileAccess]::ReadWrite, 1, $false); ` +
    `$aveCwdPath = [System.IO.Directory]::GetCurrentDirectory(); ` +
    `$aveCwdIdentity = & /usr/bin/stat ${statArgs.map(quote).join(" ")}; ` +
    `if ($LASTEXITCODE -ne 0 -or $aveCwdPath -cne ${quote(identity.realpath)} -or ` +
    `$aveCwdIdentity -cne ${quote(expected)}) { $aveHostControl.WriteByte(67); $aveHostControl.Flush(); exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE} }; ` +
    `$aveHostControl.WriteByte(82); $aveHostControl.Flush(); $aveHostGrant = $aveHostControl.ReadByte() ` +
    `} catch { exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE} } finally { if ($null -ne $aveHostControl) { $aveHostControl.Dispose() } }; ` +
    `if ($aveHostGrant -ne 71) { exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE} }; ` +
    `Remove-Variable aveHostControl, aveHostHandle, aveHostGrant, aveCwdPath, aveCwdIdentity; `;
}
