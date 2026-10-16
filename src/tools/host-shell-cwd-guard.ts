import type { ShellWorkingDirectoryIdentity } from "../permissions/shell-working-directory-identity.js";
import { shellQuote } from "../lib/shell-resolver.js";

export const HOST_SHELL_CWD_REVOKED_EXIT_CODE = 197;

/** Host-authored prelude: inspect the child's inherited cwd before any user command. */
export function hostShellWorkingDirectoryPrelude(
  identity: ShellWorkingDirectoryIdentity,
  dialect: "bash" | "powershell",
  platform: NodeJS.Platform,
): string | undefined {
  // Native Windows shells do not expose a portable stat device/inode pair
  // matching the host filesystem API. They still spawn with the bound physical
  // realpath, but directory rename/replacement after the host check remains a
  // platform limitation until a native child-side file-identity check exists.
  if (platform !== "darwin" && platform !== "linux") return undefined;
  const statArgs = platform === "darwin" ? ["-f", "%d:%i", "."] : ["-L", "-c", "%d:%i", "--", "."];
  const expected = `${identity.dev}:${identity.ino}`;
  if (dialect === "bash") {
    // A suffix preserves trailing newlines that command substitution would strip.
    return `if [ "$(/bin/pwd -P; printf .)" != ${shellQuote(identity.realpath + "\n.")} ] || ` +
      `[ "$(/usr/bin/stat ${statArgs.map(shellQuote).join(" ")} 2>/dev/null)" != ${shellQuote(expected)} ]; ` +
      `then exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE}; fi; `;
  }
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return `try { $aveCwdPath = [System.IO.Directory]::GetCurrentDirectory() } catch { exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE} }; ` +
    `$aveCwdIdentity = & /usr/bin/stat ${statArgs.map(quote).join(" ")}; ` +
    `if ($LASTEXITCODE -ne 0 -or $aveCwdPath -cne ${quote(identity.realpath)} -or ` +
    `$aveCwdIdentity -cne ${quote(expected)}) { exit ${HOST_SHELL_CWD_REVOKED_EXIT_CODE} }; ` +
    `Remove-Variable aveCwdPath, aveCwdIdentity; `;
}
