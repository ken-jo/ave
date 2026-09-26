import type { AlertMigrationPorts } from "../../alerts/migration.js";
import { inheritedConfig } from "../../alerts/migration.js";
import type { RetiredPluginConfigRecord } from "../../shared/alerts-types.js";
import type { PluginConfigRecord } from "../../shared/plugin-config.js";

export function createAlertMigrationPorts(): AlertMigrationPorts {
  let records: Record<string, RetiredPluginConfigRecord> = {};
  const config: Record<string, PluginConfigRecord> = {};
  return {
    records: { get: () => structuredClone(records), set: async (next) => { records = structuredClone(next); } },
    installed: async () => [],
    hasPendingCleanup: () => false,
    applyConfig: async (pluginId, entries, source) => {
      const next = inheritedConfig(config[pluginId] ?? {}, entries, source);
      if (!next) return false;
      config[pluginId] = next;
      return true;
    },
    configApplied: () => {},
    warn: () => {},
  };
}
