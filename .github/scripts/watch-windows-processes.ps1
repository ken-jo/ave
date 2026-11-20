$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$directory = Get-Location
$stop = Join-Path $directory 'watcher.stop'
$control = Join-Path $directory 'watcher-ownership.json'
$permissionStep = Join-Path $directory 'permission-step.txt'
$properties = 'ProcessId', 'ParentProcessId', 'Name', 'ExecutablePath', 'CommandLine', 'CreationDate'
$mediaImages = 'setup_wm.exe', 'unregmp2.exe', 'wmplayer.exe', 'wmpnscfg.exe', 'wmpnetwk.exe'
$source = 'AveProcessStarts'
$mechanism = 'polling'
$seen = [Collections.Generic.HashSet[string]]::new()
$pipeName = $env:AVE_PROCESS_WATCH_PIPE.Substring('\\.\pipe\'.Length)
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::Out)
$writer = $null
$batchLimitMs = 1500
$mediaLimit = 8
$enrichment = $null
$enrichmentResult = $null
$recentStarts = [Collections.Generic.Queue[hashtable]]::new()
$latestStart = [DateTime]::MinValue
$contextLookup = $null
$contextResult = $null
$pendingContexts = $null
$contextBatch = $null

function Write-Record($record) {
  $writer.WriteLine((ConvertTo-Json -InputObject $record -Compress -Depth 6))
}

function Write-Mechanism {
  Write-Record @{ kind = 'mechanism'; mechanism = $mechanism; jobRootMatch = 'image path or current directory' }
}

$mediaLookup = {
  param($name, $parameters, $definitions, $native, $pointerSize)
  $ErrorActionPreference = 'Stop'
  foreach ($functionName in $definitions.Keys) {
    Set-Item -LiteralPath "function:$functionName" -Value $definitions[$functionName]
  }
  & $name @parameters
}

function Invoke-MediaLookup($name, $parameters, $batch) {
  # A timed-out lookup may still be unwinding. Keep at most one in flight.
  if ($enrichmentResult) {
    if (!$enrichmentResult.IsCompleted) { throw 'Media lookup is still running' }
    try { $null = $enrichment.EndInvoke($enrichmentResult) } catch {}
    $script:enrichmentResult = $null
  }
  if ($batch.ElapsedMilliseconds -ge $batchLimitMs) { throw 'Media batch time exhausted' }
  if (!$enrichment) { $script:enrichment = [PowerShell]::Create() }
  $enrichment.Commands.Clear()
  $null = $enrichment.AddScript($mediaLookup.ToString(), $true).AddParameters(@{
    name = $name; parameters = $parameters; definitions = $enrichmentDefinitions
    native = $native; pointerSize = $pointerSize
  })
  $script:enrichmentResult = $enrichment.BeginInvoke()
  $remaining = [int][Math]::Max(0, $batchLimitMs - $batch.ElapsedMilliseconds)
  if (!$enrichmentResult.AsyncWaitHandle.WaitOne($remaining)) { throw 'Media batch time exhausted' }
  try { $enrichment.EndInvoke($enrichmentResult) }
  finally { $script:enrichmentResult = $null }
}

