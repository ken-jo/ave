import { isOwnerOnlyDacl, mapWindowsGenericRights, windowsGrantingRules, windowsOwnerRules, type WindowsDaclFacts } from "./windows-path-facts.js";

export const WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS = 0x1200a9;

/**
 * A foreign root entry Ave accepts (with a diagnostic): an allow of read-only rights that applies to the root alone. Traversal into the
 * home may be shared; an inheritable entry (OI or CI) of any rights flows into every unprotected child (workspace, logs, plugin data),
 * so it is an extra principal. All mutating rights remain exclusive to the owner.
 */
export function isWindowsHomeRootForeignTraversal(rule: { accessControlType: number; fileSystemRights: number; inheritanceFlags: number }): boolean {
  return rule.accessControlType === 0 && rule.inheritanceFlags === 0
    && (mapWindowsGenericRights(rule.fileSystemRights) & ~WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS) === 0;
}

/** Besides the user, the principals that may write to the workspace: SYSTEM and Administrators (lead decision 2026-11-02). */
export const WINDOWS_WORKSPACE_TRUSTED_WRITERS: ReadonlySet<string> = new Set(["S-1-5-18", "S-1-5-32-544"]);

/**
 * The workspace is the cwd, the default workspace root and the in-project auto-write scope, so any other principal that can write to
 * it, through an explicit or an inherited allow, is an extra principal there. A foreign read-only allow is reported, not refused.
 */
export function isWindowsWorkspaceForeignWriter(rule: { sid: string; accessControlType: number; fileSystemRights: number }, userSid: string): boolean {
  return rule.sid !== userSid && !WINDOWS_WORKSPACE_TRUSTED_WRITERS.has(rule.sid) && rule.accessControlType === 0
    && (mapWindowsGenericRights(rule.fileSystemRights) & ~WINDOWS_HOME_ROOT_READ_ONLY_RIGHTS) !== 0;
}

export function isWindowsHomeRootSafe(facts: WindowsDaclFacts): boolean {
  if (!facts.dacl?.protected) return false;
  // Deny entries (srt-win's FILE_DELETE_CHILD deny for its sandbox account among them) remove rights and never grant any.
  const rules = windowsGrantingRules(windowsOwnerRules(facts.dacl));
  return isOwnerOnlyDacl({ ownerSid: facts.dacl.owner, elevated: facts.elevated,
    rules: rules.filter(rule => rule.sid === facts.currentUserSid) }, facts.currentUserSid)
    && rules.every(rule => rule.sid === facts.currentUserSid || isWindowsHomeRootForeignTraversal(rule));
}

/**
 * Mirrors HomeDirectoryDacl.RepairInheritedRoot: the only root shape Ave repairs, the one its own plain mkdir produced before the
 * protection helper created homes. The native helper re-checks it on the pinned handle it repairs through; this decides whether to ask.
 */
const ROOT_REPAIR_REMOVABLE = new Set(["S-1-5-18", "S-1-5-32-544"]);

export function isWindowsHomeRootRepairable(facts: WindowsDaclFacts): boolean {
  const dacl = facts.dacl;
  if (facts.exists !== true || !facts.directory || facts.reparseTag !== 0 || (facts.attributes & 0x400) !== 0) return false;
  if (!dacl || dacl.nullDacl) return false;
  // Owned by the token user (an Administrators-owned root never qualifies, elevated or not), and never a protected DACL:
  // a protected root, safe or not, is left exactly as it is.
  if (dacl.owner !== facts.currentUserSid || dacl.protected) return false;
  let userEntry = false;
  for (const ace of dacl.aces) {
    const own = ace.sid === facts.currentUserSid;
    const inherited = (ace.flags & 0x10) !== 0;
    if (!inherited && (!own || ace.type !== 0)) return false;
    // The repair may drop only inherited SYSTEM and Administrators entries (owner decision 2026-11-02); any other inherited
    // principal (Users, Authenticated Users, Everyone, CREATOR OWNER, a domain group, another user) is refused with the command.
    if (!own && (ace.sid === null || !ROOT_REPAIR_REMOVABLE.has(ace.sid))) return false;
    if (own) userEntry = true;
  }
  return userEntry;
}

