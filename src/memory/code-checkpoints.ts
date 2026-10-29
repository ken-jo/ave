import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { openFeatureNamespace } from "../main/storage/feature-namespace.js";
import { sameFileIdentity } from "../lib/file-identity.js";
import { renameFile, retryOnFileLock } from "../lib/transient-fs-lock-retry.js";
import { CODE_CHECKPOINT_POLICY } from "../shared/code-rewind.js";
import { FILE_MENTION_REFERENCE_POLICY } from "../shared/file-mention-reference.js";
import { countFileChangeLines } from "../shared/file-change-counts.js";
import type { TurnChangeReview, TurnReviewError, TurnReviewResult } from "../shared/turn-change-review.js";
import { buildRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import { assertReadableFilePath } from "../tools/file-read-core.js";
import { ensureFileAccess } from "../tools/file-access-policy.js";
import { observeAgentDocumentMutation } from "../tools/agent-observation-context.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { createLogger } from "../lib/logger.js";
import { countTurnReviewLines, createTurnReviewHunks } from "./turn-review-diff.js";

const log = createLogger("code-checkpoints");
const namespace = openFeatureNamespace("code-checkpoints");
const FILE_NAME = "turns.json";
const IMAGE_NAME_PATTERN = /^image-[a-f0-9-]{36}\.json$/;
const QuarantineManifestSchema = z.array(z.string().regex(IMAGE_NAME_PATTERN));
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const ChangeSchema = z.object({
  path: z.string().refine(isAbsolute),
  before: z.string().max(Math.ceil(CODE_CHECKPOINT_POLICY.maxFileBytes / 3) * 4)
    .refine((value) => Buffer.byteLength(value, "base64") <= CODE_CHECKPOINT_POLICY.maxFileBytes
      && Buffer.from(value, "base64").toString("base64") === value).nullable(),
  mode: z.number().int().min(0).max(0o777),
  afterHash: HashSchema,
});
const TurnSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  unavailable: z.boolean(),
  consumed: z.boolean(),
  changes: z.array(ChangeSchema),
});
const LedgerSchema = z.array(TurnSchema).max(CODE_CHECKPOINT_POLICY.maxTurns);
const StoredChangeSchema = ChangeSchema.omit({ before: true }).extend({
  before: z.string().regex(IMAGE_NAME_PATTERN).nullable(),
  beforeHash: HashSchema,
  storageBytes: z.number().int().min(0).max(CODE_CHECKPOINT_POLICY.maxStorageBytes),
  addedLines: z.number().int().min(0).max(CODE_CHECKPOINT_POLICY.maxFileBytes).optional(),
  removedLines: z.number().int().min(0).max(CODE_CHECKPOINT_POLICY.maxFileBytes).optional(),
});
const StoredTurnSchema = TurnSchema.extend({ changes: z.array(StoredChangeSchema) });
const IndexSchema = z.object({ version: z.literal(2), turns: z.array(StoredTurnSchema) });
type Change = z.infer<typeof ChangeSchema>;
type StoredChange = z.infer<typeof StoredChangeSchema>;
type Turn = z.infer<typeof StoredTurnSchema>;
interface TurnIdentity { sessionId: string; messageId: string }
interface ActiveTurn extends TurnIdentity { dir: string; unavailable: boolean; deleted: boolean; admitted: boolean; automaticWritesBlocked: boolean }
interface DeferredSession {
  dir: string;
  sessionId: string;
  turns: Map<string, boolean>;
}
const turnContext = new AsyncLocalStorage<ActiveTurn>();
const requiredCheckpointContext = new AsyncLocalStorage<boolean>();
const inFlight = new Set<ActiveTurn>();
const liveChildren = new Map<string, number>();
const pendingUnavailable = new Map<string, DeferredSession>();
export function _pendingUnavailableCountForTest(sessionId: string): number {
  return pendingUnavailable.get(childKey(sessionId))?.turns.size ?? 0;
}
let queue: Promise<unknown> = Promise.resolve();

class InvalidCheckpointStorageError extends Error {}

class CodeCheckpointRequiredError extends Error {
  constructor() { super("Code checkpoint unavailable; retry with explicit approval"); }
}

function requireAvailableCheckpoint(identity: ActiveTurn | undefined): void {
  if (requiredCheckpointContext.getStore() === true
    && (!identity || identity.deleted || identity.unavailable || identity.automaticWritesBlocked || !identity.admitted || identity.dir !== namespace.dir)) {
    throw new CodeCheckpointRequiredError();
  }
}

function blockAutomaticWrites(identity: ActiveTurn): never {
  identity.automaticWritesBlocked = true;
  throw new CodeCheckpointRequiredError();
}

