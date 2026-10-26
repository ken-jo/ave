// Replacement recovery owns pendingUpdate until state is restored or committed; never delete unattributed state.
// Park losing state outside swept namespaces and log its path.
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isResolvedPathWithin } from "./plugin-storage-containment.js";
import {
  type PluginDataCarryPolicy,
  assertPayloadOnlyPluginTree,
  type PluginSocketCarryPolicy,
  carryPluginStateDirs,
  carryPluginSocketDirs,
  pluginPayloadCopyFilter,
} from "./plugin-storage-layout.js";
import { parkUnattributedPluginState, removePluginTreeNowOrAtBoot } from "./installed-entry-fs.js";

import { retryOnTransientFsLock } from "../lib/transient-fs-lock-retry.js";
import {
  installReceiptPath,
  restoreInstallReceiptRaw,
  verifyInstallReceipt,
  verifyInstallReceiptRaw,
} from "./plugin-install-receipt.js";
import type { PluginPaths } from "./plugin-paths.js";
import { readPluginRegistry, updatePluginRegistry } from "./registry.js";
import type { PluginRegistryEntry } from "./types.js";
import { canonicalJSON } from "./secret-access/canonical-json.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { UUID_SOURCE } from "../shared/uuid.js";
import { createLogger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isMissingPathError } from "../lib/atomic-file.js";

const log = createLogger("marketplace-update-recovery");

type PendingUpdate = NonNullable<PluginRegistryEntry["pendingUpdate"]>;
type PendingCleanup = NonNullable<PluginRegistryEntry["pendingCleanup"]>[number];

