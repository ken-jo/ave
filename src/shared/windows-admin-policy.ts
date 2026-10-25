import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32SystemBinary } from "./ave-home.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { WINDOWS_OWNER_CLAIM_SOURCE } from "./windows-owner-claim.js";

interface PolicyAccessRule {
  sid: string;
  mask: number;
  allow: boolean;
  inheritOnly: boolean;
}

export interface WindowsPolicyDescriptor {
  ownerSid: string;
  nullDacl: boolean;
  rules: PolicyAccessRule[];
}

const ADMINISTRATORS_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const TRUSTED_WRITERS = new Set([ADMINISTRATORS_SID, SYSTEM_SID, TRUSTED_INSTALLER_SID]);

export function windowsPolicyTrustFailure(file: WindowsPolicyDescriptor, parent: WindowsPolicyDescriptor): string | null {
  if (file.ownerSid !== ADMINISTRATORS_SID && file.ownerSid !== SYSTEM_SID) return `owner ${file.ownerSid}`;
  // A directory owner can replace its DACL even without an explicit write grant.
  if (!TRUSTED_WRITERS.has(parent.ownerSid)) return `parent owner ${parent.ownerSid}`;
  // Add-file/subdirectory on the parent cannot replace an existing file; ProgramData's default inheritance grants Users exactly that.
  for (const [descriptor, label, mask] of [[file, "file", 0x500d0116], [parent, "parent", 0x500d0040]] as const) {
    if (descriptor.nullDacl) return `${label} has an unrestricted DACL`;
    for (const rule of descriptor.rules) {
      if (rule.allow && !rule.inheritOnly && (rule.mask & mask) !== 0 && !TRUSTED_WRITERS.has(rule.sid)) {
        return `${label} writable by ${rule.sid}`;
      }
    }
  }
  return null;
}

const WINDOWS_POLICY_READ_SOURCE = `
public sealed class PolicyRule {
  public string sid;
  public uint mask;
  public bool allow;
  public bool inheritOnly;
}
public sealed class PolicyDescriptor {
  public string ownerSid;
  public bool nullDacl;
  public System.Collections.Generic.List<PolicyRule> rules = new System.Collections.Generic.List<PolicyRule>();
}
public sealed class PolicySnapshot {
  public PolicyDescriptor file;
  public PolicyDescriptor parent;
  public string bytes;
}
public static class WindowsPolicyRead {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, System.Text.StringBuilder path, uint size, uint flags);
  private static string FinalPath(Microsoft.Win32.SafeHandles.SafeFileHandle handle) {
    var path = new System.Text.StringBuilder(32768);
    uint size = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
    if (size == 0) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    if (size >= path.Capacity) throw new System.InvalidOperationException("Final path exceeds the read limit");
    return path.ToString().TrimEnd('\\\\');
  }
  private static void CheckKind(Microsoft.Win32.SafeHandles.SafeFileHandle handle, bool directory) {
    long attributes;
    if (!WindowsOwnerClaim.GetFileInformationByHandleEx(handle, 9, out attributes, 8))
      throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    if ((attributes & 0x400) != 0) throw new System.InvalidOperationException("Reparse point refused");
    if (((attributes & 0x10) != 0) != directory) throw new System.InvalidOperationException("Unexpected file kind");
  }
  private static PolicyDescriptor Security(Microsoft.Win32.SafeHandles.SafeFileHandle handle) {
    System.IntPtr owner, group, dacl, sacl, descriptor;
    uint result = WindowsOwnerClaim.GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new System.ComponentModel.Win32Exception((int)result);
    try {
      var bytes = new byte[WindowsOwnerClaim.GetSecurityDescriptorLength(descriptor)];
      System.Runtime.InteropServices.Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var raw = new System.Security.AccessControl.RawSecurityDescriptor(bytes, 0);
      var access = new PolicyDescriptor { ownerSid = raw.Owner.Value, nullDacl = raw.DiscretionaryAcl == null };
      if (raw.DiscretionaryAcl != null) foreach (System.Security.AccessControl.GenericAce ace in raw.DiscretionaryAcl) {
        var qualified = ace as System.Security.AccessControl.QualifiedAce;
        if (qualified == null || qualified.IsCallback || (qualified.AceQualifier != System.Security.AccessControl.AceQualifier.AccessAllowed && qualified.AceQualifier != System.Security.AccessControl.AceQualifier.AccessDenied))
          throw new System.InvalidOperationException("Unsupported DACL entry");
        access.rules.Add(new PolicyRule { sid = qualified.SecurityIdentifier.Value, mask = unchecked((uint)qualified.AccessMask),
          allow = qualified.AceQualifier == System.Security.AccessControl.AceQualifier.AccessAllowed,
          inheritOnly = (qualified.AceFlags & System.Security.AccessControl.AceFlags.InheritOnly) != 0 });
      }
      return access;
    } finally { WindowsOwnerClaim.LocalFree(descriptor); }
  }
  public static PolicySnapshot Read(string path) {
    string full = System.IO.Path.GetFullPath(path);
    string directory = System.IO.Path.GetDirectoryName(full);
    // Keep both objects pinned against rename, replacement and concurrent file writes.
    using (var parent = WindowsOwnerClaim.CreateFile(directory, 0x20000, 3, System.IntPtr.Zero, 3, 0x02200000, System.IntPtr.Zero)) {
      if (parent.IsInvalid) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
      CheckKind(parent, true);
      using (var file = WindowsOwnerClaim.CreateFile(full, 0x80020000, 1, System.IntPtr.Zero, 3, 0x00200000, System.IntPtr.Zero)) {
        if (file.IsInvalid) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        CheckKind(file, false);
        string filePath = FinalPath(file);
        if (!string.Equals(System.IO.Path.GetDirectoryName(filePath), FinalPath(parent), System.StringComparison.OrdinalIgnoreCase)
          || !string.Equals(System.IO.Path.GetFileName(filePath), System.IO.Path.GetFileName(full), System.StringComparison.OrdinalIgnoreCase))
          throw new System.InvalidOperationException("Policy file is outside the checked parent");
        var snapshot = new PolicySnapshot { file = Security(file), parent = Security(parent) };
        using (var stream = new System.IO.FileStream(file, System.IO.FileAccess.Read)) {
          if (stream.Length > 1048576) throw new System.InvalidOperationException("Policy file exceeds the read limit");
          using (var bytes = new System.IO.MemoryStream()) {
            stream.CopyTo(bytes);
            snapshot.bytes = System.Convert.ToBase64String(bytes.ToArray());
          }
        }
        return snapshot;
      }
    }
  }
}`;

