import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { admitLocalRoute, admitRouteAncestor, localFs, withLocalityDecision } from "../../shared/local-path-io.js";
import { admitWindowsReparse, pinWindowsPaths } from "../../shared/windows-path-facts.js";
import { admitObligations, consumeObligations, windowsObligationsApply } from "../admitted-obligation.js";

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

function readControlFingerprint(path: string, expectedIdentity: string, maxBytes: number, isConfig: boolean, nativeWindows: boolean): { hash: string; bytes: number } | null {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const descriptor = nativeWindows ? localFs.open(ordinaryLocalRoute(path).verdict, flags) : openSync(path, flags);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maxBytes) || metadataIdentity(stat) !== expectedIdentity) return null;
    const contents = Buffer.alloc(CONTROL_READ_BUFFER_BYTES);
    const hash = createHash("sha256");
    // Only configuration needs retained bytes for the existing syntax validator.
    const configChunks: Buffer[] = [];
    let length = 0;
    while (length <= maxBytes) {
      const count = readSync(descriptor, contents, 0, Math.min(contents.length, maxBytes - length + 1), null);
      if (count === 0) break;
      length += count;
      if (length > maxBytes) return null;
      const bytes = contents.subarray(0, count);
      hash.update(bytes);
      if (isConfig) configChunks.push(Buffer.from(bytes));
    }
    if ((isConfig && !hasSupportedConfig(Buffer.concat(configChunks, length)))
      || metadataIdentity(fstatSync(descriptor, { bigint: true })) !== expectedIdentity) return null;
    const current = nativeWindows ? localFs.lstatBigint(ordinaryLocalRoute(path).verdict) : lstatSync(path, { bigint: true });
    if (current === undefined || metadataIdentity(current) !== expectedIdentity) return null;
    return { hash: hash.digest("hex"), bytes: length };
  } finally {
    closeSync(descriptor);
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
function areOrdinaryWindowsPaths(paths: readonly string[]): boolean {
  for (let start = 0; start < paths.length;) {
    let end = start;
    let characters = 0;
    while (end < paths.length && (end === start || characters + paths[end]!.length + 3 <= MAX_WINDOWS_PIN_BATCH_CHARACTERS)) {
      characters += paths[end]!.length + 3;
      end += 1;
    }
    const batch = paths.slice(start, end);
    const rows = pinWindowsPaths(batch);
    if (rows.length !== batch.length || !rows.every(row => row.exists === true && admitWindowsReparse(row, "evidence") === true)) return false;
    start = end;
  }
  return true;
}

function admitGitPaths(paths: readonly string[]): readonly string[] | undefined {
  const set = admitObligations({
    purpose: "git-pin", principal: "host-lookup",
    rows: paths.map(path => ({
      spelling: { path, literal: true }, polarity: { effect: "allow", access: "lookup" }, source: "command-operand",
    })),
  });
  const entries = consumeObligations(set, "git-pin");
  if (entries.length !== paths.length || entries.some(entry => entry.kind === "missing" || !entry.followCapable)) return undefined;
  return entries.map(entry => entry.target);
}

/** Bounded evidence for pre/post comparison; metadata is not atomically sealed. */
export function inspectGitRepository(cwd: string): GitRepositoryInputs | null {
  if (!isAbsolute(cwd) || cwd.includes("\0")) return null;
  try {
    return withLocalityDecision(() => inspectRepositoryInDecision(cwd));
  } catch {
    return null;
  }
}

function inspectRepositoryInDecision(cwd: string): GitRepositoryInputs | null {
  const nativeWindows = windowsObligationsApply();
  if (!nativeWindows && process.platform === "win32" && !areOrdinaryWindowsPaths([cwd])) return null;
  const workTree = nativeWindows ? admitGitPaths([cwd])?.[0] : realpathSync(cwd);
  if (workTree === undefined) return null;
  let provenanceRoute = nativeWindows ? ordinaryLocalRoute(workTree) : undefined;
  const captureAncestor = (path: string): BigIntStats | undefined => provenanceRoute !== undefined
    ? localFs.lstatBigint(admitRouteAncestor(provenanceRoute, path))
    : lstatSync(path, { bigint: true });
  const provenance: [string, string][] = [];
  let ancestor = workTree;
  for (let depth = 0; ; depth += 1) {
    if (depth > MAX_METADATA_DEPTH) return null;
    const stat = captureAncestor(ancestor);
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return null;
    provenance.push([ancestor, metadataIdentity(stat)]);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const evidence: [string, string, string][] = [];
  const requestedGitDirectory = join(workTree, ".git");
  const gitDirectory = nativeWindows ? admitGitPaths([requestedGitDirectory])?.[0] : requestedGitDirectory;
  if (gitDirectory === undefined) return null;
  let entries = 0;
  let controlBytes = 0;
  const inspect = (path: string, relative: string, depth: number): boolean => {
    const metadataPath = relative.toLowerCase();
    if (++entries > MAX_METADATA_ENTRIES || depth > MAX_METADATA_DEPTH
      || FORBIDDEN_METADATA_PATHS.has(metadataPath) || metadataPath.endsWith("/commondir")) return false;
    // The caller pinned this path, alone for the root and with its siblings otherwise.
    const route = nativeWindows ? ordinaryLocalRoute(path) : undefined;
    const stat = route === undefined ? lstatSync(path, { bigint: true }) : localFs.lstatBigint(route.verdict);
    if (stat === undefined || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) return false;
    const identity = metadataIdentity(stat);
    if (relative === "" && !stat.isDirectory()) return false;
    const isConfig = metadataPath === "config" || metadataPath === "config.worktree";
    if (stat.isFile()) {
      let contentHash = "";
      if (needsContentEvidence(metadataPath)) {
        const fingerprint = readControlFingerprint(path, identity,
          Math.min(MAX_CONTROL_FILE_BYTES, MAX_CONTROL_TOTAL_BYTES - controlBytes), isConfig, nativeWindows);
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
    const directory = route === undefined ? opendirSync(path) : localFs.opendir(route.verdict);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
        if (entries + names.length >= MAX_METADATA_ENTRIES) return false;
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    const children = names.map(name => join(path, name));
    if (nativeWindows) {
      const admitted = admitGitPaths(children);
      if (admitted === undefined || admitted.some((target, index) => target !== children[index])) return false;
    } else if (process.platform === "win32" && !areOrdinaryWindowsPaths(children)) return false;
    for (const name of names) {
      if (!inspect(join(path, name), relative ? `${relative}/${name}` : name, depth + 1)) return false;
    }
    return true;
  };
  if (!nativeWindows && process.platform === "win32" && !areOrdinaryWindowsPaths([gitDirectory])) return null;
  if (!inspect(gitDirectory, "", 0)) return null;
  // Catch paths changed while another part of the bounded walk was inspected.
  // This is a consistency check, not a lock on later path opens.
  // A same-object rename and restore within one filesystem timestamp tick is indistinguishable.
  if (nativeWindows) provenanceRoute = ordinaryLocalRoute(workTree);
  for (const [path, identity] of provenance) {
    const stat = captureAncestor(path);
    if (stat === undefined || metadataIdentity(stat) !== identity) return null;
  }
  for (const [relative, identity] of evidence) {
    const path = join(gitDirectory, relative);
    const stat = nativeWindows
      ? localFs.lstatBigint(ordinaryLocalRoute(path).verdict)
      : lstatSync(path, { bigint: true });
    if (stat === undefined || metadataIdentity(stat) !== identity) return null;
  }
  evidence.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const stateFingerprint = createHash("sha256").update(JSON.stringify([provenance, evidence])).digest("hex");
  return { gitDirectory, workTree, referenceBackend: "files", stateFingerprint };
}

function ordinaryLocalRoute(path: string) {
  const route = admitLocalRoute(path);
  if (route.followedLink || route.physical !== path) throw new Error("Git metadata path changed during inspection");
  return route;
}
