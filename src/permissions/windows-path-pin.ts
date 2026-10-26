import { execFileSync } from "node:child_process";
import { win32SystemBinary } from "../shared/ave-home.js";
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export interface WindowsPathPin {
  readonly path: string;
  readonly exists: boolean;
  readonly components: readonly { readonly path: string; readonly ino: string }[];
}

// Each ancestor stays open without write/delete sharing until every final path and file ID has been read.
const WINDOWS_PATH_PIN_SOURCE = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class PinnedComponent { public string path; public string ino; }
public sealed class PinnedPath { public string path; public bool exists; public List<PinnedComponent> components = new List<PinnedComponent>(); }
public static class WindowsPathPin {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInfo {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, System.Text.StringBuilder path, uint size, uint flags);
  public static List<PinnedPath> Pin(string[] paths) {
    var handles = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    try {
      var result = new List<PinnedPath>();
      foreach (string requested in paths) {
        string full = System.IO.Path.GetFullPath(requested);
        string root = System.IO.Path.GetPathRoot(full);
        var parts = new List<string> { root };
        string current = root;
        foreach (string part in full.Substring(root.Length).Split(new char[] {'\\\\'}, StringSplitOptions.RemoveEmptyEntries)) {
          current = System.IO.Path.Combine(current, part); parts.Add(current);
        }
        var pinned = new PinnedPath { path = full, exists = true };
        string canonical = root;
        foreach (string component in parts) {
          SafeFileHandle handle;
          if (!handles.TryGetValue(component, out handle)) {
            handle = CreateFile(component, 0, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) {
              int error = Marshal.GetLastWin32Error(); handle.Dispose();
              if (error == 2 || error == 3) { pinned.exists = false; canonical = System.IO.Path.Combine(canonical, full.Substring(component.Length - System.IO.Path.GetFileName(component).Length)); break; }
              throw new Win32Exception(error);
            }
            handles.Add(component, handle);
          }
          FileInfo info;
          if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
          if ((info.attributes & 0x400) != 0) throw new InvalidOperationException("Sandbox stamp target reparse point refused: " + component);
          var name = new System.Text.StringBuilder(32768);
          uint size = GetFinalPathNameByHandle(handle, name, (uint)name.Capacity, 0);
          if (size == 0 || size >= name.Capacity) throw new InvalidOperationException("Cannot pin final path");
          string final = name.ToString();
          if (!final.StartsWith(@"\\\\?\\")) throw new InvalidOperationException("Cannot pin plain drive path");
          final = final.Substring(4);
          if (component != root && !string.Equals(System.IO.Path.GetDirectoryName(final).TrimEnd('\\\\'), canonical.TrimEnd('\\\\'), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Sandbox stamp target left its pinned parent");
          canonical = final;
          pinned.components.Add(new PinnedComponent { path = component, ino = (((ulong)info.indexHigh << 32) | info.indexLow).ToString(System.Globalization.CultureInfo.InvariantCulture) });
        }
        pinned.path = canonical; result.Add(pinned);
      }
      return result;
    } finally { foreach (var handle in handles.Values) handle.Dispose(); }
  }
}`;

const PIN_COMMAND = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
try {
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WINDOWS_PATH_PIN_SOURCE).toString("base64")}')));
  $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json;
  ConvertTo-Json -InputObject @([WindowsPathPin]::Pin([string[]]$paths)) -Depth 5 -Compress;
} catch {
  $cause = $_.Exception; while ($cause.InnerException) { $cause = $cause.InnerException }
  @{ error = $cause.Message } | ConvertTo-Json -Compress;
}`;

export function pinWindowsPaths(paths: readonly string[]): WindowsPathPin[] {
  if (paths.length === 0) return [];
  const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PIN_COMMAND], {
      input: JSON.stringify(paths), encoding: "utf8", windowsHide: true,
      env: windowsPowerShellEnv(), timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  const result = JSON.parse(output) as WindowsPathPin[] | { error: string };
  if (!Array.isArray(result)) throw new Error(result.error);
  if (result.length !== paths.length) throw new Error("Sandbox stamp target pin count mismatch");
  return result;
}
