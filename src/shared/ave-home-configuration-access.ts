import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileIdentityKey, sameFileIdentity } from "../lib/file-identity.js";
import { createSerialQueue, type SerialQueue } from "../lib/with-file-lock.js";
import { withDirectoryMutationObserver } from "../lib/directory-mutation-observer.js";
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
    super("Ave is running; close it or use the app");
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
  if (process.platform === "win32") {
    try { windowsReadBoundary(resolveConfigurationFile(join(home, "settings.json"))); }
    catch (error) {
      if (error instanceof AveHomeConfigurationUntrustedError) throw error;
      throw new AveHomeConfigurationUntrustedError(home, (error as Error).message);
    }
  } else verifyAveHomeConfiguration(home, "boundary");
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
  let active = true;
  try {
    withDirectoryMutationObserver((directory) => active ? observeOwnerDirectoryMutation(directory) : () => {},
      () => callback(resolveConfigurationFile(path)));
  } finally { active = false; }
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
      let active = true;
      try {
        return await withDirectoryMutationObserver((directory) => active ? observeOwnerDirectoryMutation(directory) : () => {},
          () => callback(resolveConfigurationFile(path)));
      } finally { active = false; }
    });
  } finally {
    const remaining = busyHomes.get(key)! - 1;
    if (remaining === 0) busyHomes.delete(key); else busyHomes.set(key, remaining);
  }
}

interface WindowsReadBoundary {
  key: string;
  identity: string;
  root: string;
  directory: string;
  protectedDirectory: boolean;
  ancestors: string[];
}

const windowsReadCertificates = new Map<string, WindowsReadBoundary>();

function assertWindowsNonReparseEntry(path: string): void {
  if (dirname(path) === path) return;
  // Directory enumeration exposes every reparse tag, including tags lstat treats as ordinary entries.
  const name = basename(path).toLowerCase();
  const entry = readdirSync(dirname(path), { withFileTypes: true }).find((candidate) => candidate.name.toLowerCase() === name);
  if (entry === undefined || entry.isSymbolicLink()) throw new Error("Configuration path is missing or a reparse point");
}

function windowsDirectoryIdentity(path: string, daclRelied = true): string {
  assertWindowsNonReparseEntry(path);
  const identity = lstatSync(path, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino === 0n || identity.dev === 0n || identity.ctimeNs === 0n) {
    throw new Error("Configuration directory identity is unverified");
  }
  return `${fileIdentityKey(identity)}${daclRelied ? `:${identity.ctimeNs}` : ""}`;
}

function windowsBoundaryIdentity(boundary: WindowsReadBoundary): string {
  const root = windowsDirectoryIdentity(boundary.root);
  const directories = boundary.protectedDirectory ? `${root}|${windowsDirectoryIdentity(boundary.directory)}` : root;
  return [directories, ...boundary.ancestors.map((ancestor) => windowsDirectoryIdentity(ancestor, false))].join("|");
}

function observeOwnerDirectoryMutation(directory: string): () => void {
  if (process.platform !== "win32") return () => {};
  assertOwner();
  const key = homeKey(directory);
  const affected = [...windowsReadCertificates.values()].filter((boundary) =>
    homeKey(boundary.root) === key || (boundary.protectedDirectory && homeKey(boundary.directory) === key));
  const snapshots = affected.map((boundary) => {
    const before = windowsBoundaryIdentity(boundary);
    if (before !== boundary.identity) {
      windowsReadCertificates.delete(boundary.key);
      throw new AveHomeConfigurationUntrustedError(directory, "Configuration boundary changed before owner mutation");
    }
    return { boundary, before: before.split("|") };
  });
  return () => {
    const changedIdentity = snapshots.length === 0 ? undefined : windowsDirectoryIdentity(directory);
    for (const { boundary, before } of snapshots) {
      const after = windowsBoundaryIdentity(boundary).split("|");
      const changed = homeKey(boundary.root) === key ? 0 : 1;
      if (after[changed] !== changedIdentity || after.some((identity, index) => index === changed
        ? identity.slice(0, identity.lastIndexOf(":")) !== before[index]!.slice(0, before[index]!.lastIndexOf(":"))
        : identity !== before[index])) {
        windowsReadCertificates.delete(boundary.key);
        throw new AveHomeConfigurationUntrustedError(directory, "Configuration boundary changed during owner mutation");
      }
      boundary.identity = after.join("|");
    }
  };
}

