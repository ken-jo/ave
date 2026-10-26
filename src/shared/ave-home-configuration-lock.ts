import { execFile, execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileIdentityKey, sameFileIdentity } from "../lib/file-identity.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { aveHome, aveHomeConfigurationDirectory, AveHomeConfigurationUntrustedError, isAveHomeConfigurationRefused, verifyAveHomeConfiguration, win32SystemBinary } from "./ave-home.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";

const LOCK_NAME = ".ave-config.lock";
const WAIT_MS = 5_000;
const UNREADABLE_STALE_MS = 30_000;
let ownStartTime: string | undefined;
const heldHomes = new Set<string>();

function homeKey(home: string): string {
  return process.platform === "win32" ? resolve(home).toLowerCase() : resolve(home);
}

class AveHomeConfigurationLockTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`Timed out waiting for configuration lock: ${path}`);
    this.name = "AveHomeConfigurationLockTimeoutError";
  }
}

function processStartTime(pid: number): string {
  if (process.platform === "win32") {
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`,
    ], { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv(process.env) }).trim();
  }
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  }
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
}

function runProcess(command: string, args: string[], env = process.env, input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { encoding: "utf8", windowsHide: true, env }, (error, stdout) => {
      if (error) reject(error); else accept(stdout.trim());
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}

async function processStartTimeAsync(pid: number): Promise<string> {
  if (process.platform === "win32") {
    return runProcess(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`,
    ], windowsPowerShellEnv(process.env));
  }
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  }
  return runProcess("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
}

