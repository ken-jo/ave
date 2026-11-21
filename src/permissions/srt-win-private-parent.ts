import { execFileSync } from "node:child_process";

import { WINDOWS_HOME_BOUNDARY_SOURCE } from "../shared/windows-home-boundary.js";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const POWERSHELL_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
];

const TEMP_ROOT_ACL_DIAGNOSTIC = "srt-win-temp-root-acl-owner-action-required";

// A marker is useful only inside verified private directories. Support both layouts, deleting only their two known plain files without recursion.
const SWEEP_SCRIPT = [
  ...POWERSHELL_PROLOGUE,
  "$root = [System.IO.Path]::GetFullPath($env:AVE_SRT_TEMP_ROOT).TrimEnd('\\')",
  "$reparse = [System.IO.FileAttributes]::ReparsePoint",
  "if (([System.IO.File]::GetAttributes($root) -band $reparse) -ne 0) { exit }",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  // Diagnose the installed account's legacy temp-root ACEs without changing any descriptor.
  `try { $sandboxSid = (New-Object System.Security.Principal.NTAccount('srt-sandbox')).Translate([System.Security.Principal.SecurityIdentifier]); $rootAcl = [System.IO.Directory]::GetAccessControl($root); if (@($rootAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq $sandboxSid }).Count -ne 0) { [Console]::Out.WriteLine('${TEMP_ROOT_ACL_DIAGNOSTIC}') } } catch { }`,
  "$ownDirectories = ConvertFrom-Json -InputObject $env:AVE_SRT_OWN_DIRECTORIES",
  "foreach ($directory in [System.IO.Directory]::GetDirectories($root, 'ave-srt-win-*', [System.IO.SearchOption]::TopDirectoryOnly)) { try {",
  "if ($directory -in $ownDirectories -or [System.IO.Path]::Combine($directory, 'bin') -in $ownDirectories) { continue }",
  "if ([System.IO.Path]::GetDirectoryName($directory) -ne $root) { continue }",
  "$attributes = [System.IO.File]::GetAttributes($directory)",
  "if (($attributes -band $reparse) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { continue }",
  "$modify = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
  "$acl = [System.IO.Directory]::GetAccessControl($directory)",
  "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or !$acl.AreAccessRulesProtected) { continue }",
  "if (@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -ne $sid -and ($_.FileSystemRights -band $modify) -ne 0 }).Count -ne 0) { continue }",
  "$entries = @([System.IO.Directory]::GetFileSystemEntries($directory))",
  "$imageDirectory = $directory",
  "if ($entries.Count -eq 1 -and [System.IO.Path]::GetFileName($entries[0]) -eq 'bin') {",
  "$imageDirectory = $entries[0]; $attributes = [System.IO.File]::GetAttributes($imageDirectory)",
  "if (($attributes -band $reparse) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { continue }",
  "$acl = [System.IO.Directory]::GetAccessControl($imageDirectory)",
  "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or !$acl.AreAccessRulesProtected) { continue }",
  "if (@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -ne $sid -and ($_.FileSystemRights -band $modify) -ne 0 }).Count -ne 0) { continue }",
  "$entries = @([System.IO.Directory]::GetFileSystemEntries($imageDirectory))",
  "}",
  "if ($entries.Count -ne 2) { continue }",
  "$plain = $true; foreach ($entry in $entries) { $a = [System.IO.File]::GetAttributes($entry); if (($a -band ($reparse -bor [System.IO.FileAttributes]::Directory)) -ne 0 -or [System.IO.Path]::GetFileName($entry) -notin @('owner.json', 'srt-win.exe')) { $plain = $false } }",
  "if (!$plain) { continue }",
  "$marker = [System.IO.Path]::Combine($imageDirectory, 'owner.json')",
  "$owner = [System.IO.File]::ReadAllText($marker) | ConvertFrom-Json",
  "if ($owner.pid -isnot [int] -or $owner.pid -le 0 -or $owner.pid -eq [int]$env:AVE_SRT_OWNER_PID -or $owner.started -isnot [string] -or $owner.started -notmatch '^[0-9]+$') { continue }",
  "$live = $true; try { $p = [System.Diagnostics.Process]::GetProcessById($owner.pid); $live = $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $owner.started; $p.Dispose() } catch [System.ArgumentException] { $live = $false }",
  "if ($live) { continue }",
  "$image = [System.IO.Path]::Combine($imageDirectory, 'srt-win.exe')",
  // A running image or an incompatible open handle prevents this write open. Hold the handle through deletion; sharing permits only deletion, not spawn.
  "$handle = [System.IO.File]::Open($image, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Delete)",
  "try { [System.IO.File]::Delete($image) } finally { $handle.Dispose() }",
  "[System.IO.File]::Delete($marker)",
  "if ($imageDirectory -ne $directory) { [System.IO.Directory]::Delete($imageDirectory, $false) }",
  "[System.IO.Directory]::Delete($directory, $false)",
  "} catch { continue } }",
].join("; ");
// The bootstrap separates native source and image bytes from the program before parsing it.
const BOOTSTRAP = "$native = [Console]::In.ReadLine(); $image = [Console]::In.ReadLine(); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";
const COMMAND = Buffer.from(BOOTSTRAP, "utf16le").toString("base64");
const NATIVE_SOURCE = Buffer.from(WINDOWS_HOME_BOUNDARY_SOURCE).toString("base64");

