import { execFileSync } from "node:child_process";

import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const POWERSHELL_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
];

const TEMP_ROOT_ACL_DIAGNOSTIC = "srt-win-temp-root-acl-owner-action-required";

// A marker is useful only inside verified private directories. Support both layouts, deleting only their two known plain files without recursion.
const LEGACY_SWEEP_SCRIPT = [
  ...POWERSHELL_PROLOGUE,
  "$root = [System.IO.Path]::GetFullPath($env:AVE_SRT_TEMP_ROOT).TrimEnd('\\')",
  "$reparse = [System.IO.FileAttributes]::ReparsePoint",
  "if (([System.IO.File]::GetAttributes($root) -band $reparse) -ne 0) { return }",
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
// Keep image bytes separate from the program before parsing it.
const BOOTSTRAP = "$image = [Console]::In.ReadLine(); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";
const COMMAND = Buffer.from(BOOTSTRAP, "utf16le").toString("base64");

const PRIVATE_PARENT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')

function New-Security($security, $descriptor) {
  $bytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($bytes, 0)
  $security.SetSecurityDescriptorBinaryForm($bytes)
  return $security
}

function Get-PrivateParentSddl($owner) {
  $rules = "(A;OICI;FA;;;$owner)"
  # The runner opens the image under its own logon. These are the existing
  # image readers, with only FILE_TRAVERSE on this ancestor.
  foreach ($principal in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545')) {
    if ($principal -ne $owner) { $rules += "(A;;0x20;;;$principal)" }
  }
  return ('O:' + $owner + 'D:P' + $rules)
}

function Get-EntryAttributes($path) {
  try { return [System.IO.File]::GetAttributes($path) }
  catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return $null }
}

