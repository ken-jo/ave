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

function Assert-AveStopped {
  param([string]$Executable, [string]$UserSid)

  $name = [System.IO.Path]::GetFileName($Executable).Replace("\", "\\").Replace("'", "\'")
  foreach ($process in (Get-CimInstance -ClassName Win32_Process -Filter "Name = '$name'")) {
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) {
      throw "could not verify the owner of Ave process $($process.ProcessId)"
    }
    if ($owner.Sid -eq $UserSid) {
      throw "Ave is still running for this user (process $($process.ProcessId))"
    }
  }
}

function Initialize-ToastRegistry {
  # Managed registry methods can collapse a native failure into a missing value or a successful delete.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

public sealed class ToastRegistrySlot
{
    public RegistryValueKind Kind { get; private set; }
    public string Bytes { get; private set; }
    public object Value { get; private set; }

    public ToastRegistrySlot(RegistryValueKind kind, string bytes, object value)
    {
        Kind = kind;
        Bytes = bytes;
        Value = value;
    }
}

public sealed class ToastRegistryKey : IDisposable
{
    private const int FileNotFound = 2;
    private const int PathNotFound = 3;
    private const int QueryValueAccess = 0x0001;
    private const int SetValueAccess = 0x0002;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegOpenKeyExW(SafeRegistryHandle parent, string path, int options,
        int access, out SafeRegistryHandle key);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegQueryValueExW(SafeRegistryHandle key, string name, IntPtr reserved,
        out RegistryValueKind kind, [Out] byte[] data, ref int size);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegDeleteValueW(SafeRegistryHandle key, string name);

    private readonly SafeRegistryHandle handle;
    private readonly RegistryView view;

    private ToastRegistryKey(SafeRegistryHandle handle, RegistryView view)
    {
        this.handle = handle;
        this.view = view;
    }

    public static ToastRegistryKey OpenCurrentUser(string path, RegistryView view, bool writable)
    {
        using (var currentUser = new SafeRegistryHandle(new IntPtr((int)RegistryHive.CurrentUser), false))
            return Open(currentUser, path, view, writable);
    }

    public ToastRegistryKey OpenSubKey(string path, bool writable)
    {
        return Open(handle, path, view, writable);
    }

    private static ToastRegistryKey Open(SafeRegistryHandle parent, string path, RegistryView view, bool writable)
    {
        int access = (int)view | QueryValueAccess | (writable ? SetValueAccess : 0);
        SafeRegistryHandle key;
        int status = RegOpenKeyExW(parent, path, 0, access, out key);
        if (status == FileNotFound || status == PathNotFound) return null;
        CheckStatus(status, "opening registry key", path);
        return new ToastRegistryKey(key, view);
    }

    private static void CheckStatus(int status, string operation, string name)
    {
        if (status == 0) return;
        string label = name.Length == 0 ? "(default)" : name;
        throw new Win32Exception(status, String.Format("Error {0} {1} {2}: {3}",
            status, operation, label, new Win32Exception(status).Message));
    }

    private bool TryQueryValue(string name, byte[] data, out RegistryValueKind kind, ref int size)
    {
        int status = RegQueryValueExW(handle, name, IntPtr.Zero, out kind, data, ref size);
        if (status == FileNotFound) return false;
        CheckStatus(status, "reading registry value", name);
        return true;
    }

    public bool HasValue(string name)
    {
        RegistryValueKind kind;
        int size = 0;
        return TryQueryValue(name, null, out kind, ref size);
    }

    public ToastRegistrySlot ReadSlot(string name, RegistryValueKind expectedKind)
    {
        RegistryValueKind kind;
        int size = 0;
        if (!TryQueryValue(name, null, out kind, ref size)) return null;

        // Leave room for a data read even if the value reported a size of zero.
        byte[] data = new byte[Math.Max(size, 1)];
        RegistryValueKind dataKind;
        int dataSize = data.Length;
        if (!TryQueryValue(name, data, out dataKind, ref dataSize) || kind != dataKind || size != dataSize)
            throw new InvalidDataException("Registry value changed during read: " + name);

        string bytes = Convert.ToBase64String(data, 0, size);
        object value = kind == expectedKind ? DecodeValue(name, kind, data, size) : null;
        return new ToastRegistrySlot(kind, bytes, value);
    }

    private static object DecodeValue(string name, RegistryValueKind kind, byte[] data, int size)
    {
        if (kind == RegistryValueKind.DWord && size == sizeof(int))
            return BitConverter.ToInt32(data, 0);
        if (kind == RegistryValueKind.String && size % sizeof(char) == 0)
        {
            if (size >= sizeof(char) && data[size - 1] == 0 && data[size - 2] == 0)
                size -= sizeof(char);
            return Encoding.Unicode.GetString(data, 0, size);
        }
        throw new InvalidDataException("Invalid data size for registry value: " + name);
    }

    public void DeleteValue(string name)
    {
        int status = RegDeleteValueW(handle, name);
        if (status != FileNotFound) CheckStatus(status, "deleting registry value", name);
    }

    public void Dispose()
    {
        handle.Dispose();
    }
}
'@
}

