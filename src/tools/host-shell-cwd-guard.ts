import type { ShellWorkingDirectoryIdentity } from "../permissions/shell-working-directory-identity.js";
import { shellQuote } from "../lib/shell-resolver.js";

export const HOST_SHELL_CWD_REVOKED_EXIT_CODE = 197;

/** Inspect the inherited cwd, then await the host's final policy grant on fd 3. */
export function hostShellWorkingDirectoryPrelude(
  identity: ShellWorkingDirectoryIdentity,
  dialect: "bash" | "powershell",
  platform: NodeJS.Platform,
): string | undefined {
  // Windows has no child-side check: a permit-bearing launch runs in a job tied to a host-held directory chain until the child closes (holdHostShellSpawnDirectory); a leaf whose contents can be removed can still become a junction in place.
  if (platform !== "darwin" && platform !== "linux") return undefined;
  if (dialect === "bash") {
    return posixWorkingDirectoryCheck(identity, platform, "/bin/pwd -P", ">&3") +
      `IFS= read -r -n 1 aveHostHandoff <&3; exec 3>&- 3<&-; ` +
      `if [ "$aveHostHandoff" != G ]; then unset aveHostHandoff; exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; ` +
      `unset aveHostHandoff; `;
  }
  const statArgs = statIdentityArgs(platform);
  const expected = `${identity.dev}:${identity.ino}`;
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

function statIdentityArgs(platform: "darwin" | "linux"): readonly string[] {
  return platform === "darwin" ? ["-f", "%d:%i", "."] : ["-L", "-c", "%d:%i", "--", "."];
}

// The shared comparison: the physical cwd path and its dev:inode, then one ready byte, or a refusal byte and exit.
function posixWorkingDirectoryCheck(
  identity: ShellWorkingDirectoryIdentity, platform: "darwin" | "linux", pwd: "/bin/pwd -P" | "pwd -P", report: ">&3" | "",
): string {
  const close = report === "" ? "" : "exec 3>&- 3<&-; ";
  // A suffix preserves trailing newlines that command substitution would strip.
  return `if [ "$(${pwd}; printf .)" != ${shellQuote(identity.realpath + "\n.")} ] || ` +
    `[ "$(/usr/bin/stat ${statIdentityArgs(platform).map(shellQuote).join(" ")} 2>/dev/null)" != ${shellQuote(`${identity.dev}:${identity.ino}`)} ]; ` +
    `then printf C${report && ` ${report}`}; ${close}exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; ` +
    `if ! printf R${report && ` ${report}`}; then ${close}exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; `;
}

/**
 * The macOS container shell's form of the same check. The SDK passes the workload no descriptor beyond its standard
 * streams, and those pipes end in the native shell supervisor alone: the ready or refusal byte is the first byte on
 * stdout, which the supervisor takes off before any output is forwarded, and the grant is a line on stdin, which the
 * supervisor then ends. The SDK starts every command under /bin/sh, so this runs before Bash or PowerShell is
 * exec'd, and the interpreter inherits the directory it verified. The shell's own `pwd -P` names the physical path:
 * under Seatbelt, /bin/pwd is refused where the cwd's ancestors are not readable. The container's environment is an
 * allowlist, so no imported function can stand in for it.
 */
export function containerShellWorkingDirectoryPrelude(identity: ShellWorkingDirectoryIdentity): string {
  return posixWorkingDirectoryCheck(identity, "darwin", "pwd -P", "") +
    `IFS= read -r aveHostHandoff; ` +
    `if [ "$aveHostHandoff" != G ]; then unset aveHostHandoff; exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; ` +
    `unset aveHostHandoff; `;
}

/** The bytes the container shell's prelude reads as its grant. */
export const CONTAINER_SHELL_CWD_GRANT = "G\n";
