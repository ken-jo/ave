import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { win32SystemBinary } from "./ave-home.js";
import { errorMessage } from "./error-message.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

export type WindowsReadDenyPrincipal = "Everyone" | "Users" | "Authenticated Users" | "INTERACTIVE" | "srt-sandbox" | "sandbox-runtime-users";

const WINDOWS_READ_DENY_PRINCIPALS: readonly WindowsReadDenyPrincipal[] = [
  "Everyone", "Users", "Authenticated Users", "INTERACTIVE", "srt-sandbox", "sandbox-runtime-users",
];

export interface WindowsReadDenyEvidence {
  readonly status: "missing" | "private" | "readable" | "reparse" | "error";
  readonly reason?: string;
  readonly principals?: readonly WindowsReadDenyPrincipal[];
  readonly identity?: { readonly volumeSerialNumber: string; readonly fileId: string };
}

export type WindowsReadDenySnapshot = ReadonlyMap<string, WindowsReadDenyEvidence>;

export function windowsReadDenyKey(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

export function windowsReadDenyEvidence(path: string, snapshot?: WindowsReadDenySnapshot): WindowsReadDenyEvidence {
  const evidence = snapshot?.get(windowsReadDenyKey(path));
  if (evidence?.status === "error") return evidence;
  if (snapshot !== undefined && evidence === undefined) return { status: "error", reason: "Target absent from DACL snapshot" };
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) {
      return evidence === undefined || evidence.status === "missing" ? { status: "missing" }
        : { status: "error", reason: "DACL snapshot target no longer exists" };
    }
    if (evidence?.status === "missing") return { status: "error", reason: "DACL snapshot target now exists" };
    if (evidence !== undefined) {
      if (!stat.isSymbolicLink() && evidence.identity !== undefined
        && stat.dev === BigInt(evidence.identity.volumeSerialNumber) && stat.ino === BigInt(evidence.identity.fileId)) return evidence;
      return { status: "error", reason: "DACL snapshot target identity is unproven" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && (evidence === undefined || evidence.status === "missing")) return { status: "missing" };
    return { status: "error", reason: "DACL snapshot target identity could not be checked" };
  }
  return { status: "error", reason: "DACL snapshot unavailable" };
}

const WINDOWS_READ_DENY_SOURCE = `
public sealed class ReadDenyIdentity {
  public string volumeSerialNumber;
  public string fileId;
}
public sealed class ReadDenyEvidence {
  public string status;
  public string reason;
  public string[] principals;
  public ReadDenyIdentity identity;
}
public static class WindowsReadDeny {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
  private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, System.IntPtr security, uint creation, uint flags, System.IntPtr template);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, out FileInformation information);
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct FileInformation {
    public uint attributes, creationLow, creationHigh, accessLow, accessHigh, writeLow, writeHigh;
    public uint volumeSerialNumber, sizeHigh, sizeLow, links, fileIdHigh, fileIdLow;
  }
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
  private static void AddAccount(System.Collections.Generic.Dictionary<string, string> principals, string name) {
    try {
      principals[new System.Security.Principal.NTAccount(System.Environment.MachineName, name)
        .Translate(typeof(System.Security.Principal.SecurityIdentifier)).Value] = name;
    } catch (System.Security.Principal.IdentityNotMappedException) { }
  }
  public static ReadDenyEvidence[] Read(string[] paths) {
    var principals = new System.Collections.Generic.Dictionary<string, string> {
      { "S-1-1-0", "Everyone" }, { "S-1-5-32-545", "Users" },
      { "S-1-5-11", "Authenticated Users" }, { "S-1-5-4", "INTERACTIVE" }
    };
    AddAccount(principals, "srt-sandbox");
    AddAccount(principals, "sandbox-runtime-users");
    var results = new ReadDenyEvidence[paths.Length];
    for (int i = 0; i < paths.Length; i++) {
      try { results[i] = ReadOne(paths[i], principals); }
      catch (System.Exception error) { results[i] = new ReadDenyEvidence { status = "error", reason = error.Message }; }
    }
    return results;
  }
  private static ReadDenyEvidence ReadOne(string path, System.Collections.Generic.Dictionary<string, string> principals) {
    using (var handle = CreateFile(path, 0x20000, 7, System.IntPtr.Zero, 3, 0x02200000, System.IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int code = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
        if (code == 2 || code == 3) return new ReadDenyEvidence { status = "missing" };
        throw new System.ComponentModel.Win32Exception(code);
      }
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information))
        throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
      var identity = new ReadDenyIdentity {
        volumeSerialNumber = information.volumeSerialNumber.ToString(System.Globalization.CultureInfo.InvariantCulture),
        fileId = (((ulong)information.fileIdHigh << 32) | information.fileIdLow).ToString(System.Globalization.CultureInfo.InvariantCulture)
      };
      if ((information.attributes & 0x400) != 0) return new ReadDenyEvidence { status = "reparse", identity = identity };
      System.IntPtr owner, group, dacl, sacl, descriptor;
      uint result = GetSecurityInfo(handle, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
      if (result != 0) throw new System.ComponentModel.Win32Exception((int)result);
      try {
        var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
        System.Runtime.InteropServices.Marshal.Copy(descriptor, bytes, 0, bytes.Length);
        var raw = new System.Security.AccessControl.RawSecurityDescriptor(bytes, 0);
        if (raw.DiscretionaryAcl == null) return new ReadDenyEvidence { status = "readable", identity = identity, reason = "Unrestricted DACL", principals = new string[] { "Everyone" } };
        var matched = new System.Collections.Generic.HashSet<string>();
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
          if ((mask & 1) != 0 && principals.ContainsKey(qualified.SecurityIdentifier.Value))
            matched.Add(principals[qualified.SecurityIdentifier.Value]);
        }
        if (matched.Count != 0) return new ReadDenyEvidence { status = "readable", identity = identity, principals = new System.Collections.Generic.List<string>(matched).ToArray() };
        return new ReadDenyEvidence { status = "private", identity = identity };
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
        || (row.reason !== null && row.reason !== undefined && typeof row.reason !== "string")
        || (row.status === "readable" && (!Array.isArray(row.principals) || row.principals.length === 0
          || row.principals.some(principal => !WINDOWS_READ_DENY_PRINCIPALS.includes(principal))))
        || (["private", "readable", "reparse"].includes(row.status) && (row.identity === null || typeof row.identity !== "object"
          || typeof row.identity.volumeSerialNumber !== "string" || !/^[0-9]{1,10}$/.test(row.identity.volumeSerialNumber)
          || BigInt(row.identity.volumeSerialNumber) > 0xffffffffn
          || typeof row.identity.fileId !== "string" || !/^[0-9]{1,20}$/.test(row.identity.fileId)
          || BigInt(row.identity.fileId) > 0xffffffffffffffffn))) throw new Error("Invalid DACL evidence");
      return [windowsReadDenyKey(path), { status: row.status, ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
        ...(row.identity ? { identity: { volumeSerialNumber: row.identity.volumeSerialNumber, fileId: row.identity.fileId } } : {}),
        ...(row.status === "readable" ? { principals: row.principals } : {}) }];
    }));
  } catch (error) {
    const reason = errorMessage(error);
    return new Map(targets.map(path => [windowsReadDenyKey(path), { status: "error", reason }]));
  }
}