function windowsReadBoundary(path: string): WindowsReadBoundary {
  const home = configurationHomeForFile(path);
  const protectedDirectory = home !== undefined && homeKey(dirname(path)) === homeKey(join(home, "config"));
  const directory = dirname(path);
  const root = home ?? directory;
  const verifyHome = home !== undefined && !isAveHomeConfigurationRefused(home);
  const key = `${homeKey(root)}|${homeKey(directory)}|${verifyHome}|${protectedDirectory}`;
  const ancestors: string[] = [];
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    ancestors.unshift(ancestor);
    if (dirname(ancestor) === ancestor) break;
  }
  const boundary: WindowsReadBoundary = { key, identity: "", root, directory, protectedDirectory, ancestors };
  boundary.identity = windowsBoundaryIdentity(boundary);
  const cached = windowsReadCertificates.get(key);
  if (cached?.identity === boundary.identity) return boundary;
  if (cached !== undefined && cached.identity.split("|").slice(protectedDirectory ? 2 : 1).join("|")
    !== boundary.identity.split("|").slice(protectedDirectory ? 2 : 1).join("|")) {
    throw new Error("Configuration path ancestry changed");
  }
  windowsReadCertificates.delete(key);
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition @'
${WINDOWS_HOME_BOUNDARY_SOURCE}
'@;
    $request=ConvertFrom-Json $env:AVE_DACL_REQUEST;
    $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
    $elevated=([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
    $certificate=[HomeDirectoryDacl]::ConfigurationReadBoundary($request.directory,$request.home,$request.protectedDirectory,$identity.User,$elevated,$request.ancestors);
    ConvertTo-Json -InputObject $certificate -Compress`;
  const raw = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64"),
  ], { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env,
    AVE_DACL_REQUEST: JSON.stringify({ directory, home: verifyHome ? home : null, protectedDirectory, ancestors }) }) });
  const value: unknown = JSON.parse(raw);
  if (value !== boundary.identity || windowsBoundaryIdentity(boundary) !== boundary.identity) {
    throw new Error("Configuration boundary changed during verification");
  }
  windowsReadCertificates.set(key, boundary);
  return boundary;
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
    if (process.platform === "win32") assertWindowsNonReparseEntry(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Configuration is not a regular file");
    if (before.size > 4n * 1024n * 1024n) throw new Error("Configuration file exceeds the size limit");
    const boundary = process.platform === "win32" ? windowsReadBoundary(path) : undefined;
    descriptor = openSync(path, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new Error("Configuration identity changed before open");
    if (boundary !== undefined && (opened.size > 4n * 1024n * 1024n || opened.ctimeNs !== before.ctimeNs)) {
      throw new Error("Configuration file changed before open");
    }
    const bytes = readConfigurationDescriptor(descriptor, Number(opened.size));
    const verified = readConfigurationDescriptor(descriptor, Number(opened.size));
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, lstatSync(path, { bigint: true })) || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || bytes.byteLength !== Number(opened.size)
       || !bytes.equals(verified)) throw new Error("Configuration identity changed during read");
    if (boundary !== undefined) {
      assertWindowsNonReparseEntry(path);
      const current = lstatSync(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.ctimeNs !== opened.ctimeNs
        || windowsBoundaryIdentity(boundary) !== boundary.identity) {
        windowsReadCertificates.delete(boundary.key);
        throw new Error("Configuration boundary changed during read");
      }
    }
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
