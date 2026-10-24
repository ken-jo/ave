import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "./lib/windows-powershell-env.mjs";

const result = spawnSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
  fileURLToPath(new URL("./build-windows-job.ps1", import.meta.url)),
  ...process.argv.slice(2),
], { stdio: "inherit", env: windowsPowerShellEnv() });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
