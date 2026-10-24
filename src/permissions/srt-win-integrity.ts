import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, type } from "node:os";
import { basename, join, win32 } from "node:path";

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

// Each script names the modules it uses instead of letting PowerShell search
// for them. The child gets a minimal environment, so a search has no command
// cache to read and scans every installed module first. Core cmdlets need no
// import.
const POWERSHELL_PROLOGUE = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
];

// Objects the host creates are owned by the current user, set when they are
// created (docs/architecture/architecture.md, "Windows object ownership"). An
// elevated token's default owner is usually BUILTIN\Administrators. This one
// PowerShell step protects the directory, then creates the empty image and the
// owner marker inside it, makes the token user the owner of all three, and
// reads each owner back. The image's bytes are written only after this step.
// This path is synchronous, so it cannot use the resident ACL host. Any
// failure throws, and the caller removes the directory.
const PRIVATE_DIRECTORY_SCRIPT = [
  ...POWERSHELL_PROLOGUE,
  "if (([System.IO.File]::GetAttributes($env:AVE_SRT_PRIVATE_DIRECTORY) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private directory is a link' }",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = [System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY)",
  "$acl.SetOwner($sid)",
  "$acl.SetAccessRuleProtection($true, $false)",
  "foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
  "$acl.AddAccessRule($rule)",
  "$readers = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545')",
  "foreach ($id in $readers) { $principal = New-Object System.Security.Principal.SecurityIdentifier($id); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
  "[System.IO.Directory]::SetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY, $acl)",
  "$check = [System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY)",
  "if ($check.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Private directory owner mismatch' }",
  "if (!$check.AreAccessRulesProtected) { throw 'Private directory grants are inherited' }",
  "$modification = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
  "foreach ($entry in $check.Access) { $id = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]); if ($entry.AccessControlType -ne 'Allow' -or ($id -ne $sid -and ($id.Value -notin $readers -or ($entry.FileSystemRights -band $modification) -ne 0))) { throw 'Private directory modification grants are not exclusive' } }",
  "$rx = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
  "foreach ($id in $readers) { $grants = @($check.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $id }); if ($grants.Count -ne 1 -or ($grants[0].FileSystemRights -band $rx) -ne $rx) { throw 'Private directory read and execute grant is missing' } }",
  "$image = [System.IO.Path]::Combine($env:AVE_SRT_PRIVATE_DIRECTORY, 'srt-win.exe')",
  "[System.IO.File]::Open($image, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None).Dispose()",
  "$owner = [System.Diagnostics.Process]::GetProcessById([int]$env:AVE_SRT_OWNER_PID)",
  "$marker = @{ pid = [int]$env:AVE_SRT_OWNER_PID; started = $owner.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress",
  "[System.IO.File]::WriteAllText([System.IO.Path]::Combine($env:AVE_SRT_PRIVATE_DIRECTORY, 'owner.json'), $marker)",
  "foreach ($name in @('srt-win.exe', 'owner.json')) { $file = [System.IO.Path]::Combine($env:AVE_SRT_PRIVATE_DIRECTORY, $name); $fileAcl = [System.IO.File]::GetAccessControl($file); $fileAcl.SetOwner($sid); [System.IO.File]::SetAccessControl($file, $fileAcl); if ([System.IO.File]::GetAccessControl($file).GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Private file owner mismatch' } }",
].join("; ");
const PRIVATE_DIRECTORY_COMMAND = Buffer.from(PRIVATE_DIRECTORY_SCRIPT, "utf16le").toString("base64");

