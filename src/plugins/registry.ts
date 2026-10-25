import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import type { PluginAccessSpec, PluginRegistry, PluginRegistryEntry, PluginRegistryEntryInstallSource } from "./types.js";
import { logPluginLifecycle, PluginPhase } from "./lifecycle-log.js";
import { isCommittedAtomicWriteError, isMissingPathError, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { FileLockReleaseError, withFileLock, withInProcessFileQueue } from "../lib/with-file-lock.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import { resolveTrustedRegistryManifestPath } from "./registry-manifest-trust.js";
import { isRecord, isStringArray } from "../shared/is-record.js";

/** Normalize legacy install-source fields and remove unsupported tool grants without weakening receipt checks. */
interface LegacyRegistryEntry extends Omit<PluginRegistryEntry, "installSource"> {
  installedBy?: "admin" | "user";
  _devLinked?: boolean;
  /** Read legacy dev-link strings only to normalize them to local-dev. */
  installSource?: PluginRegistryEntryInstallSource | "dev-link";
}

/** Remove retired tool grants while preserving supported event and approval data; persisted JSON is untrusted. */
export function stripLegacyPluginToolGrants(
  access: PluginAccessSpec | undefined,
): { access: PluginAccessSpec | undefined; changed: boolean } {
  if (!access || !Array.isArray(access.plugins)) return { access, changed: false };
  let changed = false;
  const plugins = access.plugins.flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      changed = true;
      return [];
    }

    const record = target as unknown as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, "tools")) return [target];
    changed = true;
    const eventOnlyTarget = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "tools"),
    );
    return [eventOnlyTarget as unknown as typeof target];
  });
  return {
    access: changed ? { ...access, plugins } : access,
    changed,
  };
}

/** Return null when conformant; report legacy install-source rewrites once rather than silently changing trust. */
function migrateLegacyEntry(
  entry: LegacyRegistryEntry,
  out: { devLinkRewritten: boolean; legacyToolGrantsRemoved: boolean },
): PluginRegistryEntry | null {
  const hasLegacy = entry.installedBy !== undefined || entry._devLinked !== undefined;
  const hasDevLinkInstallSource = entry.installSource === "dev-link";
  const cleanedAccess = stripLegacyPluginToolGrants(entry.approvedPluginAccess);
  // Conformant entries need no migration, including entries with no derivable installSource.
  if (!hasLegacy && !hasDevLinkInstallSource && !cleanedAccess.changed) return null;
  if (cleanedAccess.changed) out.legacyToolGrantsRemoved = true;
  let installSource: PluginRegistryEntryInstallSource | undefined;
  if (hasDevLinkInstallSource || entry._devLinked === true) {
    installSource = "local-dev";
    out.devLinkRewritten = true;
  } else if (entry.installSource !== undefined) {
    installSource = entry.installSource as PluginRegistryEntryInstallSource;
  } else if (entry.installedBy === "admin") {
    installSource = "admin";
  } else if (entry.installedBy === "user") {
    installSource = "user";
  }
  const migrated: PluginRegistryEntry = {
    id: entry.id,
    manifestPath: entry.manifestPath,
  };
  if (entry.manifestSha256 !== undefined) migrated.manifestSha256 = entry.manifestSha256;
  if (entry.enabled !== undefined) migrated.enabled = entry.enabled;
  if (entry.bundleRefs !== undefined) migrated.bundleRefs = entry.bundleRefs;
  if (cleanedAccess.access !== undefined) migrated.approvedPluginAccess = cleanedAccess.access;
  if (installSource !== undefined) migrated.installSource = installSource;
  if (entry.origin !== undefined) migrated.origin = entry.origin;
  if (entry.pendingUpdate !== undefined) migrated.pendingUpdate = entry.pendingUpdate;
  if (entry.pendingCleanup !== undefined) {
    migrated.pendingCleanup = entry.pendingCleanup.map((item) => ({ ...item }));
  }
  return migrated;
}

