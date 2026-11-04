/**
 * Home content trust (the approval manifest). A trusted input in AVE_HOME loads only when the bytes Ave read, hashed and parsed
 * from one no-follow buffer match an entry of `config/.ave-trust-manifest.json`, which is itself read on the verified `config/`
 * boundary, or when Ave wrote those bytes in this run through a recorded write. An absent, unreadable or mismatching manifest or
 * entry means untrusted; no history, record or write failure ever grants trust. Owner and ACL evidence can only withdraw trust (R1).
 *
 * The gate is active for the one home boot evaluated in this process. A process that never booted (tests of single stores) reads
 * these files as before, the same scope slice 1 gives `isInRefusedAveHome`.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isMissingPathError, setAtomicWriteGuard, type AtomicWriteTicket } from "../lib/atomic-file.js";
import { AveHomeConfigurationRefusedWriteError, aveHomeRefusalReason, isAveHomeConfigurationRefused, isInRefusedAveHome, removeWindowsItemNoFollow, type AveHomeRefusalReason } from "./ave-home.js";
import { AveHomeConfigurationNotOwnerError, isAveHomeConfigurationOwner, readAveHomeTrustManifestBytes, writeAveHomeTrustManifestSync } from "./ave-home-configuration-access.js";
import { readWindowsDacls, windowsOwnerRules, type WindowsDaclFacts } from "./windows-path-facts.js";
import { WINDOWS_WORKSPACE_TRUSTED_WRITERS } from "./windows-home-boundary.js";

export type AveHomeTrustState = "fresh" | "bootstrapped:false" | "bootstrapped:true";

interface ManifestEntry {
  /** The SHA-256 (hex) Ave last wrote or the user approved. */
  current?: string;
  /** The intent hash of a write in flight: recorded before the write, collapsed into `current` after it (R5). */
  pendingWrite?: string;
}

interface TrustManifest {
  version: 1;
  state: AveHomeTrustState;
  /**
   * Set when this manifest was not the one a clean first commit wrote: a moved `config/` sat beside the home at that commit
   * (D3①), or the manifest was missing or unreadable and recreated. "Approve all" is never offered; each item is reviewed.
   */
  oneByOne?: true;
  entries: Record<string, ManifestEntry>;
}

/** Why an input reads as untrusted. */
export type AveHomeTrustReason = "new" | "changed" | "link" | "unreadable" | "foreign-owner" | "foreign-access" | "home-refused" | "home-recovery";

export type AveHomeInput =
  | { status: "absent" }
  | { status: "trusted"; bytes: Buffer }
  | { status: "untrusted"; bytes: Buffer; reason: AveHomeTrustReason };

export type AveHomeEntry =
  | { status: "absent" }
  | { status: "trusted" | "untrusted"; kind: "file"; bytes: Buffer; reason?: AveHomeTrustReason }
  | { status: "trusted" | "untrusted"; kind: "tree"; files: ReadonlyMap<string, Buffer>; reason?: AveHomeTrustReason };

interface ActiveTrust {
  readonly home: string;
  /** Undefined while the manifest is usable; otherwise every input is untrusted and nothing can be approved. */
  readonly unavailable?: AveHomeRefusalReason;
  manifest: TrustManifest;
  /** Keys whose owner or ACL evidence withdraws trust for this run (R1). Evidence read later only adds to it. */
  readonly withdrawn: Map<string, "foreign-owner" | "foreign-access">;
  /** Whether every evidence read so far (at boot and at each review) found no foreign owner or ACE and itself succeeded. */
  evidenceClean: boolean;
  readonly pendingAtBoot: boolean;
}

let active: ActiveTrust | undefined;
let reviewSnapshot: { id: string; rows: readonly AveHomeTrustRow[] } | undefined;

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_TREE_FILES = 4096;
const MAX_TREE_BYTES = 64 * 1024 * 1024;

/** Single files covered by the manifest, relative to the home. */
const COVERED_FILES: readonly string[] = Object.freeze([
  "permissions.json",
  "permissions/user-approvals.json",
  "permissions/shell-egress-hosts.json",
  "permissions/reviewer-cache.jsonl",
  "mcp/servers.json",
  "mcp/servers.json.bak",
  "governance/mcp-policy.json",
  "plugins/registry.json",
  "plugins/.cache/plugin-contribution-trust/hooks.json",
  "plugins/.cache/plugin-contribution-trust/mcp-servers.json",
  "agent-plugin-trust/hooks/approvals.json",
  "agent-plugin-trust/mcp/approvals.json",
  "skill-approvals.json",
  "routine/routines.json",
  "marketplaces/sources.json",
  "AGENTS.md",
  "agents.custom.md",
  "user-preferences.md",
  "memories/MEMORY.md",
  // Marketplace install records: their digests vouch for installed packages, like a plugin install receipt.
  "packages/ledger.json",
  "packages/mcp-installs.json",
]);

/** Directories whose every first-level entry (a file, or a whole tree hashed as one item) is an item. */
const ENTRY_DIRECTORIES: readonly string[] = Object.freeze(["skills", "agents", "commands"]);

