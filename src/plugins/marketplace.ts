import { cp, mkdir, readFile, rename, rm, stat as statAsync } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { buildSideloadCopyFilter, rejectSideloadSymlinks } from "./sideload-filter.js";
import { readPluginRegistry, updatePluginRegistry } from "./registry.js";
import type { PluginDeploymentGuard } from "./deployment-guard.js";
import type { CommittedPluginGeneration } from "./plugin-host-generation.js";
import {
  isCommittedPluginGenerationPublicationError,
} from "./committed-generation-publication-error.js";
import { toRegistryRelativeManifestPath, type PluginPaths } from "./plugin-paths.js";
import { isDevModeUnlocked } from "../boot/dev-flags.js";
import type { DependencySpec, PluginAccessSpec, PluginManifest, PluginRegistryEntryInstallSource, PluginRegistryEntryOrigin, PluginRegistryTrust } from "./types.js";
import { MissingDependenciesError, MissingPluginDependenciesError } from "./types.js";
import { resolveDependencies } from "./dependency-resolver.js";
import {
  ArtifactRollbackError,
  PluginArtifactStore,
  retryOnTransientFsLock,
} from "./plugin-artifact-store.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import {
  cleanupObsoletePluginBackupPath,
  clearObsoletePluginBackupOwnership,
  pendingOwnedBackupPaths,
  preparePendingPluginUpdate,
  recoverPendingPluginUpdate,
  restoreSupersededPendingPluginUpdate,
} from "./marketplace-update-recovery.js";
import {
  PLUGIN_RUNTIME_DIR_NAMES,
  carryPluginDataDir,
  carryPluginSocketDirs,
  pluginPayloadCopyFilter,
} from "./plugin-storage-layout.js";
import {
  buildFolderInstallReceipt,
  buildGitInstallReceipt,
  FOLDER_RUNG,
  installReceiptPath,
  listFilesRecursive,
  restoreInstallReceiptRaw,
  verifyInstallReceiptRaw,
} from "./plugin-install-receipt.js";
import { assertGitInstallManifest, expectedPluginOf, manifestAuthority } from "../marketplace/resolve/manifest-rules.js";
import { classifyInstall, type InstallAction } from "../marketplace/resolve/identity.js";
import { MarketplaceError } from "../marketplace/errors.js";
import { IncompatibleHostProtocolError } from "./isolation/host-api-wire.js";
import { pluginConsent, unknownConsent, type ConsentFingerprint } from "../marketplace/updates/consent.js";
import { readPayloadFiles, type PayloadFile } from "./contribution-approval-digest.js";
import type { PluginAuthority } from "../marketplace/catalog/types.js";
import type { PluginInstallPlan, StagedPluginArtifact } from "../marketplace/resolve/plugin-ladder.js";
import { canonicalJSON } from "./secret-access/canonical-json.js";
import {
  abortRemovalTransaction,
  assertCanonicalRegistryOwnership,
  createRemovalTransaction,
  finishRemovalTransaction,
  markRemovalTransactionRegistryCommitted,
  stageRemovalTransaction,
  type RemovalTransactionKind,
} from "./plugin-removal-transaction.js";
import type { PluginInstallReceipt } from "./plugin-install-receipt.js";
import { flattenAgentPluginsManifest } from "./public-contract.js";
import {
  assertProcessEntryAdmitted,
  hasProcessEntry,
  processEntryProvenance,
  ProcessEntryRequiresPinnedArtifactError,
} from "./process-entry.js";
import type { PluginRegistryEntry } from "./types.js";
import { createLogger } from "../lib/logger.js";
import { materializePluginContributions } from "./plugin-contributions.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isMissingPathError } from "../lib/atomic-file.js";
const log = createLogger("marketplace");

interface PreparedMarketplacePluginArtifact {
  readonly installId: string;
  readonly pluginRoot: string;
  readonly manifest: PluginManifest;
  readonly receiptRaw: string;
  readonly registryEntry: Readonly<
    PluginRegistryTrust
  >;
  readonly approvedPluginAccess?: PluginAccessSpec;
  durableCommit(): Promise<string>;
}

export type PreparedMarketplacePluginActivation = (
  prepared: PreparedMarketplacePluginArtifact,
) => Promise<CommittedPluginGeneration<string>>;

function requirePreparedMarketplacePluginActivation(
  activation: PreparedMarketplacePluginActivation | undefined,
  operation: string,
): PreparedMarketplacePluginActivation {
  if (typeof activation !== "function") {
    throw new Error(
      `[plugin-generation] ${operation} requires coordinated generation activation`,
    );
  }
  return activation;
}

function shaOfManifest(manifest: unknown): string {
  return sha256Hex(canonicalJSON(manifest));
}

function normalizeDependencies(
  plugin: { dependencies?: Array<string | DependencySpec> },
): Array<{ pluginId: string; versionRange?: string; required: boolean }> {
  const result: Array<{ pluginId: string; versionRange?: string; required: boolean }> = [];
  for (const dependency of plugin.dependencies ?? []) {
    if (typeof dependency === "string") {
      result.push({ pluginId: dependency, required: true });
      continue;
    }
    if (!dependency?.pluginId) continue;
    result.push({
      pluginId: dependency.pluginId,
      versionRange: dependency.versionRange,
      required: dependency.required ?? true,
    });
  }
  return result;
}

type LocalInstallRollbackSnapshot = {
  kind: "filesystem-snapshot" | "pending-predecessor";
  installDir: string;
  backupDir?: string;
  receiptRaw?: string;
  registryEntry: PluginRegistryEntry;
};

/**
 * The directory a sideload replacement moves the plugin's data directory
 * through while the live root is removed and the candidate promoted: the
 * recovery backup boot recovery is told about. It is the only place a crash
 * mid-swap can leave the state where `recoverPendingPluginUpdate` will look
 * for it. A first install has no such backup and no predecessor state to
 * protect; the candidate itself receives whatever the vacated root held.
 */
function localInstallDataCarrier(snapshot: LocalInstallRollbackSnapshot | null): string | undefined {
  if (!snapshot) return undefined;
  return snapshot.kind === "filesystem-snapshot"
    ? snapshot.backupDir
    : snapshot.registryEntry.pendingUpdate?.recoveryBackupDir;
}

type InstallReceiptValidation = {
  ok: boolean;
  reason?: string;
  receipt?: PluginInstallReceipt;
};

/**
 * Where a git or folder install came from, as its registry entry records it
 * (design §10.3 reads it). A folder install's commit is its revision and its
 * rung `folder` (§18.4.2, §18.4.3).
 */
function gitInstallOrigin(staged: StagedPluginArtifact): PluginRegistryEntryOrigin {
  const { plan } = staged;
  if (staged.rung === FOLDER_RUNG && plan.snapshotCommit !== plan.versionCommit) {
    throw new Error(`plugin ${plan.name}: a folder plan reads one revision, not ${plan.snapshotCommit} and ${plan.versionCommit}`);
  }
  return {
    sourceId: plan.sourceId,
    sourceOrigin: plan.sourceOrigin,
    commit: plan.snapshotCommit,
    packagePath: plan.packagePath,
    version: plan.version,
    rung: staged.rung,
    artifactSha256: staged.artifactSha256,
    installedAt: new Date().toISOString(),
  };
}

function cleanupJournalAfterCommit(entry: PluginRegistryEntry): PluginRegistryEntry["pendingCleanup"] {
  const journal = (entry.pendingCleanup ?? []).map((item) => ({ ...item, path: resolve(item.path) }));
  const pending = entry.pendingUpdate;
  if (pending?.recoveryBackupDir && pending.recoveryBackupMode) {
    const item = {
      kind: pending.recoveryBackupMode === "rename"
        ? "obsolete-artifact" as const
        : "obsolete-local-backup" as const,
      path: resolve(pending.recoveryBackupDir),
    };
    if (!journal.some((candidate) => candidate.path === item.path)) journal.push(item);
  }
  return journal.length > 0 ? journal : undefined;
}

