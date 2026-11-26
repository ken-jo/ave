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

function Initialize-ToastCleanup {
  # Managed registry methods can collapse a native failure into a missing value or a successful delete.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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

public sealed class ToastShortcutFile : IDisposable
{
    private const uint GenericRead = 0x80000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint OpenReparsePoint = 0x00200000;
    private const int FileDispositionInfo = 4;
    private const int FileAttributeTagInfo = 9;
    private const int FileIdInfo = 18;

    [StructLayout(LayoutKind.Sequential)]
    private struct AttributeTag
    {
        public FileAttributes Attributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdentity
    {
        public ulong Volume;
        public ulong Low;
        public ulong High;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, FileShare share,
        IntPtr security, FileMode mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass,
        out AttributeTag information, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass,
        out FileIdentity information, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass,
        ref byte information, int size);

    private readonly FileStream stream;
    private readonly FileIdentity identity;

    private ToastShortcutFile(FileStream stream, FileIdentity identity)
    {
        this.stream = stream;
        this.identity = identity;
    }

    public static ToastShortcutFile Open(string path, bool forDeletion)
    {
        var handle = CreateFileW(path, GenericRead | (forDeletion ? DeleteAccess : 0), FileShare.Read,
            IntPtr.Zero, FileMode.Open, OpenReparsePoint, IntPtr.Zero);
        try
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            AttributeTag tag;
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out tag, Marshal.SizeOf(typeof(AttributeTag))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((tag.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new IOException("The quarantined shortcut is not a regular file");
            FileIdentity identity;
            if (!GetFileInformationByHandleEx(handle, FileIdInfo, out identity, Marshal.SizeOf(typeof(FileIdentity))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return new ToastShortcutFile(new FileStream(handle, FileAccess.Read), identity);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public string Digest()
    {
        using (var hash = SHA256.Create())
            return Convert.ToBase64String(hash.ComputeHash(stream));
    }

    public bool Matches(ToastShortcutFile verifiedFile, string digest)
    {
        return identity.Volume == verifiedFile.identity.Volume &&
            identity.Low == verifiedFile.identity.Low && identity.High == verifiedFile.identity.High &&
            Digest() == digest;
    }

    public void Delete()
    {
        byte delete = 1;
        if (!SetFileInformationByHandle(stream.SafeFileHandle, FileDispositionInfo, ref delete, sizeof(byte)))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Dispose()
    {
        stream.Dispose();
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

function Test-OwnedToastSlotValue {
  param(
    [Parameter(Mandatory = $true)][OwnedToastSlot]$Slot,
    [AllowNull()]$Value,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  if ($null -eq $Value) { return $false }
  if ($Slot -eq [OwnedToastSlot]::RootDefault) {
    return [string]::Equals(
      [string]$Value.Value,
      "Electron Notification Activator",
      [System.StringComparison]::Ordinal
    )
  }
  if ($Slot -eq [OwnedToastSlot]::CustomActivator) { return $Value.Value -eq 1 }
  return Test-SamePath $Value.Value $ExpectedExecutable
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
  if (Test-OwnedToastSlotValue RootDefault $rootDefault $ExpectedExecutable) {
    $slots = $slots -bor [OwnedToastSlot]::RootDefault
  }
  if (Test-OwnedToastSlotValue CustomActivator $customActivator $ExpectedExecutable) {
    $slots = $slots -bor [OwnedToastSlot]::CustomActivator
  }
  if (Test-OwnedToastSlotValue ServerDefault $serverDefault $ExpectedExecutable) {
    $slots = $slots -bor [OwnedToastSlot]::ServerDefault
  }
  return [PSCustomObject]@{
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

# Deletion boundary: reread one slot and report whether it still holds the
# owned typed value. A value that stopped matching is never deleted.
function Test-ToastSlotStillOwned {
  param(
    [Parameter(Mandatory = $true)]$Key,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Name,
    [Parameter(Mandatory = $true)][Microsoft.Win32.RegistryValueKind]$Kind,
    [Parameter(Mandatory = $true)][OwnedToastSlot]$Slot,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $current = $Key.ReadSlot($Name, $Kind)
  if ($null -eq $current) { return $false }
  if (-not (Test-OwnedToastSlotValue $Slot $current $ExpectedExecutable)) {
    throw "the $Slot registration slot changed to a foreign value before deletion"
  }
  $script:toastRegistryMutated = $true
  return $true
}

function Remove-OwnedToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [switch]$AllowPartial
  )

  $string = [Microsoft.Win32.RegistryValueKind]::String
  $dword = [Microsoft.Win32.RegistryValueKind]::DWord
  $root = $null
  $server = $null
  try {
    $root = [ToastRegistryKey]::OpenCurrentUser("Software\Classes\CLSID\$Clsid", $View, $true)
    # Both registry views can expose the same key.
    if ($null -eq $root) { return $false }
    $server = $root.OpenSubKey("LocalServer32", $true)

    # Keep the keys so a concurrent writer's values cannot be removed by key deletion.
    $state = Read-ToastRegistrationSlots $root $server $ExpectedExecutable
    $slots = $state.Owned
    if (
      ((-not ($slots -band [OwnedToastSlot]::ServerDefault)) -and $null -ne $state.ServerDefault) -or
      ((-not ($slots -band [OwnedToastSlot]::CustomActivator)) -and $null -ne $state.CustomActivator) -or
      ((-not ($slots -band [OwnedToastSlot]::RootDefault)) -and $null -ne $state.RootDefault)
    ) {
      throw "Ave toast registration $Clsid ($View) contains a foreign value in a registration slot"
    }
    if ($slots -eq [OwnedToastSlot]::None) { return $false }
    if (-not $AllowPartial -and $slots -ne [OwnedToastSlot]::All) {
      throw "incomplete Ave toast registration $Clsid ($View) for the owned shortcut"
    }

    if ($null -ne $server -and (Test-ToastSlotStillOwned $server "" $string ServerDefault $ExpectedExecutable)) {
      $server.DeleteValue("")
    }
    if (Test-ToastSlotStillOwned $root "CustomActivator" $dword CustomActivator $ExpectedExecutable) {
      $root.DeleteValue("CustomActivator")
    }
    if (Test-ToastSlotStillOwned $root "" $string RootDefault $ExpectedExecutable) {
      $root.DeleteValue("")
    }
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

  foreach ($registration in @(Read-ToastRegistrations $ExpectedExecutable $CandidateClsids)) {
    if ($registration.Slots.Owned -ne [OwnedToastSlot]::None) {
      throw "owned Ave toast registration values for $($registration.Clsid) ($($registration.View)) survived cleanup"
    }
  }
}

function Get-OwnedShortcutClsid {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Expected
  )

  $attributes = Get-ShortcutAttributes $Path
  if ($null -eq $attributes -or ($attributes -band $Expected.NonRegular) -ne 0) {
    throw "the quarantined shortcut is missing or is no longer a regular file"
  }
  $record = Get-ShortcutRecord $Path
  $ownershipMismatches = @(
    Get-ShortcutOwnershipMismatches $record $Expected.Executable $Expected.Directory $Expected.Name $Expected.AppUserModelId
  )
  if ($ownershipMismatches.Count -ne 0) {
    throw ("the quarantined shortcut is not the exact owned shortcut; mismatched fields: {0}" -f ($ownershipMismatches -join ","))
  }
  return ([guid]$record.ToastClsid).ToString("B")
}

# Entries a previous cleanup left in quarantine. Clsid is set only for an
# exact owned shortcut; any other entry is unattributable and has Clsid $null.
function Get-QuarantinedShortcuts {
  param(
    [Parameter(Mandatory = $true)][string]$Programs,
    [Parameter(Mandatory = $true)]$Expected
  )

  $pattern = '^\.' + [regex]::Escape($Expected.Name) + '\.ave-uninstall-[0-9a-f]{32}\.lnk$'
  $entries = @()
  try {
    $entries = @([System.IO.Directory]::EnumerateFileSystemEntries($Programs))
  }
  catch [System.IO.DirectoryNotFoundException] {}
  foreach ($entry in $entries) {
    if ([System.IO.Path]::GetFileName($entry) -notmatch $pattern) { continue }
    $clsid = $null
    try { $clsid = Get-OwnedShortcutClsid $entry $Expected }
    catch {}
    [PSCustomObject]@{ Path = $entry; Clsid = $clsid }
  }
}

$cleanupLock = $null
$shortcutMoved = $false
$script:toastRegistryMutated = $false
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

  # One per-user lock coordinates cleanup with other cleanups and with Ave,
  # which exits at startup while the lock is held (src/main/windows-notification-cleanup-lock.ts).
  # Taking it before the process check means a later Ave start cannot provision artifacts.
  $lockDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  if ([string]::IsNullOrWhiteSpace($lockDirectory)) {
    throw "the current user's roaming application data folder is unavailable"
  }
  try {
    $cleanupLock = [System.IO.FileStream]::new(
      (Join-Path $lockDirectory ".ave-notification-cleanup.lock"),
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete),
      1,
      [System.IO.FileOptions]::DeleteOnClose
    )
  }
  catch [System.IO.IOException] {
    # ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS, ERROR_SHARING_VIOLATION
    if ($_.Exception.GetBaseException().HResult -notin @(-2147024816, -2147024713, -2147024864)) { throw }
    throw "the current user's Ave notification cleanup lock path is occupied"
  }
  $cleanupLock.Lock(0, 1)
  $cleanupLock.WriteByte(0)
  $lockMarker = [System.Text.Encoding]::ASCII.GetBytes("Ave notification cleanup v1")
  $cleanupLock.Write($lockMarker, 0, $lockMarker.Length)
  $cleanupLock.Flush()
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Assert-AveStopped $installedExe $userSid

  Initialize-ToastCleanup
  $programs = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Programs,
    [Environment+SpecialFolderOption]::DoNotVerify
  )
  if ([string]::IsNullOrWhiteSpace($programs)) {
    throw "the current user's Programs known folder is unavailable"
  }
  $shortcutPath = Join-Path $programs ($ShortcutName + ".lnk")
  $nonRegularAttributes = [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
  $expectedShortcut = [PSCustomObject]@{
    Executable = $installedExe
    Directory = $installDir
    Name = $ShortcutName
    AppUserModelId = $AppUserModelId
    NonRegular = $nonRegularAttributes
  }
  $productClsid = "{62FD3EFB-B3D2-4235-9402-6979F52C0286}"
  $candidateClsids = @($productClsid)
  $quarantined = @()
  $unattributedQuarantine = $false

  foreach ($entry in @(Get-QuarantinedShortcuts $programs $expectedShortcut)) {
    if ($null -eq $entry.Clsid) {
      $unattributedQuarantine = $true
      Write-CleanupEvent "foreign-preserved" "shortcut-quarantine" (
        "left an unattributable quarantine entry untouched: $($entry.Path)"
      )
      continue
    }
    $quarantined += $entry
    if ($candidateClsids -notcontains $entry.Clsid) { $candidateClsids += $entry.Clsid }
  }

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
        # Quarantine the verified shortcut until registry cleanup finishes.
        # It names the legacy CLSID, and a later cleanup resumes from it.
        $quarantinePath = Join-Path $programs (
          ".{0}.ave-uninstall-{1}.lnk" -f
          $ShortcutName,
          [System.Guid]::NewGuid().ToString("N")
        )
        [System.IO.File]::Move($shortcutPath, $quarantinePath)
        $shortcutMoved = $true
        $verifiedClsid = Get-OwnedShortcutClsid $quarantinePath $expectedShortcut
        if ($verifiedClsid -ne ([guid]$record.ToastClsid).ToString("B")) {
          throw "the shortcut toast activator CLSID changed before atomic quarantine"
        }
        $quarantined += [PSCustomObject]@{ Path = $quarantinePath; Clsid = $verifiedClsid }
        if ($candidateClsids -notcontains $verifiedClsid) { $candidateClsids += $verifiedClsid }
      }
    }
  }

  foreach ($registration in @(Read-ToastRegistrations $installedExe $candidateClsids)) {
    if ($registration.Slots.Owned -eq [OwnedToastSlot]::None) { continue }
    if (Remove-OwnedToastRegistration $registration.View $registration.Clsid $installedExe `
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

  Confirm-ToastRegistrationsAbsent $installedExe $candidateClsids
  Write-CleanupEvent "verified-absent" "toast-registration" (
    "no owned current-user Ave toast registration values remained at the final read under the cleanup lock"
  )

  foreach ($entry in $quarantined) {
    # Keep the shortcut stable while its shell properties are read by path.
    $verifiedFile = [ToastShortcutFile]::Open($entry.Path, $false)
    try {
      if ((Get-OwnedShortcutClsid $entry.Path $expectedShortcut) -ne $entry.Clsid) {
        throw "the quarantined shortcut changed during cleanup"
      }
      $digest = $verifiedFile.Digest()
    }
    finally { $verifiedFile.Dispose() }

    $deleteFile = [ToastShortcutFile]::Open($entry.Path, $true)
    try {
      if (-not $deleteFile.Matches($verifiedFile, $digest)) {
        throw "the quarantined shortcut changed before deletion"
      }
      $deleteFile.Delete()
    }
    finally { $deleteFile.Dispose() }
    if ($null -ne (Get-ShortcutAttributes $entry.Path)) {
      throw "the quarantined owned shortcut survived cleanup"
    }
    Write-CleanupEvent "removed" "shortcut" (
      "removed exact current-user Ave notification shortcut: $($entry.Path)"
    )
  }
  if ($unattributedQuarantine) {
    # Everything attributable is verified removed; only the reported entry remains.
    exit 2
  }
  exit 0
}
catch {
  $failureMessage = $_.Exception.Message
  if ($shortcutMoved) {
    if ($script:toastRegistryMutated) {
      Write-CleanupEvent "contract-failed" "shortcut-quarantine" (
        "kept the owned shortcut in quarantine for the next cleanup to resume: $quarantinePath"
      )
    }
    else {
      try {
        # Move never overwrites, so a reoccupied path leaves the shortcut in quarantine.
        [System.IO.File]::Move($quarantinePath, $shortcutPath)
        Write-CleanupEvent "foreign-preserved" "shortcut" "restored the quarantined shortcut after cleanup failed"
      }
      catch {
        Write-CleanupEvent "contract-failed" "shortcut-quarantine" (
          "left the owned shortcut in quarantine at {0} for the next cleanup to resume: {1}" -f
          $quarantinePath, $_.Exception.Message
        )
      }
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
  if ($null -ne $cleanupLock) { $cleanupLock.Dispose() }
}
