// Recheck ownership on the same non-following handle used to claim it.
export const WINDOWS_OWNER_CLAIM_SOURCE = `using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class WindowsOwnerClaim {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out long attributes, uint size);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint info, byte[] owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  private static string OwnerOf(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint result = GetSecurityInfo(handle, 1, 1, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    try { return new SecurityIdentifier(owner).Value; }
    finally { LocalFree(descriptor); }
  }
  public static string Owner(string path) {
    using (SafeFileHandle handle = CreateFile(path, 0x00020000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      return OwnerOf(handle);
    }
  }
  public static void ClaimFromAdministrators(string path, SecurityIdentifier claimant, bool requireNonReparseDirectory) {
    using (SafeFileHandle handle = CreateFile(path, 0x00080000 | 0x00020000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (requireNonReparseDirectory) {
        long attributes;
        if (!GetFileInformationByHandleEx(handle, 9, out attributes, 8)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((attributes & 0x400) != 0 || (attributes & 0x10) == 0) throw new InvalidOperationException("Path is not a non-reparse directory");
      }
      if (OwnerOf(handle) != "S-1-5-32-544") throw new InvalidOperationException("Owner changed during the claim");
      byte[] sid = new byte[claimant.BinaryLength];
      claimant.GetBinaryForm(sid, 0);
      uint result = SetSecurityInfo(handle, 1, 1, sid, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      if (result != 0) throw new Win32Exception((int)result);
    }
  }
}`;