function foldKey(rel: string): string {
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

const COVERED_FILE_KEYS = new Set(COVERED_FILES.map(foldKey));

/**
 * The manifest key of a covered input at `segments` below the home, or undefined when the path is not covered. `entry` marks a
 * first-level item of skills/, agents/ or commands/; `inside` marks a path within such a tree item, which has no key of its own.
 */
function coveredKey(segments: readonly string[]): { key: string; kind: "file" | "entry" | "inside" } | undefined {
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  const folded = segments.map(foldKey);
  const rel = folded.join("/");
  if (COVERED_FILE_KEYS.has(rel)) return { key: rel, kind: "file" };
  const [first, second, third, fourth] = folded;
  if (ENTRY_DIRECTORIES.includes(first!) && second !== undefined && !second.startsWith(".")) {
    return { key: `${first}/${second}`, kind: segments.length === 2 ? "entry" : "inside" };
  }
  if (folded.length === 3 && first === "permissions" && second === "project-rules" && !third!.startsWith(".")) return { key: rel, kind: "file" };
  if (folded.length === 4 && first === "plugins" && second === ".cache" && !third!.startsWith(".") && fourth === "install-receipt.json") {
    return { key: rel, kind: "file" };
  }
  if (first === "marketplaces" && second !== undefined && !second.startsWith(".")) {
    if (folded.length === 3 && third === "state.json") return { key: rel, kind: "file" };
    if (folded.length === 4 && third === "snapshots" && !fourth!.startsWith(".")) return { key: rel, kind: "file" };
  }
  return undefined;
}

function homeSegments(home: string, path: string): string[] | undefined {
  const rel = relative(resolve(home), resolve(path));
  if (rel === "" || rel.startsWith("..") || resolve(rel) === rel) return undefined;
  return rel.split(sep);
}

/** The active trust and the covered key of `path`, when the gate applies to it. */
function gateFor(path: string): { trust: ActiveTrust; key: string; kind: "file" | "entry" | "inside" } | undefined {
  if (active === undefined) return undefined;
  const segments = homeSegments(active.home, path);
  const covered = segments === undefined ? undefined : coveredKey(segments);
  return covered === undefined ? undefined : { trust: active, ...covered };
}

class LinkedInputError extends Error {
  constructor(path: string) {
    super(`${path} is a link or not a regular file`);
    this.name = "LinkedInputError";
  }
}

/** Two names in one directory fold to the same key on Windows (a case-sensitive directory): which one loads is ambiguous. */
class AmbiguousInputError extends Error {
  constructor(path: string) {
    super(`${path} holds names that differ only in case`);
    this.name = "AmbiguousInputError";
  }
}

/** Every component from the home down to `path` must be a real directory or, last, a regular file: no link, junction or reparse point. */
function assertNoLinkBelow(home: string, path: string): Stats | undefined {
  const segments = homeSegments(home, path) ?? [];
  let current = resolve(home);
  let entry: Stats | undefined;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    try { entry = lstatSync(current); }
    catch (error) { if (isMissingPathError(error)) return undefined; throw error; }
    if (entry.isSymbolicLink()) throw new LinkedInputError(current);
    if (index < segments.length - 1 && !entry.isDirectory()) return undefined;
  }
  return entry;
}

/** The bytes of one regular file read through a no-follow handle whose identity matches its pinned entry, or undefined when absent. */
function readRegularFile(path: string, pinned: Stats): { bytes: Buffer; uid: number } {
  if (!pinned.isFile()) throw new LinkedInputError(path);
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== pinned.ino || opened.dev !== pinned.dev) throw new Error(`${path} changed while it was opened`);
    if (opened.size > MAX_INPUT_BYTES) throw new Error(`${path} exceeds the size limit`);
    const bytes = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < bytes.length) {
      const count = readSync(descriptor, bytes, filled, bytes.length - filled, filled);
      if (count === 0) break;
      filled += count;
    }
    return { bytes: bytes.subarray(0, filled), uid: opened.uid };
  } finally { closeSync(descriptor); }
}

/**
 * Item digests carry their kind, so a tree item and a file item can never share a hash: an attacker who swaps an approved
 * directory for a file holding its serialization (or the reverse) gets a different digest. Covered single files keep the plain
 * SHA-256 of their bytes; their keys are never item keys.
 */
function treeDigestOf(files: ReadonlyMap<string, Buffer>): string {
  const lines = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, bytes]) => `${path}\0${sha256Hex(bytes)}\n`);
  return sha256Hex(`ave-tree-v1\n${lines.join("")}`);
}

function entryFileDigestOf(bytes: Uint8Array | string): string {
  return sha256Hex(`ave-file-v1\n${sha256Hex(bytes)}`);
}

/** The tree digest of in-memory files keyed by POSIX relative paths: what a no-follow read of the same tree on disk yields. */
export function aveHomeTreeDigest(files: ReadonlyMap<string, Buffer>): string {
  return treeDigestOf(files);
}

/** The tree digest of `root` read without following any link; a link, special file or (Windows) case collision throws. */
export function readAveHomeTreeDigestSync(root: string): string {
  const entry = lstatSync(root);
  if (!entry.isDirectory()) throw new LinkedInputError(root);
  return treeDigestOf(readTree(root).files);
}

/** A tree's files by POSIX relative path. Inside the gate a link anywhere rejects the tree; outside it (`follow`) links are read through. */
function readTree(root: string): { files: Map<string, Buffer>; uids: Set<number> } {
  const files = new Map<string, Buffer>();
  const uids = new Set<number>();
  let total = 0;
  const walk = (directory: string, prefix: string): void => {
    const names = readdirSync(directory).sort();
    if (process.platform === "win32" && new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new AmbiguousInputError(directory);
    for (const name of names) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (entry.isSymbolicLink()) throw new LinkedInputError(path);
      if (entry.isDirectory()) { walk(path, rel); continue; }
      if (!entry.isFile()) throw new LinkedInputError(path);
      const read = readRegularFile(path, entry);
      total += read.bytes.length;
      if (files.size >= MAX_TREE_FILES || total > MAX_TREE_BYTES) throw new Error(`${root} exceeds the size limit`);
      files.set(rel, read.bytes);
      uids.add(read.uid);
    }
  };
  walk(root, "");
  return { files, uids };
}

function entryMatches(entry: ManifestEntry | undefined, hash: string): boolean {
  return entry !== undefined && (entry.current === hash || entry.pendingWrite === hash);
}

/** Whether the evidence read with the bytes (POSIX owner) withdraws trust: a file another account owns was not written by Ave. */
function posixForeign(uids: Iterable<number>): boolean {
  if (process.platform === "win32") return false;
  const uid = process.geteuid!();
  for (const owner of uids) if (owner !== uid) return true;
  return false;
}

function verdict(trust: ActiveTrust, key: string, hash: string, uids: Iterable<number>): { trusted: true } | { trusted: false; reason: AveHomeTrustReason } {
  if (trust.unavailable !== undefined) return { trusted: false, reason: trust.unavailable === "recovery" ? "home-recovery" : "home-refused" };
  const withdrawn = trust.withdrawn.get(key);
  if (withdrawn !== undefined) return { trusted: false, reason: withdrawn };
  if (posixForeign(uids)) return { trusted: false, reason: "foreign-owner" };
  const entry = trust.manifest.entries[key];
  if (entryMatches(entry, hash)) return { trusted: true };
  return { trusted: false, reason: entry?.current === undefined ? "new" : "changed" };
}

/**
 * Read one covered file for loading: its trusted bytes, its untrusted bytes (for the closed restriction overlay only), or absent.
 * Loaders parse exactly the returned buffer and never reopen the path. Outside the gate this is a plain read, so a single store
 * under test behaves as before; a home refused at boot still reads untrusted.
 */
