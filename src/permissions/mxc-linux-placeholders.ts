import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { isMissingPathError, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { renameFileOnceSync } from "../lib/transient-fs-lock-retry.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
import {
  currentMxcRuntimeHost, requireMxcContainerStartRoot, type MxcRuntimeHost,
} from "./mxc-runtime-root.js";
import { atOrUnder, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";

const DirectoryIdentity = z.object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) });
const AbsolutePath = z.string().refine((path) => path !== "/" && posix.isAbsolute(path) && posix.normalize(path) === path);
const PidMarker = z.object({ pid: z.number().int().positive(), start: z.string().min(1).nullable() });
const PlaceholderRegistry = z.object({
  runs: z.array(z.object({
    id: z.uuid(), owner: PidMarker, launcher: PidMarker.optional(),
    /** A Linux holder's outer bwrap, which Ave started directly: stopped at the next boot if its owner died first. */
    holder: z.object({ pid: z.number().int().positive(), start: z.string().min(1), executable: AbsolutePath }).optional(),
  })),
  directories: z.array(z.object({
    path: AbsolutePath, identity: DirectoryIdentity.optional(), parent: DirectoryIdentity,
    leaf: z.boolean(), owners: z.array(z.uuid()),
    /** Journalled before `mkdir`, not yet proved: the folder may or may not exist. `notBefore` is the epoch in ns. */
    pending: z.object({ notBefore: z.string().regex(/^\d+$/u) }).optional(),
  }).refine((directory) => (directory.identity === undefined) !== (directory.pending === undefined))),
});

type PlaceholderRegistry = z.infer<typeof PlaceholderRegistry>;
type DirectoryIdentity = z.infer<typeof DirectoryIdentity>;
type PidMarker = z.infer<typeof PidMarker>;

function directoryIdentity(path: string): DirectoryIdentity | undefined {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return entry?.isDirectory() && realpathSync.native(path) === path
    ? { device: String(entry.dev), inode: String(entry.ino) }
    : undefined;
}

function isSameDirectory(path: string, expected: DirectoryIdentity): boolean {
  const identity = directoryIdentity(path);
  return identity?.device === expected.device && identity.inode === expected.inode;
}

function isLive(marker: PidMarker, host: MxcRuntimeHost): boolean {
  if (!host.processExists(marker.pid)) return false;
  const start = host.processStart(marker.pid);
  return start === null || marker.start === null || marker.start === start;
}

const log = createLogger("mxc-linux-placeholders");

/** The journal exists and cannot be read or does not hold a registry. No launch can judge what it owns until a restart. */
class ContainerPlaceholderJournalError extends Error {
  override readonly name = "ContainerPlaceholderJournalError";
  constructor(readonly path: string, cause: unknown) {
    super(`Container placeholder journal ${path} cannot be read; restart Ave to recover it`, { cause });
  }
}

function readRegistry(path: string): PlaceholderRegistry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { runs: [], directories: [] };
    throw new ContainerPlaceholderJournalError(path, error);
  }
  try {
    return PlaceholderRegistry.parse(JSON.parse(text));
  } catch (error) {
    throw new ContainerPlaceholderJournalError(path, error);
  }
}

/** A folder this run holds was replaced or moved on the host since the run proved it. */
export class ContainerPlaceholderChangedError extends Error {
  override readonly name = "ContainerPlaceholderChangedError";
  constructor(readonly path: string) {
    super(`Container placeholder changed before start: ${path}`);
  }
}

let recoveryNotice: string | undefined;

/** The one notice left by a boot sweep that set an unreadable journal aside, handed out once. */
export function takeMxcLinuxPlaceholderRecoveryNotice(): string | undefined {
  const notice = recoveryNotice;
  recoveryNotice = undefined;
  return notice;
}

function saveRegistry(path: string, registry: PlaceholderRegistry): void {
  writeUtf8FileAtomicSync(path, JSON.stringify(registry));
}

/**
 * File times come from the kernel's coarse clock, which can trail the wall clock by a tick. A folder made just after
 * its entry was journalled must still count as made after it.
 */
const PENDING_CLOCK_SLACK_MS = 100;

/**
 * A pending folder is ours only if it is a directory made at or after its entry was journalled, under the recorded
 * parent. One that existed before (the user's) has an earlier change time and is left alone.
 */
