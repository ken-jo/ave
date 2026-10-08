/**
 * Boot §4.2 / #958-#959 — registry-entry cache (C6 extraction).
 *
 * Behavior-preserving move of the `registryEntryCache` cluster out of
 * initPluginRuntime. The registry file (`~/.ave/plugins/registry.json`) is the
 * host-verified source of truth for `installSource`, the install-time
 * manifest SHA pin and the install's origin; `plugin.json` lives inside the
 * plugin's writable surface and cannot be trusted alone. The cache is populated at boot
 * and refreshed on every install/uninstall so HostApi closures answer lookups
 * synchronously without touching disk on the hot path.
 *
 * Trust source: the host-secret gate (getSecret / resolveApiKey) reads this
 * map; manifest-only metadata never grants a host secret.
 */
import { stat } from "node:fs/promises";
import { isMissingPathError } from "../../../lib/atomic-file.js";
import { readPluginRegistry } from "../../../plugins/registry.js";
import type { PluginRegistryTrust } from "../../../plugins/types.js";

export interface RegistryEntryCache {
  refreshRegistryEntryCache: () => Promise<void>;
  /**
   * Re-read the registry only when the file changed since the last read. The
   * install and uninstall events refresh the cache, but other writers (the
   * §16.3 migration binding an origin, boot recovery) do not raise them; the
   * host-secret gate calls this before it trusts an entry.
   */
  refreshRegistryEntryCacheIfChanged: () => Promise<void>;
  getRegistryEntry: (
    pluginId: string,
  ) => PluginRegistryTrust | undefined;
}

/**
 * Build the registry-entry cache. `refreshRegistryEntryCache` re-reads the
 * host-managed registry file (fail-closed on error → empty cache → no entry,
 * so no host-secret grant); `getRegistryEntry` is a synchronous
 * lookup used inside the per-plugin HostApi closures.
 */
export function createRegistryEntryCache(deps: {
  registryPath: string;
  log: { warn: (msg: string, ...args: unknown[]) => void };
}): RegistryEntryCache {
  const { registryPath, log } = deps;
  const registryEntryCache = new Map<string, PluginRegistryTrust>();
  /** The file's identity at the last read; null before one, or after a failed read. */
  let readStamp: string | null = null;
  const stamp = async (): Promise<string> => {
    try {
      const info = await stat(registryPath);
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch (err) {
      if (isMissingPathError(err)) return "missing";
      throw err;
    }
  };
  const refreshRegistryEntryCache = async (): Promise<void> => {
    try {
      // Taken before the read, so a write during it is seen by the next check.
      const before = await stamp();
      const registry = await readPluginRegistry(registryPath);
      registryEntryCache.clear();
      for (const entry of registry.plugins) {
        if (entry.pendingUpdate) continue;
        if (entry.installSource !== undefined || entry.manifestSha256 !== undefined || entry.origin !== undefined) {
          registryEntryCache.set(entry.id, {
            installSource: entry.installSource,
            manifestSha256: entry.manifestSha256,
            origin: entry.origin,
          });
        }
      }
      readStamp = before;
    } catch (err) {
      registryEntryCache.clear();
      readStamp = null;
      // Cache stays empty, so the host-secret gate finds no entry and grants
      // nothing until a later refresh reads the registry.
      log.warn(
        "registry-entry cache refresh failed: %s",
        (err as Error).message,
      );
    }
  };
  const getRegistryEntry = (
    pluginId: string,
  ): PluginRegistryTrust | undefined => registryEntryCache.get(pluginId);
  const refreshRegistryEntryCacheIfChanged = async (): Promise<void> => {
    let current: string;
    try {
      current = await stamp();
    } catch (err) {
      log.warn("registry-entry cache stat failed: %s", (err as Error).message);
      return refreshRegistryEntryCache();
    }
    if (current !== readStamp) await refreshRegistryEntryCache();
  };
  return { refreshRegistryEntryCache, refreshRegistryEntryCacheIfChanged, getRegistryEntry };
}
