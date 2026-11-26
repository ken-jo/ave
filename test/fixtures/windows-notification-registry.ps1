class FixtureRegistryKey {
  static [object] $State
  [string] $Role

  FixtureRegistryKey([string]$role) { $this.Role = $role }

  static [FixtureRegistryKey] OpenBaseKey([Microsoft.Win32.RegistryView]$view) {
    return [FixtureRegistryKey]::new("base")
  }

  static [FixtureRegistryKey] OpenCurrentUser(
    [string]$path, [Microsoft.Win32.RegistryView]$view, [bool]$writable
  ) {
    if ($path -ne "Software\Classes\CLSID\$env:AVE_FIXTURE_CLSID") { return $null }
    return [FixtureRegistryKey]::new("root")
  }

  [FixtureRegistryKey] OpenSubKey([string]$path, [bool]$writable) {
    if ($this.Role -eq "base") { return [FixtureRegistryKey]::OpenCurrentUser($path, "Default", $writable) }
    if ($path -eq "LocalServer32" -and $null -ne [FixtureRegistryKey]::State.server) {
      return [FixtureRegistryKey]::new("server")
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

  [object] GetValue([string]$name, [object]$missing) {
    return $this.GetValue($name, $missing, [Microsoft.Win32.RegistryValueOptions]::None)
  }

  [object] GetValue([string]$name, [object]$missing, [Microsoft.Win32.RegistryValueOptions]$options) {
    if ($env:AVE_FIXTURE_SCENARIO -eq "read-error") {
      [Console]::Error.WriteLine("fixture exercised read-error")
      throw [System.UnauthorizedAccessException]::new("fixture denied the value read")
    }
    $value = $this.Value($name)
    if ($null -eq $value) { return $missing }
    return $value
  }

  [object] ReadValue([string]$name, [Microsoft.Win32.RegistryValueKind]$kind) {
    if ($this.GetValueKind($name) -ne $kind) { return $null }
    return $this.GetValue($name, $null)
  }

  static [void] Save() {
    [System.IO.File]::WriteAllText(
      $env:AVE_FIXTURE_REGISTRY, ([FixtureRegistryKey]::State | ConvertTo-Json -Depth 4 -Compress)
    )
  }

  [void] DeleteValue([string]$name, [bool]$throwOnMissing) { $this.DeleteValue($name) }

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
    [FixtureRegistryKey]::Save()
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

function Get-ShortcutRecord {
  param([string]$Path)
  if ([System.IO.File]::ReadAllText($Path) -ne "fixture shortcut evidence") {
    throw "unexpected shortcut fixture content"
  }
  return [PSCustomObject]@{
    Target = Join-Path $env:AVE_FIXTURE_DIRECTORY "Ave.exe"
    WorkingDirectory = $env:AVE_FIXTURE_DIRECTORY
    Arguments = ""
    Description = "Ave"
    AppUserModelId = "ai.example.toast"
    ToastClsid = $env:AVE_FIXTURE_CLSID
  }
}
