import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { openFeatureNamespace } from "../main/storage/feature-namespace.js";
import { CODE_CHECKPOINT_POLICY } from "../shared/code-rewind.js";

const namespace = openFeatureNamespace("code-checkpoints");
const FILE_NAME = "turns.json";
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const ChangeSchema = z.object({
  path: z.string().refine(isAbsolute),
  before: z.string().max(Math.ceil(CODE_CHECKPOINT_POLICY.maxFileBytes / 3) * 4)
    .refine((value) => Buffer.byteLength(value, "base64") <= CODE_CHECKPOINT_POLICY.maxFileBytes
      && Buffer.from(value, "base64").toString("base64") === value).nullable(),
  mode: z.number().int(),
  afterHash: HashSchema,
});
const TurnSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  unavailable: z.boolean(),
  changes: z.array(ChangeSchema),
});
const LedgerSchema = z.array(TurnSchema).max(CODE_CHECKPOINT_POLICY.maxTurns);
type Change = z.infer<typeof ChangeSchema>;
type Turn = z.infer<typeof TurnSchema>;
interface TurnIdentity { sessionId: string; messageId: string }
const turnContext = new AsyncLocalStorage<TurnIdentity>();
let queue: Promise<unknown> = Promise.resolve();

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
      throw new Error("Code checkpoint namespace is invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function load(): Promise<Turn[]> {
  await verifyNamespace();
  let handle;
  try {
    handle = await open(join(namespace.dir, FILE_NAME), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > CODE_CHECKPOINT_POLICY.maxStorageBytes
      || (typeof process.getuid === "function" && info.uid !== process.getuid())
      || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
      throw new Error("Code checkpoint storage is invalid");
    }
    return LedgerSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

async function save(turns: Turn[], retained?: Turn): Promise<void> {
  // Prune oldest whole turns. A surviving boundary always retains its full suffix.
  while (turns.length > CODE_CHECKPOINT_POLICY.maxTurns
    || turns.some((turn) => turns.filter((other) => other.sessionId === turn.sessionId).length > CODE_CHECKPOINT_POLICY.maxSessionTurns)
    || Buffer.byteLength(JSON.stringify(turns, null, 2) + "\n") > CODE_CHECKPOINT_POLICY.maxStorageBytes) {
    if (turns[0] === retained) throw new Error("Code checkpoint storage limit exceeded");
    turns.shift();
  }
  await verifyNamespace();
  await namespace.writeJson(FILE_NAME, turns);
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
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { await lstat(path); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, mode: 0o600 };
        throw missing;
      }
    }
    throw error;
  }
  try {
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
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error("Code checkpoint file changed during capture");
    }
    return { bytes: Buffer.from(bytes.subarray(0, length)), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function withCodeCheckpoint<T>(identity: TurnIdentity, run: () => Promise<T>): Promise<T> {
  await exclusive(async () => {
    const turns = await load();
    const existing = turns.find((turn) => turn.sessionId === identity.sessionId && turn.messageId === identity.messageId);
    if (!existing) turns.push({ ...identity, unavailable: false, changes: [] });
    await save(turns, existing ?? turns[turns.length - 1]);
  });
  return turnContext.run(identity, run);
}

/** Remote edits and file transfers have no host before-image contract. */
export async function markCodeCheckpointUnavailable(): Promise<void> {
  const identity = turnContext.getStore();
  if (!identity) return;
  await exclusive(async () => {
    const turns = await load();
    const turn = turns.find((item) => item.sessionId === identity.sessionId && item.messageId === identity.messageId);
    if (!turn) throw new Error("Code checkpoint was pruned");
    turn.unavailable = true;
    await save(turns, turn);
  });
}

/** Called only after native file-tool authorization and immediately before mutation. */
export async function checkpointFileMutation<T>(
  effects: Array<{ path: string } & ({ content: Buffer | string | null } | { copyFrom: string })>,
  run: () => Promise<T>,
): Promise<T> {
  const identity = turnContext.getStore();
  if (!identity) return run();
  return exclusive(async () => {
    const turns = await load();
    const turn = turns.find((item) => item.sessionId === identity.sessionId && item.messageId === identity.messageId);
    if (!turn) throw new Error("Code checkpoint was pruned");
    const changes: Change[] = [];
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
      else changes.push({ path, before: before.bytes?.toString("base64") ?? null, mode: before.mode, afterHash: hash(after) });
    }
    turn.changes.push(...changes);
    // Write ahead: a crash cannot leave a successful edit without its before-image.
    await save(turns, turn);
    const removeUnchanged = async () => {
      // Failed no-op operations do not claim an edit. Partial effects remain guarded
      // by their intended after-hash, never by arbitrary bytes read after execution.
      for (const change of changes) {
        const current = await snapshot(change.path).catch(() => undefined);
        if (current && hash(current.bytes) === hash(change.before === null ? null : Buffer.from(change.before, "base64"))) {
          const index = turn.changes.indexOf(change);
          if (index >= 0) turn.changes.splice(index, 1);
        }
      }
      await save(turns, turn);
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
    }
  });
}

