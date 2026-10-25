import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkResolvedAveHome } from "./ave-home-test-guard.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { WINDOWS_OWNER_CLAIM_SOURCE } from "./windows-owner-claim.js";

/** All user-data paths must use this resolver so AVE_HOME isolates every store, including secrets. */
export function aveHome(): string {
  const home = resolve(process.env.AVE_HOME ?? defaultAveHome());
  // Tests replace the guard to refuse real user data; production uses its no-op implementation.
  checkResolvedAveHome(home);
  return home;
}

/** The actual default home, ignoring AVE_HOME, for recognizing protected real-user data. */
export function defaultAveHome(): string {
  return resolve(join(homedir(), ".ave"));
}

/** Keep live, user-overlay, and merge-artifact names shared across seeding, prompt reads, IPC, and merging. */

/** Live agent context. Seeded from packaged resources; read on every turn. */
export const AGENTS_DOC_NAME = "AGENTS.md";

/** Compose the keep-latest user overlay after the live document so user choices win. */
export const AGENTS_CUSTOM_DOC_NAME = "agents.custom.md";

/** Merge output is review-only until explicitly applied to the live document. */
export const AGENTS_MERGED_DOC_NAME = "AGENTS.md.merged";

/** Report actual protection: POSIX modes do not establish Windows ACL isolation. */
export type AveHomePrivacy =
  | { enforcement: "posix-mode"; home: string }
  | { enforcement: "win32-dacl"; home: string; sid: string; repairs?: { path: string; removedPrincipals: string[] }[] }
  | {
    enforcement: "none";
    home: string;
    failedPath?: string;
    reason: string;
    category: AveHomePrivacyFailureCategory;
    extraPrincipals?: AveHomePrincipal[];
  };

export type AveHomePrivacyFailureCategory =
  | "system-root-missing"
  | "directory-failed"
  | "identity-failed"
  | "icacls-failed"
  | "read-back-failed"
  | "extra-principals"
  | "not-protected"
  | "invalid-owner-grant"
  | "owner-claim-failed"
  | "reparse-point";

export interface AveHomePrincipal {
  sid: string;
  account?: string;
}

export interface WindowsDirectoryDacl {
  path: string;
  currentUserSid?: string;
  elevated?: boolean;
  ownerSid?: string;
  protected?: boolean;
  child?: boolean;
  rules?: WindowsAccessRule[];
  removedPrincipals?: string[];
  category?: AveHomePrivacyFailureCategory;
  error?: string;
}

export interface WindowsAccessRule extends AveHomePrincipal {
  accessControlType: number;
  fileSystemRights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  isInherited: boolean;
}

export interface AveHomePrivacyRuntime {
  platform: NodeJS.Platform;
  readDacls(paths: readonly string[], protect?: boolean, claimableRuntimeRoot?: string): WindowsDirectoryDacl[];
}

const DEFAULT_PRIVACY_RUNTIME: AveHomePrivacyRuntime = {
  platform: process.platform,
  readDacls: readWindowsDirectoryDacls,
};

