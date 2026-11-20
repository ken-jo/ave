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
  private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int InheritHandle; }
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, byte[] info, uint length);
  private const uint Traverse = 0x20, ReadAttributes = 0x80, DeleteAccess = 0x10000;
  private const uint Directory = 0x10, ReparsePoint = 0x400;
  private static FileInformation Info(SafeFileHandle handle) {
    FileInformation info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return info;
  }
  private static string Identity(FileInformation info) {
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
          || (expected != null && Identity(info) != expected)) throw new InvalidOperationException("Private helper entry changed");
      return handle;
    } catch { handle.Dispose(); throw; }
  }
  public sealed class HeldParents : IDisposable {
    private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
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
  public static SafeFileHandle Create(string path, byte[] descriptor) {
    GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), InheritHandle = 0 };
      if (!CreateDirectoryW(ExtendedPath(path), ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { pinned.Free(); }
    var handle = Open(path, Traverse, true, null);
    if (handle == null) throw new DirectoryNotFoundException();
    return handle;
  }
  public static void Record(string journal, string claim, SafeFileHandle handle) {
    var bytes = Encoding.ASCII.GetBytes(claim + " " + Identity(Info(handle)) + "\\n");
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
          try { File.GetAttributes(bin); throw new InvalidOperationException("Private helper bin is unclaimed"); }
          catch (FileNotFoundException) {} catch (DirectoryNotFoundException) {}
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
