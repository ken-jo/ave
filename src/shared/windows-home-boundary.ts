import { isOwnerOnlyDacl, mapWindowsGenericRights, windowsOwnerRules, type WindowsDaclFacts } from "./windows-path-facts.js";

export const WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS = 0x1200a9;

/** Root traversal may be shared; all mutating rights remain exclusive to the owner. */
export function isWindowsHomeRootSafe(facts: WindowsDaclFacts): boolean {
  if (!facts.dacl?.protected) return false;
  const rules = windowsOwnerRules(facts.dacl);
  return isOwnerOnlyDacl({ ownerSid: facts.dacl.owner, elevated: facts.elevated,
    rules: rules.filter(rule => rule.sid === facts.currentUserSid) }, facts.currentUserSid)
    && rules.every(rule => rule.sid === facts.currentUserSid || (rule.accessControlType === 0
      && (mapWindowsGenericRights(rule.fileSystemRights) & ~WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS) === 0));
}

export const WINDOWS_HOME_BOUNDARY_SOURCE = `using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class HomeDirectoryDacl {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  private const string RepairMarker = ".ave-repair-created";
  private const string NoticeMarker = ".ave-repair-notice-pending";
  private const string ConfigurationMarker = ".ave-config-migrated";
  public static readonly System.Collections.Generic.List<string> CleanupWarnings = new System.Collections.Generic.List<string>();
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out long attributes, uint size);
  [DllImport("advapi32.dll")]
  private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);
  private static byte[] ReadDescriptor(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint result = GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      return bytes;
    } finally { LocalFree(descriptor); }
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
  public static SafeFileHandle OpenHome(string path, SecurityIdentifier user, bool create, bool readOnly = false) {
    string fullPath = System.IO.Path.GetFullPath(path);
    string parentPath = System.IO.Path.GetDirectoryName(fullPath);
    string leaf = System.IO.Path.GetFileName(fullPath);
    if (String.IsNullOrEmpty(parentPath) || String.IsNullOrEmpty(leaf)) throw new InvalidOperationException("Directory path is invalid");
    using (SafeFileHandle parent = CreateFile(parentPath, 0x00100001, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (parent.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Directory parent handle could not be opened");
      return OpenRelative(parent, leaf, user, create ? 3u : 1u, true, true, true, readOnly, readOnly ? 7u : 3u);
    }
  }
  public static SafeFileHandle OpenRelative(SafeFileHandle parent, string leaf, SecurityIdentifier user, uint disposition, bool directory, bool noReparse, bool boundary, bool readOnly = false, uint share = 3u) {
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
      int status = NtCreateFile(out handle, readOnly ? 0x00120089u : 0x02100000u, ref attributes, out io, IntPtr.Zero, directory ? 0x10u : 0u, share, disposition, 0x00204020u | (directory ? 1u : 0u), IntPtr.Zero, 0);
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
      } else if (rule.AccessControlType != AccessControlType.Allow || (MapFileGenericRights((int)rule.FileSystemRights) & ~readMask) != 0) return false;
    }
    return ownRules == 1;
  }
  private static int MapFileGenericRights(int mask) {
    uint rights = unchecked((uint)mask);
    return (int)((rights & 0x0fffffff) | ((rights & 0x80000000) != 0 ? 0x120089u : 0) |
      ((rights & 0x40000000) != 0 ? 0x120116u : 0) | ((rights & 0x20000000) != 0 ? 0x1200a0u : 0) |
      ((rights & 0x10000000) != 0 ? 0x1f01ffu : 0));
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
  private static void Rename(SafeFileHandle handle, SafeFileHandle parent, string name, bool replace = false) {
    byte[] text = System.Text.Encoding.Unicode.GetBytes(name);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int textOffset = lengthOffset + 4;
    int size = textOffset + text.Length;
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      for (int i = 0; i < size; i++) Marshal.WriteByte(memory, i, 0);
      if (replace) Marshal.WriteByte(memory, 0, 1);
      Marshal.WriteIntPtr(memory, rootOffset, parent.DangerousGetHandle());
      Marshal.WriteInt32(memory, lengthOffset, text.Length);
      Marshal.Copy(text, 0, IntPtr.Add(memory, textOffset), text.Length);
      IoStatus io;
      Check(NtSetInformationFile(handle, out io, memory, (uint)size, 10), "Repair rename failed");
    } finally { Marshal.FreeHGlobal(memory); GC.KeepAlive(parent); }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ConfigurationIdentity {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ConfigurationIdentity identity);
  [StructLayout(LayoutKind.Sequential)]
  private struct ConfigurationBasicInformation {
    public long Created, Accessed, Written, Changed;
    public uint Attributes;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out ConfigurationBasicInformation information, uint size);
  private static string ConfigurationDirectoryIdentity(SafeFileHandle handle, bool daclRelied = true) {
    ConfigurationIdentity identity;
    ConfigurationBasicInformation basic;
    if (!GetFileInformationByHandle(handle, out identity) || !GetFileInformationByHandleEx(handle, 0, out basic, 40)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((identity.Attributes & 0x410) != 0x10) throw new InvalidOperationException("Configuration boundary is not a regular directory");
    ulong index = ((ulong)identity.IndexHigh << 32) | identity.IndexLow;
    long changed = checked((basic.Changed - 116444736000000000L) * 100L);
    return identity.Volume.ToString() + ":" + index.ToString() + (daclRelied ? ":" + changed.ToString() : "");
  }
  public static string ConfigurationReadBoundary(string directory, string homePath, bool protectedDirectory, SecurityIdentifier user, bool elevated, string[] ancestors) {
    var handles = new System.Collections.Generic.List<SafeFileHandle>();
    var identities = new System.Collections.Generic.List<string>();
    try {
      foreach (string ancestor in ancestors) {
        var handle = CreateFile(ancestor, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        handles.Add(handle);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        identities.Add(ConfigurationDirectoryIdentity(handle, false));
      }
      string ancestry = "|" + String.Join("|", identities.ToArray());
    using (var root = OpenHome(String.IsNullOrEmpty(homePath) ? directory : homePath, user, false, true)) {
      if (root == null) throw new InvalidOperationException("Configuration home is missing");
      var security = Read(root);
      if (!String.IsNullOrEmpty(homePath) && !RootSafe(security, user, elevated, 0x1200a9)) throw new InvalidOperationException("Configuration home protection is unverified");
      string rootIdentity = ConfigurationDirectoryIdentity(root);
      if (!protectedDirectory) return rootIdentity + ancestry;
      using (var parent = OpenRelative(root, "config", user, 1, true, true, true, true, 7)) {
        if (parent == null || !OwnerOnly(Read(parent), user, elevated)) throw new InvalidOperationException("Configuration boundary protection is unverified");
        return rootIdentity + "|" + ConfigurationDirectoryIdentity(parent) + ancestry;
      }
    }
    } finally { foreach (var handle in handles) handle.Dispose(); }
  }
  private static bool Delete(SafeFileHandle handle, SecurityIdentifier user) {
    long attributes = Attributes(handle);
    if ((attributes & 0x410) == 0x10) {
      foreach (string name in RepairEntries(handle)) {
        using (var child = OpenRelative(handle, name, user, 1, false, false, false)) {
          if (child == null) throw new InvalidOperationException("Repair entry disappeared during deletion");
          Delete(child, user);
        }
      }
    }
    IntPtr memory = Marshal.AllocHGlobal(4);
    try {
      Marshal.WriteInt32(memory, 0x1 | 0x2 | 0x10);
      IoStatus io;
      int status = NtSetInformationFile(handle, out io, memory, 4, 64);
      return status >= 0;
    } finally { Marshal.FreeHGlobal(memory); }
  }
  private static int Copy(SafeFileHandle source, SafeFileHandle destination, SecurityIdentifier user) {
    int skipped = 0;
    foreach (string name in RepairEntries(source)) {
      if (name == RepairMarker || name == NoticeMarker || name == ConfigurationMarker) continue;
      using (var child = OpenRelative(source, name, user, 1, false, false, false)) {
        if (child == null) throw new InvalidOperationException("Repair entry disappeared during copy");
        long attributes = Attributes(child);
        if ((attributes & 0x400) != 0) { skipped++; continue; }
        bool directory = (attributes & 0x10) != 0;
        using (var copy = OpenRelative(destination, name, user, 2, directory, true, false)) {
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
  public static bool RecoverConfigurationCommit(string path, SecurityIdentifier user, bool elevated) {
    using (var home = OpenHome(path, user, false, true)) {
      if (home == null) return false;
      if (!RootSafe(Read(home), user, elevated, 0x1200a9)) throw new InvalidOperationException("Configuration home protection is unverified");
      using (var directory = OpenRelative(home, "config", user, 1, true, true, true, false, 3u)) {
        if (directory == null) return false;
        if (!OwnerOnly(Read(directory), user, elevated)) throw new InvalidOperationException("Configuration boundary protection is unverified");
        using (var marker = OpenRelative(directory, ConfigurationMarker, user, 1, false, true, false, false)) {
          if (marker == null) return false;
          if ((Attributes(marker) & 0x410) != 0) throw new InvalidOperationException("Configuration marker is not a regular file");
          if (MarkerContentValid(marker)) return true;
        }
        using (var marker = OpenRelative(directory, ConfigurationMarker, user, 1, false, true, false)) {
          if (marker == null || !Delete(marker, user)) throw new InvalidOperationException("Configuration marker recovery failed");
        }
        return false;
      }
    }
  }
  public static string[] CleanupConfiguration(string path, string directory, string[] names, SecurityIdentifier user, bool elevated) {
    var diagnostics = new System.Collections.Generic.List<string>();
    using (var home = OpenHome(path, user, false)) {
      if (home == null || !RootSafe(Read(home), user, elevated, 0x1200a9)) throw new InvalidOperationException("Configuration home protection is unverified");
      using (var boundary = OpenRelative(home, directory, user, 1, true, true, true, true)) {
        if (boundary == null || !OwnerOnly(Read(boundary), user, elevated) || !HasMarker(boundary, ConfigurationMarker, user)) throw new InvalidOperationException("Committed configuration protection is unverified");
        string manifest = "";
        using (var record = OpenRelative(boundary, ".ave-config-sources.json", user, 1, false, true, false, true)) {
          if (record != null) {
            if ((Attributes(record) & 0x410) != 0) throw new InvalidOperationException("Configuration source record is not a regular file");
            using (var input = new System.IO.FileStream(record, System.IO.FileAccess.Read))
            using (var reader = new System.IO.StreamReader(input)) manifest = reader.ReadToEnd();
          }
        }
        foreach (string name in names) {
          string oldPath = System.IO.Path.Combine(path, name);
          try {
            using (var source = OpenRelative(home, name, user, 1, false, false, false, false, 1)) {
              if (source == null) continue;
              if ((Attributes(source) & 0x410) != 0) { diagnostics.Add("Legacy configuration is a link or non-regular file: " + oldPath); continue; }
              string hash;
              using (var input = new System.IO.FileStream(source, System.IO.FileAccess.Read)) {
                using (var digest = System.Security.Cryptography.SHA256.Create()) hash = Convert.ToBase64String(digest.ComputeHash(input));
                string quote = ((char)34).ToString();
                var recorded = System.Text.RegularExpressions.Regex.Match(manifest, quote + System.Text.RegularExpressions.Regex.Escape(name) + quote + "\\\\s*:\\\\s*" + quote + "([A-Za-z0-9+/=]+)" + quote);
                if (recorded.Success && recorded.Groups[1].Value == hash) {
                  if (!Delete(source, user)) diagnostics.Add("Legacy configuration cleanup failed: " + oldPath);
                } else {
                  string aside = name + ".post-migration-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffffffZ");
                  Rename(source, home, aside, false);
                  diagnostics.Add("Legacy configuration preserved at " + System.IO.Path.Combine(path, aside));
                }
              }
            }
          } catch (Exception error) { diagnostics.Add("Legacy configuration cleanup failed: " + oldPath + ": " + error.Message); }
        }
      }
    }
    return diagnostics.ToArray();
  }
  public static string[] MigrateConfiguration(string path, string directory, string[] names, SecurityIdentifier user, bool elevated, string[] expectedHashes) {
    var diagnostics = new System.Collections.Generic.List<string>();
    using (var home = OpenHome(path, user, false)) {
      if (home == null || !RootSafe(Read(home), user, elevated, 0x1200a9)) throw new InvalidOperationException("Configuration home protection is unverified");
      using (var destination = OpenRelative(home, directory, user, 1, true, true, true)) {
        if (destination == null || !OwnerOnly(Read(destination), user, elevated)) throw new InvalidOperationException("Configuration boundary protection is unverified");
        var retained = new System.Collections.Generic.List<IDisposable>();
        var deletions = new System.Collections.Generic.Dictionary<SafeFileHandle, string>();
        bool refused = false;
        try {
          for (int index = 0; index < names.Length; index++) {
          string name = names[index];
          string oldPath = System.IO.Path.Combine(path, name);
          string newPath = System.IO.Path.Combine(path, directory, name);
          {
            SafeFileHandle source;
            try { source = OpenRelative(home, name, user, 1, false, false, false, false, 1); }
            catch (Exception) { diagnostics.Add("Configuration source could not be read safely: " + oldPath); refused = true; continue; }
            if (source == null) {
              if (!String.IsNullOrEmpty(expectedHashes[index])) { diagnostics.Add("Configuration source disappeared: " + oldPath); refused = true; }
              continue;
            }
            retained.Add(source);
            if ((Attributes(source) & 0x410) != 0) {
              diagnostics.Add("Skipped non-regular configuration source \\"" + oldPath + "\\" for \\"" + newPath + "\\"");
              refused = true;
              continue;
            }
            string staged = "." + name + ".migration-" + Guid.NewGuid().ToString("N");
            var input = new System.IO.FileStream(source, System.IO.FileAccess.Read);
            retained.Add(input);
            byte[] contents;
            using (var bytes = new System.IO.MemoryStream()) { input.CopyTo(bytes); contents = bytes.ToArray(); }
            string hash;
            using (var digest = System.Security.Cryptography.SHA256.Create()) { hash = Convert.ToBase64String(digest.ComputeHash(contents)); }
            if (hash != expectedHashes[index]) { diagnostics.Add("Configuration source changed after validation: " + oldPath); refused = true; continue; }
            using (var copy = OpenRelative(destination, staged, user, 2, false, true, false))
            using (var output = new System.IO.FileStream(copy, System.IO.FileAccess.Write)) {
              output.Write(contents, 0, contents.Length);
              output.Flush(true);
              Rename(copy, destination, name, true);
              deletions.Add(source, oldPath);
            }
          }
          }
          if (refused) return diagnostics.ToArray();
          for (int index = 0; index < names.Length; index++) {
            if (!String.IsNullOrEmpty(expectedHashes[index])) continue;
            string text = names[index] == "settings.json" ? "{}\\n" : names[index] == "policy.json"
              ? "{\\"version\\":1,\\"requireExplicitApproval\\":true,\\"managed\\":false}\\n"
              : "{\\"version\\":1,\\"entries\\":{}}\\n";
            byte[] contents = System.Text.Encoding.UTF8.GetBytes(text);
            using (var existing = OpenRelative(destination, names[index], user, 1, false, true, false, true, 1)) {
              if (existing != null) {
                if ((Attributes(existing) & 0x410) != 0) { diagnostics.Add("Configuration without a root source is not a regular file: " + names[index]); return diagnostics.ToArray(); }
                using (var input = new System.IO.FileStream(existing, System.IO.FileAccess.Read))
                using (var bytes = new System.IO.MemoryStream()) {
                  input.CopyTo(bytes);
                  byte[] previous = bytes.ToArray();
                  bool identical = previous.Length == contents.Length;
                  for (int offset = 0; identical && offset < previous.Length; offset++) identical = previous[offset] == contents[offset];
                  if (!identical) { diagnostics.Add("Configuration without a root source requires recovery: " + names[index]); return diagnostics.ToArray(); }
                }
                continue;
              }
            }
            string staged = "." + names[index] + ".migration-" + Guid.NewGuid().ToString("N");
            using (var copy = OpenRelative(destination, staged, user, 2, false, true, false))
            using (var output = new System.IO.FileStream(copy, System.IO.FileAccess.Write)) {
              output.Write(contents, 0, contents.Length);
              output.Flush(true);
              Rename(copy, destination, names[index], true);
            }
          }
          string hashRecord = "{";
          for (int index = 0; index < names.Length; index++) {
            if (String.IsNullOrEmpty(expectedHashes[index])) continue;
            if (hashRecord.Length > 1) hashRecord += ",";
            string quote = ((char)34).ToString();
            hashRecord += quote + names[index] + quote + ":" + quote + expectedHashes[index] + quote;
          }
          byte[] hashBytes = System.Text.Encoding.UTF8.GetBytes(hashRecord + "}");
          string stagedHashes = ".ave-config-sources-" + Guid.NewGuid().ToString("N");
          using (var record = OpenRelative(destination, stagedHashes, user, 2, false, true, false))
          using (var output = new System.IO.FileStream(record, System.IO.FileAccess.Write)) {
            output.Write(hashBytes, 0, hashBytes.Length);
            output.Flush(true);
            Rename(record, destination, ".ave-config-sources.json", true);
          }
          EnsureMarker(destination, ConfigurationMarker, user);
          if (!HasMarker(destination, ConfigurationMarker, user)) throw new InvalidOperationException("Configuration migration marker is invalid");
          foreach (var deletion in deletions) {
            try {
              if (!Delete(deletion.Key, user)) diagnostics.Add("Legacy configuration retained after copy: " + deletion.Value);
            } catch (Exception error) { diagnostics.Add("Legacy configuration cleanup failed: " + deletion.Value + ": " + error.Message); }
          }
        } finally {
          for (int index = retained.Count - 1; index >= 0; index--) retained[index].Dispose();
        }
      }
    }
    return diagnostics.ToArray();
  }
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint info, byte[] owner, IntPtr group, byte[] dacl, IntPtr sacl);
  public static void ClaimRuntimeRoot(SafeFileHandle home, string name, SecurityIdentifier user) {
    if (name != "subscription-runtimes") throw new InvalidOperationException("Runtime ownership claim boundary is invalid");
    using (var handle = OpenRelative(home, name, user, 1, true, true, true)) {
      if (handle == null) return;
      string owner = Read(handle).GetOwner(typeof(SecurityIdentifier)).Value;
      if (owner == user.Value) return;
      if (owner != "S-1-5-32-544") throw new InvalidOperationException("Directory is owned by another account");
      byte[] sid = new byte[user.BinaryLength];
      user.GetBinaryForm(sid, 0);
      RawAcl acl = new RawSecurityDescriptor("D:P(A;OICI;FA;;;" + user.Value + ")").DiscretionaryAcl;
      byte[] access = new byte[acl.BinaryLength];
      acl.GetBinaryForm(access, 0);
      uint result = SetSecurityInfo(handle, 1, 0x80000005u, sid, IntPtr.Zero, access, IntPtr.Zero);
      if (result != 0) throw new Win32Exception((int)result);
      if (!OwnerOnly(Read(handle), user, false)) throw new InvalidOperationException("Runtime ownership claim protection is unverified");
    }
  }
  public static int Repair(SafeFileHandle home, string name, SecurityIdentifier user, bool elevated, string path = "") {
    CleanupWarnings.Clear();
    string step = "open";
    string pending = name + ".unprotected-recovery";
    string complete = name + ".unprotected-complete";
    SafeFileHandle live = null, aside = null, finished = null;
    bool fresh = false;
    try {
      live = OpenRelative(home, name, user, 1, true, true, true);
      aside = OpenRelative(home, pending, user, 1, true, true, false);
      finished = OpenRelative(home, complete, user, 1, true, true, false);
      if (aside != null && finished != null) throw new InvalidOperationException("Multiple repair states exist");
      if (live == null && (aside != null || finished != null)) {
        step = "recover";
        if (finished != null) { Rename(finished, home, pending); aside = finished; finished = null; }
      }
      if (live == null) { step = "create"; live = OpenRelative(home, name, user, 2, true, true, true); fresh = true; }
      var security = Read(live);
      if (!OwnerValid(security, user, elevated)) throw new InvalidOperationException("Directory is owned by another account");
      bool valid = OwnerOnly(security, user, elevated);
      if (finished != null) {
        if (!valid) throw new InvalidOperationException("Completed repair has no protected live directory");
        bool noticePending = HasMarker(live, NoticeMarker, user);
        step = "delete"; Cleanup(finished, System.IO.Path.Combine(path, complete), user); return noticePending ? 0 : -1;
      }
      if (aside == null && valid) return HasMarker(live, NoticeMarker, user) ? 0 : -1;
      if (aside == null) {
        step = "rename"; Rename(live, home, pending); aside = live; live = null;
        step = "create"; live = OpenRelative(home, name, user, 2, true, true, true);
      } else if (!fresh) {
        step = "restart";
        bool created = valid && HasMarker(live, RepairMarker, user);
        string abandoned = name + ".unprotected-abandoned-" + Guid.NewGuid().ToString("N");
        Rename(live, home, abandoned);
        if (created) Cleanup(live, System.IO.Path.Combine(path, abandoned), user);
        else CleanupWarnings.Add("Unmarked interrupted directory retained: " + System.IO.Path.Combine(path, abandoned));
        live.Dispose();
        live = OpenRelative(home, name, user, 2, true, true, true);
      }
      EnsureMarker(live, RepairMarker, user);
      step = "copy";
      int skipped = Copy(aside, live, user);
      step = "verify";
      if (!OwnerOnly(Read(live), user, elevated)) throw new InvalidOperationException("Fresh boundary protection failed verification");
      EnsureMarker(live, NoticeMarker, user);
      step = "complete"; Rename(aside, home, complete);
      step = "delete"; Cleanup(aside, System.IO.Path.Combine(path, complete), user);
      return skipped;
    } catch (Exception error) { throw new InvalidOperationException("Directory " + name + " repair step " + step + " failed: " + error.Message, error); }
    finally {
      if (finished != null) finished.Dispose();
      if (aside != null) aside.Dispose();
      if (live != null) live.Dispose();
    }
  }
  private static void Cleanup(SafeFileHandle handle, string path, SecurityIdentifier user) {
    try {
      if (Delete(handle, user)) return;
    } catch (Exception error) { CleanupWarnings.Add("Aside cleanup failed: " + path + ": " + error.Message); return; }
    CleanupWarnings.Add("Aside retained without changing attributes: " + path);
  }
  private static bool HasMarker(SafeFileHandle directory, string name, SecurityIdentifier user) {
    using (var marker = OpenRelative(directory, name, user, 1, false, true, false)) {
      if (marker == null) return false;
      if ((Attributes(marker) & 0x410) != 0) return false;
      return MarkerContentValid(marker);
    }
  }
  private static bool MarkerContentValid(SafeFileHandle marker) {
      using (var stream = new System.IO.FileStream(marker, System.IO.FileAccess.Read)) {
        byte[] expected = System.Text.Encoding.UTF8.GetBytes("ave-home-boundary-v1");
        if (stream.Length != expected.Length) return false;
        foreach (byte value in expected) if (stream.ReadByte() != value) return false;
        return true;
      }
  }
  private static void EnsureMarker(SafeFileHandle directory, string name, SecurityIdentifier user) {
    if (HasMarker(directory, name, user)) return;
    string staged = "." + name + ".migration-" + Guid.NewGuid().ToString("N");
    using (var marker = OpenRelative(directory, staged, user, 2, false, true, false))
    using (var stream = new System.IO.FileStream(marker, System.IO.FileAccess.Write)) {
      byte[] bytes = System.Text.Encoding.UTF8.GetBytes("ave-home-boundary-v1");
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
      Rename(marker, directory, name);
    }
  }
  public static void AcknowledgeRepair(string path, string name, SecurityIdentifier user, bool elevated) {
    using (var home = OpenHome(path, user, false)) {
      if (home == null || !RootSafe(Read(home), user, elevated, 0x1200a9)) throw new InvalidOperationException("Notice home protection is unverified");
      using (var boundary = OpenRelative(home, name, user, 1, true, true, true)) {
        if (boundary == null || !OwnerOnly(Read(boundary), user, elevated)) throw new InvalidOperationException("Notice boundary protection is unverified");
        if (!HasMarker(boundary, NoticeMarker, user)) return;
        using (var marker = OpenRelative(boundary, NoticeMarker, user, 1, false, true, false)) {
          if (marker != null && !Delete(marker, user)) throw new InvalidOperationException("Notice acknowledgment failed");
        }
      }
    }
  }
}`;
