import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
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

/** Candidates and installation roots must be host-owned constants, never command or PATH input. */
export function resolveVerifiedExecutable(
  candidates: readonly VerifiedExecutableCandidate[],
  platform: NodeJS.Platform = process.platform,
): VerifiedExecutable | null {
  const parent = platform === "win32" ? win32.dirname : posix.dirname;
  for (const candidate of candidates) {
    const roots = candidate.installationRoots ?? [parent(candidate.executable)];
    const key = JSON.stringify([platform, candidate.executable, roots]);
    const cached = installationProofs.get(key);
    if (cached !== undefined) {
      if (cached !== null) return cached;
      continue;
    }
    const verified = hasValidInstallationRoots(candidate.executable, roots, platform)
      ? platform === "win32"
        ? verifyWindowsInstallation(candidate.executable, roots)
        : verifyPosixInstallation(candidate.executable, roots, platform)
      : null;
    // Protected objects cannot change under agent authority. Cache refusals too:
    // a new or repaired installation needs restart, never repeated startup I/O.
    installationProofs.set(key, verified);
    if (verified !== null) return verified;
  }
  return null;
}

function hasValidInstallationRoots(executable: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  if (roots.length === 0 || ![executable, ...roots].every(path => paths.isAbsolute(path) && paths.normalize(path) === path)) return false;
  return roots.some(root => {
    const child = paths.relative(root, executable);
    return child !== ".." && !child.startsWith(platform === "win32" ? "..\\" : "../") && !paths.isAbsolute(child);
  });
}

function isPosixEntryProtected(path: string): boolean {
  const entry = lstatSync(path);
  if (entry.uid !== 0 || (entry.mode & 0o022) !== 0 || entry.isSymbolicLink()) return false;
  try { accessSync(path, constants.W_OK); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EROFS"; }
}

function ancestors(path: string, parent: (value: string) => string): string[] {
  const paths: string[] = [];
  for (let current = path;; current = parent(current)) {
    paths.push(current);
    if (parent(current) === current) return paths;
  }
}

function installationEntries(root: string, platform: NodeJS.Platform, inspected: number): string[] {
  const paths: string[] = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const { path, depth } = pending.pop()!;
    if (depth > MAX_INSTALLATION_DEPTH || inspected + paths.length >= MAX_INSTALLATION_ENTRIES) throw new Error("Executable installation exceeds structural limits");
    if (!isPosixEntryProtected(path)) throw new Error("Executable installation is not protected");
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Executable installation contains unsupported entries");
    paths.push(path);
    if (entry.isDirectory()) {
      if (platform === "darwin" && !hasNoDarwinExtendedAcl([path])) throw new Error("Executable installation has extended access");
      for (const name of readdirSync(path)) pending.push({ path: posix.join(path, name), depth: depth + 1 });
    }
  }
  return paths;
}

function verifyPosixInstallation(candidate: string, roots: readonly string[], platform: NodeJS.Platform): VerifiedExecutable | null {
  try {
    if (typeof process.getuid !== "function" || process.getuid() === 0 || process.geteuid?.() === 0) return null;
    const executable = realpathSync(candidate);
    if (executable !== candidate || !lstatSync(executable).isFile()) return null;
    let inspected = 0;
    for (const root of roots) {
      const parents = ancestors(root, posix.dirname);
      if (!parents.every(isPosixEntryProtected)) return null;
      if (platform === "darwin" && !hasNoDarwinExtendedAcl(parents)) return null;
      const paths = installationEntries(root, platform, inspected);
      inspected += paths.length;
      if (platform === "darwin" && !hasNoDarwinExtendedAcl(paths)) return null;
    }
    accessSync(executable, constants.X_OK);
    return Object.freeze({ executable });
  } catch { return null; }
}

function hasNoDarwinExtendedAcl(paths: readonly string[]): boolean {
  // Ordinary mode bits do not describe extended security-change grants.
  // The fixed system helper runs with no inherited loader or search settings.
  const helper = "/bin/ls";
  if (!ancestors(helper, posix.dirname).every(isPosixEntryProtected)) return false;
  for (let offset = 0; offset < paths.length; offset += 32) {
    const output = execFileSync(helper, ["-lde", ...paths.slice(offset, offset + 32)], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 1024 * 1024,
    });
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
