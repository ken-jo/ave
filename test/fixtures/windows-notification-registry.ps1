class FixtureRegistryKey {
  static [object] $State
  static [bool] $Deleted
  static [bool] $ProductStarted
  static [int] $FinalScanCount
  [string] $Role
  [bool] $FinalView

  FixtureRegistryKey([string]$role) { $this.Role = $role }

  static [FixtureRegistryKey] OpenCurrentUser(
    [string]$path, [Microsoft.Win32.RegistryView]$view, [bool]$writable
  ) {
    if ($path -ne "Software\Classes\CLSID\$env:AVE_FIXTURE_CLSID") { return $null }
    $key = [FixtureRegistryKey]::new("root")
    $key.FinalView = -not $writable -and $view -eq [Microsoft.Win32.RegistryView]::Registry32
    if ($key.FinalView -and [FixtureRegistryKey]::Deleted) { [FixtureRegistryKey]::FinalScanCount++ }
    return $key
  }

  [FixtureRegistryKey] OpenSubKey([string]$path, [bool]$writable) {
    if ($path -eq "LocalServer32" -and $null -ne [FixtureRegistryKey]::State.server) {
      $key = [FixtureRegistryKey]::new("server")
      $key.FinalView = $this.FinalView -and -not $writable
      return $key
    }
    if ($path -eq "Foreign" -and $null -ne [FixtureRegistryKey]::State.foreign) {
      return [FixtureRegistryKey]::new("foreign")
    }
    return $null
  }

  [string] ValueSlot([string]$name) {
    if ($name -eq "") { return "defaultValue" }
    return $name
  }

  [object] Value([string]$name) {
    $key = [FixtureRegistryKey]::State.($this.Role)
    $slot = $this.ValueSlot($name)
    $property = $key.PSObject.Properties[$slot]
    if ($null -eq $property) { return $null }
    return $property.Value
  }

  [bool] HasValue([string]$name) { return $null -ne $this.Value($name) }

  [Microsoft.Win32.RegistryValueKind] GetValueKind([string]$name) {
    $value = $this.Value($name)
    if ($value -is [int]) { return [Microsoft.Win32.RegistryValueKind]::DWord }
    if ($value -is [string]) { return [Microsoft.Win32.RegistryValueKind]::String }
    return [Microsoft.Win32.RegistryValueKind]::None
  }

  [object] ReadSlot([string]$name, [Microsoft.Win32.RegistryValueKind]$expectedKind) {
    $this.BeforeRead($name)
    if ($env:AVE_FIXTURE_SCENARIO -eq "read-error") {
      [Console]::Error.WriteLine("fixture exercised read-error")
      throw [System.UnauthorizedAccessException]::new("fixture denied the value read")
    }
    $value = $this.Value($name)
    if ($null -eq $value) { return $null }
    $kind = $this.GetValueKind($name)
    return [PSCustomObject]@{
      Kind = $kind
      Bytes = ConvertTo-Json -InputObject $value -Compress
      Value = if ($kind -eq $expectedKind) { $value } else { $null }
    }
  }

  [void] BeforeRead([string]$name) {
    if ($this.FinalView -and [FixtureRegistryKey]::FinalScanCount -gt 0) {
      $scenario = $env:AVE_FIXTURE_SCENARIO
      if ($scenario -eq "final-read-error") {
        [Console]::Error.WriteLine("fixture exercised final-read-error")
        throw [System.UnauthorizedAccessException]::new("fixture denied the final scan read")
      }
      # The last read of the last scan: only the cleanup lock can stop an Ave start here from provisioning.
      if (
        $scenario -eq "product-start" -and $this.Role -eq "server" -and $name -eq "" -and
        [FixtureRegistryKey]::FinalScanCount -eq [int]$env:AVE_FIXTURE_FINAL_SCANS -and
        -not [FixtureRegistryKey]::ProductStarted
      ) {
        [FixtureRegistryKey]::ProductStarted = $true
        if ([FixtureRegistryKey]::WaitForProductStart() -eq "provisioned") {
          [FixtureRegistryKey]::State.root |
            Add-Member -NotePropertyName defaultValue -NotePropertyValue "Electron Notification Activator"
          [FixtureRegistryKey]::Save()
        }
      }
    }
  }

  static [string] WaitForProductStart() {
    [System.IO.File]::WriteAllText($env:AVE_FIXTURE_SIGNAL, "started")
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not [System.IO.File]::Exists("$($env:AVE_FIXTURE_SIGNAL).ack")) {
      if ([DateTime]::UtcNow -gt $deadline) { throw "fixture product start was not acknowledged" }
      Start-Sleep -Milliseconds 50
    }
    return [System.IO.File]::ReadAllText("$($env:AVE_FIXTURE_SIGNAL).ack")
  }

  static [void] Save() {
    [System.IO.File]::WriteAllText(
      $env:AVE_FIXTURE_REGISTRY, ([FixtureRegistryKey]::State | ConvertTo-Json -Depth 4 -Compress)
    )
  }

  [void] DeleteValue([string]$name) {
    if ($this.Role -eq "root" -and $name -eq "CustomActivator") {
      if ($env:AVE_FIXTURE_SCENARIO -eq "delete-noop") {
        [Console]::Error.WriteLine("fixture exercised delete-noop")
        return
      }
      if ($env:AVE_FIXTURE_SCENARIO -eq "delete-error") {
        [Console]::Error.WriteLine("fixture exercised delete-error")
        throw [System.UnauthorizedAccessException]::new("fixture denied deleting CustomActivator")
      }
    }
    $key = [FixtureRegistryKey]::State.($this.Role)
    $key.PSObject.Properties.Remove($this.ValueSlot($name))
    [FixtureRegistryKey]::Deleted = $true
    [FixtureRegistryKey]::Save()
    if ($env:AVE_FIXTURE_SCENARIO -eq "foreign-replace" -and $this.Role -eq "server") {
      [FixtureRegistryKey]::State.root.PSObject.Properties.Remove("CustomActivator")
      [FixtureRegistryKey]::State.root | Add-Member -NotePropertyName CustomActivator -NotePropertyValue "foreign data"
      [FixtureRegistryKey]::Save()
      [Console]::Error.WriteLine("fixture exercised foreign-replace")
    }
    if ($env:AVE_FIXTURE_SCENARIO -eq "overlap" -and $this.Role -eq "server") {
      $this.RunOverlappingCleanup()
      throw [System.UnauthorizedAccessException]::new("fixture stopped the first cleanup")
    }
  }

  [void] RunOverlappingCleanup() {
    $dir = $env:AVE_FIXTURE_DIRECTORY
    $quarantine = @(Get-ChildItem -LiteralPath $dir -Filter ".Ave.ave-uninstall-*.lnk" -Force)
    if ($quarantine.Count -ne 1 -or [System.IO.File]::Exists((Join-Path $dir "Ave.lnk"))) {
      throw "fixture expected the legacy shortcut in quarantine"
    }
    $evidence = [System.IO.File]::ReadAllText($quarantine[0].FullName)
    $env:AVE_FIXTURE_SCENARIO = ""
    $ErrorActionPreference = "Continue"
    $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $output = & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
      -File (Join-Path $dir "cleanup.ps1") -InstalledExecutable (Join-Path $dir "Ave.exe") `
      -ShortcutName Ave -AppUserModelId ai.example.toast -InstallMarker (Join-Path $dir ".ave-nsis-per-machine-v1") `
      2>&1 | Out-String
    $result = @{ status = $global:LASTEXITCODE; evidence = $evidence; output = $output }
    [System.IO.File]::WriteAllText(
      $env:AVE_FIXTURE_OVERLAP_RESULT, ($result | ConvertTo-Json -Compress)
    )
  }

  [void] Dispose() {}
}