export function readAveHomeInputSync(path: string): AveHomeInput {
  const gate = gateFor(path);
  // A file that is (or sits inside) a first-level item of skills/, agents/ or commands/ is vouched for by that whole item.
  if (gate !== undefined && gate.kind !== "file") return readThroughEntry(gate.trust.home, gate.key, path);
  if (gate === undefined) {
    if (isInRefusedAveHome(path)) return readRefusedInput(path);
    try { return { status: "trusted", bytes: readFileSync(path) }; }
    catch (error) { if (isMissingPathError(error)) return { status: "absent" }; throw error; }
  }
  let pinned: Stats | undefined;
  try { pinned = assertNoLinkBelow(gate.trust.home, path); }
  catch (error) {
    if (!(error instanceof LinkedInputError)) throw error;
    return { status: "untrusted", bytes: Buffer.alloc(0), reason: "link" };
  }
  if (pinned === undefined) return { status: "absent" };
  let read: { bytes: Buffer; uid: number };
  try { read = readRegularFile(path, pinned); }
  catch (error) {
    if (isMissingPathError(error)) return { status: "absent" };
    if (error instanceof LinkedInputError) return { status: "untrusted", bytes: Buffer.alloc(0), reason: "link" };
    throw error;
  }
  // An empty file nothing vouches for is what a file lock leaves before its first write: it holds no content, so it reads as
  // absent rather than pending. Once a hash is recorded for the key, an emptied file is a change like any other.
  if (isPlaceholder(gate.trust, gate.key, read.bytes)) return { status: "absent" };
  const decision = verdict(gate.trust, gate.key, sha256Hex(read.bytes), [read.uid]);
  return decision.trusted ? { status: "trusted", bytes: read.bytes } : { status: "untrusted", bytes: read.bytes, reason: decision.reason };
}

function isPlaceholder(trust: ActiveTrust, key: string, bytes: Buffer): boolean {
  return bytes.length === 0 && trust.unavailable === undefined && trust.manifest.entries[key] === undefined;
}

function isEmptyFile(path: string): boolean {
  try { const entry = lstatSync(path); return entry.isFile() && entry.size === 0; }
  catch { return false; }
}

function readThroughEntry(home: string, key: string, path: string): AveHomeInput {
  const entryPath = join(home, ...key.split("/"));
  const entry = readAveHomeEntrySync(entryPath);
  if (entry.status === "absent") return { status: "absent" };
  const reason = entry.status === "untrusted" ? entry.reason ?? "changed" : undefined;
  let bytes: Buffer | undefined;
  if (entry.kind === "file") {
    if (resolve(path) !== resolve(entryPath)) return { status: "absent" };
    bytes = entry.bytes;
  } else {
    const rel = relative(entryPath, resolve(path)).split(sep).join("/");
    bytes = entry.files.get(process.platform === "win32" ? [...entry.files.keys()].find((name) => name.toLowerCase() === rel.toLowerCase()) ?? rel : rel);
    if (bytes === undefined) return reason === undefined ? { status: "absent" } : { status: "untrusted", bytes: Buffer.alloc(0), reason };
  }
  return reason === undefined ? { status: "trusted", bytes } : { status: "untrusted", bytes, reason };
}

/** Async form for async loaders; the read itself is one synchronous no-follow buffer. */
export async function readAveHomeInput(path: string): Promise<AveHomeInput> {
  return readAveHomeInputSync(path);
}

/** The trusted bytes of a covered file, or undefined when it is absent or untrusted: untrusted content reads as absent. */
export function readTrustedAveHomeInputSync(path: string): Buffer | undefined {
  const input = readAveHomeInputSync(path);
  return input.status === "trusted" ? input.bytes : undefined;
}

function readRefusedInput(path: string): AveHomeInput {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return { status: "untrusted", bytes: Buffer.alloc(0), reason: "link" };
    return { status: "untrusted", bytes: readRegularFile(path, entry).bytes, reason: "home-refused" };
  } catch (error) {
    if (isMissingPathError(error)) return { status: "absent" };
    return { status: "untrusted", bytes: Buffer.alloc(0), reason: "unreadable" };
  }
}

/**
 * Outside the gate a tree item is read as before: each file on request, following links like the loaders always did, and
 * without walking the tree (which a link loop would never finish). It lists nothing; callers only look files up.
 */
class PlainTreeFiles extends Map<string, Buffer> {
  constructor(private readonly root: string) { super(); }
  override get(rel: string): Buffer | undefined {
    try { return readFileSync(join(this.root, ...rel.split("/"))); }
    catch (error) { if (isMissingPathError(error)) return undefined; throw error; }
  }
}

/** One first-level item of skills/, agents/ or commands/: a file, or a whole tree hashed as one item. */
export function readAveHomeEntrySync(path: string): AveHomeEntry {
  const gate = gateFor(path);
  if (gate === undefined || gate.kind !== "entry") {
    if (isInRefusedAveHome(path)) return { status: "untrusted", kind: "tree", files: new Map(), reason: "home-refused" };
    let entry: Stats;
    try { entry = lstatSync(path); }
    catch (error) { if (isMissingPathError(error)) return { status: "absent" }; throw error; }
    if (!entry.isDirectory()) return { status: "trusted", kind: "file", bytes: readFileSync(path) };
    return { status: "trusted", kind: "tree", files: new PlainTreeFiles(path) };
  }
  let pinned: Stats | undefined;
  try {
    pinned = assertNoLinkBelow(gate.trust.home, path);
    if (pinned === undefined) return { status: "absent" };
    if (pinned.isDirectory()) {
      const tree = readTree(path);
      const decision = verdict(gate.trust, gate.key, treeDigestOf(tree.files), tree.uids);
      return decision.trusted ? { status: "trusted", kind: "tree", files: tree.files }
        : { status: "untrusted", kind: "tree", files: tree.files, reason: decision.reason };
    }
    const read = readRegularFile(path, pinned);
    const decision = verdict(gate.trust, gate.key, entryFileDigestOf(read.bytes), [read.uid]);
    return decision.trusted ? { status: "trusted", kind: "file", bytes: read.bytes }
      : { status: "untrusted", kind: "file", bytes: read.bytes, reason: decision.reason };
  } catch (error) {
    if (isMissingPathError(error)) return { status: "absent" };
    if (error instanceof LinkedInputError) return { status: "untrusted", kind: "tree", files: new Map(), reason: "link" };
    if (error instanceof AmbiguousInputError) return { status: "untrusted", kind: "tree", files: new Map(), reason: "unreadable" };
    throw error;
  }
}

