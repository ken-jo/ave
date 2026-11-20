// Isolate every job path from the account profile. Native Windows fixtures also
// need the system volume's aliases and trusted volume-root ownership.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";
import { diagnoseJobRoot } from "./job-root-diagnostic.mjs";

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
    Buffer.from(script, "utf16le").toString("base64")], { ...options, env: windowsPowerShellEnv() }));
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

function writeCleanupLog(lines) {
  // A synchronous stderr sink can stall the writer without holding up cleanup.
  const writer = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stderr)"],
    { stdio: ["pipe", "ignore", 2], windowsHide: true });
  const deadline = setTimeout(() => {
    writer.stdin.destroy();
    try { writer.kill(); } catch {}
    writer.unref();
  }, 250).unref();
  writer.on("error", () => {});
  writer.stdin.on("error", () => {});
  writer.once("close", () => clearTimeout(deadline));
  writer.stdin.end(lines.join("\n") + "\n");
}

export async function cleanupWindowsJobRoot(root, { remove = rmSync, run, diagnostic } = {}) {
  try {
    remove(root, { recursive: true, force: true });
  } catch (error) {
    const lines = [];
    try {
      lines.push(`Job root cleanup failed: code=${JSON.stringify(error.code)} syscall=${JSON.stringify(error.syscall)} path=${JSON.stringify(error.path)}`);
      await diagnoseJobRoot(root, line => lines.push(line), run);
    } catch { lines.push("Cleanup diagnostic failed or timed out"); }
    setImmediate(() => {
      try {
        if (diagnostic) lines.forEach(line => diagnostic(line));
        else writeCleanupLog(lines);
      } catch { /* The removal rejection has already settled. */ }
    });
    throw error;
  }
}
async function main() {
  if (process.argv.includes("--cleanup")) {
    const root = validateJobHomeRoot(process.env.AVE_CI_JOB_ROOT, process.env.SystemRoot);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
      || realpathSync.native(root).toLowerCase() !== root.toLowerCase()) {
      throw new Error("Cleanup requires an unchanged isolated job root");
    }
    try { await cleanupWindowsJobRoot(root); }
    catch { process.exitCode = 1; }
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
