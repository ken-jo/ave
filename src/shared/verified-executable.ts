import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, realpath, realpathSync, type Stats } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { check, runChecksAsync, runChecksSync, type Checks } from "./sync-async-checks.js";
import { admitWindowsReparse, mapWindowsGenericRights, readWindowsDacls, type WindowsDaclFacts } from "./windows-path-facts.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

export interface VerifiedExecutableCandidate {
  readonly executable: string;
  /** Protected files or complete directory trees; defaults to the image directory and must cover the image. */
  readonly installationRoots?: readonly string[];
}

export interface VerifiedExecutable {
  readonly executable: string;
}

const trustedWindowsWriters = new Set([
  "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const MAX_INSTALLATION_ENTRIES = 65_536;
const MAX_INSTALLATION_DEPTH = 64;
const installationProofs = new Map<string, VerifiedExecutable | null>();
const pendingProofs = new Map<string, Promise<VerifiedExecutable | null>>();

/** Candidates and installation roots must be host-owned constants, never command or PATH input. */
export function resolveVerifiedExecutable(
  candidates: readonly VerifiedExecutableCandidate[],
  platform: NodeJS.Platform = process.platform,
): VerifiedExecutable | null {
  return runChecksSync(resolveCandidates(candidates, platform));
}

/**
 * The same proof and cache as {@link resolveVerifiedExecutable}, performed without blocking the event loop.
 * Windows installations are proven only by the synchronous native DACL helper, so this proof refuses them:
 * the caller sees an unverified executable, never an error, and no refusal is cached for the sync proof.
 */
export function resolveVerifiedExecutableAsync(
  candidates: readonly VerifiedExecutableCandidate[],
  platform: NodeJS.Platform = process.platform,
): Promise<VerifiedExecutable | null> {
  if (platform === "win32") return Promise.resolve(null);
  return runChecksAsync(resolveCandidates(candidates, platform));
}

function* resolveCandidates(candidates: readonly VerifiedExecutableCandidate[], platform: NodeJS.Platform): Checks<VerifiedExecutable | null> {
  const parent = platform === "win32" ? win32.dirname : posix.dirname;
  for (const candidate of candidates) {
    const roots = candidate.installationRoots ?? [parent(candidate.executable)];
    const key = JSON.stringify([platform, candidate.executable, roots]);
    let verified = installationProofs.get(key);
    if (verified === undefined) {
      verified = yield* check(
        () => proveCandidateSync(candidate.executable, roots, platform),
        () => proveCandidateAsync(key, candidate.executable, roots, platform),
      );
      // Protected objects cannot change under agent authority. Cache refusals too:
      // a new or repaired installation needs restart, never repeated startup I/O.
      const settled = installationProofs.get(key);
      if (settled === undefined) installationProofs.set(key, verified);
      else verified = settled;
    }
    if (verified !== null) return verified;
  }
  return null;
}

function proveCandidateSync(executable: string, roots: readonly string[], platform: NodeJS.Platform): VerifiedExecutable | null {
  if (!hasValidInstallationRoots(executable, roots, platform)) return null;
  return platform === "win32"
    ? verifyWindowsInstallation(executable, roots)
    : runChecksSync(verifyPosixInstallation(executable, roots, platform));
}

function proveCandidateAsync(key: string, executable: string, roots: readonly string[], platform: NodeJS.Platform): Promise<VerifiedExecutable | null> {
  const pending = pendingProofs.get(key);
  if (pending !== undefined) return pending;
  const proof = (hasValidInstallationRoots(executable, roots, platform)
    ? runChecksAsync(verifyPosixInstallation(executable, roots, platform))
    : Promise.resolve(null))
    .finally(() => { if (pendingProofs.get(key) === proof) pendingProofs.delete(key); });
  pendingProofs.set(key, proof);
  return proof;
}

function hasValidInstallationRoots(executable: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  if (roots.length === 0 || ![executable, ...roots].every(path => paths.isAbsolute(path) && paths.normalize(path) === path)) return false;
  return roots.some(root => {
    const child = paths.relative(root, executable);
    return child !== ".." && !child.startsWith(platform === "win32" ? "..\\" : "../") && !paths.isAbsolute(child);
  });
}

function* lstatEntry(path: string): Checks<Stats> {
  return yield* check(() => lstatSync(path), () => lstat(path));
}

function* isPosixEntryProtected(path: string): Checks<boolean> {
  const entry = yield* lstatEntry(path);
  if (entry.uid !== 0 || (entry.mode & 0o022) !== 0 || entry.isSymbolicLink()) return false;
  try { yield* check(() => accessSync(path, constants.W_OK), () => access(path, constants.W_OK)); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EROFS"; }
}

function* everyPosixEntryProtected(paths: readonly string[]): Checks<boolean> {
  for (const path of paths) if (!(yield* isPosixEntryProtected(path))) return false;
  return true;
}

function ancestors(path: string, parent: (value: string) => string): string[] {
  const paths: string[] = [];
  for (let current = path;; current = parent(current)) {
    paths.push(current);
    if (parent(current) === current) return paths;
  }
}

function* installationEntries(root: string, platform: NodeJS.Platform, inspected: number): Checks<string[]> {
  const paths: string[] = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const { path, depth } = pending.pop()!;
    if (depth > MAX_INSTALLATION_DEPTH || inspected + paths.length >= MAX_INSTALLATION_ENTRIES) throw new Error("Executable installation exceeds structural limits");
    if (!(yield* isPosixEntryProtected(path))) throw new Error("Executable installation is not protected");
    const entry = yield* lstatEntry(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Executable installation contains unsupported entries");
    paths.push(path);
    if (entry.isDirectory()) {
      if (platform === "darwin" && !(yield* hasNoDarwinExtendedAcl([path]))) throw new Error("Executable installation has extended access");
      const names = yield* check(() => readdirSync(path), () => readdir(path));
      for (const name of names) pending.push({ path: posix.join(path, name), depth: depth + 1 });
    }
  }
  return paths;
}

function realpathAsync(path: string): Promise<string> {
  // The callback form shares realpathSync's JavaScript resolution; fs/promises uses the native one.
  return new Promise((resolve, reject) => realpath(path, (error, resolved) => error ? reject(error) : resolve(resolved)));
}

function* verifyPosixInstallation(candidate: string, roots: readonly string[], platform: NodeJS.Platform): Checks<VerifiedExecutable | null> {
  try {
    if (typeof process.getuid !== "function" || process.getuid() === 0 || process.geteuid?.() === 0) return null;
    const executable = yield* check(() => realpathSync(candidate), () => realpathAsync(candidate));
    if (executable !== candidate || !(yield* lstatEntry(executable)).isFile()) return null;
    let inspected = 0;
    for (const root of roots) {
      const parents = ancestors(root, posix.dirname);
      if (!(yield* everyPosixEntryProtected(parents))) return null;
      if (platform === "darwin" && !(yield* hasNoDarwinExtendedAcl(parents))) return null;
      const paths = yield* installationEntries(root, platform, inspected);
      inspected += paths.length;
      if (platform === "darwin" && !(yield* hasNoDarwinExtendedAcl(paths))) return null;
    }
    yield* check(() => accessSync(executable, constants.X_OK), () => access(executable, constants.X_OK));
    return Object.freeze({ executable });
  } catch { return null; }
}

const DARWIN_ACL_HELPER = "/bin/ls";
const darwinAclOptions = Object.freeze({
  encoding: "utf8" as const, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 1024 * 1024,
});

function listDarwinAclsAsync(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(DARWIN_ACL_HELPER, args, darwinAclOptions, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

function* hasNoDarwinExtendedAcl(paths: readonly string[]): Checks<boolean> {
  // Ordinary mode bits do not describe extended security-change grants.
  // The fixed system helper runs with no inherited loader or search settings.
  if (!(yield* everyPosixEntryProtected(ancestors(DARWIN_ACL_HELPER, posix.dirname)))) return false;
  for (let offset = 0; offset < paths.length; offset += 32) {
    const args = ["-lde", ...paths.slice(offset, offset + 32)];
    const output = yield* check(() => execFileSync(DARWIN_ACL_HELPER, args, darwinAclOptions), () => listDarwinAclsAsync(args));
    const rows = output.split("\n");
    if (rows.pop() !== "" || rows.length !== Math.min(32, paths.length - offset)
      || !rows.every((row) => /^[d-][rwxstST-]{9} /.test(row))) return false;
  }
  return true;
}

function protectedWindowsEntry(row: WindowsDaclFacts, ancestor: boolean): boolean {
  if (row.elevated || row.exists !== true || admitWindowsReparse(row, "evidence") !== true || !row.dacl
    || row.dacl.nullDacl || !trustedWindowsWriters.has(row.dacl.owner)) return false;
  const mutationMask = ancestor ? 0x000d0040 : 0x000d0156;
  for (const ace of row.dacl.aces) {
    if (![0, 1, 5, 6].includes(ace.type) || ace.sid === null) return false;
    if ((ace.type === 0 || ace.type === 5) && (ace.flags & 8) === 0
      && (mapWindowsGenericRights(ace.mask) & mutationMask) !== 0 && !trustedWindowsWriters.has(ace.sid)) return false;
  }
  return true;
}

function verifyWindowsInstallation(candidate: string, roots: readonly string[]): VerifiedExecutable | null {
  try {
    const parents = roots.flatMap(root => ancestors(win32.dirname(root), win32.dirname));
    for (let offset = 0; offset < parents.length; offset += 16) {
      const batch = parents.slice(offset, offset + 16);
      const rows = readWindowsDacls(batch);
      if (rows.length !== batch.length || !rows.every((row) => protectedWindowsEntry(row, true) && row.directory)) return null;
    }
    const pending = roots.map(path => ({ path, depth: 0 }));
    let inspected = 0;
    let foundExecutable = false;
    while (pending.length > 0) {
      const batch = pending.splice(Math.max(0, pending.length - 16), 16);
      if (batch.some(({ path, depth }) => path.length > 1024 || depth > MAX_INSTALLATION_DEPTH)
        || inspected + batch.length > MAX_INSTALLATION_ENTRIES) return null;
      const rows = readWindowsDacls(batch.map(({ path }) => path));
      if (rows.length !== batch.length || !rows.every((row) => protectedWindowsEntry(row, false))) return null;
      inspected += batch.length;
      for (let index = 0; index < batch.length; index += 1) {
        const { path, depth } = batch[index]!;
        const row = rows[index]!;
        if (path.toLowerCase() === candidate.toLowerCase()) {
          if (row.directory) return null;
          foundExecutable = true;
        }
        // Prove the directory before reading its entries. A writable subtree
        // never becomes startup work merely because a protected parent names it.
        if (row.directory) for (const name of readdirSync(path)) pending.push({ path: win32.join(path, name), depth: depth + 1 });
      }
    }
    return foundExecutable ? Object.freeze({ executable: candidate }) : null;
  } catch { return null; }
}
