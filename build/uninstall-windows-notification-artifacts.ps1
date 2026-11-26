[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstalledExecutable,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ShortcutName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$AppUserModelId,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstallMarker
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Value)

  $full = [System.IO.Path]::GetFullPath($Value)
  while (
    $full.Length -gt 3 -and
    ($full.EndsWith("\", [System.StringComparison]::Ordinal) -or
      $full.EndsWith("/", [System.StringComparison]::Ordinal))
  ) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  return $full
}

function Test-SamePath {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  if ([string]::IsNullOrWhiteSpace($Left)) { return $false }
  try {
    return [string]::Equals(
      (Get-NormalizedPath $Left),
      (Get-NormalizedPath $Right),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
  catch {
    return $false
  }
}

function Get-ShortcutAttributes {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    return [System.IO.File]::GetAttributes($Path)
  }
  catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {
    return $null
  }
}

function Write-CleanupEvent {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("removed", "foreign-preserved", "verified-absent", "contract-failed")]
    [string]$Status,
    [Parameter(Mandatory = $true)][string]$Artifact,
    [Parameter(Mandatory = $true)][string]$Detail
  )

  [PSCustomObject]@{
    component = "ave-notification-cleanup"
    status = $Status
    artifact = $Artifact
    detail = $Detail
  } | ConvertTo-Json -Compress
}

function Release-ComObject {
  param($Value)

  if (
    $null -ne $Value -and
    [System.Runtime.InteropServices.Marshal]::IsComObject($Value)
  ) {
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
  }
}

function Get-ShortcutRecord {
  param([Parameter(Mandatory = $true)][string]$Path)

  $wscript = $null
  $shortcut = $null
  $shell = $null
  $folder = $null
  $item = $null
  try {
    $wscript = New-Object -ComObject WScript.Shell
    $shortcut = $wscript.CreateShortcut($Path)
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace([System.IO.Path]::GetDirectoryName($Path))
    if ($null -eq $folder) {
      throw "could not open the shortcut parent folder"
    }
    $item = $folder.ParseName([System.IO.Path]::GetFileName($Path))
    if ($null -eq $item) {
      throw "could not read the shortcut property store"
    }

    return [PSCustomObject]@{
      Target = [string]$shortcut.TargetPath
      WorkingDirectory = [string]$shortcut.WorkingDirectory
      Arguments = [string]$shortcut.Arguments
      Description = [string]$shortcut.Description
      AppUserModelId = [string]$item.ExtendedProperty("System.AppUserModel.ID")
      ToastClsid = [string]$item.ExtendedProperty(
        "System.AppUserModel.ToastActivatorCLSID"
      )
    }
  }
  finally {
    Release-ComObject $item
    Release-ComObject $folder
    Release-ComObject $shell
    Release-ComObject $shortcut
    Release-ComObject $wscript
  }
}

function Get-ShortcutOwnershipMismatches {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedWorkingDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedDescription,
    [Parameter(Mandatory = $true)][string]$ExpectedAppUserModelId
  )

  $mismatches = @()
  if (-not (Test-SamePath $Record.Target $ExpectedExecutable)) {
    $mismatches += "target"
  }
  if (-not (Test-SamePath $Record.WorkingDirectory $ExpectedWorkingDirectory)) {
    $mismatches += "workingDirectory"
  }
  if (-not [string]::Equals(
      $Record.Arguments,
      "",
      [System.StringComparison]::Ordinal
    )) {
    $mismatches += "arguments"
  }
  if (-not [string]::Equals(
      $Record.Description,
      $ExpectedDescription,
      [System.StringComparison]::Ordinal
    )) {
    $mismatches += "description"
  }
  if (-not [string]::Equals(
      $Record.AppUserModelId,
      $ExpectedAppUserModelId,
      [System.StringComparison]::Ordinal
    )) {
    $mismatches += "appUserModelId"
  }
  $parsedClsid = [System.Guid]::Empty
  if (
    -not [System.Guid]::TryParse($Record.ToastClsid, [ref]$parsedClsid) -or
    $parsedClsid -eq [System.Guid]::Empty
  ) {
    $mismatches += "toastClsid"
  }
  return @($mismatches)
}

