import { execFileSync } from "node:child_process";
import { basename, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

function runProcessQuery(command, args, options) {
  return execFileSync(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", command), args, options);
}

export function listJobRootProcesses(root, run, diagnostic) {
  const prefix = `${root.replace(/[\\/]+$/, "")}\\`.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "ConvertTo-Json -Compress -InputObject @(Get-Process | Where-Object {",
    `$_.Path -and $_.Path.StartsWith('${prefix}', [StringComparison]::OrdinalIgnoreCase)`,
    "} | Select-Object -First 20 | ForEach-Object {",
    "@{ pid = $_.Id; image = [IO.Path]::GetFileName($_.Path) }",
    "})",
  ].join("\n");
  const processes = JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 5000, maxBuffer: 64 * 1024,
    env: windowsPowerShellEnv(),
  }));
  if (!Array.isArray(processes)) throw new Error("Invalid cleanup process listing");
  for (const process of processes.slice(0, 20)) {
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || typeof process.image !== "string") {
      throw new Error("Invalid cleanup process details");
    }
    diagnostic(`process pid=${process.pid} image=${JSON.stringify(basename(win32.basename(process.image)).slice(0, 256))}`);
  }
}


export function diagnoseJobRoot(root, diagnostic = line => console.log(line), run = runProcessQuery) {
  try { listJobRootProcesses(root, run, diagnostic); } catch { diagnostic("Cleanup process query failed"); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) diagnoseJobRoot(process.argv[2]);
