// Isolate every job path from the account profile. Native Windows fixtures also
// need the system volume's aliases and trusted volume-root ownership.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv, windowsPowerShellPath } from "../../scripts/lib/windows-powershell-env.mjs";
import { assertNoJobRootWriters, diagnoseJobRoot } from "./job-root-diagnostic.mjs";
import { containedStepManifest, JOB_RECEIPTS } from "./run-in-job.mjs";

function systemVolume(systemRoot) {
  const root = typeof systemRoot === "string" ? win32.parse(systemRoot).root : "";
  if (!/^[a-z]:\\$/i.test(root)) throw new Error("Job isolation requires a local system volume");
  return root;
}

function runJobRootCommand(command, args, options) {
  const executable = command === "powershell.exe" ? windowsPowerShellPath()
    : win32.join(process.env.SystemRoot, "System32", command);
  return execFileSync(executable, args, options);
}

export function hardenWindowsJobRoot(root, run = runJobRootCommand) {
  const options = { encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 10_000 };
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

function createOwnedJobRoot(prefix, create, readIdentity, publish) {
  const root = create(prefix);
  try {
    publish({ AVE_CI_JOB_ROOT: root, AVE_CI_JOB_ROOT_IDENTITY: "unknown" });
  } catch (cause) {
    throw new Error(`Cannot publish cleanup for the new job root. Directory left at ${root}`, { cause });
  }
  try {
    const identity = readIdentity(root);
    if (!isJobRootIdentity(identity)) throw new Error("Invalid directory identity");
    return { root, identity };
  } catch (cause) {
    throw new Error(`Cannot verify ownership of the new job root. Directory left at ${root}`, { cause });
  }
}

/**
 * Setup rollback runs before any contained step, so it skips the receipt ledger
 * and otherwise shares the cleanup quarantine: the process scan refuses on a
 * match or an unfinished scan, then the root is renamed to a tombstone,
 * re-verified and removed. The cleanup residual applies: an undetected
 * DCOM-launched data-file holder can only cause a reported rollback failure,
 * never a deletion outside the root.
 */
export async function isolationAssignments(
  { platform, runnerTemp, systemRoot }, create = mkdtempSync, harden = hardenWindowsJobRoot,
  readIdentity = readJobRootIdentity, publish = () => {}, run, diagnostic,
) {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  const { root, identity } = windows
    ? createOwnedJobRoot(paths.join(systemVolume(systemRoot), "ave-ci-"), create, readIdentity, publish)
    : { root: runnerTemp };
  try {
    if (windows) harden(root);
    const home = paths.join(root, "home");
    const temp = paths.join(root, "tmp");
    // Leave room for confined-process socket names and their terminators.
    if (platform === "darwin" && Buffer.byteLength(temp) + 32 > 103) {
      throw new Error("Job temp directory is too long for a Unix socket path");
    }
    const values = {
      HOME: home, USERPROFILE: home, AVE_HOME: paths.join(home, ".ave"),
      TMPDIR: temp, TEMP: temp, TMP: temp,
      ...(windows ? {
        LOCALAPPDATA: paths.join(home, "local-app-data"), APPDATA: paths.join(home, "app-data"),
        AVE_TEST_TMP_ROOT: paths.join(home, ".ave-test-tmp"),
        AVE_CI_JOB_ROOT: root, AVE_CI_JOB_ROOT_IDENTITY: identity,
      } : {}),
    };
    publish(values);
    return values;
  } catch (error) {
    if (windows) {
      try {
        await removeOwnedRoot(root, identity, { readIdentity, rename: renameSync, remove: rmSync, run, diagnostic });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Job isolation setup and rollback failed");
      }
    }
    throw error;
  }
}

export function validateJobHomeRoot(root, systemRoot) {
  const volume = systemVolume(systemRoot);
  if (typeof root !== "string" || !win32.isAbsolute(root) || win32.dirname(root).toLowerCase() !== volume.toLowerCase()
    || !/^ave-ci-[a-z0-9]{6}$/i.test(win32.basename(root)) || win32.normalize(root) !== root) {
    throw new Error("Cleanup requires an isolated job root directly on the system volume");
  }
  return root;
}

function readJobRootIdentity(root) {
  const entry = lstatSync(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.ino === 0n
    || realpathSync.native(root).toLowerCase() !== root.toLowerCase()) {
    throw new Error("Cleanup requires an unchanged isolated job root");
  }
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}

function isJobRootIdentity(identity) {
  return typeof identity === "string" && /^\d+:\d+:\d+$/u.test(identity);
}

function assertOwnedRoot(root, identity, readIdentity) {
  if (!isJobRootIdentity(identity)) {
    throw new Error(`Cannot clean up job root ${root}: directory identity is unknown or invalid`);
  }
  let currentIdentity;
  try {
    currentIdentity = readIdentity(root);
  } catch (cause) {
    throw new Error(`Cleanup requires an unchanged isolated job root. Could not read directory identity at ${root}`, { cause });
  }
  if (currentIdentity !== identity) {
    throw new Error(`Cleanup requires an unchanged isolated job root. Directory identity changed at ${root}`);
  }
}

function readJobReceipts(directory) {
  return readdirSync(directory, { withFileTypes: true }).map(entry => ({
    name: entry.name, text: entry.isFile() ? readFileSync(win32.join(directory, entry.name), "utf8") : undefined,
  }));
}

function receiptProblem(step, identity, text) {
  if (text === `${step.id}\n${identity}\n0`) return undefined;
  const [id, owner] = typeof text === "string" ? text.split("\n") : [];
  if (id !== step.id) return "names another step";
  if (owner !== identity) return "names another job root";
  return "has no zero verdict";
}

async function assertContainedSteps(root, identity, readReceipts, manifest) {
  let receipts;
  try {
    receipts = readReceipts(win32.join(root, JOB_RECEIPTS));
  } catch (cause) {
    throw new Error(`Cannot clean up job root ${root}: the job receipt ledger is unreadable`, { cause });
  }
  let steps;
  try {
    steps = manifest ?? await containedStepManifest();
  } catch (cause) {
    throw new Error(`Cannot clean up job root ${root}: the contained-step manifest is unavailable`, { cause });
  }
  const problems = [];
  for (const { name, text } of receipts) {
    const step = steps.find(entry => entry.receipt === name);
    const problem = step ? receiptProblem(step, identity, text) : "is not a contained-step receipt";
    if (problem) problems.push(`${JSON.stringify(name)} ${problem}`);
  }
  for (const { receipt } of steps) {
    if (!receipts.some(({ name }) => name === receipt)) problems.push(`${JSON.stringify(receipt)} is missing`);
  }
  if (problems.length > 0) {
    throw new Error([`Cannot clean up job root ${root}: ${problems.length} contained-step receipts are missing or unproven`,
      ...problems.slice(0, 20).map(problem => `receipt ${problem}`)].join("\n"));
  }
}

// Quarantine: verify identity, rename to a fresh tombstone, verify it, then remove only the tombstone.
async function removeOwnedRoot(root, identity, { readIdentity, rename, remove, readReceipts, manifest, run, diagnostic }) {
  assertOwnedRoot(root, identity, readIdentity);
  if (readReceipts) await assertContainedSteps(root, identity, readReceipts, manifest);
  const warnings = await assertNoJobRootWriters(root, run);
  assertOwnedRoot(root, identity, readIdentity);
  const tombstone = `${root}.cleanup-${randomUUID()}`;
  try {
    rename(root, tombstone);
  } catch (cause) {
    await reportCleanupFailure(root, cause, { run, diagnostic });
    throw new Error(`Cannot clean up job root ${root}: rename to ${tombstone} failed (${cause?.message ?? cause}). Directory left in place.`, { cause });
  }
  try {
    assertOwnedRoot(tombstone, identity, readIdentity);
  } catch (cause) {
    throw new Error(`Cleanup requires an unchanged isolated job root. Directory left at ${tombstone}`, { cause });
  }
  try {
    await diagnoseCleanupFailure(tombstone, () => remove(tombstone, { recursive: true, force: true }), { run, diagnostic });
  } catch (cause) {
    throw new Error(`Cannot clean up job root ${root}: removing ${tombstone} failed (${cause?.message ?? cause}). Remaining entries left at ${tombstone}.`, { cause });
  }
  writeCleanupDiagnostics(warnings, diagnostic);
}

function writeCleanupLog(lines) {
  // A synchronous stderr sink can stall the writer without holding up cleanup.
  const writer = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stderr)"],
    { stdio: ["pipe", "ignore", 2], windowsHide: true });
  const deadline = setTimeout(() => {
    writer.stdin.destroy();
    writer.unref();
  }, 250).unref();
  writer.on("error", () => {});
  writer.stdin.on("error", () => {});
  writer.once("close", () => clearTimeout(deadline));
  writer.stdin.end(lines.join("\n") + "\n");
}