/** Prune from installed IDs only when the registry can vouch for them; malformed or replaced files return undefined. */
export async function vouchedInstalledPluginIds(registryPath: string): Promise<ReadonlySet<string> | undefined> {
  if (!existsSync(registryPath)) return undefined;
  const registry = await readPluginRegistry(registryPath);
  if (registry.plugins.some((entry) => entry.pendingUpdate)) return undefined;
  return new Set(registry.plugins.map((entry) => entry.id));
}

export async function readPluginRegistry(registryPath: string): Promise<PluginRegistry> {
  logPluginLifecycle("debug", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_START, registryPath }, "registry read");
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (err) {
    // An absent first-boot registry means empty state; other read failures remain errors.
    if (isMissingPathError(err)) {
      logPluginLifecycle("info", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_SKIP, reason: "first_boot_no_registry" }, "no registry — first boot");
      return { version: 1, plugins: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    logPluginLifecycle("error", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_FAIL, err, reason: "invalid_json", registryPath }, "registry parse failed");
    throw err;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    logPluginLifecycle("error", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_FAIL, reason: "invalid_format", registryPath }, "registry malformed");
    throw new Error(`Invalid plugin registry: ${registryPath}`);
  }
  if (parsed.version !== undefined && typeof parsed.version !== "number") {
    throw new Error(`Invalid plugin registry version: ${registryPath}`);
  }
  // Migrate in memory; only explicit transactions may persist without overwriting concurrent writers.
  let migratedCount = 0;
  const out = { devLinkRewritten: false, legacyToolGrantsRemoved: false };
  validateRawPluginRegistry(parsed, registryPath);
  const plugins: PluginRegistryEntry[] = parsed.plugins.map((entry) => {
    const migrated = migrateLegacyEntry(entry, out);
    if (migrated !== null) {
      migratedCount += 1;
      return migrated;
    }
    return entry as PluginRegistryEntry;
  });
  const registry: PluginRegistry = {
    version: parsed.version ?? 1,
    plugins,
  };
  validatePluginRegistry(registry, registryPath);
  if (out.devLinkRewritten) {
    // Report dev-link rewrites once because receipt enforcement can make the migrated install fail visibly.
    logPluginLifecycle(
      "warn",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "dev_link_install_source_removed",
        registryPath,
      },
      `registry contained dev-link entries — rewritten to installSource:"local-dev". `
        + `These plugins will fail to load until reinstalled via the marketplace `
        + `or the development-only Settings > Plugin Config > Install from local folder flow.`,
    );
  }
  if (migratedCount > 0) {
    if (out.legacyToolGrantsRemoved) {
      logPluginLifecycle(
        "info",
        {
          pluginId: "<registry>",
          phase: PluginPhase.DISCOVERY_START,
          reason: "legacy_plugin_tool_grants_removed",
          registryPath,
        },
        "registry contained retired pluginAccess.tools grants — removed them and retained event grants",
      );
    }

    logPluginLifecycle(
      "info",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "legacy_registry_migrated",
        migratedCount,
        registryPath,
      },
      `registry migrated ${migratedCount} legacy entries`,
    );
  }
  return registry;
}

const REGISTRY_ENTRY_KEYS = new Set([
  "id", "manifestPath", "manifestSha256", "enabled", "bundleRefs",
  "approvedPluginAccess", "installSource", "origin", "pendingUpdate",
  "pendingCleanup",
]);
const LEGACY_REGISTRY_ENTRY_KEYS = new Set([...REGISTRY_ENTRY_KEYS, "installedBy", "_devLinked"]);

function validateRawPluginRegistry(value: Record<string, unknown>, registryPath: string): void {
  assertOnlyKeys(value, new Set(["version", "plugins"]), `plugin registry: ${registryPath}`);
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`Invalid plugin registry version: ${registryPath}`);
  }
  for (const entry of value.plugins as unknown[]) validateRegistryEntry(entry, registryPath, true);
}