/** Whether a first-level skills/, agents/ or commands/ item may be listed and loaded. */
export function isAveHomeEntryTrusted(path: string): boolean {
  return readAveHomeEntrySync(path).status === "trusted";
}

function persist(trust: ActiveTrust): void {
  writeAveHomeTrustManifestSync(trust.home, `${JSON.stringify(trust.manifest, null, 2)}\n`);
}

/** Refuse a write that the gate does not allow; return the key to record, or undefined when the path is outside the gate. */
function admitWrite(path: string, action: string): { trust: ActiveTrust; key: string; kind: "file" | "entry" } | undefined {
  const gate = gateFor(path);
  if (gate === undefined || gate.kind === "inside") {
    if (gate !== undefined && gate.trust.unavailable !== undefined) throw new AveHomeConfigurationRefusedWriteError(path, action, gate.trust.unavailable);
    return undefined;
  }
  // Only the host-instance lock owner writes trusted inputs: a writer without it would leave drift or skip the record.
  if (!isAveHomeConfigurationOwner()) throw new AveHomeConfigurationNotOwnerError();
  if (gate.trust.unavailable !== undefined) throw new AveHomeConfigurationRefusedWriteError(path, action, gate.trust.unavailable);
  const current = gate.kind === "entry" ? readAveHomeEntrySync(path) : readAveHomeInputSync(path);
  // Rewriting a pending item from its absent view would erase content the user has not reviewed: review first.
  if (current.status === "untrusted") throw new AveHomeConfigurationRefusedWriteError(path, action, "pending");
  return { trust: gate.trust, key: gate.key, kind: gate.kind };
}

/**
 * Refuse, before a read-modify-write starts, a write the gate would refuse: a store that reads as absent in a refused home, a
 * pending item ("review first"), or a writer without the host-instance lock.
 */
export function assertAveHomeInputWritable(path: string, action = `change ${path}`): void {
  if (isInRefusedAveHome(path)) throw new AveHomeConfigurationRefusedWriteError(path, action);
  admitWrite(path, action);
}

/** The hashes of this run's writes still in flight, per key, oldest first. Only Ave's own intents are ever listed here. */
const inFlight = new Map<string, string[]>();
/** Per key, the hashes of the writes that overlapped since the key last had none in flight, minus those that failed. */
const overlapping = new Map<string, Set<string>>();

/** Set `key`'s entry to `current` plus the newest write still in flight, if any. */
function settle(trust: ActiveTrust, key: string, current: string | undefined): void {
  const pending = inFlight.get(key)?.at(-1);
  if (current === undefined && pending === undefined) delete trust.manifest.entries[key];
  else trust.manifest.entries[key] = { ...(current !== undefined ? { current } : {}), ...(pending !== undefined ? { pendingWrite: pending } : {}) };
}

function dropInFlight(key: string, hash: string, failed: boolean): void {
  const list = inFlight.get(key);
  if (list === undefined) return;
  const index = list.indexOf(hash);
  if (index >= 0) list.splice(index, 1);
  if (failed && !list.includes(hash)) overlapping.get(key)?.delete(hash);
  if (list.length === 0) { inFlight.delete(key); overlapping.delete(key); }
}

/**
 * The hash now on disk when it is one of this run's own overlapping writes to `key`, so writes that overlap settle on whichever
 * rename landed last instead of on the order their callbacks ran. Without an overlap, or for anything else on disk (absent,
 * foreign, unreadable), it is the committing write's hash, and a mismatch then reads as changed.
 */
function landedHash(trust: ActiveTrust, key: string, kind: "file" | "entry", own: string): string {
  const group = overlapping.get(key);
  if (group === undefined || group.size <= 1) return own;
  const path = join(trust.home, ...key.split("/"));
  const disk = currentHash({ key, path, kind }, trust.home)?.hash;
  return disk !== undefined && group.has(disk) ? disk : own;
}

function stage(trust: ActiveTrust, key: string, kind: "file" | "entry", hash: string): AtomicWriteTicket {
  const before = trust.manifest.entries[key];
  inFlight.set(key, [...(inFlight.get(key) ?? []), hash]);
  overlapping.set(key, (overlapping.get(key) ?? new Set()).add(hash));
  // One persisted slot: the newest write's intent. Older writes still in flight stay listed in memory.
  settle(trust, key, before?.current);
  try { persist(trust); }
  catch (error) {
    dropInFlight(key, hash, true);
    settle(trust, key, before?.current);
    throw error;
  }
  return {
    committed: () => {
      const landed = landedHash(trust, key, kind, hash);
      dropInFlight(key, hash, false);
      settle(trust, key, landed);
      // The intent already vouches for these bytes, so a failed collapse strands nothing; boot collapses it.
      try { persist(trust); } catch { /* collapsed at the next boot */ }
    },
    failed: () => {
      // A failed write clears its own intent at once, so restored old bytes that happen to match it never become trusted (R5).
      // What another write committed meanwhile stays current.
      dropInFlight(key, hash, true);
      settle(trust, key, trust.manifest.entries[key]?.current);
      try { persist(trust); } catch { /* the in-memory slot is already cleared; boot drops any stale intent */ }
    },
  };
}

/** The atomic-file guard: every whole-file write of a covered input is admitted, staged and recorded. */
function guardWrite(path: string, content: string | Uint8Array): AtomicWriteTicket | undefined {
  const admitted = admitWrite(path, `change ${path}`);
  if (admitted === undefined) return undefined;
  return stage(admitted.trust, admitted.key, admitted.kind, admitted.kind === "entry" ? entryFileDigestOf(content) : sha256Hex(content));
}

/** Record a write that does not go through the atomic-file helpers: `bytes` is exactly what `write` puts at `path`. */
export function recordAveHomeInputWriteSync<T>(path: string, bytes: string | Uint8Array, write: () => T): T {
  const ticket = guardWrite(path, bytes);
  if (ticket === undefined) return write();
  let result: T;
  try { result = write(); }
  catch (error) { ticket.failed(); throw error; }
  ticket.committed();
  return result;
}

