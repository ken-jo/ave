// Separates receipt-covered payload, child-writable runtime state, and host-only storage.
// Install swaps and recovery share these directory identities and mutation queues.
import { constants, realpathSync, type BigIntStats, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, readlink, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import { renameDirectory } from "../lib/transient-fs-lock-retry.js";
import { errorMessage } from "../shared/error-message.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { aveHome } from "../shared/ave-home.js";
import { assertNoConfinedProcessMayRun, confinedProcessesMayBeRunning } from "../lib/confined-process-phase.js";
import { removeOwnedPluginTree } from "./installed-entry-fs.js";
import { PluginDataRootError, isPathWithin, resolvePluginDataRoot } from "./plugin-storage-containment.js";

export const PLUGIN_DATA_DIR_NAME = "data";

/** Host-only storage stays outside child write envelopes, preserving HostApi effect and DLP checks. */
export const PLUGIN_HOST_STORAGE_DIR_NAME = "storage";

/** Build storage in host-only staging, then rename it atomically; interrupted copies restart on boot. */
export const PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME = ".storage-migrating";

const PLUGIN_STATE_DIR_NAMES: readonly string[] = [PLUGIN_DATA_DIR_NAME, PLUGIN_HOST_STORAGE_DIR_NAME];

/** Host-allocated worker control sockets live under run/<workerId>/. */
export const PLUGIN_WORKER_RUN_DIR_NAME = "run";

/** Plugin-bound sockets and host-allocated worker sockets use separate roots with different ownership. */
export const PLUGIN_OWN_SOCKET_DIR_NAME = "sockets";

/** Rename socket entries into host-only staging before inspection so the child cannot swap them. */
export const PLUGIN_SOCKET_CARRY_DIR_NAME = ".sockets-carry";

/** Rename entries into host-only discard before recursive deletion; child-writable trees can race with links. */
export const PLUGIN_SOCKET_DISCARD_DIR_NAME = ".sockets-discard";

/** Runtime directories must be excluded from receipts and payloads, and carried across root swaps. */
export const PLUGIN_RUNTIME_DIR_NAMES: ReadonlySet<string> = new Set([
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_HOST_STORAGE_DIR_NAME,
  PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
  PLUGIN_SOCKET_CARRY_DIR_NAME,
  PLUGIN_SOCKET_DISCARD_DIR_NAME,
]);

/** Reject runtime-directory names case-insensitively on every platform so payloads remain safe to install elsewhere. */
export function isPluginRuntimeDirName(name: string): boolean {
  const canonical = name.normalize("NFC").toLocaleUpperCase("en-US");
  for (const runtimeDir of PLUGIN_RUNTIME_DIR_NAMES) {
    if (runtimeDir.toLocaleUpperCase("en-US") === canonical) return true;
  }
  return false;
}

/** Default desktop filesystems fold case; Linux paths remain case-sensitive. */
const PLUGIN_PATHS_ARE_CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32";

/** Match filesystem path identity, including case folding, so data directories are never copied into payloads. */
export function isSamePluginPath(
  left: string,
  right: string,
  caseInsensitive: boolean = PLUGIN_PATHS_ARE_CASE_INSENSITIVE,
): boolean {
  const a = resolve(left).normalize("NFC");
  const b = resolve(right).normalize("NFC");
  if (!caseInsensitive) return a === b;
  return a.toLocaleUpperCase("en-US") === b.toLocaleUpperCase("en-US");
}

/** Grant writes only to data/, never the executable install root, so plugin tools cannot rewrite their bundle. */
export function resolvePluginWritableRoot(pluginId: string): string {
  return resolve(aveHome(), "plugins", pluginId, PLUGIN_DATA_DIR_NAME);
}

/** Return the canonical trusted data root for both write confinement and reviewer-cache identity. */
export function resolveOwnerPluginSandboxRoot(pluginId: string): string | undefined {
  const root = resolvePluginWritableRoot(pluginId);
  try {
    resolvePluginDataRoot(`plugin '${pluginId}'`, root);
  } catch (error) {
    if (error instanceof PluginDataRootError) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
    throw error;
  }
  return root;
}

/** Carry state by rename across root replacement; callers must choose an explicit conflict policy. */
export async function carryPluginStateDirs(
  fromRoot: string,
  toRoot: string,
  policy: PluginDataCarryPolicy,
): Promise<boolean> {
  if (policy.onConflict === "reject") {
    for (const name of PLUGIN_STATE_DIR_NAMES) {
      const source = resolve(fromRoot, name);
      const target = resolve(toRoot, name);
      if (await pathExists(source) && await pathExists(target)) {
        throw new Error(
          `[plugin-storage-layout] both roots hold a plugin ${stateDirLabel(name)} directory; refusing to `
            + `replace ${target} with ${source}`,
        );
      }
    }
  }
  let moved = false;
  for (const name of PLUGIN_STATE_DIR_NAMES) {
    const source = resolve(fromRoot, name);
    const target = resolve(toRoot, name);
    if (!await pathExists(source)) continue;
    if (await pathExists(target)) {
      if (policy.onConflict === "reject") throw new Error(`[plugin-storage-layout] ${target} appeared during the carry`);
      if (!await clearCarryDestination(source, target, fromRoot, toRoot, policy)) continue;
    }
    await rename(source, target);
    moved = true;
  }
  return moved;
}

function stateDirLabel(name: string): string {
  return name === PLUGIN_DATA_DIR_NAME ? "data" : "host storage";
}

// Install rejects conflicting state and rolls back; recovery must reach a terminal result without deleting state.
// Recovery removes empty directories, but parks nonempty live-path state through moveAside and keeps the backup’s state.
// moveAside must retain the losing directory for human review; it must never use a swept namespace.
export type PluginDataCarryPolicy =
  | { onConflict: "reject" }
  | {
      onConflict: "resolve";
      /** Only the live install path can receive stray writes; backup state remains authoritative during recovery. */
      unattributedRoot: string;
      moveAside: (conflictingDataDir: string) => Promise<void>;
    };

async function clearCarryDestination(
  source: string,
  target: string,
  fromRoot: string,
  toRoot: string,
  policy: Extract<PluginDataCarryPolicy, { onConflict: "resolve" }>,
): Promise<boolean> {
  if (await isEmptyDirectory(target)) {
    await rmdir(target);
    return true;
  }
  if (await isEmptyDirectory(source)) {
    await rmdir(source);
    return false;
  }
  const sourceIsUnattributed = isSamePluginPath(fromRoot, policy.unattributedRoot);
  const targetIsUnattributed = isSamePluginPath(toRoot, policy.unattributedRoot);
  if (sourceIsUnattributed === targetIsUnattributed) {
    // Recovery must identify exactly one live root; ambiguous callers must fail instead of guessing state ownership.
    throw new Error(
      `[plugin-storage-layout] cannot attribute a data directory conflict between `
        + `${source} and ${target}: neither is under ${policy.unattributedRoot}`,
    );
  }
  const loser = sourceIsUnattributed ? source : target;
  await policy.moveAside(loser);
  if (await pathExists(loser)) {
    throw new Error(
      `[plugin-storage-layout] conflicting plugin data directory was not moved aside: ${loser}`,
    );
  }
  return !sourceIsUnattributed;
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    // ENOTDIR occupants are not empty plugin state; retain them through moveAside.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}

/** Socket roots exclude durable state and host-only carry/discard staging. */
const PLUGIN_SOCKET_DIR_NAMES: readonly string[] = [
  PLUGIN_WORKER_RUN_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
];

/** Serialize runtime-directory mutations separately from reentrant lifecycle locks; never hold this queue while awaiting a child. */
export function withPluginRuntimeDirQueue<T>(pluginRoot: string, operation: () => Promise<T>): Promise<T> {
  return withInProcessFileQueue(pluginRuntimeDirKey(pluginRoot), operation);
}

function pluginRuntimeDirKey(pluginRoot: string): string {
  const path = resolve(pluginRoot);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

// Preserve source directory identity across swaps because running children may hold bind mounts of it.
// Merge destination entries into the source before restoring it; host worker allocation shares this mutation queue.
// Install rejects name conflicts before mutation; recovery keeps destination entries and reports discarded invalid shapes.
// Rename child-writable entries into host-only staging before checking and linking, because link may follow a swapped symlink.
// Never recurse where a child can write; completed moves remain owned for retry, and renameDirectory owns lock retries.
export type PluginSocketCarryPolicy =
  | {
    readonly onConflict: "reject";
    readonly onRetry?: (attempt: number, code: string) => void;
  }
  | {
    readonly onConflict: "keep-destination";
    readonly onRetry?: (attempt: number, code: string) => void;
    readonly onDiscardEntry: (path: string, reason: string) => void;
  };

export async function carryPluginSocketDirs(
  fromRoot: string,
  toRoot: string,
  policy: PluginSocketCarryPolicy,
): Promise<void> {
  if (isSamePluginPath(fromRoot, toRoot)) return;
  await withPluginRuntimeDirQueues([fromRoot, toRoot], async () => {
    // Without a surviving live root, recovery has no running socket owner to receive these entries.
    if (policy.onConflict === "keep-destination" && !await pathExists(toRoot)) return;
    const move = (from: string, to: string): Promise<void> => renameDirectory(from, to, policy.onRetry);
    // Validate both roots and names before mutation so linked roots cannot redirect entry moves.
    await assertSocketDirectory(fromRoot);
    await assertSocketDirectory(toRoot);
    // Interrupted deletes leave entries outside every child’s reach.
    for (const root of [fromRoot, toRoot]) await emptyDiscardDirectory(root);
    // Finish host-staged entries from interrupted carries before moving new ones.
    for (const root of [fromRoot, toRoot]) await finishStagedSocketEntries(root, policy);
    for (const name of PLUGIN_SOCKET_DIR_NAMES) {
      const source = resolve(fromRoot, name);
      const target = resolve(toRoot, name);
      const sourceExists = await assertSocketDirectory(source);
      const targetExists = await assertSocketDirectory(target);
      // Only host-owned run entries may be directories; reject child-created directories and symlinks before mutation.
      if (name === PLUGIN_OWN_SOCKET_DIR_NAME) {
        for (const dir of [sourceExists ? source : undefined, targetExists ? target : undefined]) {
          if (dir) for (const entry of await readdir(dir)) await refuseSocketEntryShape(resolve(dir, entry), policy, dirname(dirname(resolve(dir, entry))));
        }
      }
      if (sourceExists && targetExists && policy.onConflict === "reject") {
        for (const entry of await readdir(target)) {
          if (await socketEntriesConflict(resolve(source, entry), resolve(target, entry))) {
            throw socketConflict(name, entry, source, target);
          }
        }
      }
    }
    for (const name of PLUGIN_SOCKET_DIR_NAMES) {
      const source = resolve(fromRoot, name);
      const target = resolve(toRoot, name);
      if (!await pathExists(source)) continue;
      // Bound retries because workers can recreate the destination between merge and rename.
      for (let attempt = 1; ; attempt += 1) {
        try {
          // Place or refuse previously staged EEXIST entries before staging more.
          if (name === PLUGIN_OWN_SOCKET_DIR_NAME) await finishStagedSocketEntries(fromRoot, policy);
          if (await assertSocketDirectory(target)) {
            const entries = await readdir(target);
            const conflicts: string[] = [];
            for (const entry of entries) {
              if (await socketEntriesConflict(resolve(source, entry), resolve(target, entry))) conflicts.push(entry);
            }
            if (conflicts.length > 0 && policy.onConflict === "reject") {
              throw socketConflict(name, conflicts[0]!, source, target);
            }
            const staging = resolve(fromRoot, PLUGIN_SOCKET_CARRY_DIR_NAME);
            for (const entry of entries) {
              if (conflicts.includes(entry)) await discardRuntimeEntry(fromRoot, resolve(source, entry));
              const from = resolve(target, entry);
              const to = resolve(source, entry);
              if (name === PLUGIN_WORKER_RUN_DIR_NAME) {
                // Children cannot create worker siblings; the shared host queue excludes new leaves during rename.
                await moveUnlessVanished(from, to, move);
              } else {
                // Rename out of child reach before inspecting or linking.
                await mkdir(staging, { recursive: true });
                const staged = resolve(staging, entry);
                // A child may unlink its socket between enumeration and move.
                if (await moveUnlessVanished(from, staged, move)) await placeStagedSocketEntry(staged, to, policy, fromRoot);
              }
            }
            if (await pathExists(staging)) await rmdir(staging);
            await rmdir(target);
          }
          await move(source, target);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
          if (attempt >= 3) {
            // Concurrent writers may exhaust retries; completed moves remain in owned roots for a later retry.
            throw Object.assign(
              new Error(`[plugin-storage-layout] ${target} kept gaining entries from a live process across ${attempt} carry attempts; retry the carry`, { cause: error }),
              { code },
            );
          }
        }
      }
    }
  });
}

/** Lock distinct roots in global order and collapse equal keys to avoid self-deadlock. */
function withPluginRuntimeDirQueues(roots: readonly string[], operation: () => Promise<void>): Promise<void> {
  const keys = [...new Set(roots.map(pluginRuntimeDirKey))].sort();
  return keys.reduceRight<() => Promise<void>>(
    (inner, key) => () => withInProcessFileQueue(key, inner),
    operation,
  )();
}

/** Only sockets and regular files may be linked; symlinks can be followed by the platform link call. */
async function socketEntryShapeRefusal(path: string): Promise<string | undefined> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry === undefined) return undefined;
  if (entry.isDirectory()) return `Plugin socket entry is a directory: ${path}`;
  if (!entry.isSocket() && !entry.isFile()) return `Plugin socket entry is not a socket or regular file: ${path}`;
  return undefined;
}

/** Reject leaves entries untouched unless host-staged; recovery discards refused shapes and reports them. */
async function refuseSocketEntryShape(
  path: string,
  policy: PluginSocketCarryPolicy,
  root: string,
  removeOnReject = false,
): Promise<boolean> {
  const refusal = await socketEntryShapeRefusal(path);
  if (refusal === undefined) return false;
  if (policy.onConflict === "reject") {
    if (removeOnReject) await discardRuntimeEntry(root, path);
    throw new Error(refusal);
  }
  await discardRuntimeEntry(root, path);
  policy.onDiscardEntry(path, refusal);
  return true;
}

/** Rename into host-only discard before recursive deletion so child writes cannot redirect traversal. */
async function discardRuntimeEntry(root: string, path: string): Promise<void> {
  const discard = resolve(root, PLUGIN_SOCKET_DISCARD_DIR_NAME);
  await mkdir(discard, { recursive: true });
  await moveUnlessVanished(path, resolve(discard, `${randomUUID()}-${basename(path)}`), renameDirectory);
  await emptyDiscardDirectory(root);
}

async function emptyDiscardDirectory(root: string): Promise<void> {
  const discard = resolve(root, PLUGIN_SOCKET_DISCARD_DIR_NAME);
  if (!await assertSocketDirectory(discard)) return;
  // A live child may keep writing discarded entries; boot retries deletion.
  if (confinedProcessesMayBeRunning()) return;
  // Child-held locks or immutable files can prevent immediate discard cleanup.
  await removeOwnedPluginTree(discard);
}

/** Sweep live-root discard directories at boot; non-live roots are removed whole by recovery. */
export async function sweepPluginSocketDiscardDirs(pluginsRoot: string): Promise<string[]> {
  assertNoConfinedProcessMayRun(`the socket discard directories under ${pluginsRoot}`);
  let names: string[];
  try {
    names = await readdir(pluginsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const emptied: string[] = [];
  const failures: unknown[] = [];
  for (const name of names) {
    const root = resolve(pluginsRoot, name);
    try {
      if (!(await lstat(root)).isDirectory()) continue;
      await withPluginRuntimeDirQueue(root, async () => {
        if (!await pathExists(resolve(root, PLUGIN_SOCKET_DISCARD_DIR_NAME))) return;
        await emptyDiscardDirectory(root);
        emptied.push(root);
      });
    } catch (error) {
      // One failed root must not prevent sweeping other roots.
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `[plugin-storage-layout] ${failures.length} socket discard director(ies) under ${pluginsRoot} were not emptied`);
  }
  return emptied;
}

/** Inspect and link only host-staged entries; shared inode identity completes an interrupted move without conflict. */
async function placeStagedSocketEntry(
  staged: string,
  to: string,
  policy: PluginSocketCarryPolicy,
  root: string,
): Promise<void> {
  if (!await socketEntriesMatch(staged, to)) {
    if (await refuseSocketEntryShape(staged, policy, root, true)) return;
    if (await pathExists(to)) {
      if (policy.onConflict === "reject") {
        throw new Error(`[plugin-storage-layout] a socket was bound at ${to} during the carry; the carried entry stays staged at ${staged}`);
      }
      await discardRuntimeEntry(root, to);
    }
    // Atomic link refuses a name newly bound by a live child; leave staging available for retry.
    await link(staged, to);
    // Verify the linked entry in case platform behavior followed an unexpected link.
    if (!await socketEntriesMatch(staged, to)) {
      throw new Error(`[plugin-storage-layout] linked socket entry does not match its staged source: ${to}`);
    }
  }
  await unlink(staged);
}

/** Drain interrupted staging into its own root’s sockets/ before removing staging. */
async function finishStagedSocketEntries(root: string, policy: PluginSocketCarryPolicy): Promise<void> {
  const staging = resolve(root, PLUGIN_SOCKET_CARRY_DIR_NAME);
  if (!await assertSocketDirectory(staging)) return;
  const sockets = resolve(root, PLUGIN_OWN_SOCKET_DIR_NAME);
  if (!await assertSocketDirectory(sockets)) {
    throw new Error(`[plugin-storage-layout] staged socket entries have no socket directory to return to: ${staging}`);
  }
  for (const entry of await readdir(staging)) {
    await placeStagedSocketEntry(resolve(staging, entry), resolve(sockets, entry), policy, root);
  }
  await rmdir(staging);
}

/** Only a vanished source is benign; missing destination parents and other rename failures propagate. */
async function moveUnlessVanished(
  from: string,
  to: string,
  move: (from: string, to: string) => Promise<void>,
): Promise<boolean> {
  try {
    await move(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !await pathExists(from)) return false;
    throw error;
  }
}

async function socketEntriesConflict(source: string, target: string): Promise<boolean> {
  return await pathExists(source) && await pathExists(target) && !await socketEntriesMatch(source, target);
}

async function socketEntriesMatch(from: string, to: string): Promise<boolean> {
  try {
    // Use bigint because 64-bit file ids lose precision in doubles.
    const source = await lstat(from, { bigint: true });
    const target = await lstat(to, { bigint: true });
    return source.ino !== 0n && sameFileIdentity(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function socketConflict(name: string, entry: string, source: string, target: string): Error {
  return new Error(`[plugin-storage-layout] both roots hold ${name}/${entry}; refusing to merge ${target} into ${source}`);
}

async function assertSocketDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Plugin socket root is not a real directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Copy payload only; state moves by rename and live socket inodes must never be copied. */
export function pluginPayloadCopyFilter(root: string): (source: string) => boolean {
  const runtimeDirs = [...PLUGIN_RUNTIME_DIR_NAMES].map((name) => resolve(root, name));
  return (source) => !runtimeDirs.some((dir) => isSamePluginPath(source, dir));
}

/** Immediate tree deletion requires payload-only roots; runtime directories require deferred removal. */
export async function assertPayloadOnlyPluginTree(root: string): Promise<void> {
  for (const name of PLUGIN_RUNTIME_DIR_NAMES) {
    if (await pathExists(resolve(root, name))) {
      throw new Error(`[plugin-storage-layout] ${root} holds runtime directory ${name}/; it is not a payload-only tree to delete now`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Confined children bind sockets only in their granted socket root; host worker control sockets use a separate root. */
export function resolvePluginSocketDir(pluginDataDir: string): string {
  // Derive sibling paths from the data directory so relocated plugin roots keep creation and grants aligned.
  return resolve(dirname(pluginDataDir), PLUGIN_OWN_SOCKET_DIR_NAME);
}

/** Host-only storage is the sibling of data/, derived from the same root. */
export function resolvePluginHostStorageDir(pluginDataDir: string): string {
  return resolve(dirname(pluginDataDir), PLUGIN_HOST_STORAGE_DIR_NAME);
}

/** Reject write grants intersecting host storage, including ancestor grants; compare Windows paths without case sensitivity. */
export function writeGrantsReachingHostStorage(pluginDataDir: string, writePaths: readonly string[]): string[] {
  const fold = (path: string): string => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  const storage = fold(resolvePluginHostStorageDir(pluginDataDir));
  return writePaths.filter((path) => {
    const grant = fold(path);
    return isPathWithin(grant, storage) || isPathWithin(storage, grant);
  });
}

/** Limit migration to storage-sized values so recordings and workspaces do not enter host storage. */
const MIGRATED_STORAGE_FILE_BYTES_MAX = 8 * 1024 * 1024;

/** Skip deeper trees because they are plugin-managed state rather than supported storage keys. */
const MIGRATED_STORAGE_KEY_DEPTH_MAX = 2;

export interface PluginHostStorageMigration {
  readonly migrated: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** Retry failed migration roots on the next boot. */
  readonly failed: ReadonlyArray<{ readonly root: string; readonly error: string }>;
}

// Copy eligible data/ files into staged host storage without changing the original state.
// Skip oversized or deep entries, links, hardlinks, sockets, and special files; report every skipped entry.
// Never hard-link copied files back into child-writable data, and verify opened inode identity before reading.
// Migration runs before confined processes; Windows relies on this ordering, while other platforms also check links.
// Publish storage/ by atomic rename; interrupted staging is rebuilt and already-published roots are untouched.
/** Retain this boot’s migration failures by canonical root. */
const hostStorageMigrationFailures = new Map<string, string>();

/** Missing-storage refusals report the original migration cause so persistent failures remain actionable. */
export function hostStorageMigrationFailureFor(pluginDataDir: string): string | undefined {
  try {
    return hostStorageMigrationFailures.get(realpathSync(dirname(pluginDataDir)));
  } catch {
    return undefined;
  }
}

export async function migratePluginHostStorage(pluginsRoot: string): Promise<PluginHostStorageMigration> {
  if (confinedProcessesMayBeRunning()) {
    throw new Error(
      `[plugin-storage-layout] refusing to migrate host storage under ${pluginsRoot}: confined processes may already `
        + "be running, and one could re-point a path under data/ while it is copied; it runs at boot, before any starts",
    );
  }
  const migrated: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ root: string; error: string }> = [];
  let canonicalPluginsRoot: string;
  let names: string[];
  try {
    // Canonicalize paths before no-follow opens so host-created path aliases do not fail migration.
    canonicalPluginsRoot = await realpath(pluginsRoot);
    names = await readdir(canonicalPluginsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { migrated, skipped, failed };
    throw error;
  }
  for (const name of names) {
    const root = resolve(canonicalPluginsRoot, name);
    try {
      if (!(await lstat(root)).isDirectory()) continue;
      const data = resolve(root, PLUGIN_DATA_DIR_NAME);
      const dataEntry = await lstatOrUndefined(data);
      if (dataEntry === undefined) continue;
      const storage = resolve(root, PLUGIN_HOST_STORAGE_DIR_NAME);
      const storageEntry = await lstatOrUndefined(storage);
      if (storageEntry !== undefined) {
        if (!storageEntry.isDirectory()) {
          throw new Error(`[plugin-storage-layout] ${storage} is not a directory`);
        }
        continue;
      }
      await withPluginRuntimeDirQueue(root, async () => {
        const staging = resolve(root, PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME);
        if (await lstatOrUndefined(staging) !== undefined) await removeOwnedPluginTree(staging);
        await mkdir(staging, { mode: 0o700 });
        if (dataEntry.isDirectory()) {
          await copyStorageTree(data, staging, skipped, 1, async () => true);
        } else {
          skipped.push({ path: data, reason: "not a directory; nothing copied" });
        }
        await renameDirectory(staging, storage);
      });
      migrated.push(root);
      hostStorageMigrationFailures.delete(root);
    } catch (error) {
      failed.push({ root, error: errorMessage(error) });
      hostStorageMigrationFailures.set(root, errorMessage(error));
    }
  }
  return { migrated, skipped, failed };
}

/** `O_NOFOLLOW_ANY` (macOS 11+, `<sys/fcntl.h>`): no link in any component. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

function noFollowOpenFlags(): number {
  if (process.platform === "win32") return 0;
  // O_NOFOLLOW_ANY already covers the final component; combining both flags fails with EINVAL.
  return process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW;
}

async function copyStorageTree(
  from: string,
  to: string,
  skipped: Array<{ path: string; reason: string }>,
  depth: number,
  // Create staging parents only when copying a file so skipped trees leave no empty namespaces.
  ready: () => Promise<boolean>,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(from);
  } catch (error) {
    // Skip unreadable directories instead of refusing the plugin on every boot.
    skipped.push({ path: from, reason: unreadableReason(error) });
    return;
  }
  for (const name of names) {
    const source = resolve(from, name);
    const target = resolve(to, name);
    let entry: BigIntStats;
    try {
      entry = await lstat(source, { bigint: true });
    } catch (error) {
      skipped.push({ path: source, reason: unreadableReason(error) });
      continue;
    }
    if (entry.isDirectory()) {
      // A directory at the key-depth limit can hold only unsupported deeper keys.
      if (depth >= MIGRATED_STORAGE_KEY_DEPTH_MAX) {
        skipped.push({ path: source, reason: `deeper than a storage key (depth ${MIGRATED_STORAGE_KEY_DEPTH_MAX})` });
        continue;
      }
      let made: Promise<boolean> | undefined;
      const targetReady = (): Promise<boolean> => (made ??= ready().then((parentMade) => parentMade
        && intoStaging(target, source, skipped, () => mkdir(target, { mode: 0o700 }).then(() => undefined))));
      await copyStorageTree(source, target, skipped, depth + 1, targetReady);
      continue;
    }
    const refusal = migratedFileRefusal(entry);
    if (refusal !== undefined) {
      skipped.push({ path: source, reason: refusal });
      continue;
    }
    let handle;
    try {
      handle = await open(source, constants.O_RDONLY | noFollowOpenFlags());
    } catch (error) {
      // Unreadable files were outside the old storage view; skip them without failing the root.
      skipped.push({
        path: source,
        reason: (error as NodeJS.ErrnoException).code === "ELOOP" ? "a link in its path" : unreadableReason(error),
      });
      continue;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      const changed = !sameFileIdentity(opened, entry)
        || !(await openedAtPath(handle.fd, source));
      const openedRefusal = changed ? "replaced while it was being copied" : migratedFileRefusal(opened);
      if (openedRefusal !== undefined) {
        skipped.push({ path: source, reason: openedRefusal });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await handle.readFile();
      } catch (error) {
        skipped.push({ path: source, reason: unreadableReason(error) });
        continue;
      }
      if (!(await ready())) continue;
      await intoStaging(target, source, skipped, () => writeFile(target, bytes, { mode: 0o600, flag: "wx" }));
    } finally {
      await handle.close();
    }
  }
}

// Linux must verify /proc/self/fd against the intended path because O_NOFOLLOW checks only the final component.
// Other no-follow primitives cover parents; Windows instead relies on migration preceding confined processes.
async function openedAtPath(fd: number, path: string): Promise<boolean> {
  if (process.platform !== "linux") return true;
  return (await readlink(`/proc/self/fd/${fd}`)) === path;
}

/** Skip entry-specific access and disappearance failures; propagate host I/O errors so incomplete roots retry. */
const UNREADABLE_ENTRY_CODES: ReadonlySet<string> = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "ENXIO", "ENAMETOOLONG",
]);

/** Longer staging names can exceed path limits; skip those entries rather than blocking every boot. */
async function intoStaging(
  target: string,
  source: string,
  skipped: Array<{ path: string; reason: string }>,
  create: () => Promise<void>,
): Promise<boolean> {
  try {
    await create();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw error;
    skipped.push({ path: source, reason: `too long under storage/: ${target.length} characters` });
    return false;
  }
}

function unreadableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === undefined || !UNREADABLE_ENTRY_CODES.has(code)) throw error;
  return code === "ENOENT" ? "vanished" : `unreadable: ${code}`;
}

function migratedFileRefusal(entry: BigIntStats): string | undefined {
  if (!entry.isFile()) return entry.isSymbolicLink() ? "a link" : "not a regular file";
  if (entry.nlink !== 1n) return "hard-linked";
  if (entry.size > BigInt(MIGRATED_STORAGE_FILE_BYTES_MAX)) return "larger than 8 MiB";
  return undefined;
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Host-allocated worker control sockets use run/<workerId>/; child grants must reach that same root. */
export function resolvePluginWorkerRunRoot(pluginDataDir: string): string {
  // Derive from pluginDataDir so worker socket grants and creation share one root.
  return resolve(dirname(pluginDataDir), PLUGIN_WORKER_RUN_DIR_NAME);
}

/** Reserve the terminating NUL in sockaddr_un; oversized paths otherwise fail as opaque malformed addresses. */
const MAX_UNIX_SOCKET_PATH_BYTES = (process.platform === "darwin" ? 104 : 108) - 1;

/** Check socket path length before binding so the diagnostic names the actual path limit. */
export function assertUnixSocketPathFits(socketPath: string, what: string): void {
  const bytes = Buffer.byteLength(socketPath, "utf-8");
  if (bytes <= MAX_UNIX_SOCKET_PATH_BYTES) return;
  throw new Error(
    `[plugin-storage-layout] ${what}: socket path is ${String(bytes)} bytes, over this `
      + `platform's ${String(MAX_UNIX_SOCKET_PATH_BYTES)}-byte limit — bind() would fail `
      + `with EINVAL and name no cause. Path: ${socketPath}`,
  );
}
