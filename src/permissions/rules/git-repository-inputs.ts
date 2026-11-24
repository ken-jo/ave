import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpath, realpathSync, type BigIntStats, type Dir } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { check, runChecksAsync, runChecksSync, type Checks } from "../../shared/sync-async-checks.js";
import { admitWindowsReparse, pinWindowsPaths } from "../../shared/windows-path-facts.js";

export interface GitRepositoryInputs {
  readonly gitDirectory: string;
  readonly workTree: string;
  readonly referenceBackend: "files";
  readonly stateFingerprint: string;
}

const MAX_METADATA_ENTRIES = 4096;
const MAX_METADATA_DEPTH = 32;
// Large control files (including packed refs) decline the verified read-only
// path; the aggregate cap prevents thousands of small refs from multiplying I/O.
const MAX_CONTROL_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_TOTAL_BYTES = 16 * 1024 * 1024;
const CONTROL_READ_BUFFER_BYTES = 64 * 1024;
const CONTENT_METADATA_PATHS = new Set([
  "config", "config.worktree", "head", "packed-refs", "shallow", "objects/info/packs",
  "objects/info/commit-graphs/commit-graph-chain",
  "auto_merge", "bisect_expected_rev", "notes_merge_partial", "notes_merge_ref", "merge_autostash",
  // `git branch --list` describes a detached HEAD from the rebase and bisect state.
  "bisect_start", "rebase-merge/head-name", "rebase-merge/onto", "rebase-apply/head-name", "rebase-apply/onto",
]);
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

/** A control file opened by exactly one driver; using it from the other driver is a contract violation. */
interface ControlFile { readonly descriptor?: number; readonly handle?: FileHandle }

function syncDescriptor(file: ControlFile): number {
  if (file.descriptor === undefined) throw new Error("Control file was opened by the asynchronous driver");
  return file.descriptor;
}

function asyncHandle(file: ControlFile): FileHandle {
  if (file.handle === undefined) throw new Error("Control file was opened by the synchronous driver");
  return file.handle;
}

function* lstatEvidence(path: string): Checks<BigIntStats> {
  return yield* check(() => lstatSync(path, { bigint: true }), () => lstat(path, { bigint: true }));
}

function* fstatControl(file: ControlFile): Checks<BigIntStats> {
  return yield* check(() => fstatSync(syncDescriptor(file), { bigint: true }), () => asyncHandle(file).stat({ bigint: true }));
}

function* readControlFingerprint(path: string, expectedIdentity: string, maxBytes: number, isConfig: boolean): Checks<{ hash: string; bytes: number } | null> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file: ControlFile = yield* check(
    (): ControlFile => ({ descriptor: openSync(path, flags) }),
    async (): Promise<ControlFile> => ({ handle: await open(path, flags) }),
  );
  try {
    const stat = yield* fstatControl(file);
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maxBytes) || metadataIdentity(stat) !== expectedIdentity) return null;
    const contents = Buffer.alloc(CONTROL_READ_BUFFER_BYTES);
    const hash = createHash("sha256");
    // Only configuration needs retained bytes for the existing syntax validator.
    const configChunks: Buffer[] = [];
    let length = 0;
    while (length <= maxBytes) {
      const requested = Math.min(contents.length, maxBytes - length + 1);
      const count = yield* check(
        () => readSync(syncDescriptor(file), contents, 0, requested, null),
        async () => (await asyncHandle(file).read(contents, 0, requested, null)).bytesRead,
      );
      if (count === 0) break;
      length += count;
      if (length > maxBytes) return null;
      const bytes = contents.subarray(0, count);
      hash.update(bytes);
      if (isConfig) configChunks.push(Buffer.from(bytes));
    }
    if (isConfig && !hasSupportedConfig(Buffer.concat(configChunks, length))) return null;
    if (metadataIdentity(yield* fstatControl(file)) !== expectedIdentity
      || metadataIdentity(yield* lstatEvidence(path)) !== expectedIdentity) return null;
    return { hash: hash.digest("hex"), bytes: length };
  } finally {
    yield* check(() => closeSync(syncDescriptor(file)), () => asyncHandle(file).close());
  }
}

function needsContentEvidence(path: string): boolean {
  // readOnlyGitArguments admits revision/history, branch listing and tree diffs.
  // Their mutable inputs are root refs/config, refs, shallow and info controls.
  // Root refs include the irregular names recognized by the files backend.
  // Pack listings and the commit-graph chain are text; binary data stays identity-only.
  // Alternate-store text selectors are already forbidden above.
  // gitReadOnlyEnvironment redirects the index; argv disables submodule reads
  // and reflog selectors. Nested repository, cache and editor data is not read.
  return CONTENT_METADATA_PATHS.has(path) || /^[a-z_-]+_head$/.test(path)
    || path.startsWith("refs/") || path.startsWith("info/");
}

// Keeps each helper command line well below the 32,767-character CreateProcess limit.
const MAX_WINDOWS_PIN_BATCH_CHARACTERS = 16 * 1024;

