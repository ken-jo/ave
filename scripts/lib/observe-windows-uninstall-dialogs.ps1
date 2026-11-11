param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
if ($env:AVE_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE -ne '1' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Dialog automation requires an explicitly authorized disposable hosted runner'
}
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-uninstall-dialog-observer.cs')
$result = [UninstallDialogObserver]::Run($request.executable, $request.ownerSid, $request.reply,
  [string[]]$request.sentinelPaths, [string[]]$request.sentinelContents, $request.finishedPath, [long]$request.deadlineUnixMs)
$result | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath $ReportPath -Encoding UTF8