/** Drop the entry of an input Ave deleted, so old bytes restored later do not match a stale hash. */
export function forgetAveHomeInputSync(path: string): void {
  const gate = gateFor(path);
  if (gate === undefined || gate.kind === "inside" || gate.trust.unavailable !== undefined) return;
  if (gate.trust.manifest.entries[gate.key] === undefined) return;
  if (!isAveHomeConfigurationOwner()) throw new AveHomeConfigurationNotOwnerError();
  delete gate.trust.manifest.entries[gate.key];
  persist(gate.trust);
}

/** One covered input that exists on disk. */
interface CoveredInput {
  /** The manifest key: `name` folded the way the manifest compares names on this platform. */
  readonly key: string;
  /** The path below the home as written (Ave's spelling of a covered file, or the on-disk name); what the review shows. */
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "entry";
  /**
   * Set for something that cannot be approved, only removed: a directory Ave enumerates for items that is itself a link or not a
   * directory (its items would otherwise never show), or a name that collides with another one when case is folded.
   */
  readonly blocked?: "link" | "unreadable";
}

/** The names in an enumerated directory; `linked` when the directory itself is a link or not a directory. */
function listDirectory(path: string): { names: string[]; linked: boolean } {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory()) return { names: [], linked: true };
    return { names: readdirSync(path).sort(), linked: false };
  } catch (error) {
    if (isMissingPathError(error)) return { names: [], linked: false };
    throw error;
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (isMissingPathError(error)) return false; throw error; }
}

/** Every covered input present in `home`, in a stable order. */
export function listAveHomeCoveredInputs(home: string): CoveredInput[] {
  const root = resolve(home);
  const found: CoveredInput[] = [];
  const keys = new Set<string>();
  const add = (rel: string, kind: "file" | "entry") => {
    const path = join(root, ...rel.split("/"));
    if (!exists(path)) return;
    const key = foldKey(rel);
    if (keys.has(key)) {
      // A second name with the same folded key: neither can be approved, since an approval could not say which one it vouches for.
      for (let index = 0; index < found.length; index++) if (found[index]!.key === key) found[index] = { ...found[index]!, blocked: "unreadable" };
      found.push({ key, name: rel, path, kind, blocked: "unreadable" });
      return;
    }
    keys.add(key);
    found.push({ key, name: rel, path, kind });
  };
  const list = (rel: string): string[] => {
    const listing = listDirectory(join(root, ...rel.split("/")));
    if (listing.linked) found.push({ key: foldKey(rel), name: rel, path: join(root, ...rel.split("/")), kind: "file", blocked: "link" });
    return listing.names.filter((name) => !name.startsWith("."));
  };
  for (const rel of COVERED_FILES) add(rel, "file");
  for (const name of list("permissions/project-rules")) add(`permissions/project-rules/${name}`, "file");
  for (const name of list("plugins/.cache")) add(`plugins/.cache/${name}/install-receipt.json`, "file");
  for (const name of list("marketplaces")) {
    add(`marketplaces/${name}/state.json`, "file");
    for (const snapshot of list(`marketplaces/${name}/snapshots`)) add(`marketplaces/${name}/snapshots/${snapshot}`, "file");
  }
  for (const directory of ENTRY_DIRECTORIES) for (const name of list(directory)) add(`${directory}/${name}`, "entry");
  return found;
}

/** The manifest a commit writes fresh: `fresh` for a home with nothing to vouch for, else every existing item is pending. */
/**
 * The manifest a commit writes fresh: `fresh` for a home with nothing to vouch for, else every existing item is pending. A
 * moved `config/` candidate beside the home (D3①) is recorded in the manifest itself, so no later boot offers "approve all".
 */
export function initialAveHomeTrustManifest(home: string, legacyRootConfiguration: boolean, movedConfiguration = false): string {
  const state: AveHomeTrustState = legacyRootConfiguration || listAveHomeCoveredInputs(home).some((input) => !isEmptyFile(input.path)) ? "bootstrapped:false" : "fresh";
  return `${JSON.stringify({ version: 1, state, ...(movedConfiguration ? { oneByOne: true } : {}), entries: {} } satisfies TrustManifest, null, 2)}\n`;
}

function parseManifest(bytes: Buffer): TrustManifest | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { version, state, entries, oneByOne } = parsed as Partial<TrustManifest>;
  if (version !== 1 || (state !== "fresh" && state !== "bootstrapped:false" && state !== "bootstrapped:true")) return undefined;
  if (oneByOne !== undefined && oneByOne !== true) return undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return undefined;
  const clean: Record<string, ManifestEntry> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { current, pendingWrite } = value as ManifestEntry;
    if ((current !== undefined && !/^[0-9a-f]{64}$/.test(current)) || (pendingWrite !== undefined && !/^[0-9a-f]{64}$/.test(pendingWrite))) return undefined;
    if (current === undefined && pendingWrite === undefined) continue;
    clean[key] = { ...(current !== undefined ? { current } : {}), ...(pendingWrite !== undefined ? { pendingWrite } : {}) };
  }
  return { version: 1, state, ...(oneByOne ? { oneByOne } : {}), entries: clean };
}

/** The hash of an input as it is on disk now, or undefined when it is absent, a link or unreadable. */
function currentHash(input: Omit<CoveredInput, "name">, home: string): { hash: string; uids: number[]; bytes?: Buffer; files?: readonly string[] } | undefined {
  try {
    const pinned = assertNoLinkBelow(home, input.path);
    if (pinned === undefined) return undefined;
    if (input.kind === "entry" && pinned.isDirectory()) {
      const tree = readTree(input.path);
      return { hash: treeDigestOf(tree.files), uids: [...tree.uids], files: [...tree.files.keys()] };
    }
    const read = readRegularFile(input.path, pinned);
    return { hash: input.kind === "entry" ? entryFileDigestOf(read.bytes) : sha256Hex(read.bytes), uids: [read.uid], bytes: read.bytes };
  } catch {
    return undefined;
  }
}

const WINDOWS_TRUSTED_OWNERS = new Set(["S-1-5-18", "S-1-5-32-544"]);