function validateRegistryEntry(
  value: unknown,
  registryPath: string,
  allowLegacy: boolean,
): asserts value is LegacyRegistryEntry {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.manifestPath !== "string"
    || value.manifestPath.length === 0) {
    throw new Error(`Invalid plugin registry entry: ${registryPath}`);
  }
  assertSafeArtifactSlug(value.id);
  assertOnlyKeys(
    value,
    allowLegacy ? LEGACY_REGISTRY_ENTRY_KEYS : REGISTRY_ENTRY_KEYS,
    `plugin registry entry '${value.id}'`,
  );
  if (value.manifestSha256 !== undefined && typeof value.manifestSha256 !== "string") {
    throw new Error(`Invalid plugin registry manifest hash: ${value.id}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Invalid plugin registry enabled flag: ${value.id}`);
  }
  if (value.bundleRefs !== undefined && !isStringArray(value.bundleRefs)) {
    throw new Error(`Invalid plugin registry bundle references: ${value.id}`);
  }
  if (value.installedBy !== undefined && value.installedBy !== "admin" && value.installedBy !== "user") {
    throw new Error(`Invalid legacy plugin registry installedBy: ${value.id}`);
  }
  if (value._devLinked !== undefined && typeof value._devLinked !== "boolean") {
    throw new Error(`Invalid legacy plugin registry _devLinked: ${value.id}`);
  }
  const allowedInstallSources = allowLegacy
    ? new Set(["admin", "user", "local-dev", "dev-link"])
    : new Set(["admin", "user", "local-dev"]);
  if (value.installSource !== undefined || Object.prototype.hasOwnProperty.call(value, "installSource")) {
    if (typeof value.installSource !== "string" || !allowedInstallSources.has(value.installSource)) {
      throw new Error(`Invalid plugin registry install source: ${value.id}`);
    }
  }
  if (value.approvedPluginAccess !== undefined) validatePluginAccess(value.approvedPluginAccess, value.id);
  if (value.origin !== undefined) validateOrigin(value.origin, value.id);
  if (value.pendingUpdate !== undefined) validatePendingUpdate(value.pendingUpdate, value.id);
  if (value.pendingCleanup !== undefined) validatePendingCleanup(value.pendingCleanup, value.id);
}

const ORIGIN_SOURCE_KINDS = new Set(["official", "managed", "custom", "direct"]);
const ORIGIN_RUNGS = new Set(["release", "archive", "tree", "folder", "legacy"]);

function validateOrigin(value: unknown, pluginId: string): void {
  if (!isRecord(value)) throw new Error(`Invalid plugin registry origin: ${pluginId}`);
  assertOnlyKeys(
    value,
    new Set(["sourceId", "sourceOrigin", "commit", "packagePath", "version", "rung", "artifactSha256", "installedAt"]),
    `origin for '${pluginId}'`,
  );
  // Folder pins use revisions; other source rungs use commit hashes.
  const commitOk = typeof value.commit === "string"
    && (value.rung === "folder" ? /^local-[a-f0-9]{64}$/.test(value.commit) : /^[a-f0-9]{40}$/.test(value.commit));
  const folderOriginOk = value.rung !== "folder" || value.sourceOrigin !== "official";
  const digestOk = value.rung === "legacy"
    ? value.artifactSha256 === null
    : typeof value.artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(value.artifactSha256);
  if (typeof value.sourceId !== "string" || value.sourceId.length === 0
    || typeof value.sourceOrigin !== "string" || !ORIGIN_SOURCE_KINDS.has(value.sourceOrigin)
    || !commitOk || !folderOriginOk
    || typeof value.packagePath !== "string"
    || typeof value.version !== "string" || value.version.length === 0
    || typeof value.rung !== "string" || !ORIGIN_RUNGS.has(value.rung)
    || !digestOk
    || typeof value.installedAt !== "string") {
    throw new Error(`Invalid plugin registry origin: ${pluginId}`);
  }
}

