/**
 * Storage layout inside a single plugin root (`~/.ave/plugins/<id>/`).
 *
 * A plugin root mixes three kinds of content with very different trust:
 *   - INSTALLED PAYLOAD (`plugin.json`, `dist/`, assets) — covered file by file
 *     by the install receipt and re-verified before every load;
 *   - the plugin's own WRITABLE STATE (`data/`) — created by
 *     `ensurePluginDataDir`, exposed as `hostApi.storage`, outside the receipt;
 *   - HOST-allocated worker control sockets (`run/<workerId>/`) — created by
 *     `permissions/worker-spawn.ts`, never plugin-written, outside the receipt.
 *
 * The split is a security boundary, not a convention: the OS write-jail grants
 * the plugin `data/` only, so plugin code cannot rewrite the bundle the next
 * load imports into the Electron main process.
 *
 * Shared by receipt verification, permissions and runtime-directory mutations
 * so their paths and host-side serialization agree.
 */
import { link, lstat, mkdir, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { renameDirectory } from "../lib/transient-fs-lock-retry.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { aveHome } from "../shared/ave-home.js";
import { PluginDataRootError, resolvePluginDataRoot } from "./plugin-storage-containment.js";

/**
 * Directory under a plugin root holding the plugin's own writable runtime
 * state. Created by `ensurePluginDataDir` (plugins/runtime/sandbox.ts).
 */
export const PLUGIN_DATA_DIR_NAME = "data";

/**
 * Directory under a plugin root holding HOST-allocated worker control sockets
 * (`run/<workerId>/control.sock`, see permissions/worker-spawn.ts).
 */
export const PLUGIN_WORKER_RUN_DIR_NAME = "run";

/**
 * Directory under a plugin root holding sockets the PLUGIN ITSELF binds:
 * `~/.ave/plugins/<pluginId>/sockets`.
 *
 * Distinct from {@link PLUGIN_WORKER_RUN_DIR_NAME}, which holds sockets the
 * HOST allocates and a worker binds. The two are kept apart because the
 * question "who created this socket" is the question an operator looking at a
 * stale one needs answered, and a single directory could not answer it.
 */
export const PLUGIN_OWN_SOCKET_DIR_NAME = "sockets";

/**
 * HOST-ONLY staging directory under a plugin root, used while
 * {@link carryPluginSocketDirs} moves `sockets/` entries between roots. No
 * child's envelope names it, so an entry renamed in here can no longer be
 * swapped by the plugin before the host inspects and links it. It is empty and
 * removed when a carry completes; one left by an interrupted carry is drained
 * into the same root's `sockets/` by the next carry that touches the root.
 */
export const PLUGIN_SOCKET_CARRY_DIR_NAME = ".sockets-carry";

/**
 * HOST-ONLY directory under a plugin root where {@link carryPluginSocketDirs}
 * deletes an entry. A recursive delete inside `sockets/` or a worker leaf —
 * both writable by a child — races the child, which can swap a subdirectory
 * for a link to an outside directory between rm's lstat and its descent. So
 * an entry is renamed in here (rename never follows) and deleted only here.
 * Emptied at the end of every delete and at the start of every carry.
 */
export const PLUGIN_SOCKET_DISCARD_DIR_NAME = ".sockets-discard";

/**
 * Every top-level directory under a plugin root that is RUNTIME STATE rather
 * than installed payload.
 *
 * One set, because every rule about these directories is the same rule: the
 * receipt verifier must not scan them, a payload must not ship them, and a
 * root-to-root payload copy must not duplicate them. They were previously
 * enumerated once in the receipt verifier and separately (as `data/` alone) in
 * the copy filter, and the copy filter's shorter list is exactly how a live
 * `sockets/egress.sock` reached a `cp` and failed it with `ERR_FS_CP_SOCKET`.
 *
 * What each one is, and why none of them is covered by the install receipt:
 *
 *  - `data/` — the plugin's writable state, created by `ensurePluginDataDir`
 *    (runtime/sandbox.ts) and the sole region the OS write-jail grants it. It
 *    holds index databases, migration markers and workspaces the plugin
 *    legitimately mutates while it runs, so scanning it would fail the receipt
 *    the moment the plugin does anything.
 *  - `run/` — HOST-allocated worker control sockets
 *    (`run/<workerId>/control.sock`, permissions/worker-spawn.ts). A worker
 *    that dies without cleanup leaves the socket behind; without this
 *    exclusion the next boot's payload scan hits a non-regular file and
 *    refuses to load an otherwise-intact plugin.
 *  - `sockets/` — sockets the PLUGIN ITSELF binds
 *    ({@link PLUGIN_OWN_SOCKET_DIR_NAME}). Exactly the same argument as
 *    `run/`, and it was missed originally because the two are deliberately
 *    separate directories: the host owns one and the plugin owns the other, so
 *    a rule written for one does not carry to the other on its own.
 *    local-indexer's egress broker binds `sockets/egress.sock`; a quit that
 *    left it behind made the NEXT boot refuse the plugin with "installed
 *    payload contains unsupported entry: sockets/egress.sock".
 *  - `.sockets-carry/` — the host's staging directory for a socket carry
 *    ({@link PLUGIN_SOCKET_CARRY_DIR_NAME}). It exists only during a carry, or
 *    after a crash in one until the next carry drains it, and it holds the
 *    same socket entries as `sockets/`.
 *  - `.sockets-discard/` — where that carry deletes entries
 *    ({@link PLUGIN_SOCKET_DISCARD_DIR_NAME}); transient in the same way.
 *
 * The exclusion is TOP LEVEL only, everywhere it is applied — a nested
 * `dist/data/` is shipped payload and stays validated, copied, and refused in
 * an uploaded artifact like any other file.
 *
 * Declared HERE, in the leaf that owns the names, rather than in the receipt
 * verifier that first needed it: the copy filter below is a consumer, and a
 * set declared in the verifier would have made this leaf import its own
 * dependent.
 */
export const PLUGIN_RUNTIME_DIR_NAMES: ReadonlySet<string> = new Set([
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
  PLUGIN_SOCKET_CARRY_DIR_NAME,
  PLUGIN_SOCKET_DISCARD_DIR_NAME,
]);

/**
 * Whether `name` is one of the runtime directory names, compared the way a
 * filesystem that folds case would compare it.
 *
 * Always case-insensitive, regardless of the platform running the check: this
 * decides whether an INSTALL PAYLOAD may carry a top-level entry, and a
 * payload built on Linux is installed on macOS and Windows, where `Data/` and
 * `data/` are the same directory. A payload that shipped `Data/` would land on
 * top of the plugin's live state there.
 */
export function isPluginRuntimeDirName(name: string): boolean {
  const canonical = name.normalize("NFC").toLocaleUpperCase("en-US");
  for (const runtimeDir of PLUGIN_RUNTIME_DIR_NAMES) {
    if (runtimeDir.toLocaleUpperCase("en-US") === canonical) return true;
  }
  return false;
}

/**
 * Whether this platform's filesystem treats `data/` and `Data/` as one
 * directory. macOS (APFS/HFS+ default) and Windows do; Linux does not.
 */
const PLUGIN_PATHS_ARE_CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32";

/**
 * Whether two paths name the same filesystem entry.
 *
 * WHY NOT `===`. The carry below asks the filesystem (`lstat`) whether a data
 * directory is there, and on a case-insensitive volume the filesystem answers
 * yes for `Data/`. A string-equality filter answers no for the same directory.
 * That disagreement is not cosmetic: the copy filter would COPY a `Data/` the
 * carry then refuses to reconcile, which is precisely the duplicate the two
 * exist to prevent. Both questions now go through this one comparison.
 *
 * Upper-casing rather than lower-casing for the reason
 * `canonicalZipEntryPathIdentity` gives: it folds multi-code-point aliases
 * (`Straße`/`STRASSE`) that lower-casing leaves distinct.
 *
 * @param caseInsensitive defaults to this platform's behaviour; passed
 * explicitly by tests, which must be able to exercise both filesystems from
 * whichever one they happen to run on.
 */
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

/**
 * The absolute directory a plugin-owned tool may write into without escaping
 * its storage namespace: `~/.ave/plugins/<pluginId>/data`.
 *
 * Deliberately NOT the plugin root. The root holds the plugin's own executable
 * bundle (`dist/`) and its manifest; granting write access there lets sandboxed
 * plugin code rewrite the very module the next load imports into the Electron
 * main process. Load-time receipt verification detects such a rewrite, but the
 * jail removes the primitive instead of merely detecting its use.
 */
export function resolvePluginWritableRoot(pluginId: string): string {
  return resolve(aveHome(), "plugins", pluginId, PLUGIN_DATA_DIR_NAME);
}

/**
 * The owner-plugin sandbox root a plugin-owned tool invocation is judged and
 * jailed against, or `undefined` when there is none to trust.
 *
 * The reviewer's "write inside owner plugin sandbox" auto-LOW and the shell
 * write jail both canonicalise this path, so a data root a confined plugin had
 * replaced with a link would make the link's target the plugin's "own"
 * sandbox. It goes through {@link resolvePluginDataRoot} first: a root that is
 * not the host's real directory yields `undefined`, which is the stricter path
 * for both readers — no auto-LOW, and a jail of the allowed directories only.
 * A root that does not exist yet has no link to follow and is returned as is.
 * The lexical path, not the canonical one, is returned, because it is part of
 * the reviewer's verdict-cache identity.
 */
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

/**
 * Move a plugin root's own writable state (`data/`) from one root to another.
 *
 * WHY THIS EXISTS. Install and recovery replace a plugin ROOT as a unit — the
 * live directory is renamed aside, a freshly extracted payload is promoted in
 * its place, and the obsolete root is removed — because a whole-directory
 * rename is the only atomic swap the filesystem offers. But `data/` is not
 * payload. It is the plugin's state (index databases, recorded sessions,
 * settings sidecars), and the receipt already says so by skipping it. A root
 * swap that does not take the data directory along deletes the state with the
 * root it happened to sit in, and the next load recreates an empty one, so the
 * loss is silent.
 *
 * So every promotion moves the data directory into the promoted root BEFORE
 * the transaction commits, and every step that discards a root moves the data
 * directory into the root that survives FIRST. The move is one `rename` on the
 * same volume: no bytes are copied, and at every instant the directory is
 * wholly at `fromRoot` or wholly at `toRoot`, never split between them.
 *
 * Returns whether a directory moved. `fromRoot` holding none is an ordinary
 * outcome (a plugin that never wrote state, or a root whose state already
 * moved on). `toRoot` already holding one is a CONFLICT, and what to do about
 * it is the caller's to say — see {@link PluginDataCarryPolicy}.
 */
export async function carryPluginDataDir(
  fromRoot: string,
  toRoot: string,
  policy: PluginDataCarryPolicy,
): Promise<boolean> {
  const source = resolve(fromRoot, PLUGIN_DATA_DIR_NAME);
  const target = resolve(toRoot, PLUGIN_DATA_DIR_NAME);
  if (!await pathExists(source)) return false;
  if (await pathExists(target)) {
    if (policy.onConflict === "reject") {
      throw new Error(
        `[plugin-storage-layout] both roots hold a plugin data directory; refusing to `
          + `replace ${target} with ${source}`,
      );
    }
    if (!await clearCarryDestination(source, target, fromRoot, toRoot, policy)) return false;
  }
  await rename(source, target);
  return true;
}

/**
 * What {@link carryPluginDataDir} does when the destination root already holds
 * a data directory. There is no default: the two callers need opposite
 * answers, and the wrong one is silent in both directions.
 *
 * `reject` — an INSTALL transaction. It built the destination root itself from
 * a verified payload moments earlier, so a data directory there is a statement
 * that the transaction's own bookkeeping is wrong. It has a rollback path and
 * must take it rather than merge two candidates for one state.
 *
 * `resolve` — RECOVERY. It is handed whatever the crash left behind and has no
 * rollback: refusing leaves `pendingUpdate` set forever, so the plugin never
 * loads again and no later boot can clear it. Recovery must always reach a
 * terminal disposition, so a conflict is decided here, by rules that never
 * delete state:
 *
 *  1. an EMPTY directory holds no state and is removed. That is the conflict
 *     seen in practice — an interrupted carry, or a storage call landing in
 *     the swap window — and either side of the carry can be the empty one. If
 *     the DESTINATION is empty it goes and the carry proceeds; if the SOURCE is
 *     empty instead, the destination's real state stays where it already is;
 *  2. two non-empty directories are not equal candidates, and which one is the
 *     stray is structural rather than a guess. Only the LIVE plugin path
 *     (`unattributedRoot`) is somewhere a stray write can land — a recovery
 *     backup path is never a storage target, and it holds state a transaction
 *     deliberately put there. So the directory under `unattributedRoot` is the
 *     one handed to `moveAside`, and the other one wins: when the loser is the
 *     destination the carry proceeds over it, and when the loser is the SOURCE
 *     the destination keeps the state it already holds and nothing is carried.
 *
 * `moveAside` must KEEP what it is handed. Recovery parks it in the
 * unattributed-state namespace, which nothing sweeps — the point of the call is
 * that a human decides, so a destination that deletes (the uninstall tombstone
 * lifecycle, say) would make rule 2 a lie.
 */
export type PluginDataCarryPolicy =
  | { onConflict: "reject" }
  | {
      onConflict: "resolve";
      /**
       * The plugin root whose `data/` is NOT authoritative when both roots hold
       * state: the live install path, the only one a stray write can reach.
       */
      unattributedRoot: string;
      /** Take custody of the losing `data/`, KEEP it, and leave its path free. */
      moveAside: (conflictingDataDir: string) => Promise<void>;
    };

/** @returns whether the destination is now free for the carry to proceed. */
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
    // Neither side is the live path, or both claim to be. Recovery always
    // carries to or from the live install directory, so this is a caller that
    // named the wrong root — a bug to fix, not a state to guess at.
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
    // ENOTDIR: something that is not a directory occupies the name. It is not
    // empty, it is not the plugin's state, and it goes to `moveAside` with
    // everything else that needs looking at rather than deleting.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * The runtime directories that hold Unix-domain sockets rather than state:
 * `run/` (host-allocated worker control sockets) and `sockets/` (sockets the
 * plugin binds itself). {@link PLUGIN_RUNTIME_DIR_NAMES} minus `data/` and
 * the carry's own staging and discard directories.
 */
const PLUGIN_SOCKET_DIR_NAMES: readonly string[] = [
  PLUGIN_WORKER_RUN_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
];

/**
 * Queue host mutations of one plugin's runtime directories. The lifecycle
 * lock admits reentrant work, so it cannot exclude a worker allocation inside
 * the same lifecycle operation. Reuse the filesystem queue for this short
 * section; never hold it while starting or waiting for a child.
 */
export function withPluginRuntimeDirQueue<T>(pluginRoot: string, operation: () => Promise<T>): Promise<T> {
  return withInProcessFileQueue(pluginRuntimeDirKey(pluginRoot), operation);
}

function pluginRuntimeDirKey(pluginRoot: string): string {
  const path = resolve(pluginRoot);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Move a plugin root's socket directories (`run/`, `sockets/`) from one root
 * to another, next to the {@link carryPluginDataDir} the same swap performs.
 *
 * WHY A ROOT SWAP MUST TAKE THEM ALONG. A staged install activates its
 * candidate BEFORE the durable commit: the child is spawned, and the spawn
 * materialises every directory of its envelope at the FINAL plugin root
 * (`spawnConfinedPluginChild` creates `sockets/` and `run/` beside `data/`;
 * an in-process load gets `sockets/` from `ensurePluginDataDir`). The durable
 * commit then renames that root aside and promotes the staged payload in its
 * place. A swap that carries `data/` only leaves the promoted root without
 * `sockets/`, so the candidate — now running, its sandbox profile granting
 * exactly that path — binds into a directory that no longer exists:
 * `listen EACCES …/sockets/egress.sock` on macOS, and its startup is recorded
 * as degraded until a restart re-creates the directory. It is the same loss on
 * update, where the renamed-aside root also held the predecessor's live socket
 * directory.
 *
 * WHY A RENAME AND NOT A FRESH `mkdir`. The directory the spawn created is the
 * one the child's sandbox was built against. Seatbelt names it by path, so a
 * new directory at that path would satisfy macOS, but a Linux bubblewrap child
 * holds a bind mount of the directory itself, and only the same directory —
 * moved, never re-created — is the one that child can reach. This is the move
 * `data/` already gets for the same reason.
 *
 * WHEN THE DESTINATION ALREADY HOLDS ONE. That is not a bookkeeping error by
 * itself: a live generation's worker may `mkdir run/<workerId>` at the
 * destination path in the window between a root rename and this carry, and a
 * recovery runs while the live predecessor's workers keep doing so. The
 * SOURCE directory always keeps its identity, because it is the one the
 * running children were wrapped against: every caller carries the directory
 * that was moved away from the live path back toward it. So the destination's
 * entries — `run/<workerId>/`, `sockets/<name>` — move INTO the source,
 * each keeping its own identity; the emptied destination is removed,
 * and the source moves into place. Whichever side is empty, nothing is
 * dropped and no live directory is replaced by a newer one.
 *
 * Only the same entry name on both sides is a real conflict. Preflight checks
 * both directories before anything moves, using the caller's policy, which
 * has no default for the reason
 * {@link PluginDataCarryPolicy} has none:
 *  - `reject` — an INSTALL transaction. Two sockets claiming one name means
 *    the transaction's bookkeeping is wrong; it throws to its rollback with
 *    both sides untouched for a conflict present at preflight;
 *  - `keep-destination` — RECOVERY, which must always reach a terminal
 *    disposition. Sockets are not state, so the destination's entry replaces
 *    the source's. With no destination root at all, nothing moves. An entry
 *    of a shape the carry refuses (below) is removed — rm never follows a
 *    link — and reported through `onDiscardEntry` instead of thrown: a child
 *    can leave a directory, symlink or FIFO in its own `sockets/`, and a
 *    throw there would leave the plugin unresolved on every boot.
 * Host worker allocation shares the runtime-directory queue, so no worker
 * directory can arrive between preflight and the moves. A child may still
 * bind a socket file; link-then-unlink refuses an existing name atomically.
 * Earlier completed moves remain in the owned roots for retry or recovery.
 *
 * WHY `sockets/` ENTRIES GO THROUGH A HOST-ONLY STAGING DIRECTORY. `sockets/`
 * is in the child's write envelope, so the child can replace any entry in it
 * at any moment, including with a symlink to a file it cannot write. On macOS
 * `link(2)` FOLLOWS a symlink and hard-links its target, so linking straight
 * out of `sockets/` would hand the child a writable name for that file.
 * Checking the entry first does not close it: the child can swap the entry
 * between the check and the link. So each entry is first renamed (which never
 * follows) into {@link PLUGIN_SOCKET_CARRY_DIR_NAME} of the receiving root,
 * where no child can touch it; only there is it inspected, refused unless it
 * is a socket or a regular file, linked, and verified. A symlink or other
 * shape found at preflight is refused before anything moves (`reject`) or
 * removed (`keep-destination`). Nothing is ever deleted recursively where a
 * child can write: see {@link PLUGIN_SOCKET_DISCARD_DIR_NAME}.
 *
 * Directories use {@link renameDirectory}, which retries the transient
 * Windows lock codes (reporting each retry through `policy.onRetry`); callers
 * do not wrap it again.
 */
export type PluginSocketCarryPolicy =
  | {
    readonly onConflict: "reject";
    readonly onRetry?: (attempt: number, code: string) => void;
  }
  | {
    readonly onConflict: "keep-destination";
    readonly onRetry?: (attempt: number, code: string) => void;
    /** A refused `sockets/` entry was removed; recovery logs it. */
    readonly onDiscardEntry: (path: string, reason: string) => void;
  };

export async function carryPluginSocketDirs(
  fromRoot: string,
  toRoot: string,
  policy: PluginSocketCarryPolicy,
): Promise<void> {
  if (isSamePluginPath(fromRoot, toRoot)) return;
  await withPluginRuntimeDirQueues([fromRoot, toRoot], async () => {
    // Recovery may discard a root while no live root survives (a cleanup after
    // an uninstall): nothing is bound there to hand the sockets to.
    if (policy.onConflict === "keep-destination" && !await pathExists(toRoot)) return;
    const move = (from: string, to: string): Promise<void> => renameDirectory(from, to, policy.onRetry);
    // Check every root and both names before the first mutation. A linked root
    // would make readdir/entry moves operate on a tree outside the plugin.
    await assertSocketDirectory(fromRoot);
    await assertSocketDirectory(toRoot);
    // A crash mid-delete leaves only entries already out of every child's reach.
    for (const root of [fromRoot, toRoot]) await emptyDiscardDirectory(root);
    // An interrupted carry may have left host-staged entries in either root.
    // They were already out of the child's reach; finish placing them first.
    for (const root of [fromRoot, toRoot]) await finishStagedSocketEntries(root, policy);
    for (const name of PLUGIN_SOCKET_DIR_NAMES) {
      const source = resolve(fromRoot, name);
      const target = resolve(toRoot, name);
      const sourceExists = await assertSocketDirectory(source);
      const targetExists = await assertSocketDirectory(target);
      // Only host-owned run entries may be directories. A child can create a
      // directory inside sockets, where rename could replace a late empty one,
      // and a symlink there must never reach link(). Refuse both shapes before
      // mutation instead of claiming host exclusion.
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
      // Bounded: a worker that recreates the destination between the merge and
      // the final rename makes that rename fail, and the merge runs again.
      for (let attempt = 1; ; attempt += 1) {
        try {
          // A link refused with EEXIST on the previous attempt left its entry
          // staged; it is placed (or refused) before anything new moves.
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
                // Children can write inside their worker leaf, but cannot create
                // a sibling in the host-owned run root. The shared queue excludes
                // host mkdir, including an empty leaf, while this rename runs.
                // A leaf removed since readdir has nothing left to move.
                await moveUnlessVanished(from, to, move);
              } else {
                // Out of the child's reach first (rename never follows), then
                // inspected and linked there; see the function comment.
                await mkdir(staging, { recursive: true });
                const staged = resolve(staging, entry);
                // A child may unlink its own socket after readdir: nothing to move.
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
            // A live child kept adding entries (or a worker kept recreating the
            // destination). Everything moved so far is in an owned root, so the
            // caller may simply retry once the child settles or exits.
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

/**
 * Hold the runtime-directory queue of every distinct root, in one global
 * order. Equal keys are collapsed first: nesting the same in-process queue
 * twice would wait on itself forever. Defensive: carryPluginSocketDirs returns
 * early for one root, so no caller reaches equal keys today.
 */
function withPluginRuntimeDirQueues(roots: readonly string[], operation: () => Promise<void>): Promise<void> {
  const keys = [...new Set(roots.map(pluginRuntimeDirKey))].sort();
  return keys.reduceRight<() => Promise<void>>(
    (inner, key) => () => withInProcessFileQueue(key, inner),
    operation,
  )();
}

/**
 * Why the carry may not move this `sockets/` entry, if it may not: a
 * directory (see the preflight) or anything that is not a socket or a regular
 * file, a symlink above all, because macOS `link(2)` would follow it.
 */
async function socketEntryShapeRefusal(path: string): Promise<string | undefined> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    // Unlinked by its child since readdir: there is nothing to refuse.
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry === undefined) return undefined;
  if (entry.isDirectory()) return `Plugin socket entry is a directory: ${path}`;
  if (!entry.isSocket() && !entry.isFile()) return `Plugin socket entry is not a socket or regular file: ${path}`;
  return undefined;
}

/**
 * Act on a refused entry shape: `reject` throws, leaving the entry where it
 * is unless `removeOnReject` (a host-staged entry, which would otherwise
 * refuse every later carry); `keep-destination` discards it and reports it.
 * Returns whether the entry is gone. `root` is the plugin root holding it.
 */
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

/**
 * Delete one entry of `root`'s runtime directories without ever recursing
 * where a child can write: rename it (never follows) into the root's
 * host-only discard directory under a unique name, then delete it there.
 */
async function discardRuntimeEntry(root: string, path: string): Promise<void> {
  const discard = resolve(root, PLUGIN_SOCKET_DISCARD_DIR_NAME);
  await mkdir(discard, { recursive: true });
  await moveUnlessVanished(path, resolve(discard, `${randomUUID()}-${basename(path)}`), renameDirectory);
  await emptyDiscardDirectory(root);
}

async function emptyDiscardDirectory(root: string): Promise<void> {
  const discard = resolve(root, PLUGIN_SOCKET_DISCARD_DIR_NAME);
  if (!await assertSocketDirectory(discard)) return;
  await rm(discard, { recursive: true, force: true });
}

/**
 * Give a host-staged `sockets/` entry its final name, then drop the staged
 * one. The staged entry is out of every child's reach, so the shape checked
 * here is the shape linked. A refused entry is removed from staging under
 * either policy: rm does not follow a symlink, and leaving it would refuse
 * every later carry too.
 * After an interrupted unlink the two names already share the inode, which
 * finishes the move rather than counting as a conflict.
 */
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
    // A live child can still bind this name now: link refuses EEXIST without
    // replacing it, and the caller's next attempt places the entry again.
    await link(staged, to);
    // Defensive: the staged entry was just checked to be no link, so link(2)
    // cannot have followed it; this catches a platform that still did.
    if (!await socketEntriesMatch(staged, to)) {
      throw new Error(`[plugin-storage-layout] linked socket entry does not match its staged source: ${to}`);
    }
  }
  await unlink(staged);
}

/**
 * Place every entry a previous, interrupted carry left in this root's staging
 * directory into the same root's `sockets/` (the directory it was moving
 * toward), then remove the staging directory.
 */
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

/**
 * Move `from` to `to`, or report that `from` vanished first (a child unlinked
 * its own entry between the caller's readdir and this rename). Any other
 * failure, including a missing destination parent, propagates.
 */
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

/** Both names exist and are different entries: a real same-name conflict. */
async function socketEntriesConflict(source: string, target: string): Promise<boolean> {
  return await pathExists(source) && await pathExists(target) && !await socketEntriesMatch(source, target);
}

async function socketEntriesMatch(from: string, to: string): Promise<boolean> {
  try {
    // bigint: a Windows 64-bit file id does not survive a double.
    const source = await lstat(from, { bigint: true });
    const target = await lstat(to, { bigint: true });
    return source.ino !== 0n && source.ino === target.ino && source.dev === target.dev;
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

/**
 * `cp` filter that copies a plugin root's payload and leaves its RUNTIME
 * directories behind ({@link PLUGIN_RUNTIME_DIR_NAMES}).
 *
 * `data/` is excluded because state is carried by {@link carryPluginDataDir} —
 * one rename, never a copy — so a root copy that included it would create the
 * second candidate the carry has to reconcile. `run/` and `sockets/` are
 * excluded because they hold live Unix-domain sockets, and `cp` over a socket
 * does not skip it: it fails the whole copy with `ERR_FS_CP_SOCKET`, which
 * takes the enclosing install or recovery down with it. local-indexer's egress
 * broker keeps `sockets/egress.sock` bound for as long as the plugin runs.
 */
export function pluginPayloadCopyFilter(root: string): (source: string) => boolean {
  const runtimeDirs = [...PLUGIN_RUNTIME_DIR_NAMES].map((name) => resolve(root, name));
  return (source) => !runtimeDirs.some((dir) => isSamePluginPath(source, dir));
}

/**
 * Refuse to treat `root` as a payload-only tree when it holds a runtime
 * directory. Callers that delete a staging, restore or backup copy right away
 * rely on it holding payload only: no confined process is granted a path in
 * it, so nothing can race the recursive delete. A runtime directory there
 * (state, a live socket, a worker leaf) breaks that premise, and the delete
 * must go through the deferred tree removal instead.
 */
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

/**
 * Where a confined plugin child may bind a Unix-domain socket.
 *
 * WHY A PLUGIN NEEDS ONE AT ALL. A plugin that has to be reached by a process
 * it spawned — `local-indexer`'s egress broker is the case that forced this —
 * used to bind loopback TCP. That is ambient axis 1 in the routing SOT, and it
 * is the half of axis 1 the census long missed: not egress, INBOUND BIND. On
 * macOS the confined bind is refused outright, and on Linux the child's network
 * namespace makes loopback unreachable from outside it. A Unix socket has
 * neither problem, because it is a filesystem object.
 *
 * WHY THE HOST OWNS THE DIRECTORY. The Unix-socket ALLOW is a SHARED ASRT
 * config entry scoped to a DIRECTORY on macOS (`(subpath <dir>)`), and the
 * seatbelt profile is generated when the child is wrapped — so the directory
 * has to be known and registered BEFORE the spawn, which is a thing only the
 * host can do. See the WORKER UDS header in `permissions/asrt-sandbox.ts`.
 */
export function resolvePluginSocketDir(pluginDataDir: string): string {
  // Derived FROM the data directory rather than rebuilt from `aveHome()` and
  // the plugin id. The two coincide in production and diverge under a test that
  // relocates the plugins root, and a socket directory that disagreed with the
  // data directory it is supposed to sit beside would be granted in one place
  // and created in another — a silent inequality, not a crash.
  return resolve(dirname(pluginDataDir), PLUGIN_OWN_SOCKET_DIR_NAME);
}

/**
 * Where the HOST binds control sockets for workers this plugin asked for:
 * `~/.ave/plugins/<pluginId>/run`.
 *
 * WHY THE CHILD NEEDS IT. `permissions/worker-spawn.ts` allocates
 * `run/<workerId>/control.sock`, registers that directory so the WORKER may
 * bind, and its header records the assumption that made the other half
 * unnecessary: "the host connects from OUTSIDE the sandbox (unconstrained)."
 * That stopped being true when every plugin moved out of process. The client is
 * now the plugin's own confined child, and a child whose profile does not name
 * this directory binds nothing and connects nowhere — `connect EPERM` on a
 * socket that exists and that an unconfined process reaches without trouble.
 *
 * The whole subtree rather than one worker's leaf, and registered for every
 * child rather than the ones known to spawn workers, for the reason
 * {@link resolvePluginSocketDir} carries: the directory is inside the plugin's
 * own namespace and grants no reach beyond it, and the alternative is a list
 * someone has to remember to update.
 */
export function resolvePluginWorkerRunRoot(pluginDataDir: string): string {
  // Derived FROM the data directory for the reason resolvePluginSocketDir is:
  // the two must not be able to disagree about which plugin root they mean.
  return resolve(dirname(pluginDataDir), PLUGIN_WORKER_RUN_DIR_NAME);
}

/**
 * The most bytes a Unix-domain socket PATH can have on this platform.
 *
 * `sockaddr_un.sun_path` is a fixed char array — 104 on macOS/BSD, 108 on
 * Linux — and one of those bytes is the terminating NUL. A path over the limit
 * does not fail as "too long": `bind()` returns `EINVAL`, which reads as a
 * malformed address and sends the reader looking at the wrong thing entirely.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = (process.platform === "darwin" ? 104 : 108) - 1;

/**
 * Refuse a socket path the kernel cannot hold, and say why.
 *
 * Called BEFORE anything binds, on the host side, because the failure this
 * prevents is opaque at every later point: the child reports `EINVAL`, the
 * host sees a worker that never came up, and nothing in either message
 * mentions a length. The check is cheap and the diagnosis it replaces is not.
 *
 * The limit is reached in practice rather than in theory — a long account name
 * plus a long plugin id plus a per-worker subdirectory is most of 104 bytes
 * before the socket's own name.
 *
 * @param socketPath the full path something is about to bind.
 * @param what a short noun for the caller, used in the message.
 */
export function assertUnixSocketPathFits(socketPath: string, what: string): void {
  const bytes = Buffer.byteLength(socketPath, "utf-8");
  if (bytes <= MAX_UNIX_SOCKET_PATH_BYTES) return;
  throw new Error(
    `[plugin-storage-layout] ${what}: socket path is ${String(bytes)} bytes, over this `
      + `platform's ${String(MAX_UNIX_SOCKET_PATH_BYTES)}-byte limit — bind() would fail `
      + `with EINVAL and name no cause. Path: ${socketPath}`,
  );
}
