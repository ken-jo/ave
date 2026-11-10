import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../../scripts/lib/windows-powershell-env.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..", "..", "..");
if (process.platform !== "win32") throw new Error("Owner token preflight requires Windows");
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const prefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
if (!process.argv.includes("--owner")) {
  for (const expectedExit of [0, 7]) {
    const argumentsToRun = expectedExit === 0 ? [script, "--owner"] : ["-e", "process.exit(7)"];
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
  for (const expectedExit of [0, 7]) {
    const directory = mkdtempSync(join(tmpdir(), "ave-owner-flow-"));
    const report = join(directory, "report.json");
    try {
      const launcher = join(directory, "limited.ps1");
      copyFileSync(join(root, "scripts", "lib", "run-limited-windows-process.ps1"), launcher);
      const result = spawnSync(powershell, [...prefix,
        "-File", launcher,
        "-FilePath", powershell,
        "-ArgumentsBase64", Buffer.from(JSON.stringify([...prefix, "-Command", `exit ${expectedExit}`])).toString("base64"),
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
      process.stdout.write(`[windows-owner-flow] verified actual linked-token exit ${expectedExit}: ${JSON.stringify(observed)}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