async function readNullable(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function ownedInstallDir(paths: PluginPaths, pluginId: string): string {
  return resolve(paths.pluginsRoot, assertSafeArtifactSlug(pluginId));
}

function ownedManifestPath(paths: PluginPaths, pluginId: string): string {
  return resolve(ownedInstallDir(paths, pluginId), "plugin.json");
}

/** Recovery must resolve every carry conflict; park unattributed state where no removal lifecycle can delete it. */
function recoveryDataCarry(paths: PluginPaths, pluginId: string): PluginDataCarryPolicy {
  return {
    onConflict: "resolve",
    unattributedRoot: ownedInstallDir(paths, pluginId),
    moveAside: async (conflictingDataDir) => {
      const parked = await parkUnattributedPluginState(conflictingDataDir, paths.pluginsRoot);
      // Log the parked path: no registry row or sweeper otherwise makes retained bytes discoverable.
      log.warn(
        { pluginId, source: conflictingDataDir, parked },
        "plugin data directory could not be attributed to the transaction; parked for operator review",
      );
    },
  };
}

/** Keep destination conflict entries while preserving the original directory identity. */
const RECOVERY_SOCKET_CARRY: PluginSocketCarryPolicy = {
  onConflict: "keep-destination",
  onDiscardEntry: (path, reason) =>
    log.warn({ path, reason }, "removed a plugin socket entry recovery cannot carry"),
};

/** Carry remaining state before removing a root; absence is a no-op, never a reason to lose the only copy. */
async function discardOwnedPluginRoot(
  paths: PluginPaths,
  pluginId: string,
  rootDir: string,
): Promise<void> {
  await retryOnTransientFsLock(
    () => carryPluginStateDirs(rootDir, ownedInstallDir(paths, pluginId), recoveryDataCarry(paths, pluginId)),
  );
  // Carry sockets too: a local swap may have parked live runtime directories in its backup.
  await carryPluginSocketDirs(rootDir, ownedInstallDir(paths, pluginId), RECOVERY_SOCKET_CARRY);
  // Runtime rollback may still have bound children; deletion waits for boot.
  await removePluginTreeNowOrAtBoot(rootDir, paths.pluginsRoot, removeRecoveredTreeNow);
}

async function removeRecoveredTreeNow(path: string): Promise<void> {
  await retryOnTransientFsLock(() => rm(path, { recursive: true, force: true }));
}

function assertOwnedBackupPath(
  paths: PluginPaths,
  pluginId: string,
  backupDir: string | undefined,
  mode: "rename" | "copy" | undefined,
): string {
  const safePluginId = assertSafeArtifactSlug(pluginId);
  if (!backupDir || !mode || !isResolvedPathWithin(paths.pluginsRoot, backupDir)) {
    throw new Error(`Invalid recovery backup metadata for plugin: ${pluginId}`);
  }
  const name = basename(backupDir);
  const resolvedBackupDir = resolve(backupDir);
  const localBackupRoot = resolve(paths.pluginsRoot, ".cache", "local-install-rollback");
  const escapedPluginId = escapeRegExp(safePluginId);
  const marketplaceName = new RegExp(
    `^\\.${escapedPluginId}\\.old-${UUID_SOURCE}$`,
    "i",
  );
  const localName = new RegExp(`^${escapedPluginId}-[0-9]+-[0-9]+$`);
  const validName = mode === "rename"
    ? dirname(resolvedBackupDir) === resolve(paths.pluginsRoot)
      && marketplaceName.test(name)
    : dirname(resolvedBackupDir) === localBackupRoot
      && localName.test(name);
  if (!validName) throw new Error(`Unsafe recovery backup path for plugin: ${pluginId}`);
  return resolvedBackupDir;
}

function assertRecoveryBackupPath(paths: PluginPaths, pluginId: string, pending: PendingUpdate): string {
  return assertOwnedBackupPath(
    paths,
    pluginId,
    pending.recoveryBackupDir,
    pending.recoveryBackupMode,
  );
}

function cleanupRecordForBackup(pending: Pick<PendingUpdate, "recoveryBackupDir" | "recoveryBackupMode">): PendingCleanup | null {
  if (!pending.recoveryBackupDir || !pending.recoveryBackupMode) return null;
  return {
    kind: pending.recoveryBackupMode === "rename" ? "obsolete-artifact" : "obsolete-local-backup",
    path: resolve(pending.recoveryBackupDir),
  };
}

function appendPendingCleanup(entry: PluginRegistryEntry, cleanup: PendingCleanup | null): void {
  if (!cleanup) return;
  const existing = entry.pendingCleanup ?? [];
  if (existing.some((item) => resolve(item.path) === cleanup.path)) return;
  entry.pendingCleanup = [...existing.map((item) => ({ ...item })), cleanup];
}

export function pendingOwnedBackupPaths(paths: PluginPaths, entry: PluginRegistryEntry): string[] {
  const owned = new Set<string>();
  if (entry.pendingUpdate?.recoveryBackupDir) {
    owned.add(assertRecoveryBackupPath(paths, entry.id, entry.pendingUpdate));
  }
  for (const cleanup of entry.pendingCleanup ?? []) {
    owned.add(assertPendingCleanupPath(paths, entry.id, cleanup));
  }
  return [...owned];
}

async function payloadMatchesPrevious(
  entry: PluginRegistryEntry,
  pluginRoot: string,
): Promise<boolean> {
  const pending = entry.pendingUpdate;
  if (!pending || pending.previousReceiptRaw === null) return false;
  const rawManifest = await readNullable(resolve(pluginRoot, "plugin.json"));
  const manifestHash = rawManifest === null ? null : sha256Hex(rawManifest);
  if (manifestHash !== pending.previousManifestFileSha256) return false;
  return (await verifyInstallReceiptRaw(pending.previousReceiptRaw, entry.id, pluginRoot)).ok;
}

async function liveMatchesPrevious(paths: PluginPaths, entry: PluginRegistryEntry): Promise<boolean> {
  const pending = entry.pendingUpdate;
  if (!pending || !await payloadMatchesPrevious(entry, ownedInstallDir(paths, entry.id))) return false;
  const receiptRaw = await readNullable(installReceiptPath(paths.cacheRoot, entry.id));
  if (receiptRaw !== pending.previousReceiptRaw) return false;
  return (await verifyInstallReceipt(paths.cacheRoot, entry.id, ownedInstallDir(paths, entry.id))).ok;
}

async function clearPendingUpdate(paths: PluginPaths, pluginId: string, expected: PendingUpdate): Promise<void> {
  await updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!entry?.pendingUpdate || JSON.stringify(entry.pendingUpdate) !== JSON.stringify(expected)) {
      throw new Error(`Pending plugin update changed during recovery: ${pluginId}`);
    }
    entry.pendingUpdate = undefined;
  });
}

export async function preparePendingPluginUpdate(
  paths: PluginPaths,
  expectedEntry: PluginRegistryEntry,
  options: {
    kind: PendingUpdate["kind"];
    recoveryBackupDir?: string;
    recoveryBackupMode?: NonNullable<PendingUpdate["recoveryBackupMode"]>;
  },
): Promise<PluginRegistryEntry> {
  assertSafeArtifactSlug(expectedEntry.id);
  const pendingUpdate = expectedEntry.pendingUpdate
    ? null
    : await (async (): Promise<PendingUpdate> => {
        const rawManifest = await readNullable(ownedManifestPath(paths, expectedEntry.id));
        const receiptRaw = await readNullable(installReceiptPath(paths.cacheRoot, expectedEntry.id));
        return {
          kind: options.kind,
          previousManifestFileSha256: rawManifest === null ? null : sha256Hex(rawManifest),
          previousReceiptRaw: receiptRaw,
          ...(options.recoveryBackupDir && options.recoveryBackupMode
            ? {
                recoveryBackupDir: resolve(options.recoveryBackupDir),
                recoveryBackupMode: options.recoveryBackupMode,
              }
            : {}),
        };
      })();
  return updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === expectedEntry.id);
    if (!entry) throw new Error(`Plugin registry entry disappeared before update: ${expectedEntry.id}`);
    if (canonicalJSON(entry) !== canonicalJSON(expectedEntry)) {
      throw new Error(`Plugin registry entry changed before update: ${expectedEntry.id}`);
    }
    if (entry.pendingUpdate) {
      // Preserve the original predecessor; journal retry backups as cleanup-only before promotion.
      appendPendingCleanup(entry, cleanupRecordForBackup({
        recoveryBackupDir: options.recoveryBackupDir,
        recoveryBackupMode: options.recoveryBackupMode,
      }));
    } else {
      entry.pendingUpdate = pendingUpdate!;
    }
    return {
      ...entry,
      bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined,
      pendingUpdate: entry.pendingUpdate ? { ...entry.pendingUpdate } : undefined,
      pendingCleanup: entry.pendingCleanup?.map((item) => ({ ...item })),
    };
  });
}

