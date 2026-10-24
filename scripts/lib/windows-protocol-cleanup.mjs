/**
 * Proof that an isolated packaged Windows launch left the user's HKCU
 * `ave://` handler alone. The smokes launch win-unpacked with a temporary
 * `AVE_HOME` and `--user-data-dir`, and the app must then skip
 * `setAsDefaultProtocolClient` (src/main/ave-protocol-registration.ts). A
 * claim naming exactly `executable` is a regression: its values are removed
 * (and empty keys after that), so the host is left as it was, and the call
 * throws. A missing root, or a registration owned by another executable,
 * passes untouched. A no-op off Windows.
 */
import { spawnSync } from "node:child_process";

const WINDOWS_PROTOCOL_CLEANUP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rootPath = 'Software\\Classes\\ave'",
  "$commandPath = 'Software\\Classes\\ave\\shell\\open\\command'",
  "function Remove-RegistryValueIfEquals([string]$path, [string]$name, [string]$expected, [System.StringComparison]$comparison) {",
  "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)",
  "  if ($null -eq $key) { return }",
  "  try {",
  "    if (-not (@($key.GetValueNames()) -contains $name)) { return }",
  "    if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) { return }",
  "    $value = [string]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "    if ([string]::Equals($value, $expected, $comparison)) { $key.DeleteValue($name, $false) }",
  "  } finally { $key.Dispose() }",
  "}",
  "function Remove-EmptyRegistryKey([string]$path) {",
  "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)",
  "  if ($null -eq $key) { return }",
  "  $empty = $false",
  "  try {",
  "    $empty = @($key.GetValueNames()).Count -eq 0 -and @($key.GetSubKeyNames()).Count -eq 0",
  "  } finally { $key.Dispose() }",
  "  if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($path, $false) }",
  "}",
  "$rootKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($rootPath, $false)",
  "if ($null -eq $rootKey) { Write-Output 'absent'; exit 0 }",
  "$rootKey.Dispose()",
  "$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($commandPath, $false)",
  "if ($null -eq $commandKey) { Write-Output 'foreign'; exit 0 }",
  "try {",
  "  $commandKind = $commandKey.GetValueKind('')",
  "  $command = [string]$commandKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "} finally { $commandKey.Dispose() }",
  "if ($commandKind -ne [Microsoft.Win32.RegistryValueKind]::String) { Write-Output 'foreign'; exit 0 }",
  "$expectedCommand = '\"' + $env:AVE_PROTOCOL_OWNER_EXE + '\" \"%1\"'",
  "if (-not [string]::Equals($command, $expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) { Write-Output 'foreign'; exit 0 }",
  "$expectedIcon = '\"' + $env:AVE_PROTOCOL_OWNER_EXE + '\",0'",
  "Remove-RegistryValueIfEquals $commandPath '' $expectedCommand ([System.StringComparison]::OrdinalIgnoreCase)",
  "Remove-RegistryValueIfEquals 'Software\\Classes\\ave\\DefaultIcon' '' $expectedIcon ([System.StringComparison]::OrdinalIgnoreCase)",
  "Remove-RegistryValueIfEquals $rootPath 'URL Protocol' '' ([System.StringComparison]::Ordinal)",
  "Remove-RegistryValueIfEquals $rootPath '' 'URL:ave' ([System.StringComparison]::Ordinal)",
  "foreach ($path in @(",
  "  $commandPath,",
  "  'Software\\Classes\\ave\\shell\\open',",
  "  'Software\\Classes\\ave\\shell',",
  "  'Software\\Classes\\ave\\DefaultIcon',",
  "  $rootPath",
  )) { Remove-EmptyRegistryKey $path }",
  "Write-Output 'removed'",
].join("\n");

export function assertNoWindowsProtocolClaim(executable) {
  if (process.platform !== "win32") return;

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_PROTOCOL_CLEANUP_SCRIPT,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AVE_PROTOCOL_OWNER_EXE: executable,
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(
      `packaged Windows protocol check failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `packaged Windows protocol check failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  const outcome = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (outcome === "absent" || outcome === "foreign") return;
  if (outcome === "removed") {
    throw new Error(
      "an isolated packaged launch claimed HKCU ave:// for its own executable; the claim was removed",
    );
  }
  throw new Error(`packaged Windows protocol check returned an unexpected outcome: ${outcome}`);
}