function Get-RegistryViews {
  if ([Environment]::Is64BitOperatingSystem) {
    return @(
      [Microsoft.Win32.RegistryView]::Registry64,
      [Microsoft.Win32.RegistryView]::Registry32
    )
  }
  return @([Microsoft.Win32.RegistryView]::Registry32)
}

function Test-ExactToastRegistrationHandles {
  param(
    [Parameter(Mandatory = $true)]$RootKey,
    [Parameter(Mandatory = $true)]$ServerKey,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  try {
    if ($RootKey.GetValueKind("") -ne [Microsoft.Win32.RegistryValueKind]::String) {
      return $false
    }
    $rootDefault = $RootKey.GetValue(
      "",
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    if (
      -not [string]::Equals(
        [string]$rootDefault,
        "Electron Notification Activator",
        [System.StringComparison]::Ordinal
      )
    ) {
      return $false
    }
    if (
      $RootKey.GetValueKind("CustomActivator") -ne
      [Microsoft.Win32.RegistryValueKind]::DWord
    ) {
      return $false
    }
    if ([int64]$RootKey.GetValue("CustomActivator", 0) -ne 1) {
      return $false
    }
    if ($ServerKey.GetValueKind("") -ne [Microsoft.Win32.RegistryValueKind]::String) {
      return $false
    }
    $serverDefault = $ServerKey.GetValue(
      "",
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    return (
      $null -ne $serverDefault -and
      (Test-SamePath ([string]$serverDefault) $ExpectedExecutable)
    )
  }
  catch {
    return $false
  }
}

function Test-ExactToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $base = $null
  $root = $null
  $server = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      $View
    )
    $root = $base.OpenSubKey("Software\Classes\CLSID\$Clsid", $false)
    if ($null -eq $root) { return $false }
    $server = $root.OpenSubKey("LocalServer32", $false)
    if ($null -eq $server) { return $false }
    return Test-ExactToastRegistrationHandles $root $server $ExpectedExecutable
  }
  finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $root) { $root.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
}

function Remove-ExactToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $base = $null
  $root = $null
  $server = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      $View
    )
    $root = $base.OpenSubKey("Software\Classes\CLSID\$Clsid", $true)
    if ($null -eq $root) { return $false }
    $server = $root.OpenSubKey("LocalServer32", $true)
    if ($null -eq $server) { return $false }

    # Recheck exact types and data on writable handles. Keep the keys so a
    # concurrent writer's values cannot be removed by key deletion.
    if (-not (Test-ExactToastRegistrationHandles $root $server $ExpectedExecutable)) {
      return $false
    }

    $server.DeleteValue("", $false)
    $root.DeleteValue("CustomActivator", $false)
    $root.DeleteValue("", $false)
    return $true
  }
  finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $root) { $root.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
}

function Find-ExactToastRegistrations {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string[]]$CandidateClsids
  )

  $matches = @()
  foreach ($view in (Get-RegistryViews)) {
    foreach ($clsid in $CandidateClsids) {
      if (Test-ExactToastRegistration $view $clsid $ExpectedExecutable) {
        $matches += [PSCustomObject]@{ View = $view; Clsid = $clsid }
      }
    }
  }
  return @($matches)
}

