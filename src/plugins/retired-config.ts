import type { SettingsService } from "../data/settings-store.js";
import { normalizeRetiredPluginConfigRecord } from "../data/settings-normalization.js";
import type { RetiredPluginConfigRecord, RetirementSuccessors } from "../shared/alerts-types.js";
import { sanitizePluginConfig } from "../shared/plugin-config.js";
import { stripSecretFields } from "./config-schema.js";
import { effectivePluginConfig } from "./effective-config.js";
import type { PluginMarketplaceService } from "./marketplace.js";

/** Host-only instructions; never part of a renderer uninstall request. */
export interface PluginConfigRetention {
  reason: "revoked" | "superseded";
  sourceId: string | null;
  successors: RetirementSuccessors;
}

export interface PluginRetirementPort {
  capture(pluginId: string, retain: PluginConfigRetention): Promise<RetiredPluginConfigRecord>;
  writeIfAbsent(pluginId: string, record: RetiredPluginConfigRecord): Promise<void>;
}

export function createPluginRetirementPort(deps: {
  settings: Pick<SettingsService, "get" | "set" | "getPluginConfig">;
  marketplace: Pick<PluginMarketplaceService, "getInstalledConfigManifest">;
  wildcard: () => Record<string, unknown>;
  appVersion: () => string;
}): PluginRetirementPort {
  return {
    async capture(pluginId, retain) {
      const existing = deps.settings.get("retiredPluginConfigs");
      if (Object.hasOwn(existing, pluginId)) return existing[pluginId]!;
      const installed = await deps.marketplace.getInstalledConfigManifest(pluginId);
      if (!installed || installed.sourceId !== retain.sourceId) {
        throw new Error("Plugin retirement install identity changed");
      }
      const effective = effectivePluginConfig(installed.manifest, deps.wildcard(), deps.settings.getPluginConfig(pluginId));
      const record: RetiredPluginConfigRecord = {
        config: sanitizePluginConfig(stripSecretFields(installed.manifest.configSchema, effective)),
        enabled: installed.enabled,
        sourceId: retain.sourceId,
        retiredAtAppVersion: deps.appVersion(),
        successors: structuredClone(retain.successors),
        consumedBy: [],
      };
      if (!normalizeRetiredPluginConfigRecord(record)) throw new Error("Invalid plugin retirement capture");
      return record;
    },
    async writeIfAbsent(pluginId, record) {
      // Keep read and synchronous memory update in one turn; persistence may later resolve or roll back.
      const records = deps.settings.get("retiredPluginConfigs");
      if (Object.hasOwn(records, pluginId)) return;
      await deps.settings.set("retiredPluginConfigs", { ...records, [pluginId]: structuredClone(record) });
    },
  };
}