// A marker is useful only inside a directory whose owner and modification
// grants we verified. Never recurse: these directories contain two plain files.
const SWEEP_SCRIPT = [
  ...POWERSHELL_PROLOGUE,
  "$root = [System.IO.Path]::GetFullPath($env:AVE_SRT_TEMP_ROOT).TrimEnd('\\')",
  "$reparse = [System.IO.FileAttributes]::ReparsePoint",
  "if (([System.IO.File]::GetAttributes($root) -band $reparse) -ne 0) { exit }",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$ownDirectories = ConvertFrom-Json -InputObject $env:AVE_SRT_OWN_DIRECTORIES",
  "foreach ($directory in [System.IO.Directory]::GetDirectories($root, 'ave-srt-win-*', [System.IO.SearchOption]::TopDirectoryOnly)) { try {",
  "if ($directory -in $ownDirectories) { continue }",
  "if ([System.IO.Path]::GetDirectoryName($directory) -ne $root) { continue }",
  "$attributes = [System.IO.File]::GetAttributes($directory)",
  "if (($attributes -band $reparse) -ne 0 -or ($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { continue }",
  "$acl = [System.IO.Directory]::GetAccessControl($directory)",
  "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or !$acl.AreAccessRulesProtected) { continue }",
  "$modify = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
  "if (@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -ne $sid -and ($_.FileSystemRights -band $modify) -ne 0 }).Count -ne 0) { continue }",
  "$entries = @([System.IO.Directory]::GetFileSystemEntries($directory))",
  "if ($entries.Count -ne 2) { continue }",
  "$plain = $true; foreach ($entry in $entries) { $a = [System.IO.File]::GetAttributes($entry); if (($a -band ($reparse -bor [System.IO.FileAttributes]::Directory)) -ne 0 -or [System.IO.Path]::GetFileName($entry) -notin @('owner.json', 'srt-win.exe')) { $plain = $false } }",
  "if (!$plain) { continue }",
  "$marker = [System.IO.Path]::Combine($directory, 'owner.json')",
  "$owner = [System.IO.File]::ReadAllText($marker) | ConvertFrom-Json",
  "if ($owner.pid -isnot [int] -or $owner.pid -le 0 -or $owner.pid -eq [int]$env:AVE_SRT_OWNER_PID -or $owner.started -isnot [string] -or $owner.started -notmatch '^[0-9]+$') { continue }",
  "$live = $true; try { $p = [System.Diagnostics.Process]::GetProcessById($owner.pid); $live = $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $owner.started; $p.Dispose() } catch [System.ArgumentException] { $live = $false }",
  "if ($live) { continue }",
  "$image = [System.IO.Path]::Combine($directory, 'srt-win.exe')",
  // A running image or an incompatible open handle prevents this write open.
  // Hold the handle through deletion; sharing permits only deletion, not spawn.
  "$handle = [System.IO.File]::Open($image, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Delete)",
  "try { [System.IO.File]::Delete($image) } finally { $handle.Dispose() }",
  "[System.IO.File]::Delete($marker)",
  "[System.IO.Directory]::Delete($directory, $false)",
  "} catch { continue } }",
].join("; ");
const SWEEP_COMMAND = Buffer.from(SWEEP_SCRIPT, "utf16le").toString("base64");

function runDirectoryCommand(command: string, env: Record<string, string>): void {
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  execFileSync(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command,
  ], {
    env: { SystemRoot: root, AVE_SRT_OWNER_PID: String(process.pid), ...env },
    windowsHide: true, stdio: "pipe", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
  });
}

/** Keep uncertain entries, including unmarked copies left by older releases. */
export function sweepStaleSrtWinDirectories(): void {
  if (type() !== "Windows_NT") return;
  try {
    runDirectoryCommand(SWEEP_COMMAND, {
      AVE_SRT_TEMP_ROOT: tmpdir(),
      AVE_SRT_OWN_DIRECTORIES: JSON.stringify(srtWinPrivateDirectories()),
    });
  } catch { /* Cleanup is best effort. */ }
}

/** The bundled helper supports two architectures; 32-bit hosts use x64. */
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

/**
 * Execute a verified snapshot, never the mutable package path. The directory
 * has no inherited grants: only the host identity can modify its contents.
 * The runner re-executes this image under the sandbox account. Its SID is only
 * available through a helper status call and may not exist before installation,
 * so BUILTIN\Users receives read/execute, as do privileged consent identities.
 * The restricted runner retains bypass-traverse privilege, also required for
 * workspace grants beneath the host profile; no parent profile ACL is widened.
 * Confined processes must also receive this directory in their write-deny floor
 * so a covering filesystem grant cannot lend them modification rights.
 * Keep the copy for the process lifetime: the runtime retains and re-spawns the
 * configured path for status, ACL operations, installation and teardown.
 */
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
  const directory = mkdtempSync(join(tmpdir(), "ave-srt-win-"));
  try {
    const executable = join(directory, "srt-win.exe");
    // POSIX modes do not enforce a Windows boundary. Set a protected DACL before
    // writing any executable bytes; this operation needs no elevation. On
    // Windows that step also creates the empty image, owned by the current
    // user, so the bytes go into the file it made.
    const windows = type() === "Windows_NT";
    if (windows) runDirectoryCommand(PRIVATE_DIRECTORY_COMMAND, { AVE_SRT_PRIVATE_DIRECTORY: directory });
    // Write the bytes that were hashed, rather than re-opening the source to copy.
    writeFileSync(executable, bytes, windows ? { flag: "r+" } : { flag: "wx", mode: 0o700 });
    assertSrtWinDigest(readHelper(executable), arch);
    copies.set(key, { directory, executable, arch });
    return executable;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    if (error instanceof SrtWinIntegrityError) throw error;
    throw new SrtWinIntegrityError("srt-win-integrity-mismatch", { cause: error });
  }
}

export function srtWinPrivateDirectories(): string[] {
  return [...copies.values()].map((copy) => copy.directory);
}

/** Recheck immediately before each host-controlled helper spawn. */
export function assertSrtWinSpawnIntegrity(executable: string): void {
  if (process.platform !== "win32" || basename(executable).toLowerCase() !== "srt-win.exe") return;
  const copy = [...copies.values()].find((candidate) => candidate.executable === executable);
  if (!copy) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
  assertSrtWinDigest(readHelper(executable), copy.arch);
}

process.once("exit", () => {
  for (const { directory } of copies.values()) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* An active helper may still hold the image. */ }
  }
});
