import { type BigIntStats, lstatSync, readdirSync, readFileSync, rmdirSync, type Stats, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { renameFileOnce } from "../lib/transient-fs-lock-retry.js";
import { errorMessage } from "../shared/error-message.js";
import { createSandboxQuarantine, sandboxQuarantineRoot } from "./sandbox-quarantine.js";

const log = createLogger("sandbox-watched-rows");

/** Closed outcome of one protected deny row reachable from a Windows write root. */
export type WindowsProtectedRowOutcome = "stamped" | "carried" | "excepted" | "watched" | "refused";

/** The named violation a command result carries when it created a watched row. */
export const WATCHED_ROW_VIOLATION = "sandbox-watched-path-created";

const MANIFEST = "watched-manifest.json";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

// An absent protected row: Ave never creates it; the nearest existing ancestor's identity is recorded when a write root first reaches it.
interface WatchedRow {
  readonly path: string;
  readonly anchor: string;
  readonly anchorIdentity: FileIdentity;
  readonly recordedAt: string;
  readonly roots: Set<string>;
  exact: boolean;
}

interface ManifestEntry {
  readonly original: string;
  readonly quarantined: string;
  readonly row: string;
  readonly time: string;
  readonly commandId: string;
  readonly sessionId?: string;
  readonly command?: string;
  restored?: string;
}

export interface WatchedQuarantineEntry extends ManifestEntry {
  readonly slot: string;
  readonly index: number;
}

export interface WatchedSweepContext {
  readonly commandId: string;
  readonly sessionId?: string;
  readonly command?: string;
}

const watched = new Map<string, WatchedRow>();
// A created entry whose quarantine failed: host-side consumers of these roots stay refused while it exists.
const failClosed = new Map<string, { readonly path: string; readonly roots: readonly string[] }>();
// Rows the user restored; they are no longer watched in this session.
const excepted = new Set<string>();

function plain(path: string): string {
  return resolve(path.replace(/^\\\\\?\\(?!UNC\\)/i, "").replace(/(?<=[^:\\/])[\\/]+$/, ""));
}

function key(path: string): string {
  const resolved = plain(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function within(root: string, path: string): boolean {
  const suffix = relative(key(root), key(path));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function entryAt(path: string, bigint: true): BigIntStats | undefined;
function entryAt(path: string): Stats | undefined;
function entryAt(path: string, bigint = false): Stats | BigIntStats | undefined {
  try { return bigint ? lstatSync(path, { bigint: true }) : lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Record an absent protected row reachable from `roots`; nothing is created. */
export function watchAbsentProtectedRow(path: string, roots: readonly string[], exact = false): void {
  const target = plain(path);
  const id = key(target);
  if (excepted.has(id)) return;
  const known = watched.get(id);
  if (known) {
    known.exact ||= exact;
    for (const root of roots) known.roots.add(root);
    return;
  }
  let anchor = dirname(target);
  for (;;) {
    const entry = entryAt(anchor, true);
    if (entry?.isDirectory()) {
      watched.set(id, { path: target, anchor, anchorIdentity: { dev: entry.dev, ino: entry.ino }, recordedAt: new Date().toISOString(), roots: new Set(roots), exact });
      return;
    }
    const parent = dirname(anchor);
    // No existing ancestor (an absent drive): nothing below it can be created.
    if (parent === anchor) return;
    anchor = parent;
  }
}

export function watchedProtectedRows(): readonly string[] {
  return [...watched.values()].map(row => row.path);
}

function createdRows(): WatchedRow[] {
  return [...watched.values()].filter(row => entryAt(row.path) !== undefined);
}

/** Forget rows no live write root reaches, except a created row still awaiting its sweep. */
export function pruneWatchedRows(liveWriteRoots: readonly string[]): void {
  const live = new Set(liveWriteRoots.map(key));
  for (const [id, row] of watched) {
    for (const root of row.roots) if (!live.has(key(root))) row.roots.delete(root);
    if (row.roots.size === 0 && entryAt(row.path) === undefined) watched.delete(id);
  }
}

/** Host-side consumers (host Git) must not act on a workspace holding a created, unswept watched row or a failed quarantine. */
export function isWatchedWorkspaceConsumable(workspace: string): boolean {
  for (const [id, entry] of failClosed) {
    if (entryAt(entry.path) === undefined) { failClosed.delete(id); continue; }
    if (entry.roots.some(root => overlaps(root, workspace)) || overlaps(entry.path, workspace)) return false;
  }
  return !createdRows().some(row => [...row.roots].some(root => overlaps(root, workspace)) || overlaps(row.path, workspace));
}

function sameIdentity(path: string, identity: FileIdentity): boolean {
  const current = entryAt(path, true);
  return current?.isDirectory() === true && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
}

/** Quarantine created watched entries. Throws the user-facing failure when a move fails. */
export async function sweepWatchedRows(context: WatchedSweepContext): Promise<string | undefined> {
  const created = createdRows();
  if (created.length === 0) return undefined;
  const entries = new Map<string, { readonly original: string; readonly row: WatchedRow }>();
  for (const row of created) {
    const original = row.exact ? row.path : join(row.anchor, relative(row.anchor, row.path).split(/[\\/]/)[0] ?? "");
    if (!entries.has(key(original))) entries.set(key(original), { original, row });
  }
  const failures: string[] = [];
  const moved: ManifestEntry[] = [];
  let quarantine: Awaited<ReturnType<typeof createSandboxQuarantine>> | undefined;
  try { quarantine = await createSandboxQuarantine(context.commandId); }
  catch (error) { failures.push(errorMessage(error)); }
  for (const [id, { original, row }] of entries) {
    try {
      if (quarantine === undefined) throw new Error(failures[0]);
      if (!sameIdentity(row.anchor, row.anchorIdentity)) throw new Error(`the folder ${JSON.stringify(row.anchor)} changed identity`);
      const parent = lstatSync(dirname(original));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Sandbox quarantine parent is not a plain directory");
      const before = quarantine.moved.length;
      quarantine.move(original, parent);
      const landed = quarantine.moved[before];
      if (landed !== undefined) {
        moved.push({ original, quarantined: landed.quarantined, row: row.path, time: new Date().toISOString(), commandId: context.commandId,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}), ...(context.command ? { command: context.command } : {}) });
      }
    } catch (error) {
      failClosed.set(id, { path: original, roots: [...row.roots] });
      failures.push(t("sandboxPolicy.watchedQuarantineFailed", { path: JSON.stringify(original), reason: errorMessage(error) }));
    }
  }
  const first = moved[0];
  if (quarantine !== undefined && first !== undefined) {
    const slot = dirname(first.quarantined);
    writeFileSync(join(slot, MANIFEST), `${JSON.stringify({ kind: "watched", entries: moved }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } else if (quarantine !== undefined) {
    try { rmdirSync(quarantine.slot); }
    catch { /* never remove a slot holding anything */ }
  }
  const notice = moved.length > 0
    ? t("sandboxPolicy.watchedQuarantined", { code: WATCHED_ROW_VIOLATION, moves: moved.map(entry => `${JSON.stringify(entry.original)} -> ${JSON.stringify(entry.quarantined)}`).join("\n") })
    : undefined;
  for (const failure of failures) log.warn(failure);
  if (failures.length > 0) throw new Error([...new Set(failures)].join("\n") + (notice ? `\n${notice}` : ""));
  if (notice) log.warn(notice);
  return notice;
}

function manifestPath(slot: string): string {
  if (!/^[\w.-]+$/.test(slot)) throw new Error("Invalid quarantine slot");
  return join(sandboxQuarantineRoot(), slot, MANIFEST);
}

function readManifest(slot: string): ManifestEntry[] {
  const parsed = JSON.parse(readFileSync(manifestPath(slot), "utf8")) as { kind?: unknown; entries?: unknown };
  if (parsed.kind !== "watched" || !Array.isArray(parsed.entries)) throw new Error("Not a watched-row quarantine manifest");
  return parsed.entries as ManifestEntry[];
}

/** The quarantined watched entries, for the user's restore action. */
export function listWatchedQuarantine(): WatchedQuarantineEntry[] {
  let slots: string[];
  try { slots = readdirSync(sandboxQuarantineRoot()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return slots.flatMap(slot => {
    let entries: ManifestEntry[];
    try { entries = readManifest(slot); }
    catch { return []; }
    return entries.map((entry, index) => ({ ...entry, slot, index }));
  });
}

/** User action: move a quarantined entry back. The restored path is excepted from watching for this session. */
export async function restoreWatchedQuarantine(slot: string, index: number): Promise<{ readonly restored: string }> {
  const entries = readManifest(slot);
  const entry = entries[index];
  if (entry === undefined || !Number.isInteger(index)) throw new Error("Unknown quarantine entry");
  if (entry.restored !== undefined) throw new Error("Entry was already restored");
  if (basename(dirname(entry.quarantined)) !== slot) throw new Error("Quarantine entry is outside its slot");
  if (entryAt(entry.original) !== undefined) throw new Error(`${entry.original} exists; move it aside before restoring`);
  if (!entryAt(dirname(entry.original))?.isDirectory()) throw new Error(`The folder of ${entry.original} no longer exists`);
  await renameFileOnce(entry.quarantined, entry.original);
  excepted.add(key(entry.row));
  watched.delete(key(entry.row));
  failClosed.delete(key(entry.original));
  entry.restored = new Date().toISOString();
  writeFileSync(manifestPath(slot), `${JSON.stringify({ kind: "watched", entries }, null, 2)}\n`, { mode: 0o600 });
  return { restored: entry.original };
}

/** Session teardown: no write root survives, but a created or failed row still blocks host consumers until swept or removed. */
export function resetWatchedRows(): void {
  pruneWatchedRows([]);
  excepted.clear();
}

/** Zero-byte files at protected rows, the shape an earlier native stamp left. Ave keeps no record of its own placeholders, so none is removed: the caller lists them. */
export function placeholderLeftovers(rows: readonly string[]): string[] {
  return rows.filter(row => {
    const entry = entryAt(row);
    return entry?.isFile() === true && entry.size === 0;
  });
}
