import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, type } from "node:os";
import { basename, dirname, join } from "node:path";

import { writeExitDiagnostic } from "../shared/exit-diagnostic.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import SRT_WIN_BUILD_RECEIPTS from "./generated/srt-win-build-receipts.js";
import { _registerSrtWinCopyForTest } from "./srt-win-copy-owner.js";
import SRT_WIN_PINS from "./srt-win-pins.json" with { type: "json" };

export class SrtWinIntegrityError extends Error {
  constructor(readonly code: "srt-win-integrity-mismatch" | "srt-win-not-found", options?: ErrorOptions) {
    super(code === "srt-win-not-found" ? "Windows sandbox helper is missing" : "Windows sandbox helper integrity verification failed", options);
    this.name = "SrtWinIntegrityError";
  }
}

export function assertSrtWinDigest(bytes: Uint8Array, arch: string): void {
  const receipt = Object.hasOwn(SRT_WIN_BUILD_RECEIPTS, arch) ? SRT_WIN_BUILD_RECEIPTS[arch] : undefined;
  const target = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;
  if (!receipt || !target || receipt.schemaVersion !== 1 ||
      receipt.sourceRevision !== SRT_WIN_PINS.source.revision || receipt.sourceArchiveSha256 !== SRT_WIN_PINS.source.sha256 ||
      receipt.nativePatchSha256 !== SRT_WIN_PINS.nativePatchSha256 || receipt.rustToolchain !== SRT_WIN_PINS.rustToolchain ||
      receipt.target !== target || createHash("sha256").update(bytes).digest("hex") !== receipt.binarySha256) {
    throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  }
}

// Import required modules explicitly; minimal child env otherwise forces a full installed-module scan. Core cmdlets need no import.
const POWERSHELL_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
  // Both Windows commands use the kernel creation time as invariant decimal UTC ticks, compatible with existing markers.
  "$readOwnerStart = { param($process); $process.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture) }",
];

// Create directories and files with final user ownership and protected DACLs. Refuse existing paths, verify descriptors, and remove created objects on failure. Never modify existing ACLs (docs/architecture/architecture.md).
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
  "$verifyDirectory = { param($directory)",
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
  "$writeNewFile = { param($path, [byte[]]$bytes)",
  "$stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions', [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $fileSecurity)",
  "try { try { if ($stream.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Private file owner mismatch' }; $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() } } catch { [System.IO.File]::Delete($path); throw }",
  "}",
  "$markerPath = [System.IO.Path]::Combine($outer, 'owner.json')",
  "$imagePath = [System.IO.Path]::Combine($bin, 'srt-win.exe')",
  "$null = [System.IO.Directory]::CreateDirectory($outer, $security)",
  // Publish the process marker before creating any payload. A markerless directory is never stale.
  "$createdMarker = $false; $createdBin = $false",
  "try {",
  "& $verifyDirectory $outer",
  "$owner = [System.Diagnostics.Process]::GetProcessById([int]$env:AVE_SRT_OWNER_PID)",
  "try { $started = & $readOwnerStart $owner } finally { $owner.Dispose() }",
  "$marker = @{ pid = [int]$env:AVE_SRT_OWNER_PID; started = $started } | ConvertTo-Json -Compress",
  "& $writeNewFile $markerPath ((New-Object System.Text.UTF8Encoding($false)).GetBytes($marker))",
  "$createdMarker = $true",
  "$present = $true; try { $null = [System.IO.File]::GetAttributes($bin) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { $present = $false }",
  "if ($present) { throw 'Private directory already exists' }",
  "$null = [System.IO.Directory]::CreateDirectory($bin, $security); $createdBin = $true",
  "& $verifyDirectory $bin",
  "& $writeNewFile $imagePath ([byte[]]@())",
  "} catch { if ($createdBin) { [System.IO.Directory]::Delete($bin, $false) }; if ($createdMarker) { [System.IO.File]::Delete($markerPath) }; [System.IO.Directory]::Delete($outer, $false); throw }",
].join("; ");
const PRIVATE_DIRECTORY_COMMAND = Buffer.from(PRIVATE_DIRECTORY_SCRIPT, "utf16le").toString("base64");