function isPendingFolderOurs(path: string, notBefore: string): boolean {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return entry?.isDirectory() === true && realpathSync.native(path) === path && entry.ctimeNs >= BigInt(notBefore);
}

/** Remove only empty directories of the recorded identity, in leaf-to-root order. */
function retireRun(registry: PlaceholderRegistry, id: string): void {
  registry.runs = registry.runs.filter((run) => run.id !== id);
  dropOwnership(registry, id, () => true);
}

/** Drops `id` from the directories `drop` selects, removing each that has no owner left and is still ours. */
function dropOwnership(registry: PlaceholderRegistry, id: string, drop: (path: string) => boolean): void {
  for (const directory of registry.directories.toSorted((a, b) => b.path.length - a.path.length)) {
    if (!drop(directory.path)) continue;
    directory.owners = directory.owners.filter((owner) => owner !== id);
    if (directory.owners.length > 0) continue;
    try {
      const ours = directory.identity !== undefined ? isSameDirectory(directory.path, directory.identity)
        : directory.pending !== undefined && isPendingFolderOurs(directory.path, directory.pending.notBefore);
      if (isSameDirectory(posix.dirname(directory.path), directory.parent) && ours) rmdirSync(directory.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A sibling may have been written by the command. Preserve it and give up ownership of that directory.
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && !isMissingPathError(error)) throw error;
    }
  }
  registry.directories = registry.directories.filter((directory) => directory.owners.length > 0);
}

function sweepDeadRuns(registry: PlaceholderRegistry, host: MxcRuntimeHost): boolean {
  let changed = false;
  for (const run of registry.runs) {
    if (isLive(run.owner, host) || (run.launcher !== undefined && isLive(run.launcher, host))
      || (run.holder !== undefined && isLive(run.holder, host))) continue;
    retireRun(registry, run.id);
    changed = true;
  }
  return changed;
}

function registryPath(host: MxcRuntimeHost): string {
  if (host.platform !== "linux") throw new Error("Container placeholders require Linux");
  return posix.join(requireMxcContainerStartRoot(host), "shell-placeholders.json");
}

/** How the boot stop reads and stops a recorded holder: `/proc/<pid>/exe` and a group KILL by default. */
interface MxcLinuxOrphanHolderOps {
  executable(pid: number): string | null;
  kill(pid: number): void;
}

const PROC_ORPHAN_HOLDER_OPS: MxcLinuxOrphanHolderOps = {
  executable(pid) {
    try { return readlinkSync(`/proc/${pid}/exe`); } catch { return null; }
  },
  kill(pid) {
    // The outer bwrap leads its own group (the launch gate starts it detached); its namespace ends with it.
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  },
};

/**
 * Boot, before any listener opens (design 3 rule 4): a holder whose Ave died, and whose recorded bwrap is still the
 * same process (same start time) running the recorded executable, is stopped. A pid failing either check is a
 * different process now and is left alone; its marker is dropped. Either way the run is retired by the dead-run sweep.
 */
function stopOrphanHolders(registry: PlaceholderRegistry, host: MxcRuntimeHost, ops: MxcLinuxOrphanHolderOps): boolean {
  let changed = false;
  for (const run of registry.runs) {
    const holder = run.holder;
    if (holder === undefined || isLive(run.owner, host)) continue;
    if (host.processExists(holder.pid) && host.processStart(holder.pid) === holder.start && ops.executable(holder.pid) === holder.executable) {
      log.warn("Stopping Linux holder bwrap %d left running by an Ave that exited", holder.pid);
      ops.kill(holder.pid);
    }
    delete run.holder;
    changed = true;
  }
  return changed;
}

export interface MxcLinuxPlaceholderSweepOptions {
  /**
   * Boot only: set an unreadable journal aside and start empty. Another Ave on this account could still be using the
   * file, so this needs the host instance lock.
   */
  readonly recoverCorruptJournal?: { readonly ownsHostInstance: () => boolean };
  /** Boot only: stop holders whose Ave died (design 3 rule 4). */
  readonly stopOrphanHolders?: MxcLinuxOrphanHolderOps | true;
}