/**
 * A process entry's admission trusts the rung and digest its receipt records
 * (§9.7 P4), so the transaction binds them to the plan before writing one: a
 * release or archive rung must carry exactly the sha256 the catalog pinned for
 * it. The ladder already proved the bytes against that pin; this keeps the
 * receipt from recording a digest the plan never pinned, whatever staged it.
 */
function assertStagedArtifactPinned(staged: StagedPluginArtifact): void {
  const { plan, rung } = staged;
  // A folder install never qualifies (§18.4.9); the folder rung refused it already.
  if (rung === FOLDER_RUNG) throw new ProcessEntryRequiresPinnedArtifactError();
  if (rung !== "release" && rung !== "archive") return;
  const pin = plan.artifact[rung]?.sha256?.toLowerCase();
  if (pin !== staged.artifactSha256) {
    throw new MarketplaceError(
      "ARTIFACT_DIGEST_MISMATCH",
      `plugin ${plan.name}@${plan.version}: the staged ${rung} hashes to ${staged.artifactSha256}, the catalog pins ${pin ?? "nothing"}`,
    );
  }
}

export class PluginMarketplaceService {
  private readonly paths: PluginPaths;
  private readonly registryPath: string;
  private readonly pluginsRoot: string;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  /** §9.6: per-plugin version cache for rollback. */
  private readonly cacheRoot: string;
  /**
   * §FU#267 — artifact-management subsystem. Owns atomic extract, the
   * history journal and the version snapshot cache. The orchestrator (this
   * class) coordinates registry writes around it.
   */
  private readonly artifactStore: PluginArtifactStore;
  private readonly installReceiptValidationCache = new Map<string, InstallReceiptValidation>();
  private readonly deferredLifecycleCleanups = new Set<Promise<void>>();
  /**
   * Per-plugin in-process mutex. Concurrent install/uninstall calls for the
   * same pluginId are serialized to protect the cache breadcrumb +
   * history.json from corruption.
   */
  private readonly locks = new Map<string, Promise<void>>();
  /** Optional diagnostic logger. Injected in tests; no-op in production. */
  readonly log?: (message: string, ...args: unknown[]) => void;

  /**
   * `paths` is the single source of truth for the registry / installed-dir /
   * cache layout.
   */
  constructor(paths: PluginPaths, deploymentGuard?: PluginDeploymentGuard) {
    this.paths = paths;
    this.registryPath = paths.registryPath;
    this.pluginsRoot = paths.pluginsRoot;
    this.cacheRoot = paths.cacheRoot;
    this.deploymentGuard = deploymentGuard;
    // Artifact store owns the same `pluginsRoot` (extract target) +
    // `cacheRoot` (history + version snapshots).
    this.artifactStore = new PluginArtifactStore({
      installRoot: paths.pluginsRoot,
      cacheRoot: paths.cacheRoot,
    });
  }

  async uninstall(
    pluginId: string,
    options?: { removeBundleMembers?: boolean },
  ): Promise<{ pluginId: string; uninstalled: true }> {
    // A plugin the machine policy requires cannot be uninstalled (design §10.2).
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canUninstall(pluginId);
      if (!guardResult.allowed) {
        throw new Error(guardResult.reason ?? `Plugin uninstall denied: ${pluginId}`);
      }
    }

    const buildPlan = (entries: PluginRegistryEntry[]) => {
      const target = entries.find((entry) => entry.id === pluginId);
      if (!target) throw new Error(`Plugin not installed: ${pluginId}`);
      const idsToRemove = new Set<string>([pluginId]);
      const nextBundleRefs = new Map<string, string[]>();
      for (const entry of entries) {
        if (entry.id === pluginId) continue;
        const withoutRoot = (entry.bundleRefs ?? []).filter((bundleId) => bundleId !== pluginId);
        if (withoutRoot.length === (entry.bundleRefs ?? []).length) continue;
        if (options?.removeBundleMembers && withoutRoot.length === 0) {
          idsToRemove.add(entry.id);
        } else {
          nextBundleRefs.set(entry.id, withoutRoot);
        }
      }
      const removed = entries
        .filter((entry) => idsToRemove.has(entry.id))
        .map((entry) => this.cloneRegistryEntry(entry));
      const affected = entries
        .filter((entry) => idsToRemove.has(entry.id) || nextBundleRefs.has(entry.id))
        .map((entry) => this.cloneRegistryEntry(entry))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const signature = canonicalJSON({
        affected,
        nextBundleRefs: [...nextBundleRefs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      });
      return { idsToRemove, nextBundleRefs, removed, affected, signature };
    };

    const snapshot = await readPluginRegistry(this.registryPath);
    const planned = buildPlan(snapshot.plugins);
    return this.withPluginLocks([...planned.idsToRemove], async () => {
      const lockedSnapshot = await readPluginRegistry(this.registryPath);
      const lockedPlan = buildPlan(lockedSnapshot.plugins);
      if (lockedPlan.signature !== planned.signature) {
        throw new Error(`Plugin registry changed before uninstall locks were acquired: ${pluginId}`);
      }
      const affectedIds = new Set(lockedPlan.affected.map((entry) => entry.id));
      const registryAfter = lockedSnapshot.plugins.map((entry) => this.cloneRegistryEntry(entry));
      for (const [id, refs] of lockedPlan.nextBundleRefs) {
        const entry = registryAfter.find((candidate) => candidate.id === id);
        if (entry) entry.bundleRefs = refs;
      }
      const projectedAfter = registryAfter.filter((entry) => affectedIds.has(entry.id) && !lockedPlan.idsToRemove.has(entry.id));
      const originals = lockedPlan.removed.flatMap((entry) =>
        this.ownedDirectoriesForEntry(entry).map((path) => ({ pluginId: entry.id, path })),
      );
      await this.executeRemovalTransaction(
        "uninstall",
        lockedPlan.affected,
        projectedAfter,
        originals,
        async () => updatePluginRegistry(this.registryPath, (registry) => {
          const fresh = buildPlan(registry.plugins);
          if (fresh.signature !== lockedPlan.signature) {
            throw new Error(`Plugin registry changed during uninstall: ${pluginId}`);
          }
          for (const [id, refs] of fresh.nextBundleRefs) {
            const entry = registry.plugins.find((candidate) => candidate.id === id);
            if (entry) entry.bundleRefs = refs;
          }
          registry.plugins = registry.plugins.filter((entry) => !fresh.idsToRemove.has(entry.id));
        }),
      );
      return { pluginId, uninstalled: true as const };
    });
  }

