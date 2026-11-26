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
    if ($path -ne "Software\Classes\CLSID\{762333EB-F45E-4825-9E7A-61BBADC1AEE6}") { return $null }
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
    [System.IO.File]::WriteAllText(
      $env:AVE_FIXTURE_REGISTRY, ([FixtureRegistryKey]::State | ConvertTo-Json -Depth 4 -Compress)
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
    ToastClsid = "{762333EB-F45E-4825-9E7A-61BBADC1AEE6}"
  }
}
