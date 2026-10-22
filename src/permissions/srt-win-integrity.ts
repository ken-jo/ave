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

const PRIVATE_DIRECTORY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = [System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY)",
  "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Private directory owner mismatch' }",
  "$acl.SetAccessRuleProtection($true, $false)",
  "foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
  "$acl.AddAccessRule($rule)",
  "$readers = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545')",
  "foreach ($id in $readers) { $principal = New-Object System.Security.Principal.SecurityIdentifier($id); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
  "[System.IO.Directory]::SetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY, $acl)",
  "$check = [System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY)",
  "if (!$check.AreAccessRulesProtected) { throw 'Private directory grants are inherited' }",
  "$modification = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
  "foreach ($entry in $check.Access) { $id = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]); if ($entry.AccessControlType -ne 'Allow' -or ($id -ne $sid -and ($id.Value -notin $readers -or ($entry.FileSystemRights -band $modification) -ne 0))) { throw 'Private directory modification grants are not exclusive' } }",
  "$rx = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
  "foreach ($id in $readers) { $grants = @($check.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $id }); if ($grants.Count -ne 1 -or ($grants[0].FileSystemRights -band $rx) -ne $rx) { throw 'Private directory read and execute grant is missing' } }",
].join("; ");
const PRIVATE_DIRECTORY_COMMAND = Buffer.from(PRIVATE_DIRECTORY_SCRIPT, "utf16le").toString("base64");

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
export function prepareSrtWinExecutable(source: string, arch = process.arch): string {
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
    // POSIX modes do not enforce a Windows boundary. Set a protected DACL before
    // writing any executable bytes; this operation needs no elevation.
    if (type() === "Windows_NT") {
      const root = process.env.SystemRoot;
      if (!root || !win32.isAbsolute(root)) throw new SrtWinIntegrityError("srt-win-integrity-mismatch");
      execFileSync(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", PRIVATE_DIRECTORY_COMMAND,
      ], {
        env: { SystemRoot: root, AVE_SRT_PRIVATE_DIRECTORY: directory },
        windowsHide: true,
        stdio: "pipe",
        timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
    }
    const executable = join(directory, "srt-win.exe");
    // Write the bytes that were hashed, rather than re-opening the source to copy.
    writeFileSync(executable, bytes, { flag: "wx", mode: 0o700 });
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
