$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$directory = Get-Location
$stop = Join-Path $directory 'watcher.stop'
$control = Join-Path $directory 'watcher-ownership.json'
$properties = 'ProcessId', 'ParentProcessId', 'Name', 'ExecutablePath', 'CommandLine', 'CreationDate'
$mediaImages = 'setup_wm.exe', 'unregmp2.exe', 'wmplayer.exe', 'wmpnscfg.exe', 'wmpnetwk.exe'
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

function Read-Process($row) {
  if ($row.ProcessId -gt 0 -and $row.CreationDate) {
    @{
      pid = $row.ProcessId; parentPid = $row.ParentProcessId; name = $row.Name
      image = $row.ExecutablePath; commandLine = $row.CommandLine
      created = $row.CreationDate.ToUniversalTime().ToString('o')
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
  $snapshot = @(Read-Processes $filter)
  Reset-CwdBudget
  $rows = @(foreach ($row in $snapshot) {
    $process = Read-Process $row
    if (!$process) { continue }
    if ($seen.Add("$($process.pid)/$($process.created)") -and $kind -ne 'baseline') { Add-ProcessCwd $process }
    $process
  })
  Write-Record @{ kind = $kind; rows = $rows }
  Write-CwdCoverage
}

function Read-Ancestors($parentId, $childTime, $draining) {
  $links = [Collections.Generic.List[object]]::new()
  $status = 'root'
  while ($parentId -gt 0) {
    if ($links.Count -ge 6) { $status = 'depth-limited'; break }
    if (!$draining -and [IO.File]::Exists($stop)) { $status = 'stop-requested'; break }
    try { $row = Read-Processes "ProcessId = $parentId" }
    catch { $status = 'query-failed'; break }
    $parent = Read-Process $row
    if (!$parent) {
      $links.Add(@{ pid = $parentId; parentCreatedBeforeChild = $false })
      $status = 'parent-unavailable'
      break
    }
    $parentTime = $row.CreationDate.ToUniversalTime()
    $parent.parentCreatedBeforeChild = $parentTime -lt $childTime
    $links.Add($parent)
    if (!$parent.parentCreatedBeforeChild) { $status = 'parent-not-older'; break }
    $childTime = $parentTime
    $parentId = $parent.parentPid
  }
  @{ links = $links.ToArray(); status = $status }
}

function Read-Start($eventRecord) {
  $eventTime = [DateTime]::FromFileTimeUtc([long]$eventRecord.TIME_CREATED)
  $id = [uint32]$eventRecord.ProcessID
  $parentId = [uint32]$eventRecord.ParentProcessID
  Write-Record @{
    kind = 'raw-start'; pid = $id; parentPid = $parentId; name = $eventRecord.ProcessName
    eventTime = $eventTime.ToString('o')
  }
  @{
    pid = $id; parentPid = $parentId; name = $eventRecord.ProcessName; created = $null
    eventTime = $eventTime.ToString('o')
  }
}

function Write-Start($process, $draining) {
  $live = @()
  if (!$draining -and ![IO.File]::Exists($stop)) {
    try { $live = @(Read-Processes "ProcessId = $($process.pid)") }
    catch { Write-Record @{ kind = 'trace-process-query-failed' } }
  }
  $eventTime = [DateTime]::Parse($process.eventTime).ToUniversalTime()
  foreach ($row in $live) {
    if ($row.ProcessId -ne $process.pid -or !$row.CreationDate -or $row.CreationDate.ToUniversalTime() -gt $eventTime -or
        $row.ParentProcessId -ne $process.parentPid -or $row.Name -ne $process.name) { continue }
    $child = Read-Process $row
    if (!$child) { continue }
    $process.created = $child.created
    $process.image = $child.image
    $process.commandLine = $child.commandLine
  }
  if ($process.created -and $process.ancestryTimeBasis) {
    $process.ancestryTimeBasis = 'child-creation'
    # The live child can predate its trace timestamp.
    if ($process.ancestry.Count -gt 0) {
      $parent = $process.ancestry[0]
      if ($parent.created -and [DateTimeOffset]::Parse($parent.created) -ge [DateTimeOffset]::Parse($process.created)) {
        $parent.parentCreatedBeforeChild = $false
        $process.ancestry = @($parent)
        $process.ancestryStatus = 'parent-not-older'
      }
    }
  }
  Add-ProcessCwd $process
  Write-Record @{ kind = 'trace'; rows = @($process) }
}

function Write-TraceBatch($stopping) {
  $mediaStarts = [Collections.Generic.List[object]]::new()
  $otherStarts = [Collections.Generic.List[object]]::new()
  foreach ($start in (Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
    if ($start.SourceEventArgs.NewEvent.ProcessName -in $mediaImages) { $mediaStarts.Add($start) }
    else { $otherStarts.Add($start) }
  }

  $mediaLimit = 8
  $media = @(foreach ($start in $mediaStarts) {
    Remove-Event -EventIdentifier $start.EventIdentifier
    $process = Read-Start $start.SourceEventArgs.NewEvent
    if ($mediaLimit-- -le 0) {
      $process.ancestry = @()
      $process.ancestryStatus = 'media-batch-limited'
      Write-Record @{ kind = 'trace'; rows = @($process) }
      continue
    }
    $ancestry = Read-Ancestors $process.parentPid ([DateTime]::Parse($process.eventTime).ToUniversalTime()) $stopping
    $process.ancestry = $ancestry.links
    $process.ancestryStatus = $ancestry.status
    $process.ancestryTimeBasis = 'start-event'
    $process
  })
  Reset-CwdBudget
  foreach ($process in $media) { Write-Start $process $stopping }
  Write-CwdCoverage

  Reset-CwdBudget
  $batch = [Diagnostics.Stopwatch]::StartNew()
  $limit = 32
  foreach ($start in $otherStarts) {
    if ($limit-- -eq 0 -or $batch.ElapsedMilliseconds -ge 1500) {
      if ($stopping) { Write-Record @{ kind = 'stop-drain-limited' } }
      break
    }
    if (!$stopping -and [IO.File]::Exists($stop)) { break }
    Remove-Event -EventIdentifier $start.EventIdentifier
    Write-Start (Read-Start $start.SourceEventArgs.NewEvent) $stopping
  }
  Write-CwdCoverage
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
  Write-Snapshot 'baseline'
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
  if ($mechanism -eq 'polling') { Write-Snapshot 'snapshot' }
  Write-Record @{ kind = 'ready' }
  while ($true) {
    $stopping = [IO.File]::Exists($stop)
    if ($mechanism -eq 'Win32_ProcessStartTrace') {
      if (!$stopping) { Wait-Event -SourceIdentifier $source -Timeout 1 | Out-Null }
      Write-Record @{ kind = 'heartbeat' }
      Write-TraceBatch $stopping
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
