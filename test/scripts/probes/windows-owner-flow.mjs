import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../../scripts/lib/windows-powershell-env.mjs";
import { assertDisposableSmokeGate } from "../../../scripts/smoke-windows-nsis-installer.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..", "..", "..");
if (process.platform !== "win32") throw new Error("Owner token preflight requires Windows");
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const prefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
if (!process.argv.includes("--owner")) {
  for (const expectedExit of [0, 7]) {
    const argumentsToRun = [script, "--owner", String(expectedExit)];
    const result = spawnSync(powershell, [...prefix,
      "-File", join(root, "scripts", "lib", "run-windows-installer-owner.ps1"),
      "-NodeExecutable", process.execPath,
      "-ArgumentsBase64", Buffer.from(JSON.stringify(argumentsToRun)).toString("base64"),
      "-WorkingDirectory", root,
      "-DeadlineUnixMs", String(Date.now() + 60_000),
    ], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    assert.equal(result.status, expectedExit, "owner-profile preflight exit propagation failed");
  }
} else {
  assertDisposableSmokeGate();
  const expectedExit = Number(process.argv[3]);
  assert.ok([0, 7].includes(expectedExit), "invalid owner probe exit");
  const probe = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.ComponentModel; using System.Runtime.InteropServices;
public static class DesktopWindowProbe {
  [DllImport("user32.dll", EntryPoint="CreateWindowExW", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindow(uint extended, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern bool DestroyWindow(IntPtr window);
  public static void Verify() {
    IntPtr window=CreateWindow(0,"STATIC","owner-probe",0x80000000,0,0,1,1,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(window==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(!DestroyWindow(window)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[DesktopWindowProbe]::Verify()
exit ${expectedExit}`;
  const directory = mkdtempSync(join(tmpdir(), "ave-owner-flow-"));
  const report = join(directory, "report.json");
  try {
    const launcher = join(directory, "limited.ps1");
    copyFileSync(join(root, "scripts", "lib", "run-limited-windows-process.ps1"), launcher);
    const result = spawnSync(powershell, [...prefix,
      "-File", launcher,
      "-FilePath", powershell,
      "-ArgumentsBase64", Buffer.from(JSON.stringify([...prefix, "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")])).toString("base64"),
      "-WorkingDirectory", tmpdir(),
      "-ReportPath", report,
      "-DeadlineUnixMs", String(Date.now() + 30_000),
    ], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedExit, result.stdout + result.stderr);
    const observed = JSON.parse(readFileSync(report, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(observed.administrator, false);
    assert.equal(observed.mediumIntegrity, true);
    assert.equal(observed.userSid, process.env.AVE_WINDOWS_SMOKE_OWNER_SID);
    assert.equal(observed.exitCode, expectedExit);
    process.stdout.write(`[windows-owner-flow] verified actual filtered-owner exit ${expectedExit}: ${JSON.stringify(observed)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exitCode = expectedExit;
}