function writeCleanupDiagnostics(lines, diagnostic) {
  if (lines.length === 0) return;
  try {
    if (diagnostic) lines.forEach(line => diagnostic(line));
    else writeCleanupLog(lines);
  } catch { /* Diagnostic output must not change the cleanup result. */ }
}

/**
 * The receipt ledger must hold exactly one receipt per contained-step manifest
 * entry, each naming its step and this job root and proving its closed
 * kill-on-close job empty; anything else refuses. Receipts target accidental
 * lingering writers; deliberate forgery by a test running as the same CI
 * account is out of scope. A receipt attests only to the step's descendants.
 * The sandbox helper's runner and payload start through the logon service in
 * jobs of their own, so the process scan is the authoritative check for
 * service-created processes: the runner's image is the helper copy in TEMP
 * under the root, and the payload matches by cwd or argument. One pass over
 * every process (image, command line, cwd) refuses on a match or an unfinished
 * scan and lists unreadable values. The verified root is renamed to
 * <root>.cleanup-<uuid>, re-verified and removed; a rename or removal failure
 * refuses with its error.
 * Residual: a DCOM-launched process that holds only data files under the root
 * with delete sharing, and has no image, cwd or argument reference there, is
 * not detected; nor is a sandbox payload that outlives its runner while its
 * image and arguments are outside the root and its cwd is outside or
 * unreadable. Their only consequence is a reported cleanup failure, never a
 * deletion outside the root.
 */
