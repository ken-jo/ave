/** Trust host registry provenance and pins; writable plugin manifests alone cannot grant host secrets. */
import { stat } from "node:fs/promises";
import { isMissingPathError } from "../../../lib/atomic-file.js";
import { fileIdentityKey } from "../../../lib/file-identity.js";
import { readPluginRegistry } from "../../../plugins/registry.js";
import type { PluginRegistryTrust } from "../../../plugins/types.js";

export interface RegistryEntryCache {
  refreshRegistryEntryCache: () => Promise<void>;
  /** Check file identity before trust decisions because some registry writers emit no install event. */
  refreshRegistryEntryCacheIfChanged: () => Promise<void>;
  getRegistryEntry: (
    pluginId: string,
  ) => PluginRegistryTrust | undefined;
}

/** Read failures empty the cache and deny grants until a successful refresh. */
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
      const info = await stat(registryPath, { bigint: true });
      return `${fileIdentityKey(info)}:${info.size}:${info.mtimeNs}`;
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