/** The Windows owner/ACL overlay: owner or ACE evidence of another principal withdraws an item's trust for this run (R1). */
function windowsEvidence(home: string, inputs: readonly CoveredInput[]): { withdrawn: Map<string, "foreign-owner" | "foreign-access">; clean: boolean } {
  if (process.platform !== "win32" || inputs.length === 0) return { withdrawn: new Map(), clean: true };
  const paths: string[] = [];
  const keys: string[] = [];
  for (const input of inputs) {
    paths.push(input.path);
    keys.push(input.key);
    // The directories between the home and the item too: an ACE granting another principal write on a parent lets it replace the item.
    const segments = homeSegments(home, input.path) ?? [];
    for (let depth = 1; depth < segments.length; depth++) { paths.push(join(resolve(home), ...segments.slice(0, depth))); keys.push(input.key); }
    if (input.kind === "entry") {
      try {
        if (lstatSync(input.path).isDirectory()) {
          for (const rel of readTree(input.path).files.keys()) { paths.push(join(input.path, ...rel.split("/"))); keys.push(input.key); }
        }
      } catch { /* hashing marks it untrusted */ }
    }
  }
  let facts: readonly WindowsDaclFacts[];
  try { facts = readWindowsDacls(paths); }
  catch { return { withdrawn: new Map(), clean: false }; }
  return classifyWindowsHomeEvidence(facts, keys);
}

/**
 * Classify the owner and DACL facts read for each covered key (one row per path, `keys[i]` naming the item `facts[i]` belongs
 * to). Pure, so the Windows overlay is tested on every platform.
 */
export function classifyWindowsHomeEvidence(facts: readonly WindowsDaclFacts[], keys: readonly string[]): { withdrawn: Map<string, "foreign-owner" | "foreign-access">; clean: boolean } {
  const withdrawn = new Map<string, "foreign-owner" | "foreign-access">();
  let clean = facts.length === keys.length;
  facts.forEach((row, index) => {
    const key = keys[index]!;
    if (row.exists !== true || !row.dacl) { clean = false; return; }
    const user = row.currentUserSid;
    if (row.dacl.owner !== user && !WINDOWS_TRUSTED_OWNERS.has(row.dacl.owner ?? "")) {
      withdrawn.set(key, "foreign-owner");
      clean = false;
      return;
    }
    let rules;
    try { rules = windowsOwnerRules(row.dacl); }
    catch { withdrawn.set(key, "foreign-access"); clean = false; return; }
    if (rules.some((rule) => rule.accessControlType === 0 && rule.sid !== user && !WINDOWS_WORKSPACE_TRUSTED_WRITERS.has(rule.sid))) {
      if (!withdrawn.has(key)) withdrawn.set(key, "foreign-access");
      clean = false;
    }
  });
  return { withdrawn, clean };
}

export interface AveHomeTrustVerdict {
  /** Any covered input is untrusted, or the manifest is unavailable: confinement is forced for this boot. */
  readonly pending: boolean;
  readonly state?: AveHomeTrustState;
  readonly unavailable?: AveHomeRefusalReason;
}

/**
 * Evaluate the manifest once per boot, right after the configuration commit and before any loader runs. The lock owner writes
 * the initial state when a committed home has none and collapses `pendingWrite` intents (R5). Registers the write guard.
 */
export function evaluateAveHomeTrustAtBoot(home: string): AveHomeTrustVerdict {
  const root = resolve(home);
  reviewSnapshot = undefined;
  const refusal = isAveHomeConfigurationRefused(root) ? aveHomeRefusalReason(root) : undefined;
  if (refusal !== undefined) {
    active = { home: root, unavailable: refusal, manifest: { version: 1, state: "bootstrapped:false", entries: {} }, withdrawn: new Map(), evidenceClean: false, pendingAtBoot: true };
    setAtomicWriteGuard(guardWrite);
    return { pending: true, unavailable: refusal };
  }
  const inputs = listAveHomeCoveredInputs(root);
  const bytes = readAveHomeTrustManifestBytes(root);
  let manifest = bytes === undefined ? undefined : parseManifest(bytes);
  let changed = false;
  if (manifest === undefined) {
    // Absent or unreadable: never trusted, and every existing item is pending. Absent is the expected state of a home whose
    // config/ was committed before the manifest existed, so it keeps "approve all" (D1, still gated on clean evidence and every
    // row approvable). Bytes that are present but do not parse are damage: those items are reviewed one by one.
    const corrupt = bytes !== undefined;
    manifest = inputs.length === 0 ? { version: 1, state: "fresh", entries: {} }
      : { version: 1, state: "bootstrapped:false", ...(corrupt ? { oneByOne: true as const } : {}), entries: {} };
    changed = true;
  }
  const byKey = new Map(inputs.map((input) => [input.key, input]));
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (entry.pendingWrite === undefined) continue;
    const input = byKey.get(key);
    const hash = input === undefined ? undefined : currentHash(input, root)?.hash;
    // A file matching its intent collapses into `current`; anything else drops the intent, so a stale one never vouches later.
    manifest.entries[key] = hash === entry.pendingWrite ? { current: entry.pendingWrite } : { ...(entry.current !== undefined ? { current: entry.current } : {}) };
    if (manifest.entries[key]!.current === undefined) delete manifest.entries[key];
    changed = true;
  }
  const evidence = windowsEvidence(root, inputs);
  active = { home: root, manifest, withdrawn: evidence.withdrawn, evidenceClean: evidence.clean, pendingAtBoot: false };
  if (changed && isAveHomeConfigurationOwner()) persist(active);
  const pending = reviewRows(active).length > 0;
  active = { ...active, pendingAtBoot: pending };
  setAtomicWriteGuard(guardWrite);
  return { pending, state: manifest.state };
}

/** Whether this boot found any untrusted input; read by sandbox-init to force confinement. Never consults settings. */
export function isAveHomeTrustPendingAtBoot(): boolean {
  return active?.pendingAtBoot === true;
}

export interface AveHomeTrustRow {
  readonly key: string;
  readonly path: string;
  readonly kind: "file" | "entry";
  /** The hash Approve records; absent when the item cannot be hashed (a link, or unreadable). */
  readonly hash?: string;
  readonly reason: AveHomeTrustReason;
  /** Withdrawn by owner/ACL evidence or unhashable: only Remove is offered. */
  readonly approvable: boolean;
  /** What the item would run or allow, from the same bytes as `hash`, with arguments, environment, headers and URL credentials left out. */
  readonly summary?: string;
}

const SUMMARY_LIMIT = 12;