[Flags()]
enum OwnedToastSlot {
  None = 0
  RootDefault = 1
  CustomActivator = 2
  ServerDefault = 4
  All = 7
}

function Read-ToastRegistrationSlots {
  param(
    [AllowNull()]$RootKey,
    [AllowNull()]$ServerKey,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $rootDefault = $null
  $customActivator = $null
  $serverDefault = $null
  if ($null -ne $RootKey) {
    $rootDefault = $RootKey.ReadSlot("", [Microsoft.Win32.RegistryValueKind]::String)
    $customActivator = $RootKey.ReadSlot("CustomActivator", [Microsoft.Win32.RegistryValueKind]::DWord)
  }
  if ($null -ne $ServerKey) {
    $serverDefault = $ServerKey.ReadSlot("", [Microsoft.Win32.RegistryValueKind]::String)
  }

  $slots = [OwnedToastSlot]::None
  if (
    $null -ne $rootDefault -and [string]::Equals(
      [string]$rootDefault.Value,
      "Electron Notification Activator",
      [System.StringComparison]::Ordinal
    )
  ) {
    $slots = $slots -bor [OwnedToastSlot]::RootDefault
  }
  if ($null -ne $customActivator -and $customActivator.Value -eq 1) {
    $slots = $slots -bor [OwnedToastSlot]::CustomActivator
  }
  if ($null -ne $serverDefault -and (Test-SamePath $serverDefault.Value $ExpectedExecutable)) {
    $slots = $slots -bor [OwnedToastSlot]::ServerDefault
  }
  return [PSCustomObject]@{
    RootExists = $null -ne $RootKey
    ServerExists = $null -ne $ServerKey
    RootDefault = $rootDefault
    CustomActivator = $customActivator
    ServerDefault = $serverDefault
    Owned = $slots
  }
}

function Read-ToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $root = $null
  $server = $null
  try {
    $root = [ToastRegistryKey]::OpenCurrentUser("Software\Classes\CLSID\$Clsid", $View, $false)
    if ($null -ne $root) { $server = $root.OpenSubKey("LocalServer32", $false) }
    return [PSCustomObject]@{
      View = $View
      Clsid = $Clsid
      Slots = Read-ToastRegistrationSlots $root $server $ExpectedExecutable
    }
  }
  finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $root) { $root.Dispose() }
  }
}

function Remove-OwnedToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][OwnedToastSlot]$ExpectedSlots,
    [switch]$AllowPartial
  )

  if (-not $AllowPartial -and $ExpectedSlots -ne [OwnedToastSlot]::All) {
    throw "incomplete Ave toast registration $Clsid ($View) for the owned shortcut"
  }

  $root = $null
  $server = $null
  try {
    $root = [ToastRegistryKey]::OpenCurrentUser("Software\Classes\CLSID\$Clsid", $View, $true)
    if ($null -eq $root) { throw "Ave toast registration $Clsid ($View) disappeared before deletion" }
    $server = $root.OpenSubKey("LocalServer32", $true)

    # Recheck exact types and data on writable handles. Keep the keys so a
    # concurrent writer's values cannot be removed by key deletion.
    $state = Read-ToastRegistrationSlots $root $server $ExpectedExecutable
    $slots = $state.Owned
    if (
      ((-not ($slots -band [OwnedToastSlot]::ServerDefault)) -and $null -ne $state.ServerDefault) -or
      ((-not ($slots -band [OwnedToastSlot]::CustomActivator)) -and $null -ne $state.CustomActivator) -or
      ((-not ($slots -band [OwnedToastSlot]::RootDefault)) -and $null -ne $state.RootDefault)
    ) {
      throw "Ave toast registration $Clsid ($View) contains a foreign value in a registration slot"
    }
    # Both registry views can expose the same key.
    if ($slots -eq [OwnedToastSlot]::None) { return $false }
    if ($slots -ne $ExpectedSlots) {
      throw "Ave toast registration $Clsid ($View) changed before deletion"
    }

    if ($slots -band [OwnedToastSlot]::ServerDefault) { $server.DeleteValue("") }
    if ($slots -band [OwnedToastSlot]::CustomActivator) { $root.DeleteValue("CustomActivator") }
    if ($slots -band [OwnedToastSlot]::RootDefault) { $root.DeleteValue("") }
    $remainingValues = @(
      if ($null -ne $server -and $server.HasValue("")) { "LocalServer32 (default)" }
      if ($root.HasValue("CustomActivator")) { "CustomActivator" }
      if ($root.HasValue("")) { "CLSID (default)" }
    )
    if ($remainingValues.Count -ne 0) {
      throw "Ave toast registration $Clsid ($View) retained values: $($remainingValues -join ', ')"
    }
    return $true
  }
  finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $root) { $root.Dispose() }
  }
}

