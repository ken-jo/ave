/**
 * Snapshot retention (design §2.3): a sync prunes old snapshots, but never
 * one an installed package still references by its `origin.commit` (the
 * snapshot commit its install plan was bound to). Each reader lists the
 * origins of one kind of install; `retainedCommitsFrom` turns them into the
 * syncer's `retainedCommits` option.
 */
import { readPluginRegistry } from "../../plugins/registry.js";

interface RetainedOrigin {
  sourceId: string;
  commit: string;
}

export type OriginReader = () => Promise<readonly RetainedOrigin[]>;

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

/** Origins of git-installed plugins, from the plugin registry. */
export function pluginRegistryOrigins(registryPath: string): OriginReader {
  return async () => {
    const registry = await readPluginRegistry(registryPath);
    return registry.plugins.flatMap((entry) => (entry.origin ? [{ sourceId: entry.origin.sourceId, commit: entry.origin.commit }] : []));
  };
}
