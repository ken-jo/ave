$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$directory = Get-Location
$stop = Join-Path $directory 'watcher.stop'
$control = Join-Path $directory 'watcher-processes.json'
$properties = 'ProcessId', 'ParentProcessId', 'Name', 'ExecutablePath', 'CommandLine', 'CreationDate'
$source = 'AveProcessStarts'
$mechanism = 'polling'
$seen = [Collections.Generic.HashSet[string]]::new()
$pipeName = $env:AVE_PROCESS_WATCH_PIPE.Substring('\\.\pipe\'.Length)
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::Out)
$writer = $null

function Write-Record($record) {
  $writer.WriteLine((ConvertTo-Json -InputObject $record -Compress -Depth 6))
}

function Read-Processes($filter) {
  Write-Record @{ kind = 'heartbeat' }
  $query = @{ ClassName = 'Win32_Process'; Property = $properties; OperationTimeoutSec = 2 }
  if ($filter) { $query.Filter = $filter }
  Get-CimInstance @query
}

function Read-Process($row, $observedAt) {
  if ($row.ProcessId -gt 0 -and $row.CreationDate) {
    @{
      pid = $row.ProcessId; parentPid = $row.ParentProcessId; name = $row.Name
      image = $row.ExecutablePath; commandLine = $row.CommandLine
      created = $row.CreationDate.ToUniversalTime().ToString('o')
      observedAt = $observedAt.ToString('o')
    }
  }
}

function Reset-CwdBudget {
  $script:cwdTimer = [Diagnostics.Stopwatch]::new()
  $script:cwdAttempts = $script:cwdUnavailable = $script:cwdSkipped = 0
}

function Add-ProcessCwd($process) {
  if (!$process.created -or !$cwdAvailable) {
    $process.cwdStatus = 'unavailable'
    $script:cwdUnavailable++
  } elseif ($cwdAttempts -ge 32 -or $cwdTimer.ElapsedMilliseconds -ge 150) {
    $process.cwdStatus = 'budget-exhausted'
    $script:cwdSkipped++
  } else {
    $script:cwdAttempts++
    $cwdTimer.Start()
    try {
      $created = [DateTime]::Parse($process.created).ToFileTimeUtc()
      $process.cwd = ReadCurrentDirectory $process.pid $created
    } catch {} finally { $cwdTimer.Stop() }
    $process.cwdStatus = if ($process.cwd) { 'read' } else { 'unavailable' }
    if (!$process.cwd) { $script:cwdUnavailable++ }
  }
}

function Write-CwdCoverage {
  if ($cwdUnavailable -or $cwdSkipped) {
    Write-Record @{ kind = 'cwd-coverage'; unavailable = $cwdUnavailable; budgetExhausted = $cwdSkipped }
  }
}

function Write-Snapshot($kind) {
  $filter = $null
  if ($env:AVE_PROCESS_WATCH_PARENT) {
    $parentId = [uint32]$env:AVE_PROCESS_WATCH_PARENT
    $filter = "ProcessId = $parentId OR ParentProcessId = $parentId"
  }
  # The query start is a conservative lower bound on when each returned row was alive.
  $observedAt = [DateTime]::UtcNow
  $snapshot = @(Read-Processes $filter)
  Reset-CwdBudget
  $rows = @(foreach ($row in $snapshot) {
    $process = Read-Process $row $observedAt
    if (!$process) { continue }
    if ($seen.Add("$($process.pid)/$($process.created)") -and $kind -ne 'baseline') { Add-ProcessCwd $process }
    $process
  })
  Write-Record @{ kind = $kind; rows = $rows }
  Write-CwdCoverage
}

function Write-Start($eventRecord, $draining) {
  $eventTime = [DateTime]::FromFileTimeUtc([long]$eventRecord.TIME_CREATED)
  $id = [uint32]$eventRecord.ProcessID
  $parentId = [uint32]$eventRecord.ParentProcessID
  $observedAt = [DateTime]::UtcNow
  $live = @()
  if (!$draining) { $live = @(Read-Processes "ProcessId = $id OR ProcessId = $parentId") }
  $process = @{
    pid = $id; parentPid = $parentId; name = $eventRecord.ProcessName; created = $null
  }
  $parent = $null
  foreach ($row in $live) {
    if ($row.ProcessId -eq $id -and $row.CreationDate -and $row.CreationDate.ToUniversalTime() -le $eventTime -and
        $row.ParentProcessId -eq $parentId -and $row.Name -eq $eventRecord.ProcessName) {
      $process = Read-Process $row $observedAt
    } elseif ($row.ProcessId -eq $parentId) {
      $parent = Read-Process $row $observedAt
    }
  }
  $process.eventTime = $eventTime.ToString('o')
  Add-ProcessCwd $process
  $rows = @($process)
  if ($parent) { $rows += $parent }
  Write-Record @{ kind = 'trace'; rows = $rows }
}

try {
  $pipe.Connect(6000)
  $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false))
  $writer.AutoFlush = $true
  $launch = [Diagnostics.Stopwatch]::StartNew()
  while (![IO.File]::Exists($control) -and ![IO.File]::Exists($stop) -and $launch.ElapsedMilliseconds -lt 6000) {
    Start-Sleep -Milliseconds 25
  }
  if (![IO.File]::Exists($control) -or [IO.File]::Exists($stop)) { return }
  $cwdAvailable = $true
  try { . (Join-Path $directory 'cwd-probe.ps1') }
  catch { $cwdAvailable = $false }
  if ($env:GITHUB_ACTIONS -ceq 'true' -and $env:AVE_PROCESS_WATCH_TRACE -eq '1') {
    try {
      Write-Record @{ kind = 'heartbeat' }
      Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -OperationTimeoutSec 2 -SourceIdentifier $source |
        Out-Null
      $mechanism = 'Win32_ProcessStartTrace'
    } catch {
      Write-Record @{ kind = 'trace-unavailable' }
    }
  }
  Write-Record @{ kind = 'mechanism'; mechanism = $mechanism; jobRootMatch = 'image path or current directory' }
  Write-Snapshot 'baseline'
  while ($true) {
    $stopping = [IO.File]::Exists($stop)
    if ($mechanism -eq 'Win32_ProcessStartTrace') {
      if (!$stopping) { Wait-Event -SourceIdentifier $source -Timeout 1 | Out-Null }
      Write-Record @{ kind = 'heartbeat' }
      Reset-CwdBudget
      $batch = [Diagnostics.Stopwatch]::StartNew()
      $limit = 32
      foreach ($start in (Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue |
          Select-Object -First ($limit + 1))) {
        if ($limit-- -eq 0 -or $batch.ElapsedMilliseconds -ge 1500) {
          if ($stopping) { Write-Record @{ kind = 'stop-drain-limited' } }
          break
        }
        if (!$stopping -and [IO.File]::Exists($stop)) { break }
        Remove-Event -EventIdentifier $start.EventIdentifier
        Write-Start $start.SourceEventArgs.NewEvent $stopping
      }
      Write-CwdCoverage
    } elseif (!$stopping) {
      Start-Sleep -Milliseconds 250
      if (![IO.File]::Exists($stop)) { Write-Snapshot 'snapshot' }
    }
    if ($stopping) { break }
  }
  Write-Record @{ kind = 'stopped' }
} catch {
  if ($writer) { Write-Record @{ kind = 'collector-failed' } }
} finally {
  if ($writer) { $writer.Dispose() }
  $pipe.Dispose()
}
