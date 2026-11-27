import { type BigIntStats, lstatSync, readdirSync, readFileSync, rmdirSync, type Stats, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { renameFileOnce, renameFileOnceSync } from "../lib/transient-fs-lock-retry.js";
import { errorMessage } from "../shared/error-message.js";
import { setHostWorkspaceGuard } from "../shared/host-workspace-gate.js";
import { admitLocalPath, admitLocalRoute, assertLocalityDecisionUsable, isLocalityFailure, rethrowLocalityFailure, withLocalityDecision } from "../shared/local-path-io.js";
import { admitWindowsReparse, pinWindowsPaths } from "../shared/windows-path-facts.js";
import type { MxcWatchedRow } from "./mxc-windows.js";
import { createSandboxQuarantine, sandboxQuarantineRoot } from "./sandbox-quarantine.js";

const log = createLogger("sandbox-watched-rows");

/** The named violation a command result carries when a watched entry is quarantined. */
export const WATCHED_ROW_VIOLATION = "sandbox-watched-path-created";

/** A localized sweep failure that can include the restore locations of successful moves. */
export class WatchedQuarantineError extends Error {}

const MANIFEST = "watched-manifest.json";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface AnchorPin {
  readonly anchor: string;
  readonly anchorIdentity: FileIdentity;
}

// An absent protected row: Ave never creates it; the nearest existing ancestor's identity is recorded when a write root first reaches it.
interface WatchedRow extends AnchorPin {
  readonly path: string;
  readonly recordedAt: string;
  readonly roots: Set<string>;
  readonly holders: Set<symbol>;
  // The folder each grant measured when it armed this name; every one must still be that object.
  readonly pins: Map<symbol, AnchorPin>;
  exact: boolean;
  // The user restored the entry while a launch still claimed the name: only that launch's release moves it again.
  restored?: boolean;
}

interface StoredFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

interface RestoreIdentity {
  readonly source: StoredFileIdentity;
  readonly parent: StoredFileIdentity;
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
  readonly restoreIdentity?: RestoreIdentity;
}

export interface WatchedQuarantineEntry extends Omit<ManifestEntry, "restoreIdentity"> {
  readonly slot: string;
  readonly index: number;
}

export interface WatchedSweepContext {
  readonly commandId: string;
  readonly sessionId?: string;
  readonly command?: string;
}

const watched = new Map<string, WatchedRow>();
// A failed quarantine blocks later sweeps and host consumers until the entry is removed or recovered.
const failClosed = new Map<string, { readonly path: string; readonly roots: readonly string[]; readonly failure: string }>();
// Rows the user restored; they are no longer watched in this session.
const excepted = new Set<string>();
// Receipts no command result carried yet (a holder's release, a check made for a host consumer): the next sandboxed command's result takes them.
const undelivered: string[] = [];
const holderReceipts = new Map<symbol, string[]>();

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

function admitWatchedEntry(path: string): void {
  if (process.platform !== "win32") return;
  admitLocalPath(path);
  admitLocalRoute(dirname(path));
}

function entryAt(path: string, bigint: true): BigIntStats | undefined;
function entryAt(path: string): Stats | undefined;
function entryAt(path: string, bigint = false): Stats | BigIntStats | undefined {
  try {
    return withLocalityDecision(() => {
      admitWatchedEntry(path);
      return bigint ? lstatSync(path, { bigint: true }) : lstatSync(path);
    });
  }
  catch (error) {
    rethrowLocalityFailure(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * Record an absent protected row reachable from `roots`; nothing is created. An exact watch pins the nearest existing folder through
 * the path helper and refuses when the name exists or a pinned folder changed. A `claim` keeps the folder it first measured: arming
 * it again checks that folder and the name instead of pinning afresh.
 */
export function watchAbsentProtectedRow(path: string, roots: readonly string[], exact = false, claim?: symbol): void {
  withLocalityDecision(() => prepareAbsentProtectedWatch(path, roots, exact, claim))?.();
}

export function prepareAbsentProtectedWatch(path: string, roots: readonly string[], exact: boolean, claim?: symbol): (() => void) | undefined {
  const target = plain(path);
  const id = key(target);
  if (excepted.has(id) && !exact) return;
  const known = watched.get(id);
  if (exact) {
    const own = claim === undefined ? undefined : known?.pins.get(claim);
    let pinned: AnchorPin | undefined;
    if (known !== undefined && own !== undefined) {
      if (!anchorsIntact(known) || entryAt(target) !== undefined) throw refusal(target);
    } else {
      const observed = pinAbsentWatchAnchor(target);
      if (known === undefined) {
        return () => {
          excepted.delete(id);
          watched.set(id, { path: target, ...observed, recordedAt: new Date().toISOString(), roots: new Set(roots), holders: new Set(),
            pins: new Map(claim === undefined ? [] : [[claim, observed]]), exact });
        };
      }
      if (!anchorsIntact(known)) throw refusal(target);
      pinned = observed;
    }
    return () => {
      if (claim !== undefined && pinned !== undefined) known.pins.set(claim, pinned);
      known.exact = true;
      for (const root of roots) known.roots.add(root);
      delete known.restored;
    };
  }
  if (known) {
    return () => { for (const root of roots) known.roots.add(root); };
  }
  let anchor = dirname(target);
  for (;;) {
    const entry = entryAt(anchor, true);
    if (entry?.isDirectory()) {
      const pin = { anchor, anchorIdentity: { dev: entry.dev, ino: entry.ino } };
      return () => {
        const published = watched.get(id);
        if (published !== undefined) {
          for (const root of roots) published.roots.add(root);
        } else {
          watched.set(id, { path: target, ...pin, recordedAt: new Date().toISOString(), roots: new Set(roots), holders: new Set(), pins: new Map(), exact });
        }
      };
    }
    const parent = dirname(anchor);
    // No existing ancestor (an absent drive): nothing below it can be created.
    if (parent === anchor) return;
    anchor = parent;
  }
}

function pinAbsentWatchAnchor(path: string): AnchorPin {
  try {
    if (process.platform === "win32") admitLocalPath(path);
    const [facts] = pinWindowsPaths([path]);
    const parent = facts?.ancestors.findLast(component => component.exists === true);
    if (facts?.exists === false && admitWindowsReparse(facts) === true && parent?.directory
      && parent.canonical !== null && parent.volumeSerialNumber !== null && parent.fileIndex !== null) {
      const anchor = plain(parent.canonical);
      const anchorIdentity = { dev: BigInt(parent.volumeSerialNumber), ino: BigInt(parent.fileIndex) };
      if (within(anchor, path) && key(anchor) !== key(path)
        && sameIdentity(anchor, anchorIdentity) && entryAt(path) === undefined) return { anchor, anchorIdentity };
    }
  } catch (error) {
    throw refusal(path, error);
  }
  throw refusal(path);
}

/** One container launch's claim on its watched rows. */
export interface WatchedRowClaim {
  /** The launch's last synchronous check before its process is created. A name that now exists, or an anchor that is no longer the
   * admitted folder, refuses the launch naming the protected path and registers nothing. */
  start(assertStillValid?: () => void): void;
  /** After the process tree has ended: quarantine what a started launch's names now hold, and drop the claim. */
  release(): Promise<string | undefined>;
}

function refusal(path: string, cause?: unknown): Error {
  return new Error(t("sandboxPolicy.windowsProtectedWriteRefused", { path }), cause === undefined ? undefined : { cause });
}

/**
 * Claim the rows a container launch ranked as watched. Nothing is recorded until `start`, and `start` records every row or none.
 * Only a started claim fences host consumers and is swept at release: a launch that never started could not have written anything.
 */
export function claimMxcWatchedRows(rows: readonly MxcWatchedRow[], context: WatchedSweepContext): WatchedRowClaim {
  const holder = Symbol();
  let started = false;
  return {
    start: (assertStillValid) => {
      if (started) return;
      const checked = withLocalityDecision(() => {
        const anchors = rows.map((row) => {
          const target = plain(row.path);
          const anchor = plain(row.anchor);
          let identity: FileIdentity | undefined;
          try {
            // The folder the ranker admitted, by the helper's identity, read between two looks at the same object.
            const before = entryAt(anchor, true);
            const [facts] = pinWindowsPaths([anchor]);
            const known = watched.get(key(target));
            if (before?.isDirectory() === true && !before.isSymbolicLink() && sameIdentity(anchor, before)
              && facts?.volumeSerial === row.volumeSerial && facts.fileId === row.fileId
              && within(anchor, target) && key(anchor) !== key(target)
              // Still as ranked: once the first missing folder exists the name can carry an exact deny, so a stale ranking is refused.
              && entryAt(join(anchor, relative(anchor, target).split(/[\\/]/)[0] ?? "")) === undefined
              && (known === undefined || (known.anchorIdentity.dev === before.dev && known.anchorIdentity.ino === before.ino))) {
              identity = { dev: before.dev, ino: before.ino };
            }
          } catch (error) {
            throw refusal(row.path, error);
          }
          if (identity === undefined) throw refusal(row.path);
          return { target, anchor, identity };
        });
        assertStillValid?.();
        return anchors;
      });
      for (const { target, anchor, identity } of checked) {
        const id = key(target);
        const known = watched.get(id);
        if (known !== undefined) {
          known.exact = true;
          known.holders.add(holder);
        } else {
          watched.set(id, { path: target, anchor, anchorIdentity: identity, recordedAt: new Date().toISOString(), roots: new Set(), holders: new Set([holder]), pins: new Map(), exact: true });
        }
      }
      holderReceipts.set(holder, []);
      started = true;
    },
    release: async () => {
      if (!started) return undefined;
      started = false;
      const drop = (): string[] => {
        for (const [id, row] of watched) {
          if (row.holders.delete(holder) && row.holders.size === 0 && row.roots.size === 0 && rowState(row) === "absent") watched.delete(id);
        }
        const receipts = holderReceipts.get(holder) ?? [];
        holderReceipts.delete(holder);
        return receipts;
      };
      let own: string | undefined;
      try { own = await quarantineCreatedRows(context, holder); }
      catch (error) {
        const receipts = drop();
        if (error instanceof WatchedQuarantineError && receipts.length > 0) throw new WatchedQuarantineError([error.message, ...receipts].join("\n"));
        throw error;
      }
      const receipts = [...drop(), ...(own === undefined ? [] : [own])];
      return receipts.length > 0 ? receipts.join("\n") : undefined;
    },
  };
}

/** Keep a receipt no command result carried for the next sandboxed command's result. */
export function deferWatchedReceipt(receipt: string): void {
  undelivered.push(receipt);
}

export function watchedProtectedRows(): readonly string[] {
  return [...watched.values()].map(row => row.path);
}

// A fresh check beneath the recorded folder: the folder must still be the recorded object before the name is looked up in it.
function rowState(row: WatchedRow, rootCount = row.roots.size): "absent" | "present" | "unverifiable" {
  try {
    const present = entryAt(row.path) !== undefined;
    if (anchorsIntact(row)) return present ? "present" : "absent";
    // A replaced folder with nothing at the name leaves nothing to read once no contained process can still write there.
    return present || row.holders.size > 0 || (row.exact && rootCount > 0) ? "unverifiable" : "absent";
  } catch (error) {
    rethrowLocalityFailure(error);
    return "unverifiable";
  }
}

function createdRows(holder?: symbol): WatchedRow[] {
  return [...watched.values()].filter(row => (holder === undefined ? row.restored !== true : row.holders.has(holder)) && rowState(row) !== "absent");
}

/** Forget rows no live write root reaches, except a created row still awaiting its sweep. */
export function pruneWatchedRows(liveWriteRoots: readonly string[]): void {
  const live = new Set(liveWriteRoots.map(key));
  const updates = withLocalityDecision(() => [...watched].map(([id, row]) => {
    const dropped = [...row.roots].filter(root => !live.has(key(root)));
    const remove = row.roots.size === dropped.length && row.holders.size === 0 && rowState(row, 0) === "absent";
    return { id, row, dropped, remove };
  }));
  for (const { id, row, dropped, remove } of updates) {
    for (const root of dropped) row.roots.delete(root);
    if (remove) watched.delete(id);
  }
}

let consumerSweep: Promise<void> | undefined;

/**
 * The one gate for host-side consumers of a workspace (host Git, project commands, project hooks, stage seeding). Each call checks
 * every watched row of that workspace afresh. A name that now exists, a check that cannot be made, or a failed quarantine refuses
 * the consumer; an existing name is moved to quarantine so a later call can pass.
 */
export function isWatchedWorkspaceConsumable(workspace: string): boolean {
  try {
    const { consumable, created, cleared } = withLocalityDecision(() => {
      let consumable = true;
      const cleared: string[] = [];
      for (const [id, entry] of failClosed) {
        if (entryAt(entry.path) === undefined) { cleared.push(id); continue; }
        if (entry.roots.some(root => overlaps(root, workspace)) || overlaps(entry.path, workspace)) consumable = false;
      }
      let created = false;
      for (const row of watched.values()) {
        if (!overlaps(row.anchor, workspace) && !overlaps(row.path, workspace) && ![...row.roots].some(root => overlaps(root, workspace))) continue;
        const state = rowState(row);
        if (state === "absent") continue;
        consumable = false;
        created ||= state === "present" && row.restored !== true && quarantineFailureAt(sweepOriginal(row)) === undefined;
      }
      return { consumable, created, cleared };
    });
    for (const id of cleared) failClosed.delete(id);
    if (created && consumerSweep === undefined) {
      consumerSweep = quarantineCreatedRows({ commandId: "host-consumer" }, undefined, true)
        .then(() => {}, (error: unknown) => { if (!(error instanceof WatchedQuarantineError)) log.warn(errorMessage(error)); })
        .finally(() => { consumerSweep = undefined; });
    }
    return consumable;
  } catch {
    assertLocalityDecisionUsable();
    return false;
  }
}

setHostWorkspaceGuard(isWatchedWorkspaceConsumable);

function sweepOriginal(row: WatchedRow): string {
  return row.exact ? row.path : join(row.anchor, relative(row.anchor, row.path).split(/[\\/]/)[0] ?? "");
}

function quarantineFailureAt(path: string): string | undefined {
  for (const entry of failClosed.values()) {
    if (overlaps(entry.path, path)) return entry.failure;
  }
  return undefined;
}

function storeFileIdentity(identity: Pick<Stats | BigIntStats, "dev" | "ino">): StoredFileIdentity {
  return { dev: identity.dev.toString(), ino: identity.ino.toString() };
}

function matchesStoredFileIdentity(identity: FileIdentity, expected: StoredFileIdentity): boolean {
  return identity.dev.toString() === expected?.dev && identity.ino.toString() === expected.ino;
}

function sameIdentity(path: string, identity: FileIdentity): boolean {
  const current = entryAt(path, true);
  return current?.isDirectory() === true && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
}

function changedAnchor(row: WatchedRow): string | undefined {
  return [row, ...row.pins.values()].find(pin => !sameIdentity(pin.anchor, pin.anchorIdentity))?.anchor;
}

function anchorsIntact(row: WatchedRow): boolean {
  return changedAnchor(row) === undefined;
}

/** A grant's end: the folders it pinned are no longer checked once its own sweep ran. */
export function releaseWatchClaim(claim: symbol): void {
  for (const row of watched.values()) row.pins.delete(claim);
}

/** Command end: quarantine created watched entries and take the receipts no result carried yet. Throws the user-facing failure when a move fails. */
export async function sweepWatchedRows(context: WatchedSweepContext): Promise<string | undefined> {
  const pending = (): string[] => undelivered.splice(0);
  let notice: string | undefined;
  try { notice = await quarantineCreatedRows(context); }
  catch (error) {
    if (process.platform === "win32" && isLocalityFailure(error)) throw error;
    const receipts = pending();
    if (error instanceof WatchedQuarantineError && receipts.length > 0) throw new WatchedQuarantineError([...new Set([error.message, ...receipts])].join("\n"));
    throw error;
  }
  const receipts = [...pending(), ...(notice === undefined ? [] : [notice])];
  return receipts.length > 0 ? receipts.join("\n") : undefined;
}

/** Whether a command-end sweep has anything to do. */
export function hasWatchedWork(): boolean {
  return watched.size > 0 || undelivered.length > 0;
}

let sweeping: Promise<unknown> = Promise.resolve();

// One sweep at a time: a later one sees what the earlier one moved.
function quarantineCreatedRows(context: WatchedSweepContext, holder?: symbol, deferReceipt = false): Promise<string | undefined> {
  const run = sweeping.then(() => quarantineCreatedRowsNow(context, holder, deferReceipt));
  sweeping = run.catch(() => {});
  return run;
}

async function quarantineCreatedRowsNow(context: WatchedSweepContext, holder: symbol | undefined, deferReceipt: boolean): Promise<string | undefined> {
  const { cleared, created } = withLocalityDecision(() => {
    const cleared: string[] = [];
    for (const [id, entry] of failClosed) {
      try { if (entryAt(entry.path) === undefined) cleared.push(id); }
      catch (error) { rethrowLocalityFailure(error); }
    }
    return { cleared, created: createdRows(holder) };
  });
  for (const id of cleared) failClosed.delete(id);
  if (created.length === 0) return undefined;
  const entries = new Map<string, { readonly original: string; readonly row: WatchedRow }>();
  for (const row of created) {
    const original = sweepOriginal(row);
    if (!entries.has(key(original))) entries.set(key(original), { original, row });
  }
  const failures: string[] = [];
  const moved: ManifestEntry[] = [];
  let quarantine: Awaited<ReturnType<typeof createSandboxQuarantine>> | undefined;
  try {
    withLocalityDecision(() => admitWatchedEntry(sandboxQuarantineRoot()));
    quarantine = await createSandboxQuarantine(context.commandId);
  }
  catch (error) {
    rethrowLocalityFailure(error);
    failures.push(errorMessage(error));
  }
  for (const [id, { original, row }] of entries) {
    const previousFailure = quarantineFailureAt(original);
    if (previousFailure !== undefined) {
      failures.push(previousFailure);
      continue;
    }
    let found = false;
    try {
      const preflight = withLocalityDecision(() => {
        const changed = changedAnchor(row);
        if (changed !== undefined) throw new Error(`the folder ${JSON.stringify(changed)} changed identity`);
        const windows = process.platform === "win32";
        const source = windows ? entryAt(original, true) : undefined;
        if (windows ? source === undefined : entryAt(original) === undefined) return undefined;
        found = true;
        if (quarantine === undefined) throw new Error(failures[0]);
        admitWatchedEntry(quarantine.slot);
        const parent = source === undefined ? lstatSync(dirname(original)) : lstatSync(dirname(original), { bigint: true });
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Sandbox quarantine parent is not a plain directory");
        const restoreIdentity = source !== undefined
          ? { source: storeFileIdentity(source), parent: storeFileIdentity(parent) } : undefined;
        return { parent: { dev: Number(parent.dev), ino: Number(parent.ino) }, restoreIdentity };
      });
      if (preflight === undefined || quarantine === undefined) continue;
      const before = quarantine.moved.length;
      quarantine.move(original, preflight.parent);
      const landed = quarantine.moved[before];
      if (landed !== undefined) {
        row.restored = false;
        moved.push({ original, quarantined: landed.quarantined, row: row.path, time: new Date().toISOString(), commandId: context.commandId,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}), ...(context.command ? { command: context.command } : {}),
          ...(preflight.restoreIdentity === undefined ? {} : { restoreIdentity: preflight.restoreIdentity }) });
      }
    } catch (error) {
      const messageKey = found ? "sandboxPolicy.watchedQuarantineFailed" : "sandboxPolicy.watchedQuarantineUnverified";
      const failure = `${t(messageKey, { path: JSON.stringify(original), reason: errorMessage(error) })}\n${t("sandboxPolicy.watchedQuarantineRecovery")}`;
      failClosed.set(id, { path: original, roots: [...row.roots, row.anchor], failure });
      failures.push(failure);
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
  const failure = failures.length > 0 ? [...new Set(failures)].join("\n") + (notice ? `\n${notice}` : "") : undefined;
  // A sweep one launch did not run still reports on that launch's own result.
  const receipt = failure ?? notice;
  if (receipt !== undefined) {
    let carried = false;
    for (const other of new Set(created.flatMap(row => [...row.holders]))) {
      if (other === holder) continue;
      holderReceipts.get(other)?.push(receipt);
      carried = true;
    }
    if (deferReceipt && !carried) undelivered.push(receipt);
  }
  if (failure !== undefined) throw new WatchedQuarantineError(failure);
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
    if (process.platform !== "win32") return entries.map((entry, index) => ({ ...entry, slot, index }));
    return entries.map(({ restoreIdentity: _, ...entry }, index) => ({ ...entry, slot, index }));
  });
}

/** User action: move a quarantined entry back. The restored path is excepted from watching for this session, unless a live launch
 * still claims it: that claim and its fence on host consumers stay until the launch's release, which checks the name again. */
export async function restoreWatchedQuarantine(slot: string, index: number): Promise<{ readonly restored: string }> {
  let entries: ManifestEntry[];
  let entry: ManifestEntry | undefined;
  if (process.platform !== "win32") {
    entries = readManifest(slot);
    entry = entries[index];
    if (entry === undefined || !Number.isInteger(index)) throw new Error("Unknown quarantine entry");
    if (entry.restored !== undefined) throw new Error("Entry was already restored");
    if (basename(dirname(entry.quarantined)) !== slot) throw new Error("Quarantine entry is outside its slot");
    if (entryAt(entry.original) !== undefined) throw new Error(`${entry.original} exists; move it aside before restoring`);
    if (!entryAt(dirname(entry.original))?.isDirectory()) throw new Error(`The folder of ${entry.original} no longer exists`);
    await renameFileOnce(entry.quarantined, entry.original);
  } else {
    ({ entries, entry } = withLocalityDecision(() => {
      const manifest = manifestPath(slot);
      const slotPath = dirname(manifest);
      const slotEntry = entryAt(slotPath, true);
      const physicalSlot = admitLocalRoute(slotPath).physical;
      const manifestEntry = entryAt(manifest, true);
      if (slotEntry?.isDirectory() !== true || physicalSlot === undefined || manifestEntry?.isFile() !== true) {
        throw new Error("Quarantine slot or manifest is unavailable");
      }
      const entries = readManifest(slot);
      const entry = entries[index];
      if (entry === undefined || !Number.isInteger(index)) throw new Error("Unknown quarantine entry");
      if (entry.restored !== undefined) throw new Error("Entry was already restored");
      const source = entry.quarantined;
      const destination = entry.original;
      const parent = dirname(destination);
      admitLocalPath(source);
      admitLocalPath(destination);
      if (basename(dirname(source)) !== slot || key(dirname(source)) !== key(physicalSlot)) {
        throw new Error("Quarantine entry is outside its slot");
      }
      if (entryAt(destination) !== undefined) throw new Error(`${destination} exists; move it aside before restoring`);
      const sourceEntry = entryAt(source, true);
      if (sourceEntry === undefined || (entry.restoreIdentity !== undefined && !matchesStoredFileIdentity(sourceEntry, entry.restoreIdentity.source))) {
        throw new Error("Quarantined entry changed identity");
      }
      const parentEntry = entryAt(parent, true);
      const row = watched.get(key(entry.row));
      if (parentEntry?.isDirectory() !== true || (row !== undefined && !anchorsIntact(row))
        || (entry.restoreIdentity !== undefined && !matchesStoredFileIdentity(parentEntry, entry.restoreIdentity.parent))) {
        throw new Error("Quarantine restore destination folder changed identity");
      }
      const currentManifest = entryAt(manifest, true);
      const currentSource = entryAt(source, true);
      if (!sameIdentity(slotPath, slotEntry) || currentManifest?.dev !== manifestEntry.dev || currentManifest.ino !== manifestEntry.ino
        || currentSource?.dev !== sourceEntry.dev || currentSource.ino !== sourceEntry.ino) {
        throw new Error("Quarantine source changed identity");
      }
      if (entryAt(destination) !== undefined || !sameIdentity(parent, parentEntry)) {
        throw new Error("Quarantine restore destination folder changed identity");
      }

      renameFileOnceSync(source, destination);
      const restored = entryAt(destination, true);
      if (restored?.dev !== sourceEntry.dev || restored.ino !== sourceEntry.ino || entryAt(source) !== undefined) {
        throw new Error("Quarantine restored entry changed identity");
      }
      if (!sameIdentity(parent, parentEntry)) {
        throw new Error("Quarantine restore destination folder changed identity");
      }
      return { entries, entry };
    }));
  }
  const row = watched.get(key(entry.row));
  if (row?.exact && row.roots.size > 0) {
    // The ACL grant can still write to this name, so the next sweep must check it.
    delete row.restored;
  } else if (row === undefined || row.holders.size === 0) {
    excepted.add(key(entry.row));
    watched.delete(key(entry.row));
  } else {
    row.restored = true;
  }
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
  return withLocalityDecision(() => rows.filter(row => {
    const entry = entryAt(row);
    return entry?.isFile() === true && entry.size === 0;
  }));
}