const TEMP_ROOT_ACL_DIAGNOSTIC = "srt-win-temp-root-acl-owner-action-required";

// A marker is useful only inside verified private directories. Delete only the known plain files without recursion.
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
  "$marker = [System.IO.Path]::Combine($directory, 'owner.json')",
  "$bin = [System.IO.Path]::Combine($directory, 'bin')",
  "$imageDirectory = $directory",
  "$markerFirst = $false",
  "if ($bin -in $entries) {",
  "$markerFirst = $marker -in $entries",
  "if ($entries.Count -ne (1 + [int]$markerFirst)) { continue }",
  "$imageDirectory = $entries | Where-Object { $_ -eq $bin }; $attributes = [System.IO.File]::GetAttributes($imageDirectory)",
  "if (($attributes -band $reparse) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { continue }",
  "$acl = [System.IO.Directory]::GetAccessControl($imageDirectory)",
  "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or !$acl.AreAccessRulesProtected) { continue }",
  "if (@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -ne $sid -and ($_.FileSystemRights -band $modify) -ne 0 }).Count -ne 0) { continue }",
  "$entries = @([System.IO.Directory]::GetFileSystemEntries($imageDirectory))",
  "if ($markerFirst) { $entries += $marker } else { $marker = [System.IO.Path]::Combine($imageDirectory, 'owner.json') }",
  "}",
  "$image = [System.IO.Path]::Combine($imageDirectory, 'srt-win.exe')",
  "$hasImage = $image -in $entries",
  "if ($marker -notin $entries -or $entries.Count -ne (1 + [int]$hasImage)) { continue }",
  // Only complete copies in the earlier layouts support names outside the generated namespace.
  "$legacyComplete = $hasImage -and !$markerFirst",
  "if (!$legacyComplete -and [System.IO.Path]::GetFileName($directory) -notmatch '\\Aave-srt-win-[0-9a-f]{32}\\z') { continue }",
  "$plain = $true; foreach ($entry in $entries) {",
  "$a = [System.IO.File]::GetAttributes($entry)",
  "if (($a -band ($reparse -bor [System.IO.FileAttributes]::Directory)) -ne 0) { $plain = $false; break }",
  // LinkType uses the file's link count, which GetAttributes does not expose.
  "if (!$legacyComplete) { $linkType = ([System.IO.FileInfo]::new($entry)).PSObject.Properties['LinkType']; if ($null -eq $linkType -or $null -ne $linkType.Value) { $plain = $false; break } }",
  "}",
  "if (!$plain) { continue }",
  "$owner = [System.IO.File]::ReadAllText($marker) | ConvertFrom-Json",
  // Conservatively keep copies marked with this process's PID, even if PID reuse leaves a stale copy behind.
  "if ($owner.pid -isnot [int] -or $owner.pid -le 0 -or $owner.pid -eq [int]$env:AVE_SRT_OWNER_PID -or $owner.started -isnot [string] -or $owner.started -notmatch '^[0-9]+$') { continue }",
  // Compare the full creation stamp exactly so a reused PID does not look live.
  "$live = $true; try { $p = [System.Diagnostics.Process]::GetProcessById($owner.pid); try { $live = [string]::Equals($owner.started, (& $readOwnerStart $p), [StringComparison]::Ordinal) } finally { $p.Dispose() } } catch [System.ArgumentException] { $live = $false }",
  "if ($live) { continue }",
  // A running image or an incompatible open handle prevents this write open. Hold the handle through deletion; sharing permits only deletion, not spawn.
  "if ($hasImage) { $handle = [System.IO.File]::Open($image, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Delete); try { [System.IO.File]::Delete($image) } finally { $handle.Dispose() } }",
  // A legacy marker inside bin must be removed before its directory. For new copies, keep the marker until bin is gone.
  "$nestedMarker = $imageDirectory -ne $directory -and [System.IO.Path]::GetDirectoryName($marker) -eq $imageDirectory",
  "if ($nestedMarker) { [System.IO.File]::Delete($marker) }",
  "if ($imageDirectory -ne $directory) { [System.IO.Directory]::Delete($imageDirectory, $false) }",
  "if (!$nestedMarker) { [System.IO.File]::Delete($marker) }",
  "[System.IO.Directory]::Delete($directory, $false)",
  "} catch { continue } }",
].join("; ");
const SWEEP_COMMAND = Buffer.from(SWEEP_SCRIPT, "utf16le").toString("base64");

