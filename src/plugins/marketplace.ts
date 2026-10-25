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
import { ArtifactRollbackError, PluginArtifactStore } from "./plugin-artifact-store.js";
import { retryOnTransientFsLock } from "../lib/transient-fs-lock-retry.js";
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
  assertPayloadOnlyPluginTree,
  carryPluginStateDirs,
  carryPluginSocketDirs,
  pluginPayloadCopyFilter,
} from "./plugin-storage-layout.js";
import { removePluginTreeNowOrAtBoot } from "./installed-entry-fs.js";
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
import { errorMessage } from "../shared/error-message.js";
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

/** Carry local replacement state through the registered recovery backup so boot can always find it. */
async function removeTreeNow(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Immediate staging deletion requires payload only, with no confined process granted access. */
async function removePayloadOnlyTree(path: string): Promise<void> {
  await assertPayloadOnlyPluginTree(path);
  await rm(path, { recursive: true, force: true });
}

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

/** Registry origin records the source binding; folder installs use their revision and folder rung. */
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

/** Bind receipt rung and digest to the verified plan before commit; process admission trusts those exact fields. */
function assertStagedArtifactPinned(staged: StagedPluginArtifact): void {
  const { plan, rung } = staged;
  // Folder installs never qualify for process entry.
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
  /** Per-plugin rollback version cache. */
  private readonly cacheRoot: string;
  /** The artifact store owns extraction, history and snapshots; this class coordinates registry commits. */
  private readonly artifactStore: PluginArtifactStore;
  private readonly installReceiptValidationCache = new Map<string, InstallReceiptValidation>();
  private readonly deferredLifecycleCleanups = new Set<Promise<void>>();
  /** Serialize each plugin mutation across cache breadcrumbs and history writes. */
  private readonly locks = new Map<string, Promise<void>>();
  readonly log?: (message: string, ...args: unknown[]) => void;

  constructor(paths: PluginPaths, deploymentGuard?: PluginDeploymentGuard) {
    this.paths = paths;
    this.registryPath = paths.registryPath;
    this.pluginsRoot = paths.pluginsRoot;
    this.cacheRoot = paths.cacheRoot;
    this.deploymentGuard = deploymentGuard;
    this.artifactStore = new PluginArtifactStore({
      installRoot: paths.pluginsRoot,
      cacheRoot: paths.cacheRoot,
    });
  }

  async uninstall(
    pluginId: string,
    options?: { removeBundleMembers?: boolean },
  ): Promise<{ pluginId: string; uninstalled: true }> {
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

  /** Serialize same-plugin operations while allowing other IDs to proceed; retain queue entries only while pending. */
  private async withPluginLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(pluginId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    // Store and compare the same chained Promise reference so completed operations release their map entries.
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

  private async withPluginLocks<T>(pluginIds: Iterable<string>, fn: () => Promise<T>): Promise<T> {
    const ids = [...new Set(pluginIds)].sort();
    const acquire = (index: number): Promise<T> => {
      if (index >= ids.length) return fn();
      return this.withPluginLock(ids[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  }

  /** Snapshot the installed manifest before overwrite; registry-aware path resolution stays with the caller. */
  private async snapshotCurrentInstall(pluginId: string): Promise<void> {
    // Propagate registry corruption and I/O errors; skipping the snapshot could make replacement unrecoverable.
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

  private async getRawRegistryEntry(pluginId: string): Promise<PluginRegistryEntry | null> {
    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    return entry ? this.cloneRegistryEntry(entry) : null;
  }

  async getInstalledVersion(pluginId: string): Promise<string | null> {
    // Only a missing manifest returns null; registry read errors propagate.
    const registry = await readPluginRegistry(this.registryPath);
    return this.readInstalledVersionFromRegistry(registry, pluginId);
  }

  /** Reuse an already-read registry; missing manifests return null and other errors propagate. */
  private async readInstalledVersionFromRegistry(
    registry: { plugins: PluginRegistryEntry[] },
    pluginId: string,
  ): Promise<string | null> {
    const entry = registry.plugins.find((c) => c.id === pluginId);
    return entry && !entry.pendingUpdate ? this.readInstalledManifestVersion(entry) : null;
  }

  /** Reuse caller registry entries to avoid rereading the registry once per plugin. */
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

  /** Skip in-flight replacements; missing manifests retain a null version in the installed-origin view. */
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
        // Folder refresh compares its installed tree digest.
        digest: entry.origin?.artifactSha256 ?? null,
      });
    }
    return rows;
  }

  /** Return installed authority for update review, or null if absent. */
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

  /** Use the receipt consent baseline or derive it from installed bytes; preserve the accepted review version. */
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

  stagedPayloadFiles(staged: StagedPluginArtifact): PayloadFile[] {
    return this.artifactStore.readZipPayloadFiles(staged.plan.name, staged.zipBuffer);
  }

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

  /** Skip missing manifests but propagate registry and other I/O failures. */
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
        if (isMissingPathError(err)) continue;
        throw err;
      }
      manifests.push(flattenAgentPluginsManifest(JSON.parse(raw)));
    }
    return manifests;
  }

  /** Build local receipts against the staged tree after resolving contributions. */
  private async prepareInstallReceipt(
    pluginId: string,
    pluginRoot: string,
    opts: { version: string; files: string[]; installedAt?: string },
  ): Promise<string> {
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf-8");
    const manifest = flattenAgentPluginsManifest(JSON.parse(manifestRaw));
    // Derive the receipt before changing any live payload or durable metadata.
    await materializePluginContributions(pluginRoot, manifest);
    return (await this.artifactStore.prepareInstallReceipt(pluginId, pluginRoot, opts)).raw;
  }

  /** Install only artifacts already checked against the plan pin and descriptor; preserve the shared transaction pipeline. */
  async installGitPlugin(
    plan: PluginInstallPlan,
    options: {
      stage: (plan: PluginInstallPlan) => Promise<StagedPluginArtifact>;
      activatePreparedArtifact: PreparedMarketplacePluginActivation;
      /** Source replacement preserves plugin data. */
      switchSource?: boolean;
      signal?: AbortSignal;
      reviewedAppVersion?: string;
      /** Compare extracted consent before activation; refusal must install nothing. */
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
        // Check the extracted manifest, not only its archive entry.
        assertManifest: async (manifestFile) => {
          const document = JSON.parse(await readFile(manifestFile, "utf-8")) as unknown;
          assertGitInstallManifest(document, expectedPluginOf(plan));
          if (hasProcessEntry(document)) assertStagedArtifactPinned(staged);
        },
        prepareReceipt: async (pluginRoot, files) => {
          // Future updates compare against the exact bytes installed now.
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
          // Use the same replacement journal regardless of artifact source.
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

  /** Share promotion, receipt restoration and activation for every already-verified archive source. */
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
      /** Record origin before the candidate first uses its HostApi. */
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
              // Admit process entries only from verified pinned release/archive receipts, never tree or catalog provenance.
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
                  // Pin the authored manifest document; its flat projection has a different digest.
                  manifestSha256: shaOfManifest(preparedDocument),
                },
                ...(opts.approvedPluginAccess ? { approvedPluginAccess: opts.approvedPluginAccess } : {}),
                durableCommit,
              });
            } catch (error) {
              // Report unserved protocol as update refusal while preserving the serving generation.
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
        log.error(`marketplace receipt rollback failed for ${pluginId}: ${errorMessage(receiptRestoreError)}`);
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
      log.error(`marketplace registry rollback failed for ${pendingEntry.id}: ${errorMessage(registryRestoreError)}`);
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

  /** Local install is gated by dev unlock and unavailable in packaged builds. */
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
    let manifest: PluginManifest & { id?: unknown; [key: string]: unknown };
    // Keep the authored document beside its projection because the registry pins file bytes.
    let manifestDocument: unknown;
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifestDocument = JSON.parse(raw) as unknown;
      manifest = flattenAgentPluginsManifest(manifestDocument) as
        PluginManifest & { id?: unknown; [key: string]: unknown };
    } catch {
      throw new Error(`[installLocal] could not read plugin.json in ${sourcePath}`);
    }
    if (hasProcessEntry(manifestDocument)) throw new ProcessEntryRequiresPinnedArtifactError();

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

    // Validate version before any filesystem or registry mutation.
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
        // Validate the complete staged candidate before changing live state or pointers.
        await removePayloadOnlyTree(stagingDir);
        await cp(sourcePath, stagingDir, {
          recursive: true,
          verbatimSymlinks: true,
          filter: buildSideloadCopyFilter(sourcePath),
        });
        await rejectSideloadSymlinks(stagingDir);

        // Exclude the same top-level runtime directories the receipt verifier excludes.
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
            // Carry data through the journaled backup before promotion so recovery always knows its owner.
            const dataCarrier = localInstallDataCarrier(rollbackSnapshot);
            await retryOnTransientFsLock(
              () => carryPluginStateDirs(installDir, dataCarrier ?? stagingDir, { onConflict: "reject" }),
            );
            // Carry live socket directories through the backup, never a stage deleted before predecessor retirement.
            await carryPluginSocketDirs(installDir, dataCarrier ?? stagingDir, { onConflict: "reject" });
            // Both generations may retain confinement access here; deletion must use the runtime-safe path.
            await removePluginTreeNowOrAtBoot(installDir, this.pluginsRoot, removeTreeNow);
            await rename(stagingDir, installDir);
            if (dataCarrier) {
              await retryOnTransientFsLock(
                () => carryPluginStateDirs(dataCarrier, installDir, { onConflict: "reject" }),
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
        // After commit begins, a fresh-install stage may hold candidate-bound runtime directories and is no longer payload-only.
        await removePluginTreeNowOrAtBoot(stagingDir, this.pluginsRoot, removeTreeNow).catch((cleanupErr) => {
          log.error(`installLocal staging cleanup failed for ${pluginId}: ${errorMessage(cleanupErr)}`);
        });
        // Never compensate after pointer commit; record postcommit health and preserve the committed generation.
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
            try {
              await this.discardLocalInstallRollbackSnapshot(rollbackSnapshot);
            } catch (cleanupErr) {
              log.error(`installLocal rollback snapshot cleanup failed for ${pluginId}: ${errorMessage(cleanupErr)}`);
            }
          }
          throw err;
        }
        let restored = false;
        if (rollbackSnapshot) {
          try {
            await this.restoreLocalInstallSnapshot(pluginId, rollbackSnapshot);
            restored = true;
          } catch (restoreErr) {
            log.error(`installLocal rollback restore failed for ${pluginId}: ${errorMessage(restoreErr)}`);
          }
        } else {
          try {
            await this.cleanupFreshInstalledPlugin(pluginId);
          } catch (cleanupErr) {
            log.error(`installLocal fresh cleanup failed for ${pluginId}: ${errorMessage(cleanupErr)}`);
          }
        }
        if (restored) {
          try {
            await this.discardLocalInstallRollbackSnapshot(rollbackSnapshot);
          } catch (cleanupErr) {
            log.error(`installLocal rollback snapshot cleanup failed for ${pluginId}: ${errorMessage(cleanupErr)}`);
          }
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
    await removePayloadOnlyTree(backupDir);
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
      // Move the only state copy into the surviving backup before discarding a promoted root.
      await retryOnTransientFsLock(
        () => carryPluginStateDirs(snapshot.installDir, backupDir, { onConflict: "reject" }),
      );
      // Restore the live predecessor sockets before removing their current root.
      if (existsSync(snapshot.installDir)) await carryPluginSocketDirs(backupDir, snapshot.installDir, { onConflict: "reject" });
      await carryPluginSocketDirs(snapshot.installDir, backupDir, { onConflict: "reject" });
    }
    // The failed candidate may still be confined to this root.
    await removePluginTreeNowOrAtBoot(snapshot.installDir, this.pluginsRoot, removeTreeNow);
    if (backupDir) {
      const restoreStageDir = `${snapshot.installDir}.restore-${process.pid}-${Date.now()}`;
      await removePayloadOnlyTree(restoreStageDir);
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
        await removePayloadOnlyTree(restoreStageDir).catch(() => undefined);
        throw err;
      }
      await retryOnTransientFsLock(
        () => carryPluginStateDirs(backupDir, snapshot.installDir, { onConflict: "reject" }),
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
    // The fresh candidate may still be confined to this root.
    await removePluginTreeNowOrAtBoot(installDir, this.pluginsRoot, removeTreeNow);
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
      await removePluginTreeNowOrAtBoot(snapshot.backupDir, this.pluginsRoot, removeTreeNow);
      await clearObsoletePluginBackupOwnership(
        this.paths,
        snapshot.registryEntry.id,
        snapshot.backupDir,
      );
    }
  }

}
