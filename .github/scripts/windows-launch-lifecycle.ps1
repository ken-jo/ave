param(
  [Parameter(Mandatory)][ValidateSet('start', 'stop', 'stop-collector')][string]$Mode,
  [Parameter(Mandatory)][string]$Directory,
  [int]$GraceMilliseconds = 6000
)

$ErrorActionPreference = 'Stop'
$manifest = Join-Path $Directory 'watcher-processes.json'
$stop = Join-Path $Directory 'watcher.stop'

function Start-WatcherProcess($executable, $arguments) {
  Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru
}

function Get-Identity($process) {
  $null = $process.Handle
  @{ pid = $process.Id; created = $process.StartTime.ToFileTimeUtc().ToString() }
}

function Open-VerifiedProcess($identity) {
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

function Wait-ForExit($processes, $timeout) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  foreach ($process in $processes) {
    $null = $process.WaitForExit([Math]::Max(0, $timeout - $clock.ElapsedMilliseconds))
  }
}

function Stop-VerifiedProcesses($processes) {
  foreach ($process in $processes) {
    try {
      if (!$process.HasExited) {
        $process.Kill()
        Write-Output "Forced diagnostic process exit ($($process.Id))"
      }
    } catch {
      if (!$process.HasExited) { Write-Output "Could not terminate diagnostic process ($($process.Id))" }
    }
  }
  Wait-ForExit $processes 3000
  foreach ($process in $processes) {
    if (!$process.HasExited) { throw 'Diagnostic process exit could not be verified' }
  }
}

if ($Mode -eq 'start') {
  if ([IO.File]::Exists($manifest) -or [IO.File]::Exists($stop)) { throw 'Diagnostic directory already used' }
  $env:AVE_PROCESS_WATCH_PIPE = '\\.\pipe\ave-process-watch-' + [Guid]::NewGuid().ToString('N')
  foreach ($name in 'HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','AVE_TEST_TMP_ROOT') {
    [Environment]::SetEnvironmentVariable($name, $Directory, 'Process')
  }
  Remove-Item Env:NODE_OPTIONS,Env:PSModulePath -ErrorAction SilentlyContinue
  $node = (Get-Command node.exe -CommandType Application).Source
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $PSScriptRoot 'watch-windows-processes.mjs'
  $collectorScript = Join-Path $PSScriptRoot 'watch-windows-processes.ps1'
  $watcher = $collector = $null
  $published = $false
  try {
    $watcher = Start-WatcherProcess $node ('"{0}" watch "{1}"' -f $script, $Directory)
    $watcherIdentity = Get-Identity $watcher
    $collector = Start-WatcherProcess $powershell ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $collectorScript)
    $collectorIdentity = Get-Identity $collector
    $json = @{ watcher = $watcherIdentity; collector = $collectorIdentity } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText("$manifest.tmp", $json)
    [IO.File]::Move("$manifest.tmp", $manifest)
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
  if ($Mode -eq 'stop') { [IO.File]::WriteAllText($stop, '') }
  if (![IO.File]::Exists($manifest)) { return }
  $identities = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
  $processes = [Collections.Generic.List[Diagnostics.Process]]::new()
  try {
    $roles = if ($Mode -eq 'stop') { 'collector', 'watcher' } else { 'collector' }
    $unverified = $false
    foreach ($role in $roles) {
      try {
        $process = Open-VerifiedProcess $identities.$role
        if ($process) { $processes.Add($process) }
      } catch { $unverified = $true }
    }
    if ($Mode -eq 'stop') { Wait-ForExit $processes $GraceMilliseconds }
    Stop-VerifiedProcesses $processes
    if ($unverified) { throw 'Diagnostic process identity could not be verified' }
    if ($Mode -eq 'stop') { Write-Output 'Diagnostic collector and watcher exits verified' }
  } finally {
    foreach ($process in $processes) { $process.Dispose() }
  }
}
