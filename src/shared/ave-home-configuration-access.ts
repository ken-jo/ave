import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import { createSerialQueue, type SerialQueue } from "../lib/with-file-lock.js";
import { aveHome, aveHomeConfigurationDirectory, AveHomeConfigurationUntrustedError, configurationHomeForFile, isAveHomeConfigurationRefused, verifyAveHomeConfiguration, win32SystemBinary } from "./ave-home.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "./windows-home-boundary.js";
import { windowsPowerShellEnv } from "./windows-powershell-env.js";

const OWNERSHIP_KEY = Symbol.for("ave.configuration-ownership");
interface ConfigurationOwnership {
  owner: { hasSingleInstanceLock(): boolean } | undefined;
  busyHomes: Map<string, number>;
  queues: Map<string, SerialQueue>;
}
const processAuthority = globalThis as typeof globalThis & { [OWNERSHIP_KEY]?: ConfigurationOwnership };
const ownership = processAuthority[OWNERSHIP_KEY] ??= { owner: undefined, busyHomes: new Map(), queues: new Map() };
const busyHomes = ownership.busyHomes;

export class AveHomeConfigurationNotOwnerError extends Error {
  constructor() {
    super("Configuration writes require the primary interactive instance");
    this.name = "AveHomeConfigurationNotOwnerError";
  }
}

export function setAveHomeConfigurationOwner(owner: { hasSingleInstanceLock(): boolean } | undefined): void {
  ownership.owner = owner;
}

export function isAveHomeConfigurationOwner(): boolean {
  return ownership.owner?.hasSingleInstanceLock() === true;
}

function assertOwner(): void {
  if (!isAveHomeConfigurationOwner()) throw new AveHomeConfigurationNotOwnerError();
}

function homeKey(home: string): string {
  return process.platform === "win32" ? resolve(home).toLowerCase() : resolve(home);
}

export function resolveConfigurationFile(path: string): string {
  const home = configurationHomeForFile(path);
  return home === undefined ? resolve(path) : join(aveHomeConfigurationDirectory(home), basename(path));
}

function writeHome(path: string): string {
  return configurationHomeForFile(path) ?? dirname(resolve(path));
}

function verifyWriteBoundary(home: string): void {
  if (isAveHomeConfigurationRefused(home)) return;
  verifyAveHomeConfiguration(home, "boundary");
  if (homeKey(home) === homeKey(aveHome())) {
    try { lstatSync(join(home, "config")); }
    catch { throw new AveHomeConfigurationUntrustedError(home, "Configuration directory is missing"); }
  }
}

export function withAveHomeConfigurationMigration<T>(home: string, callback: () => T): T {
  assertOwner();
  if (busyHomes.has(homeKey(home))) throw new AveHomeConfigurationUntrustedError(home, "Configuration mutation is in progress");
  return callback();
}

export function tryWithAveHomeConfigurationWrite(path: string, callback: (path: string) => void): boolean {
  if (!isAveHomeConfigurationOwner()) return false;
  const home = writeHome(path);
  if (busyHomes.has(homeKey(home))) return false;
  verifyWriteBoundary(home);
  callback(resolveConfigurationFile(path));
  return true;
}

export async function withAveHomeConfigurationWrite<T>(path: string, callback: (path: string) => Promise<T>): Promise<T> {
  assertOwner();
  const home = writeHome(path), key = homeKey(home);
  busyHomes.set(key, (busyHomes.get(key) ?? 0) + 1);
  try {
    let queue = ownership.queues.get(key);
    if (queue === undefined) { queue = createSerialQueue(); ownership.queues.set(key, queue); }
    return await queue(async () => {
      assertOwner();
      verifyWriteBoundary(home);
      return callback(resolveConfigurationFile(path));
    });
  } finally {
    const remaining = busyHomes.get(key)! - 1;
    if (remaining === 0) busyHomes.delete(key); else busyHomes.set(key, remaining);
  }
}

function windowsRead(path: string, identity: { dev: bigint; ino: bigint }): Buffer | undefined {
  const home = configurationHomeForFile(path);
  const protectedDirectory = home !== undefined && homeKey(dirname(path)) === homeKey(join(home, "config"));
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $request=ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated=([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    $bytes=[HomeDirectoryDacl]::ReadConfigurationFile($request.directory,$request.leaf,$request.home,$request.protectedDirectory,$request.device,$request.inode,$identity.User,$elevated);
    if ($null -eq $bytes) { 'null' } else { ConvertTo-Json -InputObject ([Convert]::ToBase64String($bytes)) -Compress }`;
  const raw = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ directory: dirname(path), leaf: basename(path), home: home !== undefined && !isAveHomeConfigurationRefused(home) ? home : null,
      protectedDirectory, device: identity.dev.toString(), inode: identity.ino.toString() }) }) });
  const value: unknown = JSON.parse(raw);
  if (value === null) return undefined;
  if (typeof value !== "string") throw new Error("Configuration read returned invalid bytes");
  return Buffer.from(value, "base64");
}

function readConfigurationDescriptor(descriptor: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let filled = 0;
  while (filled < bytes.length) {
    const count = readSync(descriptor, bytes, filled, bytes.length - filled, filled);
    if (count === 0) break;
    filled += count;
  }
  return bytes.subarray(0, filled);
}

function readOpenedFile(path: string): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Configuration is not a regular file");
    if (before.size > 4n * 1024n * 1024n) throw new Error("Configuration file exceeds the size limit");
    if (process.platform === "win32") return windowsRead(path, before);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new Error("Configuration identity changed before open");
    const bytes = readConfigurationDescriptor(descriptor, Number(opened.size));
    const verified = readConfigurationDescriptor(descriptor, Number(opened.size));
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, lstatSync(path, { bigint: true })) || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || bytes.byteLength !== Number(opened.size)
      || !bytes.equals(verified)) throw new Error("Configuration identity changed during read");
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function readAveHomeConfigurationFile(path: string): Buffer | undefined {
  const home = configurationHomeForFile(path);
  let observed = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = resolveConfigurationFile(path);
      try { lstatSync(target); observed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const bytes = readOpenedFile(target);
      if (bytes !== undefined) return bytes;
    }
    if (observed || (home !== undefined && aveHomeConfigurationDirectory(home) !== resolve(home))) {
      throw new Error("Configuration file disappeared or is missing after migration");
    }
    if (home !== undefined) {
      try {
        lstatSync(join(home, "config", ".ave-config-sources.json"));
        throw new Error("Configuration migration state exists without the requested file");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const candidate of [join(home, basename(path)), join(home, "config", basename(path))]) {
        try { lstatSync(candidate); throw new Error("Uncommitted configuration file is present"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof AveHomeConfigurationUntrustedError) throw error;
    throw new AveHomeConfigurationUntrustedError(path, (error as Error).message);
  }
}