export type CodeRestoreResult = { ok: true } | { ok: false; error: string; conflictingFiles?: string[] };

export async function restoreCodeCheckpoint(sessionId: string, messageId: string): Promise<CodeRestoreResult> {
  return exclusive(async () => {
    try {
      const turns = await load();
      const index = turns.findIndex((turn) => turn.sessionId === sessionId && turn.messageId === messageId);
      if (index < 0) return { ok: false, error: "code-checkpoint-unavailable" };
      const suffix = turns.slice(index).filter((turn) => turn.sessionId === sessionId);
      if (suffix.some((turn) => turn.unavailable)) return { ok: false, error: "code-checkpoint-unavailable" };
      const plan = new Map<string, Change>();
      const conflicts = new Set<string>();
      for (const change of suffix.flatMap((turn) => turn.changes)) {
        const previous = plan.get(change.path);
        const beforeHash = hash(change.before === null ? null : Buffer.from(change.before, "base64"));
        if (previous && previous.afterHash !== beforeHash) conflicts.add(change.path);
        plan.set(change.path, previous ? { ...previous, afterHash: change.afterHash } : { ...change });
      }
      const present = new Set<string>();
      for (const [path, change] of plan) {
        const file = await snapshot(path).catch(() => undefined);
        const parent = change.before === null ? true : await lstat(dirname(path)).then((info) => info.isDirectory(), () => false);
        if (!file || !parent || hash(file.bytes) !== change.afterHash) conflicts.add(path);
        else if (file.bytes !== null) present.add(path);
      }
      if (conflicts.size) return { ok: false, error: "code-restore-conflict", conflictingFiles: [...conflicts].sort() };
      // Stage every replacement before changing any target. Do not create missing
      // parent directories: their removal is an external change and must refuse.
      const staged = new Map<string, string>();
      try {
        for (const [path, change] of plan) {
          if (change.before === null) continue;
          const temporary = join(dirname(path), `.ave-restore-${randomUUID()}`);
          const handle = await open(temporary, "wx", 0o600);
          staged.set(path, temporary);
          try {
            await handle.writeFile(Buffer.from(change.before, "base64"));
            await handle.sync();
          } finally { await handle.close(); }
          await chmod(temporary, change.mode);
        }
        // Recheck all files after staging, before the first destructive operation.
        for (const [path, change] of plan) {
          if (hash((await snapshot(path)).bytes) !== change.afterHash) conflicts.add(path);
        }
        if (conflicts.size) return { ok: false, error: "code-restore-conflict", conflictingFiles: [...conflicts].sort() };
        for (const [path, change] of plan) {
          if (change.before === null) {
            if (present.has(path)) await unlink(path);
          } else await rename(staged.get(path)!, path);
        }
        // Keep boundaries but consume their edits, so code-only rewind is idempotent
        // and a later turn starts from the restored state.
        for (const turn of suffix) turn.changes = [];
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