function Read-ToastRegistrations {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string[]]$CandidateClsids
  )

  foreach ($view in (Get-RegistryViews)) {
    foreach ($clsid in $CandidateClsids) {
      Read-ToastRegistration $view $clsid $ExpectedExecutable
    }
  }
}

function Confirm-ToastRegistrationsAbsent {
  param([string]$ExpectedExecutable, [string[]]$CandidateClsids)

  $previous = $null
  for ($pass = 0; $pass -lt 2; $pass++) {
    $scan = @(Read-ToastRegistrations $ExpectedExecutable $CandidateClsids)
    foreach ($registration in $scan) {
      if ($registration.Slots.Owned -ne [OwnedToastSlot]::None) {
        throw "owned Ave toast registration values for $($registration.Clsid) ($($registration.View)) survived cleanup"
      }
    }
    $snapshot = ConvertTo-Json -InputObject $scan -Depth 5 -Compress
    if ($pass -ne 0 -and $snapshot -cne $previous) {
      throw "Ave toast registration state changed between final scans"
    }
    $previous = $snapshot
  }
}

function Assert-NoQuarantinedShortcut {
  param([string]$Programs, [string]$ShortcutName)

  $pattern = '^\.' + [regex]::Escape($ShortcutName) + '\.ave-uninstall-[0-9a-f]{32}\.lnk$'
  try {
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($Programs)) {
      if ([System.IO.Path]::GetFileName($entry) -match $pattern) {
        throw "a prior Ave notification shortcut remains in quarantine"
      }
    }
  }
  catch [System.IO.DirectoryNotFoundException] {}
}

$cleanupMutex = $null
$cleanupMutexHeld = $false
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
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $cleanupMutex = [System.Threading.Mutex]::new($false, "Global\AveNotificationCleanup-$userSid")
  try {
    $cleanupMutexHeld = $cleanupMutex.WaitOne(0)
  }
  catch [System.Threading.AbandonedMutexException] {
    $cleanupMutexHeld = $true
  }
  if (-not $cleanupMutexHeld) {
    throw "another Ave notification cleanup is in progress for this user"
  }

  Assert-AveStopped $installedExe $userSid
  Initialize-ToastRegistry
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
  $verifiedClsid = $null

  Assert-NoQuarantinedShortcut $programs $ShortcutName
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

  foreach ($registration in @(Read-ToastRegistrations $installedExe $candidateClsids)) {
    $owned = $registration.Slots.Owned
    if ($owned -eq [OwnedToastSlot]::None) { continue }
    if (Remove-OwnedToastRegistration $registration.View $registration.Clsid $installedExe $owned `
        -AllowPartial:($registration.Clsid -eq $productClsid)) {
      Write-CleanupEvent "removed" "toast-registration" (
        "Removed owned current-user Ave toast registration values for {0} ({1})." -f
        $registration.Clsid,
        $registration.View
      )
    }
  }

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
  }

  Assert-AveStopped $installedExe $userSid
  Confirm-ToastRegistrationsAbsent $installedExe $candidateClsids
  Write-CleanupEvent "verified-absent" "toast-registration" (
    "no owned current-user Ave toast registration values remain"
  )

  if ($shortcutMoved) {
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
finally {
  if ($cleanupMutexHeld) { $cleanupMutex.ReleaseMutex() }
  if ($null -ne $cleanupMutex) { $cleanupMutex.Dispose() }
}
