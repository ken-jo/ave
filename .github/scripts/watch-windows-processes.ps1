$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$properties = 'ProcessId', 'ParentProcessId', 'Name', 'ExecutablePath', 'CommandLine', 'CreationDate'
$source = 'AveProcessStarts'
$mechanism = 'polling'

function Write-Record($record) {
  [Console]::WriteLine((ConvertTo-Json -InputObject $record -Compress -Depth 5))
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

function Write-Snapshot($kind) {
  $query = @{ ClassName = 'Win32_Process'; Property = $properties }
  if ($env:AVE_PROCESS_WATCH_PARENT) {
    $parentId = [uint32]$env:AVE_PROCESS_WATCH_PARENT
    $query.Filter = "ProcessId = $parentId OR ParentProcessId = $parentId"
  }
  $rows = @(Get-CimInstance @query | ForEach-Object { Read-Process $_ })
  Write-Record @{ kind = $kind; rows = $rows }
}

function Write-Start($record) {
  $eventTime = [DateTime]::FromFileTimeUtc([long]$record.TIME_CREATED)
  $id = $record.ProcessID
  $row = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -Property $properties
  if ($row.CreationDate -and $row.CreationDate.ToUniversalTime() -le $eventTime) {
    $process = Read-Process $row
  } else {
    $process = @{
      pid = $id; name = $record.ProcessName; image = $null; commandLine = $null
      created = $eventTime.ToString('o')
    }
  }
  $process.parentPid = $record.ParentProcessID
  Write-Record @{ kind = 'snapshot'; rows = @($process) }
}

try {
  if ($env:GITHUB_ACTIONS -eq 'true' -and $env:AVE_PROCESS_WATCH_TRACE -eq '1') {
    try {
      Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $source | Out-Null
      $mechanism = 'Win32_ProcessStartTrace'
    } catch {
      Write-Record @{ kind = 'trace-unavailable' }
    }
  }
  Write-Record @{ kind = 'mechanism'; mechanism = $mechanism; jobRootMatch = 'image path' }
  Write-Snapshot 'baseline'
  while ($true) {
    $stopping = [IO.File]::Exists($env:AVE_PROCESS_WATCH_STOP)
    if ($mechanism -eq 'Win32_ProcessStartTrace') {
      if (!$stopping) { Wait-Event -SourceIdentifier $source -Timeout 1 | Out-Null }
      foreach ($start in (Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
        Remove-Event -EventIdentifier $start.EventIdentifier
        Write-Start $start.SourceEventArgs.NewEvent
      }
    } elseif (!$stopping) {
      Start-Sleep -Milliseconds 250
      Write-Snapshot 'snapshot'
    }
    if ($stopping) { break }
  }
} finally {
  if ($mechanism -eq 'Win32_ProcessStartTrace') { Unregister-Event -SourceIdentifier $source }
}
