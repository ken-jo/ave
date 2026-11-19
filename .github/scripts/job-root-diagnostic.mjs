import { execFileSync } from "node:child_process";
import { lstatSync, opendirSync } from "node:fs";
import { basename, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

function runProcessQuery(command, args, options) {
  return execFileSync(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", command), args, options);
}

export function listJobRootEntries(root, diagnostic, { openDirectory = opendirSync, stat = lstatSync } = {}) {
  const directory = openDirectory(root, { bufferSize: 1 });
  try {
    for (let count = 0; count < 50; count++) {
      const entry = directory.readSync();
      if (entry === null) return;
      if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/:]/.test(entry.name)) {
        throw new Error("Invalid cleanup entry name");
      }
      const facts = stat(join(root, entry.name));
      const type = facts.isSymbolicLink() ? "symlink/junction" : facts.isDirectory() ? "dir" : "file";
      diagnostic(`entry ${JSON.stringify(entry.name)} type=${type} read-only=${(facts.mode & 0o200) === 0}`);
    }
    diagnostic("Entry listing limited to 50 entries");
  } finally { directory.closeSync(); }
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
  try { listJobRootEntries(root, diagnostic); } catch { diagnostic("Cleanup entry listing failed"); }
  try { listJobRootProcesses(root, run, diagnostic); } catch { diagnostic("Cleanup process query failed"); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) diagnoseJobRoot(process.argv[2]);
