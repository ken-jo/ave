import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { admitWindowsReparse, pinWindowsPaths } from "../../shared/windows-path-facts.js";

export interface GitRepositoryInputs {
  readonly gitDirectory: string;
  readonly workTree: string;
  readonly referenceBackend: "files";
  readonly stateFingerprint: string;
}

const MAX_METADATA_ENTRIES = 4096;
const MAX_METADATA_DEPTH = 32;
const MAX_CONFIG_BYTES = 64 * 1024;
const FORBIDDEN_METADATA_PATHS = new Set(["commondir", "worktrees", "objects/info/alternates", "objects/info/http-alternates"]);

function hasSupportedConfig(contents: Buffer): boolean {
  const text = contents.toString("utf8");
  // The admitted subset excludes escapes, continuations, quoted values and
  // non-ASCII spelling rather than guessing how a later parser interprets them.
  if (/[^\t\r\n\x20-\x7e]/.test(text) || text.includes("\\") || /\r(?!\n)/.test(text)) return false;
  let section: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[")) {
      const match = /^\[([a-zA-Z][a-zA-Z0-9.-]*)(?:[ \t]+"[^"\\\x00-\x1f]+")?\][ \t]*(?:[#;].*)?$/.exec(line);
      if (match === null) return false;
      section = match[1]!.toLowerCase();
      if (/^(?:include|includeif|mailmap|extensions)(?:\.|$)/.test(section)) return false;
      continue;
    }
    if (section === undefined || line.includes('"')) return false;
    const assignmentIndex = line.indexOf("=");
    const variable = (assignmentIndex === -1 ? line : line.slice(0, assignmentIndex)).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(variable)) return false;
    const key = `${section}.${variable.toLowerCase()}`;
    if (key === "diff.orderfile" || key === "core.worktree") return false;
  }
  return true;
}

function metadataIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(":");
}

function readConfigFingerprint(path: string, expectedIdentity: string): string | null {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_CONFIG_BYTES) || metadataIdentity(stat) !== expectedIdentity) return null;
    const contents = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < contents.length) {
      const count = readSync(descriptor, contents, length, contents.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = contents.subarray(0, length);
    if (length > MAX_CONFIG_BYTES || !hasSupportedConfig(bytes)
      || metadataIdentity(fstatSync(descriptor, { bigint: true })) !== expectedIdentity
      || metadataIdentity(lstatSync(path, { bigint: true })) !== expectedIdentity) return null;
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function isOrdinaryWindowsPath(path: string): boolean {
  const rows = pinWindowsPaths([path]);
  const row = rows[0];
  return rows.length === 1 && row !== undefined && row.exists === true && admitWindowsReparse(row, "evidence") === true;
}

/** Bounded evidence for pre/post comparison; metadata is not atomically sealed. */
export function inspectGitRepository(cwd: string): GitRepositoryInputs | null {
  if (!isAbsolute(cwd) || cwd.includes("\0")) return null;
  try {
    if (process.platform === "win32" && !isOrdinaryWindowsPath(cwd)) return null;
    const workTree = realpathSync(cwd);
    const provenance: [string, string][] = [];
    let ancestor = workTree;
    for (let depth = 0; ; depth += 1) {
      if (depth > MAX_METADATA_DEPTH) return null;
      if (process.platform === "win32" && !isOrdinaryWindowsPath(ancestor)) return null;
      const stat = lstatSync(ancestor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      provenance.push([ancestor, metadataIdentity(stat)]);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const evidence: [string, string, string][] = [];
    const gitDirectory = join(workTree, ".git");
    let entries = 0;
    const inspect = (path: string, relative: string, depth: number): boolean => {
      const metadataPath = relative.toLowerCase();
      if (++entries > MAX_METADATA_ENTRIES || depth > MAX_METADATA_DEPTH
        || FORBIDDEN_METADATA_PATHS.has(metadataPath) || metadataPath.endsWith("/commondir")) return false;
      if (process.platform === "win32" && !isOrdinaryWindowsPath(path)) return false;
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) return false;
      const identity = metadataIdentity(stat);
      if (relative === "" && !stat.isDirectory()) return false;
      const isConfig = metadataPath === "config" || metadataPath === "config.worktree";
      if (stat.isFile()) {
        const configHash = isConfig ? readConfigFingerprint(path, identity) : "";
        if (configHash === null) return false;
        evidence.push([relative, identity, configHash]);
        return true;
      }
      if (isConfig) return false;
      evidence.push([relative, identity, ""]);
      const directory = opendirSync(path);
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (!inspect(join(path, entry.name), relative ? `${relative}/${entry.name}` : entry.name, depth + 1)) return false;
        }
      } finally {
        directory.closeSync();
      }
      return true;
    };
    if (!inspect(gitDirectory, "", 0)) return null;
    // Catch paths changed while another part of the bounded walk was inspected.
    // This is a consistency check, not a lock on later path opens.
    for (const [path, identity] of provenance) {
      if (metadataIdentity(lstatSync(path, { bigint: true })) !== identity) return null;
    }
    for (const [relative, identity] of evidence) {
      if (metadataIdentity(lstatSync(join(gitDirectory, relative), { bigint: true })) !== identity) return null;
    }
    evidence.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const stateFingerprint = createHash("sha256").update(JSON.stringify([provenance, evidence])).digest("hex");
    return { gitDirectory, workTree, referenceBackend: "files", stateFingerprint };
  } catch {
    return null;
  }
}