$shortcutMoved = $false
try {
  if (-not [System.IO.Path]::IsPathRooted($InstalledExecutable)) {
    throw "InstalledExecutable must be an absolute path"
  }
  if (
    $ShortcutName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    -not [string]::Equals(
      [System.IO.Path]::GetFileName($ShortcutName),
      $ShortcutName,
      [System.StringComparison]::Ordinal
    )
  ) {
    throw "ShortcutName must be one filename segment"
  }

  $installedExe = Get-NormalizedPath $InstalledExecutable
  $installDir = Get-NormalizedPath ([System.IO.Path]::GetDirectoryName($installedExe))
  $expectedMarker = Join-Path $installDir ".ave-nsis-per-machine-v1"
  if (-not (Test-SamePath $InstallMarker $expectedMarker)) {
    throw "InstallMarker must be the fixed NSIS marker under the install directory"
  }
  $markerItem = Get-Item -LiteralPath $expectedMarker -Force -ErrorAction SilentlyContinue
  if (
    $null -eq $markerItem -or
    $markerItem.PSIsContainer -or
    (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
    $markerItem.Length -ne 0
  ) {
    throw "the exact zero-byte regular NSIS marker contract is unavailable: $expectedMarker"
  }
  $programs = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Programs,
    [Environment+SpecialFolderOption]::DoNotVerify
  )
  if ([string]::IsNullOrWhiteSpace($programs)) {
    throw "the current user's Programs known folder is unavailable"
  }
  $shortcutPath = Join-Path $programs ($ShortcutName + ".lnk")
  $nonRegularAttributes = [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
  $productClsid = "{62FD3EFB-B3D2-4235-9402-6979F52C0286}"
  $candidateClsids = @($productClsid)

  $shortcutAttributes = Get-ShortcutAttributes $shortcutPath
  if ($null -eq $shortcutAttributes) {
    Write-CleanupEvent "verified-absent" "shortcut" (
      "current-user Ave notification shortcut was already absent: $shortcutPath"
    )
  }
  elseif (($shortcutAttributes -band $nonRegularAttributes) -ne 0) {
    Write-CleanupEvent "foreign-preserved" "shortcut" (
      "preserved non-regular or reparse-point candidate: $shortcutPath"
    )
  }
  else {
    $record = Get-ShortcutRecord $shortcutPath
    if (-not (Test-SamePath $record.Target $installedExe)) {
      Write-CleanupEvent "foreign-preserved" "shortcut" (
        "preserved different-target shortcut: $shortcutPath"
      )
    }
    else {
      $mismatches = @(
        Get-ShortcutOwnershipMismatches $record $installedExe $installDir $ShortcutName $AppUserModelId
      )
      if ($mismatches.Count -ne 0) {
        Write-CleanupEvent "foreign-preserved" "shortcut" (
          "preserved same-target partial-owned shortcut; mismatched fields: {0}" -f
          ($mismatches -join ",")
        )
      }
      else {
        # Keep the verified shortcut in quarantine until registry cleanup
        # finishes, so it can be restored on failure as legacy CLSID evidence.
        $quarantinePath = Join-Path $programs (
          ".{0}.ave-uninstall-{1}.lnk" -f
          $ShortcutName,
          [System.Guid]::NewGuid().ToString("N")
        )
        [System.IO.File]::Move($shortcutPath, $quarantinePath)
        $shortcutMoved = $true
        $quarantinedAttributes = Get-ShortcutAttributes $quarantinePath
        if (
          $null -eq $quarantinedAttributes -or
          ($quarantinedAttributes -band $nonRegularAttributes) -ne 0
        ) {
          throw "the quarantined shortcut is missing or is no longer a regular file"
        }
        $quarantinedRecord = Get-ShortcutRecord $quarantinePath
        $quarantinedMismatches = @(
          Get-ShortcutOwnershipMismatches $quarantinedRecord $installedExe $installDir $ShortcutName $AppUserModelId
        )
        if ($quarantinedMismatches.Count -ne 0) {
          throw (
            "the shortcut changed before atomic quarantine; mismatched fields: {0}" -f
            ($quarantinedMismatches -join ",")
          )
        }
        $verifiedClsid = ([guid]$quarantinedRecord.ToastClsid).ToString("B")
        if ($verifiedClsid -ne ([guid]$record.ToastClsid).ToString("B")) {
          throw "the shortcut toast activator CLSID changed before atomic quarantine"
        }
        if ($verifiedClsid -ne $productClsid) {
          $candidateClsids += $verifiedClsid
        }
      }
    }
  }

  foreach ($registration in @(Find-ExactToastRegistrations $installedExe $candidateClsids)) {
    if (Remove-ExactToastRegistration $registration.View $registration.Clsid $installedExe) {
      Write-CleanupEvent "removed" "toast-registration" (
        "Removed exact current-user Ave toast registration {0} ({1})." -f
        $registration.Clsid,
        $registration.View
      )
    }
  }

  $remaining = @(Find-ExactToastRegistrations $installedExe $candidateClsids)
  if ($remaining.Count -ne 0) {
    throw "one or more exact Ave toast registrations survived cleanup"
  }
  Write-CleanupEvent "verified-absent" "toast-registration" (
    "no exact current-user Ave toast registrations remain"
  )

  $shortcutResidue = Get-ShortcutAttributes $shortcutPath
  if (
    $null -ne $shortcutResidue -and
    ($shortcutResidue -band $nonRegularAttributes) -eq 0
  ) {
    $residueRecord = Get-ShortcutRecord $shortcutPath
    if (Test-SamePath $residueRecord.Target $installedExe) {
      $residueMismatches = @(
        Get-ShortcutOwnershipMismatches $residueRecord $installedExe $installDir $ShortcutName $AppUserModelId
      )
      if ($residueMismatches.Count -eq 0) {
        throw "the exact owned shortcut survived the final cleanup postcondition"
      }
      Write-CleanupEvent "foreign-preserved" "shortcut" (
        "preserved same-target partial-owned shortcut at final postcondition; mismatched fields: {0}" -f
        ($residueMismatches -join ",")
      )
    }
  }

  if ($shortcutMoved) {
    $quarantinedAttributes = Get-ShortcutAttributes $quarantinePath
    if (
      $null -eq $quarantinedAttributes -or
      ($quarantinedAttributes -band $nonRegularAttributes) -ne 0
    ) {
      throw "the quarantined shortcut is missing or is no longer a regular file"
    }
    $lastQuarantinedRecord = Get-ShortcutRecord $quarantinePath
    if (
      @(Get-ShortcutOwnershipMismatches $lastQuarantinedRecord $installedExe $installDir $ShortcutName $AppUserModelId).Count -ne 0 -or
      ([guid]$lastQuarantinedRecord.ToastClsid).ToString("B") -ne $verifiedClsid
    ) {
      throw "the quarantined shortcut changed during cleanup"
    }
    [System.IO.File]::Delete($quarantinePath)
    if ($null -ne (Get-ShortcutAttributes $quarantinePath)) {
      throw "the quarantined owned shortcut survived cleanup"
    }
    Write-CleanupEvent "removed" "shortcut" (
      "removed exact current-user Ave notification shortcut: $shortcutPath"
    )
  }
  exit 0
}
catch {
  $failureMessage = $_.Exception.Message
  if ($shortcutMoved) {
    try {
      if ($null -ne (Get-ShortcutAttributes $quarantinePath)) {
        if ($null -ne (Get-ShortcutAttributes $shortcutPath)) {
          throw "the original shortcut path was reoccupied"
        }
        [System.IO.File]::Move($quarantinePath, $shortcutPath)
        Write-CleanupEvent "foreign-preserved" "shortcut" "restored the quarantined shortcut after cleanup failed"
      }
    }
    catch {
      Write-CleanupEvent "contract-failed" "shortcut-quarantine" (
        "could not restore the candidate at {0}: {1}" -f $quarantinePath, $_.Exception.Message
      )
    }
  }
  Write-CleanupEvent "contract-failed" "notification-artifacts" $failureMessage
  [Console]::Error.WriteLine(
    "Ave current-user notification artifact cleanup failed: {0}",
    $failureMessage
  )
  exit 1
}
