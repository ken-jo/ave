// Recheck ownership on the same non-following handle used to claim it.
export const WINDOWS_OWNER_CLAIM_SOURCE = `using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class WindowsOwnerClaim {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  internal static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  internal static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out long attributes, uint size);
  [DllImport("advapi32.dll", SetLastError = true)]
  internal static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("ntdll.dll")]
  private static extern int NtSetSecurityObject(SafeFileHandle handle, uint info, byte[] descriptor);
  [DllImport("ntdll.dll")]
  internal static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll")]
  internal static extern IntPtr LocalFree(IntPtr memory);
  internal static byte[] ReadDescriptor(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint result = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      return bytes;
    }
    finally { LocalFree(descriptor); }
  }
  private static string OwnerOf(SafeFileHandle handle) { return new RawSecurityDescriptor(ReadDescriptor(handle), 0).Owner.Value; }
  internal static byte[] Descriptor(SecurityIdentifier user, bool directory, bool claimOwner) {
    var security = new RawSecurityDescriptor((claimOwner ? "O:" + user.Value : "") + (directory ? "D:P(A;OICI;FA;;;" + user.Value + ")" : ""));
    byte[] bytes = new byte[security.BinaryLength];
    security.GetBinaryForm(bytes, 0);
    return bytes;
  }
  internal static void Write(SafeFileHandle handle, SecurityIdentifier user, bool directory, bool claimOwner) {
    int status = NtSetSecurityObject(handle, (claimOwner ? 1u : 0u) | (directory ? 0x80000004u : 0u), Descriptor(user, directory, claimOwner));
    if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
  }
  public static string Owner(string path) {
    using (SafeFileHandle handle = CreateFile(path, 0x00020000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      return OwnerOf(handle);
    }
  }
  public static void ClaimFromAdministrators(string path, SecurityIdentifier claimant, bool requireNonReparseDirectory) {
    using (SafeFileHandle handle = CreateFile(path, requireNonReparseDirectory ? 0x000E0000u : 0x020A0000u, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      ClaimFromAdministrators(handle, claimant, requireNonReparseDirectory);
    }
  }
  public static void ClaimFromAdministrators(SafeFileHandle handle, SecurityIdentifier claimant, bool requireNonReparseDirectory) {
    long attributes;
    if (!GetFileInformationByHandleEx(handle, 9, out attributes, 8)) throw new Win32Exception(Marshal.GetLastWin32Error());
    bool directory = (attributes & 0x410) == 0x10;
    if (requireNonReparseDirectory && !directory) throw new InvalidOperationException("Path is not a non-reparse directory");
    if (OwnerOf(handle) != "S-1-5-32-544") throw new InvalidOperationException("Owner changed during the claim");
    Write(handle, claimant, directory, true);
  }
}`;