function runDirectoryCommand(command: string, env: Record<string, string>): void {
  const root = windowsSystemRoot();
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command,
  ], {
    env: { SystemRoot: root, AVE_SRT_OWNER_PID: String(process.pid), ...env },
    windowsHide: true, stdio: "pipe", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
  });
  if (output.toString("utf8").includes(TEMP_ROOT_ACL_DIAGNOSTIC)) {
    console.warn(`[${TEMP_ROOT_ACL_DIAGNOSTIC}] Sandbox account ACEs exist on the temporary root; owner review and an explicitly authorized ACL repair are required. No temporary-root ACL was changed.`);
  }
}

// Older names still require the complete shape and a valid owner marker.
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

const copies = new Map<string, { readonly executable: string; readonly arch: string }>();
const copyDisposers = new Set<() => void>();

function ownPrivateCopy(directory: string): () => void {
  const dispose = (): void => {
    if (copyDisposers.delete(dispose)) removePrivateCopy(directory);
  };
  copyDisposers.add(dispose);
  _registerSrtWinCopyForTest(directory, dispose);
  return dispose;
}

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
  let dispose: (() => void) | undefined;
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
    dispose = ownPrivateCopy(directory);
    // Write the bytes that were hashed, rather than re-opening the source to copy.
    writeFileSync(executable, bytes, windows ? { flag: "r+" } : { flag: "wx", mode: 0o700 });
    assertSrtWinDigest(readHelper(executable), arch);
    copies.set(key, { executable, arch });
    return executable;
  } catch (error) {
    try { dispose?.(); } catch { /* A leftover copy is the stale-copy sweep's. */ }
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
    rmSync(join(bin, "srt-win.exe"), { force: true });
    rmdirSync(bin);
  }
  rmSync(join(directory, "owner.json"), { force: true });
  // If this rmdir fails, only an empty outer directory remains. The sweep leaves it alone without an owner marker.
  rmdirSync(directory);
}

// The sandbox runtime spawns this copy again when its session reset revokes and restores the session's ACEs. The quit sequence awaits that reset
// before the process exits; until it has succeeded, the copy must survive this module's exit handler, which Node runs before the runtime's own
// (registered later, at initialize), so that handler or the next boot can retry the release.
let runtimeReleasePending = false;

export function markSrtWinRuntimeReleasePending(): void {
  if (copies.size > 0) runtimeReleasePending = true;
}

export function markSrtWinRuntimeReleased(): void {
  runtimeReleasePending = false;
}

export function isSrtWinRuntimeReleasePending(): boolean {
  return runtimeReleasePending;
}

process.once("exit", () => {
  if (copyDisposers.size === 0) return;
  if (runtimeReleasePending) {
    // The runtime's exit handler runs next and still finds the copy; the next boot's stale-copy sweep removes it, and its ACL recovery covers a crash.
    writeExitDiagnostic("srt-win: sandbox session was not released before exit; the private helper copy is kept for the runtime's exit handler, the next boot's sweep and ACL recovery");
    return;
  }
  for (const dispose of copyDisposers) {
    try { dispose(); } catch { /* An active helper may still hold the image. */ }
  }
});
