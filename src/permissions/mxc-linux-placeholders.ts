import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { isMissingPathError, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  currentMxcRuntimeHost, requireMxcContainerStartRoot, type MxcRuntimeHost,
} from "./mxc-runtime-root.js";
import type { PosixFilesystemGrants, PosixPolicyLookups } from "./mxc-posix.js";

const DirectoryIdentity = z.object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) });
const AbsolutePath = z.string().refine((path) => path !== "/" && posix.isAbsolute(path) && posix.normalize(path) === path);
const PidMarker = z.object({ pid: z.number().int().positive(), start: z.string().min(1).nullable() });
const PlaceholderRegistry = z.object({
  runs: z.array(z.object({ id: z.uuid(), owner: PidMarker, launcher: PidMarker.optional() })),
  directories: z.array(z.object({
    path: AbsolutePath, identity: DirectoryIdentity, parent: DirectoryIdentity,
    leaf: z.boolean(), owners: z.array(z.uuid()),
  })),
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

function readRegistry(path: string): PlaceholderRegistry {
  try {
    return PlaceholderRegistry.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (isMissingPathError(error)) return { runs: [], directories: [] };
    throw error;
  }
}

function saveRegistry(path: string, registry: PlaceholderRegistry): void {
  writeUtf8FileAtomicSync(path, JSON.stringify(registry));
}

/** Remove only empty directories of the recorded identity, in leaf-to-root order. */
function retireRun(registry: PlaceholderRegistry, id: string): void {
  registry.runs = registry.runs.filter((run) => run.id !== id);
  for (const directory of registry.directories.toSorted((a, b) => b.path.length - a.path.length)) {
    directory.owners = directory.owners.filter((owner) => owner !== id);
    if (directory.owners.length > 0) continue;
    try {
      if (isSameDirectory(posix.dirname(directory.path), directory.parent)
        && isSameDirectory(directory.path, directory.identity)) rmdirSync(directory.path);
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
    if (isLive(run.owner, host) || (run.launcher !== undefined && isLive(run.launcher, host))) continue;
    retireRun(registry, run.id);
    changed = true;
  }
  return changed;
}

function registryPath(host: MxcRuntimeHost): string {
  if (host.platform !== "linux") throw new Error("Container placeholders require Linux");
  return posix.join(requireMxcContainerStartRoot(host), "shell-placeholders.json");
}

export async function sweepMxcLinuxPlaceholders(host: MxcRuntimeHost = currentMxcRuntimeHost()): Promise<void> {
  const journal = registryPath(host);
  await withFileLock(journal, async () => {
    const registry = readRegistry(journal);
    if (sweepDeadRuns(registry, host)) saveRegistry(journal, registry);
  }, { createTarget: false });
}

export interface MxcLinuxPlaceholderHold<Grants> {
  readonly grants: Grants;
  validate(): void;
  recordLauncher(pid: number): Promise<void>;
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
    const grants = rank({
      ...lookups,
      exists(path) {
        const directory = tracked.get(path);
        if (directory?.leaf && isSameDirectory(path, directory.identity)) return false;
        return lookups.exists(path);
      },
    });
    const owned = new Set<PlaceholderRegistry["directories"][number]>();
    const owner = { pid: host.pid, start: host.processStart(host.pid) };
    if (owner.start === null) throw new Error("Container placeholder owner could not be proved");
    registry.runs.push({ id, owner });

    const claim = (path: string, leaf: boolean): void => {
      const existing = tracked.get(path);
      if (existing !== undefined) {
        if (!isSameDirectory(path, existing.identity)) throw new Error(`Container placeholder changed: ${path}`);
        if (owned.has(existing)) return;
        existing.owners.push(id);
        owned.add(existing);
        return;
      }
      const parent = directoryIdentity(posix.dirname(path));
      if (parent === undefined) throw new Error(`Container placeholder parent changed: ${path}`);
      saveRegistry(journal, registry);
      mkdirSync(path, { mode: 0o755 });
      const identity = directoryIdentity(path);
      if (identity === undefined) throw new Error(`Container placeholder could not be proved: ${path}`);
      const directory = { path, identity, parent, leaf, owners: [id] };
      registry.directories.push(directory);
      tracked.set(path, directory);
      owned.add(directory);
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
      for (const pin of grants.pins ?? []) {
        if (tracked.has(pin)) claim(pin, false);
      }
      if (owned.size > 0) saveRegistry(journal, registry);
    } catch (error) {
      retireRun(registry, id);
      saveRegistry(journal, registry);
      throw error;
    }

    return {
      grants,
      validate() {
        for (const { path, identity, parent } of owned) {
          if (!isSameDirectory(posix.dirname(path), parent) || !isSameDirectory(path, identity)) {
            throw new Error(`Container placeholder changed before start: ${path}`);
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
      async release() {
        if (owned.size === 0) return;
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
