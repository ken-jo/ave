import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, type } from "node:os";
import { basename, dirname, join, win32 } from "node:path";

import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import SRT_WIN_PINS from "./srt-win-pins.json" with { type: "json" };

export class SrtWinIntegrityError extends Error {
  constructor(readonly code: "srt-win-integrity-mismatch" | "srt-win-not-found", options?: ErrorOptions) {
    super(code === "srt-win-not-found" ? "Windows sandbox helper is missing" : "Windows sandbox helper integrity verification failed", options);
    this.name = "SrtWinIntegrityError";
  }
}

export function assertSrtWinDigest(bytes: Uint8Array, arch: string): void {
  const pins: Readonly<Record<string, string>> = SRT_WIN_PINS.sha256;
  const expected = Object.hasOwn(pins, arch) ? pins[arch] : undefined;
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  }
}

// Import required modules explicitly; minimal child env otherwise forces a full installed-module scan. Core cmdlets need no import.
const POWERSHELL_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
];

// Create random unpublished directories/files with final user ownership and protected DACLs; elevated defaults may assign administrator ownership. Refuse existing paths/links, verify descriptors and file owners on the same creation handle, write bytes afterward and remove created objects on failure. Never modify existing ACLs (docs/architecture/architecture.md).
const PRIVATE_DIRECTORY_SCRIPT = [
  ...POWERSHELL_PROLOGUE,
  "$outer = $env:AVE_SRT_PRIVATE_DIRECTORY",
  "$bin = [System.IO.Path]::Combine($outer, 'bin')",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$reparse = [System.IO.FileAttributes]::ReparsePoint",
  "$readers = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545')",
  // GetAttributes reads the entry itself, so a dangling link counts as present.
  "$present = $true; try { $null = [System.IO.File]::GetAttributes($outer) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $present = $false }",
  "if ($present) { throw 'Private directory already exists' }",
  "$security = New-Object System.Security.AccessControl.DirectorySecurity",
  "$security.SetOwner($sid)",
  "$security.SetAccessRuleProtection($true, $false)",
  "$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  "foreach ($id in $readers) { $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($id)), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
  "$null = [System.IO.Directory]::CreateDirectory($outer, $security)",
  // From here on the directory is this step's own: a failure removes what it made.
  "try {",
  "$createdBin = $false",
  "foreach ($directory in @($outer, $bin)) {",
  "if ($directory -eq $bin) { $present = $true; try { $null = [System.IO.File]::GetAttributes($bin) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $present = $false }; if ($present) { throw 'Private directory already exists' }; $null = [System.IO.Directory]::CreateDirectory($bin, $security); $createdBin = $true }",
  "$attributes = [System.IO.File]::GetAttributes($directory)",
  "if (($attributes -band $reparse) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { throw 'Private directory is not a plain directory' }",
  "$check = [System.IO.Directory]::GetAccessControl($directory)",
  "if ($check.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Private directory owner mismatch' }",
  "if (!$check.AreAccessRulesProtected) { throw 'Private directory grants are inherited' }",
  "$modification = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
  "foreach ($entry in $check.Access) { $id = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]); if ($entry.AccessControlType -ne 'Allow' -or ($id -ne $sid -and ($id.Value -notin $readers -or ($entry.FileSystemRights -band $modification) -ne 0))) { throw 'Private directory modification grants are not exclusive' } }",
  "$rx = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
  "foreach ($id in $readers) { $grants = @($check.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $id }); if ($grants.Count -ne 1 -or ($grants[0].FileSystemRights -band $rx) -ne $rx) { throw 'Private directory read and execute grant is missing' } }",
  "}",
  "$fileSecurity = New-Object System.Security.AccessControl.FileSecurity",
  "$fileSecurity.SetOwner($sid)",
  "$fileSecurity.SetAccessRuleProtection($true, $false)",
  "$fileSecurity.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'None', 'None', 'Allow')))",
  "foreach ($id in $readers) { $fileSecurity.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($id)), 'ReadAndExecute', 'None', 'None', 'Allow'))) }",
  "$owner = [System.Diagnostics.Process]::GetProcessById([int]$env:AVE_SRT_OWNER_PID)",
  "$marker = @{ pid = [int]$env:AVE_SRT_OWNER_PID; started = $owner.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress",
  "$contents = @{ 'srt-win.exe' = [byte[]]@(); 'owner.json' = (New-Object System.Text.UTF8Encoding($false)).GetBytes($marker) }",
  "foreach ($name in @('srt-win.exe', 'owner.json')) { $stream = New-Object System.IO.FileStream([System.IO.Path]::Combine($bin, $name), [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions', [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $fileSecurity); try { $bytes = $contents[$name]; $stream.Write($bytes, 0, $bytes.Length); if ($stream.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Private file owner mismatch' } } finally { $stream.Dispose() } }",
  "} catch { if ($createdBin) { foreach ($name in @('srt-win.exe', 'owner.json')) { $file = [System.IO.Path]::Combine($bin, $name); if ([System.IO.File]::Exists($file)) { [System.IO.File]::Delete($file) } }; [System.IO.Directory]::Delete($bin, $false) }; [System.IO.Directory]::Delete($outer, $false); throw }",
].join("; ");
const PRIVATE_DIRECTORY_COMMAND = Buffer.from(PRIVATE_DIRECTORY_SCRIPT, "utf16le").toString("base64");

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
const SWEEP_COMMAND = Buffer.from(SWEEP_SCRIPT, "utf16le").toString("base64");

