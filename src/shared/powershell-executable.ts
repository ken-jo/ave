import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { admitWindowsReparse, mapWindowsGenericRights, readWindowsDacls, type WindowsDaclFacts } from "./windows-path-facts.js";
import { win32SystemBinary } from "./windows-system-path.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

export interface TrustedPowerShellExecutable {
  readonly executable: string;
  readonly kind: "pwsh" | "windows-powershell";
}

const POSIX_INSTALLATIONS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ["/usr/local/microsoft/powershell/7/pwsh"],
  linux: ["/opt/microsoft/powershell/7/pwsh", "/usr/lib/powershell/7/pwsh"],
};
const trustedWindowsWriters = new Set([
  "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const MAX_INSTALLATION_ENTRIES = 65_536;
const MAX_INSTALLATION_DEPTH = 64;
const installationProofs = new Map<string, TrustedPowerShellExecutable | null>();

/** Only fixed, protected installation trees qualify; PATH never supplies authority. */
export function resolveTrustedPowerShellExecutable(platform: NodeJS.Platform = process.platform): TrustedPowerShellExecutable | null {
  const candidates = platform === "win32" ? windowsCandidates() : POSIX_INSTALLATIONS[platform] ?? [];
  for (const candidate of candidates) {
    const key = `${platform}:${candidate}`;
    const cached = installationProofs.get(key);
    if (cached !== undefined) {
      if (cached !== null) return cached;
      continue;
    }
    const verified = platform === "win32" ? verifyWindowsInstallation(candidate) : verifyPosixInstallation(candidate, platform);
    // Protected objects cannot change under agent authority. Cache refusals too:
    // a new or repaired installation needs restart, never repeated startup I/O.
    installationProofs.set(key, verified);
    if (verified !== null) return verified;
  }
  return null;
}

function windowsCandidates(): readonly string[] {
  try { return [win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe")]; }
  catch { return []; }
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

function installationEntries(root: string, platform: NodeJS.Platform): string[] {
  const paths: string[] = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const { path, depth } = pending.pop()!;
    if (depth > MAX_INSTALLATION_DEPTH || paths.length >= MAX_INSTALLATION_ENTRIES) throw new Error("Shell installation exceeds structural limits");
    if (!isPosixEntryProtected(path)) throw new Error("Shell installation is not protected");
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Shell installation contains unsupported entries");
    paths.push(path);
    if (entry.isDirectory()) {
      if (platform === "darwin" && !hasNoDarwinExtendedAcl([path])) throw new Error("Shell installation has extended access");
      for (const name of readdirSync(path)) pending.push({ path: join(path, name), depth: depth + 1 });
    }
  }
  return paths;
}

function verifyPosixInstallation(candidate: string, platform: NodeJS.Platform): TrustedPowerShellExecutable | null {
  try {
    if (typeof process.getuid !== "function" || process.getuid() === 0 || process.geteuid?.() === 0) return null;
    const executable = realpathSync(candidate);
    if (executable !== candidate || !lstatSync(executable).isFile()) return null;
    const root = dirname(executable);
    const parents = ancestors(root, dirname);
    if (!parents.every(isPosixEntryProtected)) return null;
    if (platform === "darwin" && !hasNoDarwinExtendedAcl(parents)) return null;
    const paths = installationEntries(root, platform);
    if (platform === "darwin" && !hasNoDarwinExtendedAcl(paths)) return null;
    accessSync(executable, constants.X_OK);
    return Object.freeze({ executable, kind: "pwsh" });
  } catch { return null; }
}

function hasNoDarwinExtendedAcl(paths: readonly string[]): boolean {
  // Ordinary mode bits do not describe extended security-change grants.
  // The fixed system helper runs with no inherited loader or search settings.
  const helper = "/bin/ls";
  if (!ancestors(helper, dirname).every(isPosixEntryProtected)) return false;
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

function verifyWindowsInstallation(candidate: string): TrustedPowerShellExecutable | null {
  try {
    const root = win32.dirname(candidate);
    const parents = ancestors(win32.dirname(root), win32.dirname);
    for (let offset = 0; offset < parents.length; offset += 16) {
      const batch = parents.slice(offset, offset + 16);
      const rows = readWindowsDacls(batch);
      if (rows.length !== batch.length || !rows.every((row) => protectedWindowsEntry(row, true) && row.directory)) return null;
    }
    const pending = [{ path: root, depth: 0 }];
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
    return foundExecutable ? Object.freeze({ executable: candidate, kind: "windows-powershell" }) : null;
  } catch { return null; }
}