/** Automatic edits require rewind at the actual mutation boundary, too. */
export async function withRequiredCodeCheckpoint<T>(run: () => Promise<T>): Promise<T> {
  return requiredCheckpointContext.run(true, async () => {
    requireAvailableCheckpoint(turnContext.getStore());
    return run();
  });
}

function childKey(sessionId: string, dir = namespace.dir): string {
  return `${dir}\0${sessionId}`;
}

function downgrade(turn: TurnIdentity & { unavailable: boolean }, reason: string): void {
  if (!turn.unavailable) log.warn("checkpoint unavailable: %s/%s: %s", turn.sessionId, turn.messageId, reason);
  turn.unavailable = true;
}

function deferUnavailable(active: ActiveTurn, error: unknown): void {
  downgrade(active, `read error: ${(error as Error).message}`);
  const key = childKey(active.sessionId, active.dir);
  let pending = pendingUnavailable.get(key);
  if (!pending) {
    pending = { dir: active.dir, sessionId: active.sessionId, turns: new Map() };
    pendingUnavailable.set(key, pending);
  }
  pending.turns.set(active.messageId, active.admitted || pending.turns.get(active.messageId) === true);
  // Evicting the oldest placeholder is safe because every restore reaching it also contains a newer refusal.
  if (pending.turns.size > CODE_CHECKPOINT_POLICY.maxSessionTurns) pending.turns.delete(pending.turns.keys().next().value!);
}

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

