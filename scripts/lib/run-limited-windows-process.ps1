param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][long]$DeadlineUnixMs
)
$ErrorActionPreference = 'Stop'
if (-not $env:AVE_WINDOWS_SMOKE_OWNER_DIRECTORY -or -not $env:AVE_WINDOWS_SMOKE_OWNER_SID) {
  throw 'The filtered owner launcher is not available'
}
# The retained filtered bootstrap starts the target itself. No synthetic token
# or token-copy privilege is involved in the outer process's creation.
$requestPath = Join-Path $env:AVE_WINDOWS_SMOKE_OWNER_DIRECTORY ([Guid]::NewGuid().ToString('N') + '.request.json')
$responsePath = $requestPath + '.response'
try {
  $arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json
  @{ filePath = $FilePath; arguments = ($arguments -join ' '); workingDirectory = $WorkingDirectory; deadlineUnixMs = $DeadlineUnixMs; userSid = $env:AVE_WINDOWS_SMOKE_OWNER_SID } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath ($requestPath + '.tmp') -Encoding UTF8
  Move-Item -LiteralPath ($requestPath + '.tmp') -Destination $requestPath
  while (-not (Test-Path -LiteralPath $responsePath)) {
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge ($DeadlineUnixMs - 5000)) { throw 'The filtered owner launch exceeded its deadline' }
    Start-Sleep -Milliseconds 100
  }
  $report = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json
  if ($report.error) { throw $report.error }
  if ($null -eq $report.exitCode) { throw 'The filtered owner child produced no exit code' }
  $report | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Get-Content -LiteralPath $ReportPath -Raw
  exit $report.exitCode
} finally {
  foreach ($path in @($requestPath, $responsePath, ($requestPath + '.tmp'))) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
}
