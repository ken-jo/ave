import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { win32SystemBinary } from "./ave-home.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

export interface WindowsReadDenyEvidence {
  readonly status: "missing" | "private" | "readable" | "reparse" | "error";
  readonly reason?: string;
}

export type WindowsReadDenySnapshot = ReadonlyMap<string, WindowsReadDenyEvidence>;

export function windowsReadDenyKey(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

export function windowsReadDenyEvidence(path: string, snapshot?: WindowsReadDenySnapshot): WindowsReadDenyEvidence {
  const evidence = snapshot?.get(windowsReadDenyKey(path));
  if (evidence !== undefined) return evidence;
  if (snapshot !== undefined) return { status: "error", reason: "Target absent from DACL snapshot" };
  try {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { status: "missing" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
  }
  return { status: "error", reason: "DACL snapshot unavailable" };
}

const WINDOWS_READ_DENY_SOURCE = `
public sealed class ReadDenyEvidence {
  public string status;
  public string reason;
}
public static class WindowsReadDeny {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
  private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, System.IntPtr security, uint creation, uint flags, System.IntPtr template);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int infoClass, out long attributes, uint size);
  [System.Runtime.InteropServices.DllImport("advapi32.dll")]
  private static extern uint GetSecurityInfo(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int type, uint info, out System.IntPtr owner, out System.IntPtr group, out System.IntPtr dacl, out System.IntPtr sacl, out System.IntPtr descriptor);
  [System.Runtime.InteropServices.DllImport("advapi32.dll")]
  private static extern uint GetSecurityDescriptorLength(System.IntPtr descriptor);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  private static extern System.IntPtr LocalFree(System.IntPtr memory);
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct GenericMapping { public uint read, write, execute, all; }
  [System.Runtime.InteropServices.DllImport("advapi32.dll")]
  private static extern void MapGenericMask(ref uint mask, ref GenericMapping mapping);
  private static void AddAccount(System.Collections.Generic.HashSet<string> principals, string name) {
    try {
      principals.Add(new System.Security.Principal.NTAccount(System.Environment.MachineName, name)
        .Translate(typeof(System.Security.Principal.SecurityIdentifier)).Value);
    } catch (System.Security.Principal.IdentityNotMappedException) { }
  }
  public static ReadDenyEvidence[] Read(string[] paths) {
    var principals = new System.Collections.Generic.HashSet<string>(new string[] {
      "S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-4"
    });
    AddAccount(principals, "srt-sandbox");
    AddAccount(principals, "sandbox-runtime-users");
    var results = new ReadDenyEvidence[paths.Length];
    for (int i = 0; i < paths.Length; i++) {
      try { results[i] = ReadOne(paths[i], principals); }
      catch (System.Exception error) { results[i] = new ReadDenyEvidence { status = "error", reason = error.Message }; }
    }
    return results;
  }
  private static ReadDenyEvidence ReadOne(string path, System.Collections.Generic.HashSet<string> principals) {
    using (var handle = CreateFile(path, 0x20000, 7, System.IntPtr.Zero, 3, 0x02200000, System.IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int code = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
        if (code == 2 || code == 3) return new ReadDenyEvidence { status = "missing" };
        throw new System.ComponentModel.Win32Exception(code);
      }
      long attributes;
      if (!GetFileInformationByHandleEx(handle, 9, out attributes, 8))
        throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
      if ((attributes & 0x400) != 0) return new ReadDenyEvidence { status = "reparse" };
      System.IntPtr owner, group, dacl, sacl, descriptor;
      uint result = GetSecurityInfo(handle, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
      if (result != 0) throw new System.ComponentModel.Win32Exception((int)result);
      try {
        var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
        System.Runtime.InteropServices.Marshal.Copy(descriptor, bytes, 0, bytes.Length);
        var raw = new System.Security.AccessControl.RawSecurityDescriptor(bytes, 0);
        if (raw.DiscretionaryAcl == null) return new ReadDenyEvidence { status = "readable", reason = "Unrestricted DACL" };
        foreach (System.Security.AccessControl.GenericAce ace in raw.DiscretionaryAcl) {
          if ((ace.AceFlags & System.Security.AccessControl.AceFlags.InheritOnly) != 0) continue;
          var qualified = ace as System.Security.AccessControl.QualifiedAce;
          if (qualified == null || qualified.IsCallback || qualified is System.Security.AccessControl.ObjectAce)
            throw new System.InvalidOperationException("Unsupported DACL entry");
          if (qualified.AceQualifier == System.Security.AccessControl.AceQualifier.AccessDenied) continue;
          if (qualified.AceQualifier != System.Security.AccessControl.AceQualifier.AccessAllowed)
            throw new System.InvalidOperationException("Unsupported DACL qualifier");
          uint mask = unchecked((uint)qualified.AccessMask);
          var mapping = new GenericMapping { read = 0x120089, write = 0x120116, execute = 0x1200a0, all = 0x1f01ff };
          MapGenericMask(ref mask, ref mapping);
          if ((mask & 1) != 0 && principals.Contains(qualified.SecurityIdentifier.Value))
            return new ReadDenyEvidence { status = "readable", reason = qualified.SecurityIdentifier.Value };
        }
        return new ReadDenyEvidence { status = "private" };
      } finally { LocalFree(descriptor); }
    }
  }
}`;

const READ_DENY_COMMAND = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
Add-Type -TypeDefinition $env:AVE_READ_DENY_SOURCE;
$paths = [string[]](ConvertFrom-Json $env:AVE_READ_DENY_PATHS);
ConvertTo-Json -InputObject @([WindowsReadDeny]::Read($paths)) -Depth 3 -Compress;`;

export async function readWindowsReadDenyEvidence(paths: readonly string[]): Promise<WindowsReadDenySnapshot> {
  const targets = [...new Map(paths.map(path => [windowsReadDenyKey(path), resolve(path).replace(/[\\/]+$/, "")])).values()];
  if (targets.length === 0) return new Map();
  try {
    const output = await promisify(execFile)(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_DENY_COMMAND], {
        windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
        timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
        env: windowsPowerShellEnv({ ...process.env, AVE_READ_DENY_SOURCE: WINDOWS_READ_DENY_SOURCE,
          AVE_READ_DENY_PATHS: JSON.stringify(targets) }),
      });
    const rows: unknown = JSON.parse(output.stdout);
    if (!Array.isArray(rows) || rows.length !== targets.length) throw new Error("Invalid DACL snapshot length");
    return new Map(targets.map((path, index) => {
      const row = rows[index] as WindowsReadDenyEvidence | null;
      if (row === null || typeof row !== "object" || !["missing", "private", "readable", "reparse", "error"].includes(row.status)
        || (row.reason !== null && row.reason !== undefined && typeof row.reason !== "string")) throw new Error("Invalid DACL evidence");
      return [windowsReadDenyKey(path), { status: row.status, ...(typeof row.reason === "string" ? { reason: row.reason } : {}) }];
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return new Map(targets.map(path => [windowsReadDenyKey(path), { status: "error", reason }]));
  }
}