function hash(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

async function verifyNamespace(): Promise<void> {
  try {
    const info = await lstat(namespace.dir);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new InvalidCheckpointStorageError("Code checkpoint namespace is invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readStorage(name: string, maxBytes = CODE_CHECKPOINT_POLICY.maxStorageBytes): Promise<unknown> {
  await verifyNamespace();
  const path = join(namespace.dir, name);
  const pathInfo = await lstat(path, { bigint: true });
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new InvalidCheckpointStorageError("Code checkpoint storage is invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFileIdentity(pathInfo, await handle.stat({ bigint: true }))) throw new InvalidCheckpointStorageError("Code checkpoint storage identity changed");
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes
      || (typeof process.getuid === "function" && info.uid !== process.getuid())
      || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
      throw new InvalidCheckpointStorageError("Code checkpoint storage is invalid");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function quarantineLedger(): Promise<void> {
  log.warn("checkpoint quarantine: invalid ledger");
  await verifyNamespace();
  const backupName = `${FILE_NAME}.corrupt-${Date.now()}-${randomUUID()}.bak`;
  const images = (await readdir(namespace.dir)).filter((name) => IMAGE_NAME_PATTERN.test(name));
  await namespace.writeJson(`${backupName}.images.json`, images);
  const backup = join(namespace.dir, backupName);
  await renameFile(join(namespace.dir, FILE_NAME), backup);
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    const info = await lstat(backup, { bigint: true });
    if (info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid())) {
      const handle = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameFileIdentity(info, await handle.stat({ bigint: true }))) throw new Error("Code checkpoint storage identity changed");
        await handle.chmod(0o600);
      } finally { await handle.close(); }
    }
  }
  for (const active of inFlight) if (active.dir === namespace.dir && active.admitted) downgrade(active, "invalid ledger");
}

async function storeImage(bytes: Buffer | null): Promise<Pick<StoredChange, "before" | "beforeHash" | "storageBytes">> {
  if (bytes === null) return { before: null, beforeHash: null, storageBytes: 0 };
  const before = `image-${randomUUID()}.json`;
  const encoded = bytes.toString("base64");
  try { await namespace.writeJson(before, encoded); }
  catch (error) {
    await retryOnFileLock(() => unlink(join(namespace.dir, before)))
      .catch((cleanup: NodeJS.ErrnoException) => { if (cleanup.code !== "ENOENT") log.warn("checkpoint image cleanup failed: %s", cleanup.message); });
    throw error;
  }
  return { before, beforeHash: hash(bytes), storageBytes: Buffer.byteLength(encoded) + 3 };
}

async function hydrate(change: StoredChange): Promise<Change> {
  const before = change.before === null ? null : ChangeSchema.shape.before.parse(
    await readStorage(change.before, Math.ceil(CODE_CHECKPOINT_POLICY.maxFileBytes / 3) * 4 + 3),
  );
  if (hash(before === null ? null : Buffer.from(before, "base64")) !== change.beforeHash) {
    throw new Error("Code checkpoint image is invalid");
  }
  return { ...change, before };
}

async function loadLedger(readOnly = false): Promise<Turn[]> {
  let parsed: unknown;
  try { parsed = await retryOnFileLock(() => readStorage(FILE_NAME)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (!(error instanceof SyntaxError || error instanceof InvalidCheckpointStorageError)) throw error;
    if (readOnly) throw error;
    // Preserve damaged evidence; never trust its restore ranges.
    await quarantineLedger();
    return [];
  }
  const index = Array.isArray(parsed) ? LedgerSchema.safeParse(parsed) : IndexSchema.safeParse(parsed);
  if (!index.success) {
    if (readOnly) throw new InvalidCheckpointStorageError("Code checkpoint ledger is invalid");
    await quarantineLedger();
    return [];
  }
  if (!Array.isArray(index.data)) return index.data.turns;
  const turns: Turn[] = [];
  const images: string[] = [];
  try {
    const legacy = index.data;
    for (const turn of legacy) {
      const changes: StoredChange[] = [];
      for (const change of turn.changes) {
        const image = await storeImage(change.before === null ? null : Buffer.from(change.before, "base64"));
        if (image.before) images.push(image.before);
        changes.push({ ...change, ...image });
      }
      turns.push({ ...turn, changes });
    }
    await save(turns);
    return turns;
  } catch (error) {
    // A writer can report a durability error after its index rename committed.
    const untouched = await readStorage(FILE_NAME).then((current) => JSON.stringify(current) === JSON.stringify(parsed), () => false);
    if (untouched) await Promise.all(images.map((name) => retryOnFileLock(() => unlink(join(namespace.dir, name)))));
    throw error;
  }
}

async function load(): Promise<Turn[]> {
  const turns = await loadLedger();
  for (const pending of pendingUnavailable.values()) {
    if (pending.dir !== namespace.dir) continue;
    for (const [messageId, admitted] of pending.turns) {
      const existing = turns.find((turn) => turn.sessionId === pending.sessionId && turn.messageId === messageId);
      if (!existing) {
        if (admitted) {
          for (const turn of turns.filter((turn) => turn.sessionId === pending.sessionId)) downgrade(turn, "pruned record");
        }
        turns.push({ sessionId: pending.sessionId, messageId, unavailable: true, consumed: false, changes: [] });
      } else {
        downgrade(existing, "read error");
        existing.changes = [];
      }
    }
  }
  return turns;
}

async function sweepImages(turns: Turn[]): Promise<void> {
  const names = await readdir(namespace.dir);
  const retained = new Set(turns.flatMap((turn) => turn.changes.map((change) => change.before)));
  const evidence: Array<{ backup: string; images: string[]; bytes: number }> = [];
  const imageSizes = new Map<string, number>();
  const remove = async (name: string) => retryOnFileLock(() => unlink(join(namespace.dir, name)))
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const discard = async (backup: string) => {
    await remove(backup);
    await remove(`${backup}.images.json`);
  };
  for (const backup of names.filter((name) => name.startsWith(`${FILE_NAME}.corrupt-`) && name.endsWith(".bak")).sort()) {
    try {
      const images = QuarantineManifestSchema.parse(await retryOnFileLock(() => readStorage(`${backup}.images.json`)));
      const info = await lstat(join(namespace.dir, backup));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Code checkpoint backup is invalid");
      for (const image of images) {
        if (!imageSizes.has(image) && names.includes(image)) imageSizes.set(image, (await lstat(join(namespace.dir, image))).size);
      }
      evidence.push({ backup, images, bytes: info.size + (await lstat(join(namespace.dir, `${backup}.images.json`))).size });
    } catch (error) {
      // Unverifiable evidence must not disable collection.
      log.warn("checkpoint quarantine discarded: %s", (error as Error).message);
      await discard(backup);
    }
  }
  const evidenceBytes = () => evidence.reduce((sum, entry) => sum + entry.bytes, 0)
    + [...new Set(evidence.flatMap((entry) => entry.images))].reduce((sum, image) => sum + (imageSizes.get(image) ?? 0), 0);
  while (evidenceBytes() > CODE_CHECKPOINT_POLICY.maxQuarantineBytes) await discard(evidence.shift()!.backup);
  for (const entry of evidence) for (const image of entry.images) retained.add(image);
  for (const name of names) {
    if (name.startsWith(`${FILE_NAME}.corrupt-`) && name.endsWith(".bak.images.json")
      && !names.includes(name.slice(0, -".images.json".length))) await remove(name);
  }
  for (const name of names) {
    if (IMAGE_NAME_PATTERN.test(name) && !retained.has(name)) await remove(name);
  }
}

function ledgerStorageBytes(turns: Turn[]): number {
  return Buffer.byteLength(JSON.stringify({ version: 2, turns }, null, 2) + "\n")
    + turns.reduce((total, turn) => total + turn.changes.reduce((sum, change) => sum + change.storageBytes, 0), 0);
}

async function save(turns: Turn[], retained?: Turn): Promise<void> {
  // Prune only the target session for session limits; shared quotas prune globally without breaking surviving ranges.
  for (;;) {
    const overfull = turns.find((turn) =>
      turns.filter((other) => other.sessionId === turn.sessionId).length > CODE_CHECKPOINT_POLICY.maxSessionTurns,
    );
    const bytes = ledgerStorageBytes(turns);
    if (!overfull && turns.length <= CODE_CHECKPOINT_POLICY.maxTurns && bytes <= CODE_CHECKPOINT_POLICY.maxStorageBytes) break;
    const oldest = turns.findIndex((turn, index) => (!overfull || turn.sessionId === overfull.sessionId)
      && turns.findIndex((other) => other.sessionId === turn.sessionId) === index
      && ![...inFlight].some((active) => active.dir === namespace.dir
        && active.sessionId === turn.sessionId && active.messageId === turn.messageId));
    if (oldest < 0) {
      if (bytes > CODE_CHECKPOINT_POLICY.maxStorageBytes && retained?.changes.length) {
        downgrade(retained, "storage limit");
        retained.changes = [];
        continue;
      }
      break; // Pinned metadata is pruned when its turns settle.
    }
    turns.splice(oldest, 1);
  }
  await verifyNamespace();
  await namespace.writeJson(FILE_NAME, { version: 2, turns });
  for (const [key, pending] of pendingUnavailable) if (pending.dir === namespace.dir) pendingUnavailable.delete(key);
  await sweepImages(turns).catch((error: unknown) => log.warn("checkpoint image cleanup failed: %s", (error as Error).message));
}

/** Resolve an absent leaf through its existing ancestors without following it later. */
async function canonicalPath(path: string): Promise<string> {
  const parent = dirname(path);
  try { return join(await realpath(parent), basename(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function snapshot(path: string): Promise<{ bytes: Buffer | null; mode: number }> {
  // Refuse changed parent links, file links and special files, including dangling links.
  if (await canonicalPath(path) !== path) throw new Error("Code checkpoint path changed");
  let pathInfo;
  try { pathInfo = await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, mode: 0o600 };
    throw error;
  }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n) {
    throw new Error("Code checkpoint requires an unlinked regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFileIdentity(pathInfo, await handle.stat({ bigint: true }))) throw new Error("Code checkpoint file identity changed");
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > CODE_CHECKPOINT_POLICY.maxFileBytes) {
      throw new Error("Code checkpoint requires a regular file within the size limit");
    }
    // A bounded read even when another process grows the open inode.
    const bytes = Buffer.alloc(Math.min(info.size + 1, CODE_CHECKPOINT_POLICY.maxFileBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path, { bigint: true });
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
      || pathAfter.mtimeNs !== pathInfo.mtimeNs || pathAfter.ctimeNs !== pathInfo.ctimeNs) {
      throw new Error("Code checkpoint file changed during capture");
    }
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n || !sameFileIdentity(pathInfo, pathAfter)) {
      throw new Error("Code checkpoint file identity changed");
    }
    return { bytes: Buffer.from(bytes.subarray(0, length)), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function withCodeCheckpoint<T>(identity: TurnIdentity, run: () => Promise<T>): Promise<T> {
  const active: ActiveTurn = { ...identity, dir: namespace.dir, unavailable: false, deleted: false, admitted: false, automaticWritesBlocked: false };
  if (liveChildren.has(childKey(identity.sessionId))) downgrade(active, "child alive");
  inFlight.add(active);
  try {
    await exclusive(async () => {
      const turns = await load();
      active.admitted = true;
      const existing = turns.find((turn) => turn.sessionId === identity.sessionId && turn.messageId === identity.messageId);
      if (!existing) turns.push({ ...identity, unavailable: active.unavailable, consumed: false, changes: [] });
      else if (active.unavailable) { downgrade(existing, "child alive"); existing.changes = []; }
      await save(turns, existing ?? turns[turns.length - 1]);
    }).catch((error: unknown) => deferUnavailable(active, error));
    return await turnContext.run(active, run);
  } finally {
    inFlight.delete(active);
    // Settling only prunes what this turn pinned; a failure must not replace the turn's own result.
    await exclusive(async () => { const turns = await load(); await save(turns); })
      .catch((error: unknown) => log.warn("code-checkpoints: settle after turn failed: %s", (error as Error).message));
  }
}

/** Only a healthy admitted turn with capturable originals can justify automatic writes. */
export async function isCodeCheckpointAvailable(paths: readonly string[]): Promise<boolean> {
  const identity = turnContext.getStore();
  if (!identity || !identity.admitted || identity.deleted || identity.unavailable || identity.automaticWritesBlocked
    || identity.dir !== namespace.dir || paths.length === 0) return false;
  return exclusive(async () => {
    try {
      const turns = await loadLedger(true);
      const turn = turns.find((item) => item.sessionId === identity.sessionId && item.messageId === identity.messageId);
      if (!turn || turn.unavailable || turn.consumed || identity.unavailable || identity.deleted || identity.automaticWritesBlocked) return false;
      for (const change of turn.changes) await hydrate(change);
      let projectedBytes = ledgerStorageBytes(turns);
      for (const path of new Set(paths.map((value) => resolve(value)))) {
        const before = await snapshot(path);
        projectedBytes += (before.bytes === null ? 0 : Math.ceil(before.bytes.length / 3) * 4 + 3)
          + Buffer.byteLength(path) + 512;
        if (projectedBytes > CODE_CHECKPOINT_POLICY.maxStorageBytes) return false;
      }
      return !identity.unavailable && !identity.deleted && !identity.automaticWritesBlocked;
    } catch (error) {
      log.warn("checkpoint admission unavailable: %s", (error as Error).message);
      return false;
    }
  });
}

async function makeUnavailable(turns: Turn[], identity: ActiveTurn, reason: string): Promise<void> {
  // Missing records are a gap in every earlier restore range for this session.
  const turn = turns.find((item) => item.sessionId === identity.sessionId && item.messageId === identity.messageId);
  downgrade(identity, turn ? reason : "pruned record");
  for (const item of turn ? [turn] : turns.filter((item) => item.sessionId === identity.sessionId)) {
    downgrade(item, turn ? reason : "pruned record");
    item.changes = [];
  }
  await save(turns, turn);
}

/** Remote edits and file transfers have no host before-image contract. */
export async function markCodeCheckpointUnavailable(sessionId?: string, reason = "unsupported edits"): Promise<void> {
  const inherited = turnContext.getStore();
  const targets = sessionId === undefined ? (inherited ? [inherited] : [])
    : [...inFlight].filter((active) => active.dir === namespace.dir && active.sessionId === sessionId);
  for (const active of targets) if (!active.deleted) downgrade(active, reason);
  await exclusive(async () => {
    if (!targets.some((identity) => !identity.deleted)) return;
    const turns = await load();
    for (const identity of targets) if (!identity.deleted) await makeUnavailable(turns, identity, reason);
  }).catch((error: unknown) => { for (const active of targets) if (!active.deleted) deferUnavailable(active, error); });
}

/** Count the executing lifetime, including background and detached work. */
export async function trackCodeCheckpointChild(sessionId?: string): Promise<() => void> {
  const origin = sessionId ?? turnContext.getStore()?.sessionId;
  if (origin === undefined) return () => {};
  const key = childKey(origin);
  liveChildren.set(key, (liveChildren.get(key) ?? 0) + 1);
  await markCodeCheckpointUnavailable(origin, "child alive");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (liveChildren.get(key) ?? 1) - 1;
    if (count === 0) liveChildren.delete(key);
    else liveChildren.set(key, count);
  };
}

export async function deleteCodeCheckpoints(sessionId: string): Promise<void> {
  await exclusive(async () => {
    for (const active of inFlight) {
      if (active.dir === namespace.dir && active.sessionId === sessionId) active.deleted = true;
    }
    pendingUnavailable.delete(childKey(sessionId));
    const turns = (await load()).filter((turn) => turn.sessionId !== sessionId);
    await save(turns);
    // Damaged ledgers cannot safely identify the owners of their originals.
    for (const name of await readdir(namespace.dir)) {
      if (name.startsWith(`${FILE_NAME}.corrupt-`) && name.endsWith(".bak")) {
        await retryOnFileLock(() => unlink(join(namespace.dir, name)));
      }
    }
    await sweepImages(turns);
  });
}

/** Called only after native file-tool authorization and immediately before mutation. */
export async function checkpointFileMutation<T>(
  effects: Array<{ path: string } & ({ content: Buffer | string | null } | { copyFrom: string })>,
  run: () => Promise<T>,
): Promise<T> {
  return observeAgentDocumentMutation(effects, () => checkpointMutation(effects, run));
}

async function checkpointMutation<T>(
  effects: Array<{ path: string } & ({ content: Buffer | string | null } | { copyFrom: string })>,
  run: () => Promise<T>,
): Promise<T> {
  const identity = turnContext.getStore();
  requireAvailableCheckpoint(identity);
  if (!identity || identity.deleted) return run();
  return exclusive(async () => {
    requireAvailableCheckpoint(identity);
    let turns: Turn[];
    try { turns = await load(); }
    catch (error) { deferUnavailable(identity, error); requireAvailableCheckpoint(identity); return run(); }
    const turn = turns.find((item) => item.sessionId === identity.sessionId && item.messageId === identity.messageId);
    if (requiredCheckpointContext.getStore() === true && turn?.consumed) throw new CodeCheckpointRequiredError();
    if (!turn || turn.unavailable || identity.unavailable) {
      await makeUnavailable(turns, identity, "unsupported edits");
      requireAvailableCheckpoint(identity);
      return run();
    }
    const changes: StoredChange[] = [];
    try {
      for (const effect of effects) {
        const path = await canonicalPath(resolve(effect.path));
        const before = await snapshot(path);
        const content = "copyFrom" in effect
          ? (await snapshot(await canonicalPath(resolve(effect.copyFrom)))).bytes
          : effect.content;
        const after = typeof content === "string" ? Buffer.from(content) : content;
        if (after && after.length > CODE_CHECKPOINT_POLICY.maxFileBytes) throw new Error("Code checkpoint file limit exceeded");
        const previous = changes.find((change) => change.path === path);
        if (previous) previous.afterHash = hash(after);
        else changes.push({ path, ...await storeImage(before.bytes), mode: before.mode, afterHash: hash(after) });
      }
    } catch {
      // No effect ran: preserve earlier rewind images and require a person on retry.
      if (requiredCheckpointContext.getStore() === true) blockAutomaticWrites(identity);
      await makeUnavailable(turns, identity, "uncapturable original");
      requireAvailableCheckpoint(identity);
      return run();
    }
    turn.changes.push(...changes);
    if (requiredCheckpointContext.getStore() === true && ledgerStorageBytes(turns) > CODE_CHECKPOINT_POLICY.maxStorageBytes) {
      turn.changes = turn.changes.filter((entry) => !changes.includes(entry));
      blockAutomaticWrites(identity);
    }
    // Write ahead: a crash cannot leave a successful edit without its before-image.
    try { await save(turns, turn); }
    catch (error) {
      if (requiredCheckpointContext.getStore() === true) {
        identity.automaticWritesBlocked = true;
        turn.changes = turn.changes.filter((entry) => !changes.includes(entry));
        try { await save(turns, turn); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Code checkpoint rollback failed", { cause: error });
        }
      }
      throw error;
    }
    if (turn.unavailable) {
      identity.unavailable = true;
      requireAvailableCheckpoint(identity);
      return run();
    }
    for (const change of changes) {
      const current = await snapshot(change.path).catch(() => undefined);
      if (!current || hash(current.bytes) !== change.beforeHash) {
        turn.changes = turn.changes.filter((entry) => !changes.includes(entry));
        await save(turns, turn);
        throw new Error("File changed before checkpointed mutation");
      }
    }
    requireAvailableCheckpoint(identity);
    const removeUnchanged = async () => {
      // No-op failures claim no edit; partial effects remain guarded by the intended after-hash.
      for (const change of changes) {
        const current = await snapshot(change.path).catch(() => undefined);
        if (current && hash(current.bytes) === change.beforeHash) {
          const index = turn.changes.indexOf(change);
          if (index >= 0) turn.changes.splice(index, 1);
        }
      }
      await save(turns, turn);
    };
    const recordVerifiedCounts = async () => {
      let recorded = false;
      for (const change of changes) {
        if (!turn.changes.includes(change)) continue;
        const captures = turn.changes.filter((entry) => entry.path === change.path);
        if (captures.at(-1) !== change
          || captures.some((entry, index) => index > 0 && captures[index - 1].afterHash !== entry.beforeHash)) continue;
        const current = await snapshot(change.path).catch(() => undefined);
        if (!current || hash(current.bytes) !== change.afterHash) continue;
        const first = captures[0];
        const before = (await hydrate(first)).before;
        const original = turnReviewText(before === null ? null : Buffer.from(before, "base64"));
        const after = turnReviewText(current.bytes);
        const counts = countFileChangeLines(original, after);
        if (!counts.exact) continue;
        const previousAdded = change.addedLines;
        const previousRemoved = change.removedLines;
        change.addedLines = counts.added;
        change.removedLines = counts.removed;
        // Optional display metadata cannot evict a fitting restore image.
        if (ledgerStorageBytes(turns) > CODE_CHECKPOINT_POLICY.maxStorageBytes) {
          if (previousAdded === undefined) delete change.addedLines;
          else change.addedLines = previousAdded;
          if (previousRemoved === undefined) delete change.removedLines;
          else change.removedLines = previousRemoved;
          continue;
        }
        recorded = true;
      }
      if (recorded) await save(turns, turn);
    };
    try {
      const result = await run();
      if (result && typeof result === "object" && "isError" in result && result.isError === true) {
        await removeUnchanged();
      }
      return result;
    } catch (error) {
      await removeUnchanged();
      throw error;
    } finally {
      // Informational totals never replace the effect outcome or weaken restore hashes.
      await recordVerifiedCounts().catch((error: unknown) => log.warn("checkpoint line counts unavailable: %s", (error as Error).message));
    }
  });
}

export type CodeRestoreResult = { ok: true } | { ok: false; error: string; conflictingFiles?: string[] };
type RestoreContext = Pick<ToolExecutionContext, "cwd" | "extraAllowedDirectories">;

class TurnReviewReadError extends Error {
  constructor(readonly code: TurnReviewError) { super(code); }
}

function turnReviewText(bytes: Buffer | null): string {
  if (bytes === null) return "";
  const text = bytes.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text).equals(bytes)) throw new TurnReviewReadError("turn-review-unavailable");
  return text;
}

function turnReviewPath(path: string, context: () => RestoreContext): string {
  const { cwd, extraAllowedDirectories } = context();
  const verdict = assertReadableFilePath(path, cwd, buildRuntimeAllowedDirectories(extraAllowedDirectories, cwd));
  const local = relative(cwd, path).split(sep).join("/");
  if (!verdict.ok || verdict.resolved !== path || !local || isAbsolute(local)
    || local.split("/").some((part) => part === ".." || part === ".")
    || /[\u0000-\u001f\u007f\\]/.test(local) || local.length > FILE_MENTION_REFERENCE_POLICY.maxPathChars) {
    throw new TurnReviewReadError("turn-review-unavailable");
  }
  return local;
}

/** Build the latest settled turn's review from existing captures without storing review state. */
export async function getTurnChangeReview(
  sessionId: string,
  turnId: string,
  context: () => RestoreContext,
  options?: { currentDetails?: true; selectedPaths?: readonly string[] },
): Promise<TurnReviewResult> {
  return exclusive(async () => {
    try {
      const unavailable = () => liveChildren.has(childKey(sessionId)) || pendingUnavailable.has(childKey(sessionId))
        || [...inFlight].some((active) => active.dir === namespace.dir && active.sessionId === sessionId);
      if (unavailable()) throw new TurnReviewReadError("turn-review-unavailable");
      const turns = await loadLedger(true);
      const turn = turns.filter((item) => item.sessionId === sessionId).at(-1);
      if (!turn || turn.messageId !== turnId || turn.unavailable || turn.consumed) {
        throw new TurnReviewReadError("turn-review-unavailable");
      }
      const workspaceRoot = resolve(context().cwd);
      // Reference sends validate only their selected files; the ordinary review still checks the complete turn.
      const selectedPaths = options?.selectedPaths === undefined ? undefined
        : new Set(options.selectedPaths.map((path) => resolve(workspaceRoot, path)));
      const plan = new Map<string, { first: StoredChange; last: StoredChange; local: string }>();
      for (const change of turn.changes) {
        if (selectedPaths && !selectedPaths.has(change.path)) continue;
        const local = turnReviewPath(change.path, context);
        const previous = plan.get(change.path);
        if (previous && previous.last.afterHash !== change.beforeHash) throw new TurnReviewReadError("turn-review-stale");
        plan.set(change.path, { first: previous?.first ?? change, last: change, local });
      }
      if (selectedPaths && (selectedPaths.size === 0 || [...selectedPaths].some((path) => !plan.has(path)))) {
        throw new TurnReviewReadError("turn-review-unavailable");
      }
      const currentFile = async (path: string, expectedHash: string | null, requireMatch = true) => {
        turnReviewPath(path, context);
        const current = await snapshot(path).catch(() => { throw new TurnReviewReadError("turn-review-stale"); });
        turnReviewPath(path, context);
        if (requireMatch && hash(current.bytes) !== expectedHash) throw new TurnReviewReadError("turn-review-stale");
        return current;
      };
      const files: TurnChangeReview["files"] = [];
      const disclosedHashes = new Map<string, string | null>();
      for (const [path, { first, last, local }] of plan) {
        const current = await currentFile(path, last.afterHash, !options?.currentDetails);
        const currentMatches = hash(current.bytes) === last.afterHash;
        disclosedHashes.set(path, hash(current.bytes));
        const before = (await hydrate(first)).before;
        const original = turnReviewText(before === null ? null : Buffer.from(before, "base64"));
        let text: string | undefined;
        try { text = turnReviewText(current.bytes); }
        catch (error) { if (!options?.currentDetails) throw error; }
        if (first.beforeHash === last.afterHash) continue;
        const lineCount = text === undefined ? 0 : countTurnReviewLines(text);
        const hunks = text === undefined ? [] : createTurnReviewHunks(original, text, first.beforeHash === null || current.bytes === null,
          JSON.stringify([sessionId, turnId, local]));
        const currentCounts = currentMatches && text !== undefined ? countFileChangeLines(original, text) : undefined;
        const countsKnown = currentCounts?.exact === true || (last.addedLines !== undefined && last.removedLines !== undefined);
        files.push({
          path: local, bytes: current.bytes?.length ?? 0, lineCount,
          added: currentCounts?.exact ? currentCounts.added : last.addedLines ?? 0,
          removed: currentCounts?.exact ? currentCounts.removed : last.removedLines ?? 0,
          operation: first.beforeHash === null ? "create" : last.afterHash === null ? "delete" : "modify",
          countsKnown,
          referenceable: currentMatches && current.bytes !== null && lineCount > 0,
          hunks,
        });
      }
      // Originals and other files may take asynchronous reads; recheck every final capture before disclosure.
      for (const [path, { last, local }] of plan) {
        if (turnReviewPath(path, context) !== local) throw new TurnReviewReadError("turn-review-stale");
        await currentFile(path, options?.currentDetails ? disclosedHashes.get(path)! : last.afterHash);
      }
      if (unavailable()) throw new TurnReviewReadError("turn-review-unavailable");
      if (resolve(context().cwd) !== workspaceRoot) throw new TurnReviewReadError("turn-review-stale");
      return { ok: true, review: { sessionId, turnId, workspaceRoot, files } };
    } catch (error) {
      return { ok: false, error: error instanceof TurnReviewReadError ? error.code : "turn-review-failed" };
    }
  });
}

export async function restoreCodeCheckpoint(
  sessionId: string,
  messageId: string,
  context: RestoreContext | (() => RestoreContext),
): Promise<CodeRestoreResult> {
  return exclusive(async () => {
    try {
      const accessDenied = (path: string) => ensureFileAccess(path, {
        ...(typeof context === "function" ? context() : context), metadata: {},
      }, "write");
      if (liveChildren.has(childKey(sessionId))) return { ok: false, error: "code-checkpoint-unavailable" };
      const turns = await load();
      const index = turns.findIndex((turn) => turn.sessionId === sessionId && turn.messageId === messageId);
      if (index < 0 || turns[index].consumed) return { ok: false, error: "code-checkpoint-unavailable" };
      const suffix = turns.slice(index).filter((turn) => turn.sessionId === sessionId);
      if (suffix.some((turn) => turn.unavailable) || [...inFlight].some((active) => active.dir === namespace.dir
        && active.sessionId === sessionId)) return { ok: false, error: "code-checkpoint-unavailable" };
      const plan = new Map<string, StoredChange>();
      const conflicts = new Set<string>();
      for (const change of suffix.flatMap((turn) => turn.changes)) {
        const previous = plan.get(change.path);
        if (previous && previous.afterHash !== change.beforeHash) conflicts.add(change.path);
        plan.set(change.path, previous ? { ...previous, afterHash: change.afterHash } : { ...change });
      }
      const present = new Set<string>();
      for (const [path, change] of plan) {
        if (accessDenied(path)) return { ok: false, error: "code-restore-conflict", conflictingFiles: [path] };
        const file = await snapshot(path).catch(() => undefined);
        const parent = change.before === null ? true : await lstat(dirname(path)).then((info) => info.isDirectory(), () => false);
        if (!file || !parent || hash(file.bytes) !== change.afterHash) conflicts.add(path);
        else if (file.bytes !== null) present.add(path);
      }
      if (conflicts.size) return { ok: false, error: "code-restore-conflict", conflictingFiles: [...conflicts].sort() };
      const changed = new Set([...plan].filter(([, change]) =>
        change.beforeHash !== change.afterHash,
      ).map(([path]) => path));
      // Stage all replacements before mutation; missing parent directories are external changes and must cause refusal.
      const staged = new Map<string, string>();
      try {
        for (const [path, change] of plan) {
          if (change.before === null || !changed.has(path)) continue;
          const temporary = join(dirname(path), `.ave-restore-${randomUUID()}`);
          const handle = await open(temporary, "wx", 0o600);
          staged.set(path, temporary);
          try {
            await handle.writeFile(Buffer.from((await hydrate(change)).before!, "base64"));
            await handle.chmod(change.mode);
            await handle.sync();
          } finally { await handle.close(); }
        }
        // Recheck all files after staging, before the first destructive operation.
        for (const [path, change] of plan) {
          if (accessDenied(path)) conflicts.add(path);
          const file = await snapshot(path).catch(() => undefined);
          if (!file || hash(file.bytes) !== change.afterHash) conflicts.add(path);
        }
        if (conflicts.size) return { ok: false, error: "code-restore-conflict", conflictingFiles: [...conflicts].sort() };
        // A scanner briefly holding a target on Windows must not leave a partial restore.
        for (const [path, change] of plan) {
          if (!changed.has(path)) continue;
          if (change.before === null) {
            if (present.has(path)) await retryOnFileLock(() => unlink(path));
          } else await renameFile(staged.get(path)!, path);
        }
        // Guard the restored baseline on repeat calls; later points are not forward-restore authority.
        for (const turn of suffix) {
          turn.changes = [];
          turn.consumed = turn !== turns[index];
        }
        turns[index].changes = [...plan.values()].map((change) => ({
          ...change,
          afterHash: change.beforeHash,
        }));
        await save(turns);
        return { ok: true };
      } finally {
        for (const temporary of staged.values()) {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
      }
    } catch { return { ok: false, error: "code-restore-failed" }; }
  });
}