const PRIVATE_PARENT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')

function New-Descriptor($sddl) {
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  $bytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($bytes, 0)
  return ,$bytes
}

function Assert-PrivateParent($handle) {
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([HomeDirectoryDacl]::ReadDirectoryDescriptor($handle), 0)
  if ($raw.Owner -ne $sid -or
      !($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or
      $null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -ne $writers.Count) {
    throw 'Private helper parent is not protected'
  }
  $seen = @{}
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [System.Security.AccessControl.CommonAce] -or
        $ace.AceType -ne 'AccessAllowed' -or [int]$ace.AceFlags -ne 3 -or
        $ace.AccessMask -ne 0x1f01ff -or $ace.SecurityIdentifier.Value -notin $writers -or
        $seen.ContainsKey($ace.SecurityIdentifier.Value)) {
      throw 'Private helper parent has unexpected access entries'
    }
    $seen[$ace.SecurityIdentifier.Value] = $true
  }
}

function Remove-PrivateTree($path) {
  try { $attrs = [System.IO.File]::GetAttributes($path) }
  catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
  if ($attrs -band [System.IO.FileAttributes]::Directory) {
    if (!($attrs -band [System.IO.FileAttributes]::ReparsePoint)) {
      foreach ($child in [System.IO.Directory]::GetFileSystemEntries($path)) { Remove-PrivateTree $child }
    }
    [System.IO.Directory]::Delete($path, $false)
  } else { [System.IO.File]::Delete($path) }
}

function Clear-AbandonedCopies($path) {
  foreach ($child in [System.IO.Directory]::GetFileSystemEntries($path)) {
    try {
      if ([System.IO.Path]::GetFileName($child) -match '^copy-([0-9]{1,10})-[a-f0-9]{32}$') {
        $ownerPid = [long]$Matches[1]
        if ($ownerPid -gt 0 -and $ownerPid -le [int]::MaxValue) {
          if ($ownerPid -eq [int]$env:AVE_SRT_OWNER_PID) { continue }
          try { $owner = [System.Diagnostics.Process]::GetProcessById([int]$ownerPid) }
          catch [System.ArgumentException] { $owner = $null }
          if ($null -ne $owner) { $owner.Dispose(); continue }
        }
      }
      Remove-PrivateTree $child
    } catch { }
  }
}

