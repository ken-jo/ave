import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import { createSerialQueue, type SerialQueue } from "../lib/with-file-lock.js";
import { withDirectoryMutationObserver } from "../lib/directory-mutation-observer.js";
import { aveHome, aveHomeConfigurationDirectory, AveHomeConfigurationUntrustedError, configurationHomeForFile, isAveHomeConfigurationRefused, verifyAveHomeConfiguration } from "./ave-home.js";
import { isWindowsHomeRootSafe } from "./windows-home-boundary.js";
import { admitWindowsReparse, isOwnerOnlyDacl, pinWindowsPaths, readWindowsDacls, windowsObjectKey, windowsOwnerRules, type WindowsDaclFacts, type WindowsPathFacts } from "./windows-path-facts.js";
import { openWindowsConfigurationHandles, windowsConfigurationDirectoryEntries, type WindowsConfigurationHandles } from "./windows-configuration-handles.js";

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
    try { windowsReadBoundary(resolveConfigurationFile(join(home, "settings.json"))).handles?.close(); }
    catch (error) {
      if (error instanceof AveHomeConfigurationUntrustedError) throw error;
      throw new AveHomeConfigurationUntrustedError(home, (error as Error).message);
    }
  } else verifyAveHomeConfiguration(home, "boundary");
  if (homeKey(home) === homeKey(aveHome())) {
    if (!configurationEntryExists(join(home, "config"))) throw new AveHomeConfigurationUntrustedError(home, "Configuration directory is missing");
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
  cacheable: boolean;
  file: WindowsPathFacts;
  path: string;
  directories: readonly WindowsPathFacts[];
  handles?: WindowsConfigurationHandles;
}

const windowsReadCertificates = new Map<string, WindowsReadBoundary>();

function configurationEntryExists(path: string): boolean {
  if (process.platform === "win32") {
    const row = pinWindowsPaths([path])[0]!;
    if (!admitWindowsReparse(row, "evidence")) throw new Error("Configuration path is a link or is unverified");
    return row.exists === true;
  }
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function windowsBoundarySnapshot(boundary: Pick<WindowsReadBoundary, "protectedDirectory">, rows: readonly WindowsPathFacts[]): { identity: string; cacheable: boolean } {
  const root = rows[0]!, directory = rows[1]!;
  for (const row of [root, directory]) {
    if (!admitWindowsReparse(row, "evidence") || row.exists !== true || !row.directory) {
      throw new Error("Configuration directory identity is unverified");
    }
  }
  for (const component of [root, directory, ...root.ancestors]) {
    if (!component.directory || component.volumeSerialNumber === null || component.fileIndex === null
      || BigInt(component.volumeSerialNumber) === 0n || BigInt(component.fileIndex) === 0n) {
      throw new Error("Configuration directory identity is unverified");
    }
  }
  const directories = boundary.protectedDirectory ? [root, directory] : [root];
  return {
    identity: [...directories.map(row => `${windowsObjectKey(row)}:${row.changeTime}`), ...root.ancestors.map(windowsObjectKey)].join("|"),
    cacheable: directories.every(row => row.changeTime !== null && BigInt(row.changeTime) !== 0n),
  };
}

function windowsBoundaryIdentity(boundary: WindowsReadBoundary): string {
  return windowsBoundarySnapshot(boundary, pinWindowsPaths([boundary.root, boundary.directory])).identity;
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
    for (const { boundary, before } of snapshots) {
      const rows = pinWindowsPaths([boundary.root, boundary.directory, boundary.path]);
      const snapshot = windowsBoundarySnapshot(boundary, rows);
      const after = snapshot.identity.split("|");
      const changed = homeKey(boundary.root) === key ? 0 : 1;
      if (after.some((identity, index) => index === changed
        ? identity.slice(0, identity.lastIndexOf(":")) !== before[index]!.slice(0, before[index]!.lastIndexOf(":"))
        : identity !== before[index])) {
        windowsReadCertificates.delete(boundary.key);
        throw new AveHomeConfigurationUntrustedError(directory, "Configuration boundary changed during owner mutation");
      }
      boundary.identity = after.join("|");
      boundary.directories = rows.slice(0, 2);
      boundary.file = rows[2]!;
      if (!snapshot.cacheable) windowsReadCertificates.delete(boundary.key);
    }
  };
}