const WINDOWS_LOCK_REMOVAL_SCRIPT = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $request=ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated=([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    $homeHandle=$null; $directory=$null; $handle=$null; $inputStream=$null;
    try {
      $homeHandle=[HomeDirectoryDacl]::OpenHome($request.home,$identity.User,$false,$true);
      if ($null -eq $homeHandle -or -not [HomeDirectoryDacl]::RootSafe([HomeDirectoryDacl]::Read($homeHandle),$identity.User,$elevated,0x1200a9)) { throw 'Configuration home protection is unverified' }
      $directory=[HomeDirectoryDacl]::OpenRelative($homeHandle,'config',$identity.User,1,$true,$true,$true,$true,7);
      if ($null -eq $directory -or -not [HomeDirectoryDacl]::OwnerOnly([HomeDirectoryDacl]::Read($directory),$identity.User,$elevated)) { throw 'Configuration boundary protection is unverified' }
      $handle=[HomeDirectoryDacl]::OpenRelative($directory,'${LOCK_NAME}',$identity.User,1,$false,$true,$false,$false,0);
      if ($null -eq $handle) { return }
      $inputStream=[System.IO.FileStream]::new($handle,[System.IO.FileAccess]::Read);
      $reader=[System.IO.StreamReader]::new($inputStream);
      $raw=if ($inputStream.Length -le 4096) { $reader.ReadToEnd() } else { '' }; $stale=$false;
      $recordValid=$true;
      try {
        $holder=ConvertFrom-Json $raw;
        if ($holder.pid -isnot [int] -or $holder.pid -le 0 -or $holder.startTime -isnot [string] -or -not $holder.startTime) { throw 'Unreadable lock' }
      } catch { $recordValid=$false }
      if ($recordValid) {
        $owner=Get-Process -Id $holder.pid -ErrorAction SilentlyContinue;
        $stale=$null -eq $owner;
        if ($null -ne $owner) {
          try { $stale=$owner.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $holder.startTime } catch { $stale=$false }
        }
      } else {
        $stale=([DateTime]::UtcNow-[System.IO.File]::GetLastWriteTimeUtc([System.IO.Path]::Combine($request.home,'config','${LOCK_NAME}'))).TotalMilliseconds -ge ${UNREADABLE_STALE_MS};
      }
      if ($stale) { [void][HomeDirectoryDacl]::RemoveConfigurationLock($handle,$identity.User) }
    } catch { } finally {
      if ($null -ne $inputStream) { $inputStream.Dispose() }
      if ($null -ne $handle) { $handle.Dispose() }
      if ($null -ne $directory) { $directory.Dispose() }
      if ($null -ne $homeHandle) { $homeHandle.Dispose() }
    }`;

const WINDOWS_LOCK_REMOVAL_ARGS = ["-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64")];

interface ObservedLock {
  identity: BigIntStats;
  key: string;
  record?: { pid: number; startTime: string };
}

function observeLock(path: string): ObservedLock | undefined {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || !sameFileIdentity(before, identity) || !sameFileIdentity(identity, lstatSync(path, { bigint: true }))) return undefined;
    const raw = identity.size <= 4096n ? readFileSync(descriptor) : Buffer.alloc(0);
    const observed: ObservedLock = { identity, key: `${fileIdentityKey(identity)}:${raw.toString("base64")}` };
    try {
      const record = JSON.parse(raw.toString("utf8")) as { pid: number; startTime: string };
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.startTime !== "string" || !record.startTime) throw new Error("Unreadable lock");
      observed.record = record;
    } catch { /* Interrupted records require the age bound. */ }
    return observed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function preliminaryStaleness(observed: ObservedLock): boolean | undefined {
  if (!observed.record) return Date.now() - Number(observed.identity.mtimeMs) >= UNREADABLE_STALE_MS;
  try { process.kill(observed.record.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return undefined;
}

function removeStaleLock(home: string, path: string, observed: ObservedLock): void {
  if (process.platform === "win32") {
    execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), WINDOWS_LOCK_REMOVAL_ARGS, {
      input: WINDOWS_LOCK_REMOVAL_SCRIPT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: windowsPowerShellEnv({ ...process.env, AVE_DACL_REQUEST: JSON.stringify({ home }) }),
    });
  } else if (sameFileIdentity(observed.identity, lstatSync(path, { bigint: true }))) unlinkSync(path);
}

// Liveness stays a cheap per-retry check; only the start-time query and the removal run once per observation.
function breakStaleLockSync(home: string, path: string, verdicts: Set<string>): void {
  const observed = observeLock(path);
  if (!observed) return;
  let stale = preliminaryStaleness(observed);
  if (stale === undefined) {
    if (verdicts.has(`live:${observed.key}`)) return;
    try { stale = processStartTime(observed.record!.pid) !== observed.record!.startTime; }
    catch { stale = false; }
    if (!stale) verdicts.add(`live:${observed.key}`);
  }
  if (!stale || verdicts.has(`removed:${observed.key}`)) return;
  verdicts.add(`removed:${observed.key}`);
  removeStaleLock(home, path, observed);
}

async function breakStaleLock(home: string, path: string, verdicts: Set<string>): Promise<void> {
  const observed = observeLock(path);
  if (!observed) return;
  let stale = preliminaryStaleness(observed);
  if (stale === undefined) {
    if (verdicts.has(`live:${observed.key}`)) return;
    try { stale = await processStartTimeAsync(observed.record!.pid) !== observed.record!.startTime; }
    catch { stale = false; }
    if (!stale) verdicts.add(`live:${observed.key}`);
  }
  if (!stale || verdicts.has(`removed:${observed.key}`)) return;
  verdicts.add(`removed:${observed.key}`);
  if (process.platform === "win32") {
    await runProcess(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), WINDOWS_LOCK_REMOVAL_ARGS,
      windowsPowerShellEnv({ ...process.env, AVE_DACL_REQUEST: JSON.stringify({ home }) }), WINDOWS_LOCK_REMOVAL_SCRIPT);
  } else if (sameFileIdentity(observed.identity, lstatSync(path, { bigint: true }))) unlinkSync(path);
}

function tryAcquire(home: string): (() => void) | undefined {
  const path = join(home, "config", LOCK_NAME);
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined;
  }
  const identity = fstatSync(descriptor, { bigint: true });
  const release = () => {
    if (!sameFileIdentity(identity, lstatSync(path, { bigint: true }))) throw new Error(`Configuration lock changed: ${path}`);
    unlinkSync(path);
  };
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startTime: ownStartTime }));
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    release();
    throw error;
  }
  closeSync(descriptor);
  return release;
}

function usesProtectedLock(home: string): boolean {
  if (isAveHomeConfigurationRefused(home)) return false;
  verifyAveHomeConfiguration(home, "boundary");
  try { return lstatSync(join(home, "config")).isDirectory(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (homeKey(home) === homeKey(aveHome())) throw new AveHomeConfigurationUntrustedError(join(home, "config"), "Configuration directory is missing");
      return false;
    }
    throw error;
  }
}

export function withAveHomeConfigurationLock<T>(home: string, callback: () => T): T {
  if (heldHomes.has(homeKey(home))) throw new AveHomeConfigurationLockTimeoutError(join(home, "config", LOCK_NAME));
  if (!usesProtectedLock(home)) return callback();
  ownStartTime ??= processStartTime(process.pid);
  const verdicts = new Set<string>();
  const deadline = Date.now() + WAIT_MS;
  let release: (() => void) | undefined;
  while (!(release = tryAcquire(home))) {
    breakStaleLockSync(home, join(home, "config", LOCK_NAME), verdicts);
    if (Date.now() >= deadline) throw new AveHomeConfigurationLockTimeoutError(join(home, "config", LOCK_NAME));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  heldHomes.add(homeKey(home));
  try { verifyAveHomeConfiguration(home, "boundary"); return callback(); }
  finally { heldHomes.delete(homeKey(home)); release(); }
}

export function tryWithAveHomeConfigurationLock(home: string, callback: () => void): { acquired: boolean } {
  if (isAveHomeConfigurationRefused(home)) { callback(); return { acquired: true }; }
  if (heldHomes.has(homeKey(home))) return { acquired: false };
  const path = join(home, "config", LOCK_NAME);
  try { lstatSync(path); return { acquired: false }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!usesProtectedLock(home)) { callback(); return { acquired: true }; }
  ownStartTime ??= processStartTime(process.pid);
  const release = tryAcquire(home);
  if (!release) return { acquired: false };
  heldHomes.add(homeKey(home));
  try { verifyAveHomeConfiguration(home, "boundary"); callback(); return { acquired: true }; }
  finally { heldHomes.delete(homeKey(home)); release(); }
}

export function configurationHomeForPath(path: string): string {
  const parent = dirname(resolve(path));
  return basename(parent) === "config" ? dirname(parent) : parent;
}

export function resolveConfigurationFile(path: string): string {
  if (!["settings.json", "policy.json", "ave-secrets.json"].includes(basename(path))) return resolve(path);
  return join(aveHomeConfigurationDirectory(configurationHomeForPath(path)), basename(path));
}

export async function withAveHomeConfigurationWrite<T>(path: string, callback: (resolvedPath: string) => Promise<T>): Promise<T> {
  const home = configurationHomeForPath(path);
  return withInProcessFileQueue(join(homeKey(home), "config", LOCK_NAME), async () => {
    if (!usesProtectedLock(home)) return callback(resolveConfigurationFile(path));
    ownStartTime ??= processStartTime(process.pid);
    const verdicts = new Set<string>();
    const deadline = Date.now() + WAIT_MS;
    let release: (() => void) | undefined;
    while (!(release = tryAcquire(home))) {
      await breakStaleLock(home, join(home, "config", LOCK_NAME), verdicts);
      if (Date.now() >= deadline) throw new AveHomeConfigurationLockTimeoutError(join(home, "config", LOCK_NAME));
      await delay(25);
    }
    try {
      heldHomes.add(homeKey(home));
      verifyAveHomeConfiguration(home, "boundary");
      return await callback(resolveConfigurationFile(path));
    } finally { heldHomes.delete(homeKey(home)); release(); }
  });
}
