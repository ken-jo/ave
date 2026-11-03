/** Retain every snapshot an installed origin references; those origins also bind revocation sources. */
import { readPluginRegistry } from "../../plugins/registry.js";
import type { PackageKind } from "../catalog/types.js";

export interface InstalledOrigin {
  kind: PackageKind;
  name: string;
  sourceId: string;
  commit: string;
}

export type OriginReader = () => Promise<readonly InstalledOrigin[]>;

export function retainedCommitsFrom(readers: readonly OriginReader[]): (sourceId: string) => Promise<ReadonlySet<string>> {
  return async (sourceId) => {
    const commits = new Set<string>();
    for (const read of readers) {
      for (const origin of await read()) {
        if (origin.sourceId === sourceId) commits.add(origin.commit);
      }
    }
    return commits;
  };
}

export function pluginRegistryOrigins(registryPath: string): OriginReader {
  return async () => {
    const registry = await readPluginRegistry(registryPath);
    // A registry pending review cannot say which commits installed plugins still reference: keep everything.
    if (registry.pendingReview) throw new Error("plugin registry is waiting for review; nothing is pruned");
    return registry.plugins.flatMap((entry) => (entry.origin ? [{ kind: "plugin" as const, name: entry.id, sourceId: entry.origin.sourceId, commit: entry.origin.commit }] : []));
  };
}
