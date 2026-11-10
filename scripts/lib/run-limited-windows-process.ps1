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

# A hosted runner may have no linked token because consent is disabled. Build a
# restricted primary token explicitly, denying the administrators SID and all
# optional privileges. The child verifies its effective membership before launch.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class LimitedProcess {
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2; public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, ref SidAndAttributes disable, uint deleteCount, IntPtr delete, uint restrictCount, IntPtr restrict, out IntPtr restricted);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string value, out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int informationClass, ref SidAndAttributes information, uint length);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, StringBuilder commandLine, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static uint Run(string application, string arguments, string directory, uint timeout) {
    IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, sid = IntPtr.Zero, mediumSid = IntPtr.Zero;
    var process = new ProcessInformation();
    try {
      Check(OpenProcessToken(GetCurrentProcess(), 0x000F01FF, out token));
      Check(ConvertStringSidToSid("S-1-5-32-544", out sid));
      var disable = new SidAndAttributes { Sid = sid };
      Check(CreateRestrictedToken(token, 1, 1, ref disable, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted));
      Check(ConvertStringSidToSid("S-1-16-8192", out mediumSid));
      var label = new SidAndAttributes { Sid = mediumSid, Attributes = 0x20 };
      Check(SetTokenInformation(restricted, 25, ref label, (uint)Marshal.SizeOf(typeof(SidAndAttributes)) + GetLengthSid(mediumSid)));
      var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)) };
      Check(CreateProcessWithTokenW(restricted, 0, application, new StringBuilder("\"" + application + "\" " + arguments), 0x08000000, IntPtr.Zero, directory, ref startup, out process));
      if (WaitForSingleObject(process.process, timeout) != 0) {
        using (var killer = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
          FileName = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"),
          Arguments = "/PID " + process.processId + " /T /F", UseShellExecute = false, CreateNoWindow = true
        })) { killer.WaitForExit(); }
        throw new TimeoutException("The restricted launcher timed out");
      }
      uint code; Check(GetExitCodeProcess(process.process, out code)); return code;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (sid != IntPtr.Zero) LocalFree(sid);
      if (mediumSid != IntPtr.Zero) LocalFree(mediumSid);
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
$code = [LimitedProcess]::Run($powershell, $command, $WorkingDirectory, $remaining)
if (-not (Test-Path -LiteralPath $ReportPath)) { throw "The restricted launcher produced no report (exit $code)" }
Get-Content -LiteralPath $ReportPath -Raw
exit $code
