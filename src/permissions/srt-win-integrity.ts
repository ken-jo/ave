import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, type } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { renamePathOnceSync } from "../lib/transient-fs-lock-retry.js";
import { writeExitDiagnostic } from "../shared/exit-diagnostic.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";
import { allocationIdentity, allocationOwnerIsLive, beginSrtWinAllocation, confirmSrtWinAllocation, forgetSrtWinAllocation, retireSrtWinAllocation, srtWinAllocations, type SrtWinAllocation } from "./srt-win-allocation-ledger.js";
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
];

// The managed CreateDirectory API can succeed on an existing directory. Claim the path exclusively with the final descriptor.
const PRIVATE_DIRECTORY_API = [
  "using System;",
  "using System.ComponentModel;",
  "using System.Runtime.InteropServices;",
  "public static class PrivateDirectory {",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int InheritHandle; }",
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]',
  "  [return: MarshalAs(UnmanagedType.Bool)]",
  "  private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);",
  "  public static void Create(string path, byte[] descriptor) {",
  "    GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);",
  "    try {",
  "      SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), InheritHandle = 0 };",
  "      if (!CreateDirectoryW(path, ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());",
  "    } finally { pinned.Free(); }",
  "  }",
  "}",
].join("\n");
const PRIVATE_DIRECTORY_CREATED = "private-sandbox-directory-created";

// Set the protected descriptor at creation. Confirm the outer allocation before provisioning its contents.
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
  `Add-Type -TypeDefinition '${PRIVATE_DIRECTORY_API}'`,
  "$descriptor = $security.GetSecurityDescriptorBinaryForm()",
  "[PrivateDirectory]::Create($outer, $descriptor)",
  `[Console]::Out.WriteLine('${PRIVATE_DIRECTORY_CREATED}')`,
  "[Console]::Out.Flush()",
  "foreach ($directory in @($outer, $bin)) {",
  "if ($directory -eq $bin) { [PrivateDirectory]::Create($bin, $descriptor) }",
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
].join("; ");
const PRIVATE_DIRECTORY_COMMAND = Buffer.from(PRIVATE_DIRECTORY_SCRIPT, "utf16le").toString("base64");

const TEMP_ROOT_ACL_DIAGNOSTIC = "srt-win-temp-root-acl-owner-action-required";
const CHECK_TEMP_ROOT_SCRIPT = [
  ...POWERSHELL_PROLOGUE,
  "$root = [System.IO.Path]::GetFullPath($env:AVE_SRT_TEMP_ROOT)",
  "if (([System.IO.File]::GetAttributes($root) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit }",
  `try { $sandboxSid = (New-Object System.Security.Principal.NTAccount('srt-sandbox')).Translate([System.Security.Principal.SecurityIdentifier]); $rootAcl = [System.IO.Directory]::GetAccessControl($root); if (@($rootAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq $sandboxSid }).Count -ne 0) { [Console]::Out.WriteLine('${TEMP_ROOT_ACL_DIAGNOSTIC}') } } catch { }`,
].join("; ");
const CHECK_TEMP_ROOT_COMMAND = Buffer.from(CHECK_TEMP_ROOT_SCRIPT, "utf16le").toString("base64");

function runDirectoryCommand(command: string, env: Record<string, string>): Buffer {
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
  return output;
}

// Only a durable allocation record authorizes cleanup. Names and markers are not provenance.
export function sweepStaleSrtWinDirectories(): void {
  if (type() === "Windows_NT") {
    try { runDirectoryCommand(CHECK_TEMP_ROOT_COMMAND, { AVE_SRT_TEMP_ROOT: tmpdir() }); }
    catch { /* The temp-root diagnostic is independent of reclamation. */ }
  }
  try {
    for (const allocation of srtWinAllocations()) {
      if (!allocation.disposing && allocationOwnerIsLive(allocation.pid)) continue;
      try {
        if (isAllocationDirectory(allocation.retired, allocation.identity)) removePrivateCopy(allocation.retired);
        forgetIfGone(allocation);
      } catch { /* Keep the record and continue with independent allocations. */ }
    }
  } catch { /* Missing or untrusted storage cannot authorize cleanup. */ }
}