/** One pin covers a path and every ancestor component; batches bound helper starts per directory. */
function* areOrdinaryWindowsPaths(paths: readonly string[]): Checks<boolean> {
  for (let start = 0; start < paths.length;) {
    let end = start;
    let characters = 0;
    while (end < paths.length && (end === start || characters + paths[end]!.length + 3 <= MAX_WINDOWS_PIN_BATCH_CHARACTERS)) {
      characters += paths[end]!.length + 3;
      end += 1;
    }
    const batch = paths.slice(start, end);
    // The native pin helper is synchronous; the asynchronous driver refuses rather than block.
    const rows = yield* check(() => pinWindowsPaths(batch),
      () => Promise.reject(new Error("Asynchronous repository inspection cannot pin Windows paths")));
    if (rows.length !== batch.length || !rows.every(row => row.exists === true && admitWindowsReparse(row, "evidence") === true)) return false;
    start = end;
  }
  return true;
}

/** Bounded evidence for pre/post comparison; metadata is not atomically sealed. */
export function inspectGitRepository(cwd: string): GitRepositoryInputs | null {
  return runChecksSync(inspectRepository(cwd));
}

/** The same inspection, check for check and in the same order, without blocking the event loop. */
export function inspectGitRepositoryAsync(cwd: string): Promise<GitRepositoryInputs | null> {
  return runChecksAsync(inspectRepository(cwd));
}

function realpathAsync(path: string): Promise<string> {
  // The callback form shares realpathSync's JavaScript resolution; fs/promises uses the native one.
  return new Promise((resolve, reject) => realpath(path, (error, resolved) => error ? reject(error) : resolve(resolved)));
}

function* inspectRepository(cwd: string): Checks<GitRepositoryInputs | null> {
  if (!isAbsolute(cwd) || cwd.includes("\0")) return null;
  try {
    // Pinning the requested spelling first means realpath follows no reparse point.
    if (process.platform === "win32" && !(yield* areOrdinaryWindowsPaths([cwd]))) return null;
    const workTree = yield* check(() => realpathSync(cwd), () => realpathAsync(cwd));
    const provenance: [string, string][] = [];
    let ancestor = workTree;
    for (let depth = 0; ; depth += 1) {
      if (depth > MAX_METADATA_DEPTH) return null;
      const stat = yield* lstatEvidence(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      provenance.push([ancestor, metadataIdentity(stat)]);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const evidence: [string, string, string][] = [];
    const gitDirectory = join(workTree, ".git");
    let entries = 0;
    let controlBytes = 0;
    function* inspect(path: string, relative: string, depth: number): Checks<boolean> {
      const metadataPath = relative.toLowerCase();
      if (++entries > MAX_METADATA_ENTRIES || depth > MAX_METADATA_DEPTH
        || FORBIDDEN_METADATA_PATHS.has(metadataPath) || metadataPath.endsWith("/commondir")) return false;
      // The caller pinned this path, alone for the root and with its siblings otherwise.
      const stat = yield* lstatEvidence(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) return false;
      const identity = metadataIdentity(stat);
      if (relative === "" && !stat.isDirectory()) return false;
      const isConfig = metadataPath === "config" || metadataPath === "config.worktree";
      if (stat.isFile()) {
        let contentHash = "";
        if (needsContentEvidence(metadataPath)) {
          const fingerprint = yield* readControlFingerprint(path, identity,
            Math.min(MAX_CONTROL_FILE_BYTES, MAX_CONTROL_TOTAL_BYTES - controlBytes), isConfig);
          if (fingerprint === null) return false;
          controlBytes += fingerprint.bytes;
          contentHash = fingerprint.hash;
        }
        evidence.push([relative, identity, contentHash]);
        return true;
      }
      if (isConfig) return false;
      evidence.push([relative, identity, ""]);
      const names: string[] = [];
      const directory: Dir = yield* check(() => opendirSync(path), () => opendir(path));
      try {
        let entry;
        while ((entry = yield* check(() => directory.readSync(), () => directory.read())) !== null) {
          if (entries + names.length >= MAX_METADATA_ENTRIES) return false;
          names.push(entry.name);
        }
      } finally {
        yield* check(() => directory.closeSync(), () => directory.close());
      }
      if (process.platform === "win32" && !(yield* areOrdinaryWindowsPaths(names.map(name => join(path, name))))) return false;
      for (const name of names) {
        if (!(yield* inspect(join(path, name), relative ? `${relative}/${name}` : name, depth + 1))) return false;
      }
      return true;
    }
    // This pin uses the realpath spelling, so its ancestor components cover every
    // provenance directory walked above as well as the metadata root itself.
    if (process.platform === "win32" && !(yield* areOrdinaryWindowsPaths([gitDirectory]))) return null;
    if (!(yield* inspect(gitDirectory, "", 0))) return null;
    // Catch paths changed while another part of the bounded walk was inspected.
    // This is a consistency check, not a lock on later path opens.
    for (const [path, identity] of provenance) {
      if (metadataIdentity(yield* lstatEvidence(path)) !== identity) return null;
    }
    for (const [relative, identity] of evidence) {
      if (metadataIdentity(yield* lstatEvidence(join(gitDirectory, relative))) !== identity) return null;
    }
    evidence.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const stateFingerprint = createHash("sha256").update(JSON.stringify([provenance, evidence])).digest("hex");
    return { gitDirectory, workTree, referenceBackend: "files", stateFingerprint };
  } catch {
    return null;
  }
}
