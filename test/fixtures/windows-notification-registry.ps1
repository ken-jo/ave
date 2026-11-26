class FixtureRegistryKey {
  static [bool] $RootDefault = $true
  static [bool] $CustomActivator = $true
  static [bool] $ServerDefault = $true
  [string] $Role

  FixtureRegistryKey([string]$role) { $this.Role = $role }

  static [FixtureRegistryKey] OpenBaseKey([Microsoft.Win32.RegistryView]$view) {
    return [FixtureRegistryKey]::new("base")
  }

  static [FixtureRegistryKey] OpenCurrentUser(
    [string]$path, [Microsoft.Win32.RegistryView]$view, [bool]$writable
  ) {
    return [FixtureRegistryKey]::new("root")
  }

  [FixtureRegistryKey] OpenSubKey([string]$path, [bool]$writable) {
    if ($this.Role -eq "base") { return [FixtureRegistryKey]::new("root") }
    return [FixtureRegistryKey]::new("server")
  }

  [bool] HasValue([string]$name) {
    if ($this.Role -eq "server") { return [FixtureRegistryKey]::ServerDefault }
    if ($name -eq "CustomActivator") { return [FixtureRegistryKey]::CustomActivator }
    return [FixtureRegistryKey]::RootDefault
  }

  [Microsoft.Win32.RegistryValueKind] GetValueKind([string]$name) {
    if (-not $this.HasValue($name)) { return [Microsoft.Win32.RegistryValueKind]::None }
    if ($name -eq "CustomActivator") { return [Microsoft.Win32.RegistryValueKind]::DWord }
    return [Microsoft.Win32.RegistryValueKind]::String
  }

  [object] GetValue([string]$name, [object]$missing) {
    return $this.GetValue($name, $missing, [Microsoft.Win32.RegistryValueOptions]::None)
  }

  [object] GetValue([string]$name, [object]$missing, [Microsoft.Win32.RegistryValueOptions]$options) {
    if ($env:AVE_FIXTURE_SCENARIO -eq "read-error") {
      [Console]::Error.WriteLine("fixture exercised read-error")
      throw [System.UnauthorizedAccessException]::new("fixture denied the value read")
    }
    if (-not $this.HasValue($name)) { return $missing }
    if ($this.Role -eq "server") { return (Join-Path $env:AVE_FIXTURE_DIRECTORY "Ave.exe") }
    if ($name -eq "CustomActivator") { return 1 }
    return "Electron Notification Activator"
  }

  [object] ReadValue([string]$name, [Microsoft.Win32.RegistryValueKind]$kind) {
    if ($this.GetValueKind($name) -ne $kind) { return $null }
    return $this.GetValue($name, $null)
  }

  [void] DeleteValue([string]$name, [bool]$throwOnMissing) { $this.DeleteValue($name) }

  [void] DeleteValue([string]$name) {
    if ($this.Role -eq "server") {
      [FixtureRegistryKey]::ServerDefault = $false
    }
    elseif ($name -eq "CustomActivator") {
      if ($env:AVE_FIXTURE_SCENARIO -eq "delete-noop") {
        [Console]::Error.WriteLine("fixture exercised delete-noop")
        return
      }
      [FixtureRegistryKey]::CustomActivator = $false
    }
    else {
      [FixtureRegistryKey]::RootDefault = $false
    }
  }

  [void] Dispose() {}
}

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
