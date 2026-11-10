param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][long]$DeadlineUnixMs,
  [string]$ExpectedUserSid,
  [switch]$LimitedChild
)
$ErrorActionPreference = 'Stop'

if ($LimitedChild) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -ne $ExpectedUserSid) { throw 'The limited launcher changed user identity' }
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($admin) { throw 'The uninstall launcher still has an administrator token' }
  $medium = ((& whoami.exe /groups /fo csv /nh) -match 'S-1-16-8192').Count -eq 1
  if (-not $medium) { throw 'The uninstall launcher is not at medium integrity' }
  $arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $FilePath
  $start.Arguments = $arguments -join ' '
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $process = [Diagnostics.Process]::Start($start)
  $remaining = [int][Math]::Max(1, $DeadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 10000)
  if (-not $process.WaitForExit($remaining)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    throw 'The limited-token uninstall timed out'
  }
  $process.Refresh()
  [ordered]@{ administrator = $admin; mediumIntegrity = $medium; userSid = $identity.User.Value; exitCode = $process.ExitCode } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  exit $process.ExitCode
}

# Use the primary token of the still-running filtered owner bootstrap.
# A linked-token query does not grant ordinary administrators a primary token.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class LimitedProcess {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2; public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, StringBuilder commandLine, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
  static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  public static uint Run(string application, string arguments, string directory, uint timeout, uint ownerProcessId) {
    IntPtr owner = IntPtr.Zero, token = IntPtr.Zero;
    var process = new ProcessInformation();
    try {
      owner = OpenProcess(0x1000, false, ownerProcessId);
      Check(owner != IntPtr.Zero, "Open filtered owner process");
      Check(OpenProcessToken(owner, 0x000B, out token), "Open filtered owner primary token");
      using (var identity = new System.Security.Principal.WindowsIdentity(token)) {
        if (!identity.User.Equals(System.Security.Principal.WindowsIdentity.GetCurrent().User) ||
            new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) {
          throw new InvalidOperationException("The owner token has the wrong SID or elevation");
        }
      }
      var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)) };
      Check(CreateProcessWithTokenW(token, 0, application, new StringBuilder("\"" + application + "\" " + arguments), 0x08000000, IntPtr.Zero, directory, ref startup, out process), "Create filtered owner process");
      if (WaitForSingleObject(process.process, timeout) != 0) {
        using (var killer = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
          FileName = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"),
          Arguments = "/PID " + process.processId + " /T /F", UseShellExecute = false, CreateNoWindow = true
        })) { killer.WaitForExit(); }
        throw new TimeoutException("The restricted launcher timed out");
      }
      uint code; Check(GetExitCodeProcess(process.process, out code), "Read filtered child exit"); return code;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (owner != IntPtr.Zero) CloseHandle(owner);
    }
  }
}
'@

foreach ($value in @($PSCommandPath, $FilePath, $WorkingDirectory, $ReportPath)) {
  if ($value.Contains('"')) { throw 'A launcher path contains a quote' }
}
$powershell = Join-Path $PSHOME 'powershell.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$command = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -LimitedChild -FilePath "{1}" -ArgumentsBase64 {2} -WorkingDirectory "{3}" -ReportPath "{4}" -DeadlineUnixMs {5} -ExpectedUserSid {6}' -f $PSCommandPath, $FilePath, $ArgumentsBase64, $WorkingDirectory, $ReportPath, $DeadlineUnixMs, $sid
$remaining = [uint32][Math]::Max(1, $DeadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 5000)
if (-not $env:AVE_WINDOWS_SMOKE_FILTERED_PID) { throw 'The filtered owner bootstrap is not available' }
$code = [LimitedProcess]::Run($powershell, $command, $WorkingDirectory, $remaining, [uint32]$env:AVE_WINDOWS_SMOKE_FILTERED_PID)
if (-not (Test-Path -LiteralPath $ReportPath)) { throw "The restricted launcher produced no report (exit $code)" }
Get-Content -LiteralPath $ReportPath -Raw
exit $code
