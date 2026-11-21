// The same held-file identity is used to record a creation and authorize its removal.
export const PRIVATE_DIRECTORY_API = `using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class PrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Descriptor, Quality; }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatus { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, IntPtr volumeName, uint volumeSize, IntPtr serial, IntPtr maxComponent, IntPtr flags, StringBuilder filesystem, uint filesystemSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, byte[] info, uint length);
  private const uint Traverse = 0x20, ReadAttributes = 0x80, DeleteAccess = 0x10000;
  private const uint Directory = 0x10, ReparsePoint = 0x400;
  private static FileInformation Info(SafeFileHandle handle) {
    FileInformation info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return info;
  }
  private static string Identity(SafeFileHandle handle, FileInformation info) {
    // The ledger and the runtime stat use the same NTFS volume serial and 64-bit file index.
    var filesystem = new StringBuilder(32);
    if (!GetVolumeInformationByHandleW(handle, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, filesystem, (uint)filesystem.Capacity)
        || filesystem.ToString() != "NTFS") throw new InvalidOperationException("Private helper volume identity is not supported");
    ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
    long ticks = ((long)info.CreationHigh << 32) | info.CreationLow;
    if (index == 0) throw new InvalidOperationException("Private helper identity unavailable");
    return info.Volume + ":" + index + ":" + ((ticks - 116444736000000000L) * 100);
  }
  private static string ExtendedPath(string path) {
    if (path.StartsWith(@"\\\\?\\")) return path;
    if (path.StartsWith(@"\\\\")) return @"\\\\?\\UNC\\" + path.Substring(2);
    return @"\\\\?\\" + path;
  }
  private static SafeFileHandle Open(string path, uint access, bool directory, string expected) {
    // Hold the name against deletion or rename. Open the reparse entry itself so it can be rejected.
    var handle = CreateFileW(ExtendedPath(path), access | ReadAttributes, 3u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      if (error == 2 || error == 3) return null;
      throw new Win32Exception(error);
    }
    try {
      var info = Info(handle);
      if ((info.Attributes & ReparsePoint) != 0 || ((info.Attributes & Directory) != 0) != directory
          || (expected != null && Identity(handle, info) != expected)) throw new InvalidOperationException("Private helper entry changed");
      return handle;
    } catch { handle.Dispose(); throw; }
  }
  public sealed class HeldParents : IDisposable {
    private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    public SafeFileHandle Parent { get { return handles[handles.Count - 1]; } }
    public void Add(SafeFileHandle handle) { handles.Add(handle); }
    public void Dispose() { foreach (var handle in handles) handle.Dispose(); }
  }
  public static HeldParents HoldParents(string path) {
    var names = new Stack<string>();
    for (var parent = System.IO.Directory.GetParent(path); parent != null; parent = parent.Parent) names.Push(parent.FullName);
    var handles = new HeldParents();
    try {
      foreach (string name in names) {
        var handle = Open(name, Traverse, true, null);
        if (handle == null) throw new DirectoryNotFoundException();
        handles.Add(handle);
      }
      return handles;
    } catch { handles.Dispose(); throw; }
  }
  public static SafeFileHandle Create(HeldParents parents, string path, byte[] descriptor) {
    var parent = parents.Parent;
    string leaf = Path.GetFileName(path);
    IntPtr text = Marshal.StringToHGlobalUni(leaf);
    IntPtr nameBuffer = IntPtr.Zero;
    GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var name = new UnicodeString { Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)(leaf.Length * 2 + 2)), Buffer = text };
      nameBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      Marshal.StructureToPtr(name, nameBuffer, false);
      var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.DangerousGetHandle(), Name = nameBuffer, Attributes = 0x40u, Descriptor = pinned.AddrOfPinnedObject() };
      SafeFileHandle handle;
      IoStatus io;
      // FILE_CREATE is exclusive and returns the new directory's handle with the final descriptor already in force.
      int status = NtCreateFile(out handle, 0x100000u | Traverse | ReadAttributes, ref attributes, out io, IntPtr.Zero, Directory, 3u, 2u, 0x00200021u, IntPtr.Zero, 0u);
      if (status < 0) {
        if (handle != null) handle.Dispose();
        throw new Win32Exception((int)RtlNtStatusToDosError(status), "Private helper directory creation refused (" + status.ToString("X8") + ")");
      }
      return handle;
    } finally {
      pinned.Free();
      if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
      Marshal.FreeHGlobal(text);
      GC.KeepAlive(parent);
    }
  }
  public static void Record(string journal, string claim, SafeFileHandle handle) {
    var bytes = Encoding.ASCII.GetBytes(claim + " " + Identity(handle, Info(handle)) + "\\n");
    using (var stream = new FileStream(journal, FileMode.Open, FileAccess.Write, FileShare.Read)) {
      stream.Seek(0, SeekOrigin.End);
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
  }
  private static void Rename(SafeFileHandle handle, string destination) {
    var name = Encoding.Unicode.GetBytes(destination);
    int lengthOffset = 2 * IntPtr.Size;
    int nameOffset = lengthOffset + 4;
    // ReplaceIfExists and RootDirectory are both zero. The destination is an absolute DOS path.
    var buffer = new byte[Math.Max(nameOffset + name.Length, 3 * IntPtr.Size)];
    BitConverter.GetBytes(name.Length).CopyTo(buffer, lengthOffset);
    name.CopyTo(buffer, nameOffset);
    if (!SetFileInformationByHandle(handle, 3, buffer, (uint)buffer.Length)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  private static void Remove(SafeFileHandle handle) {
    // FileDispositionInfo removes this handle's entry and refuses a nonempty directory.
    if (!SetFileInformationByHandle(handle, 4, new byte[] { 1 }, 1u)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  private static void RemoveFile(string path, string identity) {
    if (String.IsNullOrEmpty(identity)) return;
    using (var handle = Open(path, DeleteAccess, false, identity)) if (handle != null) Remove(handle);
  }
  public static void DisposeCopy(string path, string retired, string outerId, string binId, string imageId, string markerId) {
    using (HoldParents(path)) {
      using (var outer = Open(path, Traverse | DeleteAccess, true, outerId)) {
        if (outer == null) return;
        string bin = Path.Combine(path, "bin");
        if (String.IsNullOrEmpty(binId)) {
          // Refuse a collision without moving the unclaimed child with its parent.
          using (var unclaimed = Open(bin, 0u, true, null)) {
            if (unclaimed != null) throw new InvalidOperationException("Private helper bin is unclaimed");
          }
        }
        if (!String.IsNullOrEmpty(retired)) { Rename(outer, retired); bin = Path.Combine(retired, "bin"); }
        if (!String.IsNullOrEmpty(binId)) {
          using (var child = Open(bin, Traverse | DeleteAccess, true, binId)) {
            if (child != null) {
              RemoveFile(Path.Combine(bin, "srt-win.exe"), imageId);
              RemoveFile(Path.Combine(bin, "owner.json"), markerId);
              Remove(child);
            }
          }
        }
        Remove(outer);
      }
    }
  }
}`;