export async function cleanupWindowsJobRoot(root, {
  systemRoot = process.env.SystemRoot, identity = process.env.AVE_CI_JOB_ROOT_IDENTITY,
  readIdentity = readJobRootIdentity, rename = renameSync, remove = rmSync, readReceipts = readJobReceipts, manifest,
  run, diagnostic,
} = {}) {
  validateJobHomeRoot(root, systemRoot);
  await removeOwnedRoot(root, identity, { readIdentity, rename, remove, readReceipts, manifest, run, diagnostic });
}

export async function diagnoseCleanupFailure(root, remove, options) {
  try {
    remove();
  } catch (error) {
    await reportCleanupFailure(root, error, options);
    throw error;
  }
}

async function reportCleanupFailure(root, error, { run, diagnostic } = {}) {
  const lines = [];
  try {
    lines.push(`Job root cleanup failed: code=${JSON.stringify(error.code)} syscall=${JSON.stringify(error.syscall)} path=${JSON.stringify(error.path)}`);
    await diagnoseJobRoot(root, line => lines.push(line), run);
  } catch { lines.push("Cleanup diagnostic failed or timed out"); }
  setImmediate(() => writeCleanupDiagnostics(lines, diagnostic));
}
async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanupWindowsJobRoot(process.env.AVE_CI_JOB_ROOT);
    return;
  }
  const { RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv, SystemRoot: systemRoot } = process.env;
  if (!runnerTemp || !githubEnv) throw new Error("RUNNER_TEMP and GITHUB_ENV must be set");
  const values = await isolationAssignments({ platform: process.platform, runnerTemp, systemRoot },
    mkdtempSync, hardenWindowsJobRoot, readJobRootIdentity, assignments => {
      const receipts = assignments.HOME && assignments.AVE_CI_JOB_ROOT && win32.join(assignments.AVE_CI_JOB_ROOT, JOB_RECEIPTS);
      for (const path of [assignments.HOME, assignments.TEMP, assignments.LOCALAPPDATA, assignments.APPDATA, receipts]) {
        if (path) mkdirSync(path, { recursive: true });
      }
      appendFileSync(githubEnv, Object.entries(assignments).map(([name, value]) => `${name}=${value}\n`).join(""));
    });
  for (const [name, value] of Object.entries(values)) console.log(`${name} = ${value}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