// The bundled helper supports two architectures; 32-bit hosts use x64.
export function getSrtWinArchitecture(arch: string = process.arch): "arm64" | "x64" {
  return arch === "arm64" ? "arm64" : "x64";
}

let swept = false;

const copies = new Map<string, { readonly executable: string; readonly arch: string }>();
const copyDisposers = new Set<() => void>();

function isAllocationDirectory(path: string, identity: string | undefined): boolean {
  if (identity === undefined) return false;
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return entry !== undefined && entry.isDirectory() && allocationIdentity(entry) === identity;
}

function forgetIfGone(allocation: SrtWinAllocation): void {
  if (lstatSync(allocation.path, { throwIfNoEntry: false }) === undefined
    && lstatSync(allocation.retired, { throwIfNoEntry: false }) === undefined) forgetSrtWinAllocation(allocation);
}

function ownPrivateCopy(allocation: SrtWinAllocation): () => void {
  const directory = allocation.path;
  const info = lstatSync(directory, { bigint: true });
  if (!info.isDirectory()) throw new Error("Private directory is not a plain directory");
  confirmSrtWinAllocation(allocation, allocationIdentity(info));
  const dispose = (): void => {
    if (!copyDisposers.has(dispose)) return;
    if (lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
      forgetIfGone(allocation);
      copyDisposers.delete(dispose);
      return;
    }
    if (!isAllocationDirectory(directory, allocation.identity)) throw new Error("Private directory identity changed");
    retireSrtWinAllocation(allocation);
    renamePathOnceSync(directory, allocation.retired);
    copyDisposers.delete(dispose);
    if (!isAllocationDirectory(allocation.retired, allocation.identity)) throw new Error("Retired directory identity changed");
    removePrivateCopy(allocation.retired);
    forgetIfGone(allocation);
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
  const temp = resolve(tmpdir());
  const id = randomBytes(16).toString("hex");
  const directory = join(temp, `ave-srt-win-${id}`);
  const retired = `${directory}.delete-${randomBytes(16).toString("hex")}`;
  const bin = join(directory, "bin");
  let dispose: (() => void) | undefined;
  let allocation: SrtWinAllocation | undefined;
  try {
    allocation = beginSrtWinAllocation(id, directory, retired);
    const executable = join(bin, "srt-win.exe");
    // POSIX modes do not enforce a Windows boundary. On Windows both directories and the empty image are created with their protected DACL and the current user as owner before any executable byte exists; this needs no elevation, and the bytes go into the file that step made.
    const windows = type() === "Windows_NT";
    if (windows) {
      let output: unknown;
      try {
        output = runDirectoryCommand(PRIVATE_DIRECTORY_COMMAND, { AVE_SRT_PRIVATE_DIRECTORY: directory, TEMP: temp, TMP: temp });
      } catch (error) {
        // The sync command retains stdout written before failure, including on timeout.
        if (error instanceof Error && "stdout" in error) output = error.stdout;
        throw error;
      } finally {
        if (Buffer.isBuffer(output) && output.toString("utf8").split(/\r?\n/).includes(PRIVATE_DIRECTORY_CREATED)) {
          dispose = ownPrivateCopy(allocation);
        }
      }
      if (dispose === undefined) throw new Error("Private directory creation was not confirmed");
    } else {
      mkdirSync(directory, { mode: 0o700 });
      dispose = ownPrivateCopy(allocation);
      mkdirSync(bin, { mode: 0o700 });
    }
    // Write the bytes that were hashed, rather than re-opening the source to copy.
    writeFileSync(executable, bytes, windows ? { flag: "r+" } : { flag: "wx", mode: 0o700 });
    assertSrtWinDigest(readHelper(executable), arch);
    copies.set(key, { executable, arch });
    return executable;
  } catch (error) {
    try {
      if (dispose !== undefined) dispose();
      else if (allocation !== undefined) forgetIfGone(allocation);
    } catch { /* The allocation remains recorded until deletion is confirmed. */ }
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
    try { dispose(); } catch { /* The next startup sweep can recover retired copies. */ }
  }
});