/** Pass one-shot ACL input as UTF-16 environment JSON, never command interpolation or console-codepage stdin. */
export function readWindowsDirectoryDacls(paths: readonly string[], protect = false, claimableRuntimeRoot?: string): WindowsDirectoryDacl[] {
  if (!(process.env.SystemRoot ?? process.env.windir)?.trim()) {
    return paths.map((path) => ({ path, category: "system-root-missing", error: "Windows system root is missing" }));
  }
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
    $request = ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();
    $sid = $identity.User.Value;
    $elevated = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    if ($request.protect) {
      Add-Type -TypeDefinition @'
${WINDOWS_OWNER_CLAIM_SOURCE}
public static class HomeDirectoryDacl {
  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Descriptor, Quality; }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatus { public IntPtr Status, Information; }
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryDirectoryFile(SafeFileHandle handle, IntPtr evt, IntPtr apc, IntPtr context, out IoStatus status, IntPtr buffer, uint length, int infoClass, [MarshalAs(UnmanagedType.U1)] bool single, IntPtr name, [MarshalAs(UnmanagedType.U1)] bool restart);
  [StructLayout(LayoutKind.Sequential)]
  private struct FileStandardInfo { public long AllocationSize, EndOfFile; public uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] public bool DeletePending; [MarshalAs(UnmanagedType.U1)] public bool Directory; }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FileStandardInfo info, uint size);
  public static string[] Children(SafeFileHandle handle) {
    var names = new System.Collections.Generic.List<string>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool restart = true;
      while (true) {
        IoStatus io;
        int status = NtQueryDirectoryFile(handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out io, buffer, 65536, 12, true, IntPtr.Zero, restart);
        if (status == unchecked((int)0x80000006)) break;
        if (status < 0) throw new Win32Exception((int)WindowsOwnerClaim.RtlNtStatusToDosError(status), "Directory enumeration failed");
        restart = false;
        string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, 12), Marshal.ReadInt32(buffer, 8) / 2);
        if (name != "." && name != "..") names.Add(name);
      }
      return names.ToArray();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static SafeFileHandle OpenHome(string path, SecurityIdentifier user) {
    string fullPath = System.IO.Path.GetFullPath(path);
    string parentPath = System.IO.Path.GetDirectoryName(fullPath);
    string leaf = System.IO.Path.GetFileName(fullPath);
    if (String.IsNullOrEmpty(parentPath) || String.IsNullOrEmpty(leaf)) throw new InvalidOperationException("Directory path is invalid");
    using (SafeFileHandle parent = WindowsOwnerClaim.CreateFile(parentPath, 0x00100001, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (parent.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Directory parent handle could not be opened");
      return OpenRelative(parent, leaf, user, true);
    }
  }
  public static SafeFileHandle OpenRelative(SafeFileHandle parent, string leaf, SecurityIdentifier user, bool create, bool directory = true, bool enumerate = false) {
    if (String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.IndexOfAny(new char[] { '\\\\', '/', ':' }) >= 0) throw new InvalidOperationException("Directory leaf is invalid");
    IntPtr buffer = Marshal.StringToHGlobalUni(leaf);
    IntPtr memory = IntPtr.Zero;
    var security = GCHandle.Alloc(WindowsOwnerClaim.Descriptor(user, true, true), GCHandleType.Pinned);
    try {
      var name = new UnicodeString { Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)(leaf.Length * 2 + 2)), Buffer = buffer };
      memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      Marshal.StructureToPtr(name, memory, false);
      var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.DangerousGetHandle(), Name = memory, Attributes = 0x1040, Descriptor = security.AddrOfPinnedObject() };
      SafeFileHandle handle;
      IoStatus io;
      int status = NtCreateFile(out handle, enumerate ? 0x00100001u : 0x02000000u, ref attributes, out io, IntPtr.Zero, 0x10, enumerate ? 7u : 3u, create ? 3u : 1u, 0x00004000u | (directory ? 1u : 0u) | (enumerate ? 0x20u : 0u), IntPtr.Zero, 0);
      if (status < 0) {
        if (handle != null) handle.Dispose();
        if (status == unchecked((int)0xC000050B)) throw new InvalidOperationException("Directory is a link or junction");
        if (status == unchecked((int)0xC0000103)) throw new InvalidOperationException("Path is not a directory");
        throw new Win32Exception((int)WindowsOwnerClaim.RtlNtStatusToDosError(status), "Directory permission handle could not be opened");
      }
      return handle;
    } finally {
      security.Free();
      if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
      Marshal.FreeHGlobal(buffer);
      GC.KeepAlive(parent);
    }
  }
  public static DirectorySecurity Read(SafeFileHandle handle) {
    long attributes;
    if (!WindowsOwnerClaim.GetFileInformationByHandleEx(handle, 9, out attributes, 8)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Directory attributes could not be read on the permission handle");
    if ((attributes & 0x400) != 0) throw new InvalidOperationException("Directory is a link or junction");
    if ((attributes & 0x10) == 0) throw new InvalidOperationException("Path is not a directory");
    var security = new DirectorySecurity();
    security.SetSecurityDescriptorBinaryForm(WindowsOwnerClaim.ReadDescriptor(handle));
    return security;
  }
  public static FileSystemSecurity ReadChild(SafeFileHandle handle) {
    long attributes;
    if (!WindowsOwnerClaim.GetFileInformationByHandleEx(handle, 9, out attributes, 8)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((attributes & 0x400) != 0) throw new InvalidOperationException("Directory is a link or junction");
    FileSystemSecurity security = (attributes & 0x10) != 0 ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
    security.SetSecurityDescriptorBinaryForm(WindowsOwnerClaim.ReadDescriptor(handle));
    return security;
  }
  public static string[] ReapplyChild(SafeFileHandle handle, SecurityIdentifier user) {
    var previous = ReadChild(handle);
    if (previous.GetOwner(typeof(SecurityIdentifier)).Value != user.Value) throw new InvalidOperationException("Directory is owned by another account");
    bool directory = previous is DirectorySecurity;
    FileStandardInfo info;
    if (!GetFileInformationByHandleEx(handle, 1, out info, (uint)Marshal.SizeOf(typeof(FileStandardInfo)))) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!directory && info.NumberOfLinks > 1) throw new InvalidOperationException("File has multiple links");
    var rules = previous.GetAccessRules(true, true, typeof(SecurityIdentifier));
    var rule = rules.Count == 1 ? (FileSystemAccessRule)rules[0] : null;
    if (previous.AreAccessRulesProtected && rule != null && rule.IdentityReference.Value == user.Value && rule.AccessControlType == AccessControlType.Allow && rule.FileSystemRights == FileSystemRights.FullControl && rule.InheritanceFlags == (directory ? InheritanceFlags.ObjectInherit | InheritanceFlags.ContainerInherit : InheritanceFlags.None) && rule.PropagationFlags == PropagationFlags.None && !rule.IsInherited) return null;
    var removed = new System.Collections.Generic.SortedSet<string>(StringComparer.Ordinal);
    foreach (FileSystemAccessRule entry in rules) if (entry.IdentityReference.Value != user.Value) removed.Add(entry.IdentityReference.Value);
    WindowsOwnerClaim.Write(handle, user, directory, false);
    var principals = new string[removed.Count];
    removed.CopyTo(principals);
    return principals;
  }
  public static string[] Reapply(SafeFileHandle handle, SecurityIdentifier user, bool elevated) {
    var previous = Read(handle);
    string ownerSid = previous.GetOwner(typeof(SecurityIdentifier)).Value;
    if (ownerSid != user.Value && !(elevated && ownerSid == "S-1-5-32-544")) throw new InvalidOperationException("Directory is owned by another account");
    var removed = new System.Collections.Generic.SortedSet<string>(StringComparer.Ordinal);
    foreach (FileSystemAccessRule rule in previous.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.IdentityReference.Value != user.Value) removed.Add(rule.IdentityReference.Value);
    }
    WindowsOwnerClaim.Write(handle, user, true, false);
    var principals = new string[removed.Count];
    removed.CopyTo(principals);
    return principals;
  }
}
'@;
    }
    function Read-Dacl($path, $child, $handle = $null) {
      try {
        $acl = if ($null -eq $handle) { Get-Acl -LiteralPath $path } elseif ($child) { [HomeDirectoryDacl]::ReadChild($handle) } else { [HomeDirectoryDacl]::Read($handle) };
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
          $principal = @{ sid = $_.IdentityReference.Value; accessControlType = [int]$_.AccessControlType;
            fileSystemRights = [int]$_.FileSystemRights; inheritanceFlags = [int]$_.InheritanceFlags;
            propagationFlags = [int]$_.PropagationFlags; isInherited = $_.IsInherited };
          try { $principal.account = $_.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch {}
          $principal
        });
        @{ path = $path; currentUserSid = $sid; elevated = $elevated;
          ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
          protected = $acl.AreAccessRulesProtected; child = $child; rules = $rules }
      } catch { @{ path = $path; error = $_.Exception.GetBaseException().Message } }
    }
    $refused = $null;
    $homeHandle = $null;
    try {
      $results = @(foreach ($path in $request.paths) {
        if ($null -ne $refused) { @{ path = $path; category = $refused; error = 'An enclosing directory was refused' }; continue }
        if (-not $request.protect) { Read-Dacl $path $false; continue }
        $handle = $null;
        $scanHandle = $null;
        try {
          if ($null -eq $homeHandle) {
            $homeHandle = [HomeDirectoryDacl]::OpenHome($path, $identity.User);
            $handle = $homeHandle;
          } else {
            if ([System.IO.Path]::GetDirectoryName($path) -ne [System.IO.Path]::GetFullPath($request.paths[0])) { throw 'Directory is outside the pinned home' }
            $handle = [HomeDirectoryDacl]::OpenRelative($homeHandle, [System.IO.Path]::GetFileName($path), $identity.User, $true);
          }
          $readBack = Read-Dacl $path $false $handle;
          if ($readBack.error) {
            $refused = 'read-back-failed'; $readBack.category = $refused; $readBack; continue
          }
          $owner = $readBack.ownerSid;
          if ($path -eq $request.claimableRuntimeRoot -and -not $elevated -and $owner -eq 'S-1-5-32-544') {
            try {
              [WindowsOwnerClaim]::ClaimFromAdministrators($handle, $identity.User, $true);
              $readBack = Read-Dacl $path $false $handle;
              if ($readBack.error) { throw $readBack.error }
              $owner = $readBack.ownerSid;
            } catch {
              $refused = 'owner-claim-failed'; @{ path = $path; category = $refused; error = ('Directory "' + $path + '" is owned by Administrators and could not be claimed. Run Ave once elevated or fix the directory owner. ' + $_.Exception.GetBaseException().Message) }; continue
            }
          }
          if ($owner -ne $sid -and -not ($elevated -and $owner -eq 'S-1-5-32-544')) {
            $refused = 'invalid-owner-grant'; @{ path = $path; category = $refused; error = 'Directory is owned by another account' }; continue
          }
          $rule = $readBack.rules | Select-Object -First 1;
          if ($readBack.protected -and $readBack.rules.Count -eq 1 -and $rule.sid -eq $sid -and
              $rule.accessControlType -eq 0 -and $rule.fileSystemRights -eq 2032127 -and
              $rule.inheritanceFlags -eq 3 -and $rule.propagationFlags -eq 0 -and $rule.isInherited -eq $false) {
            $resultsForPath = $readBack
          } else {
            $removed = @([HomeDirectoryDacl]::Reapply($handle, $identity.User, $elevated));
            $readBack = Read-Dacl $path $false $handle;
            if ($removed.Count -gt 0) { $readBack.removedPrincipals = @($removed) }
            $resultsForPath = $readBack
          }
          $resultsForPath;
          if ($path -ne $request.paths[0]) {
            $scanHandle = [HomeDirectoryDacl]::OpenRelative($homeHandle, [System.IO.Path]::GetFileName($path), $identity.User, $false, $true, $true);
            foreach ($leaf in [HomeDirectoryDacl]::Children($scanHandle)) {
              $childPath = [System.IO.Path]::Combine($path, $leaf);
              $childHandle = $null;
              try {
                $childHandle = [HomeDirectoryDacl]::OpenRelative($scanHandle, $leaf, $identity.User, $false, $false);
                $removed = [HomeDirectoryDacl]::ReapplyChild($childHandle, $identity.User);
                $childReadBack = Read-Dacl $childPath $true $childHandle;
                if ($null -ne $removed) { $childReadBack.removedPrincipals = @($removed) }
                $childReadBack;
              } catch {
                $message = $_.Exception.GetBaseException().Message;
                $category = switch ($message) {
                  'Directory is a link or junction' { 'reparse-point' }
                  'Directory is owned by another account' { 'invalid-owner-grant' }
                  default { 'icacls-failed' }
                };
                @{ path = $childPath; child = $true; category = $category; error = $message };
              } finally { if ($null -ne $childHandle) { $childHandle.Dispose() } }
            }
          }
        } catch {
          $message = $_.Exception.GetBaseException().Message;
          $refused = switch ($message) {
            'Directory is a link or junction' { 'reparse-point' }
            'Path is not a directory' { 'directory-failed' }
            'Directory is owned by another account' { 'invalid-owner-grant' }
            default { 'icacls-failed' }
          };
          @{ path = $path; category = $refused; error = $message };
        } finally {
          if ($null -ne $scanHandle) { $scanHandle.Dispose() }
          if ($null -ne $handle -and $handle -ne $homeHandle) { $handle.Dispose() }
        }
      });
      ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
    } finally { if ($null -ne $homeHandle) { $homeHandle.Dispose() } }`,
  ], { encoding: "utf-8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ paths, protect, claimableRuntimeRoot }) }) });
  const results: unknown = JSON.parse(output);
  if (!Array.isArray(results) || results.length < paths.length) {
    throw new Error("Directory DACL read-back returned an invalid result set");
  }
  return results;
}
function isOwnerOnlyDacl(descriptor: WindowsDirectoryDacl, sid: string): boolean {
  // Allow an existing elevated administrator owner, but never group Allow entries; new homes belong to the token user.
  const ownerValid = descriptor.ownerSid === sid ||
    (descriptor.elevated === true && descriptor.ownerSid === "S-1-5-32-544");
  const rule = descriptor.rules?.[0];
  return ownerValid && descriptor.rules?.length === 1 && rule?.sid === sid &&
    rule.accessControlType === 0 && rule.fileSystemRights === 2032127 &&
    rule.inheritanceFlags === 3 && rule.propagationFlags === 0 && rule.isInherited === false;
}

let bootHomePrivacy: AveHomePrivacy | undefined;
let extensionsWithoutIsolationApproved = false;
let reportPrivacyRefusal: ((message: string) => void) | undefined;

/** Main-process audit wiring; no renderer or extension owns this state. */
export function setAveHomePrivacyRefusalReporter(reporter: (message: string) => void): void {
  reportPrivacyRefusal = reporter;
}

export function areExtensionsWithoutIsolationApproved(): boolean {
  return getAveHomePrivacyFailure() !== undefined && extensionsWithoutIsolationApproved;
}

/** Called only by the trusted, gesture-checked permissions IPC handler. */
export function approveExtensionsWithoutIsolation(): void {
  if (getAveHomePrivacyFailure() === undefined) throw new Error("Home privacy approval is not applicable");
  extensionsWithoutIsolationApproved = true;
}

/** Boot publishes this once before confinement starts; folder permission repairs require a restart. */
export function setAveHomePrivacyAtBoot(privacy: AveHomePrivacy): void {
  if (JSON.stringify(bootHomePrivacy) !== JSON.stringify(privacy)) extensionsWithoutIsolationApproved = false;
  bootHomePrivacy = Object.freeze(structuredClone(privacy));
}

/** The failed path is safe to show; command diagnostics stay in the host log. */
export function getAveHomePrivacyFailure(): Extract<AveHomePrivacy, { enforcement: "none" }> | undefined {
  return process.platform === "win32" && bootHomePrivacy?.enforcement === "none"
    ? bootHomePrivacy
    : undefined;
}

/** Guard initialization and each confined extension effect boundary. */
export function assertAveHomePrivacyForConfinement(): void {
  if (process.platform !== "win32") return;
  if (bootHomePrivacy?.enforcement !== "win32-dacl" && bootHomePrivacy?.enforcement !== "none") {
    throw new Error("Extension confinement refused: home privacy not established (boot did not publish AVE_HOME protection)");
  }
  const failure = getAveHomePrivacyFailure();
  if (failure !== undefined) {
    const principals = failure.extraPrincipals?.map(({ sid, account }) => account ? `${sid} (${account})` : sid).join(", ");
    const message = `Extension isolation is off: AVE_HOME privacy could not be established (${failure.category}, ${failure.failedPath ?? failure.home}). Approve running without isolation in Settings > Permissions, or fix the folder permissions.${principals ? ` Extra principals: ${principals}.` : ""}`;
    reportPrivacyRefusal?.(message);
    throw new Error(message);
  }
}

/** Test teardown only; production seals the result during boot. */
export function _resetAveHomePrivacyForTest(): void {
  bootHomePrivacy = undefined;
  extensionsWithoutIsolationApproved = false;
  reportPrivacyRefusal = undefined;
}

/** Resolve system security executables by absolute path to avoid incompatible or attacker-controlled PATH entries. */
export function win32SystemBinary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, "System32", `${name}.exe`) : name;
}

/** Windows needs an explicit owner-only inheritable DACL; report failure so confinement refuses unprotected storage. */
export function ensureAveHomePrivate(
  home = aveHome(),
  runtime: AveHomePrivacyRuntime = DEFAULT_PRIVACY_RUNTIME,
): AveHomePrivacy {
  if (runtime.platform !== "win32") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return { enforcement: "posix-mode", home };
  }
  let path = home;
  let category: AveHomePrivacyFailureCategory = "directory-failed";
  try {
    // The protection helper creates private directories with current-user ownership.
    mkdirSync(dirname(home), { recursive: true });
    category = "read-back-failed";
    path = home;
    const paths = [home, join(home, "secrets"), join(home, "subscription-runtimes")];
    const descriptors = runtime.readDacls(paths, true, join(home, "subscription-runtimes"));
    const sid = descriptors[0]?.currentUserSid;
    for (const target of paths) {
      if (!descriptors.some((entry) => entry.path === target && !entry.child)) {
        throw new Error("Directory DACL read-back missing");
      }
    }
    for (const descriptor of descriptors) {
      path = descriptor.path;
      if (descriptor.error !== undefined) {
        category = descriptor.category ?? "read-back-failed";
        throw new Error(descriptor?.error ?? "Directory DACL read-back missing");
      }
      if (typeof sid !== "string" || !/^S-1-[0-9-]+$/.test(sid) || descriptor.currentUserSid !== sid) {
        category = "identity-failed";
        throw new Error("Current account SID read-back is invalid");
      }
      if (!Array.isArray(descriptor.rules) || descriptor.rules.some((rule) =>
        typeof rule.sid !== "string" || !/^S-1-[0-9-]+$/.test(rule.sid) ||
        ![0, 1].includes(rule.accessControlType) || !Number.isInteger(rule.fileSystemRights) ||
        !Number.isInteger(rule.inheritanceFlags) || !Number.isInteger(rule.propagationFlags) ||
        typeof rule.isInherited !== "boolean")) {
        throw new Error("Directory DACL rules read-back is invalid");
      }
      const extraPrincipals = [...new Map(descriptor.rules
        .filter((rule) => rule.sid !== sid && (!descriptor.child || (rule.accessControlType === 0 &&
          (!rule.isInherited || !["S-1-5-18", "S-1-5-32-544"].includes(rule.sid)))))
        .map(({ sid, account }) => [sid, { sid, ...(account ? { account } : {}) }])).values()];
      if (extraPrincipals.length > 0) {
        return { enforcement: "none", home, failedPath: path, category: "extra-principals", extraPrincipals,
          reason: "Remove the extra principal entries or move AVE_HOME" };
      }
      if (descriptor.child) continue;
      if (descriptor.protected !== true) {
        return { enforcement: "none", home, failedPath: path, category: "not-protected", reason: "Directory DACL is not protected against inheritance" };
      }
      if (!isOwnerOnlyDacl(descriptor, sid)) {
        return { enforcement: "none", home, failedPath: path, category: "invalid-owner-grant", reason: "Directory DACL is not owner-only FullControl with object and container inheritance" };
      }
    }
    if (!sid) throw new Error("Current account SID read-back missing");
    const repairs = descriptors.filter((entry) => entry.removedPrincipals !== undefined && (entry.child || entry.removedPrincipals.length > 0))
      .map(({ path, removedPrincipals }) => ({ path, removedPrincipals: removedPrincipals! }));
    return { enforcement: "win32-dacl", home, sid, ...(repairs.length ? { repairs } : {}) };
  } catch (err) {
    return { enforcement: "none", home, failedPath: path, category, reason: (err as Error).message };
  }
}
