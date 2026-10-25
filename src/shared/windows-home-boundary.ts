import { WINDOWS_OWNER_CLAIM_SOURCE } from "./windows-owner-claim.js";

export const WINDOWS_HOME_BOUNDARY_SOURCE = `${WINDOWS_OWNER_CLAIM_SOURCE}
public static class HomeDirectoryDacl {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out long attributes, uint size);
  [DllImport("advapi32.dll")]
  private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);
  private static byte[] ReadDescriptor(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint result = WindowsOwnerClaim.GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      return bytes;
    } finally { WindowsOwnerClaim.LocalFree(descriptor); }
  }
  private static byte[] Descriptor(SecurityIdentifier user) {
    var security = new RawSecurityDescriptor("O:" + user.Value + "D:P(A;OICI;FA;;;" + user.Value + ")");
    byte[] bytes = new byte[security.BinaryLength];
    security.GetBinaryForm(bytes, 0);
    return bytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Descriptor, Quality; }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatus { public IntPtr Status, Information; }
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatus status, IntPtr information, uint length, int infoClass);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryDirectoryFile(SafeFileHandle handle, IntPtr evt, IntPtr apc, IntPtr context, out IoStatus status, IntPtr buffer, uint length, int infoClass, [MarshalAs(UnmanagedType.U1)] bool single, IntPtr name, [MarshalAs(UnmanagedType.U1)] bool restart);
  private static void Check(int status, string message) {
    if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status), message + " (" + status.ToString("X8") + ")");
  }
  public static SafeFileHandle OpenHome(string path, SecurityIdentifier user, bool create) {
    string fullPath = System.IO.Path.GetFullPath(path);
    string parentPath = System.IO.Path.GetDirectoryName(fullPath);
    string leaf = System.IO.Path.GetFileName(fullPath);
    if (String.IsNullOrEmpty(parentPath) || String.IsNullOrEmpty(leaf)) throw new InvalidOperationException("Directory path is invalid");
    using (SafeFileHandle parent = WindowsOwnerClaim.CreateFile(parentPath, 0x00100001, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (parent.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Directory parent handle could not be opened");
      return OpenRelative(parent, leaf, user, create ? 3u : 1u, true, true, true);
    }
  }
  public static SafeFileHandle OpenRelative(SafeFileHandle parent, string leaf, SecurityIdentifier user, uint disposition, bool directory, bool noReparse, bool boundary) {
    if (String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.IndexOfAny(new char[] { '\\\\', '/', ':' }) >= 0) throw new InvalidOperationException("Directory leaf is invalid");
    IntPtr buffer = Marshal.StringToHGlobalUni(leaf);
    IntPtr memory = IntPtr.Zero;
    byte[] bytes = boundary ? Descriptor(user) : OwnerDescriptor(user);
    var security = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      var name = new UnicodeString { Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)(leaf.Length * 2 + 2)), Buffer = buffer };
      memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      Marshal.StructureToPtr(name, memory, false);
      var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.DangerousGetHandle(), Name = memory, Attributes = noReparse ? 0x1040u : 0x40u, Descriptor = security.AddrOfPinnedObject() };
      SafeFileHandle handle;
      IoStatus io;
      int status = NtCreateFile(out handle, 0x02100000u, ref attributes, out io, IntPtr.Zero, directory ? 0x10u : 0u, 3u, disposition, 0x00204020u | (directory ? 1u : 0u), IntPtr.Zero, 0);
      if (status == unchecked((int)0xC0000034)) { if (handle != null) handle.Dispose(); return null; }
      if (status < 0) {
        if (handle != null) handle.Dispose();
        if (status == unchecked((int)0xC000050B)) throw new InvalidOperationException("Directory is a link or junction");
        if (status == unchecked((int)0xC0000103)) throw new InvalidOperationException("Path is not a directory");
        Check(status, "Directory permission handle could not be opened");
      }
      if (noReparse && (Attributes(handle) & 0x400) != 0) {
        handle.Dispose();
        throw new InvalidOperationException("Directory is a link or junction");
      }
      return handle;
    } finally {
      security.Free();
      if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
      Marshal.FreeHGlobal(buffer);
      GC.KeepAlive(parent);
    }
  }
  private static byte[] OwnerDescriptor(SecurityIdentifier user) {
    var security = new RawSecurityDescriptor("O:" + user.Value);
    byte[] bytes = new byte[security.BinaryLength];
    security.GetBinaryForm(bytes, 0);
    return bytes;
  }
  private static long Attributes(SafeFileHandle handle) {
    long attributes;
    if (!GetFileInformationByHandleEx(handle, 9, out attributes, 8)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Directory attributes could not be read on the permission handle");
    return attributes;
  }
  public static DirectorySecurity Read(SafeFileHandle handle) {
    long attributes = Attributes(handle);
    if ((attributes & 0x400) != 0) throw new InvalidOperationException("Directory is a link or junction");
    if ((attributes & 0x10) == 0) throw new InvalidOperationException("Path is not a directory");
    var security = new DirectorySecurity();
    security.SetSecurityDescriptorBinaryForm(ReadDescriptor(handle));
    return security;
  }
  public static bool OwnerValid(DirectorySecurity security, SecurityIdentifier user, bool elevated) {
    string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
    return owner == user.Value || (elevated && owner == "S-1-5-32-544");
  }
  public static bool OwnerOnly(DirectorySecurity security, SecurityIdentifier user, bool elevated) {
    var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
    if (!OwnerValid(security, user, elevated) || !security.AreAccessRulesProtected || rules.Count != 1) return false;
    var rule = (FileSystemAccessRule)rules[0];
    return rule.IdentityReference.Value == user.Value && rule.AccessControlType == AccessControlType.Allow &&
      (int)rule.FileSystemRights == 2032127 && (int)rule.InheritanceFlags == 3 && (int)rule.PropagationFlags == 0 && !rule.IsInherited;
  }
  public static bool RootSafe(DirectorySecurity security, SecurityIdentifier user, bool elevated, int readMask) {
    if (!OwnerValid(security, user, elevated) || !security.AreAccessRulesProtected) return false;
    int ownRules = 0;
    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.IdentityReference.Value == user.Value) {
        ownRules++;
        if (rule.AccessControlType != AccessControlType.Allow || (int)rule.FileSystemRights != 2032127 ||
          (int)rule.InheritanceFlags != 3 || (int)rule.PropagationFlags != 0 || rule.IsInherited) return false;
      } else if (rule.AccessControlType != AccessControlType.Allow || ((int)rule.FileSystemRights & ~readMask) != 0) return false;
    }
    return ownRules == 1;
  }
  private static string[] RepairEntries(SafeFileHandle handle) {
    var entries = new System.Collections.Generic.List<string>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool restart = true;
      while (true) {
        IoStatus io;
        int status = NtQueryDirectoryFile(handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out io, buffer, 65536, 12, true, IntPtr.Zero, restart);
        if (status == unchecked((int)0x80000006)) break;
        Check(status, "Repair directory enumeration failed");
        restart = false;
        string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, 12), Marshal.ReadInt32(buffer, 8) / 2);
        if (name != "." && name != "..") entries.Add(name);
      }
      return entries.ToArray();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  private static void Rename(SafeFileHandle handle, SafeFileHandle parent, string name) {
    byte[] text = System.Text.Encoding.Unicode.GetBytes(name);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int textOffset = lengthOffset + 4;
    int size = textOffset + text.Length;
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      for (int i = 0; i < size; i++) Marshal.WriteByte(memory, i, 0);
      Marshal.WriteIntPtr(memory, rootOffset, parent.DangerousGetHandle());
      Marshal.WriteInt32(memory, lengthOffset, text.Length);
      Marshal.Copy(text, 0, IntPtr.Add(memory, textOffset), text.Length);
      IoStatus io;
      Check(NtSetInformationFile(handle, out io, memory, (uint)size, 10), "Repair rename failed");
    } finally { Marshal.FreeHGlobal(memory); GC.KeepAlive(parent); }
  }
  private static void Delete(SafeFileHandle handle, SecurityIdentifier user) {
    long attributes = Attributes(handle);
    if ((attributes & 0x410) == 0x10) {
      foreach (string name in RepairEntries(handle)) {
        using (var child = OpenRelative(handle, name, user, 1, false, false, false)) {
          if (child == null) throw new InvalidOperationException("Repair entry disappeared during deletion");
          Delete(child, user);
        }
      }
    }
    IntPtr memory = Marshal.AllocHGlobal(40);
    try {
      Marshal.WriteInt32(memory, 0x1 | 0x2 | 0x10);
      IoStatus io;
      int status = NtSetInformationFile(handle, out io, memory, 4, 64);
      if (status != unchecked((int)0xC0000003) && status != unchecked((int)0xC00000BB)) {
        Check(status, "Repair no-follow deletion failed");
        return;
      }
      if ((attributes & 1) != 0) {
        // Zero timestamps preserve them; attributes are changed on the pinned entry only.
        for (int i = 0; i < 40; i++) Marshal.WriteByte(memory, i, 0);
        int writableAttributes = unchecked((int)attributes) & ~1;
        Marshal.WriteInt32(memory, 32, writableAttributes == 0 ? 0x80 : writableAttributes);
        Check(NtSetInformationFile(handle, out io, memory, 40, 4), "Repair read-only attribute clearing failed");
      }
      Marshal.WriteByte(memory, 1);
      Check(NtSetInformationFile(handle, out io, memory, 1, 13), "Repair no-follow deletion failed");
    } finally { Marshal.FreeHGlobal(memory); }
  }
  private static int Copy(SafeFileHandle source, SafeFileHandle destination, SecurityIdentifier user) {
    int skipped = 0;
    foreach (string name in RepairEntries(source)) {
      using (var child = OpenRelative(source, name, user, 1, false, false, false)) {
        if (child == null) throw new InvalidOperationException("Repair entry disappeared during copy");
        long attributes = Attributes(child);
        if ((attributes & 0x400) != 0) { skipped++; continue; }
        bool directory = (attributes & 0x10) != 0;
        using (var copy = OpenRelative(destination, name, user, directory ? 3u : 5u, directory, true, false)) {
          if (directory) skipped += Copy(child, copy, user);
          else {
            using (var input = new System.IO.FileStream(child, System.IO.FileAccess.Read))
            using (var output = new System.IO.FileStream(copy, System.IO.FileAccess.Write)) {
              input.CopyTo(output);
              output.Flush(true);
            }
          }
        }
      }
    }
    return skipped;
  }
  public static int Repair(SafeFileHandle home, string name, SecurityIdentifier user, bool elevated) {
    string step = "open";
    string pending = name + ".unprotected-recovery";
    string complete = name + ".unprotected-complete";
    SafeFileHandle live = null, aside = null, finished = null;
    try {
      live = OpenRelative(home, name, user, 1, true, true, true);
      aside = OpenRelative(home, pending, user, 1, true, true, false);
      finished = OpenRelative(home, complete, user, 1, true, true, false);
      if (aside != null && finished != null) throw new InvalidOperationException("Multiple repair states exist");
      if (live == null && (aside != null || finished != null)) {
        step = "recover";
        live = aside ?? finished;
        Rename(live, home, name);
        aside = null; finished = null;
      }
      if (live == null) { step = "create"; live = OpenRelative(home, name, user, 2, true, true, true); }
      var security = Read(live);
      if (!OwnerValid(security, user, elevated)) throw new InvalidOperationException("Directory is owned by another account");
      bool valid = OwnerOnly(security, user, elevated);
      if (finished != null) {
        if (!valid) throw new InvalidOperationException("Completed repair has no protected live directory");
        step = "delete"; Delete(finished, user); return 0;
      }
      if (aside == null && valid) return -1;
      if (aside == null) {
        step = "rename"; Rename(live, home, pending); aside = live; live = null;
        step = "create"; live = OpenRelative(home, name, user, 2, true, true, true);
      } else if (!valid) throw new InvalidOperationException("Pending repair has an unprotected live directory");
      step = "copy";
      int skipped = Copy(aside, live, user);
      step = "verify";
      if (!OwnerOnly(Read(live), user, elevated)) throw new InvalidOperationException("Fresh boundary protection failed verification");
      step = "complete"; Rename(aside, home, complete);
      step = "delete"; Delete(aside, user);
      return skipped;
    } catch (Exception error) { throw new InvalidOperationException("Directory " + name + " repair step " + step + " failed: " + error.Message, error); }
    finally {
      if (finished != null) finished.Dispose();
      if (aside != null) aside.Dispose();
      if (live != null) live.Dispose();
    }
  }
}`;
