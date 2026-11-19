// Isolate every job path from the account profile. Native Windows fixtures also
// need the system volume's aliases and trusted volume-root ownership.
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

function systemVolume(systemRoot) {
  const root = typeof systemRoot === "string" ? win32.parse(systemRoot).root : "";
  if (!/^[a-z]:\\$/i.test(root)) throw new Error("Job isolation requires a local system volume");
  return root;
}

function runJobRootCommand(command, args, options) {
  const executable = command === "powershell.exe" ? "WindowsPowerShell\\v1.0\\powershell.exe" : command;
  return execFileSync(win32.join(process.env.SystemRoot, "System32", executable), args, options);
}

export function hardenWindowsJobRoot(root, run = runJobRootCommand) {
  const options = { encoding: "utf8", windowsHide: true, stdio: "pipe" };
  const identity = run("whoami.exe", ["/user", "/fo", "csv", "/nh"], options);
  const sids = identity.trim().split(",").map(field => field.trim().replace(/^"|"$/g, ""))
    .filter(field => /^S-/.test(field));
  if (sids.length !== 1 || !/^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(sids[0])) {
    throw new Error("Job isolation requires a valid current account SID");
  }
  const principals = [sids[0], "S-1-5-18", "S-1-5-32-544"];
  // Reset explicit grants too: removing inheritance alone leaves foreign explicit rules.
  run("icacls.exe", [root, "/reset"], options);
  run("icacls.exe", [root, "/inheritance:r", "/grant:r",
    ...principals.map(sid => `*${sid}:(OI)(CI)F`)], options);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$acl = Get-Acl -LiteralPath '${root.replaceAll("'", "''")}'`,
    "@{ protected = $acl.AreAccessRulesProtected; rules = @($acl.Access | ForEach-Object {",
    "@{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;",
    "rights = [int]$_.FileSystemRights; type = [int]$_.AccessControlType; inherited = $_.IsInherited;",
    "inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }",
    "}) } | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  const acl = JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], options));
  if (acl.protected !== true || !Array.isArray(acl.rules) || acl.rules.length !== principals.length
    || new Set(acl.rules.map(rule => rule.sid)).size !== principals.length
    || acl.rules.some(rule => !principals.includes(rule.sid) || rule.rights !== 0x1f01ff
      || rule.type !== 0 || rule.inherited !== false || rule.inheritance !== 3 || rule.propagation !== 0)) {
    throw new Error("Job isolation requires a protected DACL with only the current account, system and administrators");
  }
}

export function isolationAssignments({ platform, runnerTemp, systemRoot }, create = mkdtempSync, harden = hardenWindowsJobRoot) {
  const paths = platform === "win32" ? win32 : posix;
  const root = platform === "win32" ? create(paths.join(systemVolume(systemRoot), "ave-ci-")) : runnerTemp;
  if (platform === "win32") {
    try { harden(root); } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
  const home = paths.join(root, "home");
  const temp = paths.join(root, "tmp");
  // Leave room for confined-process socket names and their terminators.
  if (platform === "darwin" && Buffer.byteLength(temp) + 32 > 103) {
    throw new Error("Job temp directory is too long for a Unix socket path");
  }
  return {
    HOME: home, USERPROFILE: home, AVE_HOME: paths.join(home, ".ave"),
    TMPDIR: temp, TEMP: temp, TMP: temp,
    ...(platform === "win32" ? {
      LOCALAPPDATA: paths.join(home, "local-app-data"), APPDATA: paths.join(home, "app-data"),
      AVE_TEST_TMP_ROOT: paths.join(home, ".ave-test-tmp"), AVE_CI_JOB_ROOT: root,
    } : {}),
  };
}

export function validateJobHomeRoot(root, systemRoot) {
  const volume = systemVolume(systemRoot);
  if (typeof root !== "string" || win32.dirname(root).toLowerCase() !== volume.toLowerCase()
    || !/^ave-ci-[a-z0-9]{6}$/i.test(win32.basename(root)) || win32.normalize(root) !== root) {
    throw new Error("Cleanup requires an isolated job root directly on the system volume");
  }
  return root;
}

function listJobRootEntries(root, readDirectory, stat, diagnostic) {
  const directories = [root];
  let count = 0;
  for (let index = 0; index < directories.length && count < 50; index++) {
    const directory = directories[index];
    // Check the current route again rather than trusting queued directory entries.
    let current = root;
    for (const part of ["", ...relative(root, directory).split(sep).filter(Boolean)]) {
      current = join(current, part);
      const facts = stat(current);
      if (facts.isSymbolicLink() || !facts.isDirectory()) {
        throw new Error("Cleanup entry route changed");
      }
    }
    for (const entry of readDirectory(directory, { withFileTypes: true })) {
      if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/:]/.test(entry.name)) {
        throw new Error("Invalid cleanup entry name");
      }
      const path = join(directory, entry.name);
      const facts = stat(path);
      // These fs interfaces identify links and junctions alike as symbolic links.
      const link = facts.isSymbolicLink();
      const type = link ? "symlink/junction" : facts.isDirectory() ? "dir" : "file";
      diagnostic(`entry ${JSON.stringify(relative(root, path))} type=${type} read-only=${(facts.mode & 0o200) === 0}`);
      if (!link && facts.isDirectory()) directories.push(path);
      if (++count === 50) {
        diagnostic("Entry listing limited to 50 entries");
        return;
      }
    }
  }
}

function listJobRootProcesses(root, run, diagnostic) {
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

export function cleanupWindowsJobRoot(root, {
  remove = rmSync, readDirectory = readdirSync, stat = lstatSync,
  run = runJobRootCommand, diagnostic = line => console.error(line),
} = {}) {
  try {
    remove(root, { recursive: true, force: true });
  } catch (error) {
    try {
      diagnostic(`Job root cleanup failed: code=${JSON.stringify(error.code)} syscall=${JSON.stringify(error.syscall)}`);
      try { listJobRootEntries(root, readDirectory, stat, diagnostic); } catch {
        diagnostic("Cleanup entry listing failed");
      }
      try { listJobRootProcesses(root, run, diagnostic); } catch {
        diagnostic("Cleanup process query failed");
      }
    } catch { /* Reporting must never replace the original removal error. */ }
    throw error;
  }
}

function main() {
  if (process.argv.includes("--cleanup")) {
    const root = validateJobHomeRoot(process.env.AVE_CI_JOB_ROOT, process.env.SystemRoot);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
      || realpathSync.native(root).toLowerCase() !== root.toLowerCase()) {
      throw new Error("Cleanup requires an unchanged isolated job root");
    }
    cleanupWindowsJobRoot(root);
    return;
  }
  const { RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv, SystemRoot: systemRoot } = process.env;
  if (!runnerTemp || !githubEnv) throw new Error("RUNNER_TEMP and GITHUB_ENV must be set");
  const values = isolationAssignments({ platform: process.platform, runnerTemp, systemRoot });
  for (const path of [values.HOME, values.TEMP, values.LOCALAPPDATA, values.APPDATA]) {
    if (path !== undefined) mkdirSync(path, { recursive: true });
  }
  appendFileSync(githubEnv, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
  for (const [name, value] of Object.entries(values)) console.log(`${name} = ${value}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