function Read-PlainDirectoryDescriptor($path) {
  $attributes = Get-EntryAttributes $path
  $flags = [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
  if (($attributes -band $flags) -ne [System.IO.FileAttributes]::Directory) { throw 'Private helper path is not a plain directory' }
  $security = [System.IO.Directory]::GetAccessControl($path)
  return [System.Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
}

function Assert-PrivateParent($raw, $expected) {
  if ($raw.Owner -ne $expected.Owner -or
      !($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or
      $null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -ne $expected.DiscretionaryAcl.Count) {
    throw 'Private helper parent is not protected'
  }
  $remaining = @{}
  foreach ($rule in $expected.DiscretionaryAcl) { $remaining[$rule.SecurityIdentifier.Value] = $rule }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace.AceType -ne 'AccessAllowed') { throw 'Private helper parent has unexpected access entries' }
    $principal = $ace.SecurityIdentifier.Value
    $rule = $remaining[$principal]
    if ($null -eq $rule -or $ace.AceFlags -ne $rule.AceFlags -or
        $ace.AccessMask -ne $rule.AccessMask) {
      throw 'Private helper parent has unexpected access entries'
    }
    $remaining.Remove($principal)
  }
}

function Assert-TempAncestor($raw, $user, $creatingParent = $false) {
  $trusted = @($user, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($raw.Owner.Value -notin $trusted -or $null -eq $raw.DiscretionaryAcl) { throw 'Temporary ancestor is not protected' }
  # Generic write/all, delete and delete-child, reparse-related writes, and changes to security.
  $mask = 0x500d0152
  # A foreign principal may neither claim nor plant a link at the new parent's name.
  if ($creatingParent) { $mask = $mask -bor 4 } # FILE_ADD_SUBDIRECTORY
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ([int]$ace.AceFlags -band 8) { continue } # INHERIT_ONLY
    if ($ace.AceType -in @('AccessDenied', 'AccessDeniedObject')) { continue }
    if ($ace.AceType -notin @('AccessAllowed', 'AccessAllowedObject')) { throw 'Temporary ancestor has an unsupported access entry' }
    if ($ace.SecurityIdentifier.Value -notin $trusted -and ($ace.AccessMask -band $mask)) {
      throw 'Temporary ancestor grants replacement rights'
    }
  }
}

function New-PrivateCopyDirectory($path, $descriptor) {
  if ($null -ne (Get-EntryAttributes $path)) { throw 'Private helper copy destination already exists' }
  $security = New-Security ([System.Security.AccessControl.DirectorySecurity]::new()) $descriptor
  $null = [System.IO.Directory]::CreateDirectory($path, $security)
  Assert-PrivateParent (Read-PlainDirectoryDescriptor $path) $descriptor
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
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $root = $env:AVE_SRT_PRIVATE_TEMP
  $volume = [System.IO.Path]::GetPathRoot($root)
  if ($volume -notmatch '^[a-zA-Z]:\\$') { throw 'Temporary path is not drive rooted' }
  if ([System.IO.DriveInfo]::new($volume).DriveType -notin @('Fixed', 'Removable', 'Ram')) { throw 'Temporary path is not on a local drive' }
  # Check from the volume down. Each already-checked directory protects the name of the next.
  $ancestor = $volume
  $ancestorAcl = Read-PlainDirectoryDescriptor $ancestor
  Assert-TempAncestor $ancestorAcl $sid.Value
  foreach ($leaf in ($root.Substring($volume.Length) -split '\\')) {
    if (!$leaf) { continue }
    $ancestor = [System.IO.Path]::Combine($ancestor, $leaf)
    $ancestorAcl = Read-PlainDirectoryDescriptor $ancestor
    Assert-TempAncestor $ancestorAcl $sid.Value
  }

  $parentName = 'ave-srt-win.' + $sid.Value
  if ($env:AVE_SRT_EXPECTED_PARENT -and $env:AVE_SRT_EXPECTED_PARENT -cne $parentName) { throw 'Private helper parent changed' }
  $parent = [System.IO.Path]::Combine($root, $parentName)
  $action = $env:AVE_SRT_ACTION
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new((Get-PrivateParentSddl $sid.Value))
  if ($null -eq (Get-EntryAttributes $parent)) {
    if ($action -eq 'allocate') {
      Assert-TempAncestor $ancestorAcl $sid.Value $true
      $security = New-Security ([System.Security.AccessControl.DirectorySecurity]::new()) $descriptor
      $null = [System.IO.Directory]::CreateDirectory($parent, $security)
    } elseif ($action -eq 'verify') { throw 'Private helper parent is missing' }
    else { return }
  }
  Assert-PrivateParent (Read-PlainDirectoryDescriptor $parent) $descriptor
  if ($action -eq 'sweep') { Clear-AbandonedCopies $parent; return }
  if ($action -eq 'verify') { return }

  $copyName = $env:AVE_SRT_COPY
  if ($copyName -cnotmatch ('^copy-' + $env:AVE_SRT_OWNER_PID + '-[a-f0-9]{32}$')) { throw 'Invalid helper copy name' }
  $copy = [System.IO.Path]::Combine($parent, $copyName)
  if ($action -eq 'dispose') { Remove-PrivateTree $copy; return }
  if ($action -ne 'allocate') { throw 'Invalid private helper action' }

  $readers = '(A;OICI;0x1200a9;;;BA)(A;OICI;0x1200a9;;;BU)'
  if ($sid.Value -ne 'S-1-5-18') { $readers += '(A;OICI;0x1200a9;;;SY)' }
  $directoryAcl = [System.Security.AccessControl.RawSecurityDescriptor]::new(('O:' + $sid.Value + 'D:P(A;OICI;FA;;;' + $sid.Value + ')' + $readers))
  New-PrivateCopyDirectory $copy $directoryAcl
  [Console]::Out.WriteLine($sid.Value)
  [Console]::Out.Flush()
  $bin = [System.IO.Path]::Combine($copy, 'bin')
  New-PrivateCopyDirectory $bin $directoryAcl
  $fileAcl = [System.Security.AccessControl.RawSecurityDescriptor]::new(('O:' + $sid.Value + 'D:P(A;;FA;;;' + $sid.Value + ')' + $readers.Replace('OICI', '')))
  $security = New-Security ([System.Security.AccessControl.FileSecurity]::new()) $fileAcl
  $file = [System.IO.Path]::Combine($bin, 'srt-win.exe')
  $stream = [System.IO.FileStream]::new($file, 'CreateNew', [System.Security.AccessControl.FileSystemRights]::Write, 'None', 4096, 'None', $security)
  try {
    $bytes = [Convert]::FromBase64String($image)
    $stream.Write($bytes, 0, $bytes.Length)
  } finally { $stream.Dispose() }
}

`;

// Both best-effort passes share the startup budget. The legacy diagnostic runs
// before opening the private parent.
const SWEEP_DISPATCH = `
function Invoke-LegacySweep { ${LEGACY_SWEEP_SCRIPT} }
try { Invoke-LegacySweep } catch { }
try { Invoke-PrivateParent } catch { }
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
      input: [bytes?.toString("base64") ?? "", PRIVATE_PARENT_SCRIPT,
        action === "sweep" ? SWEEP_DISPATCH : "Invoke-PrivateParent"].join("\n"),
      windowsHide: true, stdio: "pipe", encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
  } catch (error) {
    output = (error as { stdout?: string }).stdout;
    throw error;
  } finally {
    if (output?.includes(TEMP_ROOT_ACL_DIAGNOSTIC)) {
      console.warn(`[${TEMP_ROOT_ACL_DIAGNOSTIC}] Sandbox account ACEs exist on the temporary root; owner review and an explicitly authorized ACL repair are required. No temporary-root ACL was changed.`);
    }
    const sid = output?.trim();
    if (onAllocated !== undefined && sid !== undefined && /^S-1-(?:[0-9]+-)+[0-9]+$/.test(sid)) onAllocated(sid);
  }
}