function Read-Processes($filter, $batch) {
  Write-Record @{ kind = 'heartbeat' }
  $query = @{ ClassName = 'Win32_Process'; Property = $properties; OperationTimeoutSec = 2 }
  if ($filter) { $query.Filter = $filter }
  if ($batch) { Invoke-MediaLookup 'Get-CimInstance' $query $batch }
  else { Get-CimInstance @query }
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

function Read-MediaContexts($contexts, $stepIdentity, $query, $batch) {
  $live = @{}
  foreach ($row in (Get-CimInstance @query)) {
    $process = Read-Process $row
    if ($process) { $live[[uint32]$process.pid] = $process }
  }
  $step = $null
  if ($stepIdentity -match '^([0-9]{1,10}) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6})$') {
    $candidate = $live[[uint32]$Matches[1]]
    if ($candidate -and $candidate.created.StartsWith($Matches[2])) { $step = $candidate }
  }
  $descendants = if ($step) {
    @(foreach ($process in $live.Values) {
      if ($process.name -notin 'electron.exe', 'node.exe') { continue }
      $child = $process
      while ($child.parentPid -gt 0) {
        $parent = $live[[uint32]$child.parentPid]
        if (!$parent -or [string]::CompareOrdinal($parent.created, $child.created) -ge 0) { break }
        if ($parent.pid -eq $step.pid) { $process; break }
        $child = $parent
      }
    })
  }
  $records = @(foreach ($context in $contexts) {
    $before = @(foreach ($start in $context.preceding) {
      $process = $live[$start.pid]
      if ($process -and $process.parentPid -eq $start.parentPid -and $process.name -eq $start.name -and
          [string]::CompareOrdinal($process.created, $start.eventTime) -le 0 -and
          $process.created -ge $context.windowStart) { $process }
    })
    @{
      kind = 'media-context'; pid = $context.pid; eventTime = $context.eventTime
      enriched = $before.Count; unavailable = $context.preceding.Count - $before.Count; starts = $before
      stepProcesses = if ($step) { ,@($descendants | Where-Object { $_ -and $_.created -le $context.eventTime }) }
    }
  })
  @{ records = $records; elapsed = $batch.ElapsedMilliseconds }
}

function Write-UnavailableContexts($contexts) {
  foreach ($context in $contexts) {
    Write-Record @{
      kind = 'media-context'; pid = $context.pid; eventTime = $context.eventTime
      enriched = 0; unavailable = $context.preceding.Count; starts = @(); stepProcesses = $null
    }
  }
}

function Complete-MediaContexts($stopping) {
  if (!$contextResult) { return }
  if ($contextResult.IsCompleted) {
    $result = $null
    try { $result = $contextLookup.EndInvoke($contextResult)[0] }
    catch {}
    $script:contextResult = $null
    if ($pendingContexts -and $result -and $result.elapsed -lt $batchLimitMs) {
      foreach ($record in $result.records) { Write-Record $record }
      $script:pendingContexts = $null
    }
  }
  if ($pendingContexts -and (!$contextResult -or $stopping -or $contextBatch.ElapsedMilliseconds -ge $batchLimitMs)) {
    Write-UnavailableContexts $pendingContexts
    $script:pendingContexts = $null
  }
}

function Start-MediaContexts($starts, $batch, $stopping) {
  $contexts = @(foreach ($process in $starts) {
    $eventTime = [DateTime]::Parse($process.eventTime).ToUniversalTime()
    $windowStart = $eventTime.AddSeconds(-3).ToString('o')
    @{
      pid = $process.pid; eventTime = $process.eventTime; windowStart = $windowStart
      preceding = @($recentStarts | Where-Object { $_.eventTime -ge $windowStart -and $_.eventTime -lt $process.eventTime })
    }
  })
  if ($stopping -or $contextResult -or $batch.ElapsedMilliseconds -ge $batchLimitMs) {
    Write-UnavailableContexts $contexts
    return
  }
  $stepIdentity = $null
  try { $stepIdentity = [IO.File]::ReadAllText($permissionStep) } catch {}
  try {
    if (!$contextLookup) { $script:contextLookup = [PowerShell]::Create() }
    $contextLookup.Commands.Clear()
    $null = $contextLookup.AddScript($mediaLookup.ToString(), $true).AddParameters(@{
      name = 'Read-MediaContexts'; definitions = $contextDefinitions; parameters = @{
        contexts = $contexts; stepIdentity = $stepIdentity; batch = $batch
        query = @{ ClassName = 'Win32_Process'; Property = $properties; OperationTimeoutSec = 2 }
      }
    })
    $script:contextResult = $contextLookup.BeginInvoke()
    $script:contextBatch = $batch
    $script:pendingContexts = $contexts
  } catch { Write-UnavailableContexts $contexts }
}

function Reset-CwdBudget {
  $script:cwdTimer = [Diagnostics.Stopwatch]::new()
  $script:cwdAttempts = $script:cwdUnavailable = $script:cwdSkipped = 0
}

function Add-ProcessCwd($process, $batch) {
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
      if ($batch) {
        $process.cwd = Invoke-MediaLookup 'ReadCurrentDirectory' @{ id = $process.pid; expectedCreation = $created } $batch
      } else { $process.cwd = ReadCurrentDirectory $process.pid $created }
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

function Read-Ancestors($parentId, $childTime, $firstParent, $batch) {
  $links = [Collections.Generic.List[object]]::new()
  $status = 'root'
  while ($parentId -gt 0) {
    if ($links.Count -ge 6) { $status = 'depth-limited'; break }
    $row = $firstParent
    if ($links.Count -gt 0) {
      if ([IO.File]::Exists($stop)) { $status = 'stop-requested'; break }
      if ($batch.ElapsedMilliseconds -ge $batchLimitMs) { $status = 'media-budget-exhausted'; break }
      try { $row = Read-Processes "ProcessId = $parentId" $batch }
      catch {
        $status = if ($batch.ElapsedMilliseconds -ge $batchLimitMs) { 'media-budget-exhausted' } else { 'query-failed' }
        break
      }
    }
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
  if (!$eventRecord -or $null -eq $eventRecord.ParentProcessID -or
      $eventRecord.ProcessName -isnot [string] -or [string]::IsNullOrWhiteSpace($eventRecord.ProcessName)) { return }
  try {
    $id = [uint32]$eventRecord.ProcessID
    $fileTime = [long]$eventRecord.TIME_CREATED
    if ($id -eq 0 -or $fileTime -le 0) { return }
    $eventTime = [DateTime]::FromFileTimeUtc($fileTime)
    $parentId = [uint32]$eventRecord.ParentProcessID
  } catch { return }
  @{
    pid = $id; parentPid = $parentId; name = $eventRecord.ProcessName; created = $null
    eventTime = $eventTime.ToString('o'); traceTime = $eventTime
  }
}

function Write-RawStart($process) {
  Write-Record @{
    kind = 'raw-start'; pid = $process.pid; parentPid = $process.parentPid; name = $process.name
    eventTime = $process.eventTime
  }
}

function Write-Start($process, $batch) {
  $filter = "ProcessId = $($process.pid)"
  if ($process.parentPid -gt 0) { $filter += " OR ProcessId = $($process.parentPid)" }
  try { $live = @(Read-Processes $filter $batch) }
  catch {
    $status = if ($batch.ElapsedMilliseconds -ge $batchLimitMs) { 'media-budget-exhausted' } else { 'query-failed' }
    Write-Record @{ kind = 'trace-process-query-failed'; reason = $status }
    Write-MediaOnly $process $status
    return
  }
  $eventTime = [DateTime]::Parse($process.eventTime).ToUniversalTime()
  $childTime = $eventTime
  $firstParent = $null
  $process.ancestryTimeBasis = 'start-event'
  foreach ($row in $live) {
    if ($row.ProcessId -eq $process.parentPid) { $firstParent = $row }
    if ($row.ProcessId -ne $process.pid -or !$row.CreationDate -or $row.CreationDate.ToUniversalTime() -gt $eventTime -or
        $row.ParentProcessId -ne $process.parentPid -or $row.Name -ne $process.name) { continue }
    $child = Read-Process $row
    if (!$child) { continue }
    $process.created = $child.created
    $process.image = $child.image
    $process.commandLine = $child.commandLine
    $process.ancestryTimeBasis = 'child-creation'
    $childTime = $row.CreationDate.ToUniversalTime()
  }
  $ancestry = Read-Ancestors $process.parentPid $childTime $firstParent $batch
  $process.ancestry = $ancestry.links
  $process.ancestryStatus = $ancestry.status
  if ($batch.ElapsedMilliseconds -lt $batchLimitMs -and ![IO.File]::Exists($stop)) {
    Add-ProcessCwd $process $batch
  }
  Write-Record @{ kind = 'trace'; rows = @($process) }
}

function Write-MediaOnly($process, $status) {
  $process.ancestry = @()
  $process.ancestryStatus = $status
  Write-Record @{ kind = 'trace'; rows = @($process) }
}

function Write-MediaBatch($starts, $batch, $stopping) {
  Reset-CwdBudget
  foreach ($process in $starts) {
    if ($stopping -or [IO.File]::Exists($stop)) {
      Write-MediaOnly $process 'stop-requested'
    } elseif ($batch.ElapsedMilliseconds -ge $batchLimitMs -or ($enrichmentResult -and !$enrichmentResult.IsCompleted)) {
      Write-MediaOnly $process 'media-budget-exhausted'
    } else {
      Write-Start $process $batch
    }
  }
  Write-CwdCoverage
}

function Write-TraceBatch($stopping) {
  $batch = [Diagnostics.Stopwatch]::StartNew()
  $mediaStarts = [Collections.Generic.List[hashtable]]::new()
  $traceEnd = $null
  $dropped = 0
  $processed = $false
  if ($stopping) { Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue }
  do {
    $drainTail = $false
    foreach ($start in (Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
      if ($processed -and !$stopping -and !$traceEnd -and $batch.ElapsedMilliseconds -ge $batchLimitMs) { break }
      $eventArgs = $start.SourceEventArgs
      $process = Read-Start $eventArgs.NewEvent
      if ($process) {
        Write-RawStart $process
        $recentStarts.Enqueue($process)
        if ($process.traceTime -gt $latestStart) { $script:latestStart = $process.traceTime }
        if ($process.name -in $mediaImages) {
          $mediaStarts.Add($process)
        }
      } elseif ($null -eq $eventArgs.Exception -or $null -ne $eventArgs.NewEvent) { $dropped++ }
      if ((!$process -or $null -ne $eventArgs.Exception) -and !$traceEnd -and !$stopping) {
        $traceEnd = @{ kind = 'trace-ended'; reason = 'invalid-start-event' }
        if ($null -ne $eventArgs.Exception) {
          $traceEnd.reason = 'subscription-error'
          if ($null -ne $eventArgs.Exception.StatusCode) { $traceEnd.status = [string]$eventArgs.Exception.StatusCode }
        }
        Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
        $drainTail = $true
      }
      Remove-Event -EventIdentifier $start.EventIdentifier
      $processed = $true
    }
  } while ($drainTail)
  if ($dropped) { Write-Record @{ kind = 'dropped'; count = $dropped; reason = 'invalid-start-event' } }
  Complete-MediaContexts ($stopping -or $traceEnd)
  if ($mediaStarts.Count) {
    $bounded = $mediaStarts.GetRange(0, [Math]::Min($mediaLimit, $mediaStarts.Count))
    Start-MediaContexts $bounded $batch ($stopping -or $traceEnd)
    Write-MediaBatch $bounded $batch $stopping
    if ($mediaStarts.Count -gt $mediaLimit) {
      $remaining = $mediaStarts.GetRange($mediaLimit, $mediaStarts.Count - $mediaLimit)
      Start-MediaContexts $remaining $batch $true
      foreach ($process in $remaining) { Write-MediaOnly $process 'media-batch-limited' }
    }
  }
  # Leave room for events delivered out of timestamp order.
  if ($recentStarts.Count) {
    $retainAfter = $latestStart.AddSeconds(-6)
    while ($recentStarts.Count -and $recentStarts.Peek().traceTime -lt $retainAfter) { $null = $recentStarts.Dequeue() }
  }
  if ($traceEnd -and !$stopping) {
    Write-Record $traceEnd
    $script:mechanism = 'polling'
    Write-Mechanism
  }
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
      Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $source |
        Out-Null
      $enrichmentDefinitions = @{}
      foreach ($name in 'ReadProcessPointer', 'ReadCurrentDirectory', 'Get-CimInstance') {
        $function = Get-Command -Name $name -CommandType Function -ErrorAction SilentlyContinue
        if ($function) { $enrichmentDefinitions[$name] = $function.Definition }
      }
      $contextDefinitions = @{}
      foreach ($name in 'Read-Process', 'Read-MediaContexts', 'Get-CimInstance') {
        $function = Get-Command -Name $name -CommandType Function -ErrorAction SilentlyContinue
        if ($function) { $contextDefinitions[$name] = $function.Definition }
      }
      $mechanism = 'Win32_ProcessStartTrace'
    } catch {
      Write-Record @{ kind = 'trace-unavailable' }
    }
  }
  Write-Mechanism
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
  # Disposing a running lookup would block shutdown.
  if ($enrichment -and (!$enrichmentResult -or $enrichmentResult.IsCompleted)) { $enrichment.Dispose() }
  if ($contextLookup -and (!$contextResult -or $contextResult.IsCompleted)) { $contextLookup.Dispose() }
}
