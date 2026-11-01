using System;
using System.IO;
using System.Collections.Generic;
using System.IO.Pipes;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32;

// All named fixtures are unique per run; no existing application object is opened.
public class KernelObjects {
    static readonly List<IntPtr> Connections = new List<IntPtr>();
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
        public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)] struct Qos { public uint Length; public int Level; public byte Tracking, EffectiveOnly; }
    [StructLayout(LayoutKind.Sequential)] struct PortAttributes {
        public uint Flags; public Qos SecurityQos;
        public UIntPtr MaxMessageLength, MemoryBandwidth, MaxPoolUsage, MaxSectionSize, MaxViewSize, MaxTotalSectionSize;
        public uint DupObjectTypes, Reserved;
    }
    [DllImport("ntdll.dll")] static extern int NtAlpcCreatePort(out IntPtr port, ref ObjectAttributes attributes, ref PortAttributes portAttributes);
    [DllImport("ntdll.dll")] static extern int NtAlpcConnectPort(out IntPtr port, ref UnicodeString name, IntPtr attributes,
        ref PortAttributes portAttributes, uint flags, IntPtr sid, IntPtr message, ref UIntPtr size, IntPtr outgoing, IntPtr incoming, ref long timeout);
    [DllImport("ntdll.dll")] static extern int NtAlpcSendWaitReceivePort(IntPtr port, uint flags, IntPtr send, IntPtr sendAttributes,
        IntPtr receive, ref UIntPtr size, IntPtr receiveAttributes, ref long timeout);
    [DllImport("ntdll.dll")] static extern int NtAlpcAcceptConnectPort(out IntPtr port, IntPtr listener, uint flags,
        IntPtr attributes, ref PortAttributes portAttributes, IntPtr context, IntPtr request, IntPtr messageAttributes, byte accept);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static PortAttributes Attributes() {
        return new PortAttributes { SecurityQos = new Qos { Length = (uint)Marshal.SizeOf(typeof(Qos)), Level = 2 }, MaxMessageLength = (UIntPtr)512 };
    }
    static UnicodeString Name(string name) {
        return new UnicodeString { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)((name.Length + 1) * 2), Buffer = Marshal.StringToHGlobalUni(name) };
    }
    static string Status(int status) { return "0x" + unchecked((uint)status).ToString("X8"); }
    static string Escape(string value) { return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " "); }
    static string Attempt(Func<bool> operation) {
        try { return operation() ? "reachable" : "unreachable"; }
        catch (Exception error) { return "unknown:" + error.GetType().Name + ":" + error.HResult.ToString("X8"); }
    }
    static IntPtr CreatePort(string name, out int status) {
        UnicodeString text = Name(name); IntPtr textPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        try {
            Marshal.StructureToPtr(text, textPointer, false);
            ObjectAttributes attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), ObjectName = textPointer, Attributes = 0x40 };
            PortAttributes portAttributes = Attributes(); IntPtr port;
            status = NtAlpcCreatePort(out port, ref attributes, ref portAttributes); return port;
        } finally { Marshal.FreeHGlobal(text.Buffer); Marshal.FreeHGlobal(textPointer); }
    }
    static void ServePort(IntPtr port, long waitTicks) {
        IntPtr buffer = Marshal.AllocHGlobal(1024);
        try {
            while (true) {
                UIntPtr size = (UIntPtr)1024; long timeout = -waitTicks;
                int status = NtAlpcSendWaitReceivePort(port, 0, IntPtr.Zero, IntPtr.Zero, buffer, ref size, IntPtr.Zero, ref timeout);
                if (status != 0) continue;
                if ((Marshal.ReadInt16(buffer, 4) & 0xFF) != 10) continue;
                PortAttributes attributes = Attributes(); IntPtr connection;
                int accepted = NtAlpcAcceptConnectPort(out connection, port, 0, IntPtr.Zero, ref attributes, IntPtr.Zero, buffer, IntPtr.Zero, 1);
                if (accepted == 0) { lock (Connections) Connections.Add(connection); }
            }
        } catch { } finally { Marshal.FreeHGlobal(buffer); }
    }
    static string ConnectPort(string name, long waitTicks) {
        UnicodeString text = Name(name); IntPtr port = IntPtr.Zero;
        try {
            PortAttributes attributes = Attributes(); UIntPtr size = UIntPtr.Zero; long timeout = -waitTicks;
            int status = NtAlpcConnectPort(out port, ref text, IntPtr.Zero, ref attributes, 0, IntPtr.Zero, IntPtr.Zero,
                ref size, IntPtr.Zero, IntPtr.Zero, ref timeout);
            return status == 0 ? "reachable" : "unknown:" + Status(status);
        } finally { if (port != IntPtr.Zero) CloseHandle(port); Marshal.FreeHGlobal(text.Buffer); }
    }
    public static int Main(string[] args) {
        // Args originate from the host-created temp fixture descriptor, not a plugin.
        string mode = args[0], id = args[1]; int waitMs = Int32.Parse(args[2]);
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^ave-mxc-probe-[a-f0-9-]+$")) return 2;
        string pipeName = id, sectionName = "Local\\" + id, alpcName = "\\RPC Control\\" + id;
        if (mode == "serve") {
            using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            using (var section = MemoryMappedFile.CreateNew(sectionName, 4096)) {
                var pipeThread = new Thread(() => { try { while (true) { pipe.WaitForConnection(); pipe.Disconnect(); } } catch { } });
                pipeThread.IsBackground = true; pipeThread.Start();
                int status; IntPtr port = CreatePort(alpcName, out status);
                if (status == 0) { var thread = new Thread(() => ServePort(port, waitMs * 10000L)); thread.IsBackground = true; thread.Start(); }
                Console.WriteLine("{\"ready\":true,\"alpcCreate\":\"" + Status(status) + "\",\"userSid\":\"" + WindowsIdentity.GetCurrent().User.Value + "\"}");
                Console.Out.Flush();
                try { Console.ReadLine(); } finally { if (port != IntPtr.Zero) CloseHandle(port); lock (Connections) foreach (IntPtr connection in Connections) CloseHandle(connection); }
            }
        } else if (mode == "read") {
            string pipeResult = Attempt(() => { using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut)) { pipe.Connect(waitMs); return pipe.IsConnected; } });
            string sectionResult = Attempt(() => { using (var section = MemoryMappedFile.OpenExisting(sectionName, MemoryMappedFileRights.Read)) { return section != null; } });
            string registryResult = Attempt(() => { using (var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion", false)) { return key != null && key.GetValue("CurrentBuildNumber") != null; } });
            Console.WriteLine("{\"pipe\":\"" + Escape(pipeResult) + "\",\"section\":\"" + Escape(sectionResult)
                + "\",\"alpc\":\"" + ConnectPort(alpcName, waitMs * 10000L) + "\",\"registryRead\":\"" + Escape(registryResult)
                + "\",\"registryWrite\":\"unmeasured-read-only-probe\",\"userSid\":\"" + WindowsIdentity.GetCurrent().User.Value + "\"}");
        } else return 2;
        return 0;
    }
}