export async function sweepMxcLinuxPlaceholders(
  host: MxcRuntimeHost = currentMxcRuntimeHost(), options: MxcLinuxPlaceholderSweepOptions = {},
): Promise<void> {
  const journal = registryPath(host);
  await withFileLock(journal, async () => {
    let registry: PlaceholderRegistry;
    try {
      registry = readRegistry(journal);
    } catch (error) {
      const recover = options.recoverCorruptJournal;
      if (!(error instanceof ContainerPlaceholderJournalError) || recover === undefined) throw error;
      if (!recover.ownsHostInstance()) throw new Error("Container placeholder journal recovery needs the host instance lock", { cause: error });
      const aside = posix.join(posix.dirname(journal), `shell-placeholders.corrupt-${Date.now()}.json`);
      renameFileOnceSync(journal, aside);
      log.warn("Linux container placeholder journal was unreadable; set aside as %s", aside);
      recoveryNotice = t("sandboxPolicy.linuxPlaceholderJournalRecovered", { file: aside });
      return;
    }
    const orphans = options.stopOrphanHolders;
    const stopped = orphans !== undefined && stopOrphanHolders(registry, host, orphans === true ? PROC_ORPHAN_HOLDER_OPS : orphans);
    if (sweepDeadRuns(registry, host) || stopped) saveRegistry(journal, registry);
  }, { createTarget: false });
}

export interface MxcLinuxPlaceholderHold<Grants> {
  readonly grants: Grants;
  validate(): void;
  recordLauncher(pid: number): Promise<void>;
  /** A Linux holder's run entry, written even when it owns no placeholder: Ave's pid and its outer bwrap. */
  recordHolder(pid: number, executable: string): Promise<void>;
  /**
   * A long-lived holder, at its ready byte: give up the other runs' placeholders it held while its container was
   * mounted (design 7.3). Its mask of each stays; when their own run ends the folder goes, and the name is watched.
   */
  releaseForeignClaims(): Promise<void>;
  release(): Promise<void>;
}