const POLICY_READ_COMMAND = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
try {
  Add-Type -TypeDefinition $env:AVE_POLICY_READ_SOURCE;
  [WindowsPolicyRead]::Read($env:AVE_POLICY_READ_PATH) | ConvertTo-Json -Depth 6 -Compress;
} catch {
  $cause = $_.Exception; while ($cause.InnerException) { $cause = $cause.InnerException }
  $code = if ($cause -is [System.ComponentModel.Win32Exception]) { $cause.NativeErrorCode } else { 0 };
  @{ error = $cause.Message; code = $code } | ConvertTo-Json -Compress;
}`;

export class WindowsPolicyReadError extends Error {
  readonly code: string;
  constructor(path: string, cause: string, code = "untrusted-policy") {
    super(`untrusted policy file at ${path} (${cause})`);
    this.name = "WindowsPolicyReadError";
    this.code = code;
  }
}

const execFileAsync = promisify(execFile);

export async function readWindowsAdminPolicy(path: string): Promise<Buffer> {
  const output = await execFileAsync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POLICY_READ_COMMAND], {
      windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
      env: windowsPowerShellEnv({ ...process.env, AVE_POLICY_READ_PATH: path,
        AVE_POLICY_READ_SOURCE: WINDOWS_OWNER_CLAIM_SOURCE + WINDOWS_POLICY_READ_SOURCE }),
    });
  const snapshot = JSON.parse(output.stdout) as { file: WindowsPolicyDescriptor; parent: WindowsPolicyDescriptor; bytes: string; error?: string; code?: number };
  if (snapshot.error !== undefined) throw new WindowsPolicyReadError(path, snapshot.error, snapshot.code === 2 || snapshot.code === 3 ? "ENOENT" : "untrusted-policy");
  const failure = windowsPolicyTrustFailure(snapshot.file, snapshot.parent);
  if (failure !== null) throw new WindowsPolicyReadError(path, failure);
  return Buffer.from(snapshot.bytes, "base64");
}