function runDirectoryCommand(command: string, env: Record<string, string>): void {
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  const output = execFileSync(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command,
  ], {
    env: { SystemRoot: root, AVE_SRT_OWNER_PID: String(process.pid), ...env },
    windowsHide: true, stdio: "pipe", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
  });
  if (output.toString("utf8").includes(TEMP_ROOT_ACL_DIAGNOSTIC)) {
    console.warn(`[${TEMP_ROOT_ACL_DIAGNOSTIC}] Sandbox account ACEs exist on the temporary root; owner review and an explicitly authorized ACL repair are required. No temporary-root ACL was changed.`);
  }
}

// Keep uncertain entries, including unmarked copies left by older releases.
export function sweepStaleSrtWinDirectories(): void {
  if (type() !== "Windows_NT") return;
  try {
    runDirectoryCommand(SWEEP_COMMAND, {
      AVE_SRT_TEMP_ROOT: tmpdir(),
      AVE_SRT_OWN_DIRECTORIES: JSON.stringify(srtWinPrivateDirectories()),
    });
  } catch { /* Cleanup is best effort. */ }
}

// The bundled helper supports two architectures; 32-bit hosts use x64.
export function getSrtWinArchitecture(arch: string = process.arch): "arm64" | "x64" {
  return arch === "arm64" ? "arm64" : "x64";
}

let swept = false;

const copies = new Map<string, { readonly directory: string; readonly executable: string; readonly arch: string }>();

function readHelper(path: string): Buffer {
  try {
    if (!lstatSync(path).isFile()) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
    return readFileSync(path);
  } catch (error) {
    if (error instanceof SrtWinIntegrityError) throw error;
    throw new SrtWinIntegrityError((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "srt-win-not-found" : "srt-win-integrity-mismatch");
  }
}

// Execute a private verified snapshot, never the mutable package path; only host identity may modify it. Read/execute permissions support the runner before its SID exists without widening parent profile ACLs; add the snapshot to every write floor. Keep it for process lifetime because status/install/teardown re-spawn it.
export function prepareSrtWinExecutable(source: string, arch = getSrtWinArchitecture()): string {
  if (!swept) {
    swept = true;
    sweepStaleSrtWinDirectories();
  }
  const bytes = readHelper(source);
  assertSrtWinDigest(bytes, arch);
  const key = `${arch}:${source}`;
  const cached = copies.get(key);
  if (cached) {
    assertSrtWinDigest(readHelper(cached.executable), arch);
    return cached.executable;
  }
  // A fresh, unpublished name: on Windows the protecting step creates it, and anything already at the path refuses creation.
  const directory = join(tmpdir(), `ave-srt-win-${randomBytes(16).toString("hex")}`);
  const bin = join(directory, "bin");
  // A refused creation leaves nothing of ours: the step removes what it made, and whatever was already at the path is not ours to delete.
  let created = false;
  try {
    const executable = join(bin, "srt-win.exe");
    // POSIX modes do not enforce a Windows boundary. On Windows both directories and the empty image are created with their protected DACL and the current user as owner before any executable byte exists; this needs no elevation, and the bytes go into the file that step made.
    const windows = type() === "Windows_NT";
    if (windows) runDirectoryCommand(PRIVATE_DIRECTORY_COMMAND, { AVE_SRT_PRIVATE_DIRECTORY: directory });
    else {
      mkdirSync(directory, { mode: 0o700 });
      try { mkdirSync(bin, { mode: 0o700 }); }
      catch (error) { rmdirSync(directory); throw error; }
    }
    created = true;
    // Write the bytes that were hashed, rather than re-opening the source to copy.
    writeFileSync(executable, bytes, windows ? { flag: "r+" } : { flag: "wx", mode: 0o700 });
    assertSrtWinDigest(readHelper(executable), arch);
    copies.set(key, { directory, executable, arch });
    return executable;
  } catch (error) {
    if (created) {
      try { removePrivateCopy(directory); } catch { /* A leftover copy is the stale-copy sweep's. */ }
    }
    if (error instanceof SrtWinIntegrityError) throw error;
    throw new SrtWinIntegrityError("srt-win-integrity-mismatch", { cause: error });
  }
}

export function srtWinPrivateDirectories(): string[] {
  // The native parent delete-child deny must stay inside the private outer directory.
  return [...copies.values()].map((copy) => dirname(copy.executable));
}

// Recheck immediately before each host-controlled helper spawn.
export function assertSrtWinSpawnIntegrity(executable: string): void {
  if (process.platform !== "win32" || basename(executable).toLowerCase() !== "srt-win.exe") return;
  const copy = [...copies.values()].find((candidate) => candidate.executable === executable);
  if (!copy) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  assertSrtWinDigest(readHelper(executable), copy.arch);
}

// Remove only the two known files and their two directories, never recursing or following a swapped-in directory link.
function removePrivateCopy(directory: string): void {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    // A Windows directory link (junction or symlink) is removed with rmdir.
    if (process.platform === "win32") rmdirSync(directory); else unlinkSync(directory);
    return;
  }
  const bin = join(directory, "bin");
  const child = lstatSync(bin, { throwIfNoEntry: false });
  if (child?.isSymbolicLink()) {
    if (process.platform === "win32") rmdirSync(bin); else unlinkSync(bin);
  } else if (child?.isDirectory()) {
    for (const name of ["srt-win.exe", "owner.json"]) rmSync(join(bin, name), { force: true });
    rmdirSync(bin);
  }
  rmdirSync(directory);
}

process.once("exit", () => {
  for (const { directory } of copies.values()) {
    try { removePrivateCopy(directory); } catch { /* An active helper may still hold the image. */ }
  }
});