/** Host-managed executables (uv, Python installs, venvs, the uv cache). A protected boundary that Repair never copies into: a
 * nonconforming one is set aside and created empty, and its contents are rebuilt on demand. Defined here, beside the Repair source
 * that reads it, and re-exported by ave-home.ts. */
export const AVE_HOME_RUNTIME_DIRECTORY = "runtime";

/** Names the Repair copy and the commit read; ave-home.ts re-exports the first two under their `config/` names. */
export const AVE_HOME_TRUST_MANIFEST_NAME = ".ave-trust-manifest.json";
export const AVE_HOME_CONFIGURATION_SOURCES_NAME = ".ave-config-sources.json";
/** The diagnostic prefix of a commit that found user files in an uncommitted `config/`: the home is refused for recovery. */
export const AVE_HOME_CONFIGURATION_RECOVERY = "Configuration requires recovery";

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
  public static SafeFileHandle OpenRelative(SafeFileHandle parent, string leaf, SecurityIdentifier user, uint disposition, bool directory, bool noReparse, bool boundary, bool readOnly = false, uint share = 3u, uint access = 0u) {
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
      int status = NtCreateFile(out handle, access != 0u ? access : readOnly ? 0x00120089u : 0x02100000u, ref attributes, out io, IntPtr.Zero, directory ? 0x10u : 0u, share, disposition, 0x00204020u | (directory ? 1u : 0u), IntPtr.Zero, 0);
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
  // A deny entry never grants access (srt-win confines its sandbox account with them), so both shapes evaluate allow entries alone.
  public static bool OwnerOnly(DirectorySecurity security, SecurityIdentifier user, bool elevated) {
    if (!OwnerValid(security, user, elevated) || !security.AreAccessRulesProtected) return false;
    FileSystemAccessRule rule = null;
    int granting = 0;
    foreach (FileSystemAccessRule entry in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (entry.AccessControlType == AccessControlType.Deny) continue;
      granting++;
      rule = entry;
    }
    return granting == 1 && rule.IdentityReference.Value == user.Value && rule.AccessControlType == AccessControlType.Allow &&
      (int)rule.FileSystemRights == 2032127 && (int)rule.InheritanceFlags == 3 && (int)rule.PropagationFlags == 0 && !rule.IsInherited;
  }
  public static bool RootSafe(DirectorySecurity security, SecurityIdentifier user, bool elevated, int readMask) {
    if (!OwnerValid(security, user, elevated) || !security.AreAccessRulesProtected) return false;
    int ownRules = 0;
    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType == AccessControlType.Deny) continue;
      if (rule.IdentityReference.Value == user.Value) {
        ownRules++;
        if (rule.AccessControlType != AccessControlType.Allow || (int)rule.FileSystemRights != 2032127 ||
          (int)rule.InheritanceFlags != 3 || (int)rule.PropagationFlags != 0 || rule.IsInherited) return false;
      } else if (rule.AccessControlType != AccessControlType.Allow || (int)rule.InheritanceFlags != 0 ||
        (MapFileGenericRights((int)rule.FileSystemRights) & ~readMask) != 0) return false;
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
  private static bool Named(string name, string expected) {
    return String.Equals(name, expected, StringComparison.OrdinalIgnoreCase);
  }
  /**
   * Remove one item below an anchor directory through handles only: every directory on the way is opened relative to its parent
   * without following a reparse point, and the item itself is opened as the reparse point when it is one, so a link or junction
   * is deleted as an entry and its target is never touched. Returns false when the item does not exist.
   */
  public static bool RemoveItem(string anchor, string[] segments, SecurityIdentifier user) {
    if (segments == null || segments.Length == 0) throw new InvalidOperationException("Item path is invalid");
    SafeFileHandle current = OpenHome(anchor, user, false);
    try {
      for (int index = 0; index < segments.Length - 1; index++) {
        SafeFileHandle next = OpenRelative(current, segments[index], user, 1, true, true, false);
        current.Dispose();
        current = next;
        if (current == null) return false;
      }
      using (var item = OpenRelative(current, segments[segments.Length - 1], user, 1, false, false, false)) {
        if (item == null) return false;
        if (!Delete(item, user)) throw new InvalidOperationException("Item removal failed");
        return true;
      }
    } finally { if (current != null) current.Dispose(); }
  }
  private static int Copy(SafeFileHandle source, SafeFileHandle destination, SecurityIdentifier user) {
    int skipped = 0;
    foreach (string name in RepairEntries(source)) {
      // Trust-state files never travel with a copy: each commit writes them fresh (R3).
      // Compared without case: in a case-sensitive directory a differently cased copy must not slip through either.
      if (Named(name, RepairMarker) || Named(name, NoticeMarker) || Named(name, ConfigurationMarker) || Named(name, "${AVE_HOME_TRUST_MANIFEST_NAME}") || Named(name, "${AVE_HOME_CONFIGURATION_SOURCES_NAME}")) continue;
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
  // Commit a fresh configuration: write each absent document, refuse (and write nothing) when a document already present differs
  // from what this commit would write, then write the trust-state files fresh and the marker last. Root files are never copied.
  public static string[] CommitConfiguration(string path, string directory, string[] names, SecurityIdentifier user, bool elevated, string[] contents, string manifest) {
    var diagnostics = new System.Collections.Generic.List<string>();
    using (var home = OpenHome(path, user, false)) {
      if (home == null || !RootSafe(Read(home), user, elevated, 0x1200a9)) throw new InvalidOperationException("Configuration home protection is unverified");
      using (var destination = OpenRelative(home, directory, user, 1, true, true, true)) {
        if (destination == null || !OwnerOnly(Read(destination), user, elevated)) throw new InvalidOperationException("Configuration boundary protection is unverified");
        var absent = new bool[names.Length];
        for (int index = 0; index < names.Length; index++) {
          byte[] expected = System.Text.Encoding.UTF8.GetBytes(contents[index]);
          using (var existing = OpenRelative(destination, names[index], user, 1, false, true, false, true, 1)) {
            if (existing == null) { absent[index] = true; continue; }
            if ((Attributes(existing) & 0x410) != 0) { diagnostics.Add("${AVE_HOME_CONFIGURATION_RECOVERY}: " + System.IO.Path.Combine(path, directory, names[index])); continue; }
            using (var input = new System.IO.FileStream(existing, System.IO.FileAccess.Read))
            using (var bytes = new System.IO.MemoryStream()) {
              input.CopyTo(bytes);
              byte[] previous = bytes.ToArray();
              bool identical = previous.Length == expected.Length;
              for (int offset = 0; identical && offset < previous.Length; offset++) identical = previous[offset] == expected[offset];
              if (!identical) diagnostics.Add("${AVE_HOME_CONFIGURATION_RECOVERY}: " + System.IO.Path.Combine(path, directory, names[index]));
            }
          }
        }
        if (diagnostics.Count > 0) return diagnostics.ToArray();
        for (int index = 0; index < names.Length; index++) {
          if (absent[index]) WriteStaged(destination, names[index], System.Text.Encoding.UTF8.GetBytes(contents[index]), user);
        }
        WriteStaged(destination, "${AVE_HOME_CONFIGURATION_SOURCES_NAME}", System.Text.Encoding.UTF8.GetBytes("{}"), user);
        WriteStaged(destination, "${AVE_HOME_TRUST_MANIFEST_NAME}", System.Text.Encoding.UTF8.GetBytes(manifest), user);
        EnsureMarker(destination, ConfigurationMarker, user);
        if (!HasMarker(destination, ConfigurationMarker, user)) throw new InvalidOperationException("Configuration migration marker is invalid");
      }
    }
    return diagnostics.ToArray();
  }
  private static void WriteStaged(SafeFileHandle destination, string name, byte[] contents, SecurityIdentifier user) {
    string staged = "." + name + ".migration-" + Guid.NewGuid().ToString("N");
    using (var copy = OpenRelative(destination, staged, user, 2, false, true, false))
    using (var output = new System.IO.FileStream(copy, System.IO.FileAccess.Write)) {
      output.Write(contents, 0, contents.Length);
      output.Flush(true);
      Rename(copy, destination, name, true);
    }
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
  // The one root shape Ave repairs: what a plain mkdir under a user profile produced before the protection helper created the home.
  // Owned by the current user (an Administrators-owned root never qualifies, even elevated), not a link, an unprotected DACL whose
  // every non-owner entry is inherited, and an entry for the user. Checked and repaired on the pinned home handle, then read back
  // through RootSafe and OwnerOnly unchanged. Any other shape is left exactly as it is and refused by the caller.
  public static bool RootRepairable(DirectorySecurity security, SecurityIdentifier user) {
    if (security.GetOwner(typeof(SecurityIdentifier)).Value != user.Value) return false;
    if (security.AreAccessRulesProtected) return false;
    bool userEntry = false;
    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      bool own = rule.IdentityReference.Value == user.Value;
      if (!rule.IsInherited && (!own || rule.AccessControlType != AccessControlType.Allow)) return false;
      if (!own && rule.IdentityReference.Value != "S-1-5-18" && rule.IdentityReference.Value != "S-1-5-32-544") return false;
      if (own) userEntry = true;
    }
    return userEntry;
  }
  public static bool RepairInheritedRoot(SafeFileHandle home, SecurityIdentifier user, bool elevated, int readMask) {
    // Read() refuses a link or a non-directory on this same handle.
    if (!RootRepairable(Read(home), user)) return false;
    // Only the root's own DACL is written. SetSecurityInfo also propagated into existing children, and native run 4 showed that
    // propagation turning the workspace's stale inherited SYSTEM and Administrators entries into explicit ones (before any other
    // writer ran). NtSetSecurityObject computes no inheritance and reaches no child; the per-boot workspace check rewrites it.
    var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected |
      ControlFlags.DiscretionaryAclAutoInherited | ControlFlags.SelfRelative, null, null, null,
      new RawSecurityDescriptor("D:P(A;OICI;FA;;;" + user.Value + ")").DiscretionaryAcl);
    byte[] bytes = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(bytes, 0);
    Check(NtSetSecurityObject(home, 4u, bytes), "Home root repair failed");
    var repaired = Read(home);
    if (!RootSafe(repaired, user, elevated, readMask) || !OwnerOnly(repaired, user, elevated)) throw new InvalidOperationException("Home root repair protection is unverified");
    return true;
  }
  [DllImport("ntdll.dll")]
  private static extern int NtSetSecurityObject(SafeFileHandle handle, uint info, byte[] descriptor);
  // The root repair writes only the root (NtSetSecurityObject, no propagation), so a workspace made under the older, unprotected root
  // keeps that root's stale inherited entries until it is rewritten here. Every boot whose root passes RootSafe checks this one
  // directory, the cwd and default workspace root: when its inherited entries are anything but the single entry a RootSafe root
  // passes down (the user's FullControl, object and container inherit), it is rewritten as its explicit entries in order followed
  // by that entry. NtSetSecurityObject computes no inheritance, so the result is exactly this, and it is read back.
  // Running every boot, not only in the boot that repaired the root, is what retries a boot whose rewrite failed.
  // The workspace is the app's cwd, so it is opened for exactly READ_CONTROL, WRITE_DAC, FILE_READ_ATTRIBUTES and SYNCHRONIZE
  // with full sharing: a request that could include DELETE is a sharing violation against the process's own cwd handle (CI run
  // 41469456420). A link, a non-directory, a protected DACL or a foreign owner is "left"; one that cannot be opened or read is
  // "unavailable", which the boot reports. Other children keep their stale SYSTEM and Administrators entries.
  public static string ReinheritWorkspace(SafeFileHandle home, SecurityIdentifier user) {
    SafeFileHandle handle;
    try { handle = OpenRelative(home, "workspace", user, 1, true, true, false, false, 7u, 0x00160080u); }
    catch (InvalidOperationException) { return "left"; }
    catch (Win32Exception) { return "unavailable"; }
    if (handle == null) return "absent";
    using (handle) {
      RawSecurityDescriptor raw;
      try { raw = new RawSecurityDescriptor(ReadDescriptor(handle), 0); }
      catch (Win32Exception) { return "unavailable"; }
      if ((raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 || raw.DiscretionaryAcl == null) return "left";
      if (raw.Owner == null || raw.Owner.Value != user.Value) return "left";
      if (!StaleInheritance(raw.DiscretionaryAcl, user)) return "clean";
      var acl = new RawAcl(GenericAcl.AclRevision, raw.DiscretionaryAcl.Count + 1);
      int index = 0;
      // Explicit entries are kept in order, and so is an inherited deny (srt-win's sandbox deny on the root flows here): a deny is
      // never stale, and dropping it would only widen what the sandbox account can do in the workspace.
      foreach (GenericAce ace in raw.DiscretionaryAcl) {
        if ((ace.AceFlags & AceFlags.Inherited) == 0 || InheritedDeny(ace)) acl.InsertAce(index++, ace.Copy());
      }
      acl.InsertAce(index, new CommonAce(AceFlags.ObjectInherit | AceFlags.ContainerInherit | AceFlags.Inherited,
        AceQualifier.AccessAllowed, 0x1f01ff, user, false, null));
      var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclAutoInherited |
        ControlFlags.SelfRelative, null, null, null, acl);
      byte[] bytes = new byte[descriptor.BinaryLength];
      descriptor.GetBinaryForm(bytes, 0);
      Check(NtSetSecurityObject(handle, 4u, bytes), "Workspace inheritance reset failed");
      if (StaleInheritance(new RawSecurityDescriptor(ReadDescriptor(handle), 0).DiscretionaryAcl, user)) {
        throw new InvalidOperationException("Workspace inheritance reset is unverified");
      }
      return "rewritten";
    }
  }
  private static bool InheritedDeny(GenericAce ace) {
    var common = ace as CommonAce;
    return (ace.AceFlags & AceFlags.Inherited) != 0 && common != null && common.AceQualifier == AceQualifier.AccessDenied;
  }
  // True unless the only inherited allow entry is the one a RootSafe root passes down to a child directory. An inherited deny is
  // not stale: RootSafe evaluates allow entries alone, so a safe root may pass one down.
  public static bool StaleInheritance(RawAcl acl, SecurityIdentifier user) {
    int inherited = 0;
    foreach (GenericAce ace in acl) {
      if ((ace.AceFlags & AceFlags.Inherited) == 0 || InheritedDeny(ace)) continue;
      inherited++;
      var common = ace as CommonAce;
      if (common == null || common.AceQualifier != AceQualifier.AccessAllowed || common.SecurityIdentifier.Value != user.Value ||
        common.AccessMask != 0x1f01ff || ace.AceFlags != (AceFlags.ObjectInherit | AceFlags.ContainerInherit | AceFlags.Inherited)) return true;
    }
    return inherited != 1;
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
      // The runtime boundary holds executables another principal may have changed while it was unprotected. Copying would launder
      // them into the protected directory, so it starts empty and its contents are rebuilt; the aside is deleted below.
      step = "copy";
      int skipped = name == "${AVE_HOME_RUNTIME_DIRECTORY}" ? 0 : Copy(aside, live, user);
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
