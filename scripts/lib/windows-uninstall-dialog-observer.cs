using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public sealed class UninstallDialogObservation {
  public int processId;
  public string kind;
  public string text;
  public bool visible;
  public bool topmost;
  public int defaultButton;
  public bool dataIntactBeforeAnswer;
  public string answer;
}

public sealed class UninstallDialogReport {
  public List<UninstallDialogObservation> dialogs = new List<UninstallDialogObservation>();
  public string error;
}

public static class UninstallDialogObserver {
  private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  private delegate void WinEvent(IntPtr hook, uint eventId, IntPtr window, int objectId, int childId, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] private struct Message {
    public IntPtr window; public uint id; public UIntPtr wParam; public IntPtr lParam;
    public uint time; public Point point; public uint privateData;
  }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLong64(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr window, int index);
  [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll", SetLastError = true)] private static extern int GetMessage(out Message message, IntPtr window, uint first, uint last);
  [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint flags);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] private static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint milliseconds, IntPtr callback);
  [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr window, UIntPtr id);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

  private const uint FINISHED_MESSAGE = 0x8001;
  private static readonly string DATA_QUESTION = "Ave 사용자 데이터를 함께 삭제하시겠습니까?";
  private static readonly HashSet<string> handled = new HashSet<string>();
  private static UninstallDialogReport report;
  private static string executable, ownerSid, answer;
  private static string[] sentinelPaths, sentinelContents;
  private static uint observerThread;
  private static int observerSession;
  private static WinEvent callback;

  private static string Text(IntPtr window) {
    var text = new StringBuilder(32768);
    GetWindowText(window, text, text.Capacity);
    return text.ToString();
  }

  private static bool Owned(uint processId) {
    using (var process = Process.GetProcessById((int)processId)) {
      if (process.SessionId != observerSession) return false;
    }
    IntPtr processHandle = OpenProcess(0x1000, false, processId);
    if (processHandle == IntPtr.Zero) return false;
    try {
      var path = new StringBuilder(32768);
      int size = path.Capacity;
      if (!QueryFullProcessImageName(processHandle, 0, path, ref size)
        || !String.Equals(Path.GetFullPath(path.ToString()), executable, StringComparison.OrdinalIgnoreCase)) return false;
      IntPtr token;
      if (!OpenProcessToken(processHandle, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        using (var identity = new WindowsIdentity(token)) { return identity.User.Value == ownerSid; }
      } finally { CloseHandle(token); }
    } finally { CloseHandle(processHandle); }
  }

  private static void RequireSentinels() {
    for (int index = 0; index < sentinelPaths.Length; index++) {
      byte[] expected = Convert.FromBase64String(sentinelContents[index]);
      byte[] actual = File.ReadAllBytes(sentinelPaths[index]);
      if (actual.Length != expected.Length) throw new InvalidOperationException("User data changed before the consent answer");
      for (int offset = 0; offset < actual.Length; offset++) {
        if (actual[offset] != expected[offset]) throw new InvalidOperationException("User data changed before the consent answer");
      }
    }
  }

  private static void Inspect(IntPtr window) {
    if (window == IntPtr.Zero) return;
    var className = new StringBuilder(256);
    GetClassName(window, className, className.Capacity);
    if (className.ToString() != "#32770" || !IsWindowVisible(window)) return;
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    if (!Owned(processId)) return;
    var text = new StringBuilder();
    EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
      var childClass = new StringBuilder(256);
      GetClassName(child, childClass, childClass.Capacity);
      if (childClass.ToString() == "Static") text.AppendLine(Text(child));
      return true;
    }, IntPtr.Zero);
    bool data = text.ToString().Contains(DATA_QUESTION);
    bool confirmation = !data && text.ToString().Contains("Ave")
      && GetDlgItem(window, 1) != IntPtr.Zero && GetDlgItem(window, 2) != IntPtr.Zero;
    if (!data && !confirmation) return;
    if (data && (GetDlgItem(window, 6) == IntPtr.Zero || GetDlgItem(window, 7) == IntPtr.Zero)) return;
    string kind = data ? "data" : "confirmation";
    string key = processId + ":" + window.ToInt64() + ":" + kind;
    if (!handled.Add(key)) return;
    long style = IntPtr.Size == 8 ? GetWindowLong64(window, -20).ToInt64() : GetWindowLong32(window, -20);
    var observation = new UninstallDialogObservation {
      processId = (int)processId, kind = kind, text = text.ToString(), visible = true,
      topmost = (style & 8) != 0, defaultButton = (int)(SendMessage(window, 0x0400, IntPtr.Zero, IntPtr.Zero).ToInt64() & 0xffff),
      answer = data ? answer : "OK"
    };
    report.dialogs.Add(observation);
    if (data) { RequireSentinels(); observation.dataIntactBeforeAnswer = true; }
    if (data && answer == "close") {
      SendMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
    } else {
      int button = data ? (answer == "yes" ? 6 : 7) : 1;
      SendMessage(GetDlgItem(window, button), 0x00f5, IntPtr.Zero, IntPtr.Zero);
    }
  }

  private static void OnEvent(IntPtr hook, uint eventId, IntPtr window, int objectId, int childId, uint thread, uint time) {
    try { Inspect(GetAncestor(window, 2)); }
    catch (ArgumentException) { /* A window can close before its event is delivered. */ }
    catch (Exception error) {
      report.error = error.ToString();
      PostThreadMessage(observerThread, FINISHED_MESSAGE, UIntPtr.Zero, IntPtr.Zero);
    }
  }

  public static UninstallDialogReport Run(string targetExecutable, string expectedSid, string reply, string[] paths, string[] contents, string finishedPath, long deadlineUnixMs) {
    if (reply != "yes" && reply != "no" && reply != "close") throw new ArgumentException("Invalid dialog answer");
    executable = Path.GetFullPath(targetExecutable);
    ownerSid = expectedSid; answer = reply; sentinelPaths = paths; sentinelContents = contents;
    if (paths.Length != contents.Length) throw new ArgumentException("Invalid sentinel manifest");
    report = new UninstallDialogReport(); handled.Clear();
    observerThread = GetCurrentThreadId(); observerSession = Process.GetCurrentProcess().SessionId;
    callback = OnEvent;
    Message message;
    PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
    IntPtr dialogHook = SetWinEventHook(0x0010, 0x0010, IntPtr.Zero, callback, 0, 0, 2);
    IntPtr objectHook = SetWinEventHook(0x8002, 0x800c, IntPtr.Zero, callback, 0, 0, 2);
    if (dialogHook == IntPtr.Zero || objectHook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Dialog observation could not start");
    long remaining = deadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    if (remaining <= 0 || remaining > Int32.MaxValue) throw new InvalidOperationException("Dialog observation deadline expired");
    UIntPtr timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, (uint)remaining, IntPtr.Zero);
    if (timer == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Dialog deadline could not be registered");
    using (var finished = new FileSystemWatcher(Path.GetDirectoryName(finishedPath), Path.GetFileName(finishedPath))) {
      FileSystemEventHandler signal = delegate(object sender, FileSystemEventArgs args) {
        PostThreadMessage(observerThread, FINISHED_MESSAGE, UIntPtr.Zero, IntPtr.Zero);
      };
      finished.Created += signal;
      finished.EnableRaisingEvents = true;
      try {
        Console.WriteLine("AVE_UNINSTALL_DIALOG_OBSERVER_READY");
        Console.Out.Flush();
        EnumWindows(delegate(IntPtr window, IntPtr unused) { OnEvent(IntPtr.Zero, 0, window, 0, 0, 0, 0); return true; }, IntPtr.Zero);
        while (true) {
          int received = GetMessage(out message, IntPtr.Zero, 0, 0);
          if (received < 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Dialog message loop failed");
          if (received == 0 || message.id == FINISHED_MESSAGE) break;
          if (message.id == 0x0113 && message.wParam == timer) { report.error = "Dialog observation exceeded the uninstall deadline"; break; }
          TranslateMessage(ref message); DispatchMessage(ref message);
        }
      } finally {
        KillTimer(IntPtr.Zero, timer);
        UnhookWinEvent(dialogHook); UnhookWinEvent(objectHook);
      }
    }
    return report;
  }
}