[FixtureRegistryKey]::State = ConvertFrom-Json ([System.IO.File]::ReadAllText($env:AVE_FIXTURE_REGISTRY))

function Get-CimInstance {
  param($ClassName, $Filter)
  if ($ClassName -ne "Win32_Process" -or $Filter -ne "Name = 'Ave.exe'") {
    throw "unexpected process lookup: $ClassName $Filter"
  }
  if ($env:AVE_FIXTURE_SCENARIO -in @("app-running", "other-user-app", "owner-lookup-error")) {
    [PSCustomObject]@{ ProcessId = 1234 }
  }
}

function Invoke-CimMethod {
  param($InputObject, $MethodName)
  if ($InputObject.ProcessId -ne 1234 -or $MethodName -ne "GetOwnerSid") {
    throw "unexpected process owner lookup"
  }
  if ($env:AVE_FIXTURE_SCENARIO -eq "owner-lookup-error") {
    return [PSCustomObject]@{ ReturnValue = 2; Sid = $null }
  }
  $sid = if ($env:AVE_FIXTURE_SCENARIO -eq "app-running") {
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  }
  else { "S-1-5-21-1-2-3-4" }
  [PSCustomObject]@{ ReturnValue = 0; Sid = $sid }
}

function Get-ShortcutRecord {
  param([string]$Path)
  $content = [System.IO.File]::ReadAllText($Path)
  $clsids = @{
    "fixture shortcut evidence" = $env:AVE_FIXTURE_CLSID
    "fixture product shortcut" = "{62FD3EFB-B3D2-4235-9402-6979F52C0286}"
    "fixture foreign shortcut" = "{11111111-2222-4333-8444-555555555555}"
  }
  if (-not $clsids.ContainsKey($content)) {
    throw "unexpected shortcut fixture content"
  }
  $directory = $env:AVE_FIXTURE_DIRECTORY
  if ($content -eq "fixture foreign shortcut") { $directory = Join-Path $directory "elsewhere" }
  return [PSCustomObject]@{
    Target = Join-Path $directory "Ave.exe"
    WorkingDirectory = $directory
    Arguments = ""
    Description = "Ave"
    AppUserModelId = "ai.example.toast"
    ToastClsid = $clsids[$content]
  }
}

if ($env:AVE_FIXTURE_SCENARIO -eq "unrelated-lock") {
  $foreignLock = [System.IO.File]::Open(
    (Join-Path $env:AVE_FIXTURE_DIRECTORY ".ave-notification-cleanup.lock"), "Open", "Read", "None"
  )
  try { [FixtureRegistryKey]::WaitForProductStart() }
  finally { $foreignLock.Dispose() }
  exit 0
}