function listed(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const shown = names.slice(0, SUMMARY_LIMIT).join(", ");
  return names.length > SUMMARY_LIMIT ? `${shown}, +${names.length - SUMMARY_LIMIT}` : shown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The program name only: a path is cut to its last segment, so no home path or argument reaches the card. */
function programName(command: unknown): string {
  if (typeof command !== "string" || command.trim() === "") return "?";
  const first = command.trim().split(/\s+/)[0]!;
  return first.split(/[\\/]/).pop() || "?";
}

/** A URL reduced to its scheme and host: user info, path, query and fragment can carry credentials. */
function urlHost(url: unknown): string {
  if (typeof url !== "string") return "?";
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}`; }
  catch { return "?"; }
}

/**
 * The masked summary of one pending item, for the review card. Unparseable content gets no summary; the path and hash still show.
 * Exported for the masking test.
 */
export function summarizeAveHomeInput(key: string, current: { bytes?: Buffer; files?: readonly string[] }): string | undefined {
  if (current.files !== undefined) return listed(current.files);
  if (current.bytes === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(current.bytes.toString("utf8")); }
  catch { return undefined; }
  const doc = record(parsed);
  if (doc === undefined) return undefined;
  if (key === "mcp/servers.json" || key === "mcp/servers.json.bak") {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    return listed(servers.map((value) => {
      const server = record(value);
      return `${String(server?.name ?? "?")}: ${server?.url !== undefined ? urlHost(server.url) : programName(server?.command)}`;
    }));
  }
  if (key === "plugins/registry.json") {
    const plugins = Array.isArray(doc.plugins) ? doc.plugins : [];
    return listed(plugins.map((entry) => String(record(entry)?.id ?? "?")));
  }
  if (key.startsWith("plugins/.cache/") && key.endsWith("/install-receipt.json")) {
    return `${String(doc.pluginId ?? "?")}@${String(doc.version ?? "?")}`;
  }
  if (key === "permissions.json") {
    const allow = (Array.isArray(doc.rules) ? doc.rules : []).filter((rule) => record(rule)?.action === "allow").map((rule) => String(record(rule)!.pattern));
    return `mode ${String(doc.mode ?? "?")}; allow ${listed(allow) ?? "none"}`;
  }
  return undefined;
}

function reviewRows(trust: ActiveTrust): AveHomeTrustRow[] {
  const rows: AveHomeTrustRow[] = [];
  for (const input of listAveHomeCoveredInputs(trust.home)) {
    if (input.blocked !== undefined) {
      rows.push({ key: input.name, path: input.path, kind: input.kind, reason: input.blocked, approvable: false });
      continue;
    }
    const current = currentHash(input, trust.home);
    if (current?.bytes !== undefined && input.kind === "file" && isPlaceholder(trust, input.key, current.bytes)) continue;
    if (current === undefined) {
      let reason: AveHomeTrustReason = "unreadable";
      try { assertNoLinkBelow(trust.home, input.path); } catch (error) { if (error instanceof LinkedInputError) reason = "link"; }
      rows.push({ key: input.name, path: input.path, kind: input.kind, reason, approvable: false });
      continue;
    }
    const decision = verdict(trust, input.key, current.hash, current.uids);
    if (decision.trusted) continue;
    const withdrawn = decision.reason === "foreign-owner" || decision.reason === "foreign-access";
    const blocked = decision.reason === "home-refused" || decision.reason === "home-recovery";
    const summary = summarizeAveHomeInput(input.key, current);
    rows.push({
      key: input.name, path: input.path, kind: input.kind, hash: current.hash, reason: decision.reason, approvable: !withdrawn && !blocked,
      ...(summary !== undefined ? { summary } : {}),
    });
  }
  return rows;
}

/**
 * Read the owner/ACL evidence again for what is on disk now, so an item that appeared or changed after boot is judged on its
 * own evidence before the card offers it. Evidence only withdraws (R1): nothing read here makes an item trusted.
 */
function refreshEvidence(trust: ActiveTrust): void {
  const evidence = windowsEvidence(trust.home, listAveHomeCoveredInputs(trust.home));
  for (const [key, reason] of evidence.withdrawn) if (!trust.withdrawn.has(key)) trust.withdrawn.set(key, reason);
  if (!evidence.clean) trust.evidenceClean = false;
}

export interface AveHomeTrustReview {
  readonly snapshotId: string;
  readonly state?: AveHomeTrustState;
  /** The manifest cannot be used this boot: nothing can be approved until the folder is fixed. */
  readonly unavailable?: AveHomeRefusalReason;
  /** With `unavailable: "recovery"`: the configuration folder to move aside, so the card can name it. */
  readonly configurationFolder?: string;
  readonly rows: readonly AveHomeTrustRow[];
  /** "Approve all" (D1①): only for an explicit `bootstrapped:false` manifest with clean evidence, on a home not refused now. */
  readonly approveAllOffered: boolean;
  /** The verdict this boot ran under: approved items load after a restart. */
  readonly pendingAtBoot: boolean;
}

/** What the review IPC serves: the review plus whether extensions actually run confined this boot (a backend may be missing). */
export interface AveHomeTrustReviewView extends AveHomeTrustReview {
  readonly extensionsConfined: boolean;
}

/** The review the card renders. Approve and Remove act only on the rows of this exact snapshot, with the hashes it showed. */
export function getAveHomeTrustReview(): AveHomeTrustReview | undefined {
  const trust = active;
  if (trust === undefined) return undefined;
  if (trust.unavailable === undefined) refreshEvidence(trust);
  const rows = trust.unavailable === undefined ? reviewRows(trust) : [];
  const snapshotId = randomUUID();
  reviewSnapshot = { id: snapshotId, rows };
  const approveAllOffered = trust.unavailable === undefined && approveAllAllowed(trust, rows) && rows.length > 0;
  return {
    snapshotId,
    ...(trust.unavailable === undefined ? { state: trust.manifest.state } : { unavailable: trust.unavailable }),
    ...(trust.unavailable === "recovery" ? { configurationFolder: join(trust.home, "config") } : {}),
    rows,
    approveAllOffered,
    pendingAtBoot: trust.pendingAtBoot,
  };
}

/** Thrown for a review action the host cannot honour; the message is safe to show. */
export class AveHomeTrustReviewError extends Error {
  constructor(readonly code: "unavailable" | "stale" | "not-approvable" | "not-offered", message: string) {
    super(message);
    this.name = "AveHomeTrustReviewError";
  }
}

/** D1①: one click only for an explicit `bootstrapped:false` manifest a clean commit wrote, with clean evidence and every row approvable. */
function approveAllAllowed(trust: ActiveTrust, rows: readonly AveHomeTrustRow[]): boolean {
  return trust.manifest.state === "bootstrapped:false" && trust.manifest.oneByOne !== true && trust.evidenceClean && rows.every((row) => row.approvable);
}

function reviewTarget(snapshotId: string): { trust: ActiveTrust; rows: readonly AveHomeTrustRow[] } {
  const trust = active;
  if (trust === undefined || trust.unavailable !== undefined || isAveHomeConfigurationRefused(trust.home)) {
    throw new AveHomeTrustReviewError("unavailable", trust?.unavailable === "recovery"
      ? "Ave's configuration folder is incomplete. Move it aside and restart Ave first."
      : "Fix the Ave folder permissions first, then restart Ave.");
  }
  if (reviewSnapshot === undefined || reviewSnapshot.id !== snapshotId) throw new AveHomeTrustReviewError("stale", "The review changed. Reopen it and try again.");
  return { trust, rows: reviewSnapshot.rows };
}

/**
 * A row names the item as written; the caller's key may differ in case where the platform folds names (win32), so it matches by
 * the manifest's folded key. An exact match wins, so two names that fold together (both shown blocked) stay distinct.
 */
function reviewRow(rows: readonly AveHomeTrustRow[], key: string): AveHomeTrustRow | undefined {
  return rows.find((candidate) => candidate.key === key) ?? rows.find((candidate) => foldKey(candidate.key) === foldKey(key));
}

/**
 * Approve rows of the served snapshot, recording exactly the hashes it rendered; nothing is re-read at click time. Without keys
 * this is "approve all", offered only under the D1① rule. The caller has already checked the host sender and a user gesture.
 */
export function approveAveHomeTrustItems(snapshotId: string, keys?: readonly string[]): number {
  const { trust, rows } = reviewTarget(snapshotId);
  if (!isAveHomeConfigurationOwner()) throw new AveHomeConfigurationNotOwnerError();
  let selected: readonly AveHomeTrustRow[];
  if (keys === undefined) {
    if (!approveAllAllowed(trust, rows)) throw new AveHomeTrustReviewError("not-offered", "Approve the items one by one.");
    selected = rows;
  } else {
    selected = keys.map((key) => {
      const row = reviewRow(rows, key);
      if (row === undefined) throw new AveHomeTrustReviewError("stale", "The review changed. Reopen it and try again.");
      return row;
    });
  }
  for (const row of selected) {
    if (!row.approvable || row.hash === undefined) throw new AveHomeTrustReviewError("not-approvable", `${row.path} cannot be approved; remove it instead.`);
  }
  const before = structuredClone(trust.manifest);
  for (const row of selected) trust.manifest.entries[foldKey(row.key)] = { current: row.hash! };
  if (keys === undefined) trust.manifest.state = "bootstrapped:true";
  try { persist(trust); }
  catch (error) { trust.manifest = before; throw error; }
  reviewSnapshot = undefined;
  return selected.length;
}

/** Delete one item of the served snapshot after the user confirmed (D4①), through no-follow removal: a link is removed, never followed. */
export function removeAveHomeTrustItem(snapshotId: string, key: string): void {
  const { trust, rows } = reviewTarget(snapshotId);
  if (!isAveHomeConfigurationOwner()) throw new AveHomeConfigurationNotOwnerError();
  const row = reviewRow(rows, key);
  if (row === undefined) throw new AveHomeTrustReviewError("stale", "The review changed. Reopen it and try again.");
  removeNoFollow(row.path, trust.home);
  const manifestKey = foldKey(row.key);
  if (trust.manifest.entries[manifestKey] !== undefined) {
    delete trust.manifest.entries[manifestKey];
    persist(trust);
  }
  reviewSnapshot = undefined;
}

/**
 * Remove `path` without following any link: a link or junction is deleted as an entry and its target is never touched.
 * Windows walks from `anchor` through handles opened without following reparse points (the home boundary's Delete). POSIX pins
 * each directory with an O_NOFOLLOW handle: on Linux its entries are reached through that handle (`/proc/self/fd`); elsewhere
 * the directory's identity is checked against the pinned handle before each step, so a directory swapped for a link mid-walk
 * stops the removal instead of reaching outside. The home is owner-only, so such a swap needs the user's own account.
 */
export function removeNoFollow(path: string, anchor: string = dirname(resolve(path))): void {
  if (process.platform === "win32") {
    const rel = relative(resolve(anchor), resolve(path));
    if (rel === "" || rel.startsWith("..") || resolve(rel) === rel) throw new Error(`${path} is not below ${anchor}`);
    removeWindowsItemNoFollow(resolve(anchor), rel.split(sep));
    return;
  }
  removePosixNoFollow(path);
}

const PROC_FD = "/proc/self/fd";
const procFdUsable = (() => {
  let usable: boolean | undefined;
  return () => {
    if (usable === undefined) {
      try { usable = process.platform === "linux" && lstatSync(PROC_FD).isDirectory(); } catch { usable = false; }
    }
    return usable;
  };
})();

function assertSameDirectory(path: string, pinned: Stats): void {
  const now = lstatSync(path);
  if (!now.isDirectory() || now.ino !== pinned.ino || now.dev !== pinned.dev) throw new Error(`${path} changed while it was being removed`);
}

function removePosixNoFollow(path: string): void {
  let entry: Stats;
  try { entry = lstatSync(path); }
  catch (error) { if (isMissingPathError(error)) return; throw error; }
  // A link, file or special file is removed as an entry; unlink never follows the last component.
  if (!entry.isDirectory()) { unlinkSync(path); return; }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = fstatSync(descriptor);
    if (!pinned.isDirectory() || pinned.ino !== entry.ino || pinned.dev !== entry.dev) throw new Error(`${path} changed while it was opened`);
    const byHandle = procFdUsable();
    const base = byHandle ? join(PROC_FD, String(descriptor)) : path;
    for (const name of readdirSync(base)) {
      if (!byHandle) assertSameDirectory(path, pinned);
      removePosixNoFollow(join(base, name));
    }
    if (!byHandle) assertSameDirectory(path, pinned);
  } finally { closeSync(descriptor); }
  rmdirSync(path);
}

/** Test teardown only. */
export function _resetAveHomeTrustForTest(): void {
  active = undefined;
  inFlight.clear();
  overlapping.clear();
  reviewSnapshot = undefined;
  setAtomicWriteGuard(undefined);
}
