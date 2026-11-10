param(
  [Parameter(Mandatory = $true)][string]$NodeExecutable,
  [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][long]$DeadlineUnixMs,
  [string]$OutputDirectory,
  [string]$ExpectedUserSid,
  [string]$SmokeEnvironmentBase64,
  [int]$FilteredOwnerProcessId,
  [switch]$OwnerBootstrap,
  [switch]$ElevatedOwner
)
$ErrorActionPreference = 'Stop'
$smokeEnvironmentNames = @('GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'AVE_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE', 'AVE_ALLOW_DESTRUCTIVE_UNINSTALL_SMOKE')
if ($OwnerBootstrap -or $ElevatedOwner) {
  # Alternate-credential startup constructs a new environment. Transfer only
  # the explicit disposable-smoke authorization, never the runner's secrets.
  $smokeEnvironment = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SmokeEnvironmentBase64)) | ConvertFrom-Json
  foreach ($name in $smokeEnvironmentNames) { [Environment]::SetEnvironmentVariable($name, $smokeEnvironment.$name, 'Process') }
} else {
  $smokeEnvironment = @{}
  foreach ($name in $smokeEnvironmentNames) { $smokeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  $SmokeEnvironmentBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($smokeEnvironment | ConvertTo-Json -Compress)))
}
if ($env:AVE_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE -ne '1' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'The owner-profile harness requires an explicitly authorized hosted disposable runner'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$powershell = Join-Path $PSHOME 'powershell.exe'
function Wait-OwnerProcess($process, [int]$reserveMs) {
  # Retain the native handle before waiting: redirected process objects can
  # otherwise lose their exit status when the child closes.
  $retainedHandle = $process.Handle
  $remaining = [int][Math]::Max(1, $DeadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $reserveMs)
  if (-not $process.WaitForExit($remaining)) { throw 'The owner-profile smoke exceeded its deadline' }
  $process.Refresh()
  $result = $process.ExitCode
  $process.Dispose()
  if ($null -eq $result) { throw 'The owner process produced no exit code' }
  return $result
}

if ($OwnerBootstrap -or $ElevatedOwner) {
  if ($identity.User.Value -ne $ExpectedUserSid -or $ExpectedUserSid.EndsWith('-500')) {
    throw 'The smoke owner is not the temporary split-token account'
  }
  # Resolve all profile paths from the loaded identity before elevating again.
  $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
  $registeredProfile = [Environment]::ExpandEnvironmentVariables((Get-ItemPropertyValue "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$ExpectedUserSid" ProfileImagePath))
  if (-not [string]::Equals($registeredProfile, $env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) { throw 'The loaded owner profile does not match its SID registration' }
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
  $env:HOME = $env:USERPROFILE
  $env:AVE_HOME = Join-Path $env:USERPROFILE '.ave'
  $env:AVE_WINDOWS_SMOKE_OWNER_SID = $ExpectedUserSid
  $env:HOMEDRIVE = [IO.Path]::GetPathRoot($env:USERPROFILE).TrimEnd('\')
  $env:HOMEPATH = $env:USERPROFILE.Substring($env:HOMEDRIVE.Length)
  $env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
  $env:TMP = $env:TEMP
  $env:USERNAME = $identity.Name.Split('\')[-1]
  New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
  $probe = 'SOFTWARE\AveInstallerOwnerProbe'
  $mappingProof = [Guid]::NewGuid().ToString('N')
  New-Item -Path "HKCU:\$probe" -Force | Out-Null
  New-ItemProperty -Path "HKCU:\$probe" -Name MappingProof -Value $mappingProof -Force | Out-Null
  $users = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $users.OpenSubKey("$ExpectedUserSid\$probe")
    if ($null -eq $key) { throw 'The owner HKCU hive is not loaded under its SID' }
    try { if ($key.GetValue('MappingProof') -ne $mappingProof) { throw 'The owner HKCU hive maps to another SID' } } finally { $key.Dispose() }
  } finally { $users.Dispose() }
  $evidenceName = if ($ElevatedOwner) { 'elevated-owner.json' } else { 'filtered-owner.json' }
  @{ userSid = $identity.User.Value; administrator = $admin; profile = $env:USERPROFILE; hiveVerified = $true } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $OutputDirectory $evidenceName) -Encoding UTF8
  if ($ElevatedOwner) {
    if (-not $admin) { throw 'The smoke owner did not elevate' }
    if ($FilteredOwnerProcessId -le 0) { throw 'The filtered owner process is missing' }
    $env:AVE_WINDOWS_SMOKE_FILTERED_PID = [string]$FilteredOwnerProcessId
    $arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json
    Set-Location -LiteralPath $WorkingDirectory
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = $null
    & $NodeExecutable @arguments 1> (Join-Path $OutputDirectory 'stdout.log') 2> (Join-Path $OutputDirectory 'stderr.log')
    if ($null -eq $LASTEXITCODE) { throw 'The smoke process did not produce an exit code' }
    exit $LASTEXITCODE
  }
  if ($admin) { throw 'The owner bootstrap did not receive a filtered token' }
  if (((& whoami.exe /groups /fo csv /nh) -match 'S-1-16-8192').Count -ne 1) { throw 'The owner bootstrap is not at medium integrity' }
  $command = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ElevatedOwner -NodeExecutable "{1}" -ArgumentsBase64 {2} -WorkingDirectory "{3}" -OutputDirectory "{4}" -ExpectedUserSid {5} -DeadlineUnixMs {6} -SmokeEnvironmentBase64 {7} -FilteredOwnerProcessId {8}' -f $PSCommandPath, $NodeExecutable, $ArgumentsBase64, $WorkingDirectory, $OutputDirectory, $ExpectedUserSid, $DeadlineUnixMs, $SmokeEnvironmentBase64, $PID
  $child = Start-Process -FilePath $powershell -ArgumentList $command -Verb RunAs -WorkingDirectory $OutputDirectory -PassThru
  $code = Wait-OwnerProcess $child 10000
  exit $code
}

if (-not $admin) { throw 'The disposable runner must be elevated' }
$policyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
if ((Get-ItemPropertyValue $policyPath EnableLUA) -ne 1) { throw 'Split-token smoke requires UAC enabled' }
$policy = Get-Item -LiteralPath $policyPath
$saved = @{}
foreach ($name in @('ConsentPromptBehaviorAdmin', 'PromptOnSecureDesktop')) { $saved[$name] = $policy.GetValue($name, $null) }
$policy.Dispose()
$user = $null
$sid = $null
$code = 1
$failure = $null
$cleanupErrors = @()
$OutputDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('ave-smoke-owner-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
try {
  # Consent is automatic only for this disposable test. UAC itself remains on;
  # both policy values are restored even when startup or uninstall fails.
  foreach ($name in $saved.Keys) { New-ItemProperty -LiteralPath $policyPath -Name $name -Value 0 -PropertyType DWord -Force | Out-Null }
  $name = 'AveSmoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $password = ConvertTo-SecureString ('Aa9!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires
  $sid = $user.SID.Value
  $administrators = (Get-LocalGroup -SID 'S-1-5-32-544').Name
  Add-LocalGroupMember -Group $administrators -Member $user
  & icacls.exe $OutputDirectory /grant "*${sid}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant the temporary owner its report directory' }
  & icacls.exe $OutputDirectory /setintegritylevel '(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not make the report directory writable at medium integrity' }
  # The filtered bootstrap needs only this staged script, not access to the
  # runner account's workspace. The elevated owner opens the checkout later.
  $ownerScript = Join-Path $OutputDirectory 'owner.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $ownerScript
  $credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $password)
  $command = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -OwnerBootstrap -NodeExecutable "{1}" -ArgumentsBase64 {2} -WorkingDirectory "{3}" -OutputDirectory "{4}" -ExpectedUserSid {5} -DeadlineUnixMs {6} -SmokeEnvironmentBase64 {7}' -f $ownerScript, $NodeExecutable, $ArgumentsBase64, $WorkingDirectory, $OutputDirectory, $sid, $DeadlineUnixMs, $SmokeEnvironmentBase64
  Write-Output "[windows-installer-smoke] temporary split-token owner: $sid; original runner: $($identity.User.Value)"
  $child = Start-Process -FilePath $powershell -ArgumentList $command -Credential $credential -LoadUserProfile -WorkingDirectory $OutputDirectory -PassThru -RedirectStandardOutput (Join-Path $OutputDirectory 'bootstrap-stdout.log') -RedirectStandardError (Join-Path $OutputDirectory 'bootstrap-stderr.log')
  $code = Wait-OwnerProcess $child 5000
  if (-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'stdout.log'))) { throw 'The temporary owner produced no smoke output' }
} catch {
  $failure = $_
} finally {
  foreach ($file in @('stdout.log', 'stderr.log', 'bootstrap-stdout.log', 'bootstrap-stderr.log', 'filtered-owner.json', 'elevated-owner.json')) {
    try {
      $path = Join-Path $OutputDirectory $file
      if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw }
    } catch { $cleanupErrors += "Could not read ${file}: $($_.Exception.Message)" }
  }
  if ($user) {
    try {
      & taskkill.exe /F /T /FI "USERNAME eq $env:COMPUTERNAME\$($user.Name)" /IM '*' | Out-Null
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 128) { throw 'Could not stop the temporary owner process trees' }
    } catch { $cleanupErrors += $_.Exception.Message }
  }
  foreach ($name in $saved.Keys) {
    try {
      if ($null -eq $saved[$name]) {
        if ($null -ne (Get-ItemProperty -LiteralPath $policyPath).PSObject.Properties[$name]) { Remove-ItemProperty -LiteralPath $policyPath -Name $name }
      }
      else { New-ItemProperty -LiteralPath $policyPath -Name $name -Value $saved[$name] -PropertyType DWord -Force | Out-Null }
    } catch { $cleanupErrors += $_.Exception.Message }
  }
  try {
    $restored = Get-Item -LiteralPath $policyPath
    try {
      foreach ($name in $saved.Keys) {
        if (-not [object]::Equals($saved[$name], $restored.GetValue($name, $null))) { throw "The original policy value was not restored: $name" }
      }
    } finally { $restored.Dispose() }
  } catch { $cleanupErrors += $_.Exception.Message }
  try {
    if ($sid) {
      $ownerProfile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
      while ($ownerProfile -and $ownerProfile.Loaded -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $DeadlineUnixMs) {
        Start-Sleep -Milliseconds 100
        $ownerProfile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
      }
      if ($ownerProfile -and $ownerProfile.Loaded) { throw 'The temporary owner profile did not unload before cleanup' }
      if ($ownerProfile) { $ownerProfile | Remove-CimInstance }
    }
  } catch { $cleanupErrors += $_.Exception.Message }
  try { if ($user) { Remove-LocalUser -SID $user.SID } } catch { $cleanupErrors += $_.Exception.Message }
  try {
    if ($sid -and ((@(Get-LocalUser | Where-Object { $_.SID.Value -eq $sid })).Count -ne 0 -or (Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"))) { throw 'The temporary owner account or profile survived cleanup' }
  } catch { $cleanupErrors += $_.Exception.Message }
  try { Remove-Item -LiteralPath $OutputDirectory -Recurse -Force } catch { $cleanupErrors += $_.Exception.Message }
}
if ($cleanupErrors.Count -gt 0) { throw "Owner cleanup failed: $($cleanupErrors -join '; '); smoke exit: $code; smoke failure: $failure" }
Write-Output '[windows-installer-smoke] temporary owner account/profile absent and original UAC prompt policies restored'
if ($failure) { throw $failure }
exit $code