function Invoke-PrivateParent {
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($native)))
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $writers = @($sid.Value)
  if ($sid.Value -ne 'S-1-5-18') { $writers += 'S-1-5-18' }
  $parentRules = ($writers | ForEach-Object { "(A;OICI;FA;;;$_)" }) -join ''
  $root = $env:AVE_SRT_PRIVATE_TEMP
  $volume = [System.IO.Path]::GetPathRoot($root)
  $handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
  try {
    # Hold the canonical path without delete sharing throughout validation and use.
    $handle = [HomeDirectoryDacl]::OpenDirectoryRoot($volume)
    $handles.Add($handle)
    foreach ($leaf in ($root.Substring($volume.Length) -split '\\')) {
      if (!$leaf) { continue }
      $handle = [HomeDirectoryDacl]::OpenRelative($handle, $leaf, $sid, 1, $true, $true, $false, $false, 3, 0x001000a0)
      if ($null -eq $handle) { throw 'Temporary directory disappeared' }
      $handles.Add($handle)
    }
    $parentName = 'ave-srt-win.' + $sid.Value
    if ($env:AVE_SRT_EXPECTED_PARENT -and $env:AVE_SRT_EXPECTED_PARENT -cne $parentName) { throw 'Private helper parent changed' }
    $parent = [System.IO.Path]::Combine($root, $parentName)
    $action = $env:AVE_SRT_ACTION
    # FILE_OPEN_IF atomically creates with the descriptor or opens without changing security.
    $disposition = if ($action -eq 'allocate') { 3 } else { 1 }
    $descriptor = New-Descriptor ('O:' + $sid.Value + 'D:P' + $parentRules)
    $handle = [HomeDirectoryDacl]::OpenRelative($handle, $parentName, $sid, $disposition, $true, $true, $true, $false, 3, 0x001200a1, $descriptor)
    if ($null -eq $handle) {
      if ($action -eq 'verify') { throw 'Private helper parent is missing' }
      return
    }
    $handles.Add($handle)
    Assert-PrivateParent $handle
    if ($action -eq 'sweep') { Clear-AbandonedCopies $parent; return }
    if ($action -eq 'verify') { return }

    $copyName = $env:AVE_SRT_COPY
    if ($copyName -cnotmatch ('^copy-' + $env:AVE_SRT_OWNER_PID + '-[a-f0-9]{32}$')) { throw 'Invalid helper copy name' }
    if ($action -eq 'dispose') { Remove-PrivateTree ([System.IO.Path]::Combine($parent, $copyName)); return }
    if ($action -ne 'allocate') { throw 'Invalid private helper action' }

    $readers = '(A;OICI;0x1200a9;;;BA)(A;OICI;0x1200a9;;;BU)'
    if ($sid.Value -ne 'S-1-5-18') { $readers += '(A;OICI;0x1200a9;;;SY)' }
    $directoryAcl = New-Descriptor ('O:' + $sid.Value + 'D:P(A;OICI;FA;;;' + $sid.Value + ')' + $readers)
    $copy = [HomeDirectoryDacl]::OpenRelative($handle, $copyName, $sid, 2, $true, $true, $true, $false, 3, 0, $directoryAcl)
    $handles.Add($copy)
    [Console]::Out.WriteLine($sid.Value)
    [Console]::Out.Flush()
    $bin = [HomeDirectoryDacl]::OpenRelative($copy, 'bin', $sid, 2, $true, $true, $true, $false, 3, 0, $directoryAcl)
    $handles.Add($bin)
    $fileAcl = New-Descriptor ('O:' + $sid.Value + 'D:P(A;;FA;;;' + $sid.Value + ')' + $readers.Replace('OICI', ''))
    $file = [HomeDirectoryDacl]::OpenRelative($bin, 'srt-win.exe', $sid, 2, $false, $true, $false, $false, 3, 0x00100182, $fileAcl)
    $handles.Add($file)
    $stream = [System.IO.FileStream]::new($file, [System.IO.FileAccess]::Write)
    try {
      $bytes = [Convert]::FromBase64String($image)
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
  } finally {
    for ($i = $handles.Count - 1; $i -ge 0; $i--) { $handles[$i].Dispose() }
  }
}

Invoke-PrivateParent
`;

export function runWindowsSrtWinParent(
  action: "allocate" | "sweep" | "verify" | "dispose", temp: string,
  { copy, bytes, expectedParent, legacyTemp, onAllocated }: {
    copy?: string; bytes?: Buffer; expectedParent?: string; legacyTemp?: string; onAllocated?: (sid: string) => void;
  } = {},
): void {
  let output: string | undefined;
  try {
    output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", COMMAND,
    ], {
      env: {
        SystemRoot: windowsSystemRoot(), TEMP: temp, TMP: temp, AVE_SRT_ACTION: action,
        AVE_SRT_PRIVATE_TEMP: temp, AVE_SRT_TEMP_ROOT: legacyTemp ?? temp, AVE_SRT_COPY: copy,
        AVE_SRT_EXPECTED_PARENT: expectedParent,
        AVE_SRT_OWNER_PID: String(process.pid), AVE_SRT_OWN_DIRECTORIES: "[]",
      },
      input: [NATIVE_SOURCE, bytes?.toString("base64") ?? "", PRIVATE_PARENT_SCRIPT,
        action === "sweep" ? SWEEP_SCRIPT : ""].join("\n"),
      windowsHide: true, stdio: "pipe", encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
  } catch (error) {
    output = (error as { stdout?: string }).stdout;
    throw error;
  } finally {
    const sid = output?.trim();
    if (onAllocated !== undefined && sid !== undefined && /^S-1-(?:[0-9]+-)+[0-9]+$/.test(sid)) onAllocated(sid);
  }
  if (output?.includes(TEMP_ROOT_ACL_DIAGNOSTIC)) {
    console.warn(`[${TEMP_ROOT_ACL_DIAGNOSTIC}] Sandbox account ACEs exist on the temporary root; owner review and an explicitly authorized ACL repair are required. No temporary-root ACL was changed.`);
  }
}
