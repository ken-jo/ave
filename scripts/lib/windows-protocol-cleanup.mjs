/**
 * Owner-only removal of the HKCU `ave://` registration a packaged Windows
 * build writes for itself when launched outside an NSIS install (no
 * per-machine marker beside the executable). A launch from win-unpacked
 * claims `ave://` for that executable; leaving it behind would point the
 * user's deep links at a build directory that is deleted afterwards. Only
 * values that name exactly `executable` are removed, and empty keys after
 * that; the call throws when the registration it expects is missing or is
 * owned by another executable. A no-op off Windows.
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
  "if ($null -eq $rootKey) { throw 'expected win-unpacked HKCU ave protocol root is missing' }",
  "$rootKey.Dispose()",
  "$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($commandPath, $false)",
  "if ($null -eq $commandKey) { throw 'ave protocol root exists without an owned command' }",
  "try {",
  "  $commandKind = $commandKey.GetValueKind('')",
  "  $command = [string]$commandKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "} finally { $commandKey.Dispose() }",
  "if ($commandKind -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'refusing to remove a non-owned ave protocol command kind' }",
  "$expectedCommand = '\"' + $env:AVE_PROTOCOL_OWNER_EXE + '\" \"%1\"'",
  "if (-not [string]::Equals($command, $expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'refusing to remove a non-owned ave protocol command' }",
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
  ")) { Remove-EmptyRegistryKey $path }",
].join("\n");

export function cleanupOwnedWindowsProtocolHandler(executable) {
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
      `packaged Windows protocol cleanup failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `packaged Windows protocol cleanup failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
}