export async function recoverPendingPluginUpdate(
  paths: PluginPaths,
  pluginId: string,
): Promise<"recovered" | "unresolved" | "absent"> {
  assertSafeArtifactSlug(pluginId);
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const pending = entry?.pendingUpdate;
  if (!entry || !pending) return "absent";

  const installDir = ownedInstallDir(paths, pluginId);
  if (await payloadMatchesPrevious(entry, installDir)) {
    if (pending.previousReceiptRaw === null) return "unresolved";
    if (await readNullable(installReceiptPath(paths.cacheRoot, pluginId)) !== pending.previousReceiptRaw) {
      await restoreInstallReceiptRaw(paths.cacheRoot, pluginId, pending.previousReceiptRaw);
    }
    if (!await liveMatchesPrevious(paths, entry)) return "unresolved";
    if (pending.recoveryBackupDir) {
      const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
      // If promotion never happened, restore state carried into the backup to the surviving live root.
      await discardOwnedPluginRoot(paths, pluginId, backupDir);
    }
    await clearPendingUpdate(paths, pluginId, pending);
    return "recovered";
  }

  if (!pending.recoveryBackupDir) return "unresolved";
  const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
  if (!await payloadMatchesPrevious(entry, backupDir)) {
    return "unresolved";
  }

  // Move state out of a discarded promoted root before restoring its backup.
  await retryOnTransientFsLock(() => carryPluginStateDirs(installDir, backupDir, recoveryDataCarry(paths, pluginId)));
  // Finish interrupted forward merges before reversing so the original inode survives.
  await carryPluginSocketDirs(backupDir, installDir, RECOVERY_SOCKET_CARRY);
  // Runtime restore must preserve directories still bound to the predecessor.
  await carryPluginSocketDirs(installDir, backupDir, RECOVERY_SOCKET_CARRY);
  await removePluginTreeNowOrAtBoot(installDir, paths.pluginsRoot, removeRecoveredTreeNow);
  if (pending.recoveryBackupMode === "rename") {
    await retryOnTransientFsLock(() => rename(backupDir, installDir));
  } else {
    const restoreStage = `${installDir}.recovery-${process.pid}-${Date.now()}`;
    await assertPayloadOnlyPluginTree(restoreStage);
    await rm(restoreStage, { recursive: true, force: true });
    await mkdir(dirname(restoreStage), { recursive: true });
    try {
      await cp(backupDir, restoreStage, {
        recursive: true,
        verbatimSymlinks: true,
        filter: pluginPayloadCopyFilter(backupDir),
      });
      await retryOnTransientFsLock(() => rename(restoreStage, installDir));
    } catch (error) {
      await assertPayloadOnlyPluginTree(restoreStage)
        .then(() => rm(restoreStage, { recursive: true, force: true }))
        .catch(() => undefined);
      throw error;
    }
    await retryOnTransientFsLock(() => carryPluginStateDirs(backupDir, installDir, recoveryDataCarry(paths, pluginId)));
    await carryPluginSocketDirs(backupDir, installDir, RECOVERY_SOCKET_CARRY);
  }
  if (pending.previousReceiptRaw === null) return "unresolved";
  await restoreInstallReceiptRaw(paths.cacheRoot, pluginId, pending.previousReceiptRaw);
  if (!await liveMatchesPrevious(paths, entry)) return "unresolved";
  if (pending.recoveryBackupMode === "copy") {
    await discardOwnedPluginRoot(paths, pluginId, backupDir);
  }
  await clearPendingUpdate(paths, pluginId, pending);
  return "recovered";
}