function validatePendingCleanup(value: unknown, pluginId: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid plugin registry pending cleanup: ${pluginId}`);
  }
  const paths = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`Invalid plugin registry pending cleanup: ${pluginId}`);
    assertOnlyKeys(item, new Set(["kind", "path"]), `pending cleanup for '${pluginId}'`);
    if ((item.kind !== "obsolete-artifact" && item.kind !== "obsolete-local-backup")
      || typeof item.path !== "string"
      || item.path.length === 0
      || paths.has(item.path)) {
      throw new Error(`Invalid plugin registry pending cleanup: ${pluginId}`);
    }
    paths.add(item.path);
  }
}

function validatePendingUpdate(value: unknown, pluginId: string): void {
  if (!isRecord(value)) throw new Error(`Invalid plugin registry pending update: ${pluginId}`);
  assertOnlyKeys(
    value,
    new Set(["kind", "previousManifestFileSha256", "previousReceiptRaw", "recoveryBackupDir", "recoveryBackupMode"]),
    `pending update for '${pluginId}'`,
  );
  if (value.kind !== "marketplace" && value.kind !== "local-dev") {
    throw new Error(`Invalid plugin registry pending update kind: ${pluginId}`);
  }
  if (value.previousManifestFileSha256 !== null
    && (typeof value.previousManifestFileSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.previousManifestFileSha256))) {
    throw new Error(`Invalid plugin registry pending manifest hash: ${pluginId}`);
  }
  if (value.previousReceiptRaw !== null && typeof value.previousReceiptRaw !== "string") {
    throw new Error(`Invalid plugin registry pending receipt: ${pluginId}`);
  }
  if (value.recoveryBackupDir !== undefined && typeof value.recoveryBackupDir !== "string") {
    throw new Error(`Invalid plugin registry recovery backup path: ${pluginId}`);
  }
  if (value.recoveryBackupMode !== undefined
    && value.recoveryBackupMode !== "rename"
    && value.recoveryBackupMode !== "copy") {
    throw new Error(`Invalid plugin registry recovery backup mode: ${pluginId}`);
  }
  if ((value.recoveryBackupDir === undefined) !== (value.recoveryBackupMode === undefined)) {
    throw new Error(`Incomplete plugin registry recovery backup metadata: ${pluginId}`);
  }
}

function validatePluginAccess(value: unknown, pluginId: string): void {
  if (!isRecord(value)) throw new Error(`Invalid plugin registry access grant: ${pluginId}`);
  assertOnlyKeys(value, new Set(["plugins", "agentApprovalScopes"]), `plugin access for '${pluginId}'`);
  if (!Array.isArray(value.plugins)) throw new Error(`Invalid plugin access targets: ${pluginId}`);
  for (const target of value.plugins) {
    // Allow only the specific historical null target and retired tools shape during migration.
    if (target === null) continue;
    if (!isRecord(target) || typeof target.pluginId !== "string" || target.pluginId.length === 0) {
      throw new Error(`Invalid plugin access target: ${pluginId}`);
    }
    assertOnlyKeys(target, new Set(["pluginId", "events", "tools"]), `plugin access target for '${pluginId}'`);
    if (target.events !== undefined && !isStringArray(target.events)) {
      throw new Error(`Invalid plugin access events: ${pluginId}`);
    }
    if (target.tools !== undefined && !isStringArray(target.tools)) {
      throw new Error(`Invalid legacy plugin access tools: ${pluginId}`);
    }
  }
  if (value.agentApprovalScopes !== undefined && !isStringArray(value.agentApprovalScopes)) {
    throw new Error(`Invalid plugin approval scopes: ${pluginId}`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, context: string): void {
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`Unsupported ${context} field: ${unsupported}`);
}

function validatePluginRegistry(registry: PluginRegistry, registryPath: string): void {
  if (registry.version !== 1 || !Array.isArray(registry.plugins)) {
    throw new Error(`Invalid plugin registry: ${registryPath}`);
  }
  const ids = new Set<string>();
  for (const entry of registry.plugins) {
    validateRegistryEntry(entry, registryPath, false);
    if (ids.has(entry.id)) throw new Error(`Duplicate plugin registry entry: ${entry.id}`);
    ids.add(entry.id);
  }
}

export function validatePluginRegistryEntries(
  entries: unknown[],
  context: string,
): asserts entries is PluginRegistryEntry[] {
  validatePluginRegistry({ version: 1, plugins: entries as PluginRegistryEntry[] }, context);
}

function canonicalizePluginRegistry(registry: PluginRegistry): PluginRegistry {
  return {
    version: registry.version,
    plugins: [...registry.plugins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}

export function resolveManifestPathsFromRegistry(
  registryPath: string,
  entries: PluginRegistryEntry[],
): string[] {
  const pluginsRoot = dirname(registryPath);
  // Keep inactive manifests discoverable without instantiating them; apply the same trust-root checks as load plans.
  return entries
    .filter((entry) => entry.pendingUpdate === undefined)
    .flatMap((entry) => {
      const trusted = resolveTrustedRegistryManifestPath(entry.manifestPath, pluginsRoot);
      if (trusted === null) {
        logPluginLifecycle(
          "warn",
          {
            pluginId: entry.id,
            phase: PluginPhase.DISCOVERY_SKIP,
            reason: "untrusted_manifest_path",
            manifestPath: entry.manifestPath,
          },
          "ignoring untrusted registry manifest path",
        );
        return [];
      }
      return [trusted];
    });
}

// Serialize in-process contenders before cross-process locking; absent registry means empty, empty bytes mean corruption.

const registryMutationContext = new AsyncLocalStorage<ReadonlySet<string>>();

async function withRegistryTransaction<T>(
  registryPath: string,
  mutator: (registry: PluginRegistry) => T,
): Promise<T> {
  const key = resolve(registryPath);
  return withInProcessFileQueue(key, async () => {
    try {
      const committed = await withFileLock(
        `${key}.lock-anchor`,
        async () => {
          const registry = await readPluginRegistry(key);
          const inherited = registryMutationContext.getStore() ?? new Set<string>();
          const result = registryMutationContext.run(
            new Set([...inherited, key]),
            () => mutator(registry),
          );
          if (result !== null
            && (typeof result === "object" || typeof result === "function")
            && typeof (result as { then?: unknown }).then === "function") {
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("Plugin registry mutator must be synchronous");
          }
          validatePluginRegistry(registry, key);
          const canonical = canonicalizePluginRegistry(registry);
          const content = `${JSON.stringify(canonical, null, 2)}\n`;
          try {
            writeUtf8FileAtomicSync(key, content, 0o600);
          } catch (error) {
            if (!isCommittedAtomicWriteError(error)) throw error;
            const persisted = await readFile(key, "utf-8");
            if (persisted !== content) throw error;
            logPluginLifecycle(
              "warn",
              {
                pluginId: "<registry>",
                phase: PluginPhase.DISCOVERY_FAIL,
                reason: "registry_atomic_commit_sync_unconfirmed",
                registryPath: key,
              },
              "registry atomic rename committed; exact bytes verified after parent directory sync failure",
            );
          }
          return { content, mutationResult: result };
        },
      );
      return committed.mutationResult;
    } catch (error) {
      if (!(error instanceof FileLockReleaseError)) throw error;
      const committed = error.result as { content: string; mutationResult: T };
      const persisted = await readFile(key, "utf-8");
      if (persisted !== committed.content) throw error;
      logPluginLifecycle(
        "warn",
        {
          pluginId: "<registry>",
          phase: PluginPhase.DISCOVERY_FAIL,
          err: error.releaseError,
          reason: "registry_lock_release_failed_after_commit",
          registryPath: key,
        },
        "registry commit completed but lock release failed; exact bytes verified and stale-lock recovery may be required",
      );
      return committed.mutationResult;
    }
  });
}

/** Serialize every registry mutation through this atomic read/mutate/write transaction. */
export function updatePluginRegistry<T = void>(
  registryPath: string,
  mutator: (registry: PluginRegistry) => T,
): Promise<T> {
  if ((registryMutationContext.getStore()?.size ?? 0) > 0) {
    throw new Error("Nested plugin registry mutation is not allowed");
  }
  return withRegistryTransaction(registryPath, mutator);
}

export function migratePluginRegistry(registryPath: string): Promise<void> {
  return updatePluginRegistry(registryPath, () => undefined);
}
