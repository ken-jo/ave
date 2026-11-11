import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../../scripts/lib/windows-powershell-env.mjs";
import { assertDisposableSmokeGate, assertUninstallDialogReport, observeUninstallDialogs } from "../../../scripts/smoke-windows-nsis-installer.mjs";

if (process.platform !== "win32") throw new Error("Uninstall dialog preflight requires Windows");
assertDisposableSmokeGate();
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..", "..", "..");
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const prefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

if (!process.argv.includes("--owner")) {
  for (const scenario of ["confirmation-only", "unexpected-data"]) {
    const result = spawnSync(powershell, [...prefix,
      "-File", join(root, "scripts", "lib", "run-windows-installer-owner.ps1"),
      "-NodeExecutable", process.execPath,
      "-ArgumentsBase64", Buffer.from(JSON.stringify([script, "--owner", scenario])).toString("base64"),
      "-WorkingDirectory", root, "-DeadlineUnixMs", String(Date.now() + 60_000),
    ], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `dialog preflight failed for ${scenario}`);
  }
} else {
  const scenario = process.argv[3];
  assert.ok(["confirmation-only", "unexpected-data"].includes(scenario));
  const directory = mkdtempSync(join(tmpdir(), "ave-dialog-probe-"));
  try {
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, "preserve throughout uninstall\n");
    const probe = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class UninstallConsentProbe {
  [DllImport("user32.dll", EntryPoint="MessageBoxW", CharSet=CharSet.Unicode)] static extern int MessageBox(IntPtr owner, string text, string title, uint flags);
  public static int Show() {
    if (MessageBox(IntPtr.Zero,"Remove Ave?","Ave uninstall probe",0x00050001)!=1) return 99;
    ${scenario === "unexpected-data" ? 'return MessageBox(IntPtr.Zero,"Ave 사용자 데이터를 함께 삭제하시겠습니까?","Ave uninstall probe",0x00050123);' : "return 0;"}
  }
}
'@
exit ([UninstallConsentProbe]::Show())`;
    const resultPath = join(directory, "result.json");
    const observed = await observeUninstallDialogs({
      executable: powershell, ownerSid: process.env.AVE_WINDOWS_SMOKE_OWNER_SID, timeoutMs: 30_000,
      launch(deadlineUnixMs) {
        return new Promise((resolveLaunch, reject) => {
          const child = spawn(powershell, [...prefix,
            "-File", join(root, "scripts", "lib", "run-limited-windows-process.ps1"),
            "-FilePath", powershell,
            "-ArgumentsBase64", Buffer.from(JSON.stringify([...prefix, "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")])).toString("base64"),
            "-WorkingDirectory", directory, "-ReportPath", resultPath,
            "-DeadlineUnixMs", String(deadlineUnixMs),
          ], { env: windowsPowerShellEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          let output = "";
          child.stdout.on("data", chunk => { output += chunk; });
          child.stderr.on("data", chunk => { output += chunk; });
          child.once("error", reject);
          child.once("close", code => resolveLaunch({ code, output }));
        });
      },
    });
    const expectedExit = scenario === "unexpected-data" ? 7 : 0;
    assert.equal(observed.result.code, expectedExit, observed.result.output);
    const owner = JSON.parse(readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(owner.administrator, false);
    assert.equal(owner.mediumIntegrity, true);
    assert.equal(owner.userSid, process.env.AVE_WINDOWS_SMOKE_OWNER_SID);
    assert.equal(owner.exitCode, expectedExit);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve throughout uninstall\n");
    if (scenario === "unexpected-data") {
      assert.throws(() => assertUninstallDialogReport(observed.report, { gui: true }), /unexpected data prompt/);
    } else { assertUninstallDialogReport(observed.report, { gui: true }); }
    process.stdout.write(`[windows-dialog-probe] ${scenario}: ${JSON.stringify(observed.report)}\n`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