/** Rank and acquire under the same lock so an overlapping launch cannot lose a mount source during preparation. */
export async function holdMxcLinuxPlaceholders<Grants extends PosixFilesystemGrants>(
  lookups: PosixPolicyLookups,
  rank: (lookups: PosixPolicyLookups) => Grants,
  host: MxcRuntimeHost = currentMxcRuntimeHost(),
): Promise<MxcLinuxPlaceholderHold<Grants>> {
  const journal = registryPath(host);
  const id = randomUUID();
  const lockOptions = { createTarget: false };
  return withFileLock(journal, async () => {
    const registry = readRegistry(journal);
    if (sweepDeadRuns(registry, host)) saveRegistry(journal, registry);
    const tracked = new Map(registry.directories.map((directory) => [directory.path, directory]));
    const ranked = rank({
      ...lookups,
      exists(path) {
        const directory = tracked.get(path);
        if (directory?.leaf && directory.identity !== undefined && isSameDirectory(path, directory.identity)) return false;
        return lookups.exists(path);
      },
    });
    // Another run's live placeholder under this launch's write roots is a protected name in that run's set, perhaps
    // not in this one's. Deny it here as well, so this container cannot remove it before the other mounts it.
    const foreignLeaves = registry.directories.filter((directory) => directory.leaf && directory.identity !== undefined
      && isSameDirectory(directory.path, directory.identity)
      && ranked.readwrite.some((root) => atOrUnder(directory.path, root, false))
      && !ranked.denied.includes(directory.path) && !ranked.readonly.includes(directory.path));
    const grants: Grants = foreignLeaves.length === 0 ? ranked
      : { ...ranked, denied: [...ranked.denied, ...foreignLeaves.map((directory) => directory.path)] };
    const owned = new Set<PlaceholderRegistry["directories"][number]>();
    const created = new Set<string>();
    const owner = { pid: host.pid, start: host.processStart(host.pid) };
    if (owner.start === null) throw new Error("Container placeholder owner could not be proved");
    registry.runs.push({ id, owner });

    const claim = (path: string, leaf: boolean): void => {
      const existing = tracked.get(path);
      if (existing !== undefined) {
        // A pending entry was never proved, so it is never another launch's mount source.
        if (existing.identity === undefined || !isSameDirectory(path, existing.identity)) throw new Error(`Container placeholder changed: ${path}`);
        if (owned.has(existing)) return;
        existing.owners.push(id);
        owned.add(existing);
        return;
      }
      const parent = directoryIdentity(posix.dirname(path));
      if (parent === undefined) throw new Error(`Container placeholder parent changed: ${path}`);
      // The intent is journalled before the folder exists, so a crash after mkdir leaves an entry the sweep can retire.
      const directory: PlaceholderRegistry["directories"][number] = {
        path, parent, leaf, owners: [id], pending: { notBefore: String(BigInt(Date.now() - PENDING_CLOCK_SLACK_MS) * 1_000_000n) },
      };
      registry.directories.push(directory);
      tracked.set(path, directory);
      owned.add(directory);
      created.add(path);
      saveRegistry(journal, registry);
      mkdirSync(path, { mode: 0o755 });
      const identity = directoryIdentity(path);
      if (identity === undefined) throw new Error(`Container placeholder could not be proved: ${path}`);
      directory.identity = identity;
      delete directory.pending;
      saveRegistry(journal, registry);
    };

    try {
      for (const placeholder of grants.placeholders ?? []) {
        const expected = { device: String(placeholder.device), inode: String(placeholder.inode) };
        if (!isSameDirectory(placeholder.ancestor, expected)) {
          throw new Error(`Container placeholder ancestor changed: ${placeholder.ancestor}`);
        }
        for (const parent of placeholder.parents) claim(parent, false);
        claim(placeholder.path, true);
      }
      // Every tracked folder a row equals or sits under is a mount source or lies above one: hold it for this run, so
      // the run that created it cannot remove it while this container uses it.
      const rows = [...grants.readwrite, ...grants.readonly, ...grants.denied, ...grants.pins ?? []];
      for (const directory of [...tracked.values()].toSorted((a, b) => a.path.length - b.path.length)) {
        if (owned.has(directory)) continue;
        if (rows.some((row) => atOrUnder(row, directory.path, false))) claim(directory.path, directory.leaf);
      }
      if (owned.size > 0) saveRegistry(journal, registry);
    } catch (error) {
      retireRun(registry, id);
      saveRegistry(journal, registry);
      throw error;
    }

    let holderRecorded = false;
    return {
      grants,
      validate() {
        for (const { path, identity, parent } of owned) {
          if (identity === undefined || !isSameDirectory(posix.dirname(path), parent) || !isSameDirectory(path, identity)) {
            throw new ContainerPlaceholderChangedError(path);
          }
        }
      },
      async recordLauncher(pid) {
        if (owned.size === 0) return;
        const launcher = { pid, start: host.processStart(pid) };
        await withFileLock(journal, async () => {
          const registry = readRegistry(journal);
          const run = registry.runs.find((run) => run.id === id);
          if (run === undefined) throw new Error("Container placeholder ownership was lost");
          run.launcher = launcher;
          saveRegistry(journal, registry);
        }, lockOptions);
      },
      async recordHolder(pid, executable) {
        const start = host.processStart(pid);
        if (start === null) throw new Error("Container holder marker could not be proved");
        await withFileLock(journal, async () => {
          const registry = readRegistry(journal);
          let run = registry.runs.find((run) => run.id === id);
          if (run === undefined) {
            // A run that owns no placeholder was never saved; the holder's marker needs its entry all the same.
            if (owned.size > 0) throw new Error("Container placeholder ownership was lost");
            run = { id, owner };
            registry.runs.push(run);
          }
          run.holder = { pid, start, executable };
          saveRegistry(journal, registry);
        }, lockOptions);
        holderRecorded = true;
      },
      async releaseForeignClaims() {
        const foreign = [...owned].filter((directory) => !created.has(directory.path));
        if (foreign.length === 0) return;
        await withFileLock(journal, async () => {
          const registry = readRegistry(journal);
          dropOwnership(registry, id, (path) => !created.has(path));
          registry.directories = registry.directories.filter((directory) => directory.owners.length > 0);
          saveRegistry(journal, registry);
        }, lockOptions);
        for (const directory of foreign) owned.delete(directory);
      },
      async release() {
        if (owned.size === 0 && !holderRecorded) return;
        await withFileLock(journal, async () => {
          const registry = readRegistry(journal);
          if (!registry.runs.some((run) => run.id === id)) return;
          retireRun(registry, id);
          saveRegistry(journal, registry);
        }, lockOptions);
      },
    };
  }, lockOptions);
}
