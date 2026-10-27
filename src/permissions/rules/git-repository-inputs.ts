import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { admitWindowsReparse, pinWindowsPaths } from "../../shared/windows-path-facts.js";

export interface GitRepositoryInputs {
  readonly gitDirectory: string;
  readonly workTree: string;
  readonly referenceBackend: "files";
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

function hasSupportedConfigFile(path: string): boolean {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES) return false;
    const contents = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < contents.length) {
      const count = readSync(descriptor, contents, length, contents.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return length <= MAX_CONFIG_BYTES && hasSupportedConfig(contents.subarray(0, length));
  } finally {
    closeSync(descriptor);
  }
}

function isOrdinaryWindowsPath(path: string): boolean {
  const rows = pinWindowsPaths([path]);
  const row = rows[0];
  return rows.length === 1 && row !== undefined && row.exists === true && admitWindowsReparse(row, "evidence") === true;
}

/** Check-time admission only; metadata can change after this inspection. */
export function inspectGitRepository(cwd: string): GitRepositoryInputs | null {
  if (!isAbsolute(cwd) || cwd.includes("\0")) return null;
  try {
    if (process.platform === "win32" && !isOrdinaryWindowsPath(cwd)) return null;
    const workTree = realpathSync(cwd);
    if (!lstatSync(workTree).isDirectory()) return null;
    const gitDirectory = join(workTree, ".git");
    let entries = 0;
    const inspect = (path: string, relative: string, depth: number): boolean => {
      const metadataPath = relative.toLowerCase();
      if (++entries > MAX_METADATA_ENTRIES || depth > MAX_METADATA_DEPTH
        || FORBIDDEN_METADATA_PATHS.has(metadataPath) || metadataPath.endsWith("/commondir")) return false;
      if (process.platform === "win32" && !isOrdinaryWindowsPath(path)) return false;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) return false;
      if (relative === "" && !stat.isDirectory()) return false;
      const isConfig = metadataPath === "config" || metadataPath === "config.worktree";
      if (stat.isFile()) return !isConfig || hasSupportedConfigFile(path);
      if (isConfig) return false;
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
    return inspect(gitDirectory, "", 0) ? { gitDirectory, workTree, referenceBackend: "files" } : null;
  } catch {
    return null;
  }
}
