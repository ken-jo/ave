# Balance the disposable profile load with its original token and hive handle.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class DisposableUserProfile : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low; public int high; }
  [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint count; public Luid luid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProfileInfo {
    public int size, flags;
    public string userName, profilePath, defaultPath, serverName, policyPath;
    public IntPtr profile;
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges privileges, uint length, IntPtr previous, IntPtr returned);
  [DllImport("advapi32.dll", EntryPoint = "LogonUserW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("userenv.dll", EntryPoint = "LoadUserProfileW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LoadUserProfile(IntPtr token, ref ProfileInfo profile);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool UnloadUserProfile(IntPtr token, IntPtr profile);
  IntPtr token, profile;
  static void Check(bool success, string operation) {
    if (!success) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, operation + " (" + error + "): " + new Win32Exception(error).Message);
    }
  }
  static void EnablePrivilege(string name) {
    IntPtr current = IntPtr.Zero;
    try {
      Check(OpenProcessToken(GetCurrentProcess(), 0x0028, out current), "Open profile-loader token");
      Luid luid; Check(LookupPrivilegeValue(null, name, out luid), "Look up " + name);
      var privileges = new TokenPrivileges { count = 1, luid = luid, attributes = 2 };
      bool adjusted = AdjustTokenPrivileges(current, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero);
      Check(adjusted && Marshal.GetLastWin32Error() == 0, "Enable " + name);
    } finally { if (current != IntPtr.Zero) CloseHandle(current); }
  }
  public DisposableUserProfile(string user, string domain, string password) {
    EnablePrivilege("SeBackupPrivilege");
    EnablePrivilege("SeRestorePrivilege");
    Check(LogonUser(user, domain, password, 2, 0, out token), "Log on disposable profile owner");
    try {
      var info = new ProfileInfo { size = Marshal.SizeOf(typeof(ProfileInfo)), flags = 1, userName = user };
      Check(LoadUserProfile(token, ref info), "Load disposable owner profile");
      profile = info.profile;
    } catch { CloseHandle(token); token = IntPtr.Zero; throw; }
  }
  public void Dispose() {
    try {
      if (profile != IntPtr.Zero) { Check(UnloadUserProfile(token, profile), "Unload disposable owner profile"); profile = IntPtr.Zero; }
    } finally { if (token != IntPtr.Zero) { CloseHandle(token); token = IntPtr.Zero; } }
  }
}
'@
