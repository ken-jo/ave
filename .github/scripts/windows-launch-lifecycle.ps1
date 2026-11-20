param(
  [Parameter(Mandatory)][ValidateSet('start', 'stop', 'stop-collector')][string]$Mode,
  [Parameter(Mandatory)][string]$Directory,
  [int]$GraceMilliseconds = 6000,
  [string]$NodeExecutable
)

$ErrorActionPreference = 'Stop'
$ownership = Join-Path $Directory 'watcher-ownership.json'
$stop = Join-Path $Directory 'watcher.stop'

function Start-WatcherProcess($executable, $arguments) {
  Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru
}

function Get-Identity($process) {
  $null = $process.Handle
  @{ pid = $process.Id; created = $process.StartTime.ToFileTimeUtc().ToString() }
}

function Open-VerifiedProcess($identity) {
  if ($identity.pid -le 0 -or $identity.created -cnotmatch '^[0-9]+$') {
    throw 'Invalid diagnostic process identity'
  }
  try { $process = [Diagnostics.Process]::GetProcessById($identity.pid) }
  catch [ArgumentException] { return }
  try {
    $null = $process.Handle
    if ($process.StartTime.ToFileTimeUtc().ToString() -eq $identity.created) { return $process }
  } catch {
    if (!$process.HasExited) { $process.Dispose(); throw }
  }
  $process.Dispose()
}

function Read-Ownership {
  try {
    $stream = [IO.File]::Open($ownership, 'Open', 'Read', 'ReadWrite')
    try {
      $reader = [IO.StreamReader]::new($stream)
      $identities = $reader.ReadToEnd() | ConvertFrom-Json
      if (!$identities) { throw 'Empty diagnostic ownership record' }
      return $identities
    } finally {
      if ($reader) { $reader.Dispose() } else { $stream.Dispose() }
    }
  } catch {
    if ($Mode -ne 'stop' -or !$env:AVE_PROCESS_WATCH_OWNERSHIP) { throw }
    return $env:AVE_PROCESS_WATCH_OWNERSHIP | ConvertFrom-Json
  }
}

function Wait-ForExit($processes, $timeout) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  foreach ($process in $processes) {
    $null = $process.WaitForExit([Math]::Max(0, $timeout - $clock.ElapsedMilliseconds))
  }
}

function Stop-VerifiedProcesses($processes) {
  foreach ($process in $processes) {
    try { if ($process.HasExited) { continue } } catch {}
    try {
      $process.Kill()
      Write-Output "Forced diagnostic process exit ($($process.Id))"
    } catch {
      Write-Output "Could not terminate diagnostic process ($($process.Id))"
    }
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $verified = $true
  foreach ($process in $processes) {
    try {
      if ($process.WaitForExit([Math]::Max(0, 3000 - $clock.ElapsedMilliseconds))) { continue }
    } catch {}
    try { if ($process.HasExited) { continue } } catch {}
    Write-Output "Diagnostic process exit could not be verified ($($process.Id))"
    $verified = $false
  }
  if (!$verified) { throw 'Diagnostic process exit could not be verified' }
}

if ($Mode -eq 'start') {
  if ([IO.File]::Exists($ownership) -or [IO.File]::Exists($stop)) { throw 'Diagnostic directory already used' }
  if (![IO.File]::Exists($NodeExecutable) -or $NodeExecutable -ne [IO.Path]::GetFullPath($NodeExecutable)) {
    throw 'An absolute Node executable path is required to start the diagnostic'
  }
  $env:AVE_PROCESS_WATCH_PIPE = '\\.\pipe\ave-process-watch-' + [Guid]::NewGuid().ToString('N')
  foreach ($name in 'HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','AVE_TEST_TMP_ROOT') {
    [Environment]::SetEnvironmentVariable($name, $Directory, 'Process')
  }
  Remove-Item Env:NODE_OPTIONS,Env:PSModulePath -ErrorAction SilentlyContinue
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $PSScriptRoot 'watch-windows-processes.mjs'
  $collectorScript = Join-Path $PSScriptRoot 'watch-windows-processes.ps1'
  $watcher = $collector = $null
  $published = $false
  try {
    $watcher = Start-WatcherProcess $NodeExecutable ('"{0}" watch "{1}"' -f $script, $Directory)
    $watcherIdentity = Get-Identity $watcher
    $collector = Start-WatcherProcess $powershell ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $collectorScript)
    $collectorIdentity = Get-Identity $collector
    $json = @{ watcher = $watcherIdentity; collector = $collectorIdentity } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText("$ownership.tmp", $json)
    [IO.File]::Move("$ownership.tmp", $ownership)
    if ($env:GITHUB_OUTPUT) {
      [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "ownership=$json`n")
    }
    $published = $true
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt 12000 -and !$watcher.HasExited -and !$collector.HasExited) {
      if ([IO.File]::Exists((Join-Path $Directory 'watcher.ready'))) { return }
      Start-Sleep -Milliseconds 75
    }
    Write-Output 'Diagnostic collector did not become ready'
  } finally {
    $owned = @(@($collector, $watcher) | Where-Object { $_ })
    try {
      if (!$published) { Stop-VerifiedProcesses $owned }
    } finally {
      foreach ($process in $owned) { $process.Dispose() }
    }
  }
} else {
  $graceful = $false
  if ($Mode -eq 'stop') {
    try {
      [IO.File]::WriteAllText($stop, '')
      $graceful = $true
    } catch { Write-Output 'Could not signal diagnostic stop' }
  }
  $processes = [Collections.Generic.List[Diagnostics.Process]]::new()
  try {
    $identities = Read-Ownership
    $roles = if ($Mode -eq 'stop') { 'collector', 'watcher' } else { 'collector' }
    $unverified = $false
    foreach ($role in $roles) {
      try {
        $process = Open-VerifiedProcess $identities.$role
        if ($process) { $processes.Add($process) }
      } catch { $unverified = $true }
    }
    if ($graceful) {
      try { Wait-ForExit $processes $GraceMilliseconds }
      catch { Write-Output 'Diagnostic graceful wait failed' }
    }
    Stop-VerifiedProcesses $processes
    if ($unverified) { throw 'Diagnostic process identity could not be verified' }
    if ($Mode -eq 'stop') { Write-Output 'Diagnostic collector and watcher exits verified' }
  } catch {
    if ($Mode -eq 'stop-collector') { throw }
    Write-Output 'Diagnostic collector and watcher exits could not be verified'
  } finally {
    foreach ($process in $processes) { $process.Dispose() }
  }
}