  /**
   * Per-plugin serialization. Concurrent callers for the same
   * pluginId queue behind each other; callers for different plugins run
   * concurrently. We keep the map entry only while the promise is pending.
   */
  private async withPluginLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(pluginId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    // `prev.then(() => next)` produces a NEW Promise object each call, so a
    // set + identity-compare against re-evaluated `prev.then(() => next)`
    // would never match and `this.locks` would leak one stale entry per
    // install. Hoist to a local so the same reference is stored + compared.
    const tail = prev.then(() => next);
    this.locks.set(pluginId, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(pluginId) === tail) {
        this.locks.delete(pluginId);
      }
    }
  }

  /** Acquire all affected per-plugin operation locks in stable order. */
  private async withPluginLocks<T>(pluginIds: Iterable<string>, fn: () => Promise<T>): Promise<T> {
    const ids = [...new Set(pluginIds)].sort();
    const acquire = (index: number): Promise<T> => {
      if (index >= ids.length) return fn();
      return this.withPluginLock(ids[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  }

  /**
   * Snapshot the currently-installed manifest into the artifact store's
   * version cache before overwrite. No-op when the plugin is not yet
   * installed. Wraps {@link PluginArtifactStore.cacheVersionFromManifest}
   * with the registry-aware path resolution that the store deliberately
   * does not own.
   */
  private async snapshotCurrentInstall(pluginId: string): Promise<void> {
    // Do NOT swallow registry read errors here. `readPluginRegistry`
    // already returns the empty default on ENOENT (first-boot); any other
    // error (corrupt JSON, IO failure) must propagate so we don't silently
    // skip the rollback snapshot and then overwrite the install with an
    // unrecoverable previous state.
    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((p) => p.id === pluginId);
    if (!entry || entry.pendingUpdate) return;
    const manifestAbs = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    await this.artifactStore.cacheVersionFromManifest(pluginId, manifestAbs, entry);
    await this.appendHistoryFromManifestVersion(pluginId, manifestAbs);
  }

  private async appendHistoryFromManifestVersion(pluginId: string, manifestPath: string): Promise<void> {
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = flattenAgentPluginsManifest(JSON.parse(raw));
      if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) return;
      await this.artifactStore.appendHistory(pluginId, {
        version: parsed.version,
        installedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.warn(`appendHistoryFromManifestVersion failed for ${pluginId}: ${(err as Error).message}`);
    }
  }

  private async readManifestSha256(manifestPath: string): Promise<string> {
    const raw = await readFile(manifestPath, "utf-8");
    return shaOfManifest(JSON.parse(raw));
  }

  /** Raw durable row lookup for replacement planning, including stale manifests. */
  private async getRawRegistryEntry(pluginId: string): Promise<PluginRegistryEntry | null> {
    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    return entry ? this.cloneRegistryEntry(entry) : null;
  }

  /** Returns the version string from the currently-installed manifest, or null. */
  async getInstalledVersion(pluginId: string): Promise<string | null> {
    // Registry read errors propagate; only the manifest-missing
    // path returns null (stale registry entry).
    const registry = await readPluginRegistry(this.registryPath);
    return this.readInstalledVersionFromRegistry(registry, pluginId);
  }

  /**
   * Installed version for a plugin, resolved from an already-loaded registry.
   * The single seam the managed-bootstrap loop uses so it does NOT re-read +
   * parse the whole registry file per plugin (it reuses the registry snapshot
   * it already holds). Manifest-missing (ENOENT) → null; other IO/parse errors
   * propagate to the caller, which isolates them per plugin.
   */
  private async readInstalledVersionFromRegistry(
    registry: { plugins: PluginRegistryEntry[] },
    pluginId: string,
  ): Promise<string | null> {
    const entry = registry.plugins.find((c) => c.id === pluginId);
    return entry && !entry.pendingUpdate ? this.readInstalledManifestVersion(entry) : null;
  }

  /**
   * Read the installed version from a registry entry's manifest. Split out of
   * {@link getInstalledVersion} so callers that already hold the registry (e.g.
   * the managed-bootstrap loop) don't re-read+parse the whole registry file per
   * plugin. Manifest-missing (ENOENT) → null; other IO/parse errors propagate.
   */
  private async readInstalledManifestVersion(entry: PluginRegistryEntry): Promise<string | null> {
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (err) {
      if (isMissingPathError(err)) return null;
      throw err;
    }
    const parsed = flattenAgentPluginsManifest(JSON.parse(raw));
    return typeof parsed.version === "string" ? parsed.version : null;
  }

  /**
   * Every installed plugin with the git origin it is bound to, for the git
   * marketplace's installed view (design §15.2). Rows mid-replacement are
   * left out; a missing manifest gives a null version.
   */
  async listInstalledPackages(): Promise<Array<{ name: string; version: string | null; sourceId: string | null; originCommit: string | null; digest: string | null }>> {
    const registry = await readPluginRegistry(this.registryPath);
    const rows = [];
    for (const entry of registry.plugins) {
      if (entry.pendingUpdate) continue;
      rows.push({
        name: entry.id,
        version: entry.origin?.version ?? (await this.readInstalledManifestVersion(entry)),
        sourceId: entry.origin?.sourceId ?? null,
        originCommit: entry.origin?.commit ?? null,
        // A folder package's refresh compares its tree digest with this (§18.7.6).
        digest: entry.origin?.artifactSha256 ?? null,
      });
    }
    return rows;
  }

  /** The authority the installed plugin.json declares (design §15.6 update review); null when it is not installed. */
  async getInstalledAuthority(pluginId: string): Promise<PluginAuthority | null> {
    const entry = await this.getRawRegistryEntry(pluginId);
    if (!entry || entry.pendingUpdate) return null;
    const manifestPath = isAbsolute(entry.manifestPath) ? entry.manifestPath : resolve(dirname(this.registryPath), entry.manifestPath);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (err) {
      if (isMissingPathError(err)) return null;
      throw err;
    }
    const authority = manifestAuthority(JSON.parse(raw) as unknown);
    if (!authority) throw new Error(`installed plugin.json of ${pluginId} has no Ave extension`);
    return authority;
  }

  /**
   * What an automatic update of `pluginId` is compared with (design
   * §18.7.3): the consent fingerprint its receipt stored, or one computed
   * from the receipt-covered installed bytes for an install from before
   * slice F, never from a catalog. Installed files that no longer match
   * their receipt give a fingerprint that is entirely unknown. Also the
   * receipt's `reviewedAppVersion`, which an update that needs no review
   * keeps. Null when it is not installed.
   */
  async getInstalledConsentBaseline(pluginId: string): Promise<{ consent: ConsentFingerprint; reviewedAppVersion: string | null; enabled: boolean; files: PayloadFile[] | null } | null> {
    const entry = await this.getRawRegistryEntry(pluginId);
    if (!entry || entry.pendingUpdate) return null;
    const manifestPath = isAbsolute(entry.manifestPath) ? entry.manifestPath : resolve(dirname(this.registryPath), entry.manifestPath);
    const pluginRoot = dirname(manifestPath);
    const enabled = entry.enabled !== false;
    let raw: string;
    try {
      raw = await readFile(installReceiptPath(this.cacheRoot, pluginId), "utf-8");
    } catch (err) {
      if (isMissingPathError(err)) return { consent: unknownConsent("plugin"), reviewedAppVersion: null, enabled, files: null };
      throw err;
    }
    const verified = await verifyInstallReceiptRaw(raw, pluginId, pluginRoot);
    if (!verified.ok) return { consent: unknownConsent("plugin"), reviewedAppVersion: null, enabled, files: null };
    const { receipt } = verified;
    const reviewedAppVersion = receipt.reviewedAppVersion ?? null;
    const files = await readPayloadFiles(pluginRoot, receipt.files.map((file) => file.path));
    const stored = "git" in receipt ? receipt.git.consent : "folder" in receipt ? receipt.folder.consent : undefined;
    if (stored) return { consent: stored, reviewedAppVersion, enabled, files };
    const manifest = files.find((file) => file.path === "plugin.json");
    if (!manifest) return { consent: unknownConsent("plugin"), reviewedAppVersion, enabled, files };
    return { consent: pluginConsent(JSON.parse(manifest.data.toString("utf8")) as unknown, files), reviewedAppVersion, enabled, files };
  }

  /** The files a staged artifact installs, by the paths extraction gives them (design §18.7.3 review). */
  stagedPayloadFiles(staged: StagedPluginArtifact): PayloadFile[] {
    return this.artifactStore.readZipPayloadFiles(staged.plan.name, staged.zipBuffer);
  }

  /** Read even a disabled or refused-load install without depending on runtime state. */
  async getInstalledConfigManifest(pluginId: string): Promise<{ manifest: PluginManifest; enabled: boolean; sourceId: string | null } | null> {
    const entry = await this.getRawRegistryEntry(pluginId);
    if (!entry || entry.pendingUpdate) return null;
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    const manifest = flattenAgentPluginsManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.id !== pluginId) throw new Error("Installed plugin manifest identity mismatch");
    return { manifest, enabled: entry.enabled !== false, sourceId: entry.origin?.sourceId ?? null };
  }

  private mergeBundleRefs(
    bundleRefs: string[] | undefined,
    bundleRootId: string | null,
    pluginId: string,
  ): string[] {
    if (!bundleRootId || bundleRootId === pluginId) {
      return bundleRefs ?? [];
    }
    return [...new Set([...(bundleRefs ?? []), bundleRootId])];
  }

  private async executeRemovalTransaction(
    kind: RemovalTransactionKind,
    registryBefore: PluginRegistryEntry[],
    registryAfter: PluginRegistryEntry[],
    originals: Array<{ pluginId: string; path: string }>,
    commitRegistry: () => Promise<unknown>,
  ): Promise<void> {
    const pluginIds = [...new Set([...registryBefore, ...registryAfter].map((entry) => entry.id))].sort();
    const journal = await createRemovalTransaction(this.paths, {
      kind,
      pluginIds,
      registryBefore,
      registryAfter,
      originals: originals.filter((item) => existsSync(item.path)),
    });
    try {
      await stageRemovalTransaction(this.paths, journal);
      await commitRegistry();
    } catch (error) {
      try {
        await abortRemovalTransaction(this.paths, journal);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `${kind} and staged-directory restore both failed`);
      }
      throw error;
    }

    try {
      await markRemovalTransactionRegistryCommitted(this.paths, journal);
      await finishRemovalTransaction(this.paths, journal);
    } catch (error) {
      log.warn(
        { transactionId: journal.transactionId, kind, error },
        "committed plugin removal transaction retained for boot reconciliation",
      );
    }
  }

  private ownedDirectoriesForEntry(entry: PluginRegistryEntry): string[] {
    const directories = new Set<string>(pendingOwnedBackupPaths(this.paths, entry));
    directories.add(this.installedDirectoryForEntry(entry));
    return [...directories];
  }

  private installedDirectoryForEntry(entry: PluginRegistryEntry): string {
    return assertCanonicalRegistryOwnership(this.paths, entry);
  }

  /**
   * Load manifests for all currently-installed plugins so the dependency
   * resolver can inspect their `capabilities[]`.  Skips entries whose manifest
   * is missing (ENOENT — stale registry entry, fail-open per §S14: a single
   * stray manifest must not block unrelated installs). Other manifest IO /
   * parse errors propagate so corruption is surfaced rather than silently
   * dropping a real plugin from dependency resolution.
   *
   * Registry read errors propagate (ENOENT is already returned
   * as the empty default inside readPluginRegistry).
   */
  private async loadInstalledManifests(): Promise<PluginManifest[]> {
    const registry = await readPluginRegistry(this.registryPath);
    const manifests: PluginManifest[] = [];
    for (const entry of registry.plugins) {
      if (entry.pendingUpdate) continue;
      if (entry.enabled === false) continue;
      const abs = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(this.registryPath), entry.manifestPath);
      let raw: string;
      try {
        raw = await readFile(abs, "utf-8");
      } catch (err) {
        // ENOENT → stale registry entry; skip silently. Other errors
        // (permission, IO) propagate.
        if (isMissingPathError(err)) continue;
        throw err;
      }
      manifests.push(flattenAgentPluginsManifest(JSON.parse(raw)));
    }
    return manifests;
  }

  /**
   * The receipt of an `installLocal` install, built against the staged tree
   * after its contributions resolve. Git installs write their own (schema v4).
   */
  private async prepareInstallReceipt(
    pluginId: string,
    pluginRoot: string,
    opts: { version: string; files: string[]; installedAt?: string },
  ): Promise<string> {
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf-8");
    const manifest = flattenAgentPluginsManifest(JSON.parse(manifestRaw));
    // Resolve every declaration and build the exact receipt against the staged
    // tree. Neither live payload nor durable metadata has changed yet.
    await materializePluginContributions(pluginRoot, manifest);
    return (await this.artifactStore.prepareInstallReceipt(pluginId, pluginRoot, opts)).raw;
  }

  /**
   * Install a plugin from a git source (design §6.2, §2.3). Inside the plugin
   * lock: the deployment guard, then the dependency preflight on the plan's
   * authority — before anything is downloaded — then the ladder (`stage`),
   * then the shared zip transaction with a v4 receipt and the registry
   * `origin`. There is no envelope verification on this path: the ladder
   * proved the bytes against the pin or computed their tree digest, and the
   * staged manifest against the descriptor.
   */
  async installGitPlugin(
    plan: PluginInstallPlan,
    options: {
      stage: (plan: PluginInstallPlan) => Promise<StagedPluginArtifact>;
      activatePreparedArtifact: PreparedMarketplacePluginActivation;
      /** Replace an install bound to another source (or to none); the plugin's data is kept. */
      switchSource?: boolean;
      signal?: AbortSignal;
      reviewedAppVersion?: string;
      /**
       * Checkpoint two of an automatic update (design §18.7.3): sees the
       * consent fingerprint of the extracted bytes, beside the manifest check
       * and before anything activates; a throw installs nothing.
       */
      assertConsent?: (consent: ConsentFingerprint) => void;
    },
  ): Promise<{ pluginId: string; installed: true; version: string; action: InstallAction; staged: StagedPluginArtifact; consent: ConsentFingerprint }> {
    const activatePreparedArtifact = requirePreparedMarketplacePluginActivation(
      options?.activatePreparedArtifact,
      "git plugin install",
    );
    const pluginId = assertSafeArtifactSlug(plan.name);
    return this.withPluginLock(pluginId, async () => {
      const current = await this.getRawRegistryEntry(pluginId);
      const action = classifyInstall(
        plan,
        current
          ? {
              kind: "plugin",
              name: pluginId,
              version: current.origin?.version ?? (await this.getInstalledVersion(pluginId)),
              sourceId: current.origin?.sourceId ?? null,
            }
          : null,
        { switchSource: options.switchSource === true },
      );
      await this.preflightGitDependencies(plan);
      const staged = await options.stage(plan);
      if (staged.plan !== plan) {
        throw new Error(`git plugin install of ${pluginId}: the staged artifact belongs to another plan`);
      }

      const existingEntry = current;
      const origin = gitInstallOrigin(staged);
      await this.snapshotCurrentInstall(pluginId);
      let pendingEntry: PluginRegistryEntry | null = null;
      let installedConsent: ConsentFingerprint | null = null;
      const installOutcome = await this.installZipTransaction(pluginId, staged.zipBuffer, {
        // The ladder checked the zip's plugin.json; this checks the file that
        // was actually extracted, which is the one that will run.
        assertManifest: async (manifestFile) => {
          const document = JSON.parse(await readFile(manifestFile, "utf-8")) as unknown;
          assertGitInstallManifest(document, expectedPluginOf(plan));
          if (hasProcessEntry(document)) assertStagedArtifactPinned(staged);
        },
        prepareReceipt: async (pluginRoot, files) => {
          // The baseline the next update is compared with is what installs now, from these exact bytes (§18.7.3).
          const consent = pluginConsent(JSON.parse(await readFile(resolve(pluginRoot, "plugin.json"), "utf-8")) as unknown, await readPayloadFiles(pluginRoot, files));
          options.assertConsent?.(consent);
          installedConsent = consent;
          return this.prepareGitInstallReceipt(pluginId, pluginRoot, staged, files, consent, options.reviewedAppVersion);
        },
        approvedPluginAccess: plan.authority.pluginAccess as PluginAccessSpec | undefined,
        activatePreparedArtifact,
        registryInstallSource: "user",
        registryOrigin: origin,
        signal: options.signal,
        beforePromote: async (recoveryBackupDir) => {
          // The replacement journal is the same as a catalog install's: the
          // recovery restores a directory and a receipt, whatever wrote them.
          pendingEntry = await this.markMarketplaceRegistryEntryPending(existingEntry, recoveryBackupDir);
        },
        commit: async (manifestPath, manifestAbsPath) => {
          const manifestSha256 = await this.readManifestSha256(manifestAbsPath);
          await this.commitGitRegistryEntry(staged, origin, manifestPath, manifestSha256, existingEntry);
        },
      }).catch((err) => this.restoreMarketplaceRegistryEntryAfterFailure(pendingEntry, existingEntry, err));
      const manifestAbsPath = isAbsolute(installOutcome.manifestPath)
        ? installOutcome.manifestPath
        : resolve(dirname(this.registryPath), installOutcome.manifestPath);
      await this.artifactStore.cacheVersionFromManifest(pluginId, manifestAbsPath).catch((error) => {
        log.warn({ pluginId, err: error }, "post-commit manifest cache degraded");
      });
      await this.artifactStore.appendHistory(pluginId, {
        version: plan.version,
        installedAt: new Date().toISOString(),
      }).catch((error) => {
        log.warn({ pluginId, err: error }, "post-commit install history degraded");
      });
      this.clearInstallReceiptValidationForPlugin(pluginId);
      if (installOutcome.predecessorRetired) {
        await this.discardSupersededPendingBackup(existingEntry).catch((error) => {
          log.warn({ pluginId, err: error }, "post-retirement backup cleanup degraded");
        });
      }
      if (!installedConsent) throw new Error(`git plugin install of ${pluginId} committed without its consent baseline`);
      return { pluginId, installed: true, version: plan.version, action, staged, consent: installedConsent };
    });
  }

  /** `requires.capabilities` and hard plugin dependencies of the plan's authority, against what is installed. */
  private async preflightGitDependencies(plan: PluginInstallPlan): Promise<void> {
    const required = plan.authority.requires?.capabilities ?? [];
    const dependencies = normalizeDependencies({
      dependencies: plan.authority.dependencies as Array<string | DependencySpec> | undefined,
    });
    if (required.length === 0 && dependencies.length === 0) return;
    const installed = await this.loadInstalledManifests();
    const capabilities = resolveDependencies(required, installed);
    if (!capabilities.ok) throw new MissingDependenciesError(capabilities.missing);
    const installedIds = new Set(installed.map((manifest) => manifest.id));
    const missing = dependencies.filter((dependency) => dependency.required && !installedIds.has(dependency.pluginId));
    if (missing.length > 0) throw new MissingPluginDependenciesError(missing.map((dependency) => dependency.pluginId));
  }

  private async prepareGitInstallReceipt(
    pluginId: string,
    pluginRoot: string,
    staged: StagedPluginArtifact,
    files: string[],
    consent: ConsentFingerprint,
    reviewedAppVersion?: string,
  ): Promise<string> {
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf-8");
    await materializePluginContributions(pluginRoot, flattenAgentPluginsManifest(JSON.parse(manifestRaw)));
    const { plan } = staged;
    if (staged.rung === FOLDER_RUNG) {
      if (plan.sourceOrigin === "official") throw new Error(`plugin ${pluginId}: the official source is never a folder`);
      return (await buildFolderInstallReceipt(pluginRoot, {
        pluginId,
        version: plan.version,
        ...(reviewedAppVersion ? { reviewedAppVersion } : {}),
        folder: {
          sourceId: plan.sourceId,
          sourceOrigin: plan.sourceOrigin,
          revision: plan.versionCommit,
          packagePath: plan.packagePath,
          treeSha256: staged.artifactSha256,
          authoritySha256: sha256Hex(canonicalJSON(plan.authority)),
          consent,
        },
        files,
      })).raw;
    }
    return (await buildGitInstallReceipt(pluginRoot, {
      pluginId,
      version: plan.version,
      artifactSha256: staged.artifactSha256,
      ...(reviewedAppVersion ? { reviewedAppVersion } : {}),
      git: {
        sourceId: plan.sourceId,
        sourceOrigin: plan.sourceOrigin,
        snapshotCommit: plan.snapshotCommit,
        versionCommit: plan.versionCommit,
        packagePath: plan.packagePath,
        rung: staged.rung,
        rungs: staged.rungs,
        authoritySha256: sha256Hex(canonicalJSON(plan.authority)),
        consent,
      },
      files,
    })).raw;
  }

  private async commitGitRegistryEntry(
    staged: StagedPluginArtifact,
    origin: PluginRegistryEntryOrigin,
    manifestPath: string,
    manifestSha256: string,
    previousEntry: PluginRegistryEntry | null,
  ): Promise<void> {
    const { plan } = staged;
    const approvedPluginAccess = plan.authority.pluginAccess as PluginAccessSpec | undefined;
    await updatePluginRegistry(this.registryPath, (registry) => {
      const existing = registry.plugins.find((entry) => entry.id === plan.name);
      if (existing) {
        const pendingCleanup = cleanupJournalAfterCommit(existing);
        existing.manifestPath = manifestPath;
        existing.manifestSha256 = manifestSha256;
        existing.enabled = true;
        existing.installSource = "user";
        existing.bundleRefs = this.mergeBundleRefs(existing.bundleRefs, null, plan.name);
        existing.approvedPluginAccess = approvedPluginAccess;
        existing.origin = origin;
        existing.pendingUpdate = undefined;
        existing.pendingCleanup = pendingCleanup;
      } else {
        registry.plugins.push({
          id: plan.name,
          manifestPath,
          manifestSha256,
          enabled: true,
          installSource: "user",
          bundleRefs: this.mergeBundleRefs(previousEntry?.bundleRefs ?? [], null, plan.name),
          approvedPluginAccess,
          origin,
        });
      }
    });
  }

  /**
   * Stage → receipt → registry → generation for one zip that the caller has
   * already verified (a signed catalog artifact, or a git ladder result). The
   * caller decides how the staged manifest is checked, which receipt is
   * written and which access grant the registry records; everything else —
   * promotion, the prior-receipt restore and activation — is shared.
   */
  private async installZipTransaction(
    pluginId: string,
    zipBuffer: Buffer,
    opts: {
      assertManifest: (manifestFile: string, pluginRoot: string) => Promise<void>;
      prepareReceipt: (pluginRoot: string, files: string[]) => Promise<string>;
      approvedPluginAccess: PluginAccessSpec | undefined;
      beforePromote?: (recoveryBackupDir: string) => Promise<void>;
      commit?: (manifestPath: string, manifestAbsPath: string) => Promise<void>;
      activatePreparedArtifact: PreparedMarketplacePluginActivation;
      registryInstallSource: PluginRegistryEntryInstallSource;
      /** The origin the commit records; the candidate's HostApi trusts it from its first start. */
      registryOrigin?: PluginRegistryEntryOrigin;
      signal?: AbortSignal;
    },
  ): Promise<{ manifestPath: string; predecessorRetired: boolean }> {
    let priorReceiptRaw: string | undefined;
    try {
      priorReceiptRaw = await readFile(
        installReceiptPath(this.cacheRoot, pluginId),
        "utf-8",
      );
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
    }
    let receiptCommitted = false;
    let preparedReceiptRaw: string | undefined;
    let preparedManifest: PluginManifest | undefined;
    let preparedDocument: unknown;
    try {
      if (opts.signal?.aborted) {
        const error = new Error(`marketplace plugin install aborted before promotion: ${pluginId}`);
        error.name = "AbortError";
        throw error;
      }
      const transaction = await this.artifactStore.extractZipWithCommit(
        pluginId,
        zipBuffer,
        async (pluginDir) => {
          const manifestFile = resolve(pluginDir, "plugin.json");
          if (!preparedReceiptRaw || !preparedManifest) {
            throw new Error(`plugin "${pluginId}" durable commit ran before staged preparation`);
          }
          await this.artifactStore.persistPreparedInstallReceipt(pluginId, preparedReceiptRaw);
          receiptCommitted = true;
          const manifestPath = toRegistryRelativeManifestPath(this.registryPath, manifestFile);
          await opts.commit?.(manifestPath, manifestFile);
          return manifestPath;
        },
        {
          beforePromote: opts.beforePromote,
          coordinateCommit: async ({ pluginRoot, files, durableCommit }) => {
            const manifestFile = resolve(pluginRoot, "plugin.json");
            let manifestRaw: string;
            try {
              manifestRaw = await readFile(manifestFile, "utf-8");
            } catch {
              throw new Error(
                `plugin "${pluginId}" verified artifact is missing plugin.json — every published marketplace zip must ship its own manifest`,
              );
            }
            await opts.assertManifest(manifestFile, pluginRoot);
            preparedDocument = JSON.parse(manifestRaw) as unknown;
            preparedManifest = flattenAgentPluginsManifest(preparedDocument);
            preparedReceiptRaw = await opts.prepareReceipt(pluginRoot, [...files]);
            if (preparedManifest.process !== undefined) {
              // Admission trusts the rung this transaction commits, read back
              // from its own receipt the way the runtime gate reads it
              // (§9.7 P4, decision 35): only a git release or archive rung
              // with a sha256 pin, never a tree rung or a catalog receipt.
              const committing = await verifyInstallReceiptRaw(preparedReceiptRaw, pluginId, pluginRoot);
              if (!committing.ok) {
                throw new Error(`plugin "${pluginId}" prepared receipt does not verify against its staged payload: ${committing.reason}`);
              }
              assertProcessEntryAdmitted(preparedManifest, processEntryProvenance(committing.receipt));
            }
            try {
              return await opts.activatePreparedArtifact({
                installId: pluginId,
                pluginRoot,
                manifest: preparedManifest,
                receiptRaw: preparedReceiptRaw,
                registryEntry: {
                  installSource: opts.registryInstallSource,
                  ...(opts.registryOrigin ? { origin: opts.registryOrigin } : {}),
                  // The pin covers the FILE, so it hashes the document —
                  // `readManifestSha256` re-derives it that way on every later
                  // read, and a pin taken over the projection would never
                  // match one taken over the file.
                  manifestSha256: shaOfManifest(preparedDocument),
                },
                ...(opts.approvedPluginAccess ? { approvedPluginAccess: opts.approvedPluginAccess } : {}),
                durableCommit,
              });
            } catch (error) {
              // The child factory refuses a manifest with no served
              // `hostProtocol` when the runtime invokes it (§9.8 A1, decision
              // 52). Reported as the update's own incompatibility — the
              // existing code and detail the catalog uses for an unserved
              // version — so the Updates card does not read it as an
              // unreachable source. The running generation is untouched.
              if (error instanceof IncompatibleHostProtocolError) {
                throw new MarketplaceError("PACKAGE_INCOMPATIBLE", error.message, {
                  cause: error,
                  detail: { reason: "host_protocol", name: pluginId },
                });
              }
              throw error;
            }
          },
          onCommittedBackupResolved: (obsoleteDir) =>
            clearObsoletePluginBackupOwnership(this.paths, pluginId, obsoleteDir),
        },
      );
      return {
        manifestPath: transaction.result,
        predecessorRetired: transaction.predecessorRetired,
      };
    } catch (err) {
      if (isCommittedPluginGenerationPublicationError(err)) throw err;
      if (!receiptCommitted) throw err;
      if (err instanceof ArtifactRollbackError) throw err;
      try {
        if (priorReceiptRaw === undefined) {
          await rm(installReceiptPath(this.cacheRoot, pluginId), { force: true });
        } else {
          await restoreInstallReceiptRaw(this.cacheRoot, pluginId, priorReceiptRaw);
        }
      } catch (receiptRestoreError) {
        throw new ArtifactRollbackError(
          `marketplace install and receipt rollback both failed: ${pluginId}`,
          [err, receiptRestoreError],
        );
      }
      throw err;
    }
  }

  private async markMarketplaceRegistryEntryPending(
    expectedEntry: PluginRegistryEntry | null,
    recoveryBackupDir: string,
  ): Promise<PluginRegistryEntry | null> {
    if (!expectedEntry) return null;
    return preparePendingPluginUpdate(this.paths, expectedEntry, {
      kind: "marketplace",
      recoveryBackupDir,
      recoveryBackupMode: "rename",
    });
  }

  private async restoreMarketplaceRegistryEntryAfterFailure(
    pendingEntry: PluginRegistryEntry | null,
    previousEntry: PluginRegistryEntry | null,
    installError: unknown,
  ): Promise<never> {
    if (isCommittedPluginGenerationPublicationError(installError)) {
      throw installError;
    }
    if (!pendingEntry) {
      throw installError;
    }
    if (installError instanceof ArtifactRollbackError && !previousEntry?.pendingUpdate) {
      throw installError;
    }
    try {
      if (previousEntry?.pendingUpdate) {
        await restoreSupersededPendingPluginUpdate(this.paths, pendingEntry, previousEntry, {
          preserveRetryCleanup: installError instanceof ArtifactRollbackError,
        });
      } else {
        const recovery = await recoverPendingPluginUpdate(this.paths, pendingEntry.id);
        if (recovery !== "recovered") {
          throw new Error(`marketplace update recovery remains unresolved: ${pendingEntry.id}`);
        }
      }
    } catch (registryRestoreError) {
      throw new AggregateError(
        [installError, registryRestoreError],
        `marketplace install and registry rollback both failed: ${pendingEntry.id}`,
      );
    }
    throw installError;
  }

  private async discardSupersededPendingBackup(entry: PluginRegistryEntry | null): Promise<void> {
    if (!entry?.pendingUpdate?.recoveryBackupDir) return;
    await cleanupObsoletePluginBackupPath(this.paths, entry.id, entry.pendingUpdate.recoveryBackupDir).catch((err) => {
      log.warn(`superseded recovery backup retained for ${entry.id}: ${(err as Error).message}`);
    });
  }

  private clearInstallReceiptValidationForPlugin(pluginId: string): void {
    const prefix = `${pluginId}\0`;
    for (const key of this.installReceiptValidationCache.keys()) {
      if (key.startsWith(prefix)) {
        this.installReceiptValidationCache.delete(key);
      }
    }
  }

  /**
   * Dev-only: copy a locally-built plugin directory into ~/.ave/plugins/<id>/
   * and register it in the plugin registry. Gated on isDevModeUnlocked() so
   * packaged builds cannot invoke this path.
   */
  async resolveLocalInstallPluginId(sourcePath: string): Promise<string> {
    if (!isDevModeUnlocked()) {
      throw new Error(
        "[security] installLocal requires dev mode — enable a supported AVE_DEV* flag in a non-packaged build",
      );
    }

    let srcStat: Awaited<ReturnType<typeof statAsync>>;
    try {
      srcStat = await statAsync(sourcePath);
    } catch {
      throw new Error(`[installLocal] path does not exist: ${sourcePath}`);
    }
    if (!srcStat.isDirectory()) {
      throw new Error(`[installLocal] path is not a directory: ${sourcePath}`);
    }

    const manifestPath = resolve(sourcePath, "plugin.json");
    let manifest: { id?: unknown };
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifest = flattenAgentPluginsManifest(JSON.parse(raw)) as {
        id?: unknown;
      };
    } catch {
      throw new Error(`[installLocal] could not read plugin.json in ${sourcePath}`);
    }
    const pluginId = typeof manifest.id === "string" ? manifest.id.trim() : "";
    if (!pluginId) {
      throw new Error("[installLocal] plugin.json must have a non-empty 'id' field");
    }
    try {
      assertSafeArtifactSlug(pluginId);
    } catch {
      throw new Error(
        `[installLocal] unsafe plugin id — must match ^[a-zA-Z0-9._-]+$: ${pluginId}`,
      );
    }
    return pluginId;
  }

  async installLocal(
    sourcePath: string,
    options: { activatePreparedArtifact: PreparedMarketplacePluginActivation },
  ): Promise<{ pluginId: string; installed: true; unchanged?: true }> {
    const activatePreparedArtifact = requirePreparedMarketplacePluginActivation(
      options?.activatePreparedArtifact,
      "local plugin install",
    );
    if (!isDevModeUnlocked()) {
      throw new Error(
        "[security] installLocal requires dev mode — enable a supported AVE_DEV* flag in a non-packaged build",
      );
    }

    // Validate the source path exists and is a directory (non-blocking).
    let srcStat: Awaited<ReturnType<typeof statAsync>>;
    try {
      srcStat = await statAsync(sourcePath);
    } catch {
      throw new Error(`[installLocal] path does not exist: ${sourcePath}`);
    }
    if (!srcStat.isDirectory()) {
      throw new Error(`[installLocal] path is not a directory: ${sourcePath}`);
    }

    // Read and parse plugin.json from the source directory.
    const manifestPath = resolve(sourcePath, "plugin.json");
    let manifest: PluginManifest & { id?: unknown; [key: string]: unknown };
    // The document is kept alongside the projection: reads go through the
    // projection, but the registry's manifest pin covers the file.
    let manifestDocument: unknown;
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifestDocument = JSON.parse(raw) as unknown;
      manifest = flattenAgentPluginsManifest(manifestDocument) as
        PluginManifest & { id?: unknown; [key: string]: unknown };
    } catch {
      throw new Error(`[installLocal] could not read plugin.json in ${sourcePath}`);
    }
    // A local install is never pinned by a release or archive artifact.
    if (hasProcessEntry(manifestDocument)) throw new ProcessEntryRequiresPinnedArtifactError();

    const pluginId = typeof manifest.id === "string" ? manifest.id.trim() : "";
    if (!pluginId) {
      throw new Error("[installLocal] plugin.json must have a non-empty 'id' field");
    }

    // Validate pluginId is a safe directory name.
    try {
      assertSafeArtifactSlug(pluginId);
    } catch {
      throw new Error(
        `[installLocal] unsafe plugin id — must match ^[a-zA-Z0-9._-]+$: ${pluginId}`,
      );
    }

    // Validate version up front — same throw message as the receipt-write
    // step, but BEFORE any filesystem mutation (cp / rename / registry
    // update) so a malformed manifest does not leave a half-installed
    // plugin dir + registry entry behind requiring manual cleanup.
    if (typeof manifest.version !== "string" || !manifest.version) {
      throw new Error(
        `[installLocal] plugin.json must declare a non-empty 'version' string: ${pluginId}`,
      );
    }
    const manifestVersion = manifest.version;

    return this.withPluginLock(pluginId, async () => {
      const userPluginsRoot = this.pluginsRoot;
      const installDir = resolve(userPluginsRoot, pluginId);

      const existingRegistry = await readPluginRegistry(this.registryPath);
      const existingEntry = existingRegistry.plugins.find((p) => p.id === pluginId);
      const rollbackSnapshot = existingEntry
        ? existingEntry.pendingUpdate
          ? {
              kind: "pending-predecessor" as const,
              installDir,
              registryEntry: this.cloneRegistryEntry(existingEntry),
            }
          : await this.createLocalInstallRollbackSnapshot(pluginId, installDir, existingEntry)
        : null;

      const stagingDir = resolve(userPluginsRoot, `${pluginId}.tmp-${process.pid}-${Date.now()}`);
      let durableCommitted = false;
      let commitAttempt: Promise<string> | undefined;
      const settleCommittedLocalUpdate = async (
        committed: CommittedPluginGeneration<string>,
      ): Promise<void> => {
        const finalize = async (): Promise<void> => {
          await committed.retirement;
          if (rollbackSnapshot) await this.discardLocalInstallRollbackSnapshot(rollbackSnapshot);
          if (!existingEntry?.pendingUpdate) {
            await this.discardSupersededPendingBackup(existingEntry ?? null);
          }
        };
        if (committed.retirementDeferred) {
          const deferredCleanup = finalize();
          this.deferredLifecycleCleanups.add(deferredCleanup);
          void deferredCleanup.finally(() => {
            this.deferredLifecycleCleanups.delete(deferredCleanup);
          }).catch((error) => {
            log.warn({ pluginId, err: error }, "local plugin predecessor retirement deferred");
          });
          return;
        }
        try {
          await finalize();
        } catch (error) {
          log.warn({ pluginId, err: error }, "local plugin predecessor retirement deferred");
        }
      };
      try {
        // Copy and validate the complete candidate before touching live bytes,
        // receipt, registry, runtime, or any generation pointer.
        await rm(stagingDir, { recursive: true, force: true });
        await cp(sourcePath, stagingDir, {
          recursive: true,
          verbatimSymlinks: true,
          filter: buildSideloadCopyFilter(sourcePath),
        });
        await rejectSideloadSymlinks(stagingDir);

        // Same top-level exclusion the receipt VERIFIER applies on every later
        // load (`verifyInstallReceipt` → `listFilesRecursive`). A receipt that
        // listed a runtime directory would stop matching the payload the first
        // time the plugin wrote to it, and the plugin would refuse to load.
        const receiptFiles = await listFilesRecursive(stagingDir, PLUGIN_RUNTIME_DIR_NAMES);
        const localReceiptRaw = await this.prepareInstallReceipt(pluginId, stagingDir, {
          version: manifestVersion,
          files: receiptFiles,
        });
        const registryManifestPath = posix.join(pluginId, "plugin.json");
        const manifestSha256 = shaOfManifest(manifestDocument);
        const approvedPluginAccess = manifest.pluginAccess;

        const durableCommit = (): Promise<string> => {
          if (commitAttempt) return commitAttempt;
          commitAttempt = (async () => {
            if (existingEntry) {
              await preparePendingPluginUpdate(this.paths, existingEntry, {
                kind: "local-dev",
                ...(rollbackSnapshot?.backupDir
                  ? { recoveryBackupDir: rollbackSnapshot.backupDir, recoveryBackupMode: "copy" as const }
                  : {}),
              });
            }
            // The live root is removed whole. Its data directory is the plugin's
            // state, not payload: it travels through the registered recovery
            // backup into the promoted root, so at every instant it is somewhere
            // boot recovery knows to reunite it with whichever root survives.
            const dataCarrier = localInstallDataCarrier(rollbackSnapshot);
            await retryOnTransientFsLock(
              () => carryPluginDataDir(installDir, dataCarrier ?? stagingDir, { onConflict: "reject" }),
            );
            // The socket directories the activated candidate (and, on an
            // update, the still-live predecessor) are bound to take the same
            // route as the state, NOT into the staged root: if the swap below
            // fails, the catch removes the staged root, and the rollback
            // restores from the recovery backup — so a socket directory parked
            // in the staged root would be deleted with it (carryPluginSocketDirs).
            await carryPluginSocketDirs(installDir, dataCarrier ?? stagingDir, { onConflict: "reject" });
            await rm(installDir, { recursive: true, force: true });
            await rename(stagingDir, installDir);
            if (dataCarrier) {
              await retryOnTransientFsLock(
                () => carryPluginDataDir(dataCarrier, installDir, { onConflict: "reject" }),
              );
              await carryPluginSocketDirs(dataCarrier, installDir, { onConflict: "reject" });
            }
            await this.artifactStore.persistPreparedInstallReceipt(pluginId, localReceiptRaw);
            await updatePluginRegistry(this.registryPath, (registry) => {
              const existing = registry.plugins.find((x) => x.id === pluginId);
              if (existing) {
                const pendingCleanup = cleanupJournalAfterCommit(existing);
                existing.manifestPath = registryManifestPath;
                existing.manifestSha256 = manifestSha256;
                existing.enabled = true;
                existing.installSource = "local-dev";
                existing.approvedPluginAccess = approvedPluginAccess;
                // A local build replaces whatever a git install put here.
                existing.origin = undefined;
                existing.pendingUpdate = undefined;
                existing.pendingCleanup = pendingCleanup;
              } else {
                registry.plugins.push({
                  id: pluginId,
                  manifestPath: registryManifestPath,
                  manifestSha256,
                  enabled: true,
                  installSource: "local-dev",
                  approvedPluginAccess,
                });
              }
            });
            durableCommitted = true;
            this.clearInstallReceiptValidationForPlugin(pluginId);
            return registryManifestPath;
          })();
          return commitAttempt;
        };

        const activated = await activatePreparedArtifact({
          installId: pluginId,
          pluginRoot: stagingDir,
          manifest,
          receiptRaw: localReceiptRaw,
          registryEntry: {
            installSource: "local-dev",
            manifestSha256,
          },
          ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
          durableCommit,
        });
        if (!durableCommitted) {
          throw new Error(`local plugin activation returned before durable commit: ${pluginId}`);
        }
        await settleCommittedLocalUpdate(activated);
        return { pluginId, installed: true as const };
      } catch (err) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        // A generation callback must never trigger compensating rollback after
        // the durable pointer commit. Post-commit health is journaled by the
        // lifecycle; this branch is only candidate/durable-commit failure.
        if (durableCommitted) {
          if (isCommittedPluginGenerationPublicationError(err) && err.committed) {
            await settleCommittedLocalUpdate(
              err.committed as CommittedPluginGeneration<string>,
            );
          }
          throw err;
        }
        if (!commitAttempt) {
          if (rollbackSnapshot) {
            await this.discardLocalInstallRollbackSnapshot(rollbackSnapshot);
          }
          throw err;
        }
        const rollbackErrors: unknown[] = [];
        let restored = false;
        if (rollbackSnapshot) {
          try {
            await this.restoreLocalInstallSnapshot(pluginId, rollbackSnapshot);
            restored = true;
          } catch (restoreErr) {
            log.warn(`installLocal rollback restore failed for ${pluginId}: ${(restoreErr as Error).message}`);
            rollbackErrors.push(restoreErr);
          }
        } else {
          try {
            await this.cleanupFreshInstalledPlugin(pluginId);
          } catch (cleanupErr) {
            log.warn(`installLocal fresh cleanup failed for ${pluginId}: ${(cleanupErr as Error).message}`);
            rollbackErrors.push(cleanupErr);
          }
        }
        if (restored) {
          try {
            await this.discardLocalInstallRollbackSnapshot(rollbackSnapshot);
          } catch (cleanupErr) {
            log.warn(`installLocal rollback snapshot cleanup failed for ${pluginId}: ${(cleanupErr as Error).message}`);
            rollbackErrors.push(cleanupErr);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [err, ...rollbackErrors],
            `local plugin install and rollback both failed: ${pluginId}`,
          );
        }
        throw err;
      }
    });
  }

  private async createLocalInstallRollbackSnapshot(
    pluginId: string,
    installDir: string,
    existingEntry: PluginRegistryEntry,
  ): Promise<LocalInstallRollbackSnapshot> {
    const snapshot: LocalInstallRollbackSnapshot = {
      kind: "filesystem-snapshot",
      installDir,
      registryEntry: this.cloneRegistryEntry(existingEntry),
    };
    try {
      snapshot.receiptRaw = await readFile(installReceiptPath(this.cacheRoot, pluginId), "utf-8");
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
    }
    try {
      const current = await statAsync(installDir);
      if (!current.isDirectory()) return snapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
      throw err;
    }
    const backupRoot = resolve(this.pluginsRoot, ".cache", "local-install-rollback");
    await mkdir(backupRoot, { recursive: true });
    const backupDir = resolve(backupRoot, `${pluginId}-${process.pid}-${Date.now()}`);
    await rm(backupDir, { recursive: true, force: true });
    await cp(installDir, backupDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: pluginPayloadCopyFilter(installDir),
    });
    snapshot.backupDir = backupDir;
    return snapshot;
  }

  private cloneRegistryEntry(entry: PluginRegistryEntry): PluginRegistryEntry {
    return {
      ...entry,
      bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined,
      approvedPluginAccess: entry.approvedPluginAccess,
      pendingUpdate: entry.pendingUpdate ? { ...entry.pendingUpdate } : undefined,
      pendingCleanup: entry.pendingCleanup?.map((item) => ({ ...item })),
    };
  }

  private async restoreLocalInstallSnapshot(
    pluginId: string,
    snapshot: LocalInstallRollbackSnapshot | null,
  ): Promise<void> {
    if (!snapshot) return;
    if (snapshot.kind === "pending-predecessor") {
      if (!snapshot.registryEntry.pendingUpdate) {
        throw new Error(`Pending local rollback predecessor metadata missing: ${pluginId}`);
      }
      await updatePluginRegistry(this.registryPath, (registry) => {
        const restoredEntry = this.cloneRegistryEntry(snapshot.registryEntry);
        const existingIndex = registry.plugins.findIndex((entry) => entry.id === pluginId);
        if (existingIndex >= 0) registry.plugins[existingIndex] = restoredEntry;
        else registry.plugins.push(restoredEntry);
      });
      const outcome = await recoverPendingPluginUpdate(this.paths, pluginId);
      if (outcome !== "recovered") {
        throw new Error(`Pending local rollback predecessor remains unresolved: ${pluginId}`);
      }
      this.clearInstallReceiptValidationForPlugin(pluginId);
      return;
    }
    await readPluginRegistry(this.registryPath);
    const backupDir = snapshot.backupDir;
    if (backupDir) {
      // Whichever step of the swap failed, the plugin's data directory is in
      // exactly one of the two roots. The promoted root is about to go; the
      // state moves into the backup that is about to come back first.
      await retryOnTransientFsLock(
        () => carryPluginDataDir(snapshot.installDir, backupDir, { onConflict: "reject" }),
      );
      // The predecessor is still the live generation here, and its sockets
      // are in the root about to be removed.
      await carryPluginSocketDirs(snapshot.installDir, backupDir, { onConflict: "reject" });
    }
    await rm(snapshot.installDir, { recursive: true, force: true });
    if (backupDir) {
      const restoreStageDir = `${snapshot.installDir}.restore-${process.pid}-${Date.now()}`;
      await rm(restoreStageDir, { recursive: true, force: true });
      try {
        await cp(backupDir, restoreStageDir, {
          recursive: true,
          verbatimSymlinks: true,
          filter: pluginPayloadCopyFilter(backupDir),
        });
        await retryOnTransientFsLock(() => rename(restoreStageDir, snapshot.installDir), {
          onRetry: (attempt, code) =>
            log.warn({ pluginId, attempt, code }, "retrying local rollback directory restore under fs lock"),
        });
      } catch (err) {
        await rm(restoreStageDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      await retryOnTransientFsLock(
        () => carryPluginDataDir(backupDir, snapshot.installDir, { onConflict: "reject" }),
      );
      await carryPluginSocketDirs(backupDir, snapshot.installDir, { onConflict: "reject" });
    }
    const receiptPath = installReceiptPath(this.cacheRoot, pluginId);
    if (snapshot.receiptRaw !== undefined) {
      await restoreInstallReceiptRaw(this.cacheRoot, pluginId, snapshot.receiptRaw);
    } else {
      await rm(receiptPath, { force: true });
    }
    await updatePluginRegistry(this.registryPath, (registry) => {
      const restoredEntry = this.cloneRegistryEntry(snapshot.registryEntry);
      const existingIndex = registry.plugins.findIndex((entry) => entry.id === pluginId);
      if (existingIndex >= 0) {
        const currentCleanup = registry.plugins[existingIndex]?.pendingCleanup ?? [];
        const restoredCleanup = restoredEntry.pendingCleanup ?? [];
        const mergedCleanup = [...restoredCleanup.map((item) => ({ ...item }))];
        for (const item of currentCleanup) {
          if (!mergedCleanup.some((candidate) => resolve(candidate.path) === resolve(item.path))) {
            mergedCleanup.push({ ...item });
          }
        }
        restoredEntry.pendingCleanup = mergedCleanup.length > 0 ? mergedCleanup : undefined;
        registry.plugins[existingIndex] = restoredEntry;
      } else {
        registry.plugins.push(restoredEntry);
      }
    });
    this.clearInstallReceiptValidationForPlugin(pluginId);
  }

  private async cleanupFreshInstalledPlugin(pluginId: string): Promise<void> {
    const installDir = resolve(this.pluginsRoot, pluginId);
    await updatePluginRegistry(this.registryPath, (registry) => {
      registry.plugins = registry.plugins.filter((entry) => entry.id !== pluginId);
    });
    await rm(installDir, { recursive: true, force: true });
    await rm(installReceiptPath(this.cacheRoot, pluginId), { force: true });
    this.clearInstallReceiptValidationForPlugin(pluginId);
  }

  private async discardLocalInstallRollbackSnapshot(
    snapshot: LocalInstallRollbackSnapshot | null,
  ): Promise<void> {
    if (snapshot?.kind === "pending-predecessor") {
      const backupDir = snapshot.registryEntry.pendingUpdate?.recoveryBackupDir;
      if (backupDir) {
        await cleanupObsoletePluginBackupPath(this.paths, snapshot.registryEntry.id, backupDir);
      }
      return;
    }
    if (snapshot?.backupDir) {
      await rm(snapshot.backupDir, { recursive: true, force: true });
      await clearObsoletePluginBackupOwnership(
        this.paths,
        snapshot.registryEntry.id,
        snapshot.backupDir,
      );
    }
  }

}