export async function restoreSupersededPendingPluginUpdate(
  paths: PluginPaths,
  expectedCurrent: PluginRegistryEntry,
  previousEntry: PluginRegistryEntry,
  options: { preserveRetryCleanup?: boolean } = {},
): Promise<void> {
  if (!expectedCurrent.pendingUpdate || !previousEntry.pendingUpdate || previousEntry.id !== expectedCurrent.id) {
    throw new Error(`Invalid superseded pending update restore: ${previousEntry.id}`);
  }
  assertSafeArtifactSlug(previousEntry.id);
  await updatePluginRegistry(paths.registryPath, (registry) => {
    const current = registry.plugins.find((candidate) => candidate.id === previousEntry.id);
    if (!current?.pendingUpdate
      || canonicalJSON(current.pendingUpdate) !== canonicalJSON(expectedCurrent.pendingUpdate)) {
      throw new Error(`Pending plugin update changed during reinstall rollback: ${previousEntry.id}`);
    }
    current.pendingUpdate = { ...previousEntry.pendingUpdate! };
    if (!options.preserveRetryCleanup) {
      current.pendingCleanup = previousEntry.pendingCleanup?.map((item) => ({ ...item }));
    }
  });
}

function assertPendingCleanupPath(paths: PluginPaths, pluginId: string, pending: PendingCleanup): string {
  return assertOwnedBackupPath(
    paths,
    pluginId,
    pending.path,
    pending.kind === "obsolete-artifact" ? "rename" : "copy",
  );
}

async function cleanupObsoletePluginBackup(paths: PluginPaths, pluginId: string): Promise<boolean> {
  assertSafeArtifactSlug(pluginId);
  let cleaned = false;
  while (true) {
    const registry = await readPluginRegistry(paths.registryPath);
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    const expected = entry?.pendingCleanup?.[0];
    if (!entry || !expected) return cleaned;
    const expectedPath = assertPendingCleanupPath(paths, pluginId, expected);
    await discardOwnedPluginRoot(paths, pluginId, expectedPath);
    await clearObsoletePluginBackupOwnership(paths, pluginId, expectedPath);
    cleaned = true;
  }
}

export async function cleanupObsoletePluginBackupPath(
  paths: PluginPaths,
  pluginId: string,
  obsoleteDir: string,
): Promise<boolean> {
  assertSafeArtifactSlug(pluginId);
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const target = entry?.pendingCleanup?.find((item) => resolve(item.path) === resolve(obsoleteDir));
  if (!target) return false;
  const targetPath = assertPendingCleanupPath(paths, pluginId, target);
  await discardOwnedPluginRoot(paths, pluginId, targetPath);
  await clearObsoletePluginBackupOwnership(paths, pluginId, targetPath);
  return true;
}

export async function clearObsoletePluginBackupOwnership(
  paths: PluginPaths,
  pluginId: string,
  obsoleteDir: string,
): Promise<void> {
  assertSafeArtifactSlug(pluginId);
  await updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!entry?.pendingCleanup) return;
    const remaining = entry.pendingCleanup.filter((item) => resolve(item.path) !== resolve(obsoleteDir));
    entry.pendingCleanup = remaining.length > 0 ? remaining : undefined;
  });
}

export async function recoverPendingPluginUpdates(paths: PluginPaths): Promise<{
  recovered: string[];
  unresolved: string[];
}> {
  const registry = await readPluginRegistry(paths.registryPath);
  const ids = registry.plugins
    .filter((entry) => entry.pendingUpdate || (entry.pendingCleanup?.length ?? 0) > 0)
    .map((entry) => entry.id);
  const result = { recovered: [] as string[], unresolved: [] as string[] };
  for (const id of ids) {
    try {
      const outcome = await recoverPendingPluginUpdate(paths, id);
      const cleaned = await cleanupObsoletePluginBackup(paths, id);
      if (outcome === "unresolved") result.unresolved.push(id);
      else if (outcome === "recovered" || cleaned) result.recovered.push(id);
    } catch {
      result.unresolved.push(id);
    }
  }
  return result;
}

export async function cleanupPendingPluginUpdateBackup(paths: PluginPaths, pluginId: string): Promise<boolean> {
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const pending = entry?.pendingUpdate;
  if (!pending?.recoveryBackupDir) return false;
  const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
  // Explicit backup cleanup must carry its data first; it may hold the only copy.
  await discardOwnedPluginRoot(paths, pluginId, backupDir);
  await updatePluginRegistry(paths.registryPath, (fresh) => {
    const current = fresh.plugins.find((candidate) => candidate.id === pluginId);
    if (!current?.pendingUpdate) return;
    current.pendingUpdate = {
      kind: current.pendingUpdate.kind,
      previousManifestFileSha256: current.pendingUpdate.previousManifestFileSha256,
      previousReceiptRaw: current.pendingUpdate.previousReceiptRaw,
    };
  });
  return true;
}
