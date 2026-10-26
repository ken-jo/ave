// Plugins supply only a validated drive letter; the host owns the lookup command and never invokes a shell. Null means no UNC backing; lookup failure
// throws. Do not cache mappings because they can change during a session.
import { execFile } from "node:child_process";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { win32SystemBinary } from "../../shared/windows-system-path.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `C:`-shaped, and nothing else. Anchored, so no suffix can ride along.
const DRIVE_LETTER = /^[A-Za-z]:$/u;

// Raised when the drive letter is not one. A programming error on the calling side rather than a condition to handle, which is why it is distinct from the `null` answer.
export class InvalidDriveLetterError extends Error {
  constructor(value: string) {
    super(
      `[mapped-drive-root] not a drive letter: ${JSON.stringify(value)}. `
        + "Expected exactly two characters, a letter and a colon, e.g. 'Z:'.",
    );
    this.name = "InvalidDriveLetterError";
  }
}

// Interpolate only a revalidated ASCII drive letter; query both session and OS mappings because neither covers all drives.
function lookupScript(letter: string): string {
  return [
    `$drive = Get-PSDrive -Name '${letter}' -ErrorAction SilentlyContinue`,
    "| Select-Object -ExpandProperty DisplayRoot;",
    "if (-not $drive) {",
    `$drive = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'"`,
    "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProviderName);",
    "}",
    "if ($drive) { Write-Output $drive }",
  ].join(" ");
}

// What the lookup needs from the platform, so a test can supply its own.
export interface MappedDriveRootDeps {
  // `process.platform`, injected so the non-Windows answer is testable.
  readonly platform: () => NodeJS.Platform;
  // Runs the lookup and returns its stdout.
  readonly runLookup: (script: string) => Promise<string>;
}

const defaultDeps: MappedDriveRootDeps = {
  platform: () => process.platform,
  runLookup: async (script) => {
    const { stdout } = await execFileAsync(win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { env: windowsPowerShellEnv() });
    return stdout;
  },
};

// Resolve `drive` (`"Z:"`) to the UNC root behind it, or `null` when there is none. Every non-Windows platform answers `null` because a mapped drive is
// not a thing there — that is a complete answer, not a failure to look.
export async function resolveMappedDriveRoot(
  drive: string,
  deps: MappedDriveRootDeps = defaultDeps,
): Promise<string | null> {
  if (!DRIVE_LETTER.test(drive)) throw new InvalidDriveLetterError(drive);
  if (deps.platform() !== "win32") return null;

  const letter = drive[0]!.toUpperCase();
  const stdout = await deps.runLookup(lookupScript(letter));
  // Backslash-canonical and trailing-separator-free, because the caller compares it against paths by prefix and `\\server\share` and `\\server\share\`
  // would not match the same set.
  const unc = stdout.trim().replace(/\//gu, "\\").replace(/\\+$/u, "");
  return unc.startsWith("\\\\") ? unc : null;
}