function windowsReadBoundary(path: string): WindowsReadBoundary {
  const home = configurationHomeForFile(path);
  const protectedDirectory = home !== undefined && homeKey(dirname(path)) === homeKey(join(home, "config"));
  const directory = dirname(path);
  const root = home ?? directory;
  const verifyHome = home !== undefined && !isAveHomeConfigurationRefused(home);
  const key = `${homeKey(root)}|${homeKey(directory)}|${verifyHome}|${protectedDirectory}|${homeKey(path)}`;
  const cached = windowsReadCertificates.get(key);
  if (cached !== undefined) {
    const handles = openWindowsConfigurationHandles([
      ...windowsConfigurationDirectoryEntries(root, cached.directories[0]!),
      ...(protectedDirectory ? windowsConfigurationDirectoryEntries(directory, cached.directories[1]!) : []),
      { path, facts: cached.file, changeTimeRequired: true },
    ]);
    if (handles !== undefined) return { ...cached, handles };
  }
  const paths = [root, directory, path];
  const rows = readWindowsDacls(paths);
  const snapshot = windowsBoundarySnapshot({ protectedDirectory }, rows);
  const boundary: WindowsReadBoundary = { key, ...snapshot, root, directory, protectedDirectory, path, directories: rows.slice(0, 2), file: rows[2]! };
  if (cached !== undefined && cached.identity.split("|").slice(protectedDirectory ? 2 : 1).join("|")
    !== boundary.identity.split("|").slice(protectedDirectory ? 2 : 1).join("|")) {
    throw new Error("Configuration path ancestry changed");
  }
  windowsReadCertificates.delete(key);
  const [rootFacts, directoryFacts] = rows as readonly WindowsDaclFacts[];
  if (verifyHome && !isWindowsHomeRootSafe(rootFacts!)) throw new Error("Configuration home protection is unverified");
  if (protectedDirectory && (!directoryFacts!.dacl?.protected || !isOwnerOnlyDacl({
    ownerSid: directoryFacts!.dacl.owner, elevated: directoryFacts!.elevated, rules: windowsOwnerRules(directoryFacts!.dacl),
  }, directoryFacts!.currentUserSid))) throw new Error("Configuration boundary protection is unverified");
  if (snapshot.identity !== boundary.identity || windowsBoundaryIdentity(boundary) !== boundary.identity) {
    throw new Error("Configuration boundary changed during verification");
  }
  boundary.file = rows[2]!;
  if (boundary.cacheable) windowsReadCertificates.set(key, boundary);
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
  let boundary: WindowsReadBoundary | undefined;
  try {
    boundary = process.platform === "win32" ? windowsReadBoundary(path) : undefined;
    const before = boundary === undefined ? lstatSync(path, { bigint: true }) : undefined;
    if (boundary !== undefined) {
      if (!admitWindowsReparse(boundary.file, "evidence")) throw new Error("Configuration is not a regular file");
      if (boundary.file.exists === false) return undefined;
      if (boundary.file.directory) throw new Error("Configuration is not a regular file");
    } else if (!before!.isFile()) throw new Error("Configuration is not a regular file");
    descriptor = boundary?.handles?.descriptors.at(-1)
      ?? openSync(path, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || (boundary === undefined ? !sameFileIdentity(before!, opened)
      : boundary.file.volumeSerialNumber === null || boundary.file.fileIndex === null
        || opened.dev !== BigInt(boundary.file.volumeSerialNumber) || opened.ino !== BigInt(boundary.file.fileIndex)
        || boundary.file.changeTime === null || opened.ctimeNs !== (BigInt(boundary.file.changeTime) - 116444736000000000n) * 100n)) {
      throw new Error("Configuration identity changed before open");
    }
    if (opened.size > 4n * 1024n * 1024n) throw new Error("Configuration file exceeds the size limit");
    const bytes = readConfigurationDescriptor(descriptor, Number(opened.size));
    const verified = readConfigurationDescriptor(descriptor, Number(opened.size));
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || (boundary === undefined && !sameFileIdentity(opened, lstatSync(path, { bigint: true }))) || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || bytes.byteLength !== Number(opened.size)
       || !bytes.equals(verified)) throw new Error("Configuration identity changed during read");
    if (boundary?.handles !== undefined) {
      if (!boundary.handles.matches()) {
        windowsReadCertificates.delete(boundary.key);
        throw new Error("Configuration boundary changed during read");
      }
    } else if (boundary !== undefined) {
      const rows = pinWindowsPaths([boundary.root, boundary.directory, path]);
      const current = rows[2]!;
      if (!admitWindowsReparse(current, "evidence") || current.exists !== true || current.directory
        || windowsObjectKey(current) !== windowsObjectKey(boundary.file) || current.changeTime !== boundary.file.changeTime
        || windowsBoundarySnapshot(boundary, rows).identity !== boundary.identity) {
        windowsReadCertificates.delete(boundary.key);
        throw new Error("Configuration boundary changed during read");
      }
    }
    return bytes;
  } catch (error) {
    if (boundary?.handles !== undefined) {
      windowsReadCertificates.delete(boundary.key);
      boundary.handles.close();
      boundary.handles = undefined;
      descriptor = undefined;
      return readOpenedFile(path);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (boundary?.handles !== undefined) boundary.handles.close();
    else if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readAveHomeConfigurationFile(path: string): Buffer | undefined {
  const home = configurationHomeForFile(path);
  let observed = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = resolveConfigurationFile(path);
      const hasCertificate = process.platform === "win32" && [...windowsReadCertificates.values()].some(boundary => homeKey(boundary.path) === homeKey(target));
      const present = hasCertificate || configurationEntryExists(target);
      if (present && !hasCertificate) observed = true;
      const bytes = present ? readOpenedFile(target) : undefined;
      if (bytes !== undefined) return bytes;
    }
    if (observed || (home !== undefined && aveHomeConfigurationDirectory(home) !== resolve(home))) {
      throw new Error("Configuration file disappeared or is missing after migration");
    }
    if (home !== undefined) {
      if (configurationEntryExists(join(home, "config", ".ave-config-sources.json"))) throw new Error("Configuration migration state exists without the requested file");
      for (const candidate of [join(home, basename(path)), join(home, "config", basename(path))]) {
        if (configurationEntryExists(candidate)) throw new Error("Uncommitted configuration file is present");
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof AveHomeConfigurationUntrustedError) throw error;
    throw new AveHomeConfigurationUntrustedError(path, (error as Error).message);
  }
}
